"""
🎬 AI Engine — Gemini-powered content reformatter for TinyToon World.

Provides:
  - regenerate_for_tinytoon(title, description) → raw AI text
  - parse_ai_response(text) → dict with title, caption, description, hashtags
  - is_available() → bool (checks if API key + library are present)

Requires:
  pip install google-generativeai

Environment:
  GEMINI_API_KEY  — your Google AI Studio key
  GEMINI_MODEL    — optional, defaults to "gemini-1.5-flash"
"""

import os

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


def _get_model():
    """Lazy-init the Gemini model on first use."""
    global _model
    if _model is not None:
        return _model
    if not _GENAI_AVAILABLE:
        raise RuntimeError(
            "google-generativeai is not installed. "
            "Run: pip install google-generativeai"
        )
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set on the server. "
            "Add it to /etc/systemd/system/remix.service"
        )
    genai.configure(api_key=GEMINI_API_KEY)
    _model = genai.GenerativeModel(GEMINI_MODEL_NAME)
    print(f"  ✅ Gemini model ready: {GEMINI_MODEL_NAME}")
    return _model


# =========================================================
# SYSTEM PROMPT — TinyToon World
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
- Output ONLY the formatted text — no preamble, no markdown fences, no extra commentary
"""


# =========================================================
# CORE FUNCTION
# =========================================================
def regenerate_for_tinytoon(title: str, description: str) -> str:
    """
    Send a title + description to Gemini, get back the reformatted
    TinyToon World version.
    """
    model = _get_model()

    prompt = f"""{SYSTEM_PROMPT}

INPUT:
TITLE: {title}
DESCRIPTION: {description}"""

    response = model.generate_content(prompt)

    # Extract text safely (some responses come back with safety blocks)
    text = ""
    try:
        text = response.text
    except Exception as e:
        # Fallback: pull text from candidates
        try:
            if response.candidates:
                parts = response.candidates[0].content.parts
                text = "".join(p.text for p in parts if hasattr(p, "text"))
        except Exception:
            pass

    if not text:
        raise RuntimeError(
            "Gemini returned an empty response. "
            "The content may have been blocked by safety filters."
        )

    return text


# =========================================================
# PARSE THE AI RESPONSE
# =========================================================
def parse_ai_response(text: str) -> dict:
    """
    Parse the AI's structured response into a dict with keys:
        title, caption, description, hashtags, raw

    The AI is instructed to output in this format:

        TITLE:
        ...

        CAPTION:
        ...

        DESCRIPTION:
        ...

        HASHTAGS:
        ...
    """
    result = {
        "title": "",
        "caption": "",
        "description": "",
        "hashtags": "",
        "raw": text,
    }

    upper = text.upper()
    markers = {
        "TITLE:":       "title",
        "CAPTION:":     "caption",
        "DESCRIPTION:": "description",
        "HASHTAGS:":    "hashtags",
    }

    # Locate each marker in order
    positions = []
    for marker, key in markers.items():
        idx = upper.find(marker)
        if idx != -1:
            positions.append((idx, marker, key))
    positions.sort()

    # Extract each section's content between markers
    for i, (start_idx, marker, key) in enumerate(positions):
        content_start = start_idx + len(marker)
        content_end = positions[i + 1][0] if i + 1 < len(positions) else len(text)
        value = text[content_start:content_end].strip()
        result[key] = value

    # If the AI didn't follow the format, put everything in raw
    if not any(result[k] for k in ("title", "caption", "description")):
        result["title"] = text.strip()[:200]  # best-effort fallback

    return result


# =========================================================
# AVAILABILITY CHECK
# =========================================================
def is_available() -> bool:
    """Return True if the AI engine is ready to use."""
    return _GENAI_AVAILABLE and bool(GEMINI_API_KEY)


# =========================================================
# BATCH HELPER (optional — for testing or future use)
# =========================================================
def regenerate_batch(items, delay=1.2):
    """
    Reformat a list of items sequentially with a delay between calls
    to respect rate limits.

    items: list of dicts with keys {id, title, description}
    delay: seconds to wait between API calls

    Returns a list of dicts: {id, parsed, error, raw}
    """
    import time

    results = []
    for item in items:
        item_id = item.get("id", "")
        title = (item.get("title") or "").strip()
        description = (item.get("description") or "").strip()

        if not title:
            results.append({"id": item_id, "error": "Missing title", "parsed": None, "raw": ""})
            continue

        try:
            raw = regenerate_for_tinytoon(title, description)
            parsed = parse_ai_response(raw)
            results.append({"id": item_id, "error": None, "parsed": parsed, "raw": raw})
        except Exception as e:
            results.append({"id": item_id, "error": str(e), "parsed": None, "raw": ""})

        # Rate limit protection
        if delay > 0:
            time.sleep(delay)

    return results


# =========================================================
# SELF-TEST (run this file directly to test)
# =========================================================
if __name__ == "__main__":
    print("🧪 Testing AI Engine")
    print(f"   - Library available: {_GENAI_AVAILABLE}")
    print(f"   - API key set:       {bool(GEMINI_API_KEY)}")
    print(f"   - Model:             {GEMINI_MODEL_NAME}")
    print(f"   - Ready:             {is_available()}")

    if not is_available():
        print("\n❌ AI not available. Check GEMINI_API_KEY and install google-generativeai.")
        raise SystemExit(1)

    print("\n🤖 Sending test prompt…")
    try:
        raw = regenerate_for_tinytoon(
            "Fruit Ice Cream! 🍦🍓 Sharing is Caring",
            "Wow, yummy! The funny toy bear really wants some delicious fruit ice cream...",
        )
        print("\n✅ Raw response:\n")
        print(raw[:1000])

        parsed = parse_ai_response(raw)
        print("\n📋 Parsed:")
        print(f"   Title:       {parsed['title'][:100]}")
        print(f"   Caption:     {parsed['caption'][:100]}")
        print(f"   Description: {parsed['description'][:100]}")
        print(f"   Hashtags:    {parsed['hashtags'][:100]}")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        raise SystemExit(1)