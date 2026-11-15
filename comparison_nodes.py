import os
import time
import uuid
import numpy as np
from PIL import Image
import folder_paths


COMPARE_PREVIEW_MAX_EDGE = 6400


def _to_rgb_uint8(tensor):
    """ComfyUI IMAGE 张量 (H,W,C) -> HxWx3 uint8 numpy"""
    arr = tensor.cpu().numpy()
    if arr.ndim == 3 and arr.shape[-1] >= 3:
        arr = arr[..., :3]

    if arr.dtype == np.uint8:
        pass
    elif arr.dtype in (np.float16, np.float32, np.float64):
        arr = np.clip(arr, 0.0, 1.0) * 255.0
        arr = arr.astype(np.uint8)
    elif arr.dtype == np.uint16:
        arr = (arr.astype(np.float32) / 257.0).astype(np.uint8)
    else:
        arr = np.clip(arr, 0, 255).astype(np.uint8)

    return np.ascontiguousarray(arr)


def _resize_for_preview(pil_image):
    """长边超过 COMPARE_PREVIEW_MAX_EDGE 时等比缩小；否则原样返回。"""
    w, h = pil_image.size
    if max(w, h) <= COMPARE_PREVIEW_MAX_EDGE:
        return pil_image
    scale = COMPARE_PREVIEW_MAX_EDGE / float(max(w, h))
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    return pil_image.resize((nw, nh), Image.LANCZOS)


def _save_preview(pil_image, path, fmt, quality):
    """预览图：按用户 format/quality 快速编码，method=0 优先速度。"""
    if fmt == "WEBP":
        pil_image.save(path, format="WEBP", quality=int(quality), method=0)
        return "image/webp"
    pil_image.save(path, format="PNG", compress_level=1)
    return "image/png"


def _save_original(pil_image, path_no_ext, fmt):
    """
    原图：全尺寸，格式跟随用户选择。
      - WEBP: quality=100, method=0
      - PNG : compress_level=1（无损，忽略 quality）
      - WEBP 编码失败（大图 libwebp 分区限制）-> 回退 PNG
    返回 (实际路径, 实际 mime, 是否发生回退)
    """
    if fmt == "WEBP":
        webp_path = path_no_ext + ".webp"
        try:
            pil_image.save(webp_path, format="WEBP", quality=100, method=0)
            return webp_path, "image/webp", False
        except Exception:
            # 大图 WEBP 仍可能 encoding error 6，回退无损 PNG
            png_path = path_no_ext + ".png"
            pil_image.save(png_path, format="PNG", compress_level=1)
            return png_path, "image/png", True

    png_path = path_no_ext + ".png"
    pil_image.save(png_path, format="PNG", compress_level=1)
    return png_path, "image/png", False


def _touch(path):
    """触发落盘，减少 /view 立即请求读到半张文件的概率。"""
    try:
        with open(path, "rb") as f:
            f.read(1)
    except Exception:
        pass


class BlueBoxComparisonImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_a": ("IMAGE", ),
                "image_b": ("IMAGE", ),
                "format": (["WEBP", "PNG"], {"default": "WEBP"}),
                "quality": ("INT", {"default": 85, "min": 1, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "compare"
    CATEGORY = "BlueBox/experimental"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Slider comparison of two images via file-backed preview (no base64). "
        "Preview capped at 6400px long edge; right-click Open/Save/Copy uses "
        "full-resolution original (user format; WEBP q100, PNG lossless)."
    )

    def compare(self, image_a, image_b, format, quality):
        temp_dir = folder_paths.get_temp_directory()
        sub_dir = os.path.join(temp_dir, "BlueBoxComparisonImage")
        os.makedirs(sub_dir, exist_ok=True)

        stamp = "{}_{}".format(int(time.time() * 1000), uuid.uuid4().hex[:8])

        results = {}
        fallbacks = {}

        for tag, tensor in (("a", image_a[0]), ("b", image_b[0])):
            pil_full = Image.fromarray(_to_rgb_uint8(tensor), mode="RGB")
            full_w, full_h = pil_full.size

            # ---- 预览：长边 <= 6400，用户 format/quality ----
            preview_img = _resize_for_preview(pil_full)
            preview_fname = "bb_cmp_prev_{}_{}.{}".format(
                tag, stamp, "webp" if format == "WEBP" else "png"
            )
            preview_fpath = os.path.join(sub_dir, preview_fname)
            preview_mime = _save_preview(preview_img, preview_fpath, format, quality)

            # ---- 原图：全尺寸，用户 format，WEBP q100 / PNG 无损 ----
            orig_stem = os.path.join(sub_dir, "bb_cmp_orig_{}_{}".format(tag, stamp))
            orig_fpath, orig_mime, fallback = _save_original(pil_full, orig_stem, format)
            orig_fname = os.path.basename(orig_fpath)

            _touch(preview_fpath)
            _touch(orig_fpath)

            results[tag] = {
                "preview_fname": preview_fname,
                "preview_mime": preview_mime,
                "preview_size": [preview_img.size[0], preview_img.size[1]],
                "orig_fname": orig_fname,
                "orig_mime": orig_mime,
                "orig_size": [full_w, full_h],
            }
            if fallback:
                fallbacks[tag] = True

        return {
            "ui": {
                "a_preview_filename": [results["a"]["preview_fname"]],
                "a_preview_mime": [results["a"]["preview_mime"]],
                "a_preview_size": [results["a"]["preview_size"]],
                "a_orig_filename": [results["a"]["orig_fname"]],
                "a_orig_mime": [results["a"]["orig_mime"]],
                "a_orig_size": [results["a"]["orig_size"]],
                "b_preview_filename": [results["b"]["preview_fname"]],
                "b_preview_mime": [results["b"]["preview_mime"]],
                "b_preview_size": [results["b"]["preview_size"]],
                "b_orig_filename": [results["b"]["orig_fname"]],
                "b_orig_mime": [results["b"]["orig_mime"]],
                "b_orig_size": [results["b"]["orig_size"]],
                "webp_fallback": [
                    {
                        "a": bool(fallbacks.get("a")),
                        "b": bool(fallbacks.get("b")),
                    }
                ],
                "subfolder": ["BlueBoxComparisonImage"],
                "type": ["temp"],
            },
            "result": (),
        }


NODE_CLASS_MAPPINGS = {
    "BlueBoxComparisonImage": BlueBoxComparisonImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxComparisonImage": "Comparison Image (BlueBox)",
}