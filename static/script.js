// =========================================================
// STATE
// =========================================================
let selectedFile = null;
let currentJobId = null;
let pollTimer = null;
let originalUrl = null;
let stagedPreviewUrl = null;
let stagedToken = null;
let currentView = "side";
let sliderDragging = false;
let sliderSyncing = false;
let currentVideoDuration = 0;

const EFFECT_LABELS = window.EFFECT_LABELS || {};

// =========================================================
// ELEMENTS
// =========================================================
const $ = (id) => document.getElementById(id);

const dropZone      = $("dropZone");
const fileInput     = $("fileInput");
const fileInfo      = $("fileInfo");
const remixBtn      = $("remixBtn");
const placeholder   = $("placeholder");
const compareArea   = $("compareArea");
const progressWrap  = $("progressWrap");
const progressFill  = $("progressFill");
const progressText  = $("progressText");
const resultActions = $("resultActions");
const downloadBtn   = $("downloadBtn");
const againBtn      = $("againBtn");
const errorBox      = $("errorBox");
const viewToggle    = $("viewToggle");

const originalVideo  = $("originalVideo");
const previewVideo   = $("previewVideo");
const sliderOriginal = $("sliderOriginal");
const sliderRemix    = $("sliderRemix");
const singleVideo    = $("singleVideo");

const sliderContainer = $("sliderContainer");
const sliderTop       = $("sliderTop");
const sliderHandle    = $("sliderHandle");
const sliderPlayBtn   = $("sliderPlayBtn");
const sliderScrub     = $("sliderScrub");
const sliderTime      = $("sliderTime");

// =========================================================
// SLIDER BINDINGS
// =========================================================
function bindSlider(id, outId, suffix = "") {
  const el = $(id), out = $(outId);
  if (!el || !out) return;
  const update = () => out.textContent = el.value + suffix;
  el.addEventListener("input", update);
  update();
}
function bindPctSlider(id, outId) {
  const el = $(id), out = $(outId);
  if (!el || !out) return;
  const update = () => out.textContent = Math.round(el.value * 100) + "%";
  el.addEventListener("input", update);
  update();
}

bindSlider("segment_duration", "outDuration", "s");
bindSlider("effects_per_segment", "outEffects");
bindSlider("category_run_length", "outRun");
bindSlider("scene_threshold", "outThresh");
bindPctSlider("crop_top_pct", "outCropTop");
bindPctSlider("crop_bottom_pct", "outCropBottom");

// =========================================================
// SEGMENT AUTO-ADAPT
// =========================================================
function probeVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const url = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(isFinite(video.duration) ? video.duration : 0);
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    video.src = url;
  });
}

function updateTotalSegmentsHint() {
  const hintEl = $("totalSegmentsHint");
  if (!hintEl) return;
  if ($("motion_aware")?.checked) {
    hintEl.title = "Motion-aware mode: segment count depends on scene cuts";
    return;
  }
  if (!currentVideoDuration) {
    hintEl.value = 0;
    hintEl.title = "Upload a video or paste a URL to auto-calculate";
    return;
  }
  const segLen = parseFloat($("segment_duration")?.value) || 3;
  const rawTotal = Math.ceil(currentVideoDuration / segLen);
  const total = Math.max(1, Math.min(500, rawTotal));
  hintEl.value = total;
  hintEl.title = `${currentVideoDuration.toFixed(2)}s ÷ ${segLen}s = ${total} segments`;
  hintEl.style.color = total > 150 ? "#ef4444" : total > 50 ? "#f59e0b" : "";
}

$("segment_duration")?.addEventListener("input", updateTotalSegmentsHint);
$("motion_aware")?.addEventListener("change", updateTotalSegmentsHint);

// =========================================================
// ORDERED EFFECT LISTS
// =========================================================
function initOrderedList(listId, addSelectId, options = {}) {
  const withWindows = !!options.withWindows;
  const list = document.getElementById(listId);
  const select = document.getElementById(addSelectId);
  if (!list || !select) return;

  select.addEventListener("change", () => {
    if (!select.value) return;
    addItem(list, select.value, withWindows);
    select.value = "";
  });

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (!btn) return;
    btn.closest(".ordered-item").remove();
    renumber(list);
  });

  // Drag and drop
  list.addEventListener("dragstart", (e) => {
    const item = e.target.closest(".ordered-item");
    if (!item) return;
    item.classList.add("dragging");
  });
  list.addEventListener("dragend", (e) => {
    const item = e.target.closest(".ordered-item");
    if (item) item.classList.remove("dragging");
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = list.querySelector(".dragging");
    if (!dragging) return;
    const after = getDragAfterElement(list, e.clientY);
    if (after == null) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
  });
}

function getDragAfterElement(container, y) {
  const items = [...container.querySelectorAll(".ordered-item:not(.dragging)")];
  return items.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function addItem(list, key, withWindows = false) {
  const item = document.createElement("div");
  item.className = "ordered-item";
  item.draggable = true;
  item.dataset.key = key;
  const label = EFFECT_LABELS[key] || key;

  if (withWindows) {
    item.innerHTML = `
      <span class="grip">⋮⋮</span>
      <span class="num"></span>
      <span class="label">${label}</span>
      <span class="window">
        From <input type="number" class="win-from" min="1" max="500" placeholder="1" />
        To <input type="number" class="win-to" min="1" max="500" placeholder="last" />
      </span>
      <button type="button" class="remove" title="Remove">✕</button>`;
  } else {
    item.innerHTML = `
      <span class="grip">⋮⋮</span>
      <span class="num"></span>
      <span class="label">${label}</span>
      <button type="button" class="remove" title="Remove">✕</button>`;
  }
  list.appendChild(item);
  renumber(list);
}

function renumber(list) {
  [...list.querySelectorAll(".ordered-item")].forEach((el, i) => {
    el.querySelector(".num").textContent = i + 1;
  });
}

initOrderedList("baseList", "baseAdd");
initOrderedList("segList",  "segAdd", { withWindows: true });

// =========================================================
// WINDOW HELPERS
// =========================================================
function getBaseKeys() {
  return [...document.querySelectorAll("#baseList .ordered-item")].map(i => i.dataset.key);
}

function getEffectWindows() {
  const out = [];
  document.querySelectorAll("#segList .ordered-item").forEach(el => {
    const frm = parseInt(el.querySelector(".win-from")?.value, 10) || 1;
    let to = parseInt(el.querySelector(".win-to")?.value, 10);
    if (!to || Number.isNaN(to)) to = null;
    out.push({ key: el.dataset.key, from: frm, to });
  });
  return out;
}

// =========================================================
// SELECT ALL / NONE
// =========================================================
$("selectAll")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelectorAll("input[name=effects]").forEach(cb => cb.checked = true);
});
$("selectNone")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelectorAll("input[name=effects]").forEach(cb => cb.checked = false);
});

// =========================================================
// CONDITIONAL FIELDS
// =========================================================
$("group_by_category")?.addEventListener("change", e => {
  $("runLengthField").style.display = e.target.checked ? "block" : "none";
});
$("motion_aware")?.addEventListener("change", e => {
  $("thresholdField").style.display = e.target.checked ? "block" : "none";
});

// =========================================================
// FILE PICKER
// =========================================================
fileInput?.addEventListener("change", (e) => {
  if (e.target.files.length) setFile(e.target.files[0]);
});
["dragenter", "dragover"].forEach(ev =>
  dropZone?.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); })
);
["dragleave", "drop"].forEach(ev =>
  dropZone?.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); })
);
dropZone?.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});

function setFile(file) {
  if (!file.type.startsWith("video/")) { showError("Please choose a video file."); return; }
  selectedFile = file;
  stagedToken = null;
  stagedPreviewUrl = null;
  if (originalUrl?.startsWith("blob:")) URL.revokeObjectURL(originalUrl);
  originalUrl = URL.createObjectURL(file);
  const mb = (file.size / 1024 / 1024).toFixed(2);
  fileInfo.textContent = `📁 ${file.name} · ${mb} MB`;
  fileInfo.classList.remove("hidden");
  remixBtn.disabled = false;
  hideError();
  probeVideoDuration(file).then((dur) => {
    currentVideoDuration = dur;
    updateTotalSegmentsHint();
  });
  showOriginalPreview();
}

function showOriginalPreview() {
  placeholder.classList.add("hidden");
  compareArea.classList.remove("hidden");
  viewToggle.classList.add("hidden");
  const src = originalUrl || stagedPreviewUrl;
  if (!src) return;
  originalVideo.src = src;
  sliderOriginal.src = src;
  singleVideo.src = src;
  setView("single");
}

// =========================================================
// FETCH FROM URL
// =========================================================
$("fetchUrlBtn")?.addEventListener("click", async () => {
  const url = $("videoUrl").value.trim();
  if (!url) { showError("Paste a video URL first."); return; }
  if (!/^https?:\/\//i.test(url)) { showError("URL must start with http:// or https://"); return; }

  hideError();
  progressWrap.classList.remove("hidden");
  setProgress(5, "Resolving & downloading…");

  const fd = new FormData();
  fd.append("video_url", url);

  try {
    const res = await fetch("/fetch_url", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Fetch failed");

    selectedFile = null;
    if (originalUrl?.startsWith("blob:")) URL.revokeObjectURL(originalUrl);
    originalUrl = null;

    stagedToken = data.token;
    stagedPreviewUrl = data.preview_url;
    currentVideoDuration = data.duration || 0;
    updateTotalSegmentsHint();

    placeholder.classList.add("hidden");
    compareArea.classList.remove("hidden");
    viewToggle.classList.add("hidden");

    originalVideo.src = data.preview_url;
    sliderOriginal.src = data.preview_url;
    singleVideo.src = data.preview_url;
    previewVideo.src = data.preview_url;
    sliderRemix.src = data.preview_url;
    setView("single");

    fileInfo.textContent = `🌐 Fetched: ${data.input_name} · ${currentVideoDuration.toFixed(2)}s`;
    fileInfo.classList.remove("hidden");

    remixBtn.disabled = false;
    progressWrap.classList.add("hidden");
    hideError();
  } catch (err) {
    resetUI();
    showError(err.message);
  }
});

// =========================================================
// REMIX
// =========================================================
remixBtn?.addEventListener("click", async () => {
  if (stagedToken) return runRemixOnStaged();
  if (selectedFile)  return stageUploadAndRemix();
  showError("Upload a video, paste a URL, or choose a file first.");
});

async function runRemixOnStaged() {
  hideError();
  resultActions.classList.add("hidden");
  progressWrap.classList.remove("hidden");
  setProgress(5, "Starting remix…");
  remixBtn.disabled = true;
  remixBtn.textContent = "⏳ Working…";

  const fd = buildOptionsFormData();

  try {
    const res = await fetch(`/remix/${stagedToken}`, { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Remix failed");
    currentJobId = data.job_id;
    stagedToken = null;
    pollStatus();
  } catch (err) {
    resetUI();
    showError(err.message);
  }
}

async function stageUploadAndRemix() {
  hideError();
  resultActions.classList.add("hidden");
  progressWrap.classList.remove("hidden");
  setProgress(5, "Uploading…");
  remixBtn.disabled = true;
  remixBtn.textContent = "⏳ Uploading…";

  const up = new FormData();
  up.append("video", selectedFile);

  try {
    const res = await fetch("/stage_upload", { method: "POST", body: up });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    setProgress(20, "Starting remix…");
    const fd = buildOptionsFormData();
    const res2 = await fetch(`/remix/${data.token}`, { method: "POST", body: fd });
    const data2 = await res2.json();
    if (!res2.ok) throw new Error(data2.error || "Remix failed");
    currentJobId = data2.job_id;
    pollStatus();
  } catch (err) {
    resetUI();
    showError(err.message);
  }
}

function buildOptionsFormData() {
  const fd = new FormData();
  fd.append("segment_duration", $("segment_duration").value);
  fd.append("effects_per_segment", $("effects_per_segment").value);
  fd.append("preserve_audio", $("preserve_audio")?.checked ? "1" : "0");
  fd.append("crop_top_pct", $("crop_top_pct").value);
  fd.append("crop_bottom_pct", $("crop_bottom_pct").value);
  fd.append("quality_preset", $("quality_preset").value);

  const gbc = $("group_by_category");
  if (gbc?.checked) {
    fd.append("group_by_category", "1");
    fd.append("category_run_length", $("category_run_length").value);
  }
  const ma = $("motion_aware");
  if (ma?.checked) {
    fd.append("motion_aware", "1");
    fd.append("scene_threshold", $("scene_threshold").value);
  }

  document.querySelectorAll("input[name=effects]:checked").forEach(cb =>
    fd.append("effects", cb.value));
  getBaseKeys().forEach(k => fd.append("base_effects", k));
  const windows = getEffectWindows();
  if (windows.length) fd.append("effect_windows", JSON.stringify(windows));
  fd.append("rotate_order", $("rotate_order").checked ? "1" : "0");
  return fd;
}

// =========================================================
// POLLING
// =========================================================
function pollStatus() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/status/${currentJobId}`);
      const data = await res.json();
      setProgress(data.progress, data.message);
      if (data.status === "done") {
        clearInterval(pollTimer);
        showResult(data.preview_url, data.download_url, data.original_url);
      } else if (data.status === "error") {
        clearInterval(pollTimer);
        resetUI();
        showError(data.message);
      }
    } catch (err) {
      clearInterval(pollTimer);
      resetUI();
      showError("Lost connection to server.");
    }
  }, 800);
}

// =========================================================
// RESULT
// =========================================================
function showResult(previewUrl, downloadUrl, originalUrlFromServer) {
  setProgress(100, "✅ Done!");
  setTimeout(() => progressWrap.classList.add("hidden"), 900);
  compareArea.classList.remove("hidden");
  viewToggle.classList.remove("hidden");

  previewVideo.src = previewUrl;
  sliderRemix.src = previewUrl;
  singleVideo.src = previewUrl;

  if (originalUrlFromServer) {
    originalVideo.src = originalUrlFromServer;
    sliderOriginal.src = originalUrlFromServer;
  } else if (originalUrl) {
    originalVideo.src = originalUrl;
    sliderOriginal.src = originalUrl;
  } else if (stagedPreviewUrl) {
    originalVideo.src = stagedPreviewUrl;
    sliderOriginal.src = stagedPreviewUrl;
  }

  setView("side");
  wireSideBySideSync();
  wireSliderOverlay();
  wireSliderControls();

  downloadBtn.href = downloadUrl;
  resultActions.classList.remove("hidden");

  let publishBtn = document.getElementById("publishYtBtn");
  if (!publishBtn) {
    publishBtn = document.createElement("button");
    publishBtn.id = "publishYtBtn";
    publishBtn.className = "secondary";
    publishBtn.textContent = "📤 Publish to YouTube";
    resultActions.appendChild(publishBtn);
  }
  publishBtn.onclick = () => onPublishToYouTube(publishBtn);

  remixBtn.disabled = false;
  remixBtn.textContent = "🚀 Remix It!";
}

async function onPublishToYouTube(publishBtn) {
  const title = prompt("YouTube title:", "My Remix Short");
  if (!title) return;
  const description = prompt("Description (optional):", title) || title;
  const originalText = publishBtn.textContent;
  publishBtn.disabled = true;
  publishBtn.textContent = "⏳ Publishing…";
  try {
    const res = await fetch(`/publish_to_youtube/${currentJobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, caption: description }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    alert("✅ Added to Buffer queue for YouTube!");
  } catch (err) {
    alert("❌ Publish failed:\n" + err.message);
  } finally {
    publishBtn.disabled = false;
    publishBtn.textContent = originalText;
  }
}

// =========================================================
// VIEW SWITCHER
// =========================================================
viewToggle?.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

function setView(view) {
  currentView = view;
  viewToggle?.querySelectorAll(".tab").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view));
  $("sideView")?.classList.toggle("active", view === "side");
  $("sliderView")?.classList.toggle("active", view === "slider");
  $("singleView")?.classList.toggle("active", view === "single");
  pauseAll();
}

function pauseAll() {
  [originalVideo, previewVideo, sliderOriginal, sliderRemix, singleVideo]
    .forEach(v => v && v.pause());
}

function wireSideBySideSync() {
  const sync = (src, dst) => {
    if (Math.abs(src.currentTime - dst.currentTime) > 0.2) dst.currentTime = src.currentTime;
  };
  if (originalVideo) {
    originalVideo.ontimeupdate = () => {
      if (currentView === "side" && !originalVideo.paused) sync(originalVideo, previewVideo);
    };
    originalVideo.onplay = () => previewVideo?.play().catch(() => {});
    originalVideo.onpause = () => previewVideo?.pause();
  }
  if (previewVideo) {
    previewVideo.ontimeupdate = () => {
      if (currentView === "side" && !previewVideo.paused) sync(previewVideo, originalVideo);
    };
    previewVideo.onplay = () => originalVideo?.play().catch(() => {});
    previewVideo.onpause = () => originalVideo?.pause();
  }
}

function wireSliderOverlay() {
  const setSplit = (pct) => {
    pct = Math.max(0, Math.min(100, pct));
    sliderTop.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    sliderHandle.style.left = pct + "%";
  };
  const getPct = (x) => {
    const r = sliderContainer.getBoundingClientRect();
    return ((x - r.left) / r.width) * 100;
  };
  sliderHandle.addEventListener("mousedown", (e) => { sliderDragging = true; e.preventDefault(); });
  sliderContainer.addEventListener("mousedown", (e) => { sliderDragging = true; setSplit(getPct(e.clientX)); });
  window.addEventListener("mousemove", (e) => { if (sliderDragging) setSplit(getPct(e.clientX)); });
  window.addEventListener("mouseup", () => sliderDragging = false);
  setSplit(50);
}

function wireSliderControls() {
  if (!sliderPlayBtn) return;
  const play = () => {
    sliderOriginal.currentTime = sliderRemix.currentTime;
    sliderOriginal.play().catch(() => {});
    sliderRemix.play().catch(() => {});
    sliderPlayBtn.textContent = "⏸";
  };
  const pause = () => {
    sliderOriginal.pause(); sliderRemix.pause();
    sliderPlayBtn.textContent = "▶";
  };
  sliderPlayBtn.onclick = () => { if (sliderRemix.paused) play(); else pause(); };
}

// =========================================================
// PROGRESS / ERROR
// =========================================================
function setProgress(pct, msg) {
  progressFill.style.width = pct + "%";
  if (msg) progressText.textContent = msg;
}
function resetUI() {
  remixBtn.disabled = false;
  remixBtn.textContent = "🚀 Remix It!";
  progressWrap.classList.add("hidden");
}
function showError(msg) {
  errorBox.textContent = "⚠️ " + msg;
  errorBox.classList.remove("hidden");
}
function hideError() { errorBox.classList.add("hidden"); }

againBtn?.addEventListener("click", () => remixBtn.click());

// =========================================================
// CSV UPLOAD MANAGER
// =========================================================
(function() {
  const dropZone = document.getElementById("csvDropZone");
  const fileInput = document.getElementById("csvFileInput");
  const resultEl = document.getElementById("csvUploadResult");
  const fileListEl = document.getElementById("csvFileList");
  if (!dropZone || !fileInput) return;

  function setResult(msg, cls = "") {
    resultEl.textContent = msg;
    resultEl.className = "ai-status " + cls;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  async function loadFileList() {
    try {
      const r = await fetch("/api/groups");
      const d = await r.json();
      if (!d.success) return;
      if (!d.groups?.length) {
        fileListEl.innerHTML = '<div style="color:var(--muted)">No CSVs uploaded yet.</div>';
        return;
      }
      fileListEl.innerHTML = d.groups.map(g => `
        <div class="csv-file-item">
          <span class="name" title="${escapeHtml(g.name)}.csv">${escapeHtml(g.name)}.csv</span>
          <span class="count">${g.count}</span>
          <button type="button" class="del" data-name="${escapeHtml(g.name)}">✕</button>
        </div>`).join("");
      fileListEl.querySelectorAll(".del").forEach(b => {
        b.onclick = () => deleteFile(b.dataset.name);
      });
    } catch (e) {}
  }

  async function uploadFiles(files) {
    const csvs = [...files].filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (!csvs.length) return setResult("No CSVs selected", "error");
    setResult(`📤 Uploading ${csvs.length} file(s)…`, "working");
    const fd = new FormData();
    csvs.forEach(f => fd.append("files", f));
    try {
      const r = await fetch("/api/upload_csv", { method: "POST", body: fd });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Upload failed");
      const ok = (d.uploaded || []).length;
      const fail = (d.failed || []).length;
      setResult(`✅ Uploaded ${ok}${fail ? ` · ❌ ${fail} failed` : ""}`, fail ? "error" : "ok");
      loadFileList();
    } catch (e) {
      setResult("❌ " + e.message, "error");
    }
  }

  async function deleteFile(name) {
    if (!confirm(`Delete ${name}.csv?`)) return;
    await fetch(`/api/delete_csv/${encodeURIComponent(name)}`, { method: "POST" });
    loadFileList();
  }

  fileInput.onchange = (e) => {
    if (e.target.files.length) uploadFiles(e.target.files);
    fileInput.value = "";
  };
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add("drag"); };
  dropZone.ondragleave = () => dropZone.classList.remove("drag");
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  };

  document.getElementById("csvRefreshBtn")?.addEventListener("click", loadFileList);
  document.getElementById("csvDeleteAllBtn")?.addEventListener("click", async () => {
    if (!confirm("Delete ALL CSVs from server?")) return;
    const r = await fetch("/api/groups");
    const d = await r.json();
    for (const g of d.groups || []) {
      await fetch(`/api/delete_csv/${encodeURIComponent(g.name)}`, { method: "POST" });
    }
    loadFileList();
  });

  loadFileList();
})();

// =========================================================
// AI QUEUE (one-by-one processing)
// =========================================================
(function() {
  const groupSelect = document.getElementById("aiGroupSelect");
  const queueEl = document.getElementById("aiQueue");
  const statusEl = document.getElementById("aiStatus");
  const statsEl = document.getElementById("aiStats");
  const progressPanel = document.getElementById("aiProgressPanel");
  const currentTitleEl = document.getElementById("aiCurrentTitle");
  const currentProgEl = document.getElementById("aiCurrentProgress");
  const currentStatusEl = document.getElementById("aiCurrentStatus");
  const stepsEl = document.getElementById("aiSteps");
  if (!queueEl) return;

  let queue = [];
  let selectedIdx = 0;
  let isProcessing = false;

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function setStatus(m, cls = "") {
    statusEl.textContent = m;
    statusEl.className = "ai-status " + cls;
  }
  function setCurrentProgress(pct, msg) {
    if (currentProgEl) currentProgEl.style.width = pct + "%";
    if (msg && currentStatusEl) currentStatusEl.textContent = msg;
  }
  function setStep(step, state) {
    stepsEl?.querySelectorAll(".ai-step").forEach(el => {
      if (el.dataset.step === step) {
        el.classList.remove("active", "done", "error");
        if (state) el.classList.add(state);
      }
    });
  }

  async function refreshGroups() {
    try {
      const r = await fetch("/api/groups");
      const d = await r.json();
      if (!d.success) return;
      groupSelect.innerHTML = '<option value="">— Select a group —</option>' +
        d.groups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count})</option>`).join("");
    } catch (e) {}
  }

  async function loadGroup(name) {
    if (!name) { setStatus("Select a group first.", "error"); return; }
    setStatus(`📥 Loading ${name}…`, "working");
    try {
      const r = await fetch(`/api/groups/${encodeURIComponent(name)}`);
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Load failed");
      const items = d.items.map(it => ({
        id: it.id || Math.random().toString(36).slice(2, 10),
        url: it.url, group: name,
        rawTitle: it.title || "", rawDescription: it.description || "",
        aiTitle: "", aiCaption: "", aiDescription: "", aiHashtags: "",
        status: "pending", error: null, jobId: null, remixUrl: null, publishError: null,
      }));
      queue = queue.concat(items);
      const firstPending = queue.findIndex(i => i.status === "pending");
      if (firstPending !== -1) selectedIdx = firstPending;
      renderQueue();
      setStatus(`📥 Loaded ${items.length} item(s) from ${name}`, "ok");
    } catch (e) {
      setStatus("❌ " + e.message, "error");
    }
  }

  function renderQueue() {
    if (!queue.length) {
      queueEl.innerHTML = '<div style="color:var(--muted);font-size:0.8rem">Queue empty — load a group or paste manually.</div>';
      if (statsEl) statsEl.innerHTML = "";
      return;
    }
    const counts = { pending: 0, done: 0, error: 0, remixed: 0, published: 0, processing: 0, remixing: 0, publishing: 0 };
    queue.forEach(i => counts[i.status] = (counts[i.status] || 0) + 1);
    if (statsEl) statsEl.innerHTML = `
      <div class="stat"><strong>${queue.length}</strong>Total</div>
      <div class="stat"><strong>${counts.pending}</strong>Pending</div>
      <div class="stat"><strong>${counts.done}</strong>AI Done</div>
      <div class="stat"><strong>${counts.remixed + counts.publishing}</strong>Remixed</div>
      <div class="stat"><strong>${counts.published}</strong>Published</div>
      <div class="stat"><strong>${counts.error}</strong>Errors</div>
    `;

    queueEl.innerHTML = queue.map((item, idx) => {
      const labels = {
        pending: "⏳ Pending", processing: "🤖 AI…", done: "✅ AI Ready",
        error: "❌ Error", remixing: "🎬 Remixing", remixed: "✅ Remixed",
        publishing: "📤 Publishing", published: "🚀 Published",
      };
      let body = "";
      if (!item.aiTitle && item.rawTitle) {
        body += `<div class="ai-title">${escapeHtml(item.rawTitle)}</div>`;
      }
      if (item.aiTitle) {
        body += `<div class="ai-result"><strong>${escapeHtml(item.aiTitle)}</strong></div>`;
      }
      if (item.error) {
        body += `<div class="ai-result error">❌ ${escapeHtml(item.error)}</div>`;
      }
      return `
        <div class="ai-item status-${item.status} ${idx === selectedIdx ? "current" : ""}" data-idx="${idx}">
          <div class="ai-row">
            <span class="ai-group">${escapeHtml(item.group)} · #${idx + 1}</span>
            <span class="ai-status-badge">${labels[item.status] || item.status}</span>
          </div>
          <div class="ai-url">${escapeHtml(item.url)}</div>
          ${body}
        </div>`;
    }).join("");
  }

  async function processOne(idx) {
    if (isProcessing) return;
    isProcessing = true;
    const item = queue[idx];
    if (!item) { isProcessing = false; return; }
    selectedIdx = idx;
    progressPanel?.classList.remove("hidden");
    if (currentTitleEl) {
      currentTitleEl.textContent = (item.rawTitle || item.url).slice(0, 60);
    }
    stepsEl?.querySelectorAll(".ai-step").forEach(el => el.classList.remove("active", "done", "error"));

    try {
      // AI step
      if (!item.aiTitle) {
        setStep("ai", "active");
        setCurrentProgress(10, "🤖 Generating AI content…");
        item.status = "processing";
        renderQueue();
        const r = await fetch("/api/ai/reformat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: item.rawTitle, description: item.rawDescription }),
        });
        const d = await r.json();
        if (!r.ok || !d.success) throw new Error(d.error || "AI failed");
        item.aiTitle = d.parsed.title || "";
        item.aiCaption = d.parsed.caption || "";
        item.aiDescription = d.parsed.description || "";
        item.aiHashtags = d.parsed.hashtags || "";
        item.status = "done";
        setStep("ai", "done");
      } else {
        setStep("ai", "done");
      }

      // Fetch step
      setStep("fetch", "active");
      setCurrentProgress(30, "📥 Fetching video…");
      item.status = "remixing";
      renderQueue();
      const fd = new FormData();
      fd.append("video_url", item.url);
      const r1 = await fetch("/fetch_url", { method: "POST", body: fd });
      const d1 = await r1.json();
      if (!r1.ok) throw new Error(d1.error || "Fetch failed");
      setStep("fetch", "done");

      // Remix step
      setStep("remix", "active");
      setCurrentProgress(50, "🎬 Starting remix…");
      const fd2 = new FormData();
      fd2.append("segment_duration", "3");
      fd2.append("effects_per_segment", "3");
      fd2.append("quality_preset", "high");
      fd2.append("preserve_audio", "1");
      fd2.append("group_name", item.group);
      fd2.append("source_url", item.url);
      const r2 = await fetch(`/remix/${d1.token}`, { method: "POST", body: fd2 });
      const d2 = await r2.json();
      if (!r2.ok) throw new Error(d2.error || "Remix failed");
      item.jobId = d2.job_id;

      let remixDone = false;
      for (let i = 0; i < 400; i++) {
        await new Promise(res => setTimeout(res, 1500));
        const sr = await fetch(`/status/${item.jobId}`);
        const sd = await sr.json();
        const pct = 50 + Math.round((sd.progress || 0) * 0.3);
        setCurrentProgress(pct, `🎬 Remixing… ${sd.progress || 0}%`);
        if (sd.status === "done") { remixDone = true; item.remixUrl = sd.preview_url; break; }
        if (sd.status === "error") throw new Error(sd.message || "Remix error");
      }
      if (!remixDone) throw new Error("Remix timeout");
      setStep("remix", "done");

      // Publish step
      setStep("publish", "active");
      setCurrentProgress(85, "📤 Publishing to YouTube…");
      item.status = "publishing";
      renderQueue();
      const r3 = await fetch(`/publish_to_youtube/${item.jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: item.aiTitle || item.rawTitle,
          caption: item.aiCaption || item.rawDescription,
        }),
      });
      const d3 = await r3.json();
      if (!r3.ok || d3.error) {
        item.status = "remixed";
        item.publishError = d3.error || "Publish failed";
        setStep("publish", "error");
      } else {
        item.status = "published";
        setStep("publish", "done");
      }
      setCurrentProgress(100, "🏁 Done");
    } catch (err) {
      item.status = "error";
      item.error = err.message;
    } finally {
      renderQueue();
      isProcessing = false;
      setTimeout(() => progressPanel?.classList.add("hidden"), 5000);
    }
  }

  document.getElementById("aiLoadGroupBtn")?.addEventListener("click", () => loadGroup(groupSelect.value));
  document.getElementById("aiRefreshGroups")?.addEventListener("click", refreshGroups);
  document.getElementById("aiProcessOneBtn")?.addEventListener("click", () => {
    let idx = selectedIdx;
    if (!queue[idx] || queue[idx].status === "published") {
      idx = queue.findIndex(i => i.status === "pending" || i.status === "error");
    }
    if (idx === -1) return setStatus("No pending items to process.", "error");
    processOne(idx);
  });
  document.getElementById("aiSkipBtn")?.addEventListener("click", () => {
    const next = queue.findIndex((i, ix) => ix > selectedIdx && (i.status === "pending" || i.status === "error"));
    if (next !== -1) { selectedIdx = next; renderQueue(); }
  });
  document.getElementById("aiClearBtn")?.addEventListener("click", () => {
    if (!queue.length) return;
    if (!confirm("Clear the entire queue?")) return;
    queue = []; selectedIdx = 0; renderQueue();
  });

  window.refreshAiGroups = refreshGroups;
  refreshGroups();
})();

// =========================================================
// BATCH CONTROL (server-side worker)
// =========================================================
(function() {
  const statusEl = document.getElementById("batchStatus");
  const startBtn = document.getElementById("aiBatchStartBtn");
  const stopBtn  = document.getElementById("aiBatchStopBtn");
  const cooldownInput = document.getElementById("batchCooldown");
  const sessionInput  = document.getElementById("batchGroupsPerSession");
  const skipInput     = document.getElementById("batchSkipPublished");
  if (!statusEl) return;

  let pollTimer = null;

  function formatCooldown(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function renderStatus(d) {
    if (!d.running && !d.last_message && d.groups_total === 0) {
      statusEl.classList.add("hidden");
      return;
    }
    statusEl.classList.remove("hidden", "paused", "complete");
    if (d.cooldown_remaining > 0) statusEl.classList.add("paused");
    if (!d.running && d.groups_done === d.groups_total && d.groups_total > 0) {
      statusEl.classList.add("complete");
    }

    statusEl.innerHTML = `
      <div class="batch-line">
        <span>📦 Groups</span>
        <span class="batch-value">${d.groups_done} / ${d.groups_total}</span>
      </div>
      <div class="batch-line">
        <span>📁 Current group</span>
        <span class="batch-value">${d.current_group || "—"}</span>
      </div>
      <div class="batch-line">
        <span>🎬 Items in group</span>
        <span class="batch-value">${d.items_done} / ${d.items_total}</span>
      </div>
      ${d.cooldown_remaining > 0 ? `
        <div class="batch-line">
          <span>😴 Cooldown</span>
          <span class="batch-value">${formatCooldown(d.cooldown_remaining)}</span>
        </div>` : ""}
      <div class="batch-line">
        <span>${d.running ? "🔵 Running" : "⚪ Idle"}</span>
        <span class="batch-value">${d.last_message || ""}</span>
      </div>
      ${d.last_error ? `<div class="batch-line" style="color:#fca5a5"><span>❌ ${d.last_error}</span></div>` : ""}
    `;

    if (startBtn) startBtn.style.display = d.running ? "none" : "inline-flex";
    if (stopBtn)  stopBtn.style.display  = d.running ? "inline-flex" : "none";
  }

  async function poll() {
    try {
      const r = await fetch("/api/batch/status");
      const d = await r.json();
      renderStatus(d);
      if (!d.running) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch (e) {
      console.warn("Batch status poll failed:", e);
    }
  }

  window.startBatchPolling = function() {
    if (pollTimer) clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, 2000);
  };

  startBtn?.addEventListener("click", async () => {
    const cooldown = parseInt(cooldownInput.value) || 30;
    const perSession = sessionInput.value;
    const skipPub = skipInput.checked;

    if (!confirm(
      `Start server-side batch?\n\n` +
      `• Cooldown: ${cooldown} min\n` +
      `• Groups per session: ${perSession || "All"}\n` +
      `• Skip published: ${skipPub}\n\n` +
      `This runs on the VPS — you can safely refresh or close this tab.`
    )) return;

    try {
      const r = await fetch("/api/batch/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cooldown_minutes: cooldown,
          groups_per_session: perSession ? parseInt(perSession) : null,
          skip_published: skipPub,
        }),
      });
      const d = await r.json();
      if (d.error) {
        alert("❌ " + d.error);
        return;
      }
      window.startBatchPolling();
    } catch (e) {
      alert("❌ " + e.message);
    }
  });

  stopBtn?.addEventListener("click", async () => {
    if (!confirm("Stop the server-side batch?\nCurrent item will finish first.")) return;
    await fetch("/api/batch/stop", { method: "POST" });
    window.startBatchPolling();
  });

  // ---- AUTO-RESUME ON PAGE LOAD ----
  (async () => {
    try {
      const r = await fetch("/api/batch/status");
      const d = await r.json();
      console.log("🔍 Batch status on load:", d);
      if (d.running) {
        console.log("✅ Server batch is running — resuming status polling");
        renderStatus(d);
        window.startBatchPolling();
      } else if (d.last_message || d.groups_total > 0) {
        renderStatus(d);
      }
    } catch (e) {
      console.warn("Could not check batch status on load:", e);
    }
  })();
})();

// =========================================================
// PROGRESS DASHBOARD (server-side group progress)
// =========================================================
(function() {
  const statsEl = document.getElementById("progressStats");
  const groupsEl = document.getElementById("progressGroups");
  if (!statsEl) return;

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  async function load() {
    try {
      const r = await fetch("/api/progress");
      const d = await r.json();
      if (!d.success) return;

      statsEl.innerHTML = `
        <div class="stat"><strong>${d.done_groups}</strong>Groups Done</div>
        <div class="stat"><strong>${d.in_progress_groups}</strong>In Progress</div>
        <div class="stat"><strong>${d.pending_groups}</strong>Not Started</div>
        <div class="stat"><strong>${d.processed_urls}/${d.total_urls}</strong>URLs</div>`;

      const names = Object.keys(d.groups).sort((a, b) =>
        (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0));

      groupsEl.innerHTML = names.map(name => {
        const g = d.groups[name];
        const total = (g.processed_urls?.length || 0) + (g.pending_urls?.length || 0);
        const done = g.processed_urls?.length || 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const statusClass = g.status === "done" ? "status-done"
                          : g.status === "in_progress" ? "status-in_progress"
                          : "status-pending";
        return `
          <div class="progress-group-row ${statusClass}">
            <span class="pg-name">${escapeHtml(name)}</span>
            <span class="pg-count">${done}/${total}</span>
            <div class="pg-bar"><div class="pg-fill" style="width:${pct}%"></div></div>
            <button type="button" class="pg-toggle mini-btn" data-name="${escapeHtml(name)}">▸</button>
          </div>`;
      }).join("");

      groupsEl.querySelectorAll(".pg-toggle").forEach(btn => {
        btn.onclick = async () => {
          const name = btn.dataset.name;
          const r = await fetch(`/api/progress/${encodeURIComponent(name)}`);
          const pd = await r.json();
          const g = pd.data || {};
          const row = btn.closest(".progress-group-row");
          const existing = row.nextElementSibling;
          if (existing && existing.classList.contains("pg-urls")) {
            existing.remove();
            btn.textContent = "▸";
            return;
          }
          const div = document.createElement("div");
          div.className = "pg-urls";
          const done = g.processed_urls || [];
          const pending = g.pending_urls || [];
          div.innerHTML = [
            ...pending.map(u => `<div class="pg-url pending">⏳ ${escapeHtml(u)}</div>`),
            ...done.map(u => `<div class="pg-url done">✅ ${escapeHtml(u)}</div>`),
          ].join("") || '<div style="color:var(--muted)">No URLs</div>';
          row.after(div);
          btn.textContent = "▾";
        };
      });
    } catch (e) {}
  }

  document.getElementById("refreshProgressBtn")?.addEventListener("click", load);
  document.getElementById("resetAllProgressBtn")?.addEventListener("click", async () => {
    if (!confirm("Reset ALL progress?\nEvery URL will be marked pending again.")) return;
    if (!confirm("Really? This cannot be undone.")) return;
    await fetch("/api/progress/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "yes-reset-all" }),
    });
    load();
  });

  load();
  setInterval(load, 30000);
})();

// =========================================================
// GEMINI API KEY SETTINGS
// =========================================================
(function() {
  const input = document.getElementById("setGeminiKey");
  const saveBtn = document.getElementById("saveGeminiBtn");
  const testBtn = document.getElementById("testGeminiBtn");
  const clearBtn = document.getElementById("clearGeminiBtn");
  const statusEl = document.getElementById("geminiSettingsStatus");
  const keyStatus = document.getElementById("geminiKeyStatus");
  if (!input || !saveBtn) return;

  function setStatus(m, cls = "") {
    statusEl.textContent = m;
    statusEl.className = "ai-status " + cls;
  }

  async function loadStatus() {
    try {
      const r = await fetch("/api/settings");
      const d = await r.json();
      const g = d.settings?.GEMINI_API_KEY || { set: false };
      keyStatus.className = "key-status " + (g.set ? (g.source === "env" ? "env" : "set") : "not-set");
      keyStatus.textContent = g.set ? (g.source === "env" ? "ENV" : "SET") : "NOT SET";
      if (g.set) keyStatus.title = `Masked: ${g.masked}`;
    } catch (e) {}
  }

  async function testKey() {
    setStatus("🧪 Testing key…", "working");
    try {
      const r = await fetch("/api/settings/test", { method: "POST" });
      const d = await r.json();
      if (d.results?.ai?.ok) setStatus("✅ " + d.results.ai.message, "ok");
      else setStatus("❌ " + (d.results?.ai?.message || d.error || "Test failed"), "error");
    } catch (e) {
      setStatus("❌ " + e.message, "error");
    }
  }

  saveBtn.onclick = async () => {
    const v = input.value.trim();
    if (!v) return setStatus("Paste a key first.", "error");
    if (!v.startsWith("AIza")) {
      if (!confirm("Doesn't look like a Gemini key (usually starts with 'AIza'). Save anyway?")) return;
    }
    setStatus("💾 Saving…", "working");
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ GEMINI_API_KEY: v }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Save failed");
      input.value = "";
      await loadStatus();
      await testKey();
    } catch (e) {
      setStatus("❌ " + e.message, "error");
    }
  };

  testBtn.onclick = testKey;

  clearBtn.onclick = async () => {
    if (!confirm("Clear the saved Gemini API key?")) return;
    setStatus("🗑️ Clearing…", "working");
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ GEMINI_API_KEY: "" }),
      });
      input.value = "";
      await loadStatus();
      setStatus("✅ Cleared.", "ok");
    } catch (e) {
      setStatus("❌ " + e.message, "error");
    }
  };

  loadStatus();
})();