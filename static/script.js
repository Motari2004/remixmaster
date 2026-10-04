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

  if (typeof refreshTimelinePreview === "function") refreshTimelinePreview();
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

  list.addEventListener("dragstart", (e) => {
    const item = e.target.closest(".ordered-item");
    if (!item) return;
    item.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  list.addEventListener("dragend", (e) => {
    const item = e.target.closest(".ordered-item");
    if (item) item.classList.remove("dragging");
    list.querySelectorAll(".ordered-item").forEach(i =>
      i.classList.remove("drag-over"));
    refreshTimelinePreview();
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = list.querySelector(".dragging");
    if (!dragging) return;
    const after = getDragAfterElement(list, e.clientY);
    list.querySelectorAll(".ordered-item").forEach(i =>
      i.classList.remove("drag-over"));
    if (after == null) list.appendChild(dragging);
    else { after.classList.add("drag-over"); list.insertBefore(dragging, after); }
  });
  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (!btn) return;
    btn.closest(".ordered-item").remove();
    renumber(list);
    refreshTimelinePreview();
  });
}

function getDragAfterElement(container, y) {
  const items = [...container.querySelectorAll(".ordered-item:not(.dragging)")];
  return items.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset)
      return { offset, element: child };
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
        To   <input type="number" class="win-to"   min="1" max="500" placeholder="last" />
      </span>
      <button type="button" class="remove" title="Remove">✕</button>
    `;
    item.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("mousedown", (e) => e.stopPropagation());
      inp.addEventListener("dragstart", (e) => e.preventDefault());
      inp.addEventListener("input", () => {
        const frm = item.querySelector(".win-from");
        const to  = item.querySelector(".win-to");
        if (frm.value && to.value && +frm.value > +to.value) to.value = frm.value;
        refreshTimelinePreview();
      });
    });
  } else {
    item.innerHTML = `
      <span class="grip">⋮⋮</span>
      <span class="num"></span>
      <span class="label">${label}</span>
      <button type="button" class="remove" title="Remove">✕</button>
    `;
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
  const list = document.getElementById("baseList");
  if (!list) return [];
  return [...list.querySelectorAll(".ordered-item")].map(i => i.dataset.key);
}

function getEffectWindows() {
  const list = document.getElementById("segList");
  if (!list) return [];
  const out = [];
  const total = +document.getElementById("totalSegmentsHint")?.value || 0;

  [...list.querySelectorAll(".ordered-item")].forEach(el => {
    const key = el.dataset.key;
    const fromEl = el.querySelector(".win-from");
    const toEl   = el.querySelector(".win-to");
    const frm = parseInt(fromEl?.value, 10) || 1;
    let to = parseInt(toEl?.value, 10);
    if (!to || Number.isNaN(to)) to = total > 0 ? total : null;
    if (to < frm) to = frm;
    out.push({ key, from: frm, to });
  });
  return out;
}

// =========================================================
// QUICK BUTTONS
// =========================================================
$("spreadEvenly")?.addEventListener("click", () => {
  const list = document.getElementById("segList");
  const items = [...list.querySelectorAll(".ordered-item")];
  const total = +document.getElementById("totalSegmentsHint")?.value || 6;
  const n = items.length;
  if (!n) return;
  const span = Math.max(1, Math.floor(total / n));
  items.forEach((el, i) => {
    const frm = i * span + 1;
    const to = (i === n - 1) ? total : Math.min(total, frm + span - 1);
    el.querySelector(".win-from").value = frm;
    el.querySelector(".win-to").value = to;
  });
  refreshTimelinePreview();
});

$("fillAllSegments")?.addEventListener("click", () => {
  const list = document.getElementById("segList");
  [...list.querySelectorAll(".ordered-item")].forEach(el => {
    el.querySelector(".win-from").value = 1;
    el.querySelector(".win-to").value = "";
  });
  refreshTimelinePreview();
});

// =========================================================
// TIMELINE PREVIEW
// =========================================================
function refreshTimelinePreview() {
  const container = document.getElementById("timelinePreview");
  if (!container) return;

  const windows = getEffectWindows();
  const total = +document.getElementById("totalSegmentsHint")?.value || 6;
  if (!windows.length || !total) { container.innerHTML = ""; return; }

  const plan = [];
  for (let s = 1; s <= total; s++) {
    const active = windows
      .filter(w => w.from <= s && (w.to == null || s <= w.to))
      .map(w => w.key);
    plan.push(active);
  }

  container.innerHTML = plan.map((keys, i) => {
    const chips = keys.length
      ? keys.map(k => `<span class="tp-chip">${EFFECT_LABELS[k] || k}</span>`).join("")
      : `<span class="tp-chip empty">—</span>`;
    return `<div class="tp-row"><span class="tp-num">${i+1}</span><div class="tp-chips">${chips}</div></div>`;
  }).join("");
}

$("totalSegmentsHint")?.addEventListener("input", refreshTimelinePreview);

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
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) setFile(e.target.files[0]);
});
["dragenter", "dragover"].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); })
);
["dragleave", "drop"].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); })
);
dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) setFile(f);
});

function setFile(file) {
  if (!file.type.startsWith("video/")) { showError("Please choose a video file."); return; }
  selectedFile = file;
  stagedToken = null;
  stagedPreviewUrl = null;

  if (originalUrl && originalUrl.startsWith("blob:")) URL.revokeObjectURL(originalUrl);
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
// FETCH FROM URL (single video)
// =========================================================
document.addEventListener("DOMContentLoaded", () => {
  const fetchBtn = document.getElementById("fetchUrlBtn");
  const urlInput = document.getElementById("videoUrl");
  if (!fetchBtn || !urlInput) return;

  fetchBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) { showError("Paste a video URL first."); return; }
    if (!/^https?:\/\//i.test(url)) { showError("URL must start with http:// or https://"); return; }

    hideError();
    fetchBtn.disabled = true;
    fetchBtn.textContent = "⏳ Fetching…";
    progressWrap.classList.remove("hidden");
    setProgress(5, "Resolving & downloading…");

    const fd = new FormData();
    fd.append("video_url", url);

    try {
      const res = await fetch("/fetch_url", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fetch failed");

      selectedFile = null;
      if (originalUrl && originalUrl.startsWith("blob:")) URL.revokeObjectURL(originalUrl);
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
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "🌐 Fetch";
    }
  });
});

// =========================================================
// REMIX (single video)
// =========================================================
remixBtn.addEventListener("click", async () => {
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
    fd.append("effects", cb.value)
  );
  getBaseKeys().forEach(k => fd.append("base_effects", k));

  const windows = getEffectWindows();
  if (windows.length) fd.append("effect_windows", JSON.stringify(windows));

  fd.append("rotate_order", $("rotate_order").checked ? "1" : "0");
  return fd;
}

// =========================================================
// POLLING (single video)
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
// RESULT (single video)
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
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Server error (HTTP ${res.status}): ${text.slice(0, 300)}`); }
    if (data.errors) throw new Error(data.errors.map(e => e.message).join("; "));
    if (data.buffer_result?.message) throw new Error(data.buffer_result.message);
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
viewToggle.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

function setView(view) {
  currentView = view;
  viewToggle.querySelectorAll(".tab").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view));
  $("sideView").classList.toggle("active", view === "side");
  $("sliderView").classList.toggle("active", view === "slider");
  $("singleView").classList.toggle("active", view === "single");
  pauseAll();
}

function pauseAll() {
  [originalVideo, previewVideo, sliderOriginal, sliderRemix, singleVideo]
    .forEach(v => v && v.pause());
}

function wireSideBySideSync() {
  const sync = (src, dst) => {
    if (Math.abs(src.currentTime - dst.currentTime) > 0.2)
      dst.currentTime = src.currentTime;
  };
  originalVideo.ontimeupdate = () => {
    if (currentView !== "side" || originalVideo.paused) return;
    sync(originalVideo, previewVideo);
  };
  previewVideo.ontimeupdate = () => {
    if (currentView !== "side" || previewVideo.paused) return;
    sync(previewVideo, originalVideo);
  };
  originalVideo.onplay = () => previewVideo.play().catch(() => {});
  previewVideo.onplay  = () => originalVideo.play().catch(() => {});
  originalVideo.onpause = () => previewVideo.pause();
  previewVideo.onpause  = () => originalVideo.pause();
}

function wireSliderOverlay() {
  const setSplit = (pct) => {
    pct = Math.max(0, Math.min(100, pct));
    sliderTop.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    sliderHandle.style.left = pct + "%";
  };
  const getPct = (clientX) => {
    const rect = sliderContainer.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * 100;
  };
  sliderHandle.addEventListener("mousedown", (e) => { sliderDragging = true; e.preventDefault(); });
  sliderContainer.addEventListener("mousedown", (e) => { sliderDragging = true; setSplit(getPct(e.clientX)); });
  window.addEventListener("mousemove", (e) => { if (sliderDragging) setSplit(getPct(e.clientX)); });
  window.addEventListener("mouseup", () => sliderDragging = false);
  sliderHandle.addEventListener("touchstart", (e) => { sliderDragging = true; e.preventDefault(); }, { passive: false });
  sliderContainer.addEventListener("touchstart", (e) => { sliderDragging = true; setSplit(getPct(e.touches[0].clientX)); });
  window.addEventListener("touchmove", (e) => { if (sliderDragging) setSplit(getPct(e.touches[0].clientX)); }, { passive: false });
  window.addEventListener("touchend", () => sliderDragging = false);
  setSplit(50);
}

function wireSliderControls() {
  const play = () => {
    sliderOriginal.currentTime = sliderRemix.currentTime;
    sliderOriginal.play().catch(() => {});
    sliderRemix.play().catch(() => {});
    sliderPlayBtn.textContent = "⏸";
  };
  const pause = () => {
    sliderOriginal.pause();
    sliderRemix.pause();
    sliderPlayBtn.textContent = "▶";
  };
  sliderPlayBtn.onclick = () => { if (sliderRemix.paused) play(); else pause(); };

  sliderRemix.ontimeupdate = () => {
    if (sliderSyncing) return;
    sliderSyncing = true;
    if (Math.abs(sliderRemix.currentTime - sliderOriginal.currentTime) > 0.15)
      sliderOriginal.currentTime = sliderRemix.currentTime;
    updateSliderUI();
    sliderSyncing = false;
  };
  sliderOriginal.ontimeupdate = () => {
    if (sliderSyncing) return;
    sliderSyncing = true;
    if (Math.abs(sliderOriginal.currentTime - sliderRemix.currentTime) > 0.15)
      sliderRemix.currentTime = sliderOriginal.currentTime;
    sliderSyncing = false;
  };

  sliderRemix.onplay = () => { if (sliderOriginal.paused) sliderOriginal.play().catch(()=>{}); };
  sliderOriginal.onplay = () => { if (sliderRemix.paused) sliderRemix.play().catch(()=>{}); };
  sliderRemix.onpause = () => { if (!sliderOriginal.paused) sliderOriginal.pause(); };
  sliderOriginal.onpause = () => { if (!sliderRemix.paused) sliderRemix.pause(); };

  sliderScrub.addEventListener("input", () => {
    const t = (sliderScrub.value / 100) * sliderRemix.duration;
    if (isFinite(t)) {
      sliderRemix.currentTime = t;
      sliderOriginal.currentTime = t;
    }
  });
  sliderRemix.onloadedmetadata = () => updateSliderUI();
}

function updateSliderUI() {
  if (!sliderRemix.duration) return;
  const pct = (sliderRemix.currentTime / sliderRemix.duration) * 100;
  sliderScrub.value = pct;
  sliderTime.textContent =
    fmt(sliderRemix.currentTime) + " / " + fmt(sliderRemix.duration);
}
function fmt(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

// =========================================================
// AGAIN / RESET
// =========================================================
againBtn.addEventListener("click", () => remixBtn.click());

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
function hideError() {
  errorBox.classList.add("hidden");
}

// =========================================================
// CSV UPLOAD MANAGER
// =========================================================
(function() {
  const dropZone     = document.getElementById("csvDropZone");
  const fileInput    = document.getElementById("csvFileInput");
  const progressWrap = document.getElementById("csvUploadProgress");
  const progressFill = document.getElementById("csvProgressFill");
  const progressText = document.getElementById("csvProgressText");
  const resultEl     = document.getElementById("csvUploadResult");
  const fileListEl   = document.getElementById("csvFileList");
  const refreshBtn   = document.getElementById("csvRefreshBtn");
  const deleteAllBtn = document.getElementById("csvDeleteAllBtn");

  if (!dropZone || !fileInput) return;

  function setResult(msg, cls = "") {
    resultEl.textContent = msg;
    resultEl.className = "ai-status " + cls;
  }

  function setProgress(pct, msg) {
    progressWrap.classList.remove("hidden");
    progressFill.style.width = pct + "%";
    progressText.textContent = msg;
  }

  function hideProgress() {
    setTimeout(() => progressWrap.classList.add("hidden"), 1200);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function loadFileList() {
    try {
      const r = await fetch("/api/groups");
      const data = await r.json();
      if (!data.success) throw new Error(data.error || "Failed");

      if (!data.groups || !data.groups.length) {
        fileListEl.innerHTML = '<div style="color:var(--muted);font-size:0.8rem;grid-column:1/-1">No CSV files uploaded yet.</div>';
        return;
      }

      fileListEl.innerHTML = data.groups.map(g => `
        <div class="csv-file-item">
          <span class="name" title="${escapeHtml(g.name)}.csv">${escapeHtml(g.name)}.csv</span>
          <span class="count">${g.count}</span>
          <button type="button" class="del" data-name="${escapeHtml(g.name)}" title="Delete">✕</button>
        </div>
      `).join("");

      fileListEl.querySelectorAll(".del").forEach(btn => {
        btn.addEventListener("click", () => deleteFile(btn.dataset.name));
      });

      if (typeof window.refreshAiGroups === "function") {
        window.refreshAiGroups();
      }
    } catch (err) {
      fileListEl.innerHTML = `<div style="color:#fca5a5;font-size:0.8rem;grid-column:1/-1">Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return;

    const csvs = [...files].filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (!csvs.length) {
      setResult("No CSV files selected.", "error");
      return;
    }

    setResult(`📤 Uploading ${csvs.length} file(s)…`, "working");
    setProgress(5, `Preparing ${csvs.length} file(s)…`);

    const fd = new FormData();
    csvs.forEach(f => fd.append("files", f));

    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/upload_csv");

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 95);
            setProgress(pct, `Uploading… ${pct}%`);
          }
        };

        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(data);
            } else {
              reject(new Error(data.error || `HTTP ${xhr.status}`));
            }
          } catch (e) {
            reject(new Error(`Invalid response: ${xhr.responseText.slice(0, 200)}`));
          }
        };

        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(fd);
      });

      setProgress(100, "✅ Upload complete");
      hideProgress();

      const okCount = (result.uploaded || []).length;
      const failCount = (result.failed || []).length;

      if (failCount > 0) {
        setResult(`✅ Uploaded ${okCount} · ❌ ${failCount} failed`, "error");
        console.warn("Failed uploads:", result.failed);
      } else {
        setResult(`✅ Uploaded ${okCount} file(s) successfully.`, "ok");
      }

      await loadFileList();
    } catch (err) {
      hideProgress();
      setResult(`❌ Upload failed: ${err.message}`, "error");
    }
  }

  async function deleteFile(name) {
    if (!confirm(`Delete ${name}.csv from the server?`)) return;
    try {
      const r = await fetch(`/api/delete_csv/${encodeURIComponent(name)}`, { method: "POST" });
      const data = await r.json();
      if (!data.success) throw new Error(data.error || "Delete failed");
      setResult(`🗑️ Deleted ${name}.csv`, "ok");
      await loadFileList();
    } catch (err) {
      setResult(`❌ ${err.message}`, "error");
    }
  }

  async function deleteAll() {
    if (!confirm("Delete ALL CSV files from groups-metadata/? This cannot be undone.")) return;
    try {
      const r = await fetch("/api/groups");
      const data = await r.json();
      if (!data.success) throw new Error(data.error || "Failed");

      let deleted = 0;
      for (const g of data.groups) {
        const dr = await fetch(`/api/delete_csv/${encodeURIComponent(g.name)}`, { method: "POST" });
        const dd = await dr.json();
        if (dd.success) deleted++;
      }
      setResult(`🗑️ Deleted ${deleted} file(s)`, "ok");
      await loadFileList();
    } catch (err) {
      setResult(`❌ ${err.message}`, "error");
    }
  }

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) uploadFiles(e.target.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach(ev =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach(ev =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); })
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files && files.length) uploadFiles(files);
  });

  refreshBtn?.addEventListener("click", () => {
    setResult("🔄 Refreshing…", "");
    loadFileList();
  });
  deleteAllBtn?.addEventListener("click", deleteAll);

  loadFileList();
})();

// =========================================================
// AI ONE-BY-ONE PROCESSING
// =========================================================
(function() {
  const groupSelect    = document.getElementById("aiGroupSelect");
  const loadGroupBtn   = document.getElementById("aiLoadGroupBtn");
  const refreshBtn     = document.getElementById("aiRefreshGroups");
  const rawInput       = document.getElementById("aiRawInput");
  const parseBtn       = document.getElementById("aiParseBtn");
  const processOneBtn  = document.getElementById("aiProcessOneBtn");
  const processSelBtn  = document.getElementById("aiProcessSelectedBtn");
  const skipBtn        = document.getElementById("aiSkipBtn");
  const clearBtn       = document.getElementById("aiClearBtn");
  const statusEl       = document.getElementById("aiStatus");
  const statsEl        = document.getElementById("aiStats");
  const queueEl        = document.getElementById("aiQueue");

  const progressPanel  = document.getElementById("aiProgressPanel");
  const currentTitleEl = document.getElementById("aiCurrentTitle");
  const currentProgEl  = document.getElementById("aiCurrentProgress");
  const currentStatusEl= document.getElementById("aiCurrentStatus");
  const stepsEl        = document.getElementById("aiSteps");

  if (!queueEl) return;

  let queue = [];
  let selectedIdx = 0;
  let isProcessing = false;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setStatus(msg, cls = "") {
    statusEl.textContent = msg;
    statusEl.className = "ai-status " + cls;
  }

  function setCurrentProgress(pct, msg) {
    currentProgEl.style.width = pct + "%";
    if (msg) currentStatusEl.textContent = msg;
  }

  function setStep(step, state) {
    stepsEl.querySelectorAll(".ai-step").forEach(el => {
      if (el.dataset.step === step) {
        el.classList.remove("active", "done", "error");
        if (state) el.classList.add(state);
      }
    });
  }

  function resetSteps() {
    stepsEl.querySelectorAll(".ai-step").forEach(el => {
      el.classList.remove("active", "done", "error");
    });
    currentProgEl.style.width = "0%";
    currentStatusEl.textContent = "";
  }

  function showProgressPanel(item) {
    progressPanel.classList.remove("hidden");
    const t = (item.rawTitle || item.url || "").slice(0, 60);
    currentTitleEl.textContent = t + ((item.rawTitle || "").length > 60 ? "…" : "");
    resetSteps();
  }

  function hideProgressPanel() {
    progressPanel.classList.add("hidden");
  }

  // ---------- GROUPS ----------
  async function refreshGroups() {
    try {
      const r = await fetch("/api/groups");
      const data = await r.json();
      if (!data.success) throw new Error(data.error || "Failed");

      if (!data.groups || !data.groups.length) {
        groupSelect.innerHTML = '<option value="">— No CSVs found —</option>';
        return;
      }

      groupSelect.innerHTML = '<option value="">— Select a group —</option>' +
        data.groups.map(g =>
          `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)} (${g.count} items)</option>`
        ).join("");
      setStatus(`📚 Found ${data.groups.length} group(s)`, "ok");
    } catch (err) {
      groupSelect.innerHTML = '<option value="">— Error loading —</option>';
      setStatus(`⚠️ ${err.message}`, "error");
    }
  }

  async function loadGroup(name) {
    if (!name) { setStatus("Select a group first.", "error"); return; }
    setStatus(`📥 Loading ${name}…`, "working");

    try {
      const r = await fetch(`/api/groups/${encodeURIComponent(name)}`);
      const data = await r.json();
      if (!data.success) throw new Error(data.error || "Failed");

      const newItems = data.items.map(it => ({
        id: it.id || Math.random().toString(36).slice(2, 10),
        url: it.url,
        group: name,
        rawTitle: it.title || "",
        rawDescription: it.description || "",
        aiTitle: "", aiCaption: "", aiDescription: "", aiHashtags: "",
        status: "pending", error: null, jobId: null, remixUrl: null, publishError: null,
      }));

      queue = queue.concat(newItems);

      const firstPending = queue.findIndex(i => i.status === "pending");
      if (firstPending !== -1) selectedIdx = firstPending;

      renderQueue();
      setStatus(`📥 Loaded ${newItems.length} item(s) from ${name}`, "ok");
    } catch (err) {
      setStatus(`❌ ${err.message}`, "error");
    }
  }

  function parseGroups(text) {
    const lines = text.split(/\r?\n/);
    const items = [];
    let currentGroup = "manual";
    let buffer = [];

    function flushBuffer() {
      const cleaned = buffer.map(l => l.trim()).filter(Boolean);
      if (cleaned.length >= 2) {
        const url = cleaned[0];
        const title = cleaned[1];
        const description = cleaned.slice(2).join(" ");
        if (/^https?:\/\//i.test(url)) {
          items.push({
            id: Math.random().toString(36).slice(2, 10),
            url, group: currentGroup,
            rawTitle: title, rawDescription: description,
            aiTitle: "", aiCaption: "", aiDescription: "", aiHashtags: "",
            status: "pending", error: null, jobId: null, remixUrl: null, publishError: null,
          });
        }
      }
      buffer = [];
    }

    for (const line of lines) {
      const trimmed = line.trim();
      const gm = trimmed.match(/^###\s*GROUP\s*:\s*(.+)$/i);
      if (gm) { flushBuffer(); currentGroup = gm[1].trim(); continue; }
      if (!trimmed) { flushBuffer(); continue; }
      buffer.push(trimmed);
    }
    flushBuffer();
    return items;
  }

  // ---------- RENDER ----------
  function renderQueue() {
    if (!queue.length) {
      queueEl.innerHTML = '<div style="color:var(--muted);font-size:0.8rem">Queue empty — load a group or paste manually.</div>';
      statsEl.innerHTML = "";
      return;
    }

    const counts = {
      pending: queue.filter(i => i.status === "pending").length,
      done: queue.filter(i => i.status === "done").length,
      error: queue.filter(i => i.status === "error").length,
      remixed: queue.filter(i => i.status === "remixed").length,
      published: queue.filter(i => i.status === "published").length,
    };
    statsEl.innerHTML = `
      <div class="stat"><strong>${queue.length}</strong>Total</div>
      <div class="stat"><strong>${counts.pending}</strong>Pending</div>
      <div class="stat"><strong>${counts.done}</strong>AI Done</div>
      <div class="stat"><strong>${counts.remixed}</strong>Remixed</div>
      <div class="stat"><strong>${counts.published}</strong>Published</div>
      <div class="stat"><strong>${counts.error}</strong>Errors</div>
    `;

    queueEl.innerHTML = queue.map((item, idx) =>
      renderItem(item, idx, idx === selectedIdx)
    ).join("");

    queueEl.querySelectorAll(".select-ai-item").forEach(el => {
      el.addEventListener("click", () => {
        if (isProcessing) return;
        selectedIdx = +el.dataset.idx;
        renderQueue();
      });
    });
    queueEl.querySelectorAll(".remove-ai-item").forEach(b => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isProcessing) return;
        queue.splice(+b.dataset.idx, 1);
        if (selectedIdx >= queue.length) selectedIdx = Math.max(0, queue.length - 1);
        renderQueue();
      });
    });
    queueEl.querySelectorAll(".process-one").forEach(b => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isProcessing) return;
        selectedIdx = +b.dataset.idx;
        renderQueue();
        processSelected();
      });
    });
    queueEl.querySelectorAll(".retry-one").forEach(b => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isProcessing) return;
        const item = queue[+b.dataset.idx];
        if (item) {
          item.status = "pending";
          item.error = null;
          item.publishError = null;
          renderQueue();
        }
      });
    });
  }

  function renderItem(item, idx, isCurrent) {
    const labels = {
      pending: "⏳ Pending",
      processing: "🤖 AI…",
      done: "✅ AI Ready",
      error: "❌ Error",
      remixing: "🎬 Remixing",
      remixed: "✅ Remixed",
      publishing: "📤 Publishing",
      published: "🚀 Published",
    };

    let body = "";

    if (!item.aiTitle) {
      body += `
        <div class="ai-title">${escapeHtml(item.rawTitle || "(no title)")}</div>
        <div class="ai-desc">${escapeHtml((item.rawDescription || "").slice(0, 180))}${(item.rawDescription || "").length > 180 ? "…" : ""}</div>
      `;
    }

    if (item.status === "processing") {
      body += `<div class="ai-result loading">🤖 Generating with Gemini…</div>`;
    } else if (item.aiTitle) {
      body += `<div class="ai-result">
<strong>📌 TITLE</strong>
${escapeHtml(item.aiTitle)}

<strong>💬 CAPTION</strong>
${escapeHtml(item.aiCaption)}

<strong>📝 DESCRIPTION</strong>
${escapeHtml(item.aiDescription)}

<strong>#️⃣ HASHTAGS</strong>
${escapeHtml(item.aiHashtags)}</div>`;
    }
    if (item.status === "error" && item.error) {
      body += `<div class="ai-result error">❌ ${escapeHtml(item.error)}</div>`;
    }
    if (item.status === "remixing") {
      body += `<div class="ai-result loading">🎬 Remixing… <span id="prog_${item.id}">0%</span></div>`;
    }
    if (item.remixUrl) {
      body += `<div class="ai-result">🎬 Remixed: <a href="${escapeHtml(item.remixUrl)}" target="_blank" style="color:var(--accent-2)">view</a></div>`;
    }
    if (item.publishError) {
      body += `<div class="ai-result error">📤 ${escapeHtml(item.publishError)}</div>`;
    }

    const canProcess = (item.status === "pending" || item.status === "error" || item.status === "done") && !isProcessing;
    const isFailed = item.status === "error";

    return `
      <div class="ai-item status-${item.status} ${isCurrent ? "current" : ""}" data-idx="${idx}">
        <div class="ai-row select-ai-item" data-idx="${idx}" style="cursor:pointer">
          <span class="ai-group">${escapeHtml(item.group)} · #${idx + 1}</span>
          <span class="ai-status-badge">${labels[item.status] || item.status}</span>
          <button type="button" class="mini-btn remove-ai-item" data-idx="${idx}">✕</button>
        </div>
        <div class="ai-url">${escapeHtml(item.url)}</div>
        ${body}
        <div class="ai-nav-row">
          ${canProcess ? `
            <button type="button" class="mini-btn process-one process-btn" data-idx="${idx}">
              ▶️ Process this
            </button>
          ` : ""}
          ${isFailed ? `
            <button type="button" class="mini-btn retry-one" data-idx="${idx}">
              🔄 Reset
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }

  // ---------- ONE-BY-ONE PIPELINE ----------
  async function processSelected() {
    if (isProcessing) { setStatus("Already processing…", "error"); return; }
    const item = queue[selectedIdx];
    if (!item) { setStatus("No item selected.", "error"); return; }

    isProcessing = true;
    showProgressPanel(item);

    try {
      // ---- STEP 1: AI REFORM ----
      if (!item.aiTitle) {
        setStep("ai", "active");
        setCurrentProgress(10, "🤖 Generating AI content…");
        item.status = "processing";
        renderQueue();

        try {
          const r = await fetch("/api/ai/reformat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: item.rawTitle,
              description: item.rawDescription,
            }),
          });
          const data = await r.json();
          if (!r.ok || !data.success) throw new Error(data.error || "AI failed");

          item.aiTitle = data.parsed.title || "";
          item.aiCaption = data.parsed.caption || "";
          item.aiDescription = data.parsed.description || "";
          item.aiHashtags = data.parsed.hashtags || "";
          item.status = "done";
          setStep("ai", "done");
          setCurrentProgress(25, "✅ AI reform done");
        } catch (err) {
          setStep("ai", "error");
          throw new Error(`AI: ${err.message}`);
        }
      } else {
        setStep("ai", "done");
        setCurrentProgress(25, "✅ AI already done");
      }

      // ---- STEP 2: FETCH ----
      setStep("fetch", "active");
      setCurrentProgress(30, "📥 Fetching video…");
      item.status = "remixing";
      renderQueue();

      let fetchData;
      try {
        const fd = new FormData();
        fd.append("video_url", item.url);
        const r = await fetch("/fetch_url", { method: "POST", body: fd });
        fetchData = await r.json();
        if (!r.ok) throw new Error(fetchData.error || "Fetch failed");
        setStep("fetch", "done");
        setCurrentProgress(45, "✅ Video fetched");
      } catch (err) {
        setStep("fetch", "error");
        throw new Error(`Fetch: ${err.message}`);
      }

      // ---- STEP 3: REMIX ----
      setStep("remix", "active");
      setCurrentProgress(50, "🎬 Starting remix…");

      let remixData;
      try {
        const fd2 = new FormData();
        fd2.append("segment_duration", "3");
        fd2.append("effects_per_segment", "3");
        fd2.append("quality_preset", "high");
        fd2.append("preserve_audio", "1");
        fd2.append("rotate_order", "1");

        const r = await fetch(`/remix/${fetchData.token}`, { method: "POST", body: fd2 });
        remixData = await r.json();
        if (!r.ok) throw new Error(remixData.error || "Remix failed");
      } catch (err) {
        setStep("remix", "error");
        throw new Error(`Remix: ${err.message}`);
      }

      item.jobId = remixData.job_id;

      let remixDone = false;
      let attempts = 0;
      while (!remixDone && attempts < 400) {
        await new Promise(r => setTimeout(r, 1500));
        const sr = await fetch(`/status/${item.jobId}`);
        const sd = await sr.json();

        const remixPct = 50 + Math.round((sd.progress || 0) * 0.3);
        setCurrentProgress(remixPct, `🎬 Remixing… ${sd.progress || 0}%`);

        const progEl = document.getElementById(`prog_${item.id}`);
        if (progEl) progEl.textContent = `${sd.progress || 0}%`;

        if (sd.status === "done") {
          remixDone = true;
          item.remixUrl = sd.preview_url;
          setStep("remix", "done");
        } else if (sd.status === "error") {
          setStep("remix", "error");
          throw new Error(`Remix: ${sd.message || "Unknown error"}`);
        }
        attempts++;
      }

      if (!remixDone) throw new Error("Remix timeout");

      // ---- STEP 4: PUBLISH ----
      setStep("publish", "active");
      setCurrentProgress(85, "📤 Publishing to YouTube…");

      try {
        const r = await fetch(`/publish_to_youtube/${item.jobId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: item.aiTitle || item.rawTitle,
            caption: item.aiCaption || item.rawDescription,
          }),
        });
        const data = await r.json();

        if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);

        item.status = "published";
        setStep("publish", "done");
        setCurrentProgress(100, "🚀 Published to YouTube!");
        setStatus(`✅ Item #${selectedIdx + 1} complete and published!`, "ok");
      } catch (err) {
        setStep("publish", "error");
        item.status = "remixed";
        item.publishError = err.message;
        setCurrentProgress(100, `⚠️ Remix OK but publish failed: ${err.message}`);
        setStatus(`⚠️ Item #${selectedIdx + 1}: remixed but publish failed`, "error");
      }

      renderQueue();

      const nextIdx = queue.findIndex((i, ix) =>
        ix > selectedIdx && (i.status === "pending" || i.status === "error"));
      if (nextIdx !== -1) {
        setTimeout(() => {
          selectedIdx = nextIdx;
          renderQueue();
          setStatus(`⏭️ Next: item #${nextIdx + 1}. Click ▶️ Process Next to continue.`, "ok");
        }, 2000);
      } else {
        setStatus(`🏁 All items processed!`, "ok");
      }

    } catch (err) {
      setStatus(`❌ ${err.message}`, "error");
      if (queue[selectedIdx]) {
        queue[selectedIdx].status = "error";
        queue[selectedIdx].error = err.message;
        renderQueue();
      }
    } finally {
      isProcessing = false;
      setTimeout(() => hideProgressPanel(), 6000);
    }
  }

  async function processAllSequentially() {
    if (isProcessing) { setStatus("Already processing…", "error"); return; }
    const pendingList = queue.map((item, idx) => ({ item, idx }))
                            .filter(x => x.item.status === "pending" || x.item.status === "error");
    if (!pendingList.length) { setStatus("No pending items.", "error"); return; }
    if (!confirm(`Process ${pendingList.length} item(s) sequentially?\nEach takes ~1-2 minutes.`)) return;

    for (const { idx } of pendingList) {
      selectedIdx = idx;
      renderQueue();
      await processSelected();
      await new Promise(r => setTimeout(r, 3000));
    }
    setStatus("🏁 Sequential processing complete!", "ok");
  }

  async function skipCurrent() {
    if (isProcessing) { setStatus("Cannot skip while processing.", "error"); return; }
    const next = queue.findIndex((i, ix) =>
      ix > selectedIdx && (i.status === "pending" || i.status === "error"));
    if (next === -1) { setStatus("No more items to skip to.", "error"); return; }
    selectedIdx = next;
    renderQueue();
    setStatus(`⏭️ Skipped to item #${next + 1}`, "ok");
  }

  // ---------- WIRE BUTTONS ----------
  refreshBtn?.addEventListener("click", refreshGroups);
  loadGroupBtn?.addEventListener("click", () => loadGroup(groupSelect.value));

  parseBtn?.addEventListener("click", () => {
    const text = (rawInput.value || "").trim();
    if (!text) { setStatus("Paste text first.", "error"); return; }
    const items = parseGroups(text);
    if (!items.length) { setStatus("No valid items found.", "error"); return; }
    queue = queue.concat(items);
    rawInput.value = "";
    renderQueue();
    setStatus(`📥 Added ${items.length} item(s).`, "ok");
  });

  processOneBtn?.addEventListener("click", () => {
    let idx = selectedIdx;
    if (!queue[idx] || queue[idx].status === "published") {
      idx = queue.findIndex(i => i.status === "pending" || i.status === "error");
    }
    if (idx === -1) { setStatus("No pending items to process.", "error"); return; }
    selectedIdx = idx;
    renderQueue();
    processSelected();
  });

  processSelBtn?.addEventListener("click", processAllSequentially);
  skipBtn?.addEventListener("click", skipCurrent);
  clearBtn?.addEventListener("click", () => {
    if (isProcessing) { setStatus("Cannot clear while processing.", "error"); return; }
    if (!queue.length) return;
    if (!confirm("Clear the entire queue?")) return;
    queue = [];
    selectedIdx = 0;
    renderQueue();
    setStatus("Queue cleared.", "");
  });

  window.refreshAiGroups = refreshGroups;
  refreshGroups();
})();

// =========================================================
// GEMINI API KEY SETTINGS
// =========================================================
(function() {
  const input       = document.getElementById("setGeminiKey");
  const saveBtn     = document.getElementById("saveGeminiBtn");
  const testBtn     = document.getElementById("testGeminiBtn");
  const clearBtn    = document.getElementById("clearGeminiBtn");
  const statusEl    = document.getElementById("geminiSettingsStatus");
  const keyStatus   = document.getElementById("geminiKeyStatus");

  if (!input || !saveBtn) return;

  function setStatus(msg, cls = "") {
    statusEl.textContent = msg;
    statusEl.className = "ai-status " + cls;
  }

  function updateKeyStatus(data) {
    if (!keyStatus) return;
    keyStatus.className = "key-status";
    if (data.set) {
      keyStatus.textContent = data.source === "env" ? "ENV" : "SET";
      keyStatus.classList.add(data.source === "env" ? "env" : "set");
      keyStatus.title = `Masked: ${data.masked}`;
    } else {
      keyStatus.textContent = "NOT SET";
      keyStatus.classList.add("not-set");
      keyStatus.title = "";
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch("/api/settings");
      const data = await r.json();
      if (data.success) {
        updateKeyStatus(data.settings.GEMINI_API_KEY || { set: false });
      }
    } catch (err) {
      console.warn("Could not load settings:", err);
    }
  }

  async function saveKey(value) {
    setStatus("💾 Saving…", "working");
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ GEMINI_API_KEY: value }),
      });
      const data = await r.json();
      if (!data.success) throw new Error(data.error || "Save failed");

      setStatus("✅ Saved. Testing key…", "ok");
      input.value = "";
      await loadStatus();
      await testKey();
    } catch (err) {
      setStatus("❌ " + err.message, "error");
    }
  }

  async function testKey() {
    setStatus("🧪 Testing key…", "working");
    try {
      const r = await fetch("/api/settings/test", { method: "POST" });
      const data = await r.json();
      if (data.success && data.results?.ai?.ok) {
        setStatus("✅ Key works! " + (data.results.ai.message || ""), "ok");
      } else {
        const msg = data.results?.ai?.message || data.error || "Test failed";
        setStatus("❌ " + msg, "error");
      }
    } catch (err) {
      setStatus("❌ " + err.message, "error");
    }
  }

  saveBtn?.addEventListener("click", () => {
    const v = (input.value || "").trim();
    if (!v) { setStatus("Paste a key first.", "error"); return; }
    if (!v.startsWith("AIza")) {
      if (!confirm("This doesn't look like a Gemini key (usually starts with 'AIza'). Save anyway?")) return;
    }
    saveKey(v);
  });

  testBtn?.addEventListener("click", testKey);

  clearBtn?.addEventListener("click", async () => {
    if (!confirm("Clear the saved Gemini API key?")) return;
    setStatus("🗑️ Clearing…", "working");
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ GEMINI_API_KEY: "" }),
      });
      const data = await r.json();
      if (!data.success) throw new Error(data.error || "Clear failed");
      input.value = "";
      await loadStatus();
      setStatus("✅ Key cleared.", "ok");
    } catch (err) {
      setStatus("❌ " + err.message, "error");
    }
  });

  loadStatus();
})();

// =========================================================
// INIT
// =========================================================
document.addEventListener("DOMContentLoaded", () => {
  refreshTimelinePreview();
});