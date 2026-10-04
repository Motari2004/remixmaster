"""
🎬 Remix Master — Flask backend (VPS)

Persistent group & URL progress tracking + AI reformatting + Buffer publishing.
"""

import os
import re
import time
import uuid
import json
import glob
import csv
import shutil
import threading
from urllib.parse import urlparse
from flask import (
    Flask, render_template, request, jsonify,
    send_from_directory, send_file, url_for
)

try:
    from flask_cors import CORS
except ImportError:
    CORS = None

from werkzeug.utils import secure_filename

try:
    import requests
except ImportError:
    requests = None

try:
    from ai_engine import (
        regenerate_for_tinytoon,
        parse_ai_response,
        is_available as ai_available,
    )
except ImportError:
    def regenerate_for_tinytoon(t, d):
        raise RuntimeError("ai_engine not loaded")
    def parse_ai_response(t):
        return {"title": "", "caption": "", "description": "", "hashtags": "", "raw": t}
    def ai_available():
        return False


_REMIX_IMPORT_ERROR = None
try:
    from remix_engine import remix_video, grouped_effects, EFFECTS
except Exception as e:
    _REMIX_IMPORT_ERROR = str(e)
    def grouped_effects():
        return {}
    EFFECTS = {}
    def remix_video(*args, **kwargs):
        raise RuntimeError(f"remix_engine unavailable: {_REMIX_IMPORT_ERROR}")


# =========================================================
# CONFIG
# =========================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", BASE_DIR)
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
OUTPUT_DIR = os.path.join(DATA_DIR, "outputs")
GROUPS_DIR = os.environ.get("GROUPS_DIR", os.path.join(BASE_DIR, "groups-metadata"))
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(GROUPS_DIR, exist_ok=True)

ALLOWED = {"mp4", "mov", "avi", "mkv", "webm", "m4v"}
MAX_BYTES = 500 * 1024 * 1024

DOWNLOAD_API_URL = os.environ.get(
    "DOWNLOAD_API_URL",
    "https://ytshortdown-scraper.onrender.com/api/fetch"
)
DOWNLOAD_API_TIMEOUT = 90
DIRECT_EXTS = {"mp4", "webm", "mov", "m4v", "mkv", "avi"}
STAGED_TTL_SECONDS = 3600
OUTPUT_TTL_SECONDS = 24 * 3600

DEFAULT_ORIGINS = "http://localhost:5000,http://127.0.0.1:5000,http://localhost:3000"
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]
PUBLIC_API_BASE = os.environ.get("PUBLIC_API_BASE", "").rstrip("/")

BUFFER_API_URL = "https://api.buffer.com"
BUFFER_API_KEY = os.environ.get("BUFFER_API_KEY", "")
BUFFER_YOUTUBE_CHANNEL_ID = os.environ.get("BUFFER_YOUTUBE_CHANNEL_ID", "")


# =========================================================
# SETTINGS
# =========================================================
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
SETTINGS_LOCK = threading.Lock()
EDITABLE_SETTINGS = ("GEMINI_API_KEY",)


def _load_settings():
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, Exception):
        return {}


def _save_settings(data):
    try:
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, SETTINGS_FILE)
        try: os.chmod(SETTINGS_FILE, 0o600)
        except Exception: pass
        return True
    except Exception as e:
        print(f"  ⚠️  Could not write settings.json: {e}")
        return False


def _get_setting(name, default=""):
    s = _load_settings()
    if name in s and s[name]:
        return s[name]
    return os.environ.get(name, default)


def _get_gemini_key():
    return _get_setting("GEMINI_API_KEY", "")


def _apply_gemini_key_to_engine():
    try:
        import ai_engine
        new_key = _get_gemini_key()
        if new_key and new_key != ai_engine.GEMINI_API_KEY:
            ai_engine.GEMINI_API_KEY = new_key
            ai_engine._model = None
            print(f"  🔑 Gemini key updated (len={len(new_key)})")
    except Exception as e:
        print(f"  ⚠️  Gemini key refresh failed: {e}")


# =========================================================
# PROGRESS TRACKING
# =========================================================
PROGRESS_FILE = os.path.join(DATA_DIR, "groups-progress.json")
PROGRESS_LOCK = threading.Lock()


def _load_progress():
    try:
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, Exception):
        return {}


def _save_progress(data):
    try:
        tmp = PROGRESS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, PROGRESS_FILE)
        return True
    except Exception as e:
        print(f"  ⚠️  Could not write progress file: {e}")
        return False


def _init_group_progress(group_name, urls):
    with PROGRESS_LOCK:
        progress = _load_progress()
        if group_name not in progress:
            progress[group_name] = {
                "status": "pending",
                "processed_urls": [],
                "pending_urls": list(urls),
                "last_update": None,
            }
        else:
            entry = progress[group_name]
            current_urls = set(urls)
            entry["pending_urls"] = [u for u in entry.get("pending_urls", []) if u in current_urls]
            entry["processed_urls"] = [u for u in entry.get("processed_urls", []) if u in current_urls]
            known = set(entry["pending_urls"]) | set(entry["processed_urls"])
            for u in urls:
                if u not in known:
                    entry["pending_urls"].append(u)
            if not entry["pending_urls"]:
                entry["status"] = "done"
        _save_progress(progress)
        return progress[group_name]


def _mark_url_processed(group_name, url, success=True):
    with PROGRESS_LOCK:
        progress = _load_progress()
        if group_name not in progress:
            progress[group_name] = {
                "status": "pending",
                "processed_urls": [],
                "pending_urls": [],
                "last_update": None,
            }
        entry = progress[group_name]
        if url in entry["pending_urls"]:
            entry["pending_urls"].remove(url)
        if url not in entry["processed_urls"]:
            entry["processed_urls"].append(url)
        entry["status"] = "done" if not entry["pending_urls"] else "in_progress"
        entry["last_update"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _save_progress(progress)


# =========================================================
# APP
# =========================================================
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES

if CORS is not None:
    CORS(app, resources={r"/*": {"origins": ALLOWED_ORIGINS if ALLOWED_ORIGINS != ["*"] else "*"}},
         supports_credentials=False, allow_headers="*", methods=["GET", "POST", "OPTIONS"])

JOBS = {}
STAGED = {}
JOBS_LOCK = threading.Lock()


# =========================================================
# HELPERS
# =========================================================
def allowed_file(name):
    return "." in name and name.rsplit(".", 1)[1].lower() in ALLOWED


def _to_bool(v, default=False):
    if v is None: return default
    if isinstance(v, bool): return v
    return str(v).lower() in ("1", "true", "yes", "on")


def _clean_windows(parsed):
    clean = []
    for w in parsed:
        if not isinstance(w, dict): continue
        k = w.get("key")
        if k not in EFFECTS: continue
        try: frm = int(w.get("from", 1) or 1)
        except (TypeError, ValueError): frm = 1
        to = w.get("to", None)
        if to in ("", None, "null"): to = None
        else:
            try: to = int(to)
            except (TypeError, ValueError): to = None
        clean.append({"key": k, "from": max(1, frm), "to": to})
    return clean


def guess_ext_from_url(url):
    path = urlparse(url).path
    if "." in path:
        ext = path.rsplit(".", 1)[-1].lower().split("?")[0].split("&")[0]
        if ext in ALLOWED: return ext
    return "mp4"


def looks_like_direct_url(url):
    path = urlparse(url).path
    if "." not in path: return False
    ext = path.rsplit(".", 1)[-1].lower().split("?")[0].split("&")[0]
    return ext in DIRECT_EXTS


def _probe_duration(fpath):
    try:
        from moviepy.editor import VideoFileClip
        clip = VideoFileClip(fpath)
        d = float(clip.duration)
        clip.close()
        return d
    except Exception as e:
        print(f"  ⚠️  Duration probe failed: {e}")
        return 0


def public_url(path):
    if PUBLIC_API_BASE:
        return f"{PUBLIC_API_BASE}{path}"
    try:
        parsed = urlparse(request.url)
        return f"{parsed.scheme}://{parsed.netloc}{path}"
    except Exception:
        return path


def _require_remix_engine():
    if _REMIX_IMPORT_ERROR:
        raise RuntimeError(f"Remix engine unavailable: {_REMIX_IMPORT_ERROR}")


def _get_buffer_youtube_channel_id():
    api_key = _get_setting("BUFFER_API_KEY", BUFFER_API_KEY)
    channel_id_env = _get_setting("BUFFER_YOUTUBE_CHANNEL_ID", BUFFER_YOUTUBE_CHANNEL_ID)
    if not api_key:
        raise ValueError("BUFFER_API_KEY is not set.")
    if channel_id_env:
        return channel_id_env

    resp = requests.post(BUFFER_API_URL,
        json={"query": "query { account { organizations { id } } }"},
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        timeout=30)
    resp.raise_for_status()
    orgs = resp.json().get("data", {}).get("account", {}).get("organizations", [])
    if not orgs: raise ValueError("No Buffer organizations found.")
    org_id = orgs[0]["id"]

    resp = requests.post(BUFFER_API_URL,
        json={"query": "query GetChannels($orgId: String!) { channels(input: { organizationId: $orgId }) { id name service } }",
              "variables": {"orgId": org_id}},
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        timeout=30)
    resp.raise_for_status()
    channels = resp.json().get("data", {}).get("channels", [])
    for ch in channels:
        if ch.get("service") == "youtube":
            return ch["id"]
    raise ValueError("No YouTube channel found in Buffer.")


# =========================================================
# OPTIONS PARSER
# =========================================================
def parse_options(src):
    if isinstance(src, dict):
        def getlist(k):
            v = src.get(k)
            if v is None: return []
            return v if isinstance(v, list) else [v]
        def getone(k, d=None): return src.get(k, d)
    else:
        getlist = src.getlist
        getone  = src.get

    def _cast(key, default, cast):
        v = getone(key, default)
        try: return cast(v)
        except (TypeError, ValueError): return default

    enabled = getlist("effects") or list(EFFECTS.keys())
    enabled = [e for e in enabled if e in EFFECTS]
    base_effects = [e for e in (getlist("base_effects") or []) if e in EFFECTS]

    ordered_raw = getone("ordered_effects") or ""
    if isinstance(ordered_raw, list):
        ordered_effects = [e for e in ordered_raw if e in EFFECTS]
    else:
        ordered_effects = [e.strip() for e in str(ordered_raw).split(",") if e.strip()]
        ordered_effects = [e for e in ordered_effects if e in EFFECTS]

    effect_windows = []
    raw_windows = getone("effect_windows")
    if isinstance(raw_windows, str) and raw_windows.strip():
        try:
            parsed = json.loads(raw_windows)
            if isinstance(parsed, list):
                effect_windows = _clean_windows(parsed)
        except Exception as e:
            print(f"  ⚠️  effect_windows parse error: {e}")
    elif isinstance(raw_windows, list):
        effect_windows = _clean_windows(raw_windows)

    options = {
        "num_segments": _cast("num_segments", None, lambda v: int(v) if v else None),
        "segment_duration": _cast("segment_duration", 3.0, float),
        "effects_per_segment": _cast("effects_per_segment", 3, int),
        "enabled_effects": enabled,
        "base_effects": base_effects,
        "ordered_effects": ordered_effects,
        "effect_windows": effect_windows,
        "rotate_order": _to_bool(getone("rotate_order"), True),
        "preserve_audio": _to_bool(getone("preserve_audio"), True),
        "group_by_category": _to_bool(getone("group_by_category"), False),
        "category_run_length": _cast("category_run_length", 3, int),
        "motion_aware": _to_bool(getone("motion_aware"), False),
        "scene_threshold": _cast("scene_threshold", 30.0, float),
        "crop_top_pct": _cast("crop_top_pct", 0.95, float),
        "crop_bottom_pct": _cast("crop_bottom_pct", 0.95, float),
        "quality_preset": getone("quality_preset", "high") or "high",
    }

    options["effects_per_segment"] = max(1, min(7, options["effects_per_segment"]))
    options["segment_duration"] = max(1.0, min(15.0, options["segment_duration"]))
    options["category_run_length"] = max(1, min(10, options["category_run_length"]))
    options["scene_threshold"] = max(5.0, min(120.0, options["scene_threshold"]))
    options["crop_top_pct"] = max(0.10, min(1.00, options["crop_top_pct"]))
    options["crop_bottom_pct"] = max(0.10, min(1.00, options["crop_bottom_pct"]))
    if options["quality_preset"] not in ("fast", "medium", "high", "max", "lossless"):
        options["quality_preset"] = "high"
    return options


# =========================================================
# RESOLVER + DOWNLOAD
# =========================================================
def resolve_via_external_api(video_url):
    if requests is None:
        raise ValueError("requests not installed")
    print(f"  🔗 Resolving via {DOWNLOAD_API_URL}")
    try:
        r = requests.post(DOWNLOAD_API_URL,
            json={"url": video_url, "quality": "1080p", "format": "mp4"},
            timeout=DOWNLOAD_API_TIMEOUT)
    except requests.exceptions.RequestException as e:
        raise ValueError(f"Resolver unreachable: {e}")
    if not r.ok:
        raise ValueError(f"Resolver HTTP {r.status_code}: {r.text[:200]}")
    try:
        data = r.json()
    except Exception:
        raise ValueError(f"Resolver non-JSON: {r.text[:200]}")
    if data.get("success") is False and data.get("error"):
        raise ValueError(f"Resolver error: {data['error']}")
    direct = (data.get("download_url") or data.get("url") or data.get("direct_url")
              or (data.get("data") or {}).get("download_url"))
    if not direct:
        raise ValueError(f"No download_url in resolver response")
    print(f"  ✅ Resolved: {direct[:80]}...")
    return direct


def download_url_to_upload_dir(url):
    if requests is None:
        raise ValueError("requests not installed")
    if not url.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")
    if not looks_like_direct_url(url):
        url = resolve_via_external_api(url)
    else:
        print(f"  ⚡ Direct URL")

    parsed = urlparse(url)
    base_name = os.path.basename(parsed.path) or "remote_video"
    ext = guess_ext_from_url(url)
    fname = f"{uuid.uuid4().hex[:12]}.{ext}"
    fpath = os.path.join(UPLOAD_DIR, secure_filename(fname))

    headers = {"User-Agent": "Mozilla/5.0", "Accept": "*/*"}
    try:
        with requests.get(url, stream=True, timeout=60, headers=headers) as r:
            r.raise_for_status()
            total = 0
            with open(fpath, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 512):
                    if not chunk: continue
                    f.write(chunk)
                    total += len(chunk)
                    if total > MAX_BYTES:
                        f.close(); os.remove(fpath)
                        raise ValueError("File exceeds 500 MB")
        print(f"  💾 Saved {fpath} ({total/1024/1024:.2f} MB)")
        return fpath, base_name
    except requests.exceptions.RequestException as e:
        if os.path.exists(fpath):
            try: os.remove(fpath)
            except Exception: pass
        raise ValueError(f"Download failed: {e}")


# =========================================================
# STAGED FILES
# =========================================================
def _stage_file(fpath, input_name):
    token = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        STAGED[token] = {"fpath": fpath, "input_name": input_name, "created_at": time.time()}
    return token


def _consume_stage(token):
    with JOBS_LOCK:
        return STAGED.pop(token, None)


def _cleanup_stale_stages():
    while True:
        time.sleep(300)
        now = time.time()
        to_delete = []
        with JOBS_LOCK:
            for tok, info in list(STAGED.items()):
                if now - info["created_at"] > STAGED_TTL_SECONDS:
                    to_delete.append((tok, info["fpath"]))
                    STAGED.pop(tok, None)
        for tok, fp in to_delete:
            try:
                if os.path.exists(fp): os.remove(fp)
            except Exception: pass


def _cleanup_old_outputs():
    while True:
        time.sleep(3600)
        now = time.time()
        try:
            for fname in os.listdir(OUTPUT_DIR):
                fpath = os.path.join(OUTPUT_DIR, fname)
                if os.path.isfile(fpath) and (now - os.path.getmtime(fpath)) > OUTPUT_TTL_SECONDS:
                    os.remove(fpath)
                    print(f"  🧹 Removed {fname}")
        except Exception as e:
            print(f"  ⚠️  Cleanup error: {e}")


threading.Thread(target=_cleanup_stale_stages, daemon=True).start()
threading.Thread(target=_cleanup_old_outputs, daemon=True).start()


# =========================================================
# CSV LOADING
# =========================================================
def _load_csv_group(csv_path):
    items = []
    try:
        with open(csv_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            raw_fields = reader.fieldnames or []
            fieldnames = [n.strip().lower() for n in raw_fields]

            id_col = None
            url_col = None
            for n in fieldnames:
                if n in ("video id", "videoid", "video_id", "id"):
                    id_col = n; break
            if not id_col:
                for n in fieldnames:
                    if n in ("url", "video_url", "link", "short_url"):
                        url_col = n; break

            title_col = next((n for n in fieldnames if n in ("title", "video_title", "name")), None)
            desc_col = next((n for n in fieldnames if n in ("description", "video_description", "desc", "caption")), None)

            if not id_col and not url_col:
                return items

            f.seek(0)
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                row_lc = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
                url = row_lc.get(url_col, "").strip() if url_col else ""
                if not url and id_col:
                    vid = row_lc.get(id_col, "").strip()
                    if vid: url = f"https://www.youtube.com/shorts/{vid}"
                if not url: continue
                items.append({
                    "id": f"{os.path.splitext(os.path.basename(csv_path))[0]}_{i+1}",
                    "url": url,
                    "video_id": row_lc.get(id_col, "").strip() if id_col else "",
                    "title": row_lc.get(title_col, "").strip() if title_col else "",
                    "description": row_lc.get(desc_col, "").strip() if desc_col else "",
                })
    except Exception as e:
        print(f"  ⚠️  CSV read failed {csv_path}: {e}")
    return items


# =========================================================
# API — GROUPS
# =========================================================
@app.route("/api/groups")
def api_groups():
    try:
        files = sorted(
            glob.glob(os.path.join(GROUPS_DIR, "*.csv")),
            key=lambda p: (int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0),
                           os.path.basename(p))
        )
        groups = []
        for path in files:
            name = os.path.splitext(os.path.basename(path))[0]
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    count = sum(1 for _ in csv.DictReader(f))
            except Exception: count = 0
            groups.append({"name": name, "count": count})
        return jsonify(success=True, groups=groups, dir=GROUPS_DIR)
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500


@app.route("/api/groups/<name>")
def api_group_detail(name):
    safe_name = secure_filename(name)
    path = os.path.join(GROUPS_DIR, f"{safe_name}.csv")
    if not os.path.exists(path):
        return jsonify(error=f"Group '{name}' not found"), 404
    items = _load_csv_group(path)
    urls = [it["url"] for it in items]
    _init_group_progress(safe_name, urls)
    return jsonify(success=True, name=safe_name, items=items, count=len(items))


@app.route("/api/upload_csv", methods=["POST"])
def upload_csv():
    if "files" not in request.files:
        return jsonify(success=False, error="No files provided"), 400
    files = request.files.getlist("files")
    if not files:
        return jsonify(success=False, error="No files selected"), 400

    os.makedirs(GROUPS_DIR, exist_ok=True)
    uploaded, failed = [], []
    for f in files:
        if not f or not f.filename: continue
        if not f.filename.lower().endswith(".csv"):
            failed.append({"name": f.filename, "error": "Not a CSV"}); continue
        safe = secure_filename(f.filename)
        if not safe:
            failed.append({"name": f.filename, "error": "Invalid filename"}); continue
        dest = os.path.join(GROUPS_DIR, safe)
        try:
            f.save(dest)
            with open(dest, "r", encoding="utf-8-sig") as fh:
                _ = csv.DictReader(fh).fieldnames
            uploaded.append(safe)
        except Exception as e:
            failed.append({"name": f.filename, "error": str(e)})

    return jsonify(success=True, uploaded=uploaded, failed=failed)


@app.route("/api/delete_csv/<name>", methods=["POST"])
def delete_csv(name):
    safe = secure_filename(name)
    if not safe.endswith(".csv"): safe += ".csv"
    path = os.path.join(GROUPS_DIR, safe)
    if not os.path.exists(path):
        return jsonify(success=False, error="Not found"), 404
    try:
        os.remove(path)
        return jsonify(success=True, deleted=safe)
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500


# =========================================================
# API — PROGRESS
# =========================================================
@app.route("/api/progress")
def api_progress():
    progress = _load_progress()
    total_groups = len(progress)
    done_groups = sum(1 for g in progress.values() if g.get("status") == "done")
    in_progress = sum(1 for g in progress.values() if g.get("status") == "in_progress")
    total_urls = sum(len(g.get("processed_urls", [])) + len(g.get("pending_urls", []))
                     for g in progress.values())
    processed_urls = sum(len(g.get("processed_urls", [])) for g in progress.values())
    return jsonify(
        success=True,
        total_groups=total_groups,
        done_groups=done_groups,
        in_progress_groups=in_progress,
        pending_groups=total_groups - done_groups - in_progress,
        total_urls=total_urls,
        processed_urls=processed_urls,
        groups=progress,
    )


@app.route("/api/progress/<group_name>")
def api_progress_group(group_name):
    safe = secure_filename(group_name)
    progress = _load_progress()
    if safe not in progress:
        csv_path = os.path.join(GROUPS_DIR, f"{safe}.csv")
        if os.path.exists(csv_path):
            items = _load_csv_group(csv_path)
            urls = [it["url"] for it in items]
            entry = _init_group_progress(safe, urls)
            return jsonify(success=True, group=safe, data=entry)
        return jsonify(error="Not found"), 404
    return jsonify(success=True, group=safe, data=progress[safe])


@app.route("/api/progress/reset", methods=["POST"])
def api_progress_reset():
    data = request.get_json(silent=True) or {}
    if data.get("confirm") != "yes-reset-all":
        return jsonify(error="Confirm required"), 400
    with PROGRESS_LOCK:
        if _save_progress({}):
            return jsonify(success=True, message="All progress reset")
        return jsonify(error="Could not reset"), 500


@app.route("/api/progress/reset/<group_name>", methods=["POST"])
def api_progress_reset_group(group_name):
    safe = secure_filename(group_name)
    with PROGRESS_LOCK:
        progress = _load_progress()
        if safe in progress:
            del progress[safe]
            _save_progress(progress)
    return jsonify(success=True, reset=safe)


# =========================================================
# API — AI
# =========================================================
@app.route("/api/ai/status")
def ai_status():
    _apply_gemini_key_to_engine()
    return jsonify(available=ai_available())


@app.route("/api/ai/reformat", methods=["POST"])
def ai_reformat():
    _apply_gemini_key_to_engine()
    if not ai_available():
        return jsonify(error="AI not configured. Set GEMINI_API_KEY in settings."), 503
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    description = (data.get("description") or "").strip()
    if not title:
        return jsonify(error="Title is required"), 400
    try:
        raw = regenerate_for_tinytoon(title, description)
        parsed = parse_ai_response(raw)
        return jsonify(success=True, raw=raw, parsed=parsed)
    except Exception as e:
        print(f"  ⚠️  AI reformat failed: {e}")
        return jsonify(error=str(e)), 500


# =========================================================
# API — SETTINGS
# =========================================================
@app.route("/api/settings", methods=["GET"])
def api_settings_get():
    settings = _load_settings()
    ui_key = settings.get("GEMINI_API_KEY", "")
    env_key = os.environ.get("GEMINI_API_KEY", "")
    effective = ui_key or env_key
    out = {}
    if effective:
        masked = effective[:6] + "…" + effective[-4:] if len(effective) > 12 else "••••"
        source = "ui" if ui_key else "env"
        out["GEMINI_API_KEY"] = {"set": True, "masked": masked, "source": source}
    else:
        out["GEMINI_API_KEY"] = {"set": False, "masked": "", "source": None}
    return jsonify(success=True, settings=out)


@app.route("/api/settings", methods=["POST"])
def api_settings_post():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(success=False, error="Invalid payload"), 400
    with SETTINGS_LOCK:
        settings = _load_settings()
        changed = []
        for k, v in data.items():
            if k not in EDITABLE_SETTINGS: continue
            v = (v or "").strip()
            if v:
                settings[k] = v; changed.append(k)
            else:
                if k in settings:
                    del settings[k]; changed.append(f"{k} (cleared)")
        if not _save_settings(settings):
            return jsonify(success=False, error="Could not save"), 500
    _apply_gemini_key_to_engine()
    return jsonify(success=True, changed=changed)


@app.route("/api/settings/test", methods=["POST"])
def api_settings_test():
    _apply_gemini_key_to_engine()
    results = {}
    try:
        import ai_engine
        key = _get_gemini_key()
        if not ai_engine._GENAI_AVAILABLE:
            results["ai"] = {"ok": False, "message": "google-generativeai not installed"}
        elif not key:
            results["ai"] = {"ok": False, "message": "Gemini API key not set"}
        else:
            try:
                raw = ai_engine.regenerate_for_tinytoon("Test Title", "Test description")
                results["ai"] = {"ok": True, "message": f"OK — got {len(raw)} chars"}
            except Exception as e:
                results["ai"] = {"ok": False, "message": str(e)}
    except Exception as e:
        results["ai"] = {"ok": False, "message": str(e)}
    return jsonify(success=True, results=results)


# =========================================================
# JOB WORKER
# =========================================================
def run_job(job_id, input_path, options, group_name=None, source_url=None):
    job = JOBS[job_id]
    try:
        def cb(step, total, msg):
            with JOBS_LOCK:
                job["step"] = step
                job["total"] = total
                job["message"] = msg
                job["progress"] = int(100 * step / max(1, total))

        output_name = remix_video(
            input_path=input_path, output_dir=OUTPUT_DIR,
            num_segments=options["num_segments"],
            segment_duration=options["segment_duration"],
            effects_per_segment=options["effects_per_segment"],
            enabled_effects=options["enabled_effects"],
            base_effects=options["base_effects"],
            ordered_effects=options["ordered_effects"],
            effect_windows=options["effect_windows"],
            rotate_order=options["rotate_order"],
            preserve_audio=options["preserve_audio"],
            group_by_category=options["group_by_category"],
            category_run_length=options["category_run_length"],
            motion_aware=options["motion_aware"],
            scene_threshold=options["scene_threshold"],
            crop_top_pct=options["crop_top_pct"],
            crop_bottom_pct=options["crop_bottom_pct"],
            quality_preset=options["quality_preset"],
            progress_callback=cb,
        )

        try:
            original_name = f"original_{job_id}.mp4"
            original_out = os.path.join(OUTPUT_DIR, original_name)
            if os.path.exists(input_path):
                shutil.copy2(input_path, original_out)
                with JOBS_LOCK:
                    job["original_output"] = original_name
        except Exception as e:
            print(f"  ⚠️  Could not save original: {e}")

        with JOBS_LOCK:
            job["status"] = "done"
            job["progress"] = 100
            job["message"] = "Remix complete!"
            job["output"] = output_name

        if group_name and source_url:
            try:
                _mark_url_processed(group_name, source_url, success=True)
                print(f"  ✅ Progress: {group_name} / {source_url[:60]}")
            except Exception as e:
                print(f"  ⚠️  Progress mark failed: {e}")
    except Exception as e:
        with JOBS_LOCK:
            job["status"] = "error"
            job["message"] = f"Error: {e}"
        print("JOB ERROR:", e)
        if group_name and source_url:
            try:
                _mark_url_processed(group_name, source_url, success=False)
            except Exception: pass
    finally:
        try:
            if os.path.exists(input_path): os.remove(input_path)
        except Exception: pass


def launch_job(input_path, options, input_name="video", group_name=None, source_url=None):
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "running", "progress": 0, "step": 0, "total": 1,
            "message": "Queued...", "output": None, "input_name": input_name,
            "options": options, "group_name": group_name, "source_url": source_url,
        }
    threading.Thread(target=run_job,
                     args=(job_id, input_path, options, group_name, source_url),
                     daemon=True).start()
    return job_id


# =========================================================
# MAIN ROUTES
# =========================================================
@app.route("/")
def index():
    if _REMIX_IMPORT_ERROR:
        return jsonify(status="degraded", error="Remix engine unavailable"), 503
    effect_labels = {k: v[0] for k, v in EFFECTS.items()}
    return render_template("index.html", groups=grouped_effects(), effect_labels=effect_labels)


@app.route("/healthz")
def healthz():
    return jsonify(status="ok", service="remix-master", remix_engine_ok=(_REMIX_IMPORT_ERROR is None)), 200


@app.route("/api/effects")
def api_effects():
    if _REMIX_IMPORT_ERROR:
        return jsonify(error="Remix engine unavailable"), 503
    labels = {k: v[0] for k, v in EFFECTS.items()}
    return jsonify(groups=grouped_effects(), labels=labels, all=list(EFFECTS.keys()))


@app.route("/stage_upload", methods=["POST"])
def stage_upload():
    _require_remix_engine()
    if "video" not in request.files: return jsonify(error="No file part"), 400
    file = request.files["video"]
    if not file or not file.filename: return jsonify(error="No file"), 400
    if not allowed_file(file.filename): return jsonify(error="Unsupported"), 400
    ext = file.filename.rsplit(".", 1)[1].lower()
    fname = f"{uuid.uuid4().hex[:12]}.{ext}"
    fpath = os.path.join(UPLOAD_DIR, secure_filename(fname))
    file.save(fpath)
    token = _stage_file(fpath, file.filename)
    duration = _probe_duration(fpath)
    return jsonify(success=True, token=token, input_name=file.filename,
                   duration=duration, preview_url=public_url(f"/staged/{token}"))


@app.route("/fetch_url", methods=["POST"])
def fetch_url():
    _require_remix_engine()
    url = (request.form.get("video_url") or "").strip()
    if not url: return jsonify(error="No URL"), 400
    try:
        fpath, base_name = download_url_to_upload_dir(url)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    token = _stage_file(fpath, base_name)
    duration = _probe_duration(fpath)
    return jsonify(success=True, token=token, input_name=base_name,
                   duration=duration, preview_url=public_url(f"/staged/{token}"))


@app.route("/remix/<token>", methods=["POST"])
def remix_staged(token):
    _require_remix_engine()
    staged = _consume_stage(token)
    if not staged: return jsonify(error="Unknown/expired token"), 404
    fpath = staged["fpath"]
    if not os.path.exists(fpath): return jsonify(error="File gone"), 404
    options = parse_options(request.form)
    group_name = (request.form.get("group_name") or "").strip() or None
    source_url = (request.form.get("source_url") or "").strip() or None
    job_id = launch_job(fpath, options, staged["input_name"],
                        group_name=group_name, source_url=source_url)
    return jsonify(job_id=job_id, options=options)


@app.route("/staged/<token>")
def staged_preview(token):
    info = STAGED.get(token)
    if not info: return "Not found", 404
    fpath = info["fpath"]
    if not os.path.exists(fpath): return "Gone", 404
    resp = send_file(fpath, conditional=True, mimetype="video/mp4")
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


@app.route("/status/<job_id>")
def status(job_id):
    job = JOBS.get(job_id)
    if not job: return jsonify(error="Unknown job"), 404
    resp = {"status": job["status"], "progress": job["progress"], "message": job["message"]}
    if job["status"] == "done":
        resp["download_url"] = public_url(f"/download/{job['output']}")
        resp["preview_url"]  = public_url(f"/outputs/{job['output']}")
        if job.get("original_output"):
            resp["original_url"] = public_url(f"/outputs/{job['original_output']}")
    return jsonify(resp)


@app.route("/outputs/<filename>")
def download(filename):
    return send_from_directory(OUTPUT_DIR, filename, as_attachment=False, mimetype="video/mp4")


@app.route("/download/<filename>")
def download_attach(filename):
    return send_from_directory(OUTPUT_DIR, filename, as_attachment=True, mimetype="video/mp4")


# =========================================================
# PUBLISH VIA BUFFER
# =========================================================
@app.route("/publish_to_youtube/<job_id>", methods=["POST"])
def publish_to_youtube(job_id):
    job = JOBS.get(job_id)
    if not job or job.get("status") != "done":
        return jsonify(error="Job not complete"), 404
    api_key = _get_setting("BUFFER_API_KEY", BUFFER_API_KEY)
    if not api_key:
        return jsonify(error="Buffer API key not set"), 500

    public_video_url = public_url(f"/outputs/{job['output']}")
    data = request.get_json() or {}
    title = data.get("title", "Remix Master Video")
    caption = data.get("caption", title)

    try:
        channel_id = _get_buffer_youtube_channel_id()
    except Exception as e:
        return jsonify(error=str(e)), 500

    mutation = """
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id dueAt status } }
        ... on MutationError { message }
      }
    }
    """
    variables = {
        "input": {
            "channelId": channel_id,
            "text": caption,
            "schedulingType": "automatic",
            "mode": "addToQueue",
            "assets": [{"video": {"url": public_video_url}}],
            "metadata": {"youtube": {"title": title, "categoryId": "22", "privacy": "public"}}
        }
    }
    try:
        resp = requests.post(BUFFER_API_URL,
            json={"query": mutation, "variables": variables},
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=30)
        resp.raise_for_status()
        result = resp.json()
        if "errors" in result:
            return jsonify(error=result["errors"]), 400
        buffer_result = result.get("data", {}).get("createPost", {})
        if isinstance(buffer_result, dict) and buffer_result.get("message"):
            return jsonify(error=buffer_result["message"]), 400
        return jsonify(success=True, buffer_result=buffer_result)
    except requests.exceptions.RequestException as e:
        return jsonify(error=str(e)), 500


try:
    _apply_gemini_key_to_engine()
except Exception as e:
    print(f"  ⚠️  Startup refresh failed: {e}")


if __name__ == "__main__":
    print(f"🌐 Resolver:  {DOWNLOAD_API_URL}")
    print(f"📁 Data:      {DATA_DIR}")
    print(f"📚 Groups:    {GROUPS_DIR}")
    print(f"🔗 API base:  {PUBLIC_API_BASE or '(auto)'}")
    print(f"🤖 AI:        {ai_available()}")
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)