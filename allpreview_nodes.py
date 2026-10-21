import io
import base64
import torchvision.transforms as T
from PIL import Image


to_pil_image = T.ToPILImage()


class BlueBoxAllPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", ),
                "format": (["WEBP", "PNG"], {"default": "WEBP"}),
                "quality": ("INT", {"default": 75, "min": 1, "max": 100, "step": 1}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "BlueBox/experimental"
    OUTPUT_NODE = True
    DESCRIPTION = "Fast image preview by displaying through base64 without saving to disk. Supports WEBP (lossy, default) and PNG (lossless)."

    def preview(self, image, format, quality):
        pil_image = to_pil_image(image[0].permute(2, 0, 1))
        width, height = pil_image.size

        with io.BytesIO() as buffered:
            if format == "WEBP":
                pil_image.save(buffered, format="WEBP", quality=quality)
            else:
                # PNG 无损，quality 参数无效，忽略
                pil_image.save(buffered, format="PNG")
            img_bytes = buffered.getvalue()

        img_base64 = base64.b64encode(img_bytes).decode("utf-8")

        mime = "image/webp" if format == "WEBP" else "image/png"

        return {
            "ui": {
                "bg_image": [img_base64],
                "bg_mime": [mime],
                "img_size": [[width, height]],
            },
            "result": ()
        }


NODE_CLASS_MAPPINGS = {
    "BlueBoxAllPreview": BlueBoxAllPreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxAllPreview": "AllPreview (BlueBox)",
}