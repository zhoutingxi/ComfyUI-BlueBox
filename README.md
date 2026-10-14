# ComfyUI-BlueBox

> ComfyUI 图像生成链路中的「可视化编辑 + 桥接」系统。
> 在 Load Image 处加载图片、在链路中间插入可编辑的 Bridge 节点，
> 用内置的 WebGL 遮罩编辑器完成遮罩绘制、涂鸦、裁切、扩图、调色，
> 再一键回填到工作流继续执行。

---

## 功能特性

- **Load Image (BlueBox)**：加载图片并自动推断遮罩
  - 遮罩来源优先级：`mask_file` 输入 → 同名 sidecar 文件 → Alpha 通道 → 全零遮罩
  - 支持 `image_upload`，直接在工作流中上传图片
  - 输出 `image` + `mask` 两个张量

- **Bridge (BlueBox)**：链路中间的可编辑断点
  - 点「运行」：无论上游是否变化，重新注入上游原图，走占位刷新流程
  - 点「继续」：用编辑器烘焙好的图（磁盘缓存）作为输出，放行下游
  - `block` 选项支持「未点继续前阻塞下游执行」

- **内置遮罩编辑器**（`web/mask-editor.html`）
  - 遮罩工具：画笔、矩形、圆形、填充、橡皮擦
  - 涂鸦工具：画笔、矩形、圆形、填充、橡皮擦，支持半透明（60%）
  - 图像操作：裁切、旋转 90°、扩图（Ctrl + 拖拽，带磁性吸附）
  - 调色：纹理、自动颜色、输入/输出色阶、亮度、对比、饱和、RGB 偏色
  - 其他：前进/后退历史、原图对比、缩放、Alt 吸管取色
  - 全程 WebGL 渲染，支持大图

---

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/zhoutingxi/ComfyUI-BlueBox.git ComfyUI-BlueBox
```

重启 ComfyUI 即可。无需安装额外依赖。

---

## 依赖

本插件**不引入任何第三方 Python 包**。

后端仅使用 Python 标准库，以及 ComfyUI 本体已自带的：

| 依赖 | 来源 | 用途 |
|------|------|------|
| `numpy` | ComfyUI 自带 | 图像数组运算 |
| `torch` | ComfyUI 自带 | 张量处理 |
| `Pillow` | ComfyUI 自带 | 图像读写、EXIF 旋转 |
| `aiohttp` | ComfyUI 自带 | 注册自定义 API 路由 |

前端仅使用浏览器原生 API（WebGL / IndexedDB / Canvas / postMessage），无需任何 CDN 外链。

`requirements.txt` 可以留空。

---

## 环境要求

- **ComfyUI**：需要较新版本（依赖 `comfy_execution.graph.ExecutionBlocker` 实现阻塞功能）。
  - 老版本 ComfyUI 上插件仍可运行，但 `block = if_not_continued` 的阻塞会失效（自动降级为无条件放行），控制台会打印提示。
- **浏览器**：需支持 **WebGL** 与 **IndexedDB**。
  - 推荐 Chrome / Edge（兼容性最稳、无存储过期问题）。
  - Safari 对 IndexedDB 有 **7 天未访问自动清除** 的策略，可能导致编辑快照丢失，建议尽快操作。

---

## 使用方法

### 基础流程

1. 在工作流开头添加 **Load Image (BlueBox)**，选择图片。
2. 在链路中间添加 **Bridge (BlueBox)**，把上游 `image` 接进来。
3. 右键节点 → **🟦 在 BLUEBOX 编辑器中打开**。
4. 在编辑器中绘制遮罩 / 涂鸦 / 裁切 / 扩图 / 调色。
5. 点「应用」保存并关闭。
6. 回到 ComfyUI：
   - 点节点上的 **「继续」** 按钮 → 使用编辑结果放行下游。
   - 或直接 **运行工作流** → 重新注入上游原图。

### Bridge 的 `block` 选项

| 值 | 行为 |
|----|------|
| `never`（默认） | 从不停止，直接放行 |
| `if_not_continued` | 未点「继续」前阻塞下游；点「继续」后自动重跑并放行 |

### 编辑器快捷键

| 快捷键 | 功能 |
|--------|------|
| `B` | 遮罩画笔 |
| `E` | 擦除遮罩 |
| `R` / `C` / `F` | 矩形 / 圆形 / 填充遮罩 |
| `D` | 涂鸦画笔 |
| `X` | 涂鸦橡皮擦 |
| `Shift+R` / `Shift+C` / `Shift+F` | 涂鸦矩形 / 圆形 / 填充 |
| `Ctrl + 拖拽` | 扩图（带磁性吸附） |
| `Alt` | 吸管取色 |
| `Ctrl+Z` / `Ctrl+Y` | 后退 / 前进 |
| `中键拖拽` | 平移视图 |
| `空格` | 切换自适应 / 100% |
| `裁切+Ctrl` 从图像外部拖拽| 扩图 |
| `Esc` | 取消选区 / 退出裁切 / 扩图 |

---

## 工作原理（简述）

- **Load Image (BlueBox)**：按优先级解析遮罩，输出 `IMAGE` + `MASK`，并生成一张叠色预览图（temp 目录）用于 UI 显示。
- **Bridge (BlueBox)**：
  - 后端在内存中维护 `node_id → (image_path, mask_path, preview_item)` 缓存，以及一个单调递增的「继续序号」。
  - 前端点「继续」时，POST `/bluebox/bridge_continue`，序号 +1，`IS_CHANGED` 返回值随之变化，强制 ComfyUI 重跑 `doit`。
  - `doit` 消费一次「继续」标记：若存在烘焙图则读磁盘输出，否则回退为重新注入上游原图。
- **编辑器回填**：
  - LoadImage 分支：上传主图 / 遮罩 / 预览图，写回 `image` 与 `mask_file` widget。
  - Bridge 分支：上传后 POST `/bluebox/bridge_register`，把路径登记到后端缓存，等待「继续」。

---

## 目录结构

```
ComfyUI-BlueBox/
├── __init__.py         
├── bluebox_nodes.py    
├── bluebox_core.py     
├── requirements.txt    
├── README.md
└── web/
    ├── bluebox.js       
    └── mask-editor.html 
```

---

## 常见问题

**Q：点「继续」后下游没反应？**
A：检查节点上是否已弹出编辑结果预览；若仍是占位图，说明后端还没收到烘焙图，可重新打开编辑器点「应用」。

**Q：编辑器打开后是空白 / 提示等待图片？**
A：确认该节点已有可编辑的图片（LoadImage 的 `image` widget 已选图，或 Bridge 已收到上游图）。

**Q：Safari 下编辑快照丢失？**
A：Safari 对 IndexedDB 有 7 天未访问自动清除策略，建议改用 Chrome / Edge，或尽快完成编辑。

**Q：老版本 ComfyUI 上 `block` 不生效？**
A：老版本没有 `ExecutionBlocker`，插件会自动降级为无条件放行，升级 ComfyUI 即可。

---

## 许可

MIT License