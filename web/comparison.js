// web/comparison.js
import { app } from "../../scripts/app.js";
import { makeUUID, chainCallback } from "./bluebox_utils.js";

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

function extFromMime(mime, fallback) {
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  return fallback || "png";
}

app.registerExtension({
  name: "BlueBox.ComparisonImage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "BlueBoxComparisonImage") return;

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      // ===== 外层容器 =====
      const element = document.createElement("div");
      element.style.cssText = `
        width: 100%; height: 100%; box-sizing: border-box;
        display: flex; flex-direction: column; overflow: hidden;
      `;

      // ===== 对比区 =====
      const stage = document.createElement("div");
      stage.style.cssText = `
        position: relative; flex: 1 1 auto; min-height: 0;
        overflow: hidden; user-select: none;
        background: #111;
      `;
      element.appendChild(stage);

      // ===== 底部尺寸/格式文字 =====
      const infoBar = document.createElement("div");
      infoBar.style.cssText = `
        flex: 0 0 auto; padding: 2px 6px; text-align: center;
        white-space: nowrap; overflow: hidden; user-select: none;
        background: transparent; border: none;
        color: inherit; font-family: inherit; font-size: inherit;
        line-height: 1.2; display: none;
      `;
      element.appendChild(infoBar);

      // ===== 两个图层 + 两张图（都用 /view URL，浏览器原生降采样） =====
      const layerA = document.createElement("div");
      layerA.style.cssText = `position: absolute; inset: 0; overflow: hidden;`;

      const layerB = document.createElement("div");
      layerB.style.cssText = `position: absolute; inset: 0; overflow: hidden;`;

      const imgStyle = `
        position: absolute; inset: 0; width: 100%; height: 100%;
        pointer-events: none; display: block;
        object-fit: contain; object-position: center;
      `;

      const imgA = document.createElement("img");
      imgA.style.cssText = imgStyle;
      imgA.draggable = false;

      const imgB = document.createElement("img");
      imgB.style.cssText = imgStyle;
      imgB.draggable = false;

      layerA.appendChild(imgA);
      layerB.appendChild(imgB);

      // ===== 分割线 =====
      const divider = document.createElement("div");
      divider.style.cssText = `
        position: absolute; top: 0; bottom: 0; left: 50%;
        width: 0;
        background: transparent;
        box-shadow: 0 0 0 0.5px rgba(255,255,255,.85);
        cursor: ew-resize;
        z-index: 3; touch-action: none;
        will-change: left, box-shadow;
        pointer-events: none;
      `;

      // ===== 角标 =====
      const mkLabel = (text, side) => {
        const el = document.createElement("div");
        el.textContent = text;
        el.style.cssText = `
          position: absolute; top: 6px; ${side}: 8px; z-index: 4;
          padding: 1px 6px; border-radius: 3px;
          font: 11px/1.4 sans-serif; color: #fff;
          background: rgba(0,0,0,.5); pointer-events: none;
          max-width: 45%; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap;
        `;
        return el;
      };
      const labelAEl = mkLabel("A", "left");
      const labelBEl = mkLabel("B", "right");

      stage.append(layerA, layerB, divider, labelAEl, labelBEl);

      // ===== 拖动逻辑 =====
      let dragging = false;
      let ratio = 0.5;

      const toStageLocalX = (clientX) => {
        const r = stage.getBoundingClientRect();
        const s = r.width / (stage.offsetWidth || 1);
        return (clientX - r.left) / (s || 1);
      };

      const applyRatio = () => {
        const sw = stage.clientWidth;
        if (sw <= 0) return;
        const x = Math.round(ratio * sw);
        layerB.style.clipPath = `inset(0 0 0 ${x}px)`;
        divider.style.left = `${x}px`;

        const zoom = app?.canvas?.ds?.scale || 1;
        const spread = 0.5 / Math.max(zoom, 0.01);
        divider.style.boxShadow = `0 0 0 ${spread}px rgba(255,255,255,.85)`;
      };

      const setRatioFromClientX = (clientX) => {
        const sw = stage.clientWidth;
        if (sw <= 0) return;
        const localX = toStageLocalX(clientX);
        ratio = Math.min(1, Math.max(0, localX / sw));
        applyRatio();
      };

      const resync = () => applyRatio();

      const onPointerDown = (e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        dragging = true;
        stage.setPointerCapture?.(e.pointerId);
        setRatioFromClientX(e.clientX);
        e.preventDefault();
        e.stopPropagation();
      };
      const onPointerMove = (e) => {
        if (!dragging) return;
        setRatioFromClientX(e.clientX);
        e.preventDefault();
      };
      const onPointerUp = (e) => {
        if (!dragging) return;
        dragging = false;
        try { stage.releasePointerCapture?.(e.pointerId); } catch (_) {}
      };

      stage.addEventListener("pointerdown", onPointerDown, { passive: false });
      stage.addEventListener("pointermove", onPointerMove, { passive: false });
      stage.addEventListener("pointerup", onPointerUp);
      stage.addEventListener("pointercancel", onPointerUp);

      const ro = new ResizeObserver(() => resync());
      ro.observe(stage);

      // ===== 画布 zoom/pan 同步分割线粗细 =====
      const ds = app?.canvas?.ds;
      let prevOnChanged = null;
      if (ds) {
        prevOnChanged = ds.onChanged;
        ds.onChanged = function (...args) {
          resync();
          if (prevOnChanged) prevOnChanged.apply(this, args);
        };
      }

      // ===== 滚轮透传 =====
      stage.addEventListener("wheel", (e) => {
        const canvas = this.graph?.canvas ?? app.canvas;
        if (canvas && typeof canvas.processMouseWheel === "function") {
          canvas.processMouseWheel(e);
        }
        e.preventDefault();
      }, { passive: false });

      // ===== 右键透传 =====
      stage.addEventListener("contextmenu", (e) => {
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

      // ===== 中键透传 =====
      let middleDragging = false;
      stage.addEventListener("pointerdown", (e) => {
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

      // ===== 挂 DOM widget =====
      this.uuid = makeUUID();
      this.cmpWidget = this.addDOMWidget(nodeData.name, "BlueBoxComparisonWidget", element, {
        serialize: false,
        hideOnZoom: false,
      });
      this.cmpWidget.parentEl = element;

      this.cmpElement = element;
      this.cmpStage = stage;
      this.cmpLayerA = layerA;
      this.cmpLayerB = layerB;
      this.cmpImgA = imgA;
      this.cmpImgB = imgB;
      this.cmpInfoBar = infoBar;
      this.cmpLabelA = labelAEl;
      this.cmpLabelB = labelBEl;
      this.cmpResync = resync;
      this.cmpResizeObserver = ro;

      this.setSize([520, 400]);
      this.resizable = true;

      chainCallback(this, "onRemoved", function () {
        try { ro.disconnect(); } catch (_) {}
        if (ds && prevOnChanged) {
          if (ds.onChanged !== prevOnChanged) ds.onChanged = prevOnChanged;
        }
      });

      // ===== onExecuted：只拿小字段，图像走 /view =====
      chainCallback(this, "onExecuted", function (message) {
        if (!message) return;

        const subfolder = pickFirst(message["subfolder"]) || "BlueBoxComparisonImage";
        const type = pickFirst(message["type"]) || "temp";

        const aPrevFname = pickFirst(message["a_preview_filename"]);
        const aPrevMime = pickFirst(message["a_preview_mime"]) || "image/webp";
        const aPrevSize = pickFirst(message["a_preview_size"]) ?? null;
        const aOrigFname = pickFirst(message["a_orig_filename"]);
        const aOrigMime = pickFirst(message["a_orig_mime"]) || aPrevMime;
        const aOrigSize = pickFirst(message["a_orig_size"]) ?? aPrevSize;

        const bPrevFname = pickFirst(message["b_preview_filename"]);
        const bPrevMime = pickFirst(message["b_preview_mime"]) || "image/webp";
        const bPrevSize = pickFirst(message["b_preview_size"]) ?? null;
        const bOrigFname = pickFirst(message["b_orig_filename"]);
        const bOrigMime = pickFirst(message["b_orig_mime"]) || bPrevMime;
        const bOrigSize = pickFirst(message["b_orig_size"]) ?? bPrevSize;

        if (!aPrevFname || !bPrevFname) return;

        const aPrevUrl = buildViewUrl(aPrevFname, subfolder, type);
        const bPrevUrl = buildViewUrl(bPrevFname, subfolder, type);
        const aOrigUrl = aOrigFname ? buildViewUrl(aOrigFname, subfolder, type) : aPrevUrl;
        const bOrigUrl = bOrigFname ? buildViewUrl(bOrigFname, subfolder, type) : bPrevUrl;

        this.properties.cmpA = {
          previewUrl: aPrevUrl,
          origUrl: aOrigUrl,
          previewMime: aPrevMime,
          origMime: aOrigMime,
          previewSize: aPrevSize,
          origSize: aOrigSize,
        };
        this.properties.cmpB = {
          previewUrl: bPrevUrl,
          origUrl: bOrigUrl,
          previewMime: bPrevMime,
          origMime: bOrigMime,
          previewSize: bPrevSize,
          origSize: bOrigSize,
        };

        // 先清空再赋值，避免浏览器沿用旧缓存
        imgA.removeAttribute("src");
        imgB.removeAttribute("src");
        imgA.src = aPrevUrl;
        imgB.src = bPrevUrl;

        // ===== infoBar：尺寸 + 实际下载格式 =====
        const fmtSize = (s) =>
          Array.isArray(s) && s.length === 2 ? `${s[0]}×${s[1]}` : "?";
        const fmtMime = (m) => (m === "image/png" ? "PNG" : m === "image/webp" ? "WEBP" : "?");

        const same =
          aOrigSize && bOrigSize &&
          aOrigSize[0] === bOrigSize[0] && aOrigSize[1] === bOrigSize[1];

        let text = same
          ? `${fmtSize(aOrigSize)}`
          : `A: ${fmtSize(aOrigSize)}  |  B: ${fmtSize(bOrigSize)}`;

        // 原图格式与预览格式不同（WEBP 回退 PNG）时提示
        const aDl = fmtMime(aOrigMime);
        const bDl = fmtMime(bOrigMime);
        text += `  ·  Download: A ${aDl} / B ${bDl}`;

        const fb = pickFirst(message["webp_fallback"]);
        if (fb && (fb.a || fb.b)) {
          const who = [fb.a ? "A" : null, fb.b ? "B" : null].filter(Boolean).join("/");
          text += `  (WEBP→PNG fallback: ${who})`;
        }

        infoBar.textContent = text;
        infoBar.style.display = "block";

        imgA.onload = () => resync();
        imgB.onload = () => resync();
        applyRatio();
      });
    }); // onNodeCreated
  },

  // ===== 右键菜单：Open/Save/Copy 走全尺寸原图，扩展名跟随实际 mime =====
  getNodeMenuItems(node) {
    const items = [];
    if (node?.comfyClass !== 'BlueBoxComparisonImage') return items;

    const mkGroup = (title, data) => {
      if (!data?.origUrl) return [];
      const url = data.origUrl;
      const ext = extFromMime(data.origMime, "png");

      return [
        {
          content: `Open ${title}`,
          callback: () => {
            window.open(url, "_blank");
          }
        },
        {
          content: `Save ${title}`,
          callback: async () => {
            try {
              const resp = await fetch(url);
              const blob = await resp.blob();
              const blobUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = blobUrl;
              a.download = `bluebox_compare_${title}.${ext}`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
            } catch (e) {
              console.error("[BlueBox] Save failed", e);
            }
          }
        },
        {
          content: `Copy ${title}`,
          callback: async () => {
            try {
              const blob = await (await fetch(url)).blob();
              await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            } catch (e) {
              console.error("[BlueBox] Copy failed", e);
            }
          }
        },
      ];
    };

    items.push(...mkGroup("A", node?.properties?.cmpA));
    if (items.length) items.push(null);
    items.push(...mkGroup("B", node?.properties?.cmpB));

    return items;
  },
});