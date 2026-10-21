import math
import torch
import numpy as np
from PIL import Image


ROTATE_INFO_TYPE = "BLUEBOX_ROTATE_INFO"


def _tensor_to_pil(t: torch.Tensor) -> Image.Image:
    arr = (t.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    if arr.shape[2] == 4:
        rgb = arr[:, :, :3].astype(np.float32)
        a = (arr[:, :, 3:4].astype(np.float32) / 255.0)
        rgb = rgb * a
        arr = rgb.clip(0, 255).astype(np.uint8)
    else:
        arr = arr[:, :, :3]
    return Image.fromarray(arr, mode="RGB")


def _pil_to_tensor(img: Image.Image) -> torch.Tensor:
    if img.mode != "RGB":
        img = img.convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)


def _rotate_pil(img: Image.Image, angle: float) -> Image.Image:
    # 顺时针为正；黑填充；expand
    return img.rotate(
        -angle,
        resample=Image.BICUBIC,
        expand=True,
        fillcolor=(0, 0, 0),
    )


def _bbox_size(w: int, h: int, angle: float) -> tuple:
    """原始 w×h 旋转 angle 度后的包围盒尺寸（与 PIL expand 结果一致，向上取整）。"""
    rad = math.radians(angle)
    cos_a = abs(math.cos(rad))
    sin_a = abs(math.sin(rad))
    bw = w * cos_a + h * sin_a
    bh = w * sin_a + h * cos_a
    # 与 PIL 的取整行为对齐
    return int(math.ceil(bw - 1e-6)), int(math.ceil(bh - 1e-6))


def _center_crop_pad(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """把 img 居中放到 target_w×target_h 的画布上（不足补黑，超出则中心裁切）。"""
    rw, rh = img.size
    if rw < target_w or rh < target_h:
        canvas = Image.new("RGB", (max(rw, target_w), max(rh, target_h)), (0, 0, 0))
        canvas.paste(img, ((canvas.width - rw) // 2, (canvas.height - rh) // 2))
        img = canvas
        rw, rh = img.size
    left = (rw - target_w) // 2
    top = (rh - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


class BlueBoxRotateImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "angle": ("INT", {"default": 0, "min": -360, "max": 360, "step": 1}),
            },
            "optional": {
                "image": ("IMAGE",),
                "rotate_info": (ROTATE_INFO_TYPE,),
            },
        }

    RETURN_TYPES = ("IMAGE", ROTATE_INFO_TYPE)
    RETURN_NAMES = ("image", "rotate_info")
    FUNCTION = "rotate"
    CATEGORY = "BlueBox/experimental"
    DESCRIPTION = (
        "单节点角度叠加旋转。无 rotate_info = 起始：以当前图为原始基准，记录 orig_w/h 与 angle。"
        "有 rotate_info = 继续：total = info.angle + angle，先逆旋转回原始方向，再按 total 重转，"
        "以 orig_w/h 计算包围盒输出（不裁切、不滚雪球）。"
    )

    def rotate(self, angle, image=None, rotate_info=None):
        if image is None:
            raise ValueError("Rotate Image (BlueBox): 必须连接 image 输入")

        img_t = image[0] if image.dim() == 4 else image
        pil = _tensor_to_pil(img_t)

        # ===== 起始模式 =====
        if rotate_info is None:
            orig_w, orig_h = pil.size
            rotated = _rotate_pil(pil, angle)
            info = {
                "orig_w": int(orig_w),
                "orig_h": int(orig_h),
                "angle": float(angle),
                "fill": "black",
                "interp": "bicubic",
            }
            out_t = _pil_to_tensor(rotated).unsqueeze(0)
            return (out_t, info)

        # ===== 继续模式 =====
        if not isinstance(rotate_info, dict) or "orig_w" not in rotate_info:
            raise ValueError("Rotate Image (BlueBox): rotate_info 格式无效")

        orig_w = int(rotate_info["orig_w"])
        orig_h = int(rotate_info["orig_h"])
        prev_angle = float(rotate_info.get("angle", 0.0))
        total_angle = prev_angle + float(angle)

        # 1) 当前图处于 prev_angle 旋转状态（中间处理在此状态下进行）
        #    先逆旋转回原始方向
        back_to_orig = _rotate_pil(pil, -prev_angle)

        # 2) 逆旋转后，裁/补到 orig_w×orig_h（消除逆旋转可能引入的 ±1 像素偏差）
        base = _center_crop_pad(back_to_orig, orig_w, orig_h)

        # 3) 再按累积角度旋转，得到完整容纳原图的包围盒
        final = _rotate_pil(base, total_angle)

        # 4) 理论上 final 尺寸 = _bbox_size(orig_w, orig_h, total_angle)，
        #    用 center_crop_pad 兜底对齐，避免浮点/取整差异
        target_w, target_h = _bbox_size(orig_w, orig_h, total_angle)
        final = _center_crop_pad(final, target_w, target_h)

        out_t = _pil_to_tensor(final).unsqueeze(0)

        out_info = dict(rotate_info)
        out_info["angle"] = total_angle
        return (out_t, out_info)


NODE_CLASS_MAPPINGS = {
    "BlueBoxRotateImage": BlueBoxRotateImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxRotateImage": "Rotate Image (BlueBox)",
}