console.log("[BlueBox] ============ bluebox.js 已加载 ============");
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXT_BASE = "/extensions/ComfyUI-BlueBox";

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

async function triggerRerun() {
  try {
    if (!app || !app.graphToPrompt) {
      console.warn("[BlueBox] app.graphToPrompt 不可用");
      return;
    }
    const p = await app.graphToPrompt();
    const clientId = api && api.clientId ? api.clientId : "bluebox";
    const res = await fetch("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: p.output,
        client_id: clientId,
      }),
    });
    if (!res.ok) {
      console.warn("[BlueBox] /prompt 返回错误:", res.status, await res.text());
    } else {
      console.log("[BlueBox] /prompt 入队成功");
    }
  } catch (e) {
    console.warn("[BlueBox] /prompt 调用失败:", e);
  }
}

window._bbEditTargetNode = null;
window._bbEditNodeId = null;
let _bbPollTimer = null;
let _bbPollAttempts = 0;
const BB_POLL_MAX = 1200;

// ------------------------------------------------------------------
// 取 Bridge 节点"当前显示图"的元信息。
//
// Bridge 没有 image widget，node.imgs 也只是 Image 对象，
// 所以最可靠的来源是 onExecuted 里缓存的原始 ui.images[0]。
// 拿不到时退化为 null，此时认为快照无效。
// ------------------------------------------------------------------
function getBridgeCurrentImageMeta(node) {
  if (!node) return null;
  const meta = node.__bbCurrentImageMeta;
  if (!meta || !meta.filename) return null;
  return meta;
}

async function openBlueBoxEditor(node) {
  node.__bbNodeId = String(node.id);
  const nodeId = node.__bbNodeId;
  console.log("[BlueBox] 打开编辑器，锁定 nodeId =", nodeId);

  let url = null;

  // ✅ 新增：BlueBoxAllPreview 直接用 properties.imgData（webp base64）
  if (node.comfyClass === "BlueBoxAllPreview") {
    const imgData = node.properties?.imgData;
    if (imgData?.base64) {
      const mime = imgData.type || "image/webp";
      url = `data:${mime};base64,${imgData.base64}`;
    }
  }

  // 原有逻辑（用 else if + !url 串起来，避免覆盖）
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
  } else if (!url && node.imgs && node.imgs.length > 0) {
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

  // 快照有效性判断
    if (snapshot) {
    if (isBridge) {
      // ---- Bridge 分支 ----
      const meta = getBridgeCurrentImageMeta(node);
      console.log("[BlueBox] Bridge 当前图元信息:", meta);

      if (!meta) {
        console.log("[BlueBox] Bridge 无当前图元信息，快照作废");
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      } else if (meta.subfolder === "BlueBoxBridge") {
        console.log("[BlueBox] Bridge 当前为占位图，快照作废");
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      } else {
        const snapshotSource = snapshot.bridgeSourceImage || null;
        if (!snapshotSource) {
          console.log("[BlueBox] Bridge 快照无来源记录，作废");
          snapshot = null;
          BB_DB.delete(snapshotKey).catch(() => {});
        } else if (snapshotSource !== meta.filename) {
          console.log(
            "[BlueBox] Bridge 烘焙图已更换，快照作废:",
            snapshotSource,
            "→",
            meta.filename,
          );
          snapshot = null;
          BB_DB.delete(snapshotKey).catch(() => {});
        } else {
          console.log("[BlueBox] Bridge 快照有效，保留");
        }
      }
    } else if (node.comfyClass === "BlueBoxAllPreview") {
      // ✅ 修复：预览节点快照一律作废，每次都用当前图
      console.log("[BlueBox] BlueBoxAllPreview 快照作废（每次都用当前图）");
      snapshot = null;
      BB_DB.delete(snapshotKey).catch(() => {});
    } else {
      // ---- LoadImage 分支 ----
      const snapshotSource = snapshot.sourceImage || null;
      const currentImage = imgWidget?.value || null;

      if (!snapshotSource) {
        console.log("[BlueBox] LoadImage 快照无来源记录，作废");
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      } else if (currentImage && snapshotSource !== currentImage) {
        console.log(
          "[BlueBox] LoadImage 图已换，快照作废:",
          snapshotSource,
          "→",
          currentImage,
        );
        snapshot = null;
        BB_DB.delete(snapshotKey).catch(() => {});
      } else {
        console.log("[BlueBox] LoadImage 快照有效，保留");
      }
    }
  }

  const imageId =
    "bb_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await BB_DB.put(imageId, dataUrl);

  window._bbEditTargetNode = node;
  window._bbEditNodeId = nodeId;

  const param = snapshot
    ? `snapshotId=${encodeURIComponent(snapshotKey)}&imageId=${encodeURIComponent(imageId)}&nodeId=${encodeURIComponent(nodeId)}`
    : `imageId=${encodeURIComponent(imageId)}&nodeId=${encodeURIComponent(nodeId)}`;

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

  // ✅ 新增：BlueBoxAllPreview 回填分支
  // 编辑器已把调色/涂鸦/缩放合成到 payload.image，
  // 直接写回 properties.imgData 并刷新节点背景。
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
      console.log("[BlueBox] BlueBoxAllPreview 预览已回填");
    } else {
      console.warn("[BlueBox] 回填 dataURL 解析失败");
    }

    window._bbEditTargetNode = null;
    window._bbEditNodeId = null;
    return;
  }

  // ---- 原有：Bridge / LoadImage 分支 ----
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
    console.log("[BlueBox] Bridge 注册 nodeId =", nodeId, "node.id =", node.id);
    console.log(
      "[BlueBox] Bridge 注册 node_id =",
      nodeId,
      "main =",
      mainName,
      "mask =",
      maskName,
      "preview =",
      previewName,
    );

    try {
      await fetch("/bluebox/bridge_register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: nodeId,
          image_filename: mainName,
          mask_filename: maskName,
          preview_filename: previewName,
        }),
      });
    } catch (e) {
      console.warn("[BlueBox] Bridge 注册失败:", e);
    }

    const displayName = previewName || mainName;
    const displayUrl =
      "/view?filename=" +
      encodeURIComponent(displayName) +
      "&subfolder=&type=input";

    const imgObj = new Image();
    imgObj.src = displayUrl;
    try {
      await imgObj.decode();
    } catch (e) {
      console.warn("[BlueBox] Bridge decode 失败，回退 onload:", e);
      await new Promise((res) => {
        if (imgObj.complete) return res();
        imgObj.onload = () => res();
        imgObj.onerror = () => res();
      });
    }
    node.imgs = [imgObj];
    node.setDirtyCanvas?.(true, true);

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

    console.log(
      "[BlueBox] Bridge 编辑结果已就绪，请点击节点上的「继续」按钮放行",
    );

    window._bbEditTargetNode = null;
    window._bbEditNodeId = null;
    return;
  }

  // ---- LoadImage 分支 ----
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

  let previewUrl2 = null;
  if (payload.previewImage) {
    const previewServerName = await uploadDataUrlToComfy(
      payload.previewImage,
      `bb_${sharedHash}_preview`,
    );
    if (previewServerName) {
      previewUrl2 =
        "/view?filename=" +
        encodeURIComponent(previewServerName) +
        "&subfolder=&type=input";
    }
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

  const displayUrl =
    previewUrl2 ||
    "/view?filename=" +
      encodeURIComponent(serverName) +
      "&subfolder=&type=input";
  if (displayUrl) {
    const imgObj = new Image();
    imgObj.src = displayUrl;
    try {
      await imgObj.decode();
    } catch (e) {
      console.warn("[BlueBox] decode 失败，回退 onload:", e);
      await new Promise((res) => {
        if (imgObj.complete) return res();
        imgObj.onload = () => res();
        imgObj.onerror = () => res();
      });
    }
    node.imgs = [imgObj];
    node.setDirtyCanvas?.(true, true);
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
        console.warn("[BlueBox] getExtraMenuOptions 异常:", e);
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

        if (imgWidget && maskWidget) {
          const origCallback = imgWidget.callback;
          imgWidget.callback = function (value, ...rest) {
            if (!node.__bbSuppressMaskClear) {
              if (maskWidget.value) {
                maskWidget.value = "";
              }
              const key = "bb_snapshot_" + String(node.id);
              BB_DB.delete(key).catch(() => {});
            }
            return origCallback?.apply(this, [value, ...rest]);
          };
        }
        return r;
      };
    }

    if (nodeData.name === "BlueBoxBridge") {
      const origOnNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const r = origOnNodeCreated?.apply(this, arguments);
        const node = this;

        node.__bbNodeId = String(node.id);

        node.addWidget("button", "继续", null, async () => {
          const nodeId = node.__bbNodeId || String(node.id);
          try {
            await fetch("/bluebox/bridge_continue", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ node_id: nodeId }),
            });
            console.log("[BlueBox] 已发送继续信号:", nodeId);
            await triggerRerun();
          } catch (e) {
            console.warn("[BlueBox] 继续信号发送失败:", e);
          }
        });

        return r;
      };

      // 缓存每次执行的 ui.images 原始元信息，供 openBlueBoxEditor 判断快照有效性。
      const origOnExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function (message) {
        const r = origOnExecuted?.apply(this, arguments);
        try {
          console.log(
            "[BlueBox] Bridge onExecuted:",
            JSON.stringify(message),
          );
          const imgs = message?.images;
          if (Array.isArray(imgs) && imgs.length > 0) {
            const first = imgs[0];
            if (first && first.filename) {
              this.__bbCurrentImageMeta = {
                filename: first.filename,
                subfolder: first.subfolder || "",
                type: first.type || "output",
              };
              console.log(
                "[BlueBox] Bridge 缓存当前图元信息:",
                this.__bbCurrentImageMeta,
              );
            }
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
              console.log(
                "[BlueBox] 切 fixed 回填:",
                nodeId,
                prevMode,
                "-> fixed, seed",
                cur,
                "->",
                restored,
              );
            } else {
              console.log("[BlueBox] 切 fixed，seed 无需回填:", nodeId, cur);
            }
          }

          _lastMode[nodeId] = value;
          return origCallback?.apply(this, [value, ...rest]);
        };

        console.log("[BlueBox] mode widget hooked:", nodeId);
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

      console.log("[BlueBox] 原生 seed fixed 修正已安装");
    } catch (e) {
      console.warn("[BlueBox] seed fix 安装失败:", e);
    }
  },
});