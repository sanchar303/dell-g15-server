const RTDB_NODES_URL =
  "https://cloud-db-studio-default-rtdb.firebaseio.com/database/nodes.json";
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB distributed chunks

const appState = {
  nodes: {}, // nodeId -> node metadata
  onlineNodes: [], // sorted by freeDiskBytes desc
  authMode: "login",
  token: localStorage.getItem("dell_g15_token") || "",
  user: null,
  folders: [],
  files: [],
  currentFolderId: "root",
  activeCategory: "all",
  viewMode: "grid", // "grid" | "list"
  searchQuery: "",
  storageSummary: { myUsedBytes: 0, othersUsedBytes: 0 },
  activeEditorFile: null,
  activeBlobUrl: null
};

let toastTimer = null;

function notify(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.getAttribute("role") === "button") {
    e.preventDefault();
    e.target.click();
  }
});

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function getFileCategory(name, mime = "") {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
    return "image";
  }
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(ext)) {
    return "video";
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) {
    return "audio";
  }
  if (ext === "pdf" || mime === "application/pdf") {
    return "pdf";
  }
  if (
    mime.startsWith("text/") ||
    [
      "py", "js", "ts", "jsx", "tsx", "html", "css", "json", "md", "txt",
      "c", "cpp", "h", "java", "cs", "go", "rs", "php", "rb", "sh", "bat",
      "ps1", "sql", "xml", "yml", "yaml", "ini", "env", "log", "csv"
    ].includes(ext)
  ) {
    return "code";
  }
  return "other";
}

// ================= RTDB MULTI-LAPTOP NODE DISCOVERY =================
async function refreshClusterNodes(announce = false) {
  const pill = document.getElementById("nodesPill");
  const text = document.getElementById("nodesStatusText");

  try {
    const res = await fetch(`${RTDB_NODES_URL}?t=${Date.now()}`);
    const raw = (await res.json()) || {};
    const now = Date.now();
    const online = [];

    Object.entries(raw).forEach(([nid, info]) => {
      if (!info || typeof info !== "object") return;
      if (info.status === "online" && info.url && now - (info.updatedAt || 0) < 75000) {
        online.push({
          ...info,
          nodeId: nid,
          url: info.url.replace(/\/$/, "")
        });
      }
    });

    online.sort((a, b) => (b.freeDiskBytes || 0) - (a.freeDiskBytes || 0));
    appState.nodes = raw;
    appState.onlineNodes = online;

    if (online.length > 0) {
      pill.classList.remove("offline");
      pill.classList.add("online");
      text.textContent = `${online.length} Laptop${online.length > 1 ? "s" : ""} Online`;
      if (announce) notify(`${online.length} laptop node(s) connected`);
    } else {
      pill.classList.remove("online");
      pill.classList.add("offline");
      text.textContent = "All Laptops Offline";
      if (announce) notify("No laptop server nodes are currently online.");
    }
    updateStorageBarUI();
    return online;
  } catch (err) {
    console.error("Node discovery error:", err);
    return [];
  }
}

function getPrimaryNode() {
  return appState.onlineNodes[0] || null;
}

function updateStorageBarUI() {
  const totalFree = appState.onlineNodes.reduce((acc, n) => acc + (n.freeDiskBytes || 0), 0);
  const myUsed = appState.storageSummary.myUsedBytes || 0;
  const othersUsed = appState.storageSummary.othersUsedBytes || 0;
  const totalCapacity = totalFree + myUsed + othersUsed;

  const myPct = totalCapacity > 0 ? Math.min(100, (myUsed / totalCapacity) * 100) : 0;
  const othersPct = totalCapacity > 0 ? Math.min(100 - myPct, (othersUsed / totalCapacity) * 100) : 0;

  document.getElementById("barMyUsed").style.width = `${myPct}%`;
  document.getElementById("barOthersUsed").style.width = `${othersPct}%`;

  document.getElementById("statMyUsed").textContent = `Your Used: ${formatBytes(myUsed)}`;
  document.getElementById("statOthersUsed").textContent = `Other Users: ${formatBytes(othersUsed)}`;
  document.getElementById("statPoolFree").textContent = `Total Available: ${formatBytes(totalFree)}`;
  document.getElementById("poolHeadline").textContent =
    `${appState.onlineNodes.length} active laptop(s) • ${formatBytes(totalFree)} shared free space`;
}

// ================= AUTHENTICATION =================
function switchAuthTab(mode) {
  appState.authMode = mode;
  const isReg = mode === "register";
  document.getElementById("loginTab").classList.toggle("active", !isReg);
  document.getElementById("registerTab").classList.toggle("active", isReg);
  document.getElementById("displayNameField").classList.toggle("hidden", !isReg);
  document.getElementById("authTitle").textContent = isReg ? "Create Distributed Account" : "My Files Vault";
  document.getElementById("authActionLabel").textContent = isReg ? "Register on Laptop Pool" : "Unlock My Files";
}

async function submitAuth() {
  if (appState.onlineNodes.length === 0) {
    await refreshClusterNodes(false);
  }
  const node = getPrimaryNode();
  if (!node) {
    notify("No laptop servers are online. Start Dell G15 Server.exe first.");
    return;
  }

  const username = document.getElementById("usernameInput").value.trim();
  const password = document.getElementById("passwordInput").value;
  const displayName = document.getElementById("displayNameInput").value.trim();

  if (!username || !password) {
    notify("Enter username and password.");
    return;
  }

  const route = appState.authMode === "register" ? "/api/register" : "/api/login";
  try {
    const res = await fetch(`${node.url}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, displayName })
    });
    const data = await res.json();
    if (!data.ok) {
      notify(data.error || "Authentication failed.");
      return;
    }

    appState.token = data.token;
    appState.user = data.user;
    localStorage.setItem("dell_g15_token", data.token);
    document.getElementById("passwordInput").value = "";
    notify(`Welcome, ${data.user.displayName}`);
    openExplorer();
  } catch (err) {
    notify("Failed to reach laptop node.");
  }
}

function signOut() {
  appState.token = "";
  appState.user = null;
  appState.folders = [];
  appState.files = [];
  localStorage.removeItem("dell_g15_token");
  document.getElementById("explorerScreen").classList.add("hidden");
  document.getElementById("signOutBtn").classList.add("hidden");
  document.getElementById("authScreen").classList.remove("hidden");
  notify("Signed out");
}

async function openExplorer() {
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("explorerScreen").classList.remove("hidden");
  document.getElementById("signOutBtn").classList.remove("hidden");
  await syncFilesystem();
}

// ================= FILESYSTEM SYNC & RENDERING =================
async function syncFilesystem() {
  if (!appState.token) return;
  if (appState.onlineNodes.length === 0) {
    await refreshClusterNodes(false);
  }
  const node = getPrimaryNode();
  if (!node) {
    notify("All laptop nodes are offline.");
    return;
  }

  try {
    const res = await fetch(`${node.url}/api/fs`, {
      headers: { Authorization: `Bearer ${appState.token}` }
    });
    if (res.status === 401) {
      signOut();
      return;
    }
    const data = await res.json();
    if (data.ok) {
      appState.user = data.user;
      appState.folders = data.folders || [];
      appState.files = data.files || [];
      appState.storageSummary = data.storageSummary || { myUsedBytes: 0, othersUsedBytes: 0 };
      document.getElementById("greetingTitle").textContent = `${data.user.displayName}'s My Files`;
      updateStorageBarUI();
      updateCategoryCounts();
      renderBreadcrumbs();
      renderExplorerItems();
    }
  } catch (err) {
    notify("Could not sync filesystem from laptop node.");
  }
}

function updateCategoryCounts() {
  const counts = { all: appState.folders.length + appState.files.length, image: 0, video: 0, audio: 0, pdf: 0, code: 0 };
  appState.files.forEach((f) => {
    const cat = getFileCategory(f.name, f.mimeType);
    if (counts[cat] !== undefined) counts[cat]++;
  });
  document.getElementById("countAll").textContent = `${counts.all} items`;
  document.getElementById("countImage").textContent = `${counts.image} files`;
  document.getElementById("countVideo").textContent = `${counts.video} files`;
  document.getElementById("countAudio").textContent = `${counts.audio} files`;
  document.getElementById("countPdf").textContent = `${counts.pdf} files`;
  document.getElementById("countCode").textContent = `${counts.code} files`;
}

function renderBreadcrumbs() {
  const bar = document.getElementById("breadcrumbsBar");
  bar.innerHTML = "";

  if (appState.activeCategory !== "all") {
    const catPill = document.createElement("div");
    catPill.className = "crumb-pill";
    catPill.textContent = `Category: ${appState.activeCategory.toUpperCase()} (Back to Folders)`;
    catPill.onclick = () => {
      appState.activeCategory = "all";
      document.querySelectorAll(".cat-tile").forEach((t) => t.classList.toggle("active", t.dataset.cat === "all"));
      renderBreadcrumbs();
      renderExplorerItems();
    };
    bar.appendChild(catPill);
    return;
  }

  const trail = [];
  let cursor = appState.currentFolderId;
  while (cursor && cursor !== "root") {
    const fld = appState.folders.find((f) => f.id === cursor);
    if (!fld) break;
    trail.unshift(fld);
    cursor = fld.parentId;
  }

  const rootPill = document.createElement("div");
  rootPill.className = "crumb-pill";
  rootPill.textContent = "My Files";
  rootPill.onclick = () => {
    appState.currentFolderId = "root";
    renderBreadcrumbs();
    renderExplorerItems();
  };
  bar.appendChild(rootPill);

  trail.forEach((fld) => {
    const sep = document.createElement("span");
    sep.className = "muted";
    sep.textContent = "›";
    bar.appendChild(sep);

    const p = document.createElement("div");
    p.className = "crumb-pill";
    p.textContent = fld.name;
    p.onclick = () => {
      appState.currentFolderId = fld.id;
      renderBreadcrumbs();
      renderExplorerItems();
    };
    bar.appendChild(p);
  });
}

function checkFileAvailability(fileObj) {
  const onlineIds = new Set(appState.onlineNodes.map((n) => n.nodeId));
  const chunks = fileObj.chunks || [];
  const availableCount = chunks.filter((c) => onlineIds.has(c.nodeId)).length;
  return {
    total: chunks.length,
    available: availableCount,
    complete: chunks.length > 0 && availableCount === chunks.length
  };
}

function renderExplorerItems() {
  const container = document.getElementById("explorerItems");
  const emptyBox = document.getElementById("emptyFolderState");
  const q = appState.searchQuery.toLowerCase();

  container.className = appState.viewMode === "grid" ? "explorer-grid" : "explorer-list";
  container.innerHTML = "";

  let visibleFolders = [];
  let visibleFiles = [];

  if (appState.activeCategory === "all" && !q) {
    visibleFolders = appState.folders.filter((f) => f.parentId === appState.currentFolderId);
    visibleFiles = appState.files.filter((f) => f.parentId === appState.currentFolderId);
  } else {
    if (appState.activeCategory === "all") {
      visibleFolders = appState.folders.filter((f) => f.name.toLowerCase().includes(q));
    }
    visibleFiles = appState.files.filter((f) => {
      const catOk = appState.activeCategory === "all" || getFileCategory(f.name, f.mimeType) === appState.activeCategory;
      const searchOk = !q || f.name.toLowerCase().includes(q);
      return catOk && searchOk;
    });
  }

  if (visibleFolders.length === 0 && visibleFiles.length === 0) {
    emptyBox.classList.remove("hidden");
    return;
  }
  emptyBox.classList.add("hidden");

  // Render Folders
  visibleFolders.forEach((fld) => {
    const childCount =
      appState.folders.filter((x) => x.parentId === fld.id).length +
      appState.files.filter((x) => x.parentId === fld.id).length;

    const card = document.createElement("div");
    card.className = "entry-card";

    const preview = document.createElement("div");
    preview.className = "entry-preview-box";
    preview.innerHTML = `<div class="folder-glyph"></div>`;
    preview.onclick = () => {
      appState.currentFolderId = fld.id;
      appState.searchQuery = "";
      document.getElementById("searchBox").value = "";
      renderBreadcrumbs();
      renderExplorerItems();
    };

    const info = document.createElement("div");
    info.className = "entry-info";
    const nameEl = document.createElement("div");
    nameEl.className = "entry-name";
    nameEl.textContent = fld.name;
    nameEl.onclick = preview.onclick;

    const metaEl = document.createElement("div");
    metaEl.className = "entry-meta";
    metaEl.textContent = `Folder • ${childCount} item(s)`;

    info.appendChild(nameEl);
    info.appendChild(metaEl);

    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.appendChild(makeMiniPill("Rename", () => promptRename("folder", fld)));
    actions.appendChild(makeMiniPill("Details", () => showItemDetails("folder", fld)));
    actions.appendChild(makeMiniPill("Delete", () => deleteEntry("folder", fld), true));

    card.appendChild(preview);
    card.appendChild(info);
    card.appendChild(actions);
    container.appendChild(card);
  });

  // Render Files
  visibleFiles.forEach((file) => {
    const cat = getFileCategory(file.name, file.mimeType);
    const ext = (file.name.split(".").pop() || "FILE").toUpperCase().slice(0, 5);
    const avail = checkFileAvailability(file);

    const card = document.createElement("div");
    card.className = "entry-card";

    const preview = document.createElement("div");
    preview.className = "entry-preview-box";
    const badge = document.createElement("div");
    badge.className = "file-ext-pill";
    badge.textContent = ext;
    preview.appendChild(badge);
    preview.onclick = () => openFileViewer(file);

    // Load live thumbnail for images if complete
    if (cat === "image" && avail.complete && file.size < 12 * 1024 * 1024) {
      assembleFileBlob(file, true).then((blobUrl) => {
        if (blobUrl) {
          preview.innerHTML = "";
          const img = document.createElement("img");
          img.className = "entry-thumb-img";
          img.src = blobUrl;
          img.alt = file.name;
          preview.appendChild(img);
        }
      });
    }

    const info = document.createElement("div");
    info.className = "entry-info";
    const nameEl = document.createElement("div");
    nameEl.className = "entry-name";
    nameEl.textContent = file.name;
    nameEl.onclick = () => openFileViewer(file);

    const metaEl = document.createElement("div");
    metaEl.className = "entry-meta";
    const nodeSummary = avail.complete
      ? `${avail.total} chunk(s) online`
      : `${avail.available}/${avail.total} chunks online`;
    metaEl.textContent = `${formatBytes(file.size)} • ${nodeSummary}`;

    info.appendChild(nameEl);
    info.appendChild(metaEl);

    const actions = document.createElement("div");
    actions.className = "entry-actions";
    actions.appendChild(makeMiniPill("Open", () => openFileViewer(file)));
    actions.appendChild(makeMiniPill("Rename", () => promptRename("file", file)));
    actions.appendChild(makeMiniPill("Details", () => showItemDetails("file", file)));
    actions.appendChild(makeMiniPill("Delete", () => deleteEntry("file", file), true));

    card.appendChild(preview);
    card.appendChild(info);
    card.appendChild(actions);
    container.appendChild(card);
  });
}

function makeMiniPill(label, handler, isDanger = false) {
  const el = document.createElement("div");
  el.className = isDanger ? "mini-pill del" : "mini-pill";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.textContent = label;
  el.onclick = handler;
  return el;
}

// ================= DISTRIBUTED CHUNK UPLOAD ENGINE =================
async function uploadDistributedFiles(fileList, replaceFileObj = null) {
  if (!fileList || fileList.length === 0) return;
  await refreshClusterNodes(false);
  const nodes = appState.onlineNodes;
  if (nodes.length === 0) {
    notify("No laptop nodes online to receive chunks.");
    return;
  }

  const banner = document.getElementById("uploadBanner");
  const statusLabel = document.getElementById("uploadStatusLabel");
  const pctLabel = document.getElementById("uploadPctLabel");
  const fillBar = document.getElementById("uploadFillBar");

  banner.classList.remove("hidden");
  let totalBytesAll = 0;
  for (const f of fileList) totalBytesAll += Math.max(1, f.size);
  let uploadedBytesAll = 0;

  let nodeCursor = Math.floor(Math.random() * nodes.length);

  for (const file of fileList) {
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const committedChunks = [];

    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const slice = file.slice(start, end);
      const chunkId = `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

      // Pick next online laptop node in weighted round-robin
      const targetNode = nodes[nodeCursor % nodes.length];
      nodeCursor++;

      statusLabel.textContent = `Uploading "${file.name}" (Chunk ${idx + 1}/${totalChunks} → ${targetNode.name})`;

      const form = new FormData();
      form.append("chunkId", chunkId);
      form.append("chunk", slice, `${chunkId}.bin`);

      const putRes = await fetch(`${targetNode.url}/api/chunks/put`, {
        method: "POST",
        headers: { Authorization: `Bearer ${appState.token}` },
        body: form
      });
      const putData = await putRes.json();
      if (!putData.ok) {
        banner.classList.add("hidden");
        notify(`Chunk upload failed on ${targetNode.name}`);
        return;
      }

      committedChunks.push({
        index: idx,
        chunkId,
        nodeId: targetNode.nodeId,
        size: putData.size
      });

      uploadedBytesAll += Math.max(1, end - start);
      const pct = Math.min(100, Math.round((uploadedBytesAll / totalBytesAll) * 100));
      pctLabel.textContent = `${pct}%`;
      fillBar.style.width = `${pct}%`;
    }

    // Commit manifest to cluster metadata
    const coordinator = getPrimaryNode();
    await fetch(`${coordinator.url}/api/fs/file`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appState.token}`
      },
      body: JSON.stringify({
        name: replaceFileObj ? replaceFileObj.name : file.name,
        parentId: replaceFileObj ? replaceFileObj.parentId : appState.currentFolderId,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        chunks: committedChunks,
        replaceFileId: replaceFileObj ? replaceFileObj.id : null
      })
    });
  }

  banner.classList.add("hidden");
  document.getElementById("hiddenFileInput").value = "";
  notify("Distributed across laptop cluster");
  await refreshClusterNodes(false);
  await syncFilesystem();
}

// ================= MULTI-CHUNK ASSEMBLY & VIEWER =================
async function assembleFileBlob(fileObj, silent = false) {
  const chunks = [...(fileObj.chunks || [])].sort((a, b) => a.index - b.index);
  if (chunks.length === 0) return null;

  const onlineMap = {};
  appState.onlineNodes.forEach((n) => (onlineMap[n.nodeId] = n));

  const buffers = [];
  for (const ch of chunks) {
    const node = onlineMap[ch.nodeId];
    if (!node) {
      if (!silent) notify(`Laptop holding chunk #${ch.index + 1} is currently offline.`);
      return null;
    }
    try {
      const res = await fetch(`${node.url}/api/chunks/get/${ch.chunkId}`, {
        headers: { Authorization: `Bearer ${appState.token}` }
      });
      if (!res.ok) throw new Error("Missing chunk");
      buffers.push(await res.arrayBuffer());
    } catch (err) {
      if (!silent) notify(`Failed retrieving chunk from ${node.name}`);
      return null;
    }
  }

  const blob = new Blob(buffers, { type: fileObj.mimeType || "application/octet-stream" });
  return URL.createObjectURL(blob);
}

function closeModal() {
  document.getElementById("viewerModal").classList.add("hidden");
  document.getElementById("modalBody").innerHTML = "";
  document.getElementById("modalSaveCodeBtn").classList.add("hidden");
  document.getElementById("modalDownloadBtn").classList.add("hidden");
  appState.activeEditorFile = null;
  if (appState.activeBlobUrl) {
    URL.revokeObjectURL(appState.activeBlobUrl);
    appState.activeBlobUrl = null;
  }
}

async function openFileViewer(fileObj) {
  const modal = document.getElementById("viewerModal");
  const title = document.getElementById("modalTitle");
  const sub = document.getElementById("modalSubtitle");
  const body = document.getElementById("modalBody");
  const dlBtn = document.getElementById("modalDownloadBtn");
  const saveCodeBtn = document.getElementById("modalSaveCodeBtn");

  closeModal();
  title.textContent = fileObj.name;
  sub.textContent = `${formatBytes(fileObj.size)} • ${fileObj.chunks.length} distributed chunk(s)`;
  body.innerHTML = `<p class="muted">Assembling file chunks from connected laptops...</p>`;
  modal.classList.remove("hidden");

  const blobUrl = await assembleFileBlob(fileObj, false);
  if (!blobUrl) {
    body.innerHTML = `<p class="muted">One or more laptops storing this file's chunks are currently offline.</p>`;
    return;
  }

  appState.activeBlobUrl = blobUrl;
  dlBtn.classList.remove("hidden");
  dlBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileObj.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const cat = getFileCategory(fileObj.name, fileObj.mimeType);
  body.innerHTML = "";

  if (cat === "image") {
    const img = document.createElement("img");
    img.className = "viewer-media-img";
    img.src = blobUrl;
    img.alt = fileObj.name;
    body.appendChild(img);
  } else if (cat === "video") {
    const vid = document.createElement("video");
    vid.className = "viewer-video";
    vid.src = blobUrl;
    vid.controls = true;
    vid.autoplay = true;
    body.appendChild(vid);
  } else if (cat === "audio") {
    const box = document.createElement("div");
    box.className = "viewer-audio-box";
    box.innerHTML = `<strong>${fileObj.name}</strong>`;
    const aud = document.createElement("audio");
    aud.src = blobUrl;
    aud.controls = true;
    aud.autoplay = true;
    box.appendChild(aud);
    body.appendChild(box);
  } else if (cat === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "viewer-pdf";
    frame.src = blobUrl;
    body.appendChild(frame);
  } else if (cat === "code") {
    const textContent = await (await fetch(blobUrl)).text();
    const editor = document.createElement("textarea");
    editor.id = "codeEditorBox";
    editor.className = "code-editor-area";
    editor.value = textContent;
    body.appendChild(editor);

    appState.activeEditorFile = fileObj;
    saveCodeBtn.classList.remove("hidden");
    saveCodeBtn.onclick = async () => {
      const updatedBlob = new Blob([editor.value], { type: fileObj.mimeType || "text/plain" });
      const updatedFile = new File([updatedBlob], fileObj.name, { type: fileObj.mimeType || "text/plain" });
      // Remove old chunks cleanly
      await cleanupRemoteChunks(fileObj.chunks || []);
      await uploadDistributedFiles([updatedFile], fileObj);
      closeModal();
      notify("Saved edited file across laptop cluster");
    };
  } else {
    body.innerHTML = `
      <div class="viewer-audio-box">
        <p><strong>${fileObj.name}</strong> (${formatBytes(fileObj.size)})</p>
        <p class="muted">Binary archive/executable assembled from ${fileObj.chunks.length} laptop chunk(s). Click Download above to save.</p>
      </div>
    `;
  }
}

// ================= FOLDER, RENAME, DELETE & DETAILS =================
async function createNewFolder() {
  const name = prompt("Enter new folder name:");
  if (!name || !name.trim()) return;
  const node = getPrimaryNode();
  if (!node) return notify("No laptop server online.");

  const res = await fetch(`${node.url}/api/fs/folder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appState.token}`
    },
    body: JSON.stringify({ name: name.trim(), parentId: appState.currentFolderId })
  });
  const data = await res.json();
  if (data.ok) {
    notify("Folder created");
    syncFilesystem();
  } else {
    notify(data.error || "Could not create folder.");
  }
}

async function promptRename(kind, item) {
  const nextName = prompt(`Rename ${kind}:`, item.name);
  if (!nextName || !nextName.trim() || nextName.trim() === item.name) return;
  const node = getPrimaryNode();
  if (!node) return notify("No laptop server online.");

  const res = await fetch(`${node.url}/api/fs/rename`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appState.token}`
    },
    body: JSON.stringify({ id: item.id, kind, name: nextName.trim() })
  });
  const data = await res.json();
  if (data.ok) {
    notify("Renamed successfully");
    syncFilesystem();
  } else {
    notify(data.error || "Rename failed.");
  }
}

async function cleanupRemoteChunks(chunks) {
  const onlineMap = {};
  appState.onlineNodes.forEach((n) => (onlineMap[n.nodeId] = n));
  for (const ch of chunks) {
    const target = onlineMap[ch.nodeId];
    if (target) {
      fetch(`${target.url}/api/chunks/delete/${ch.chunkId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${appState.token}` }
      }).catch(() => {});
    }
  }
}

async function deleteEntry(kind, item) {
  if (!confirm(`Delete "${item.name}" permanently from laptop storage?`)) return;
  const node = getPrimaryNode();
  if (!node) return notify("No laptop server online.");

  const res = await fetch(`${node.url}/api/fs/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appState.token}`
    },
    body: JSON.stringify({ id: item.id, kind })
  });
  const data = await res.json();
  if (data.ok) {
    await cleanupRemoteChunks(data.orphanChunks || []);
    notify("Deleted from laptop cluster");
    await refreshClusterNodes(false);
    await syncFilesystem();
  }
}

function showItemDetails(kind, item) {
  closeModal();
  const modal = document.getElementById("viewerModal");
  document.getElementById("modalTitle").textContent = `${item.name} — Details`;
  document.getElementById("modalSubtitle").textContent = kind === "folder" ? "Directory Properties" : "Distributed File Properties";

  const body = document.getElementById("modalBody");
  if (kind === "folder") {
    body.innerHTML = `
      <table class="props-table">
        <tr><td>Folder Name</td><td>${item.name}</td></tr>
        <tr><td>Folder ID</td><td>${item.id}</td></tr>
        <tr><td>Created</td><td>${new Date(item.createdAt).toLocaleString()}</td></tr>
        <tr><td>Modified</td><td>${new Date(item.updatedAt).toLocaleString()}</td></tr>
      </table>
    `;
  } else {
    const chunkRows = (item.chunks || [])
      .map((c) => {
        const n = appState.nodes[c.nodeId];
        const label = n ? `${n.name} (${n.status})` : c.nodeId;
        return `Chunk #${c.index + 1}: ${formatBytes(c.size)} → <strong>${label}</strong>`;
      })
      .join("<br/>");

    body.innerHTML = `
      <table class="props-table">
        <tr><td>File Name</td><td>${item.name}</td></tr>
        <tr><td>Total Size</td><td>${formatBytes(item.size)} (${item.size.toLocaleString()} bytes)</td></tr>
        <tr><td>MIME Type</td><td>${item.mimeType}</td></tr>
        <tr><td>Created</td><td>${new Date(item.createdAt).toLocaleString()}</td></tr>
        <tr><td>Modified</td><td>${new Date(item.updatedAt).toLocaleString()}</td></tr>
        <tr><td>Distributed Chunk Map</td><td>${chunkRows}</td></tr>
      </table>
    `;
  }
  modal.classList.remove("hidden");
}

function showNodesInspector() {
  closeModal();
  const modal = document.getElementById("viewerModal");
  document.getElementById("modalTitle").textContent = "Connected Laptop Nodes";
  document.getElementById("modalSubtitle").textContent = "Shared Distributed Storage Pool";
  const body = document.getElementById("modalBody");

  const entries = Object.values(appState.nodes || {});
  if (entries.length === 0) {
    body.innerHTML = `<p class="muted">No laptop nodes registered in RTDB yet.</p>`;
  } else {
    const rows = entries
      .map(
        (n) => `
        <tr>
          <td><strong>${n.name || n.nodeId}</strong><br/><span class="muted">${n.nodeId}</span></td>
          <td>${n.status === "online" ? "Online" : "Offline"}</td>
          <td>${formatBytes(n.freeDiskBytes || 0)} free</td>
          <td>${formatBytes(n.localPoolBytes || 0)} used by pool</td>
        </tr>`
      )
      .join("");
    body.innerHTML = `
      <table class="props-table">
        <tr><td><strong>Laptop</strong></td><td><strong>Status</strong></td><td><strong>Available Space</strong></td><td><strong>Pool Usage</strong></td></tr>
        ${rows}
      </table>
    `;
  }
  modal.classList.remove("hidden");
}

// ================= INITIALIZATION =================
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("nodesPill").onclick = showNodesInspector;
  document.getElementById("loginTab").onclick = () => switchAuthTab("login");
  document.getElementById("registerTab").onclick = () => switchAuthTab("register");
  document.getElementById("authActionBtn").onclick = submitAuth;
  document.getElementById("signOutBtn").onclick = signOut;
  document.getElementById("newFolderBtn").onclick = createNewFolder;
  document.getElementById("modalCloseBtn").onclick = closeModal;
  document.getElementById("syncBtn").onclick = async () => {
    await refreshClusterNodes(true);
    await syncFilesystem();
  };

  ["usernameInput", "passwordInput", "displayNameInput"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitAuth();
    });
  });

  const fileInput = document.getElementById("hiddenFileInput");
  document.getElementById("uploadTriggerBtn").onclick = () => fileInput.click();
  fileInput.onchange = () => uploadDistributedFiles(fileInput.files);

  const dropArea = document.getElementById("dropArea");
  dropArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropArea.classList.add("drag-active");
  });
  dropArea.addEventListener("dragleave", () => dropArea.classList.remove("drag-active"));
  dropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    dropArea.classList.remove("drag-active");
    uploadDistributedFiles(e.dataTransfer.files);
  });

  document.querySelectorAll(".cat-tile").forEach((tile) => {
    tile.onclick = () => {
      appState.activeCategory = tile.dataset.cat;
      document.querySelectorAll(".cat-tile").forEach((t) => t.classList.remove("active"));
      tile.classList.add("active");
      renderBreadcrumbs();
      renderExplorerItems();
    };
  });

  document.getElementById("viewGridBtn").onclick = () => {
    appState.viewMode = "grid";
    document.getElementById("viewGridBtn").classList.add("active");
    document.getElementById("viewListBtn").classList.remove("active");
    renderExplorerItems();
  };

  document.getElementById("viewListBtn").onclick = () => {
    appState.viewMode = "list";
    document.getElementById("viewListBtn").classList.add("active");
    document.getElementById("viewGridBtn").classList.remove("active");
    renderExplorerItems();
  };

  document.getElementById("searchBox").oninput = (e) => {
    appState.searchQuery = e.target.value;
    renderExplorerItems();
  };

  const online = await refreshClusterNodes(false);
  if (appState.token && online.length > 0) {
    openExplorer();
  }
  setInterval(() => refreshClusterNodes(false), 20000);
});