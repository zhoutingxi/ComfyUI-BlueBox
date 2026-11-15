console.log("[BlueBox] ============ bluebox.js 已加载 ============");
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXT_BASE = "/extensions/ComfyUI-BlueBox";
const PREVIEW_MAX_EDGE = 2048;

const BB_DB = {
  dbName: "MaskEditorDB",
  storeName: "images",
  db: null,
  init() {
    return new Promise((resolve, reject) => {
      if (this.db) return resolve(this.db);
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },
  put(id, data) {
    return this.init().then(
      (db) =>
        new Promise((res, rej) => {
          const tx = db.transaction(this.storeName, "readwrite");
          const r = tx
            .objectStore(this.storeName)
            .put({ id, data, timestamp: Date.now() });
          r.onsuccess = () => res();
          r.onerror = (e) => rej(e.target.error);
        }),
    );
  },
  get(id) {
    return this.init().then(
      (db) =>
        new Promise((res, rej) => {
          const tx = db.transaction(this.storeName, "readonly");
          const r = tx.objectStore(this.storeName).get(id);
          r.onsuccess = () => res(r.result?.data || null);
          r.onerror = (e) => rej(e.target.error);
        }),
    );
  },
  delete(id) {
    return this.init().then(
      (db) =>
        new Promise((res, rej) => {
          const tx = db.transaction(this.storeName, "readwrite");
          const r = tx.objectStore(this.storeName).delete(id);
          r.onsuccess = () => res();
          r.onerror = (e) => rej(e.target.error);
        }),
    );
  },
};

function chainCallback(object, property, callback) {
  if (!object) return;
  if (property in object) {
    const orig = object[property];
    object[property] = function () {
      const r = orig.apply(this, arguments);
      callback.apply(this, arguments);
      return r;
    };
  } else {
    object[property] = callback;
  }
}

function extractUrlFromImgEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  if (entry instanceof HTMLImageElement) return entry.src;
  if (entry.url) return entry.url;
  if (entry.src) return entry.src;
  if (entry.filename) {
    return (
      "/view?filename=" +
      encodeURIComponent(entry.filename) +
      "&subfolder=" +
      encodeURIComponent(entry.subfolder || "") +
      "&type=" +
      (entry.type || "output")
    );
  }
  return null;
}

function bbPreviewUrl(filename, subfolder, type, maxEdge) {
  return (
    "/bluebox/preview?filename=" +
    encodeURIComponent(filename) +
    "&subfolder=" +
    encodeURIComponent(subfolder || "") +
    "&type=" +
    encodeURIComponent(type || "input") +
    "&max_edge=" +
    encodeURIComponent(String(maxEdge || PREVIEW_MAX_EDGE))
  );
}

async function loadPreviewImage(filename, subfolder, type) {
  const url = bbPreviewUrl(filename, subfolder, type, PREVIEW_MAX_EDGE);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await new Promise((res) => {
    if (img.complete && img.naturalWidth > 0) return res();
    img.onload = () => res();
    img.onerror = () => res();
  });
  return img;
}

async function loadInputImage(filename) {
  const url =
    "/view?filename=" +
    encodeURIComponent(filename) +
    "&subfolder=&type=input";
  const img = new Image();
  img.src = url;
  await new Promise((res) => {
    if (img.complete && img.naturalWidth > 0) return res();
    img.onload = () => res();
    img.onerror = () => res();
  });
  return img;
}

async function uploadDataUrlToComfy(dataUrl, namePrefix) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
    const ext = blob.type.includes("jpeg")
      ? ".jpg"
      : blob.type.includes("webp")
        ? ".webp"
        : ".png";
    const filename = (namePrefix || "bb_") + hex + ext;

    const form = new FormData();
    form.append("image", blob, filename);
    form.append("overwrite", "true");

    const up = await fetch("/upload/image", { method: "POST", body: form });
    if (!up.ok) return null;
    const data = await up.json();
    return data.name || filename;
  } catch (e) {
    console.warn("[BlueBox] 上传失败:", e);
    return null;
  }
}

window._bbEditTargetNode = null;
window._bbEditNodeId = null;
let _bbPollTimer = null;
let _bbPollAttempts = 0;
const BB_POLL_MAX = 1200;

function getBridgeCurrentImageMeta(node) {
  if (!node) return null;
  const meta = node.__bbCurrentImageMeta;
  if (!meta || !meta.filename) return null;
  return meta;
}

async function fetchLatestReferenceDataUrl(node) {
  if (!node || node.comfyClass !== "BlueBoxBridge") return null;
  const nodeId = node.__bbNodeId || String(node.id);
  try {
    const resp = await fetch(
      "/bluebox/bridge_reference_image?node_id=" + encodeURIComponent(nodeId),
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.ok || !data.image?.filename) return null;
    const refUrl =
      "/view?filename=" +
      encodeURIComponent(data.image.filename) +
      "&subfolder=" +
      encodeURIComponent(data.image.subfolder || "") +
      "&type=" +
      encodeURIComponent(data.image.type || "temp");
    const r = await fetch(refUrl);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    });
  } catch (e) {
    return null;
  }
}

async function openBlueBoxEditor(node) {
  node.__bbNodeId = String(node.id);
  const nodeId = node.__bbNodeId;

  let url = null;

  if (node.comfyClass === "BlueBoxAllPreview") {
    const imgData = node.properties?.imgData;
    if (imgData?.base64) {
      const mime = imgData.type || "image/webp";
      url = `data:${mime};base64,${imgData.base64}`;
    }
  }

  const imgWidget = node.widgets?.find((w) => w.name === "image");
  if (
    !url &&
    imgWidget &&
    typeof imgWidget.value === "string" &&
    imgWidget.value
  ) {
    url =
      "/view?filename=" +
      encodeURIComponent(imgWidget.value) +
      "&subfolder=&type=input";
  }

  if (!url && node.comfyClass === "BlueBoxBridge") {
    try {
      const nodeId2 = node.__bbNodeId || String(node.id);
      const resp = await fetch(
        "/bluebox/bridge_current_image?node_id=" + encodeURIComponent(nodeId2),
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok && data.image && data.image.filename) {
          url =
            "/view?filename=" +
            encodeURIComponent(data.image.filename) +
            "&subfolder=" +
            encodeURIComponent(data.image.subfolder || "") +
            "&type=" +
            encodeURIComponent(data.image.type || "temp");
        }
      }
    } catch (e) {
      console.warn("[BlueBox] Bridge 兜底取图失败:", e);
    }
  }

  if (!url && node.imgs && node.imgs.length > 0) {
    url = extractUrlFromImgEntry(node.imgs[0]);
  }

  if (!url) {
    alert("该节点还没有可编辑的图片");
    return;
  }

  let dataUrl;
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch (e) {
    alert("读取图片失败: " + e.message);
    return;
  }

  const snapshotKey = "bb_snapshot_" + nodeId;
  const isBridge = node.comfyClass === "BlueBoxBridge";
  let snapshot = null;

  try {
    snapshot = await BB_DB.get(snapshotKey);
  } catch (e) {
    snapshot = null;
  }

  if (snapshot) {
    if (isBridge) {
      const meta = getBridgeCurrentImageMeta(node);
      if (!meta) {
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      } else if (meta.subfolder === "BlueBoxBridge") {
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      } else {
        const snapshotSource = snapshot.bridgeSourceImage || null;
        if (!snapshotSource) {
          snapshot = null;
          BB_DB.delete(snapshotKey).catch(() => {});
        } else if (snapshotSource !== meta.filename) {
          snapshot = null;
          BB_DB.delete(snapshotKey).catch(() => {});
        }
      }
    } else if (node.comfyClass === "BlueBoxAllPreview") {
      snapshot = null;
      BB_DB.delete(snapshotKey).catch(() => {});
    } else {
      const snapshotSource = snapshot.sourceImage || null;
      const currentImage = imgWidget?.value || null;
      if (!snapshotSource) {
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      } else if (currentImage && snapshotSource !== currentImage) {
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      }
    }
  }

  const imageId =
    "bb_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await BB_DB.put(imageId, dataUrl);

  window._bbEditTargetNode = node;
  window._bbEditNodeId = nodeId;

  if (node.__bbReferencePending) {
    try {
      await node.__bbReferencePending;
    } catch (e) {}
  }

  let refKey = null;
  let refData = null;

  if (isBridge) {
    refData = await fetchLatestReferenceDataUrl(node);
    if (refData) {
      refKey =
        "bb_reference_" +
        nodeId +
        "_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 6);
      await BB_DB.put(refKey, refData);
      node.__bbReferenceKey = refKey;
    }
  }

  if (!refData && node.__bbReferenceKey) {
    const cached = await BB_DB.get(node.__bbReferenceKey).catch(() => null);
    if (cached) {
      refData = cached;
      refKey = node.__bbReferenceKey;
    }
  }

  let referenceParam = "";
  if (refData && refKey) {
    referenceParam = `&referenceId=${encodeURIComponent(refKey)}`;
  } else {
    node.__bbReferenceKey = null;
  }

  const baseParam = snapshot
    ? `snapshotId=${encodeURIComponent(snapshotKey)}&imageId=${encodeURIComponent(imageId)}&nodeId=${encodeURIComponent(nodeId)}`
    : `imageId=${encodeURIComponent(imageId)}&nodeId=${encodeURIComponent(nodeId)}`;

  const param = baseParam + referenceParam;

  const win = window.open(
    `${EXT_BASE}/mask-editor.html?${param}`,
    "bluebox-mask-editor",
    "width=1536,height=1024,left=" +
      Math.round((screen.width - 1536) / 2) +
      ",top=" +
      Math.round((screen.height - 1024) / 2) +
      ",menubar=no,toolbar=no,location=no,status=no",
  );

  if (!win) {
    alert("弹窗被拦截，请允许本站弹出窗口");
    BB_DB.delete(imageId).catch(() => {});
    window._bbEditTargetNode = null;
    window._bbEditNodeId = null;
    return;
  }

  startMaskPolling();
}

function startMaskPolling() {
  if (_bbPollTimer) clearInterval(_bbPollTimer);
  _bbPollAttempts = 0;

  _bbPollTimer = setInterval(async () => {
    _bbPollAttempts++;
    if (_bbPollAttempts > BB_POLL_MAX) {
      clearInterval(_bbPollTimer);
      _bbPollTimer = null;
      return;
    }
    try {
      const raw = await BB_DB.get("mask_editor_result");
      if (!raw) return;
      clearInterval(_bbPollTimer);
      _bbPollTimer = null;
      BB_DB.delete("mask_editor_result").catch(() => {});
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return;
      }
      handleMaskResult(payload);
    } catch (e) {}
  }, 500);
}

let _bbLastSessionId = null;

async function handleMaskResult(payload) {
  if (!payload || !payload.image) return;
  if (payload.editorSessionId && payload.editorSessionId === _bbLastSessionId)
    return;
  if (payload.editorSessionId) _bbLastSessionId = payload.editorSessionId;

  const node = window._bbEditTargetNode;
  if (!node) return;

  if (node.comfyClass === "BlueBoxAllPreview") {
    const mainDataUrl = payload.image;
    if (!mainDataUrl) {
      alert("回填失败：没有可用的图像");
      window._bbEditTargetNode = null;
      window._bbEditNodeId = null;
      return;
    }

    const match = mainDataUrl.match(/^data:(.+?);base64,(.+)$/);
    if (match) {
      node.properties.imgData = {
        name: "bg_image",
        base64: match[2],
        type: match[1],
      };
      if (node.previewer?.refreshBackgroundImage) {
        node.previewer.refreshBackgroundImage(node);
      } else if (node.previewWidget?.element) {
        node.previewWidget.element.style.backgroundImage = `url(${mainDataUrl})`;
      }
      node.setDirtyCanvas?.(true, true);
    }

    window._bbEditTargetNode = null;
    window._bbEditNodeId = null;
    return;
  }

  const mainDataUrl = payload.image || payload.maskAlphaImage;
  if (!mainDataUrl) {
    alert("回填失败：没有可上传的图像");
    window._bbEditTargetNode = null;
    return;
  }

  let sharedHash = null;
  try {
    const resp = await fetch(mainDataUrl);
    const blob = await resp.blob();
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const bytes = new Uint8Array(digest);
    sharedHash = "";
    for (let i = 0; i < 8; i++)
      sharedHash += bytes[i].toString(16).padStart(2, "0");
  } catch (e) {
    sharedHash = Date.now().toString(16);
  }

  if (node.comfyClass === "BlueBoxBridge") {
    const mainUrl = payload.image;
    const maskUrl = payload.maskImage;
    const previewUrl = payload.previewImage;

    if (!mainUrl) {
      alert("桥接回填失败：缺少主图");
      window._bbEditTargetNode = null;
      return;
    }

    const mainName = await uploadDataUrlToComfy(
      mainUrl,
      `bb_bridge_${sharedHash}`,
    );
    if (!mainName) {
      alert("桥接回填失败：主图上传未成功");
      window._bbEditTargetNode = null;
      return;
    }

    let maskName = null;
    if (maskUrl) {
      maskName = await uploadDataUrlToComfy(
        maskUrl,
        `bb_bridge_${sharedHash}_mask`,
      );
    }

    let previewName = null;
    if (previewUrl) {
      previewName = await uploadDataUrlToComfy(
        previewUrl,
        `bb_bridge_${sharedHash}_preview`,
      );
    }

    const nodeId = node.__bbNodeId || String(node.id);

    try {
      await fetch("/bluebox/bridge_register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: nodeId,
          image_filename: mainName,
          mask_filename: maskName,
          preview_filename: previewName,
          source_hash: node.__bbSourceHash || null,
        }),
      });
    } catch (e) {
      console.warn("[BlueBox] Bridge 注册失败:", e);
    }

    const displayName = previewName || mainName;
    const imgObj = await loadPreviewImage(displayName, "", "input");
    if (imgObj && imgObj.naturalWidth > 0) {
      node.imgs = [imgObj];
      node.setDirtyCanvas?.(true, true);
    }

    node.__bbCurrentImageMeta = {
      filename: displayName,
      subfolder: "",
      type: "input",
    };

    const snapshotKey = "bb_snapshot_" + nodeId;
    BB_DB.get(snapshotKey)
      .then((snap) => {
        if (snap) {
          snap.bridgeSourceImage = displayName;
          BB_DB.put(snapshotKey, snap).catch(() => {});
        }
      })
      .catch(() => {});

    window._bbEditTargetNode = null;
    window._bbEditNodeId = null;
    return;
  }

  const serverName = await uploadDataUrlToComfy(
    mainDataUrl,
    `bb_${sharedHash}`,
  );
  if (!serverName) {
    alert("回填失败：图片上传未成功");
    window._bbEditTargetNode = null;
    window._bbEditNodeId = null;
    return;
  }

  let maskServerName = null;
  if (payload.maskImage) {
    maskServerName = await uploadDataUrlToComfy(
      payload.maskImage,
      `bb_${sharedHash}_mask`,
    );
  }

  let previewServerName = null;
  if (payload.previewImage) {
    previewServerName = await uploadDataUrlToComfy(
      payload.previewImage,
      `bb_${sharedHash}_preview`,
    );
  }

  const imgWidget2 = node.widgets?.find((w) => w.name === "image");
  const maskWidget = node.widgets?.find((w) => w.name === "mask_file");

  node.__bbSuppressMaskClear = true;

  if (imgWidget2) {
    imgWidget2.value = serverName;
  }

  if (maskWidget) {
    maskWidget.value = maskServerName || "";
  }

  setTimeout(() => {
    node.__bbSuppressMaskClear = false;
  }, 800);

  const displayName = previewServerName || serverName;
  const previewImg = await loadInputImage(displayName);
  if (previewImg && previewImg.naturalWidth > 0) {
    node.imgs = [previewImg];
    node.setDirtyCanvas?.(true, true);
    requestAnimationFrame(() => node.setDirtyCanvas?.(true, true));
    setTimeout(() => node.setDirtyCanvas?.(true, true), 100);
  }

  const refreshNativePreview = () => {
    if (!node.imgs || node.imgs.length === 0) return false;
    const hasNative = node.widgets?.some(
      (w) =>
        String(w.name || "").includes("canvas-image-preview") ||
        String(w.name || "") === "images",
    );
    node.setDirtyCanvas?.(true, true);
    return !!hasNative;
  };
  if (!refreshNativePreview()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (refreshNativePreview() || tries >= 20) clearInterval(timer);
    }, 100);
  }

  if (payload.width && payload.height) {
    node.__bbOutSize = [payload.width, payload.height];
    node.setDirtyCanvas?.(true, true);
    requestAnimationFrame(() => node.setDirtyCanvas?.(true, true));
    setTimeout(() => node.setDirtyCanvas?.(true, true), 100);
  }

  const snapshotKey2 = "bb_snapshot_" + String(node.id);
  BB_DB.get(snapshotKey2)
    .then((snap) => {
      if (snap) {
        snap.sourceImage = serverName;
        BB_DB.put(snapshotKey2, snap).catch(() => {});
      }
    })
    .catch(() => {});

  window._bbEditTargetNode = null;
  window._bbEditNodeId = null;
}

function drawBBOutputSize(ctx, node) {
  const s = node.__bbOutSize;
  if (!Array.isArray(s) || s.length !== 2) return;
  if (!node.imgs || node.imgs.length === 0) return;

  const img = node.imgs[0];
  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;
  if (!imgW || !imgH) return;

  const previewWidget = node.widgets?.find(
    (w) =>
      String(w.name || "").includes("canvas-image-preview") ||
      String(w.name || "") === "images",
  );

  let haveRect = false;
  let drawX = 0,
    drawY = 0,
    drawW = 0,
    drawH = 0;

  if (previewWidget) {
    const wy = previewWidget.last_y || 0;
    const wh = previewWidget.computeSize
      ? previewWidget.computeSize(node.size[0])[1]
      : node.size[1] - wy;
    if (wh > 0 && wy > 0) {
      const scale = Math.min(node.size[0] / imgW, wh / imgH);
      drawW = imgW * scale;
      drawH = imgH * scale;
      drawX = (node.size[0] - drawW) / 2;
      drawY = wy + (wh - drawH) / 2;
      haveRect = true;
    }
  }

  const text = `${s[0]}×${s[1]}`;
  const padX = 6;
  const h = 16;
  ctx.save();
  ctx.font = "11px monospace";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width + padX * 2;

  let lx, ly;
  if (haveRect) {
    lx = drawX + drawW - tw - 4;
    ly = drawY + drawH - h - 4;
  } else {
    lx = node.size[0] - tw - 8;
    ly = node.size[1] - h - 6;
  }

  ctx.fillStyle = "#16161a";
  const r = 3;
  ctx.beginPath();
  ctx.moveTo(lx + r, ly);
  ctx.lineTo(lx + tw - r, ly);
  ctx.quadraticCurveTo(lx + tw, ly, lx + tw, ly + r);
  ctx.lineTo(lx + tw, ly + h - r);
  ctx.quadraticCurveTo(lx + tw, ly + h, lx + tw - r, ly + h);
  ctx.lineTo(lx + r, ly + h);
  ctx.quadraticCurveTo(lx, ly + h, lx, ly + h - r);
  ctx.lineTo(lx, ly + r);
  ctx.quadraticCurveTo(lx, ly, lx + r, ly);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fillText(text, lx + padX, ly + h / 2);
  ctx.restore();
}

window.addEventListener("message", (e) => {
  if (!e.data || typeof e.data !== "object") return;
  if (e.data.type === "mask_saved") {
    handleMaskResult(e.data.payload);
  }
});

app.registerExtension({
  name: "bluebox.maskeditor.entry",

  async setup() {
    window.__bb_app = app;
  },

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    const t = (nodeData.name || "").toLowerCase();

    const isInputNode = t.includes("loadimage");
    const isOutputNode = t.includes("previewimage") || t.includes("saveimage");
    const isBlueBox = t.includes("bluebox");

    if (!isInputNode && !isOutputNode && !isBlueBox) return;

    const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      try {
        const r = origGetExtraMenuOptions?.apply(this, arguments);
        options.push({
          content: "🟦 在 BLUEBOX 编辑器中打开",
          callback: () => openBlueBoxEditor(this),
        });
        return r;
      } catch (e) {
        return origGetExtraMenuOptions?.apply(this, arguments);
      }
    };

    if (nodeData.name === "BlueBoxLoadImage") {
      const origOnNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = origOnNodeCreated?.apply(this, arguments);
        const node = this;
        const imgWidget = node.widgets?.find((w) => w.name === "image");
        const maskWidget = node.widgets?.find((w) => w.name === "mask_file");

        node.__bbSuppressMaskClear = false;
        node.__bbOutSize = null;

        if (imgWidget && maskWidget) {
          const origCallback = imgWidget.callback;
          imgWidget.callback = function (value, ...rest) {
            if (!node.__bbSuppressMaskClear) {
              if (maskWidget.value) {
                maskWidget.value = "";
              }
              const key = "bb_snapshot_" + String(node.id);
              BB_DB.delete(key).catch(() => {});
              node.__bbOutSize = null;
            }
            return origCallback?.apply(this, [value, ...rest]);
          };
        }

        node.setSize([320, 380]);
        node.resizable = true;

        chainCallback(node, "onExecuted", function (message) {
          try {
            const outSize = message?.out_size?.[0] ?? null;
            if (outSize) {
              this.__bbOutSize = outSize;
              this.setDirtyCanvas?.(true, true);
              requestAnimationFrame(() => this.setDirtyCanvas?.(true, true));
              setTimeout(() => this.setDirtyCanvas?.(true, true), 100);
            }
          } catch (e) {
            console.warn("[BlueBox] LoadImage onExecuted 解析失败:", e);
          }
        });

        chainCallback(node, "onDrawForeground", function (ctx) {
          try {
            drawBBOutputSize(ctx, this);
          } catch (e) {}
        });

        return r;
      };
    }

    if (nodeData.name === "BlueBoxBridge") {
      const origOnNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = origOnNodeCreated?.apply(this, arguments);
        const node = this;

        node.__bbNodeId = String(node.id);
        node.__bbReferencePending = null;
        node.__bbSourceHash = null;

        const acceptWidget = node.widgets?.find(
          (w) => w.name === "accept_input",
        );

        const applyAcceptTitle = () => {
          const baseTitle = "Bridge (BlueBox)";
          const suffix = acceptWidget?.value ? "     ||" : "     >>";
          if (node.title !== baseTitle + suffix) {
            node.title = baseTitle + suffix;
          }
          node.setDirtyCanvas?.(true, true);
        };

        if (acceptWidget) {
          const origCallback = acceptWidget.callback;
          acceptWidget.callback = function (value, ...rest) {
            applyAcceptTitle();
            return origCallback?.apply(this, [value, ...rest]);
          };
          setTimeout(applyAcceptTitle, 50);
        }

        return r;
      };

      const origOnConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        const r = origOnConfigure?.apply(this, arguments);
        try {
          const node = this;
          const acceptWidget = node.widgets?.find(
            (w) => w.name === "accept_input",
          );
          if (acceptWidget) {
            const baseTitle = "Bridge (BlueBox)";
            const suffix = acceptWidget.value ? " ‖" : " →";
            if (node.title !== baseTitle + suffix) {
              node.title = baseTitle + suffix;
            }
            node.setDirtyCanvas?.(true, true);
          }
        } catch (e) {}
        return r;
      };

      const origOnExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function (message) {
        const r = origOnExecuted?.apply(this, arguments);
        try {
          const imgs = message?.images;
          if (Array.isArray(imgs) && imgs.length > 0) {
            const first = imgs[0];
            if (first && first.filename) {
              this.__bbCurrentImageMeta = {
                filename: first.filename,
                subfolder: first.subfolder || "",
                type: first.type || "output",
              };
            }
          }

          if (message?.source_hash?.[0]) {
            this.__bbSourceHash = message.source_hash[0];
          }
        } catch (e) {
          console.warn("[BlueBox] onExecuted 解析失败:", e);
        }
        return r;
      };
    }

    const origOnRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      try {
        const key = "bb_snapshot_" + String(this.id);
        BB_DB.delete(key).catch(() => {});
        if (this.__bbReferenceKey) {
          BB_DB.delete(this.__bbReferenceKey).catch(() => {});
        }
        this.__bbOutSize = null;
      } catch (e) {}
      return origOnRemoved?.apply(this, arguments);
    };
  },
});

app.registerExtension({
  name: "bluebox.native_seed_fix",

  async setup() {
    try {
      const { api } = await import("/scripts/api.js");

      const _lastSubmittedValue = {};
      const _lastMode = {};

      const origQueuePrompt = api.queuePrompt.bind(api);
      api.queuePrompt = async function (...args) {
        try {
          const prompt = args[1];
          if (prompt?.output && app.graph?._nodes) {
            for (const node of app.graph._nodes) {
              const seedWidget = node.widgets?.find(
                (w) => w.name === "seed" || w.name === "noise_seed",
              );
              if (!seedWidget) continue;
              const nodeId = String(node.id);
              _lastSubmittedValue[nodeId] = Number(seedWidget.value) || 0;

              const modeWidget = node.widgets?.find(
                (w) => w.name === "control_after_generate",
              );
              if (modeWidget) {
                _lastMode[nodeId] = modeWidget.value;
              }
            }
          }
        } catch (e) {
          console.warn("[BlueBox] seed 记录异常:", e);
        }

        return origQueuePrompt(...args);
      };

      function hookModeWidget(node) {
        if (node.__bbModeHooked) return;
        node.__bbModeHooked = true;

        const seedWidget = node.widgets?.find(
          (w) => w.name === "seed" || w.name === "noise_seed",
        );
        const modeWidget = node.widgets?.find(
          (w) => w.name === "control_after_generate",
        );
        if (!seedWidget || !modeWidget) return;

        const nodeId = String(node.id);

        const origCallback = modeWidget.callback;
        modeWidget.callback = function (value, ...rest) {
          const prevMode = _lastMode[nodeId];
          const cur = Number(seedWidget.value) || 0;

          if (value === "fixed" && prevMode !== "fixed") {
            let restored = cur;
            if (prevMode === "increment") {
              restored = cur - 1;
            } else if (prevMode === "decrement") {
              restored = cur + 1;
            } else if (prevMode === "randomize") {
              restored = _lastSubmittedValue[nodeId] ?? cur;
            } else {
              restored = cur;
            }

            if (restored !== cur) {
              seedWidget.value = restored;
              node.setDirtyCanvas?.(true, true);
            }
          }

          _lastMode[nodeId] = value;
          return origCallback?.apply(this, [value, ...rest]);
        };
      }

      const scanNodes = () => {
        if (!app.graph?._nodes) return;
        for (const node of app.graph._nodes) {
          hookModeWidget(node);
        }
      };

      setTimeout(scanNodes, 1000);

      if (app.graph) {
        const origOnNodeAdded = app.graph.onNodeAdded;
        app.graph.onNodeAdded = function (node) {
          const r = origOnNodeAdded?.apply(this, arguments);
          try {
            hookModeWidget(node);
          } catch (e) {}
          return r;
        };
      }
    } catch (e) {
      console.warn("[BlueBox] seed fix 安装失败:", e);
    }
  },
});