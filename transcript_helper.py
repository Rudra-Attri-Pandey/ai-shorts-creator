"""Fetch a YouTube transcript via youtube-transcript-api.

Usage: python transcript_helper.py <videoId>
Prints a single JSON object to stdout:
  {"ok": true, "segments": [{"start": float, "dur": float, "text": str}]}
  {"ok": false, "error": "..."}
Works with both the v1.x (fetch/list) and legacy (get_transcript) APIs.
"""
import json
import sys


def clean(text):
    return " ".join(str(text).replace("\n", " ").split())


def to_segments(snippets):
    out = []
    for s in snippets:
        try:
            start = float(s.start if hasattr(s, "start") else s.get("start", 0))
            dur = float(s.duration if hasattr(s, "duration") else s.get("duration", 0))
            text = clean(s.text if hasattr(s, "text") else s.get("text", ""))
        except Exception:
            continue
        if text:
            out.append({"start": round(start, 2), "dur": round(dur, 2), "text": text})
    return out


def main():
    video_id = sys.argv[1] if len(sys.argv) > 1 else ""
    if not video_id:
        print(json.dumps({"ok": False, "error": "missing videoId"}))
        return
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        print(json.dumps({"ok": False, "error": "youtube-transcript-api not installed"}))
        return

    api = YouTubeTranscriptApi()

    # --- New v1.x API: fetch() shortcut first (English preferred) ---
    if hasattr(api, "fetch"):
        try:
            return_ok(to_segments(api.fetch(video_id, languages=["en"])))
            return
        except Exception:
            pass
        # Fall back: list all transcripts, prefer manual EN, then auto EN,
        # then anything translatable to EN, then the first available.
        try:
            tlist = api.list(video_id)
            transcripts = list(tlist)
            if not transcripts:
                print(json.dumps({"ok": False, "error": "no transcripts found"}))
                return
            manual_en = [t for t in transcripts
                         if t.language_code.startswith("en") and not t.is_generated]
            auto_en = [t for t in transcripts
                       if t.language_code.startswith("en") and t.is_generated]
            candidates = manual_en + auto_en
            if not candidates:
                for t in transcripts:
                    try:
                        if "en" in [l.language_code for l in t.translation_languages]:
                            candidates.append(t.translate("en"))
                    except Exception:
                        continue
            if not candidates:
                candidates = transcripts
            last_err = "unknown error"
            for t in candidates:
                try:
                    return_ok(to_segments(t.fetch()))
                    return
                except Exception as e:  # noqa: BLE001
                    last_err = str(e)
            print(json.dumps({"ok": False, "error": f"fetch failed: {last_err}"}))
            return
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"list failed: {e}"}))
            return

    # --- Legacy API: get_transcript() ---
    if hasattr(YouTubeTranscriptApi, "get_transcript"):
        try:
            data = YouTubeTranscriptApi.get_transcript(video_id, languages=["en"])
            return_ok(to_segments(data))
            return
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"get_transcript failed: {e}"}))
            return

    print(json.dumps({"ok": False, "error": "unsupported youtube-transcript-api version"}))


def return_ok(segments):
    if segments:
        print(json.dumps({"ok": True, "segments": segments}))
    else:
        print(json.dumps({"ok": False, "error": "empty transcript"}))


if __name__ == "__main__":
    main()
