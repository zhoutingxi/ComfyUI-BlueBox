import io
import base64
import torchvision.transforms as T
from PIL import Image


to_pil_image = T.ToPILImage()


def _encode_image(tensor, fmt, quality):
    """ComfyUI IMAGE 张量 (H,W,C) float [0,1] -> (base64_str, mime, w, h)"""
    pil_image = to_pil_image(tensor.permute(2, 0, 1).clamp(0, 1))
    width, height = pil_image.size

    with io.BytesIO() as buffered:
        if fmt == "WEBP":
            pil_image.save(buffered, format="WEBP", quality=quality)
            mime = "image/webp"
        else:
            pil_image.save(buffered, format="PNG")
            mime = "image/png"
        data = base64.b64encode(buffered.getvalue()).decode("utf-8")

    return data, mime, width, height


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
        "Slider comparison of two images via base64 preview, no disk save. "
        "Drag the divider to reveal A (first input) / B (second input)."
    )

    def compare(self, image_a, image_b, format, quality):
        a_b64, a_mime, a_w, a_h = _encode_image(image_a[0], format, quality)
        b_b64, b_mime, b_w, b_h = _encode_image(image_b[0], format, quality)

        return {
            "ui": {
                "image_a": [a_b64],
                "image_a_mime": [a_mime],
                "image_b": [b_b64],
                "image_b_mime": [b_mime],
                "size_a": [[a_w, a_h]],
                "size_b": [[b_w, b_h]],
            },
            "result": ()
        }


NODE_CLASS_MAPPINGS = {
    "BlueBoxComparisonImage": BlueBoxComparisonImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxComparisonImage": "Comparison Image (BlueBox)",
}