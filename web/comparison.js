// web/comparison.js
import { app } from "../../scripts/app.js";
import { makeUUID, chainCallback } from "./bluebox_utils.js";

app.registerExtension({
  name: 'BlueBox.ComparisonImage',

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== 'BlueBoxComparisonImage') return;

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

      // ===== 底部尺寸文字 =====
      const infoBar = document.createElement("div");
      infoBar.style.cssText = `
        flex: 0 0 auto; padding: 2px 6px; text-align: center;
        white-space: nowrap; overflow: hidden; user-select: none;
        background: transparent; border: none;
        color: inherit; font-family: inherit; font-size: inherit;
        line-height: 1.2; display: none;
      `;
      element.appendChild(infoBar);

      // ===== 两个图层容器 + 两张图 =====
      // 两个 layer 都是 stage 全尺寸、同中心，图片各自 contain 居中。
      // 上层 layerB 用相对自身（= stage）的 clip-path 百分比裁剪，
      // 因此 clip 边界、divider.left、鼠标坐标天然在同一 stage 布局坐标系。
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

      const imgB = document.createElement("img");
      imgB.style.cssText = imgStyle;

      layerA.appendChild(imgA);
      layerB.appendChild(imgB);

      // ===== 分割线 =====
      // width:0 + box-shadow 画线：不占布局、无半像素平移问题。
      // 具体粗细在 applyRatio 里按画布 zoom 反向补偿。
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

      // ===== 拖动逻辑（统一 stage 布局坐标，抗画布 zoom） =====
      let dragging = false;
      let ratio = 0.5;

      // 将 client 坐标换算成 stage 的本地布局像素
      // （getBoundingClientRect 含画布 transform 缩放，除以 r.width/offsetWidth 还原）
      const toStageLocalX = (clientX) => {
        const r = stage.getBoundingClientRect();
        const s = r.width / (stage.offsetWidth || 1);
        return (clientX - r.left) / (s || 1);
      };

      const applyRatio = () => {
  const sw = stage.clientWidth;
  if (sw <= 0) return;

  // 同一整数像素：裁剪与滑块严格对齐
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

      // ===== 监听画布 zoom/pan，同步分割线粗细 =====
      const ds = app?.canvas?.ds;
      let prevOnChanged = null;
      if (ds) {
        prevOnChanged = ds.onChanged;
        ds.onChanged = function (...args) {
          resync();
          if (prevOnChanged) prevOnChanged.apply(this, args);
        };
      }

      // ===== 滚轮 =====
      stage.addEventListener("wheel", (e) => {
        const canvas = this.graph?.canvas ?? app.canvas;
        if (canvas && typeof canvas.processMouseWheel === "function") {
          canvas.processMouseWheel(e);
        }
        e.preventDefault();
      }, { passive: false });

      // ===== 右键 =====
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

      // ===== 中键 =====
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

      // ===== onExecuted =====
      chainCallback(this, "onExecuted", function (message) {
        if (!message) return;

        const aB64 = message["image_a"]?.[0];
        const bB64 = message["image_b"]?.[0];
        if (!aB64 || !bB64) return;

        const aMime = message["image_a_mime"]?.[0] || "image/webp";
        const bMime = message["image_b_mime"]?.[0] || "image/webp";
        const sizeA = message["size_a"]?.[0] ?? null;
        const sizeB = message["size_b"]?.[0] ?? null;

        this.properties.cmpA = { base64: aB64, type: aMime, size: sizeA };
        this.properties.cmpB = { base64: bB64, type: bMime, size: sizeB };

        imgA.src = `data:${aMime};base64,${aB64}`;
        imgB.src = `data:${bMime};base64,${bB64}`;

        const fmt = (s) => (Array.isArray(s) && s.length === 2) ? `${s[0]}×${s[1]}` : "?";
        const same = sizeA && sizeB && sizeA[0] === sizeB[0] && sizeA[1] === sizeB[1];
        infoBar.textContent = same
          ? `${fmt(sizeA)}`
          : `A: ${fmt(sizeA)}  |  B: ${fmt(sizeB)}`;
        infoBar.style.display = "block";

        imgA.onload = () => resync();
        imgB.onload = () => resync();
        applyRatio();
      });
    }); // onNodeCreated
  },

  // ===== 右键菜单 =====
  getNodeMenuItems(node) {
    const items = [];
    if (node?.comfyClass !== 'BlueBoxComparisonImage') return items;

    const mkGroup = (title, data) => {
      if (!data?.base64) return [];
      const mime = data.type || "image/webp";
      const url = `data:${mime};base64,${data.base64}`;
      const ext = mime === "image/png" ? "png" : "webp";

      return [
        {
          content: `Open ${title}`,
          callback: () => {
            const w = window.open("");
            w.document.write(`<img src="${url}" style="max-width:100%">`);
          }
        },
        {
          content: `Save ${title}`,
          callback: () => {
            const a = document.createElement("a");
            a.href = url;
            a.download = `bluebox_compare_${title}.${ext}`;
            a.click();
          }
        },
        {
          content: `Copy ${title}`,
          callback: async () => {
            try {
              const blob = await (await fetch(url)).blob();
              await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            } catch (e) {
              console.error("Copy failed", e);
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