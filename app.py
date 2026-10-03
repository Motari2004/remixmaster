"""
🎬 Remix Master — Flask backend (VPS)

Two-step flow:
  1) Stage: /stage_upload or /fetch_url — downloads and returns a token
  2) Remix: /remix/<token> — runs the remix pipeline on the staged file

Features:
  - Flask-CORS for cross-origin requests from a remote frontend
  - Absolute URLs for preview/download
  - Env-var-driven config for allowed origins and API base
  - Lazy moviepy import — the app starts even if FFmpeg is unavailable
  - Buffer API integration for YouTube Shorts auto-posting
  - Auto-downgrade to faster presets for long videos
  - Minimum output resolution enforcement for YouTube Shorts
"""

import os
import time
import uuid
import json
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
    print("⚠️  flask-cors not installed. Run: pip install flask-cors")

from werkzeug.utils import secure_filename

try:
    import requests
except ImportError:
    requests = None


# =========================================================
# LAZY MOVIEPY / REMIX ENGINE IMPORT
# =========================================================
_REMIX_IMPORT_ERROR = None
try:
    from remix_engine import remix_video, grouped_effects, EFFECTS
except Exception as e:
    _REMIX_IMPORT_ERROR = str(e)
    print(f"⚠️  Could not import remix_engine: {e}")
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
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

ALLOWED = {"mp4", "mov", "avi", "mkv", "webm", "m4v"}
MAX_BYTES = 500 * 1024 * 1024

DOWNLOAD_API_URL = os.environ.get(
    "DOWNLOAD_API_URL",
    "https://ytshortdown-scraper.onrender.com/api/fetch"
)
DOWNLOAD_API_TIMEOUT = 90
DIRECT_EXTS = {"mp4", "webm", "mov", "m4v", "mkv", "avi"}
STAGED_TTL_SECONDS = 3600

# ---- CORS ----
DEFAULT_ORIGINS = (
    "http://localhost:5000,"
    "http://127.0.0.1:5000,"
    "http://localhost:3000"
)
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if o.strip()
]

PUBLIC_API_BASE = os.environ.get("PUBLIC_API_BASE", "").rstrip("/")

# ---- Buffer API Configuration ----
BUFFER_API_URL = "https://api.buffer.com"
BUFFER_API_KEY = os.environ.get("BUFFER_API_KEY", "")
BUFFER_YOUTUBE_CHANNEL_ID = os.environ.get("BUFFER_YOUTUBE_CHANNEL_ID", "")

# ---- Output resolution enforcement (for YouTube Shorts) ----
MIN_OUTPUT_WIDTH = 1080
MIN_OUTPUT_HEIGHT = 1920
MIN_OUTPUT_WIDTH_HORIZONTAL = 1280
MIN_OUTPUT_HEIGHT_HORIZONTAL = 720


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES

if CORS is not None:
    CORS(
        app,
        resources={r"/*": {"origins": ALLOWED_ORIGINS if ALLOWED_ORIGINS != ["*"] else "*"}},
        supports_credentials=False,
        allow_headers="*",
        methods=["GET", "POST", "OPTIONS"],
    )

JOBS = {}
STAGED = {}
JOBS_LOCK = threading.Lock()


# =========================================================
# HELPERS
# =========================================================
def allowed_file(name):
    return "." in name and name.rsplit(".", 1)[1].lower() in ALLOWED


def _to_bool(v, default=False):
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    return str(v).lower() in ("1", "true", "yes", "on")


def _clean_windows(parsed):
    clean = []
    for w in parsed:
        if not isinstance(w, dict):
            continue
        k = w.get("key")
        if k not in EFFECTS:
            continue
        try:
            frm = int(w.get("from", 1) or 1)
        except (TypeError, ValueError):
            frm = 1
        to = w.get("to", None)
        if to in ("", None, "null"):
            to = None
        else:
            try:
                to = int(to)
            except (TypeError, ValueError):
                to = None
        clean.append({"key": k, "from": max(1, frm), "to": to})
    return clean


def guess_ext_from_url(url: str) -> str:
    path = urlparse(url).path
    if "." in path:
        ext = path.rsplit(".", 1)[-1].lower().split("?")[0].split("&")[0]
        if ext in ALLOWED:
            return ext
    return "mp4"


def looks_like_direct_url(url: str) -> bool:
    path = urlparse(url).path
    if "." not in path:
        return False
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
        print(f"  ⚠️  Could not probe duration: {e}")
        return 0


def public_url(path: str) -> str:
    if PUBLIC_API_BASE:
        return f"{PUBLIC_API_BASE}{path}"
    try:
        return url_for(request.endpoint, _external=True, **request.view_args)
    except Exception:
        return path


def _require_remix_engine():
    if _REMIX_IMPORT_ERROR:
        raise RuntimeError(
            "Remix engine unavailable on this server. "
            "This is expected if the app is running on a server without FFmpeg."
        )


def _get_buffer_youtube_channel_id():
    """Return the Buffer YouTube channel ID (from env or by querying the API)."""
    if not BUFFER_API_KEY:
        raise ValueError("BUFFER_API_KEY is not set.")
    if BUFFER_YOUTUBE_CHANNEL_ID:
        return BUFFER_YOUTUBE_CHANNEL_ID

    query = """
    query {
      account {
        organizations { id }
      }
    }
    """
    resp = requests.post(
        BUFFER_API_URL,
        json={"query": query},
        headers={"Authorization": f"Bearer {BUFFER_API_KEY}", "Content-Type": "application/json"},
        timeout=30
    )
    resp.raise_for_status()
    data = resp.json()
    orgs = data.get("data", {}).get("account", {}).get("organizations", [])
    if not orgs:
        raise ValueError("No Buffer organizations found.")
    org_id = orgs[0]["id"]

    query = """
    query GetChannels($orgId: String!) {
      channels(input: { organizationId: $orgId }) {
        id name service
      }
    }
    """
    resp = requests.post(
        BUFFER_API_URL,
        json={"query": query, "variables": {"orgId": org_id}},
        headers={"Authorization": f"Bearer {BUFFER_API_KEY}", "Content-Type": "application/json"},
        timeout=30
    )
    resp.raise_for_status()
    data = resp.json()
    channels = data.get("data", {}).get("channels", [])
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
            if v is None:
                return []
            return v if isinstance(v, list) else [v]
        def getone(k, d=None):
            return src.get(k, d)
    else:
        getlist = src.getlist
        getone  = src.get

    def _cast(key, default, cast):
        v = getone(key, default)
        try:
            return cast(v)
        except (TypeError, ValueError):
            return default

    enabled = getlist("effects") or list(EFFECTS.keys())
    enabled = [e for e in enabled if e in EFFECTS]

    base_effects = getlist("base_effects") or []
    base_effects = [e for e in base_effects if e in EFFECTS]

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
        "num_segments":        _cast("num_segments", None, lambda v: int(v) if v else None),
        "segment_duration":    _cast("segment_duration", 3.0, float),   # new default: 3s
        "effects_per_segment": _cast("effects_per_segment", 3, int),
        "enabled_effects":     enabled,

        "base_effects":        base_effects,
        "ordered_effects":     ordered_effects,
        "effect_windows":      effect_windows,
        "rotate_order":        _to_bool(getone("rotate_order"), True),

        "preserve_audio":      _to_bool(getone("preserve_audio"), True),
        "group_by_category":   _to_bool(getone("group_by_category"), False),
        "category_run_length": _cast("category_run_length", 3, int),
        "motion_aware":        _to_bool(getone("motion_aware"), False),
        "scene_threshold":     _cast("scene_threshold", 30.0, float),

        "crop_top_pct":        _cast("crop_top_pct", 0.95, float),
        "crop_bottom_pct":     _cast("crop_bottom_pct", 0.95, float),

        "quality_preset":      getone("quality_preset", "high") or "high",
    }

    options["effects_per_segment"] = max(1, min(7, options["effects_per_segment"]))
    options["segment_duration"]    = max(1.0, min(15.0, options["segment_duration"]))
    options["category_run_length"] = max(1, min(10, options["category_run_length"]))
    options["scene_threshold"]     = max(5.0, min(120.0, options["scene_threshold"]))
    options["crop_top_pct"]        = max(0.10, min(1.00, options["crop_top_pct"]))
    options["crop_bottom_pct"]     = max(0.10, min(1.00, options["crop_bottom_pct"]))
    if options["quality_preset"] not in ("fast", "medium", "high", "max", "lossless"):
        options["quality_preset"] = "high"

    return options


# =========================================================
# EXTERNAL RESOLVER
# =========================================================
def resolve_via_external_api(video_url: str) -> str:
    if requests is None:
        raise ValueError("The 'requests' library is not installed on the server.")
    print(f"  🔗 Resolving via {DOWNLOAD_API_URL}")
    try:
        r = requests.post(
            DOWNLOAD_API_URL,
            json={"url": video_url, "quality": "1080p", "format": "mp4"},
            timeout=DOWNLOAD_API_TIMEOUT,
        )
    except requests.exceptions.RequestException as e:
        raise ValueError(f"Resolver service unreachable: {e}")

    if not r.ok:
        raise ValueError(f"Resolver returned HTTP {r.status_code}: {r.text[:200]}")

    try:
        data = r.json()
    except Exception:
        raise ValueError(f"Resolver returned non-JSON: {r.text[:200]}")

    if data.get("success") is False and data.get("error"):
        raise ValueError(f"Resolver error: {data['error']}")

    direct = (data.get("download_url") or data.get("url") or data.get("direct_url")
              or (data.get("data") or {}).get("download_url"))
    if not direct:
        raise ValueError(f"Resolver did not return a download URL: {data}")

    print(f"  ✅ Resolved: {direct[:80]}...")
    return direct


# =========================================================
# DOWNLOAD HELPER
# =========================================================
def download_url_to_upload_dir(url: str):
    if requests is None:
        raise ValueError("The 'requests' library is not installed on the server.")
    if not url.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")

    if not looks_like_direct_url(url):
        url = resolve_via_external_api(url)
    else:
        print(f"  ⚡ Direct URL — skipping resolver")

    parsed = urlparse(url)
    base_name = os.path.basename(parsed.path) or "remote_video"
    ext = guess_ext_from_url(url)
    fname = f"{uuid.uuid4().hex[:12]}.{ext}"
    fpath = os.path.join(UPLOAD_DIR, secure_filename(fname))

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "*/*",
    }

    try:
        with requests.get(url, stream=True, timeout=60, headers=headers) as r:
            r.raise_for_status()
            total = 0
            with open(fpath, "wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 512):
                    if not chunk:
                        continue
                    f.write(chunk)
                    total += len(chunk)
                    if total > MAX_BYTES:
                        f.close()
                        try: os.remove(fpath)
                        except Exception: pass
                        raise ValueError("Remote file exceeds the 500 MB limit.")
        print(f"  💾 Saved to: {fpath}  ({total/1024/1024:.2f} MB)")
        return fpath, base_name
    except requests.exceptions.RequestException as e:
        if os.path.exists(fpath):
            try: os.remove(fpath)
            except Exception: pass
        raise ValueError(f"Could not download resolved URL: {e}")
    except ValueError:
        raise
    except Exception as e:
        if os.path.exists(fpath):
            try: os.remove(fpath)
            except Exception: pass
        raise ValueError(f"Unexpected error while downloading: {e}")


# =========================================================
# STAGED FILE MANAGEMENT
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
                if os.path.exists(fp):
                    os.remove(fp)
                    print(f"  🧹 Cleaned up stale staged file: {fp}")
            except Exception as e:
                print(f"  ⚠️  Cleanup failed for {fp}: {e}")


threading.Thread(target=_cleanup_stale_stages, daemon=True).start()


# =========================================================
# BACKGROUND WORKER
# =========================================================
def run_job(job_id, input_path, options):
    job = JOBS[job_id]
    try:
        def cb(step, total, msg):
            with JOBS_LOCK:
                job["step"] = step
                job["total"] = total
                job["message"] = msg
                job["progress"] = int(100 * step / max(1, total))

        output_name = remix_video(
            input_path=input_path,
            output_dir=OUTPUT_DIR,
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
        with JOBS_LOCK:
            job["status"] = "done"
            job["progress"] = 100
            job["message"] = "Remix complete!"
            job["output"] = output_name
    except Exception as e:
        with JOBS_LOCK:
            job["status"] = "error"
            job["message"] = f"Error: {e}"
        print("JOB ERROR:", e)
    finally:
        try:
            if os.path.exists(input_path):
                os.remove(input_path)
        except Exception:
            pass


def launch_job(input_path, options, input_name="video"):
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "running", "progress": 0, "step": 0, "total": 1,
            "message": "Queued...", "output": None, "input_name": input_name,
            "options": options,
        }
    threading.Thread(target=run_job, args=(job_id, input_path, options), daemon=True).start()
    return job_id


# =========================================================
# ROUTES
# =========================================================
@app.route("/")
def index():
    if _REMIX_IMPORT_ERROR:
        return jsonify(status="degraded", error="Remix engine unavailable", detail=_REMIX_IMPORT_ERROR), 503
    effect_labels = {k: v[0] for k, v in EFFECTS.items()}
    return render_template("index.html", groups=grouped_effects(), effect_labels=effect_labels)


@app.route("/healthz")
def healthz():
    return jsonify(status="ok", service="remix-master", remix_engine_ok=(_REMIX_IMPORT_ERROR is None)), 200


@app.route("/api/effects")
def api_effects():
    if _REMIX_IMPORT_ERROR:
        return jsonify(error="Remix engine unavailable", detail=_REMIX_IMPORT_ERROR), 503
    effect_labels = {k: v[0] for k, v in EFFECTS.items()}
    return jsonify(groups=grouped_effects(), labels=effect_labels, all=list(EFFECTS.keys()))


@app.route("/stage_upload", methods=["POST"])
def stage_upload():
    try:
        _require_remix_engine()
    except RuntimeError as e:
        return jsonify(error=str(e)), 503
    if "video" not in request.files:
        return jsonify(error="No file part"), 400
    file = request.files["video"]
    if not file or file.filename == "":
        return jsonify(error="No file selected"), 400
    if not allowed_file(file.filename):
        return jsonify(error="Unsupported file type"), 400
    ext = file.filename.rsplit(".", 1)[1].lower()
    fname = f"{uuid.uuid4().hex[:12]}.{ext}"
    fpath = os.path.join(UPLOAD_DIR, secure_filename(fname))
    file.save(fpath)
    token = _stage_file(fpath, file.filename)
    duration = _probe_duration(fpath)
    return jsonify(success=True, token=token, input_name=file.filename, duration=duration, preview_url=public_url(f"/staged/{token}"))


@app.route("/fetch_url", methods=["POST"])
def fetch_url():
    try:
        _require_remix_engine()
    except RuntimeError as e:
        return jsonify(error=str(e)), 503
    url = (request.form.get("video_url") or "").strip()
    if not url:
        return jsonify(error="No URL provided"), 400
    try:
        fpath, base_name = download_url_to_upload_dir(url)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    token = _stage_file(fpath, base_name)
    duration = _probe_duration(fpath)
    return jsonify(success=True, token=token, input_name=base_name, duration=duration, preview_url=public_url(f"/staged/{token}"))


@app.route("/remix/<token>", methods=["POST"])
def remix_staged(token):
    try:
        _require_remix_engine()
    except RuntimeError as e:
        return jsonify(error=str(e)), 503
    staged = _consume_stage(token)
    if not staged:
        return jsonify(error="Unknown or expired token"), 404
    fpath = staged["fpath"]
    if not os.path.exists(fpath):
        return jsonify(error="Staged file no longer exists"), 404
    options = parse_options(request.form)
    job_id = launch_job(fpath, options, staged["input_name"])
    return jsonify(job_id=job_id, options=options)


@app.route("/staged/<token>")
def staged_preview(token):
    info = STAGED.get(token)
    if not info:
        return "Not found", 404
    fpath = info["fpath"]
    if not os.path.exists(fpath):
        return "Gone", 404
    resp = send_file(fpath, conditional=True)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


@app.route("/upload", methods=["POST"])
def upload():
    try:
        _require_remix_engine()
    except RuntimeError as e:
        return jsonify(error=str(e)), 503
    if "video" not in request.files:
        return jsonify(error="No file part"), 400
    file = request.files["video"]
    if not file or file.filename == "":
        return jsonify(error="No file selected"), 400
    if not allowed_file(file.filename):
        return jsonify(error="Unsupported file type"), 400
    ext = file.filename.rsplit(".", 1)[1].lower()
    fname = f"{uuid.uuid4().hex[:12]}.{ext}"
    fpath = os.path.join(UPLOAD_DIR, secure_filename(fname))
    file.save(fpath)
    options = parse_options(request.form)
    job_id = launch_job(fpath, options, file.filename)
    return jsonify(job_id=job_id, options=options)


@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    try:
        _require_remix_engine()
    except RuntimeError as e:
        return jsonify(success=False, error=str(e)), 503
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify(success=False, error="No URL provided"), 400
    try:
        fpath, base_name = download_url_to_upload_dir(url)
    except ValueError as e:
        return jsonify(success=False, error=str(e)), 400
    options = parse_options(data)
    job_id = launch_job(fpath, options, base_name)
    return jsonify(success=True, error=None, job_id=job_id, input_name=base_name, options=options)


@app.route("/status/<job_id>")
def status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify(error="Unknown job"), 404
    resp = {"status": job["status"], "progress": job["progress"], "message": job["message"]}
    if job["status"] == "done":
        resp["download_url"] = public_url(f"/download/{job['output']}")
        resp["preview_url"]  = public_url(f"/outputs/{job['output']}")
    return jsonify(resp)


@app.route("/outputs/<filename>")
def download(filename):
    return send_from_directory(
        OUTPUT_DIR,
        filename,
        as_attachment=False,
        mimetype="video/mp4",
    )


@app.route("/download/<filename>")
def download_attach(filename):
    return send_from_directory(
        OUTPUT_DIR,
        filename,
        as_attachment=True,
        mimetype="video/mp4",
    )


@app.route("/effects")
def effects_list():
    return jsonify(groups=grouped_effects(), all=list(EFFECTS.keys()))


# ---- Publish to YouTube via Buffer ----
@app.route("/publish_to_youtube/<job_id>", methods=["POST"])
def publish_to_youtube(job_id):
    job = JOBS.get(job_id)
    if not job or job.get("status") != "done":
        return jsonify(error="Job not found or not complete"), 404

    if not BUFFER_API_KEY:
        return jsonify(error="Buffer API key is not configured on the server."), 500

    public_video_url = public_url(f"/outputs/{job['output']}")
    print(f"  📤 Publishing URL: {public_video_url}")

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
            "metadata": {
                "youtube": {
                    "title": title,
                    "categoryId": "22",
                    "privacy": "public"
                }
            }
        }
    }

    try:
        resp = requests.post(
            BUFFER_API_URL,
            json={"query": mutation, "variables": variables},
            headers={"Authorization": f"Bearer {BUFFER_API_KEY}", "Content-Type": "application/json"},
            timeout=30
        )
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


# =========================================================
# ENTRYPOINT
# =========================================================
if __name__ == "__main__":
    print(f"🌐 Resolver URL:    {DOWNLOAD_API_URL}")
    print(f"📁 Data dir:        {DATA_DIR}")
    print(f"🔗 Public API base: {PUBLIC_API_BASE or '(derived from request)'}")
    print(f"✅ Allowed origins: {ALLOWED_ORIGINS}")
    if BUFFER_API_KEY:
        print(f"✅ Buffer API key:  configured")
    else:
        print(f"⚠️  Buffer API key:  NOT configured")
    if _REMIX_IMPORT_ERROR:
        print(f"⚠️  Remix engine:   DISABLED ({_REMIX_IMPORT_ERROR})")
    else:
        print(f"✅ Remix engine:    OK ({len(EFFECTS)} effects)")
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)