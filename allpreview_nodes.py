import os
import time
import uuid
import numpy as np
from PIL import Image
import folder_paths


PREVIEW_MAX_EDGE = 4096


class BlueBoxAllPreview:
    """
    AllPreview(BlueBox)：看图 + 下载原图。

    设计：
      - 节点内预览：限制长边 4096，按用户选的 format（WEBP/PNG）编码，秒开、不卡。
      - 右键 Open/Save/Copy：使用原尺寸文件。原图强制 PNG 保存，
        避开 libwebp 对大图的分区限制（encoding error 6），同时保证无损精度。
      - 不 base64 内联，避免 WebSocket 帧上限导致大图不显示。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", ),
                "format": (["WEBP", "PNG"], {"default": "WEBP"}),
                "quality": ("INT", {"default": 90, "min": 1, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "BlueBox/experimental"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Preview with 4096-edge limit for fast display; right-click Open/Save/Copy "
        "uses the full-resolution PNG file (avoids WebP encoding limit on huge images)."
    )

    def preview(self, image, format, quality):
        arr = image[0].cpu().numpy()
        if arr.ndim == 3 and arr.shape[-1] >= 3:
            arr = arr[..., :3]

        if arr.dtype == np.uint8:
            pass
        elif arr.dtype in (np.float16, np.float32, np.float64):
            # ComfyUI IMAGE 约定 0-1 浮点；先 clip 再乘 255，
            # 不用 max() 猜范围，避免个别溢出点导致整张图误判
            arr = np.clip(arr, 0.0, 1.0) * 255.0
            arr = arr.astype(np.uint8)
        elif arr.dtype == np.uint16:
            arr = (arr.astype(np.float32) / 257.0).astype(np.uint8)
        else:
            arr = np.clip(arr, 0, 255).astype(np.uint8)

        print(
            f"[BlueBox] shape={arr.shape} dtype={arr.dtype} "
            f"min={arr.min()} max={arr.max()} "
            f"meanR={arr[...,0].mean():.4f} "
            f"meanG={arr[...,1].mean():.4f} "
            f"meanB={arr[...,2].mean():.4f}"
        )
        arr = np.ascontiguousarray(arr)
        pil_image = Image.fromarray(arr, mode="RGB")

        width, height = pil_image.size

        temp_dir = folder_paths.get_temp_directory()
        sub_dir = os.path.join(temp_dir, "BlueBoxAllPreview")
        os.makedirs(sub_dir, exist_ok=True)

        stamp = "{}_{}".format(int(time.time() * 1000), uuid.uuid4().hex[:8])

        # ---- 1) 原图文件：强制 PNG，避开 WebP 分区限制（encoding error 6） ----
        orig_fname = "bb_allpreview_orig_{}.png".format(stamp)
        orig_fpath = os.path.join(sub_dir, orig_fname)
        pil_image.save(orig_fpath, format="PNG", compress_level=1)

        # ---- 2) 预览文件：按用户选 format，长边 <= 4096 ----
        w, h = pil_image.size
        if max(w, h) > PREVIEW_MAX_EDGE:
            scale = PREVIEW_MAX_EDGE / float(max(w, h))
            nw = max(1, int(round(w * scale)))
            nh = max(1, int(round(h * scale)))
            preview_img = pil_image.resize((nw, nh), Image.LANCZOS)
        else:
            preview_img = pil_image

        if format == "WEBP":
            preview_mime = "image/webp"
            preview_fname = "bb_allpreview_prev_{}.webp".format(stamp)
            preview_fpath = os.path.join(sub_dir, preview_fname)
            preview_img.save(
                preview_fpath, format="WEBP", quality=int(quality), method=0
            )
        else:
            preview_mime = "image/png"
            preview_fname = "bb_allpreview_prev_{}.png".format(stamp)
            preview_fpath = os.path.join(sub_dir, preview_fname)
            preview_img.save(preview_fpath, format="PNG", compress_level=1)

        # 触发落盘，减少 /view 立即请求读到半张的概率
        for p in (orig_fpath, preview_fpath):
            try:
                with open(p, "rb") as _f:
                    _f.read(1)
            except Exception:
                pass

        return {
            "ui": {
                "bg_filename": [preview_fname],
                "bg_subfolder": ["BlueBoxAllPreview"],
                "bg_type": ["temp"],
                "bg_mime": [preview_mime],
                "orig_filename": [orig_fname],
                "orig_subfolder": ["BlueBoxAllPreview"],
                "orig_type": ["temp"],
                "orig_mime": ["image/png"],
                "img_size": [[width, height]],
                "preview_size": [[preview_img.size[0], preview_img.size[1]]],
            },
            "result": (),
        }


NODE_CLASS_MAPPINGS = {
    "BlueBoxAllPreview": BlueBoxAllPreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxAllPreview": "AllPreview (BlueBox)",
}