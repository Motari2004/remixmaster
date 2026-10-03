// =========================================================
// STATE
// =========================================================
let selectedFile = null;
let currentJobId = null;
let pollTimer = null;
let originalUrl = null;
let currentView = "side";
let sliderDragging = false;
let sliderSyncing = false;
let currentVideoDuration = 0;
let stagedToken = null;

// Populated by index.html via `window.EFFECT_LABELS` (only used by Vercel-style static builds)
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

  const segLen = parseFloat($("segment_duration")?.value) || 2;
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
// ORDERED LISTS
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

  originalVideo.src = originalUrl;
  sliderOriginal.src = originalUrl;
  singleVideo.src = originalUrl;
  setView("single");
}

// =========================================================
// FETCH FROM URL
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

      stagedToken = data.token;
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
// REMIX
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
        showResult(data.preview_url, data.download_url);
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
// RESULT — includes Publish to YouTube button
// =========================================================
function showResult(previewUrl, downloadUrl) {
  setProgress(100, "✅ Done!");
  setTimeout(() => progressWrap.classList.add("hidden"), 900);

  compareArea.classList.remove("hidden");
  viewToggle.classList.remove("hidden");

  previewVideo.src = previewUrl;
  sliderRemix.src = previewUrl;
  singleVideo.src = previewUrl;

  if (originalUrl) {
    originalVideo.src = originalUrl;
    sliderOriginal.src = originalUrl;
  }

  setView("side");
  wireSideBySideSync();
  wireSliderOverlay();
  wireSliderControls();

  downloadBtn.href = downloadUrl;
  resultActions.classList.remove("hidden");

  // ---- Add Publish to YouTube button (idempotent) ----
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
  const defaultTitle = "My Remix Short";
  const title = prompt("YouTube title:", defaultTitle);
  if (!title) return;

  const description = prompt("Description (optional):", title) || title;

  publishBtn.disabled = true;
  const originalText = publishBtn.textContent;
  publishBtn.textContent = "⏳ Publishing…";

  try {
    const res = await fetch(`/publish_to_youtube/${currentJobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, caption: description }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Publish failed");

    alert("✅ Added to Buffer queue for YouTube!\n\nCheck your Buffer dashboard to confirm the scheduled time.");
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

// =========================================================
// SIDE-BY-SIDE SYNC
// =========================================================
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

// =========================================================
// SLIDER OVERLAY
// =========================================================
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

// =========================================================
// SLIDER MODE CONTROLS
// =========================================================
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
// INIT
// =========================================================
document.addEventListener("DOMContentLoaded", () => {
  refreshTimelinePreview();
});