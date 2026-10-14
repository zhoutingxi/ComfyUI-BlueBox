import os
import time
import uuid
import numpy as np
import torch
from PIL import Image, ImageOps
import folder_paths

from . import bluebox_core as core


# ============================================================
# 公用工具：叠色预览（Load Image 用）
# ============================================================
def _save_mask_overlay_preview(rgb_np, mask_np, prefix="bluebox"):
    base = np.clip(rgb_np * 255, 0, 255).astype(np.float32)
    overlay = np.zeros_like(base)
    overlay[..., 0] = 34
    overlay[..., 1] = 197
    overlay[..., 2] = 94
    alpha = mask_np[..., None] * 0.5
    blended = base * (1 - alpha) + overlay * alpha
    blended = np.clip(blended, 0, 255).astype(np.uint8)
    out = Image.fromarray(blended)

    temp_dir = folder_paths.get_temp_directory()
    fname = "{}_{}.png".format(prefix, int(time.time() * 1000))
    fpath = os.path.join(temp_dir, fname)
    out.save(fpath)

    return [{
        "filename": fname,
        "subfolder": "",
        "type": "temp",
    }]


# ============================================================
# Load Image (BlueBox)
# ============================================================
class BlueBoxLoadImage:
    """
    LoadImage(BlueBox)：工作流开头用。
    mask 来源优先级：mask_file → sidecar → alpha → 全零。
    """

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
            print(f"[BlueBox] 遮罩尺寸 {mask_np.shape} 与图像 {(h, w)} 不匹配，已忽略")
            mask_np = None
        if mask_np is None:
            mask_np = np.zeros((h, w), dtype=np.float32)

        mask_tensor = torch.from_numpy(mask_np)[None,]
        preview = _save_mask_overlay_preview(rgb_np, mask_np, prefix="bluebox_load")

        return {
            "ui": {"images": preview},
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
        candidates = [
            base + "_mask.png",
            base + "_mask.jpg",
            base.replace("bb_", "bb_mask_") + ext,
        ]
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


# ============================================================
# Bridge (BlueBox)
# ============================================================
class BlueBoxBridge:
    """
    Bridge(BlueBox)：工作流中间用。

    语义：
      - 点"继续"  → 用编辑器烘焙图（磁盘缓存）作为输出。
      - 点"运行"  → 无论上游变没变，一律重新注入上游原图，走占位刷新流程。

    "继续"由前端 /bluebox/bridge_continue 设置一个递增序号，
    doit 消费一次即清除。IS_CHANGED 用该序号作为返回值，
    保证每次"继续"都让 ComfyUI 认为节点已变、必须重跑 doit。

    block = never              ：无条件放行
    block = if_not_continued   ：未点"继续"时返回 ExecutionBlocker，下游停；
                                 点"继续"后自动重跑并放行
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "optional": {
                "block": ("BOOLEAN", {
                    "default": False,
                    "label_on": "if_not_continued",
                    "label_off": "never",
                    "tooltip": (
                        "if_not_continued：未点\"继续\"前，执行到此停住，下游不执行。\n"
                        "never：从不停止，直接放行。"
                    ),
                }),
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

    def doit(self, image, block=False, unique_id=None):
        node_id = str(unique_id)

        # 本次执行是不是"继续"触发的？消费即清除。
        continued = core.consume_bridge_continued(node_id)

        if continued:
            image_path, mask_path, preview_item = core.get_bridge_paths(node_id)
            print(
                f"[BlueBox] Bridge 继续: node_id={node_id}, "
                f"image_path={image_path}, mask_path={mask_path}"
            )
            if image_path and os.path.isfile(image_path):
                pixels, mask = self._load_from_disk(image_path, mask_path)

                ui_preview = [preview_item] if preview_item else [{
                    "filename": os.path.basename(image_path),
                    "subfolder": "",
                    "type": "input",
                }]

                return self._finalize(node_id, ui_preview, pixels, mask, block, continued)

            print(f"[BlueBox] Bridge 收到继续标记但无烘焙图，回退重新注入")

        # ---- 重新注入：把上游图存 temp 当占位 ----
        rgb_np_u8 = image[0].cpu().numpy()
        rgb_np_u8 = np.clip(rgb_np_u8 * 255, 0, 255).astype(np.uint8)
        pil = Image.fromarray(rgb_np_u8, mode="RGB")

        temp_dir = folder_paths.get_temp_directory()
        sub_dir = os.path.join(temp_dir, "BlueBoxBridge")
        os.makedirs(sub_dir, exist_ok=True)
        fname = "bb_bridge_{}_{}.png".format(node_id, uuid.uuid4().hex[:8])
        fpath = os.path.join(sub_dir, fname)
        pil.save(fpath)

        core.set_bridge_image(node_id, fpath, None, {
            "filename": fname,
            "subfolder": "BlueBoxBridge",
            "type": "temp",
        })

        h, w = rgb_np_u8.shape[:2]
        mask = torch.zeros((1, h, w), dtype=torch.float32)
        image_tensor = torch.from_numpy(
            (rgb_np_u8.astype(np.float32) / 255.0)
        )[None,]

        ui_preview = [{
            "filename": fname,
            "subfolder": "BlueBoxBridge",
            "type": "temp",
        }]

        return self._finalize(node_id, ui_preview, image_tensor, mask, block, continued)

    def _finalize(self, node_id, images_ui, pixels, mask, block, continued):
        """
        放行判定：
          - block=False                → 无条件放行
          - block=True 且未点"继续"    → ExecutionBlocker（下游停）
          - block=True 且已点"继续"    → 放行
        """
        should_block = False
        if block and not continued:
            should_block = True

        if should_block:
            try:
                from comfy_execution.graph import ExecutionBlocker
                return {
                    "ui": {"images": images_ui},
                    "result": (ExecutionBlocker(None), ExecutionBlocker(None)),
                }
            except Exception as e:
                print(f"[BlueBox] ExecutionBlocker 不可用（{e}），block 被忽略")
                return {
                    "ui": {"images": images_ui},
                    "result": (pixels, mask),
                }

        return {
            "ui": {"images": images_ui},
            "result": (pixels, mask),
        }

    def _load_from_disk(self, image_path, mask_path):
        """
        读磁盘烘焙图。
        完全以烘焙图自身为准，不与上游 tensor 比对尺寸
        （编辑器支持裁切/扩图/旋转/缩放，几何可变是合法的）。
        遮罩只校验与主图自洽。
        """
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
            except Exception as e:
                print(f"[BlueBox] 读取遮罩失败：{e}")
                mask_np = None

        if mask_np is not None and (mask_np.shape[0] != rgb_h or mask_np.shape[1] != rgb_w):
            print(f"[BlueBox] 遮罩尺寸 {mask_np.shape} 与主图 {(rgb_h, rgb_w)} 不匹配，回退全零")
            mask_np = None
        if mask_np is None:
            mask_np = np.zeros((rgb_h, rgb_w), dtype=np.float32)

        mask_tensor = torch.from_numpy(mask_np)[None,]
        return image_tensor, mask_tensor

    @classmethod
    def IS_CHANGED(cls, image, block=False, unique_id=None):
        node_id = str(unique_id) if unique_id else ""
        # 用"继续序号"作为变化因子：
        #   每次点继续，序号 +1，返回值必然不同 → ComfyUI 一定重跑 doit。
        #   点运行时序号为 0（或与上次不同），也会重跑，走刷新分支。
        seq = core.get_bridge_continue_seq(node_id)
        block_flag = 1 if block else 0
        return f"{seq}_{block_flag}"


# ============================================================
# 注册
# ============================================================
NODE_CLASS_MAPPINGS = {
    "BlueBoxLoadImage": BlueBoxLoadImage,
    "BlueBoxBridge": BlueBoxBridge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxLoadImage": "Load Image (BlueBox)",
    "BlueBoxBridge": "Bridge (BlueBox)",
}