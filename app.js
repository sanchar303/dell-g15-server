const RTDB_SERVER_ENDPOINT =
  "https://cloud-db-studio-default-rtdb.firebaseio.com/database/server.json";

let state = {
  serverUrl: "",
  serverOnline: false,
  authMode: "login", // "login" | "register"
  token: localStorage.getItem("sk_vault_token") || "",
  user: null,
  items: [],
  filter: "all",
  search: ""
};

let toastTimer = null;

// Non-stacking notification pill
function notify(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3200);
}

// Keyboard accessibility for capsule [role="button"] controls
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.getAttribute("role") === "button") {
    e.preventDefault();
    e.target.click();
  }
});

// Format file size cleanly
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

// Discover Laptop Server via Firebase RTDB /database/server
async function syncServerDiscovery(silent = true) {
  const pill = document.getElementById("serverPill");
  const statusText = document.getElementById("statusText");

  try {
    const res = await fetch(`${RTDB_SERVER_ENDPOINT}?t=${Date.now()}`);
    const data = await res.json();

    const isFresh = data && data.updatedAt && Date.now() - data.updatedAt < 65000;
    if (data && data.status === "online" && data.url && isFresh) {
      state.serverUrl = data.url.replace(/\/$/, "");
      state.serverOnline = true;
      pill.classList.remove("offline");
      pill.classList.add("online");
      statusText.textContent = "Laptop Server Online";
      if (!silent) notify("Connected to Laptop Server");
      return true;
    }
  } catch (err) {
    console.error("RTDB discovery error:", err);
  }

  state.serverOnline = false;
  state.serverUrl = "";
  pill.classList.remove("online");
  pill.classList.add("offline");
  statusText.textContent = "Laptop Server Offline";
  if (!silent) notify("Laptop server is currently offline.");
  return false;
}

// Auth Tab Switching
function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === "register";
  document.getElementById("tabLogin").classList.toggle("active", !isRegister);
  document.getElementById("tabRegister").classList.toggle("active", isRegister);
  document.getElementById("displayNameWrap").classList.toggle("hidden", !isRegister);
  document.getElementById("authHeading").textContent = isRegister
    ? "Create Laptop Vault Account"
    : "Access Your Laptop Vault";
  document.getElementById("authSubmitLabel").textContent = isRegister
    ? "Create Account on Laptop"
    : "Sign In to Vault";
}

// Submit Login / Registration directly to Laptop Server
async function handleAuthSubmit() {
  if (!state.serverOnline || !state.serverUrl) {
    await syncServerDiscovery(true);
    if (!state.serverOnline) {
      notify("Laptop server is offline. Start server.py on your laptop first.");
      return;
    }
  }

  const username = document.getElementById("usernameInput").value.trim();
  const password = document.getElementById("passwordInput").value;
  const displayName = document.getElementById("displayNameInput").value.trim();

  if (!username || !password) {
    notify("Please enter both username and password.");
    return;
  }

  const endpoint = state.authMode === "register" ? "/api/register" : "/api/login";
  try {
    const res = await fetch(`${state.serverUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, displayName })
    });
    const data = await res.json();

    if (!data.ok) {
      notify(data.error || "Authentication failed.");
      return;
    }

    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("sk_vault_token", state.token);
    document.getElementById("passwordInput").value = "";
    notify(`Welcome, ${data.user.displayName}`);
    enterVaultView();
  } catch (err) {
    notify("Could not reach laptop server. Verify tunnel is running.");
  }
}

function signOut() {
  state.token = "";
  state.user = null;
  state.items = [];
  localStorage.removeItem("sk_vault_token");
  document.getElementById("vaultView").classList.add("hidden");
  document.getElementById("logoutBtn").classList.add("hidden");
  document.getElementById("authView").classList.remove("hidden");
  notify("Signed out");
}

async function enterVaultView() {
  document.getElementById("authView").classList.add("hidden");
  document.getElementById("vaultView").classList.remove("hidden");
  document.getElementById("logoutBtn").classList.remove("hidden");
  await loadVaultItems();
}

// Fetch user's stored files and notes from Laptop Server
async function loadVaultItems() {
  if (!state.token) return;
  if (!state.serverOnline) {
    await syncServerDiscovery(true);
    if (!state.serverOnline) {
      notify("Laptop server is offline.");
      return;
    }
  }

  try {
    const res = await fetch(`${state.serverUrl}/api/items`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });

    if (res.status === 401) {
      signOut();
      return;
    }

    const data = await res.json();
    if (data.ok) {
      state.user = data.user;
      state.items = data.items || [];
      document.getElementById("welcomeUser").textContent = `${data.user.displayName}'s Laptop Vault`;
      document.getElementById("storageStats").textContent =
        `${state.items.length} item(s) • ${formatBytes(data.totalBytes)} stored on laptop`;
      renderItems();
    }
  } catch (err) {
    notify("Failed to sync with laptop server.");
  }
}

// Render stored files & notes
function renderItems() {
  const grid = document.getElementById("itemsGrid");
  const empty = document.getElementById("emptyState");
  const query = state.search.toLowerCase();

  const filtered = state.items.filter((item) => {
    const matchesFilter =
      state.filter === "all" ||
      (state.filter === "files" && item.kind === "file") ||
      (state.filter === "notes" && item.kind === "note");

    const matchesSearch =
      !query ||
      (item.title && item.title.toLowerCase().includes(query)) ||
      (item.content && item.content.toLowerCase().includes(query));

    return matchesFilter && matchesSearch;
  });

  grid.innerHTML = "";
  if (filtered.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  filtered.forEach((item) => {
    const card = document.createElement("div");
    card.className = "vault-item";

    const meta = document.createElement("div");
    meta.className = "item-meta";

    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.title;

    const sub = document.createElement("div");
    sub.className = "muted-text";
    const dateStr = new Date(item.createdAt).toLocaleString();
    sub.textContent =
      item.kind === "file"
        ? `File • ${formatBytes(item.size)} • ${dateStr}`
        : `Text Record • ${dateStr}`;

    meta.appendChild(title);
    meta.appendChild(sub);

    if (item.kind === "note" && item.content) {
      const noteBox = document.createElement("div");
      noteBox.className = "item-note-preview";
      noteBox.textContent = item.content;
      meta.appendChild(noteBox);
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";

    if (item.kind === "file") {
      const dlBtn = document.createElement("div");
      dlBtn.className = "capsule-btn subtle small";
      dlBtn.setAttribute("role", "button");
      dlBtn.setAttribute("tabindex", "0");
      dlBtn.textContent = "Download";
      dlBtn.onclick = () => downloadItem(item);
      actions.appendChild(dlBtn);
    } else {
      const copyBtn = document.createElement("div");
      copyBtn.className = "capsule-btn subtle small";
      copyBtn.setAttribute("role", "button");
      copyBtn.setAttribute("tabindex", "0");
      copyBtn.textContent = "Copy";
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(item.content || "");
        notify("Copied to clipboard");
      };
      actions.appendChild(copyBtn);
    }

    const delBtn = document.createElement("div");
    delBtn.className = "capsule-btn danger small";
    delBtn.setAttribute("role", "button");
    delBtn.setAttribute("tabindex", "0");
    delBtn.textContent = "Delete";
    delBtn.onclick = () => deleteItem(item.id);
    actions.appendChild(delBtn);

    card.appendChild(meta);
    card.appendChild(actions);
    grid.appendChild(card);
  });
}

// Upload files with live progress bar
function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  if (!state.serverOnline || !state.serverUrl) {
    notify("Laptop server is offline.");
    return;
  }

  const formData = new FormData();
  for (const file of fileList) {
    formData.append("files", file);
  }

  const wrap = document.getElementById("uploadProgressWrap");
  const bar = document.getElementById("uploadProgressBar");
  const txt = document.getElementById("uploadProgressText");

  wrap.classList.remove("hidden");
  bar.style.width = "0%";
  txt.textContent = "Uploading to laptop... 0%";

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${state.serverUrl}/api/upload`, true);
  xhr.setRequestHeader("Authorization", `Bearer ${state.token}`);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = `${pct}%`;
      txt.textContent = `Uploading to laptop... ${pct}%`;
    }
  };

  xhr.onload = () => {
    wrap.classList.add("hidden");
    document.getElementById("fileInput").value = "";
    if (xhr.status >= 200 && xhr.status < 300) {
      notify("Stored on laptop successfully");
      loadVaultItems();
    } else {
      notify("Upload failed.");
    }
  };

  xhr.onerror = () => {
    wrap.classList.add("hidden");
    notify("Network error during upload.");
  };

  xhr.send(formData);
}

// Save text/JSON record to laptop
async function saveNoteRecord() {
  if (!state.serverOnline || !state.serverUrl) {
    notify("Laptop server is offline.");
    return;
  }

  const title = document.getElementById("noteTitleInput").value.trim();
  const content = document.getElementById("noteContentInput").value.trim();
  if (!content) {
    notify("Enter some text or data to store.");
    return;
  }

  try {
    const res = await fetch(`${state.serverUrl}/api/notes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`
      },
      body: JSON.stringify({ title, content })
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("noteTitleInput").value = "";
      document.getElementById("noteContentInput").value = "";
      notify("Saved to laptop database");
      loadVaultItems();
    } else {
      notify(data.error || "Could not save note.");
    }
  } catch (err) {
    notify("Laptop server unreachable.");
  }
}

// Download file directly from laptop
async function downloadItem(item) {
  if (!state.serverOnline) {
    notify("Laptop server is offline.");
    return;
  }
  notify(`Downloading ${item.title}...`);
  try {
    const res = await fetch(`${state.serverUrl}/api/download/${item.id}`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!res.ok) throw new Error("Download error");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = item.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    notify("Download failed.");
  }
}

// Delete file/note from laptop
async function deleteItem(itemId) {
  if (!state.serverOnline) {
    notify("Laptop server is offline.");
    return;
  }
  try {
    const res = await fetch(`${state.serverUrl}/api/items/${itemId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (data.ok) {
      notify("Deleted from laptop");
      loadVaultItems();
    }
  } catch (err) {
    notify("Delete failed.");
  }
}

// Wire up UI events
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("serverPill").onclick = () => syncServerDiscovery(false);
  document.getElementById("tabLogin").onclick = () => setAuthMode("login");
  document.getElementById("tabRegister").onclick = () => setAuthMode("register");
  document.getElementById("authSubmitBtn").onclick = handleAuthSubmit;
  document.getElementById("logoutBtn").onclick = signOut;
  document.getElementById("refreshVaultBtn").onclick = () => {
    loadVaultItems();
    notify("Vault synced");
  };
  document.getElementById("saveNoteBtn").onclick = saveNoteRecord;

  // Enter key on auth inputs
  ["usernameInput", "passwordInput", "displayNameInput"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleAuthSubmit();
    });
  });

  // Drag & drop upload
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");

  dropZone.onclick = () => fileInput.click();
  fileInput.onchange = () => uploadFiles(fileInput.files);

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files);
  });

  // Search & Filter chips
  document.getElementById("searchInput").oninput = (e) => {
    state.search = e.target.value;
    renderItems();
  };

  ["all", "files", "notes"].forEach((type) => {
    const el = document.getElementById(`filter${type.charAt(0).toUpperCase() + type.slice(1)}`);
    el.onclick = () => {
      state.filter = type;
      document.querySelectorAll(".capsule-chip").forEach((c) => c.classList.remove("active"));
      el.classList.add("active");
      renderItems();
    };
  });

  // Initial server discovery + periodic polling
  const online = await syncServerDiscovery(true);
  if (state.token && online) {
    enterVaultView();
  }
  setInterval(() => syncServerDiscovery(true), 25000);
});