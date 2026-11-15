import os


_bridge_state = {}
# node_id -> {
#   "image_path": str|None,
#   "mask_path": str|None,
#   "preview_item": dict|None,
#   "reference_path": str|None,
#   "source_hash": str|None,
# }


def get_bridge_state(node_id):
    return _bridge_state.get(str(node_id))


def set_bridge_image(node_id, image_path, mask_path, preview_item, source_hash=None):
    nid = str(node_id)
    st = _bridge_state.get(nid) or {}
    st["image_path"] = image_path
    st["mask_path"] = mask_path
    st["preview_item"] = preview_item
    st["source_hash"] = source_hash
    _bridge_state[nid] = st


def set_bridge_reference(node_id, path):
    nid = str(node_id)
    st = _bridge_state.get(nid) or {}
    st["reference_path"] = path
    _bridge_state[nid] = st


def get_bridge_reference(node_id):
    st = _bridge_state.get(str(node_id))
    return st.get("reference_path") if st else None


def clear_bridge(node_id):
    _bridge_state.pop(str(node_id), None)