"""
🎬 AI Engine — Gemini-powered content reformatter for TinyToon World.

Reads the API key from:
  1. settings.json (set via UI) — highest priority
  2. GEMINI_API_KEY env var — fallback

Requires:
  pip install google-generativeai
"""

import os
import json as _json

try:
    import google.generativeai as genai
    _GENAI_AVAILABLE = True
except ImportError:
    _GENAI_AVAILABLE = False
    print("⚠️  google-generativeai not installed. Run: pip install google-generativeai")


# =========================================================
# CONFIG
# =========================================================
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")

_model = None


def _settings_path():
    """Path to settings.json (respects DATA_DIR)."""
    return os.path.join(
        os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__))),
        "settings.json",
    )


def _read_key_from_settings():
    """Return the key saved via the UI (or None)."""
    try:
        path = _settings_path()
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                s = _json.load(f)
            if isinstance(s, dict) and s.get("GEMINI_API_KEY"):
                return s["GEMINI_API_KEY"]
    except Exception:
        pass
    return None


def _resolve_key():
    """Key priority: settings.json > env var > module global."""
    return _read_key_from_settings() or GEMINI_API_KEY


# =========================================================
# MODEL INIT
# =========================================================
def _get_model():
    """Lazy-init the Gemini model. Re-reads the key each time it changes."""
    global _model

    key = _resolve_key()

    if not _GENAI_AVAILABLE:
        raise RuntimeError(
            "google-generativeai is not installed. "
            "Run: pip install google-generativeai"
        )
    if not key:
        raise RuntimeError(
            "Gemini API key not set. Add it in the UI Settings panel."
        )

    # Rebuild if the key changed
    if _model is None or key != getattr(_model, "_key", None):
        genai.configure(api_key=key)
        _model = genai.GenerativeModel(GEMINI_MODEL_NAME)
        try:
            _model._key = key
        except Exception:
            pass
        print(f"  ✅ Gemini model ready: {GEMINI_MODEL_NAME} (key …{key[-4:]})")

    return _model


# =========================================================
# SYSTEM PROMPT
# =========================================================
SYSTEM_PROMPT = """You are a content formatter for TinyToon World, a kids YouTube channel.

When given a title and description, regenerate them in this EXACT format:

TITLE:
[New catchy title with emojis] | TinyToon World #shorts

CAPTION:
[Engaging caption with emojis and call-to-action]

Subscribe to TinyToon World for more fun kids shorts! ►► [Your Channel Link]

#Shorts #[Topic] #TinyToonWorld #KidsCartoon #KidsSongs #ToddlerLearning

DESCRIPTION:
[Full engaging description with welcome message]

Watch More Fun Songs:
🚌 Wheels on the Bus: https://www.youtube.com/watch?v=AlGZSKxbuJg
🛏️ Ten in The Bed: https://www.youtube.com/watch?v=lpZozY1YHrk
🍬 Johny Johny Yes Papa: https://www.youtube.com/watch?v=QBqzDXwn2dE

#preschoolsong #nurserysong #kindergartensong #kidseducation #kidsentertainment

At TinyToon World, our mission is to foster an exciting and enriching learning journey for children. Through captivating 3D animations, engaging educational content, and catchy tunes, we make education a thrilling adventure.

#PreschoolSong #NurserySong #KindergartenSong #KidsEducation #KidsEntertainment

HASHTAGS:
[All relevant hashtags]

RULES:
- Keep the tone warm, friendly, and kid-appropriate
- Use emojis generously but not excessively
- Preserve the channel link placeholder [Your Channel Link] as-is
- Always keep the exact three "Watch More Fun Songs" links
- Output ONLY the formatted text — no preamble, no markdown fences
"""


# =========================================================
# CORE
# =========================================================
def regenerate_for_tinytoon(title: str, description: str) -> str:
    model = _get_model()
    prompt = f"""{SYSTEM_PROMPT}

INPUT:
TITLE: {title}
DESCRIPTION: {description}"""
    response = model.generate_content(prompt)

    text = ""
    try:
        text = response.text
    except Exception:
        try:
            if response.candidates:
                parts = response.candidates[0].content.parts
                text = "".join(p.text for p in parts if hasattr(p, "text"))
        except Exception:
            pass

    if not text:
        raise RuntimeError("Gemini returned an empty response (possibly blocked by safety filters).")

    return text


def parse_ai_response(text: str) -> dict:
    result = {"title": "", "caption": "", "description": "", "hashtags": "", "raw": text}
    upper = text.upper()
    markers = {
        "TITLE:":       "title",
        "CAPTION:":     "caption",
        "DESCRIPTION:": "description",
        "HASHTAGS:":    "hashtags",
    }
    positions = []
    for marker, key in markers.items():
        idx = upper.find(marker)
        if idx != -1:
            positions.append((idx, marker, key))
    positions.sort()

    for i, (start_idx, marker, key) in enumerate(positions):
        content_start = start_idx + len(marker)
        content_end = positions[i + 1][0] if i + 1 < len(positions) else len(text)
        result[key] = text[content_start:content_end].strip()

    if not any(result[k] for k in ("title", "caption", "description")):
        result["title"] = text.strip()[:200]

    return result


def is_available() -> bool:
    if not _GENAI_AVAILABLE:
        return False
    return bool(_resolve_key())


# =========================================================
# SELF-TEST
# =========================================================
if __name__ == "__main__":
    print("🧪 Testing AI Engine")
    print(f"   Library:     {_GENAI_AVAILABLE}")
    print(f"   Key:         {'set' if _resolve_key() else 'NOT set'}")
    print(f"   Model:       {GEMINI_MODEL_NAME}")
    print(f"   Available:   {is_available()}")

    if not is_available():
        print("\n❌ AI not available.")
        raise SystemExit(1)

    print("\n🤖 Test call…")
    try:
        raw = regenerate_for_tinytoon("Test Title", "Test description")
        print("\n✅ Response:\n")
        print(raw[:600])
    except Exception as e:
        print(f"\n❌ Error: {e}")
        raise SystemExit(1)