import os
import folder_paths
from aiohttp import web
from server import PromptServer

from .bluebox_nodes import BlueBoxLoadImage, BlueBoxBridge
from . import bluebox_core as core

from .allpreview_nodes import (
    NODE_CLASS_MAPPINGS as PREVIEW_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as PREVIEW_NODE_DISPLAY_NAME_MAPPINGS,
)

from .comparison_nodes import (
    NODE_CLASS_MAPPINGS as COMPARE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as COMPARE_NODE_DISPLAY_NAME_MAPPINGS,
)

from .nodes.rotate_image_bluebox import (
    NODE_CLASS_MAPPINGS as ROTATE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as ROTATE_NODE_DISPLAY_NAME_MAPPINGS,
)

from .nodes.cut_qwen_image_21 import (
    NODE_CLASS_MAPPINGS as CUT_QWEN_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as CUT_QWEN_NODE_DISPLAY_NAME_MAPPINGS,
)

from .nodes.color_calibrator_bluebox import (
    NODE_CLASS_MAPPINGS as COLOR_CALIB_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as COLOR_CALIB_NODE_DISPLAY_NAME_MAPPINGS,
)

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "BlueBoxLoadImage": BlueBoxLoadImage,
    "BlueBoxBridge": BlueBoxBridge,
    **PREVIEW_NODE_CLASS_MAPPINGS,
    **COMPARE_NODE_CLASS_MAPPINGS,
    **ROTATE_NODE_CLASS_MAPPINGS,
    **CUT_QWEN_NODE_CLASS_MAPPINGS,
    **COLOR_CALIB_NODE_CLASS_MAPPINGS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxLoadImage": "Load Image (BlueBox)",
    "BlueBoxBridge": "Bridge (BlueBox)",
    **PREVIEW_NODE_DISPLAY_NAME_MAPPINGS,
    **COMPARE_NODE_DISPLAY_NAME_MAPPINGS,
    **ROTATE_NODE_DISPLAY_NAME_MAPPINGS,
    **CUT_QWEN_NODE_DISPLAY_NAME_MAPPINGS,
    **COLOR_CALIB_NODE_DISPLAY_NAME_MAPPINGS,
}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


@PromptServer.instance.routes.post("/bluebox/bridge_register")
async def bluebox_bridge_register(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    image_filename = data.get("image_filename")
    mask_filename = data.get("mask_filename")
    preview_filename = data.get("preview_filename")
    source_hash = data.get("source_hash")

    if not node_id or not image_filename:
        return web.json_response({"ok": False, "error": "missing node_id or image_filename"})

    input_dir = folder_paths.get_input_directory()

    def _resolve(fname):
        if not fname:
            return None
        p = os.path.join(input_dir, fname)
        return p if os.path.isfile(p) else None

    image_path = _resolve(image_filename)
    if image_path is None:
        return web.json_response({"ok": False, "error": "image file not found"})

    mask_path = _resolve(mask_filename)

    preview_item = None
    if preview_filename:
        p = os.path.join(input_dir, preview_filename)
        if os.path.isfile(p):
            preview_item = {
                "filename": preview_filename,
                "subfolder": "",
                "type": "input",
            }

    core.set_bridge_image(node_id, image_path, mask_path, preview_item, source_hash=source_hash)
    # 回填只更新缓存与预览，不放行、不设令牌，是否向下游传递由用户手动关闭 accept_input 后运行决定
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/bluebox/bridge_current_image")
async def bluebox_bridge_current_image(request):
    node_id = str(request.query.get("node_id", ""))
    if not node_id:
        return web.json_response({"ok": False, "error": "missing node_id"})

    state = core.get_bridge_state(node_id)
    if not state:
        return web.json_response({"ok": False, "error": "no image"})

    image_path = state.get("image_path")
    if not image_path or not os.path.isfile(image_path):
        return web.json_response({"ok": False, "error": "no image"})

    preview_item = state.get("preview_item")
    if preview_item and preview_item.get("filename"):
        item = preview_item
    else:
        item = {
            "filename": os.path.basename(image_path),
            "subfolder": "",
            "type": "input",
        }

    return web.json_response({"ok": True, "image": item})


@PromptServer.instance.routes.get("/bluebox/bridge_reference_image")
async def bluebox_bridge_reference_image(request):
    node_id = str(request.query.get("node_id", ""))
    if not node_id:
        return web.json_response({"ok": False, "error": "missing node_id"})

    ref_path = core.get_bridge_reference(node_id)
    if not ref_path or not os.path.isfile(ref_path):
        return web.json_response({"ok": False, "error": "no reference"})

    return web.json_response({
        "ok": True,
        "image": {
            "filename": os.path.basename(ref_path),
            "subfolder": "BlueBoxBridge",
            "type": "temp",
        },
    })


@PromptServer.instance.routes.get("/bluebox/preview")
async def bluebox_preview(request):
    filename = request.query.get("filename", "")
    subfolder = request.query.get("subfolder", "")
    type_ = request.query.get("type", "input")
    try:
        max_edge = int(request.query.get("max_edge", "2048"))
    except Exception:
        max_edge = 2048
    if max_edge < 64:
        max_edge = 64

    if not filename:
        return web.Response(status=400, text="missing filename")

    if type_ == "temp":
        base_dir = folder_paths.get_temp_directory()
    elif type_ == "output":
        base_dir = folder_paths.get_output_directory()
    else:
        base_dir = folder_paths.get_input_directory()

    path = (
        os.path.join(base_dir, subfolder, filename)
        if subfolder
        else os.path.join(base_dir, filename)
    )
    if not os.path.isfile(path):
        return web.Response(status=404, text="not found")

    try:
        from PIL import Image, ImageOps
        import io

        img = Image.open(path)
        img = ImageOps.exif_transpose(img)

        icc = img.info.get("icc_profile")

        if img.mode in ("I;16", "I;16B", "I;16L", "I"):
            import numpy as np
            arr = np.array(img, dtype=np.float32)
            arr = np.clip(arr / 256.0, 0, 255).astype(np.uint8)
            img = Image.fromarray(arr)

        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if img.mode in ("LA", "PA") else "RGB")

        w, h = img.size
        if max(w, h) > max_edge:
            scale = max_edge / float(max(w, h))
            nw = max(1, int(round(w * scale)))
            nh = max(1, int(round(h * scale)))
            img = img.resize((nw, nh), Image.LANCZOS)

        buf = io.BytesIO()
        save_kwargs = {"format": "WEBP", "quality": 75, "method": 4}
        if icc:
            save_kwargs["icc_profile"] = icc
        img.save(buf, **save_kwargs)
        buf.seek(0)
        return web.Response(body=buf.read(), content_type="image/webp")
    except Exception as e:
        print(f"[BlueBox] preview 生成失败: {e}")
        return web.Response(status=500, text="preview failed")