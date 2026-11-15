import os
import time
import uuid
import hashlib
import numpy as np
import torch
from PIL import Image, ImageOps
import folder_paths

from . import bluebox_core as core


PREVIEW_MAX_EDGE = 2048
PREVIEW_WEBP_QUALITY = 85


def _save_mask_overlay_preview(rgb_np, mask_np, prefix="bluebox"):
    h, w = rgb_np.shape[:2]
    out_w, out_h = w, h

    if max(w, h) > PREVIEW_MAX_EDGE:
        scale = PREVIEW_MAX_EDGE / float(max(w, h))
        nw = max(1, int(round(w * scale)))
        nh = max(1, int(round(h * scale)))

        rgb_img = Image.fromarray(
            (np.clip(rgb_np, 0, 1) * 255).astype(np.uint8), mode="RGB"
        ).resize((nw, nh), Image.LANCZOS)

        mask_img = Image.fromarray(
            (np.clip(mask_np, 0, 1) * 255).astype(np.uint8), mode="L"
        ).resize((nw, nh), Image.LANCZOS)

        base = np.array(rgb_img, dtype=np.float32)
        mask_small = np.array(mask_img, dtype=np.float32) / 255.0
    else:
        base = np.clip(rgb_np * 255, 0, 255).astype(np.float32)
        mask_small = mask_np

    overlay = np.zeros_like(base)
    overlay[..., 0] = 34
    overlay[..., 1] = 197
    overlay[..., 2] = 94
    alpha = mask_small[..., None] * 0.5
    blended = base * (1 - alpha) + overlay * alpha
    blended = np.clip(blended, 0, 255).astype(np.uint8)
    out = Image.fromarray(blended, mode="RGB")

    preview_w, preview_h = out.size

    temp_dir = folder_paths.get_temp_directory()
    fname = "{}_{}.webp".format(prefix, int(time.time() * 1000))
    fpath = os.path.join(temp_dir, fname)
    out.save(fpath, format="WEBP", quality=PREVIEW_WEBP_QUALITY, method=0)

    images_ui = [{
        "filename": fname,
        "subfolder": "",
        "type": "temp",
    }]
    return images_ui, out_w, out_h, preview_w, preview_h


class BlueBoxLoadImage:

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = []
        if os.path.isdir(input_dir):
            for f in os.listdir(input_dir):
                if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp")):
                    files.append(f)
        return {
            "required": {
                "image": (sorted(files), {"image_upload": True}),
            },
            "optional": {
                "mask_file": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load_image"
    CATEGORY = "BlueBox"

    def load_image(self, image, mask_file=""):
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)

        rgb = img.convert("RGB")
        rgb_np = np.array(rgb).astype(np.float32) / 255.0
        image_tensor = torch.from_numpy(rgb_np)[None,]

        h, w = rgb_np.shape[:2]

        mask_np = None
        if mask_file:
            mask_np = self._load_mask_by_name(mask_file)
        if mask_np is None:
            mask_np = self._try_load_sidecar_mask(image_path)
        if mask_np is None:
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                alpha = img.convert("RGBA").split()[-1]
                alpha_np = np.array(alpha).astype(np.float32) / 255.0
                mask_np = 1.0 - alpha_np

        if mask_np is not None and (mask_np.shape[0] != h or mask_np.shape[1] != w):
            mask_np = None
        if mask_np is None:
            mask_np = np.zeros((h, w), dtype=np.float32)

        mask_tensor = torch.from_numpy(mask_np)[None,]

        preview_ui, out_w, out_h, prev_w, prev_h = _save_mask_overlay_preview(
            rgb_np, mask_np, prefix="bluebox_load"
        )

        return {
            "ui": {
                "images": preview_ui,
                "out_size": [[out_w, out_h]],
                "preview_size": [[prev_w, prev_h]],
            },
            "result": (image_tensor, mask_tensor),
        }

    def _load_mask_by_name(self, filename):
        try:
            path = folder_paths.get_annotated_filepath(filename)
            if not os.path.exists(path):
                return None
            m = Image.open(path).convert("L")
            return np.array(m).astype(np.float32) / 255.0
        except Exception:
            return None

    def _try_load_sidecar_mask(self, image_path):
        base, ext = os.path.splitext(image_path)
        stem = os.path.basename(base)
        candidates = [
            base + "_mask.png",
            base + "_mask.jpg",
        ]
        if stem.startswith("bb_"):
            candidates.append(base.replace("bb_", "bb_mask_", 1) + ext)

        for p in candidates:
            if os.path.exists(p):
                try:
                    m = Image.open(p).convert("L")
                    return np.array(m).astype(np.float32) / 255.0
                except Exception:
                    continue
        return None

    @classmethod
    def IS_CHANGED(cls, image, mask_file=""):
        image_path = folder_paths.get_annotated_filepath(image)
        m = os.path.getmtime(image_path) if os.path.exists(image_path) else 0
        return "{}_{}".format(float(m), mask_file or "")

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)
        return True


class BlueBoxBridge:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "accept_input": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "reference": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "doit"
    OUTPUT_NODE = True
    CATEGORY = "BlueBox"

    def doit(self, image, accept_input=True, unique_id=None, reference=None):
        node_id = str(unique_id)

        if accept_input:
            state = self._accept_from_upstream(node_id, image, reference)
            ui = {
                "images": [state["preview_item"]] if state.get("preview_item") else [],
                "blocked": [True],
            }
            try:
                from comfy_execution.graph import ExecutionBlocker
                return {
                    "ui": ui,
                    "result": (ExecutionBlocker(None), ExecutionBlocker(None)),
                }
            except Exception:
                print(f"[BlueBox] Bridge {node_id} 无法使用 ExecutionBlocker，退化为透传")
                h, w = image[0].shape[:2]
                return {
                    "ui": ui,
                    "result": (image, torch.zeros((1, h, w), dtype=torch.float32)),
                }

        state = core.get_bridge_state(node_id)
        if state and state.get("image_path") and os.path.isfile(state["image_path"]):
            return self._output_from_state(node_id, state)

        print(f"[BlueBox] Bridge {node_id} 独立模式但无缓存图，透传上游")
        return self._passthrough(image)

    def _passthrough(self, image):
        h, w = image[0].shape[:2]
        return (image, torch.zeros((1, h, w), dtype=torch.float32))

    def _accept_from_upstream(self, node_id, image, reference):
        arr = image[0].cpu().numpy()
        if arr.ndim == 3 and arr.shape[-1] >= 3:
            arr = arr[..., :3]
        u8 = np.clip(arr * 255, 0, 255).astype(np.uint8)
        pil = Image.fromarray(u8, mode="RGB")

        temp_dir = folder_paths.get_temp_directory()
        sub_dir = os.path.join(temp_dir, "BlueBoxBridge")
        os.makedirs(sub_dir, exist_ok=True)
        fname = "bb_bridge_{}_{}.png".format(node_id, uuid.uuid4().hex[:8])
        fpath = os.path.join(sub_dir, fname)
        pil.save(fpath)

        preview_item = {
            "filename": fname,
            "subfolder": "BlueBoxBridge",
            "type": "temp",
        }
        core.set_bridge_image(
            node_id, fpath, None, preview_item,
            source_hash=self._hash_image_tensor(image),
        )

        if reference is not None:
            ref_arr = reference[0].cpu().numpy()
            if ref_arr.ndim == 3 and ref_arr.shape[-1] >= 3:
                ref_arr = ref_arr[..., :3]
            ref_u8 = np.clip(ref_arr * 255, 0, 255).astype(np.uint8)
            ref_pil = Image.fromarray(ref_u8, mode="RGB")
            ref_fname = "bb_ref_{}_{}.png".format(node_id, uuid.uuid4().hex[:8])
            ref_fpath = os.path.join(sub_dir, ref_fname)
            ref_pil.save(ref_fpath)
            core.set_bridge_reference(node_id, ref_fpath)

        return core.get_bridge_state(node_id)

    def _output_from_state(self, node_id, state):
        image_path = state["image_path"]
        mask_path = state.get("mask_path")
        pixels, mask = self._load_from_disk(image_path, mask_path)
        preview = state.get("preview_item") or {
            "filename": os.path.basename(image_path),
            "subfolder": "",
            "type": "input",
        }
        return {
            "ui": {"images": [preview]},
            "result": (pixels, mask),
        }

    def _load_from_disk(self, image_path, mask_path):
        i = Image.open(image_path)
        i = ImageOps.exif_transpose(i)
        rgb = i.convert("RGB")
        rgb_np = np.array(rgb).astype(np.float32) / 255.0
        image_tensor = torch.from_numpy(rgb_np)[None,]

        rgb_h, rgb_w = rgb_np.shape[:2]

        mask_np = None
        if mask_path and os.path.isfile(mask_path):
            try:
                m = Image.open(mask_path).convert("L")
                mask_np = np.array(m).astype(np.float32) / 255.0
            except Exception:
                mask_np = None

        if mask_np is not None and (mask_np.shape[0] != rgb_h or mask_np.shape[1] != rgb_w):
            mask_np = None
        if mask_np is None:
            mask_np = np.zeros((rgb_h, rgb_w), dtype=np.float32)

        mask_tensor = torch.from_numpy(mask_np)[None,]
        return image_tensor, mask_tensor

    @staticmethod
    def _hash_image_tensor(image):
        arr = image[0].cpu().numpy()
        if arr.ndim == 3 and arr.shape[-1] >= 3:
            arr = arr[..., :3]
        q = np.clip(arr * 255, 0, 255).astype(np.uint8) // 16
        return hashlib.sha256(q.tobytes()).hexdigest()[:16]

    @staticmethod
    def _hash_file_content(path):
        try:
            if not path or not os.path.isfile(path):
                return "nofile"
            h = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            return h.hexdigest()[:16]
        except Exception:
            return "readerr"

    @classmethod
    def IS_CHANGED(cls, image, accept_input=True, reference=None, unique_id=None):
        node_id = str(unique_id) if unique_id is not None else ""

        if accept_input:
            img_h = cls._hash_image_tensor(image)
            ref_h = cls._hash_image_tensor(reference) if reference is not None else "noref"
            return "acc_{}_{}_{}".format(img_h, ref_h, time.time_ns())

        state = core.get_bridge_state(node_id) or {}
        return "ind_{}_{}_{}".format(
            cls._hash_file_content(state.get("image_path")),
            cls._hash_file_content(state.get("mask_path")),
            cls._hash_file_content(state.get("reference_path")),
        )


NODE_CLASS_MAPPINGS = {
    "BlueBoxLoadImage": BlueBoxLoadImage,
    "BlueBoxBridge": BlueBoxBridge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxLoadImage": "Load Image (BlueBox)",
    "BlueBoxBridge": "Bridge (BlueBox)",
}