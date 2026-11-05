import math
import torch

_RESOLUTIONS = list(range(128, 4096 + 1, 32))
MIN_RESOLUTION = _RESOLUTIONS[0]   # 128
MAX_RESOLUTION = _RESOLUTIONS[-1]  # 4096

MIN_SIDE = 128
MAX_SIDE = 4096

_STANDARD_RATIOS = [
    1.0, 4/3, 3/4, 16/9, 9/16, 3/2, 2/3,
]


def _auto_resolution(width: int, height: int) -> int:
    target = math.sqrt(float(width) * float(height))
    snapped = int(round(target / 32.0)) * 32
    if snapped < MIN_RESOLUTION:
        snapped = MIN_RESOLUTION
    if snapped > MAX_RESOLUTION:
        snapped = MAX_RESOLUTION
    if snapped not in _RESOLUTIONS:
        snapped = min(_RESOLUTIONS, key=lambda r: abs(r - snapped))
    return snapped


def _snap_manual_resolution(value: int) -> int:    
    v = int(value)
    snapped = int(round(v / 32.0)) * 32
    if snapped < MIN_RESOLUTION:
        snapped = MIN_RESOLUTION
    if snapped > MAX_RESOLUTION:
        snapped = MAX_RESOLUTION
    if snapped not in _RESOLUTIONS:
        snapped = min(_RESOLUTIONS, key=lambda r: abs(r - snapped))
    return snapped


def _generate_whitelist(resolution: int, tol_ratio: float = 1.0):
    n = resolution // 32
    if n < 1:
        return []
    target = n * n
    tol = max(1, int(n * tol_ratio))
    pairs = []
    seen = set()
    for k in range(1, n * 3):
        for m in range(1, n * 3):
            prod = k * m
            if abs(prod - target) <= tol:
                w, h = k * 32, m * 32
                if w > MAX_SIDE or h > MAX_SIDE:     
                    continue
                if w < MIN_SIDE or h < MIN_SIDE:     
                    continue
                if (w, h) in seen:
                    continue
                seen.add((w, h))
                pairs.append((w, h, prod))
    return pairs


def _ratio_distance(a: float, b: float) -> float:
    return abs(math.log(a) - math.log(b))


def _score_candidate(w, h, prod, resolution, input_ratio):
    ratio = w / h
    d_input = _ratio_distance(ratio, input_ratio)
    d_std = min(_ratio_distance(ratio, r) for r in _STANDARD_RATIOS)
    target_area = resolution * resolution
    d_area = abs(prod * 1024 - target_area) / target_area
    return d_input * 1.0 + d_std * 0.6 + d_area * 0.4


def _pick_target_size(width, height, resolution, tol_ratio=1.0):
    input_ratio = width / height
    whitelist = _generate_whitelist(resolution, tol_ratio)
    if not whitelist:
        raise ValueError(f"resolution={resolution} 无法生成白名单")
    best = None
    best_score = float("inf")
    for w, h, prod in whitelist:
        s = _score_candidate(w, h, prod, resolution, input_ratio)
        if s < best_score:
            best_score = s
            best = (w, h)
    return best, whitelist


def _verify_fixed_point(w, h, resolution):
    scale_by = math.sqrt((resolution * resolution) / (w * h))
    w2 = int(round(w * scale_by / 32.0)) * 32
    h2 = int(round(h * scale_by / 32.0)) * 32
    w2 = min(MAX_SIDE, max(MIN_SIDE, w2))
    h2 = min(MAX_SIDE, max(MIN_SIDE, h2))
    return w2, h2


def _center_crop_to(image, tw, th):
    squeeze = False
    if image.dim() == 3:
        image = image.unsqueeze(0)
        squeeze = True
    b, h, w, c = image.shape
    scale = max(tw / w, th / h)
    nw = max(tw, int(round(w * scale)))
    nh = max(th, int(round(h * scale)))
    img = image.permute(0, 3, 1, 2)
    img = torch.nn.functional.interpolate(img, size=(nh, nw), mode="bilinear", align_corners=False)
    img = img.permute(0, 2, 3, 1)
    top = (nh - th) // 2
    left = (nw - tw) // 2
    img = img[:, top:top + th, left:left + tw, :]
    if squeeze:
        img = img.squeeze(0)
    return img


def _pad_to(image, tw, th, pad_color=0.0):
    squeeze = False
    if image.dim() == 3:
        image = image.unsqueeze(0)
        squeeze = True
    b, h, w, c = image.shape
    scale = min(tw / w, th / h)
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    img = image.permute(0, 3, 1, 2)
    img = torch.nn.functional.interpolate(img, size=(nh, nw), mode="bilinear", align_corners=False)
    img = img.permute(0, 2, 3, 1)
    canvas = torch.full((b, th, tw, c), pad_color, dtype=img.dtype, device=img.device)
    top = (th - nh) // 2
    left = (tw - nw) // 2
    canvas[:, top:top + nh, left:left + nw, :] = img
    if squeeze:
        canvas = canvas.squeeze(0)
    return canvas


def _stretch_to(image, tw, th):
    squeeze = False
    if image.dim() == 3:
        image = image.unsqueeze(0)
        squeeze = True
    img = image.permute(0, 3, 1, 2)
    img = torch.nn.functional.interpolate(img, size=(th, tw), mode="bilinear", align_corners=False)
    img = img.permute(0, 2, 3, 1)
    if squeeze:
        img = img.squeeze(0)
    return img


def _snap_fixed_point(tw, th, resolution, tol_ratio, input_w, input_h):
    w2, h2 = _verify_fixed_point(tw, th, resolution)
    if (w2, h2) == (tw, th):
        return tw, th
    whitelist = _generate_whitelist(resolution, tol_ratio)
    input_ratio = input_w / input_h
    fallback = None
    best_err = float("inf")
    for cw, ch, _ in whitelist:
        cw2, ch2 = _verify_fixed_point(cw, ch, resolution)
        if (cw2, ch2) == (cw, ch):
            err = _ratio_distance(cw / ch, input_ratio)
            if err < best_err:
                best_err = err
                fallback = (cw, ch)
    if fallback:
        return fallback
    return tw, th


class CutQwenImage21:
   
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "resolution_mode": (["default", "manual"], {"default": "default"}),
                "resolution_value": ("INT", {
                    "default": 1024,
                    "min": MIN_RESOLUTION,
                    "max": MAX_RESOLUTION,
                    "step": 32,
                }),
                "mode": (["crop", "pad", "stretch"], {"default": "crop"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height", "resolution")
    FUNCTION = "run"
    CATEGORY = "BlueBox/Qwen"

    def run(self, image, resolution_mode, resolution_value, mode):
        _, h, w, _ = image.shape

        if resolution_mode == "default":
            resolution = _auto_resolution(w, h)
        else:
            resolution = _snap_manual_resolution(resolution_value)

        (tw, th), _ = _pick_target_size(w, h, resolution, tol_ratio=1.0)
        tw, th = _snap_fixed_point(tw, th, resolution, 1.0, w, h)

        if mode == "pad":
            out = _pad_to(image, tw, th, pad_color=0.0)   
        elif mode == "stretch":
            out = _stretch_to(image, tw, th)
        else:
            out = _center_crop_to(image, tw, th)

        return (out, tw, th, resolution)


NODE_CLASS_MAPPINGS = {"CutQwenImage21": CutQwenImage21}
NODE_DISPLAY_NAME_MAPPINGS = {"CutQwenImage21": "Cut (Qwen-Image 2.1) — BlueBox"}