import os


# node_id -> (image_path, mask_path, preview_item)
#   image_path   : 干净 RGB 主图绝对路径
#   mask_path    : 纯遮罩灰度图绝对路径（可为 None）
#   preview_item : ui.images 用的 dict
bridge_image_cache = {}

# node_id -> int，最近一次"继续"的单调递增序号。
# 用序号而非 bool，是为了让 IS_CHANGED 每次返回不同的值，
# 避免 ComfyUI 缓存命中导致 doit 不被重跑。
bridge_continue_seq = {}
_bridge_seq_counter = 0


def set_bridge_image(node_id, image_path, mask_path, preview_item):
    bridge_image_cache[str(node_id)] = (image_path, mask_path, preview_item)


def get_bridge_paths(node_id):
    item = bridge_image_cache.get(str(node_id))
    if item is None:
        return None, None, None
    return item[0], item[1], item[2]


def set_bridge_continued(node_id, flag=True):
    """标记 node 为'已继续'。用递增序号，保证每次标记都产生新值。"""
    global _bridge_seq_counter
    nid = str(node_id)
    if flag:
        _bridge_seq_counter += 1
        bridge_continue_seq[nid] = _bridge_seq_counter
    else:
        bridge_continue_seq.pop(nid, None)


def is_bridge_continued(node_id):
    return str(node_id) in bridge_continue_seq


def consume_bridge_continued(node_id):
    """读取并清除'继续'标志。返回 True/False。"""
    return bridge_continue_seq.pop(str(node_id), None) is not None


def get_bridge_continue_seq(node_id):
    """只读，供 IS_CHANGED 使用。"""
    return bridge_continue_seq.get(str(node_id), 0)


def clear_bridge_continued(node_id):
    bridge_continue_seq.pop(str(node_id), None)


def clear_bridge(node_id):
    nid = str(node_id)
    bridge_image_cache.pop(nid, None)
    bridge_continue_seq.pop(nid, None)

_bridge_reference = {}

def set_bridge_reference(node_id, image_path):
    _bridge_reference[str(node_id)] = image_path

def get_bridge_reference(node_id):
    return _bridge_reference.get(str(node_id))