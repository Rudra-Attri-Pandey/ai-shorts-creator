# AI Shorts & Clips Creator (real backend)

Paste a YouTube URL → get a **real transcript**, **viral-moment picks**, and
**downloadable SRT/VTT captions** for each moment (usable in CapCut/Premiere).
Trimmed MP4 downloads work only when `ffmpeg` is installed.

## Run locally

```bash
npm install
npm start        # http://localhost:3016 (or first free 30xx port)
```

Python 3 required with `youtube-transcript-api` (primary) and `yt-dlp`
(fallback for captions):

```bash
pip install youtube-transcript-api yt-dlp
```

Optional AI picks — copy `.env.example` to `.env` and set a key
(server runs keyless in transcript-only mode otherwise):

```bash
GEMINI_API_KEY=your-key-here
```

## API

- `GET /api/health` → `{ ok, mode, ai, ffmpeg, simulated:false }`
- `POST /api/extract { url }` → transcript segments + moments.
  With key: Gemini returns 3–5 `{ start, end, hook, why, caption_style, score? }`.
  Keyless: real transcript excerpts labeled **unscored** (`ai:false`).
  No captions → `422`; bad URL → `400`.
- `GET /api/captions?videoId=&start=&end[&format=srt|vtt]` → real SRT + VTT
  for the slice (JSON by default, raw file download with `format=`).
- `GET /api/clip?videoId=&start=&end=` → trimmed MP4 **only if ffmpeg is
  installed**; otherwise `501` with an honest message.

## Honest capability list

- ✅ Real: YouTube transcript fetching, AI or excerpt moment detection,
  SRT/VTT caption slices, moments-JSON export.
- ⚠️ Optional: MP4 clip downloads (needs `ffmpeg` on PATH; absent here —
  endpoint returns `501`).
- ❌ Not real / not included: video rendering or caption burn-in, auto-posting
  to TikTok/Shorts/Reels, file-upload transcription (v1 is URL-only).
- Scores are shown **only** when the AI supplies them; transcript mode shows
  "unscored" instead of fake percentages. No mock clips remain in the UI.
