const { app } = window.comfyAPI.app;

export function makeUUID() {
  let dt = new Date().getTime()
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = ((dt + Math.random() * 16) % 16) | 0
    dt = Math.floor(dt / 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
  return uuid
}

function chainCallback(object, property, callback) {
  if (object == undefined) {
    console.error("Tried to add callback to non-existant object")
    return;
  }
  if (property in object) {
    const callback_orig = object[property]
    object[property] = function () {
      const r = callback_orig.apply(this, arguments);
      callback.apply(this, arguments);
      return r
    };
  } else {
    object[property] = callback;
  }
}

app.registerExtension({
  name: 'BlueBox.BlueBoxAllPreview',

  getNodeMenuItems(node) {
    const items = [];

    if (node?.comfyClass !== 'BlueBoxAllPreview') return items;

    const imgData = node?.properties?.imgData;
    if (!imgData?.base64) return items;

    const mime = imgData.type || "image/webp";
    const url = `data:${mime};base64,${imgData.base64}`;
    const ext = mime === "image/png" ? "png" : "webp";

    items.push({
      content: "Open Image",
      callback: () => {
        const w = window.open("");
        w.document.write(`<img src="${url}" style="max-width:100%">`);
      }
    });
    items.push({
      content: "Save Image",
      callback: () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = `bluebox_preview.${ext}`;
        a.click();
      }
    });
    items.push({
      content: "Copy Image",
      callback: async () => {
        try {
          const blob = await (await fetch(url)).blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        } catch (e) {
          console.error("Copy failed", e);
        }
      }
    });

    return items;
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === 'BlueBoxAllPreview') {
      chainCallback(nodeType.prototype, "onNodeCreated", function () {

        // ===== 外层容器：纵向 flex（上图 / 下文字） =====
        var element = document.createElement("div");
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.display = 'flex';
        element.style.flexDirection = 'column';
        element.style.overflow = 'hidden';
        element.style.boxSizing = 'border-box';

        // ===== 图片区 =====
        var imgArea = document.createElement("div");
        imgArea.style.flex = '1 1 auto';
        imgArea.style.minHeight = '0';
        imgArea.style.backgroundSize = 'contain';
        imgArea.style.backgroundRepeat = 'no-repeat';
        imgArea.style.backgroundPosition = 'center';
        element.appendChild(imgArea);

        // ===== 底部尺寸文字：透明背景，字体继承节点原生样式 =====
        var infoBar = document.createElement("div");
        infoBar.style.flex = '0 0 auto';
        infoBar.style.padding = '2px 6px';
        infoBar.style.textAlign = 'center';
        infoBar.style.whiteSpace = 'nowrap';
        infoBar.style.overflow = 'hidden';
        infoBar.style.userSelect = 'none';
        infoBar.style.background = 'transparent';
        infoBar.style.border = 'none';
        infoBar.style.color = 'inherit';       // 跟随节点主题文字色
        infoBar.style.fontFamily = 'inherit';  // 跟随 ComfyUI 原生字体
        infoBar.style.fontSize = 'inherit';    // 跟随原生字号
        infoBar.style.lineHeight = '1.2';
        infoBar.style.display = 'none';        // 没图时完全不占位
        infoBar.textContent = '';
        element.appendChild(infoBar);

        this.uuid = makeUUID()

        // ===== 滚轮：转发给 canvas，保留缩放（只绑图片区） =====
        imgArea.addEventListener("wheel", (e) => {
          const canvas = this.graph?.canvas ?? app.canvas;
          if (canvas && typeof canvas.processMouseWheel === "function") {
            canvas.processMouseWheel(e);
          }
          e.preventDefault();
        }, { passive: false });

        // ===== 右键：拦截浏览器菜单，转发给节点菜单 =====
        imgArea.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const canvas = this.graph?.canvas ?? app.canvas;
          if (!canvas) return;

          if (typeof canvas.processContextMenu === "function") {
            canvas.processContextMenu(this, e);
            return;
          }
          if (typeof canvas.getNodeMenuOptions === "function" &&
              typeof LGraphCanvas !== "undefined" &&
              LGraphCanvas.ContextMenu) {
            const options = canvas.getNodeMenuOptions(this);
            new LGraphCanvas.ContextMenu(canvas, e, canvas.canvas.constructor, options);
          }
        });

        // ===== 中键：转发给 canvas 实现画布拖动 =====
        let middleDragging = false;

        imgArea.addEventListener("pointerdown", (e) => {
          if (e.button !== 1) return;
          middleDragging = true;
          e.preventDefault();
          e.stopPropagation();

          const canvas = this.graph?.canvas ?? app.canvas;
          if (!canvas) return;

          if (typeof canvas.processMouseDown === "function") {
            canvas.processMouseDown(e);
          } else if (typeof canvas.onMouseDown === "function") {
            canvas.onMouseDown(e);
          }

          const onMove = (ev) => {
            if (!middleDragging) return;
            ev.preventDefault();
            if (typeof canvas.processMouseMove === "function") {
              canvas.processMouseMove(ev);
            } else if (typeof canvas.onMouseMove === "function") {
              canvas.onMouseMove(ev);
            }
          };

          const onUp = (ev) => {
            if (!middleDragging) return;
            middleDragging = false;
            if (typeof canvas.processMouseUp === "function") {
              canvas.processMouseUp(ev);
            } else if (typeof canvas.onMouseUp === "function") {
              canvas.onMouseUp(ev);
            }
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
          };

          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onUp, true);
        }, { passive: false });

        this.previewWidget = this.addDOMWidget(nodeData.name, "BlueBoxAllPreviewWidget", element, {
          serialize: false,
          hideOnZoom: false,
        });

        this.previewer = new Previewer(this);
        this.sizeLabel = infoBar;
        this.imgArea = imgArea;

        this.setSize([320, 320]);
        this.resizable = true;

        this.previewWidget.parentEl = element;

        chainCallback(this, "onExecuted", function (message) {
          let bg_image = message["bg_image"];
          let bg_mime = message["bg_mime"];
          const mime = bg_mime ? bg_mime[0] : "image/webp";
          this.properties.imgData = {
            name: "bg_image",
            base64: bg_image,
            type: mime
          };

          const size = message["img_size"];
          this.properties.imgSize = size ? size[0] : null;

          this.previewer.refreshBackgroundImage(this);
          this.previewer.refreshSizeLabel(this);
        });

      }); // onNodeCreated
    }
  }
})

class Previewer {
  constructor(context) {
    this.node = context;
  }

  refreshBackgroundImage = () => {
    const imgData = this.node?.properties?.imgData;
    const el = this.node?.imgArea;
    if (imgData?.base64 && el) {
      const base64String = imgData.base64;
      const mime = imgData.type || "image/webp";
      const imageUrl = `data:${mime};base64,${base64String}`;

      el.style.backgroundImage = `url(${imageUrl})`;
      el.style.backgroundSize = 'contain';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.backgroundPosition = 'center';
    }
  };

  refreshSizeLabel = () => {
    const label = this.node?.sizeLabel;
    if (!label) return;
    const size = this.node?.properties?.imgSize;
    if (Array.isArray(size) && size.length === 2) {
      label.textContent = `${size[0]} × ${size[1]}`;
      label.style.display = 'block';
    } else {
      label.textContent = '';
      label.style.display = 'none';
    }
  };
}