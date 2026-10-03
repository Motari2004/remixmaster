"""
🎬 Remix Engine — Motion-Flow Remix Master (crash-proof + ordered + windowed + HQ)

Walks the video timeline IN ORDER (no random jumps), applies named
effects to consecutive chunks, so the motion flow is preserved.

Quality:
  - Preserves SOURCE resolution (no forced downscale).
  - Uses CRF-based encoding with quality presets (fast → lossless).
  - 320k AAC audio + +faststart for web playback.

Control layers:
  1. base_effects:     applied ONCE to the whole video (persistent).
  2. ordered_effects:  simple ordered list — fires on every chunk.
  3. effect_windows:   per-effect segment windows — each effect only
                       fires within its [from, to] range (1-based).
  4. Random mode:      falls back to random sampling from the pool.

Isolation:
  - Per-segment effects applied to a FRESH COPY of each subclip
    (seg.copy()), so they never bleed into the next segment.
  - base_effects deduplicated out of ordered_effects / effect_windows.

Safety:
  - Safe margin so we never ask for a frame at/past clip.duration.
  - Rounds all timestamps to 3 decimals to avoid float drift.
  - Re-clamps duration after duration-changing effects (speedx).
  - Uses method="chain" for concatenation.
  - Clamps audio to final video length.
  - safe_subclip() wrapper as a final safety net.

Crop:
  crop_left  / crop_right  -> swapped on purpose (labels preserved).
  crop_top   / crop_bottom -> labels match behavior.
  Default crop_top_pct / crop_bottom_pct = 0.95 (gentle 5% trim).
"""

import os
import random
import uuid
import numpy as np
from moviepy.editor import VideoFileClip, vfx, concatenate_videoclips
from moviepy.video.fx.all import (
    crop as vfx_crop,
    resize,
    rotate,
    colorx,
    speedx,
)


# =========================================================
# QUALITY PRESETS
# =========================================================
QUALITY_MAP = {
    "fast":     {"preset": "fast",   "crf": "20"},
    "medium":   {"preset": "medium", "crf": "18"},
    "high":     {"preset": "slow",   "crf": "16"},
    "max":      {"preset": "slow",   "crf": "14"},
    "lossless": {"preset": "slow",   "crf": "0"},
}


# =========================================================
# FLIP
# =========================================================
def flip_horizontal(clip, **kw):
    return clip.fx(vfx.mirror_x)


def flip_vertical(clip, **kw):
    return clip.fx(vfx.mirror_y)


# =========================================================
# CROP
# _crop_region(clip, x_pct, y_pct, w_pct, h_pct)
#   x_pct = LEFT edge of crop, as fraction of frame width
#   y_pct = TOP edge of crop,  as fraction of frame height
#   w_pct = crop width,  as fraction of frame width
#   h_pct = crop height, as fraction of frame height
# =========================================================
def _crop_region(clip, x_pct, y_pct, w_pct, h_pct):
    w, h = clip.size
    cw, ch = int(w * w_pct), int(h * h_pct)
    x1 = max(0, min(int(w * x_pct), w - cw))
    y1 = max(0, min(int(h * y_pct), h - ch))
    return clip.fx(vfx_crop, x1=x1, y1=y1, x2=x1 + cw, y2=y1 + ch)


def crop_center(clip, **kw):
    return _crop_region(clip, 0.15, 0.15, 0.70, 0.70)


def crop_left(clip, **kw):
    """UI says 'Crop Left' — actually keeps the RIGHT region."""
    return _crop_region(clip, 0.35, 0.10, 0.65, 0.80)


def crop_right(clip, **kw):
    """UI says 'Crop Right' — actually keeps the LEFT region."""
    return _crop_region(clip, 0.00, 0.10, 0.65, 0.80)


def crop_top(clip, crop_top_pct=0.95, **kw):
    """UI says 'Crop Top' — actually keeps the BOTTOM slice (default 95%)."""
    h_pct = max(0.10, min(1.00, float(crop_top_pct)))
    y_pct = 1.0 - h_pct
    return _crop_region(clip, 0.10, y_pct, 0.80, h_pct)


def crop_bottom(clip, crop_bottom_pct=0.95, **kw):
    """UI says 'Crop Bottom' — actually keeps the TOP slice (default 95%)."""
    h_pct = max(0.10, min(1.00, float(crop_bottom_pct)))
    return _crop_region(clip, 0.10, 0.00, 0.80, h_pct)


# =========================================================
# SPEED
# =========================================================
def speed_slowmo_08(clip, **kw):  return clip.fx(speedx, 0.8)
def speed_fast_12(clip, **kw):    return clip.fx(speedx, 1.2)
def speed_hyper_15(clip, **kw):   return clip.fx(speedx, 1.5)


# =========================================================
# ZOOM
# =========================================================
def _zoom_to_size(clip, factor):
    new_clip = clip.fx(resize, factor)
    w, h = clip.size
    nw, nh = new_clip.size
    x1, y1 = (nw - w) // 2, (nh - h) // 2
    if x1 < 0 or y1 < 0:
        return new_clip.fx(resize, (w, h))
    return new_clip.fx(vfx_crop, x1=x1, y1=y1, x2=x1 + w, y2=y1 + h)


def zoom_in(clip, **kw):
    return _zoom_to_size(clip, 1.35)


def zoom_out(clip, **kw):
    return _zoom_to_size(clip, 0.75)


def zoom_shake(clip, **kw):
    from moviepy.editor import VideoClip
    w, h = clip.size
    crop_pct = 0.85
    cw, ch = int(w * crop_pct), int(h * crop_pct)
    dur = clip.duration

    def shake(t):
        t_safe = min(max(0.0, t), dur - 1e-3)
        jitter = 0.03 * w
        dx = random.uniform(-jitter, jitter)
        dy = random.uniform(-jitter, jitter)
        x1 = int(max(0, min(w - cw, (w - cw) / 2 + dx)))
        y1 = int(max(0, min(h - ch, (h - ch) / 2 + dy)))
        return clip.crop(x1=x1, y1=y1, x2=x1 + cw, y2=y1 + ch).get_frame(t_safe)

    return VideoClip(shake, duration=dur).resize((w, h))


# =========================================================
# COLOR
# =========================================================
def color_warmer(clip, **kw):
    def tint(img):
        out = img.astype("float32")
        out[..., 0] *= 1.15
        out[..., 1] *= 1.05
        out[..., 2] *= 0.85
        return out.clip(0, 255).astype("uint8")
    return clip.fl_image(tint)


def color_colder(clip, **kw):
    def tint(img):
        out = img.astype("float32")
        out[..., 0] *= 0.85
        out[..., 1] *= 1.00
        out[..., 2] *= 1.20
        return out.clip(0, 255).astype("uint8")
    return clip.fl_image(tint)


def color_bw(clip, **kw):
    return clip.fx(vfx.blackwhite)


def color_high_contrast(clip, **kw):
    def contrast(img):
        out = img.astype("float32")
        out = (out - 128) * 1.6 + 128
        return out.clip(0, 255).astype("uint8")
    return clip.fl_image(contrast)


def color_cyber_neon(clip, **kw):
    def neon(img):
        out = img.astype("float32")
        out[..., 0] = out[..., 0] * 1.10 + 15
        out[..., 2] = out[..., 2] * 1.20 + 20
        out[..., 1] = out[..., 1] * 0.90
        return out.clip(0, 255).astype("uint8")
    return clip.fl_image(neon)


# =========================================================
# BLUR
# =========================================================
def blur_light(clip, **kw):   return clip.fx(vfx.blur, 1)
def blur_heavy(clip, **kw):   return clip.fx(vfx.blur, 4)


def blur_background(clip, **kw):
    from moviepy.editor import CompositeVideoClip
    w, h = clip.size
    blurred = clip.fx(vfx.blur, 6)
    inner_w, inner_h = int(w * 0.6), int(h * 0.6)
    x1, y1 = (w - inner_w) // 2, (h - inner_h) // 2
    sharp = clip.fx(vfx_crop, x1=x1, y1=y1, x2=x1 + inner_w, y2=y1 + inner_h)
    sharp = sharp.set_position(("center", "center"))
    return CompositeVideoClip([blurred, sharp], size=(w, h)).set_duration(clip.duration)


# =========================================================
# ROTATE
# =========================================================
def rotate_left_1(clip, **kw):   return clip.fx(rotate, 1)
def rotate_right_1(clip, **kw):  return clip.fx(rotate, -1)


# =========================================================
# REGISTRY
# =========================================================
EFFECTS = {
    # Flip
    "flip_horizontal":  ("Flip Horizontal",   "Flip",   flip_horizontal),
    "flip_vertical":    ("Flip Vertical",     "Flip",   flip_vertical),

    # Crop
    "crop_center":      ("Crop Center",       "Crop",   crop_center),
    "crop_left":        ("Crop Left",         "Crop",   crop_left),
    "crop_right":       ("Crop Right",        "Crop",   crop_right),
    "crop_top":         ("Crop Top",          "Crop",   crop_top),
    "crop_bottom":      ("Crop Bottom",       "Crop",   crop_bottom),

    # Speed
    "speed_slowmo_08":  ("Slow-Mo 0.8x",      "Speed",  speed_slowmo_08),
    "speed_fast_12":    ("Fast 1.2x",         "Speed",  speed_fast_12),
    "speed_hyper_15":   ("Hyper 1.5x",        "Speed",  speed_hyper_15),

    # Zoom
    "zoom_in":          ("Zoom In",           "Zoom",   zoom_in),
    "zoom_out":         ("Zoom Out",          "Zoom",   zoom_out),
    "zoom_shake":       ("Shake Zoom",        "Zoom",   zoom_shake),

    # Color
    "color_warmer":     ("Warmer",            "Color",  color_warmer),
    "color_colder":     ("Colder",            "Color",  color_colder),
    "color_bw":         ("Black & White",     "Color",  color_bw),
    "color_contrast":   ("High Contrast",     "Color",  color_high_contrast),
    "color_cyber_neon": ("Cyber Neon",        "Color",  color_cyber_neon),

    # Blur
    "blur_light":       ("Light Blur",        "Blur",   blur_light),
    "blur_heavy":       ("Heavy Blur",        "Blur",   blur_heavy),
    "blur_background":  ("Background Blur",   "Blur",   blur_background),

    # Rotate
    "rotate_left_1":    ("Rotate Left 1°",    "Rotate", rotate_left_1),
    "rotate_right_1":   ("Rotate Right 1°",   "Rotate", rotate_right_1),
}


CATEGORY_ORDER = {
    "Flip":   1,
    "Rotate": 2,
    "Crop":   3,
    "Zoom":   4,
    "Speed":  5,
    "Color":  6,
    "Blur":   7,
}


def grouped_effects():
    groups = {}
    for key, (label, cat, _) in EFFECTS.items():
        groups.setdefault(cat, []).append({"key": key, "label": label})
    return groups


# =========================================================
# ORDERED EFFECT PLANNING (with optional windows)
# =========================================================
def plan_effects(
    per_segment_order=None,
    rotate_order=True,
    pool=None,
    effects_per_segment=3,
    num_chunks=1,
):
    """
    Supports two forms of `per_segment_order`:
      1) Simple list: ["zoom_in", "crop_left"]
      2) Windowed list:
         [{"key": "zoom_in", "from": 1, "to": 3}, ...]
    Segment indices are 1-based. `to` of None = last segment.
    """
    per_chunk = []

    for i in range(num_chunks):
        seg_num = i + 1

        if per_segment_order:
            first = per_segment_order[0]
            windowed = isinstance(first, dict)

            if windowed:
                chosen = []
                for entry in per_segment_order:
                    key = entry.get("key")
                    if key not in EFFECTS:
                        continue
                    frm = int(entry.get("from", 1) or 1)
                    to = entry.get("to", None)
                    to = int(to) if to not in (None, "", "null") else num_chunks
                    if frm <= seg_num <= to:
                        chosen.append(key)

                if rotate_order and len(chosen) > 1:
                    offset = i % len(chosen)
                    chosen = chosen[offset:] + chosen[:offset]
            else:
                k = len(per_segment_order)
                if rotate_order and k > 1:
                    offset = i % k
                    chosen = list(per_segment_order[offset:]) + list(per_segment_order[:offset])
                else:
                    chosen = list(per_segment_order)
        else:
            p = pool or list(EFFECTS.keys())
            k = min(effects_per_segment, len(p))
            chosen = random.sample(p, k)

        per_chunk.append(chosen)

    return per_chunk


# =========================================================
# SCENE-CUT DETECTION
# =========================================================
def detect_scene_cuts(clip, threshold=30.0, sample_every=0.25, max_cuts=60):
    cuts = [0.0]
    prev = None
    t = 0.0
    dur = clip.duration
    try:
        while t < dur:
            frame = clip.get_frame(min(t, dur - 1e-3))
            small = frame[::16, ::16].astype("float32")
            if prev is not None:
                diff = np.abs(small - prev).mean()
                if diff > threshold:
                    cuts.append(t)
                    if len(cuts) >= max_cuts:
                        break
            prev = small
            t += sample_every
    except Exception as e:
        print(f"  ⚠️  Scene detection fallback: {e}")
    if cuts[-1] != dur:
        cuts.append(dur)
    return cuts


# =========================================================
# SAFE SUBCLIP
# =========================================================
def safe_subclip(clip, start, end):
    dur = clip.duration
    s = max(0.0, min(start, dur - 0.05))
    e = max(s + 0.05, min(end, dur - 0.01))
    return clip.subclip(s, e)


# =========================================================
# PIPELINE
# =========================================================
def remix_video(
    input_path,
    output_dir,
    num_segments=None,
    segment_duration=2.0,
    effects_per_segment=3,
    enabled_effects=None,

    # Ordered / windowed control
    base_effects=None,
    ordered_effects=None,
    effect_windows=None,
    rotate_order=True,

    # Behaviour toggles
    preserve_audio=True,
    group_by_category=False,
    category_run_length=3,
    motion_aware=False,
    scene_threshold=30.0,

    # Crop sliders — default 95% (gentle trim)
    crop_top_pct=0.95,
    crop_bottom_pct=0.95,

    # Quality
    quality_preset="high",

    progress_callback=None,
):
    """Remix a video by walking its timeline in order."""
    os.makedirs(output_dir, exist_ok=True)
    output_name = f"remix_{uuid.uuid4().hex[:8]}.mp4"
    output_path = os.path.join(output_dir, output_name)

    # ---- Resolve quality settings ----
    q = QUALITY_MAP.get(quality_preset, QUALITY_MAP["high"])

    # ---------- Validate ----------
    if enabled_effects is None:
        enabled_effects = list(EFFECTS.keys())
    enabled_effects = [e for e in enabled_effects if e in EFFECTS]

    crop_top_pct    = max(0.10, min(1.00, float(crop_top_pct)))
    crop_bottom_pct = max(0.10, min(1.00, float(crop_bottom_pct)))

    base_effects    = [e for e in (base_effects or []) if e in EFFECTS]
    ordered_effects = [e for e in (ordered_effects or []) if e in EFFECTS]

    clean_windows = []
    for w in (effect_windows or []):
        if not isinstance(w, dict):
            continue
        k = w.get("key")
        if k not in EFFECTS:
            continue
        frm = max(1, int(w.get("from", 1) or 1))
        to = w.get("to", None)
        to = int(to) if to not in (None, "", "null") else None
        clean_windows.append({"key": k, "from": frm, "to": to})

    ordered_effects = [e for e in ordered_effects if e not in base_effects]
    clean_windows   = [w for w in clean_windows if w["key"] not in base_effects]

    if clean_windows:
        ordered_effects = None

    if not enabled_effects and not ordered_effects and not clean_windows and not base_effects:
        raise ValueError("No valid effects selected")

    def report(step, total, msg):
        if progress_callback:
            progress_callback(step, total, msg)

    # ---------- Load source ----------
    report(0, 1, "Loading source video...")
    source = VideoFileClip(input_path)
    duration = float(source.duration)
    src_fps = source.fps or 24

    SAFETY = 2.0 / src_fps
    safe_duration = max(0.1, duration - SAFETY)

    print(f"📼 Source: {duration:.3f}s @ {src_fps} fps  "
          f"(safe end: {safe_duration:.3f}s)")
    print(f"🌾 Crop top/bottom keep: {crop_top_pct*100:.0f}% / {crop_bottom_pct*100:.0f}%")
    print(f"🎯 Quality preset: {quality_preset}  "
          f"(preset={q['preset']}, CRF={q['crf']})")

    # ---------- Shared kwargs for effect calls ----------
    effect_kwargs = {
        "crop_top_pct": crop_top_pct,
        "crop_bottom_pct": crop_bottom_pct,
    }

    # ---------- Apply BASE effects to whole video ----------
    if base_effects:
        print(f"🧱 Base effects (whole video): {base_effects}")
        for i, name in enumerate(base_effects):
            try:
                report(0, 1, f"Base {i+1}/{len(base_effects)}: {EFFECTS[name][0]}")
                source = EFFECTS[name][2](source, **effect_kwargs)
            except Exception as e:
                print(f"  ⚠️  base effect {name} failed: {e}")

    # ---------- Build chunk boundaries ----------
    if motion_aware:
        report(0, 1, "Detecting scene cuts...")
        raw_cuts = detect_scene_cuts(source, threshold=scene_threshold)
        raw_cuts = [min(c, safe_duration) for c in raw_cuts]
        raw_cuts = sorted(set(round(c, 3) for c in raw_cuts))
        if raw_cuts[0] != 0.0:
            raw_cuts.insert(0, 0.0)
        if raw_cuts[-1] != safe_duration:
            raw_cuts.append(round(safe_duration, 3))

        chunks = []
        for i in range(len(raw_cuts) - 1):
            a, b = raw_cuts[i], raw_cuts[i + 1]
            if b - a < 0.4 and chunks:
                chunks[-1] = (chunks[-1][0], b)
            else:
                chunks.append((a, b))
        print(f"  🎞️  Motion-aware: {len(chunks)} scene chunks")
    else:
        if num_segments and num_segments > 0:
            segment_duration = safe_duration / num_segments

        chunks = []
        t = 0.0
        while t < safe_duration - 0.02:
            end = min(t + segment_duration, safe_duration)
            end = round(end, 3)
            start_r = round(t, 3)

            if end - start_r < 0.15 and chunks:
                chunks[-1] = (chunks[-1][0], end)
                break

            chunks.append((start_r, end))
            t = end

    total_chunks = len(chunks)
    if total_chunks == 0:
        source.close()
        raise ValueError("No segments produced")

    print(f"  ✂️  {total_chunks} chunks")
    total_steps = total_chunks + 2

    # ---------- PRESERVE SOURCE RESOLUTION ----------
    target_size = source.size
    print(f"  📐 Target size: {target_size[0]}×{target_size[1]}")

    # ---------- Plan per-segment effects ----------
    if clean_windows:
        print(f"🎬 Effect windows: {clean_windows}")
        per_chunk_plan = plan_effects(
            per_segment_order=clean_windows,
            rotate_order=rotate_order,
            num_chunks=total_chunks,
        )
    elif ordered_effects:
        print(f"🎬 Ordered per-segment effects: {ordered_effects}  "
              f"(rotate_order={rotate_order})")
        per_chunk_plan = plan_effects(
            per_segment_order=ordered_effects,
            rotate_order=rotate_order,
            num_chunks=total_chunks,
        )
    else:
        if group_by_category:
            enabled_categories = {}
            for k in enabled_effects:
                cat = EFFECTS[k][1]
                enabled_categories.setdefault(cat, []).append(k)
            category_pool = list(enabled_categories.keys())
            random.shuffle(category_pool)
        else:
            category_pool = None

        per_chunk_plan = []
        for i in range(total_chunks):
            if group_by_category and category_pool:
                cat = category_pool[(i // max(1, category_run_length)) % len(category_pool)]
                pool = [k for k in enabled_effects if EFFECTS[k][1] == cat] or enabled_effects
            else:
                pool = enabled_effects
            k = min(effects_per_segment, len(pool))
            per_chunk_plan.append(random.sample(pool, k))

    for i, plan in enumerate(per_chunk_plan[:8]):
        print(f"  🎞️  Segment {i+1} plan: {plan}")
    if total_chunks > 8:
        print(f"  … and {total_chunks - 8} more")

    # ---------- Walk timeline ----------
    segments = []
    for i, (start, end) in enumerate(chunks):
        report(i + 1, total_steps,
               f"Segment {i+1}/{total_chunks}  ({start:.2f}s → {end:.2f}s)")

        seg = safe_subclip(source, start, end)

        # Fresh clip object → per-segment effects never leak
        try:
            seg = seg.copy()
        except AttributeError:
            pass

        chosen = per_chunk_plan[i]
        if chosen:
            print(f"    ↳ {i+1}: {' → '.join(EFFECTS[c][0] for c in chosen)}")

        for name in chosen:
            try:
                seg = EFFECTS[name][2](seg, **effect_kwargs)
            except Exception as e:
                print(f"  ⚠️  {name} failed on segment {i+1}: {e}")

        # Restore to source resolution if a crop/zoom changed dimensions
        try:
            if seg.size != target_size:
                seg = seg.fx(resize, target_size)
        except Exception as e:
            print(f"  ⚠️  resize failed on segment {i+1}: {e}")

        try:
            seg = seg.set_duration(round(seg.duration, 3))
        except Exception:
            pass

        segments.append(seg)

    # ---------- Concatenate ----------
    report(total_chunks + 1, total_steps, "Concatenating segments...")
    try:
        final = concatenate_videoclips(segments, method="chain")
    except Exception as e:
        print(f"  ⚠️  chain failed ({e}); falling back to compose")
        final = concatenate_videoclips(segments, method="compose")

    # ---------- Preserve audio ----------
    if preserve_audio and source.audio is not None:
        try:
            audio_end = min(final.duration, source.audio.duration)
            final = final.set_audio(source.audio.subclip(0, audio_end))
        except Exception as e:
            print(f"  ⚠️  Audio preserve failed: {e}")

    # ---------- Encode at HIGH QUALITY ----------
    report(total_chunks + 2, total_steps, "Encoding final video...")
    final.write_videofile(
        output_path,
        codec="libx264",
        audio_codec="aac",
        fps=src_fps,
        preset=q["preset"],
        audio_bitrate="320k",
        ffmpeg_params=[
            "-crf", q["crf"],
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-profile:v", "high",
            "-tune", "film",
        ],
        threads=4,
        logger=None,
    )

    source.close()
    final.close()
    return output_name