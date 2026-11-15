const { app } = window.comfyAPI.app;

export function makeUUID() {
  let dt = new Date().getTime();
  const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = ((dt + Math.random() * 16) % 16) | 0;
    dt = Math.floor(dt / 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
  return uuid;
}

function chainCallback(object, property, callback) {
  if (object == undefined) {
    console.error("Tried to add callback to non-existant object");
    return;
  }
  if (property in object) {
    const callback_orig = object[property];
    object[property] = function () {
      const r = callback_orig.apply(this, arguments);
      callback.apply(this, arguments);
      return r;
    };
  } else {
    object[property] = callback;
  }
}

function buildViewUrl(filename, subfolder, type) {
  return (
    "/view?filename=" +
    encodeURIComponent(filename) +
    "&subfolder=" +
    encodeURIComponent(subfolder || "") +
    "&type=" +
    encodeURIComponent(type || "temp")
  );
}

function pickFirst(v) {
  return Array.isArray(v) ? v[0] : v;
}

function extFromFilename(name, fallback) {
  if (!name || typeof name !== "string") return fallback || "png";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return fallback || "png";
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "webp" || ext === "png" || ext === "jpg" || ext === "jpeg") {
    return ext === "jpeg" ? "jpg" : ext;
  }
  return fallback || "png";
}

app.registerExtension({
  name: "BlueBox.BlueBoxAllPreview",

  getNodeMenuItems(node) {
    const items = [];
    if (node?.comfyClass !== "BlueBoxAllPreview") return items;

    const imgData = node?.properties?.imgData;
    if (!imgData) return items;

    // 菜单操作用原图 URL；没有则回退预览 URL
    const fullUrl = imgData.origUrl || imgData.previewUrl;
    if (!fullUrl) return items;

    const ext = extFromFilename(imgData.origName || imgData.name, "png");

    items.push({
      content: "Open Image",
      callback: () => {
        window.open(fullUrl, "_blank");
      },
    });
    items.push({
      content: "Save Image",
      callback: async () => {
        try {
          const resp = await fetch(fullUrl);
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = `bluebox_preview.${ext}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        } catch (e) {
          console.error("[BlueBox] Save failed", e);
        }
      },
    });
    items.push({
      content: "Copy Image",
      callback: async () => {
        try {
          const resp = await fetch(fullUrl);
          const blob = await resp.blob();
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob }),
          ]);
        } catch (e) {
          console.error("[BlueBox] Copy failed", e);
        }
      },
    });

    return items;
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name === "BlueBoxAllPreview") {
      chainCallback(nodeType.prototype, "onNodeCreated", function () {
        var element = document.createElement("div");
        element.style.width = "100%";
        element.style.height = "100%";
        element.style.display = "flex";
        element.style.flexDirection = "column";
        element.style.overflow = "hidden";
        element.style.boxSizing = "border-box";

        // 图片区：用 <img>，浏览器对大图会按显示尺寸降采样
        var imgArea = document.createElement("div");
        imgArea.style.flex = "1 1 auto";
        imgArea.style.minHeight = "0";
        imgArea.style.display = "flex";
        imgArea.style.alignItems = "center";
        imgArea.style.justifyContent = "center";
        imgArea.style.overflow = "hidden";
        imgArea.style.background = "transparent";

        var imgEl = document.createElement("img");
        imgEl.style.maxWidth = "100%";
        imgEl.style.maxHeight = "100%";
        imgEl.style.objectFit = "contain";
        imgEl.style.display = "none";
        imgEl.style.userSelect = "none";
        imgEl.style.pointerEvents = "none";
        imgEl.draggable = false;
        imgArea.appendChild(imgEl);
        element.appendChild(imgArea);

        var infoBar = document.createElement("div");
        infoBar.style.flex = "0 0 auto";
        infoBar.style.padding = "2px 6px";
        infoBar.style.textAlign = "center";
        infoBar.style.whiteSpace = "nowrap";
        infoBar.style.overflow = "hidden";
        infoBar.style.userSelect = "none";
        infoBar.style.background = "transparent";
        infoBar.style.border = "none";
        infoBar.style.color = "inherit";
        infoBar.style.fontFamily = "inherit";
        infoBar.style.fontSize = "inherit";
        infoBar.style.lineHeight = "1.2";
        infoBar.style.display = "none";
        infoBar.textContent = "";
        element.appendChild(infoBar);

        this.uuid = makeUUID();

        imgArea.addEventListener(
          "wheel",
          (e) => {
            const canvas = this.graph?.canvas ?? app.canvas;
            if (canvas && typeof canvas.processMouseWheel === "function") {
              canvas.processMouseWheel(e);
            }
            e.preventDefault();
          },
          { passive: false },
        );

        imgArea.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const canvas = this.graph?.canvas ?? app.canvas;
          if (!canvas) return;

          if (typeof canvas.processContextMenu === "function") {
            canvas.processContextMenu(this, e);
            return;
          }
          if (
            typeof canvas.getNodeMenuOptions === "function" &&
            typeof LGraphCanvas !== "undefined" &&
            LGraphCanvas.ContextMenu
          ) {
            const options = canvas.getNodeMenuOptions(this);
            new LGraphCanvas.ContextMenu(
              canvas,
              e,
              canvas.canvas.constructor,
              options,
            );
          }
        });

        let middleDragging = false;

        imgArea.addEventListener(
          "pointerdown",
          (e) => {
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
          },
          { passive: false },
        );

        this.previewWidget = this.addDOMWidget(
          nodeData.name,
          "BlueBoxAllPreviewWidget",
          element,
          {
            serialize: false,
            hideOnZoom: false,
          },
        );

        this.previewer = new Previewer(this);
        this.sizeLabel = infoBar;
        this.imgArea = imgArea;
        this.imgEl = imgEl;

        this.setSize([320, 320]);
        this.resizable = true;

        this.previewWidget.parentEl = element;

        chainCallback(this, "onExecuted", function (message) {
          const prevFilename = pickFirst(message["bg_filename"]);
          const prevSubfolder = pickFirst(message["bg_subfolder"]);
          const prevType = pickFirst(message["bg_type"]);
          const mime = pickFirst(message["bg_mime"]);
          const origFilename = pickFirst(message["orig_filename"]);
          const origSubfolder = pickFirst(message["orig_subfolder"]);
          const origType = pickFirst(message["orig_type"]);
          const origMime = pickFirst(message["orig_mime"]);

          if (!prevFilename && !origFilename) {
            this.properties.imgData = null;
            this.previewer.refreshBackgroundImage(this);
            this.previewer.refreshSizeLabel(this);
            return;
          }

          const previewUrl = prevFilename
            ? buildViewUrl(prevFilename, prevSubfolder, prevType)
            : null;
          const origUrl = origFilename
            ? buildViewUrl(origFilename, origSubfolder, origType)
            : null;

          this.properties.imgData = {
            name: prevFilename || origFilename,
            origName: origFilename || prevFilename,
            previewUrl: previewUrl,
            origUrl: origUrl,
            type: mime || "image/webp",
            origType: origMime || "image/png",
          };

          const size = pickFirst(message["img_size"]);
          this.properties.imgSize = size || null;

          this.previewer.refreshBackgroundImage(this);
          this.previewer.refreshSizeLabel(this);
        });
      });
    }
  },
});

class Previewer {
  constructor(context) {
    this.node = context;
  }

  refreshBackgroundImage = () => {
    const imgData = this.node?.properties?.imgData;
    const el = this.node?.imgEl;
    if (!el) return;

    const url = imgData?.previewUrl || imgData?.origUrl;
    if (url) {
      el.src = url;
      el.style.display = "block";
    } else {
      el.removeAttribute("src");
      el.style.display = "none";
    }
  };

  refreshSizeLabel = () => {
    const label = this.node?.sizeLabel;
    if (!label) return;
    const size = this.node?.properties?.imgSize;
    if (Array.isArray(size) && size.length === 2) {
      label.textContent = `${size[0]} × ${size[1]}`;
      label.style.display = "block";
    } else {
      label.textContent = "";
      label.style.display = "none";
    }
  };
}