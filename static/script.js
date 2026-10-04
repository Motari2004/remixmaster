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
  if ($("motion_aware")?.checked) { hintEl.title = "Motion-aware"; return; }
  if (!currentVideoDuration) { hintEl.value = 0; return; }
  const segLen = parseFloat($("segment_duration")?.value) || 3;
  const total = Math.max(1, Math.min(500, Math.ceil(currentVideoDuration / segLen)));
  hintEl.value = total;
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
    refreshTimelinePreview();
  });

  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (!btn) return;
    btn.closest(".ordered-item").remove();
    renumber(list);
  });
}

function addItem(list, key, withWindows = false) {
  const item = document.createElement("div");
  item.className = "ordered-item";
  item.dataset.key = key;
  const label = EFFECT_LABELS[key] || key;

  if (withWindows) {
    item.innerHTML = `
      <span class="grip">⋮⋮</span><span class="num"></span>
      <span class="label">${label}</span>
      <span class="window">From <input type="number" class="win-from" min="1" placeholder="1"> To <input type="number" class="win-to" min="1" placeholder="last"></span>
      <button type="button" class="remove">✕</button>`;
  } else {
    item.innerHTML = `
      <span class="grip">⋮⋮</span><span class="num"></span>
      <span class="label">${label}</span>
      <button type="button" class="remove">✕</button>`;
  }
  list.appendChild(item);
  renumber(list);
}

function renumber(list) {
  [...list.querySelectorAll(".ordered-item")].forEach((el, i) => {
    el.querySelector(".num").textContent = i + 1;
  });
}

function refreshTimelinePreview() { /* placeholder for compatibility */ }

initOrderedList("baseList", "baseAdd");
initOrderedList("segList",  "segAdd", { withWindows: true });

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

$("selectAll")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelectorAll("input[name=effects]").forEach(cb => cb.checked = true);
});
$("selectNone")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.querySelectorAll("input[name=effects]").forEach(cb => cb.checked = false);
});

$("group_by_category")?.addEventListener("change", e => {
  $("runLengthField").style.display = e.target.checked ? "block" : "none";
});
$("motion_aware")?.addEventListener("change", e => {
  $("thresholdField").style.display = e.target.checked ? "block" : "none";
});

// =========================================================
// SINGLE VIDEO — file picker + fetch + remix
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
  if (!file.type.startsWith("video/")) { showError("Video file required"); return; }
  selectedFile = file;
  stagedToken = null; stagedPreviewUrl = null;
  if (originalUrl?.startsWith("blob:")) URL.revokeObjectURL(originalUrl);
  originalUrl = URL.createObjectURL(file);
  const mb = (file.size / 1024 / 1024).toFixed(2);
  fileInfo.textContent = `📁 ${file.name} · ${mb} MB`;
  fileInfo.classList.remove("hidden");
  remixBtn.disabled = false;
  probeVideoDuration(file).then(d => { currentVideoDuration = d; updateTotalSegmentsHint(); });
  showOriginalPreview();
}

function showOriginalPreview() {
  placeholder.classList.add("hidden");
  compareArea.classList.remove("hidden");
  viewToggle.classList.add("hidden");
  const src = originalUrl || stagedPreviewUrl;
  if (!src) return;
  originalVideo.src = src; sliderOriginal.src = src; singleVideo.src = src;
  setView("single");
}

$("fetchUrlBtn")?.addEventListener("click", async () => {
  const url = $("videoUrl").value.trim();
  if (!url) return showError("Paste URL first.");
  const fd = new FormData();
  fd.append("video_url", url);
  try {
    const r = await fetch("/fetch_url", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed");
    selectedFile = null;
    if (originalUrl?.startsWith("blob:")) URL.revokeObjectURL(originalUrl);
    originalUrl = null;
    stagedToken = d.token;
    stagedPreviewUrl = d.preview_url;
    currentVideoDuration = d.duration || 0;
    updateTotalSegmentsHint();
    placeholder.classList.add("hidden");
    compareArea.classList.remove("hidden");
    viewToggle.classList.add("hidden");
    originalVideo.src = d.preview_url; sliderOriginal.src = d.preview_url; singleVideo.src = d.preview_url;
    previewVideo.src = d.preview_url; sliderRemix.src = d.preview_url;
    setView("single");
    fileInfo.textContent = `🌐 Fetched: ${d.input_name}`;
    fileInfo.classList.remove("hidden");
    remixBtn.disabled = false;
  } catch (err) { showError(err.message); }
});

remixBtn?.addEventListener("click", async () => {
  if (stagedToken) return runRemixOnStaged();
  if (selectedFile) return stageUploadAndRemix();
  showError("Choose a video first.");
});

async function runRemixOnStaged() {
  const fd = buildOptionsFormData();
  const r = await fetch(`/remix/${stagedToken}`, { method: "POST", body: fd });
  const d = await r.json();
  if (!r.ok) return showError(d.error);
  currentJobId = d.job_id;
  stagedToken = null;
  pollStatus();
}

async function stageUploadAndRemix() {
  const up = new FormData();
  up.append("video", selectedFile);
  const r = await fetch("/stage_upload", { method: "POST", body: up });
  const d = await r.json();
  if (!r.ok) return showError(d.error);
  const fd = buildOptionsFormData();
  const r2 = await fetch(`/remix/${d.token}`, { method: "POST", body: fd });
  const d2 = await r2.json();
  if (!r2.ok) return showError(d2.error);
  currentJobId = d2.job_id;
  pollStatus();
}

function buildOptionsFormData() {
  const fd = new FormData();
  fd.append("segment_duration", $("segment_duration").value);
  fd.append("effects_per_segment", $("effects_per_segment").value);
  fd.append("preserve_audio", $("preserve_audio")?.checked ? "1" : "0");
  fd.append("crop_top_pct", $("crop_top_pct").value);
  fd.append("crop_bottom_pct", $("crop_bottom_pct").value);
  fd.append("quality_preset", $("quality_preset").value);
  document.querySelectorAll("input[name=effects]:checked").forEach(cb => fd.append("effects", cb.value));
  getBaseKeys().forEach(k => fd.append("base_effects", k));
  const windows = getEffectWindows();
  if (windows.length) fd.append("effect_windows", JSON.stringify(windows));
  fd.append("rotate_order", $("rotate_order").checked ? "1" : "0");
  return fd;
}

function pollStatus() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await fetch(`/status/${currentJobId}`);
    const d = await r.json();
    setProgress(d.progress, d.message);
    if (d.status === "done") {
      clearInterval(pollTimer);
      showResult(d.preview_url, d.download_url, d.original_url);
    } else if (d.status === "error") {
      clearInterval(pollTimer);
      showError(d.message);
    }
  }, 800);
}

function showResult(previewUrl, downloadUrl, originalUrlFromServer) {
  setProgress(100, "✅ Done!");
  setTimeout(() => progressWrap.classList.add("hidden"), 900);
  compareArea.classList.remove("hidden");
  viewToggle.classList.remove("hidden");
  previewVideo.src = previewUrl; sliderRemix.src = previewUrl; singleVideo.src = previewUrl;
  const src = originalUrlFromServer || originalUrl || stagedPreviewUrl;
  if (src) { originalVideo.src = src; sliderOriginal.src = src; }
  setView("side");
  wireSideBySideSync(); wireSliderOverlay(); wireSliderControls();
  downloadBtn.href = downloadUrl;
  resultActions.classList.remove("hidden");
  let p = document.getElementById("publishYtBtn");
  if (!p) {
    p = document.createElement("button");
    p.id = "publishYtBtn"; p.className = "secondary"; p.textContent = "📤 Publish to YouTube";
    resultActions.appendChild(p);
  }
  p.onclick = () => onPublishToYouTube(p);
}

async function onPublishToYouTube(btn) {
  const title = prompt("YouTube title:", "My Remix Short");
  if (!title) return;
  const r = await fetch(`/publish_to_youtube/${currentJobId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, caption: title }),
  });
  const d = await r.json();
  if (d.error) alert("❌ " + (d.error.message || d.error));
  else alert("✅ Queued to Buffer!");
}

// =========================================================
// VIEW SWITCHER + SLIDER + SYNC
// =========================================================
function setView(view) {
  currentView = view;
  viewToggle.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("sideView").classList.toggle("active", view === "side");
  $("sliderView").classList.toggle("active", view === "slider");
  $("singleView").classList.toggle("active", view === "single");
}

function wireSideBySideSync() {
  const sync = (s, d) => { if (Math.abs(s.currentTime - d.currentTime) > 0.2) d.currentTime = s.currentTime; };
  originalVideo.ontimeupdate = () => { if (currentView === "side" && !originalVideo.paused) sync(originalVideo, previewVideo); };
  previewVideo.ontimeupdate = () => { if (currentView === "side" && !previewVideo.paused) sync(previewVideo, originalVideo); };
  originalVideo.onplay = () => previewVideo.play().catch(()=>{});
  previewVideo.onplay  = () => originalVideo.play().catch(()=>{});
  originalVideo.onpause = () => previewVideo.pause();
  previewVideo.onpause  = () => originalVideo.pause();
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
  sliderHandle.onmousedown = (e) => { sliderDragging = true; e.preventDefault(); };
  sliderContainer.onmousedown = (e) => { sliderDragging = true; setSplit(getPct(e.clientX)); };
  window.onmousemove = (e) => { if (sliderDragging) setSplit(getPct(e.clientX)); };
  window.onmouseup = () => sliderDragging = false;
  setSplit(50);
}

function wireSliderControls() { /* minimal */ }

function setProgress(pct, msg) {
  progressFill.style.width = pct + "%";
  if (msg) progressText.textContent = msg;
}
function showError(msg) { errorBox.textContent = "⚠️ " + msg; errorBox.classList.remove("hidden"); }
function hideError() { errorBox.classList.add("hidden"); }

// =========================================================
// CSV MANAGER
// =========================================================
(function() {
  const dropZone = document.getElementById("csvDropZone");
  const fileInput = document.getElementById("csvFileInput");
  const resultEl = document.getElementById("csvUploadResult");
  const fileListEl = document.getElementById("csvFileList");
  if (!dropZone || !fileInput) return;

  function setResult(msg, cls = "") { resultEl.textContent = msg; resultEl.className = "ai-status " + cls; }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

  async function loadFileList() {
    try {
      const r = await fetch("/api/groups");
      const d = await r.json();
      if (!d.success) return;
      if (!d.groups?.length) { fileListEl.innerHTML = '<div style="color:var(--muted)">No CSVs yet.</div>'; return; }
      fileListEl.innerHTML = d.groups.map(g => `
        <div class="csv-file-item">
          <span class="name">${escapeHtml(g.name)}.csv</span>
          <span class="count">${g.count}</span>
          <button type="button" class="del" data-name="${escapeHtml(g.name)}">✕</button>
        </div>`).join("");
      fileListEl.querySelectorAll(".del").forEach(b => b.onclick = () => deleteFile(b.dataset.name));
    } catch (e) {}
  }

  async function uploadFiles(files) {
    const csvs = [...files].filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (!csvs.length) return setResult("No CSVs selected", "error");
    setResult(`📤 Uploading ${csvs.length}…`, "working");
    const fd = new FormData();
    csvs.forEach(f => fd.append("files", f));
    try {
      const r = await fetch("/api/upload_csv", { method: "POST", body: fd });
      const d = await r.json();
      setResult(`✅ Uploaded ${d.uploaded.length}`, "ok");
      loadFileList();
    } catch (e) { setResult("❌ " + e.message, "error"); }
  }

  async function deleteFile(name) {
    if (!confirm(`Delete ${name}.csv?`)) return;
    await fetch(`/api/delete_csv/${encodeURIComponent(name)}`, { method: "POST" });
    loadFileList();
  }

  fileInput.onchange = (e) => { if (e.target.files.length) uploadFiles(e.target.files); fileInput.value = ""; };
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add("drag"); };
  dropZone.ondragleave = () => dropZone.classList.remove("drag");
  dropZone.ondrop = (e) => { e.preventDefault(); dropZone.classList.remove("drag"); if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); };

  document.getElementById("csvRefreshBtn")?.addEventListener("click", loadFileList);
  document.getElementById("csvDeleteAllBtn")?.addEventListener("click", async () => {
    if (!confirm("Delete ALL CSVs?")) return;
    const r = await fetch("/api/groups");
    const d = await r.json();
    for (const g of d.groups || []) await fetch(`/api/delete_csv/${encodeURIComponent(g.name)}`, { method: "POST" });
    loadFileList();
  });

  loadFileList();
})();

// =========================================================
// AI ONE-BY-ONE + BATCH
// =========================================================
(function() {
  const groupSelect = document.getElementById("aiGroupSelect");
  const queueEl = document.getElementById("aiQueue");
  const statusEl = document.getElementById("aiStatus");
  const statsEl = document.getElementById("aiStats");
  if (!queueEl) return;

  let queue = [];
  let selectedIdx = 0;
  let isProcessing = false;
  let batchRunning = false;
  let batchAbort = false;

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
  function setStatus(m, cls = "") { statusEl.textContent = m; statusEl.className = "ai-status " + cls; }

  async function refreshGroups() {
    const r = await fetch("/api/groups");
    const d = await r.json();
    if (!d.success) return;
    groupSelect.innerHTML = '<option value="">— Select a group —</option>' +
      d.groups.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count})</option>`).join("");
  }

  async function loadGroup(name) {
    if (!name) return;
    const r = await fetch(`/api/groups/${encodeURIComponent(name)}`);
    const d = await r.json();
    if (!d.success) return;
    const items = d.items.map(it => ({
      id: it.id || Math.random().toString(36).slice(2, 10),
      url: it.url, group: name,
      rawTitle: it.title || "", rawDescription: it.description || "",
      aiTitle: "", aiCaption: "", aiDescription: "", aiHashtags: "",
      status: "pending", error: null, jobId: null, remixUrl: null, publishError: null,
    }));
    queue = queue.concat(items);
    renderQueue();
    setStatus(`📥 Loaded ${items.length} items from ${name}`, "ok");
  }

  function renderQueue() {
    if (!queue.length) { queueEl.innerHTML = '<div style="color:var(--muted)">Queue empty</div>'; statsEl.innerHTML = ""; return; }
    const counts = { pending: 0, done: 0, error: 0, remixed: 0, published: 0 };
    queue.forEach(i => counts[i.status] = (counts[i.status] || 0) + 1);
    statsEl.innerHTML = `
      <div class="stat"><strong>${queue.length}</strong>Total</div>
      <div class="stat"><strong>${counts.pending || 0}</strong>Pending</div>
      <div class="stat"><strong>${counts.published || 0}</strong>Published</div>
      <div class="stat"><strong>${counts.error || 0}</strong>Errors</div>`;
    queueEl.innerHTML = queue.map((item, idx) => `
      <div class="ai-item status-${item.status} ${idx === selectedIdx ? "current" : ""}" data-idx="${idx}">
        <div class="ai-row">
          <span class="ai-group">${escapeHtml(item.group)} · #${idx+1}</span>
          <span class="ai-status-badge">${item.status}</span>
        </div>
        <div class="ai-url">${escapeHtml(item.url)}</div>
        ${item.aiTitle ? `<div class="ai-result"><strong>${escapeHtml(item.aiTitle)}</strong></div>` : ""}
        ${item.error ? `<div class="ai-result error">❌ ${escapeHtml(item.error)}</div>` : ""}
      </div>`).join("");
  }

  async function processOne(idx) {
    if (isProcessing) return;
    isProcessing = true;
    const item = queue[idx];
    if (!item) { isProcessing = false; return; }
    selectedIdx = idx;
    try {
      // AI
      if (!item.aiTitle) {
        item.status = "processing"; renderQueue();
        const r = await fetch("/api/ai/reformat", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: item.rawTitle, description: item.rawDescription }) });
        const d = await r.json();
        if (!d.success) throw new Error(d.error);
        item.aiTitle = d.parsed.title; item.aiCaption = d.parsed.caption;
        item.aiDescription = d.parsed.description; item.aiHashtags = d.parsed.hashtags;
      }
      // Fetch
      item.status = "remixing"; renderQueue();
      const fd = new FormData(); fd.append("video_url", item.url);
      const r1 = await fetch("/fetch_url", { method: "POST", body: fd });
      const d1 = await r1.json();
      if (!d1.success) throw new Error(d1.error);
      // Remix
      const fd2 = new FormData();
      fd2.append("segment_duration", "3");
      fd2.append("effects_per_segment", "3");
      fd2.append("quality_preset", "high");
      fd2.append("preserve_audio", "1");
      fd2.append("group_name", item.group);
      fd2.append("source_url", item.url);
      const r2 = await fetch(`/remix/${d1.token}`, { method: "POST", body: fd2 });
      const d2 = await r2.json();
      if (!d2.job_id) throw new Error("Remix failed");
      item.jobId = d2.job_id;
      // Poll
      let ok = false;
      for (let i = 0; i < 400; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const sr = await fetch(`/status/${item.jobId}`);
        const sd = await sr.json();
        if (sd.status === "done") { ok = true; item.remixUrl = sd.preview_url; break; }
        if (sd.status === "error") throw new Error(sd.message);
      }
      if (!ok) throw new Error("Timeout");
      // Publish
      item.status = "publishing"; renderQueue();
      const r3 = await fetch(`/publish_to_youtube/${item.jobId}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: item.aiTitle, caption: item.aiCaption }),
      });
      const d3 = await r3.json();
      if (d3.error) { item.status = "remixed"; item.publishError = d3.error.message || d3.error; }
      else { item.status = "published"; }
    } catch (err) {
      item.status = "error"; item.error = err.message;
    } finally {
      renderQueue();
      isProcessing = false;
    }
  }

  async function runBatch() {
    if (batchRunning) return;
    const cooldownMin = parseInt(document.getElementById("batchCooldown").value) || 30;
    const cooldownMs = cooldownMin * 60 * 1000;
    const perSession = document.getElementById("batchGroupsPerSession").value;

    const r = await fetch("/api/groups");
    const d = await r.json();
    let groups = d.groups.map(g => g.name);
    const publishedGroups = new Set(queue.filter(q => q.status === "published").map(q => q.group));
    groups = groups.filter(g => !publishedGroups.has(g));
    if (perSession) groups = groups.slice(0, parseInt(perSession));

    if (!groups.length) return setStatus("All done!", "ok");
    if (!confirm(`Process ${groups.length} groups with ${cooldownMin} min cooldown?`)) return;

    batchRunning = true;
    batchAbort = false;
    document.getElementById("aiBatchStartBtn").style.display = "none";
    document.getElementById("aiBatchStopBtn").style.display = "inline-flex";

    for (let gi = 0; gi < groups.length; gi++) {
      if (batchAbort) break;
      const groupName = groups[gi];
      setStatus(`📥 Group ${gi+1}/${groups.length}: ${groupName}`, "working");

      await loadGroup(groupName);
      const groupItems = queue.filter(q => q.group === groupName && (q.status === "pending" || q.status === "error"));
      for (let i = 0; i < groupItems.length; i++) {
        if (batchAbort) break;
        setStatus(`🎬 ${groupName}: item ${i+1}/${groupItems.length}`, "working");
        await processOne(queue.indexOf(groupItems[i]));
      }

      if (gi < groups.length - 1 && !batchAbort) {
        setStatus(`😴 Cooldown ${cooldownMin} min…`, "");
        const until = Date.now() + cooldownMs;
        while (Date.now() < until && !batchAbort) {
          const s = Math.ceil((until - Date.now()) / 1000);
          setStatus(`😴 Cooldown: ${Math.floor(s/60)}m ${s%60}s`, "");
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    batchRunning = false;
    document.getElementById("aiBatchStartBtn").style.display = "inline-flex";
    document.getElementById("aiBatchStopBtn").style.display = "none";
    setStatus(batchAbort ? "⏹️ Stopped" : "🏁 Complete", "ok");
  }

  document.getElementById("aiLoadGroupBtn")?.addEventListener("click", () => loadGroup(groupSelect.value));
  document.getElementById("aiRefreshGroups")?.addEventListener("click", refreshGroups);
  document.getElementById("aiProcessOneBtn")?.addEventListener("click", () => {
    const idx = queue.findIndex(q => q.status === "pending" || q.status === "error");
    if (idx === -1) return setStatus("No pending items", "error");
    processOne(idx);
  });
  document.getElementById("aiBatchStartBtn")?.addEventListener("click", runBatch);
  document.getElementById("aiBatchStopBtn")?.addEventListener("click", () => { batchAbort = true; });
  document.getElementById("aiClearBtn")?.addEventListener("click", () => { if (confirm("Clear queue?")) { queue = []; renderQueue(); } });

  refreshGroups();
})();

// =========================================================
// PROGRESS DASHBOARD
// =========================================================
(function() {
  const statsEl = document.getElementById("progressStats");
  const groupsEl = document.getElementById("progressGroups");
  if (!statsEl) return;
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

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
      const names = Object.keys(d.groups).sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0));
      groupsEl.innerHTML = names.map(name => {
        const g = d.groups[name];
        const total = (g.processed_urls?.length || 0) + (g.pending_urls?.length || 0);
        const done = g.processed_urls?.length || 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        return `<div class="progress-group-row status-${g.status}">
          <span class="pg-name">${escapeHtml(name)}</span>
          <span class="pg-count">${done}/${total}</span>
          <div class="pg-bar"><div class="pg-fill" style="width:${pct}%"></div></div>
        </div>`;
      }).join("");
    } catch (e) {}
  }
  document.getElementById("refreshProgressBtn")?.addEventListener("click", load);
  document.getElementById("resetAllProgressBtn")?.addEventListener("click", async () => {
    if (!confirm("Reset ALL progress?")) return;
    await fetch("/api/progress/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "yes-reset-all" }) });
    load();
  });
  load();
  setInterval(load, 30000);
})();

// =========================================================
// GEMINI SETTINGS
// =========================================================
(function() {
  const input = document.getElementById("setGeminiKey");
  const saveBtn = document.getElementById("saveGeminiBtn");
  const testBtn = document.getElementById("testGeminiBtn");
  const clearBtn = document.getElementById("clearGeminiBtn");
  const statusEl = document.getElementById("geminiSettingsStatus");
  const keyStatus = document.getElementById("geminiKeyStatus");
  if (!input || !saveBtn) return;

  function setStatus(m, cls = "") { statusEl.textContent = m; statusEl.className = "ai-status " + cls; }

  async function loadStatus() {
    try {
      const r = await fetch("/api/settings");
      const d = await r.json();
      const g = d.settings?.GEMINI_API_KEY || { set: false };
      keyStatus.className = "key-status " + (g.set ? (g.source === "env" ? "env" : "set") : "not-set");
      keyStatus.textContent = g.set ? (g.source === "env" ? "ENV" : "SET") : "NOT SET";
    } catch (e) {}
  }

  async function testKey() {
    setStatus("🧪 Testing…", "working");
    const r = await fetch("/api/settings/test", { method: "POST" });
    const d = await r.json();
    if (d.results?.ai?.ok) setStatus("✅ " + d.results.ai.message, "ok");
    else setStatus("❌ " + (d.results?.ai?.message || "Failed"), "error");
  }

  saveBtn.onclick = async () => {
    const v = input.value.trim();
    if (!v) return setStatus("Paste a key first", "error");
    setStatus("💾 Saving…", "working");
    const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ GEMINI_API_KEY: v }) });
    const d = await r.json();
    if (!d.success) return setStatus("❌ " + d.error, "error");
    input.value = "";
    setStatus("✅ Saved", "ok");
    loadStatus();
    testKey();
  };

  testBtn.onclick = testKey;
  clearBtn.onclick = async () => {
    if (!confirm("Clear API key?")) return;
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ GEMINI_API_KEY: "" }) });
    input.value = "";
    loadStatus();
    setStatus("✅ Cleared", "ok");
  };

  loadStatus();
})();