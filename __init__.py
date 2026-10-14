import os
import folder_paths
from aiohttp import web
from server import PromptServer

from .bluebox_nodes import BlueBoxLoadImage, BlueBoxBridge
from . import bluebox_core as core

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "BlueBoxLoadImage": BlueBoxLoadImage,
    "BlueBoxBridge": BlueBoxBridge,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BlueBoxLoadImage": "Load Image (BlueBox)",
    "BlueBoxBridge": "Bridge (BlueBox)",
}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


@PromptServer.instance.routes.post("/bluebox/bridge_register")
async def bluebox_bridge_register(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    image_filename = data.get("image_filename")
    mask_filename = data.get("mask_filename")
    preview_filename = data.get("preview_filename")

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

    core.set_bridge_image(node_id, image_path, mask_path, preview_item)

    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/bluebox/bridge_continue")
async def bluebox_bridge_continue(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))

    if not node_id:
        return web.json_response({"ok": False, "error": "missing node_id"})

    core.set_bridge_continued(node_id, True)
    return web.json_response({"ok": True})