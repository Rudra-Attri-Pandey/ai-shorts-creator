/* AI Shorts Creator backend — Express server.
 * Modes:
 *   - AI mode:         GEMINI_API_KEY set. Returns 3-5 viral moments with hooks.
 *   - Transcript-only: no key. Returns real transcript segments + unscored
 *                      excerpt windows with { ai:false }. NEVER fakes scores.
 * Clip MP4 downloads only work when ffmpeg is installed (checked at boot);
 * otherwise GET /api/clip returns 501 — moments + captions still work.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const APP_DIR = __dirname;
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const AI_MODE = Boolean(GEMINI_KEY);

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3016')
  .split(',').map((s) => s.trim()).filter(Boolean);

// --- ffmpeg availability (checked once at boot) -----------------------------
let FFMPEG = false;
try {
  const r = spawnSync('ffmpeg', ['-version'], { timeout: 8000, windowsHide: true });
  FFMPEG = r && r.status === 0;
} catch { FFMPEG = false; }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- Security middleware ----------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl / non-browser
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
}));
app.use(express.json({ limit: '10kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: 'draft-7' }));

// Sensitive-file guard: never expose secrets or server internals.
// Anchors use (^|\/) so nested paths (e.g. /static/server.js) are blocked too.
const SENSITIVE = /(\.env(\.|$)|package(-lock)?\.json|\.db$|\.sqlite3?$|transcript_helper\.py|(^|\/)server\.js$|\.map$)/i;
app.use((req, res, next) => {
  if (SENSITIVE.test(req.path)) return res.status(404).json({ error: 'Not found' });
  next();
});
app.use(express.static(APP_DIR, { dotfiles: 'deny', index: 'index.html' }));

// --- YouTube URL validation --------------------------------------------------
const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be',
]);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractVideoId(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  if (host === 'youtu.be') {
    const m = u.pathname.match(/^\/([A-Za-z0-9_-]{11})/);
    return m && ID_RE.test(m[1]) ? m[1] : null;
  }
  // youtube.com family: watch?v=, /shorts/, /embed/, /live/, /v/
  const v = u.searchParams.get('v');
  if (v && ID_RE.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// --- Time / caption helpers ---------------------------------------------------
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

function toSrtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function toVttTime(sec) {
  return toSrtTime(sec).replace(',', '.');
}

/** Cues of the transcript overlapping [start, end), clipped to the window. */
function sliceCues(segments, start, end) {
  const cues = [];
  for (const s of segments) {
    const sEnd = s.start + (s.dur || 0);
    if (s.start < end && sEnd > start) {
      cues.push({
        start: Math.max(s.start, start),
        end: Math.min(sEnd, end),
        text: s.text,
      });
    }
  }
  return cues.filter((c) => c.end > c.start && c.text);
}

function buildSrt(cues) {
  return cues.map((c, i) =>
    `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}\n`
  ).join('\n');
}

function buildVtt(cues) {
  const body = cues.map((c) =>
    `${toVttTime(c.start)} --> ${toVttTime(c.end)}\n${c.text}\n`
  ).join('\n');
  return `WEBVTT\n\n${body}`;
}

function videoDuration(segments) {
  if (!segments.length) return 0;
  const last = segments[segments.length - 1];
  return Math.round(((last.start + (last.dur || 0))) * 10) / 10;
}

/** Deterministic excerpt windows built ONLY from the real transcript.
 *  Never scored — callers must label these "unscored". */
function excerptWindows(segments, count = 4) {
  if (!segments.length) return [];
  const n = segments.length;
  const idx = n <= count
    ? segments.map((_, i) => i)
    : Array.from({ length: count }, (_, k) => Math.floor((k * n) / count));
  return idx.map((si, k) => {
    const chunk = segments.slice(si, Math.min(si + 8, n));
    const text = chunk.map((s) => s.text).join(' ');
    const start = segments[si].start;
    const lastSeg = chunk[chunk.length - 1];
    const end = Math.min(lastSeg.start + (lastSeg.dur || 4), start + 60);
    return {
      start: Math.round(start * 10) / 10,
      end: Math.round(Math.max(end, start + 10) * 10) / 10,
      hook: text.length > 120 ? text.slice(0, 117) + '…' : text,
      why: 'Transcript excerpt — add GEMINI_API_KEY for AI virality picks.',
      caption_style: 'tiktok',
      scored: false,
      excerpt: text.length > 220 ? text.slice(0, 217) + '…' : text,
      _rank: k + 1,
    };
  });
}

// --- Transcript fetching ------------------------------------------------------
function pythonBin() {
  for (const c of ['python', 'python3']) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return 'python';
}

function fetchTranscriptPython(videoId) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), [path.join(APP_DIR, 'transcript_helper.py'), videoId], {
      timeout: 45000, windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ ok: false, error: 'python spawn failed' }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() || '{}');
        if (parsed.ok && Array.isArray(parsed.segments) && parsed.segments.length) {
          return resolve({ ok: true, segments: parsed.segments, via: 'youtube-transcript-api' });
        }
        resolve({ ok: false, error: parsed.error || err || 'no transcript' });
      } catch { resolve({ ok: false, error: err || 'unparseable helper output' }); }
    });
  });
}

function parseVtt(vtt) {
  const segs = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n\s*\n/);
  const ts = /(\d+:)?(\d+):(\d+)\.(\d+)\s*-->\s*(\d+:)?(\d+):(\d+)\.(\d+)/;
  const toSec = (h, m, s) => (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const idx = lines.findIndex((l) => ts.test(l));
    if (idx < 0) continue;
    const m = lines[idx].match(ts);
    const text = lines.slice(idx + 1).join(' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (segs.length && segs[segs.length - 1].text === text) continue; // dedupe repeats
    segs.push({ start: toSec(m[1], m[2], m[3]), dur: 0, text });
  }
  for (let i = 0; i < segs.length; i++) {
    segs[i].dur = i + 1 < segs.length
      ? Math.max(1, Math.round((segs[i + 1].start - segs[i].start) * 10) / 10) : 4;
  }
  return segs;
}

/** Fallback: yt-dlp auto/manual subs -> VTT -> segments.
 *  No yt-dlp.exe download needed when the pip package is installed:
 *  `python -m yt_dlp` is tried first. */
function fetchTranscriptYtDlp(videoId) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-'));
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const tryBins = [
      [pythonBin(), ['-m', 'yt_dlp']],
      ['yt-dlp', []],
      [path.join(APP_DIR, 'yt-dlp.exe'), []],
    ];
    (function attempt(i) {
      if (i >= tryBins.length) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return resolve({ ok: false, error: 'yt-dlp not available' });
      }
      const [bin, prefix] = tryBins[i];
      const args = [...prefix, '--skip-download', '--no-playlist',
        '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*',
        '--sub-format', 'vtt', '--output', path.join(tmp, '%(id)s.%(ext)s'),
        '--quiet', '--no-warnings', url];
      const child = spawn(bin, args, { timeout: 90000, windowsHide: true });
      child.on('error', () => attempt(i + 1));
      child.on('close', (code) => {
        if (code !== 0) return attempt(i + 1);
        try {
          const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.vtt'));
          const en = files.filter((f) => /\.en[^.]*\.vtt$/i.test(f));
          const pick = en[0] || files[0];
          if (!pick) return attempt(i + 1);
          const segs = parseVtt(fs.readFileSync(path.join(tmp, pick), 'utf8'));
          fs.rmSync(tmp, { recursive: true, force: true });
          if (segs.length) return resolve({ ok: true, segments: segs, via: 'yt-dlp' });
          return resolve({ ok: false, error: 'yt-dlp produced no parseable cues' });
        } catch (e) { return resolve({ ok: false, error: String(e && e.message || e) }); }
      });
    })(0);
  });
}

async function fetchTitle(videoId) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.title === 'string' ? j.title : null;
  } catch { return null; }
}

// Small in-memory transcript cache (10 min TTL) so /api/captions
// doesn't refetch what /api/extract already retrieved.
const cache = new Map();
async function getTranscript(videoId) {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  let tr = await fetchTranscriptPython(videoId);
  let via = tr.via;
  if (!tr.ok) {
    const fb = await fetchTranscriptYtDlp(videoId);
    if (fb.ok) { tr = fb; via = fb.via; }
  }
  if (!tr.ok || !tr.segments || !tr.segments.length) {
    return { ok: false, error: tr.error || 'no transcript' };
  }
  const data = { ok: true, segments: tr.segments.slice(0, 2000), via };
  cache.set(videoId, { at: Date.now(), data });
  return data;
}

// --- Gemini -------------------------------------------------------------------
const MOMENTS_PROMPT = (transcript, duration) => (
  'You are a short-form virality engineer. From the YouTube transcript below '
  + `(video length ~${Math.round(duration)} seconds; lines start with [MM:SS]), `
  + 'pick 3 to 5 moments that would work as standalone vertical Shorts/Reels/TikToks.\n'
  + 'Rules: each moment 15-60s long; start < end; both within the video length; '
  + 'hook <= 120 characters; prefer strong opening hooks, surprising claims, or actionable tips.\n'
  + 'Return ONLY a JSON array (no markdown, no prose) of 3-5 objects with keys:\n'
  + '{"start": seconds as number, "end": seconds as number, '
  + '"hook": "opening hook, max 120 chars", "why": "one sentence on why it will perform", '
  + '"caption_style": "one of tiktok, minimalist, bold", '
  + '"score": optional virality score 1-100}\n\n'
  + 'TRANSCRIPT:\n' + transcript
);

const CAPTION_STYLES = new Set(['tiktok', 'minimalist', 'bold']);

function sanitizeMoments(arr, duration) {
  if (!Array.isArray(arr)) return null;
  const clean = [];
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    const start = Number(m.start), end = Number(m.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || end <= start) continue;
    if (start > duration + 5) continue;
    const e = Math.min(end, duration);
    if (e - start < 5 || e - start > 180) continue;
    const hook = String(m.hook || '').trim().slice(0, 120);
    if (!hook) continue;
    const score = Number.isFinite(Number(m.score))
      ? Math.max(1, Math.min(100, Math.round(Number(m.score)))) : null;
    clean.push({
      start: Math.round(start * 10) / 10,
      end: Math.round(e * 10) / 10,
      hook,
      why: String(m.why || '').trim().slice(0, 200) || 'Selected from transcript.',
      caption_style: CAPTION_STYLES.has(m.caption_style) ? m.caption_style : 'tiktok',
      ...(score !== null ? { score } : {}),
      scored: score !== null,
    });
  }
  if (clean.length < 1 || clean.length > 8) {
    if (!clean.length) return null;
  }
  return clean.slice(0, 5);
}

function extractJsonArray(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function transcriptForPrompt(segments) {
  const lines = segments.map((s) => `[${fmtClock(s.start)}] ${s.text}`);
  let joined = lines.join('\n');
  if (joined.length > 12000) joined = joined.slice(0, 12000) + '\n…(truncated)';
  return joined;
}

const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

async function callGeminiMoments(segments, duration) {
  const prompt = MOMENTS_PROMPT(transcriptForPrompt(segments), duration);
  let lastErr = null;
  let geminiJson;
  for (const model of GEMINI_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.5, maxOutputTokens: 1500 },
        }),
      }
    );
    if (r.ok) {
      geminiJson = await r.json();
      lastErr = null;
      break;
    }
    lastErr = new Error(`Gemini ${model} HTTP ${r.status}`);
    if (r.status === 400) break; // bad request/key — another model won't help
  }
  if (lastErr) throw lastErr;
  const j = geminiJson;
  const text = j && j.candidates && j.candidates[0] && j.candidates[0].content
    && j.candidates[0].content.parts && j.candidates[0].content.parts.map((p) => p.text || '').join('');
  const moments = sanitizeMoments(extractJsonArray(text), duration);
  if (!moments) throw new Error('Gemini returned unparseable JSON');
  return moments;
}

// --- API -----------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: AI_MODE ? 'ai' : 'transcript-only',
    ai: AI_MODE,
    ffmpeg: FFMPEG,
    simulated: false,
  });
});

app.post('/api/extract', async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Missing "url" string in request body.' });
  }
  if (url.length > 2000) {
    return res.status(400).json({ error: 'URL exceeds 2000 character limit.' });
  }
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({
      error: 'Invalid YouTube URL. Supported: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/.',
    });
  }

  const tr = await getTranscript(videoId);
  if (!tr.ok || !tr.segments.length) {
    return res.status(422).json({
      error: 'No transcript or captions found for this video. The video may have captions disabled, be private/age-restricted, or be unavailable. No moments were generated.',
      videoId,
    });
  }
  const segments = tr.segments;
  const duration = videoDuration(segments);
  const [title] = await Promise.all([fetchTitle(videoId)]);

  if (AI_MODE) {
    try {
      const moments = await callGeminiMoments(segments, duration);
      return res.json({
        videoId, title, duration, mode: 'ai', ai: true, simulated: false,
        transcriptVia: tr.via, segmentCount: segments.length,
        moments, segments,
      });
    } catch (e) {
      return res.json({
        videoId, title, duration, mode: 'transcript-only', ai: false, simulated: false,
        transcriptVia: tr.via, segmentCount: segments.length, segments,
        moments: excerptWindows(segments),
        notice: `AI moment detection failed (${(e && e.message) || e}); showing real transcript excerpts instead (unscored).`,
      });
    }
  }
  return res.json({
    videoId, title, duration, mode: 'transcript-only', ai: false, simulated: false,
    transcriptVia: tr.via, segmentCount: segments.length, segments,
    moments: excerptWindows(segments),
    notice: 'Transcript only — add GEMINI_API_KEY for AI virality picks with scores.',
  });
});

// Real captions for a slice: JSON by default, raw download via ?format=srt|vtt.
app.get('/api/captions', async (req, res) => {
  const { videoId, start, end, format } = req.query;
  if (typeof videoId !== 'string' || !ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Query param "videoId" must be an 11-character YouTube video id.' });
  }
  const s = Number(start), e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
    return res.status(400).json({ error: 'Query params "start" and "end" must be numbers with end > start >= 0.' });
  }
  if (e - s > 3600) {
    return res.status(400).json({ error: 'Slice longer than 3600 seconds is not allowed.' });
  }
  const tr = await getTranscript(videoId);
  if (!tr.ok || !tr.segments.length) {
    return res.status(422).json({ error: 'No transcript or captions found for this video.', videoId });
  }
  const cues = sliceCues(tr.segments, s, e);
  if (!cues.length) {
    return res.status(422).json({ error: 'No captions in that time range.', videoId });
  }
  const srt = buildSrt(cues);
  const vtt = buildVtt(cues);
  const fname = `${videoId}_${Math.round(s)}-${Math.round(e)}`;
  if (format === 'srt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.srt"`);
    return res.send(srt);
  }
  if (format === 'vtt') {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.vtt"`);
    return res.send(vtt);
  }
  return res.json({ videoId, start: s, end: e, cueCount: cues.length, srt, vtt });
});

// Trimmed MP4 via yt-dlp + ffmpeg — ONLY when ffmpeg is installed.
app.get('/api/clip', async (req, res) => {
  if (!FFMPEG) {
    return res.status(501).json({
      error: 'Clip downloads need ffmpeg, which is not installed on this server. Moments + captions still work; install ffmpeg and restart to enable MP4 clips.',
      ffmpeg: false,
    });
  }
  const { videoId, start, end } = req.query;
  if (typeof videoId !== 'string' || !ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Query param "videoId" must be an 11-character YouTube video id.' });
  }
  const s = Number(start), e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e - s > 180) {
    return res.status(400).json({ error: 'Clip slice must satisfy end > start >= 0 and be at most 180 seconds.' });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const dl = spawnSync(pythonBin(),
      ['-m', 'yt_dlp', '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        '--merge-output-format', 'mp4', '-o', path.join(tmp, 'src.%(ext)s'),
        '--quiet', '--no-warnings', '--no-playlist', url],
      { timeout: 300000, windowsHide: true });
    if (dl.status !== 0) {
      cleanup();
      return res.status(422).json({ error: 'Could not download source video for clipping.' });
    }
    const src = fs.readdirSync(tmp).map((f) => path.join(tmp, f))
      .find((f) => /^src\./.test(path.basename(f)) && !f.endsWith('.part'));
    if (!src) {
      cleanup();
      return res.status(422).json({ error: 'Download produced no video file.' });
    }
    const out = path.join(tmp, 'clip.mp4');
    const cut = spawnSync('ffmpeg',
      ['-y', '-ss', String(s), '-to', String(e), '-i', src, '-c', 'copy', out],
      { timeout: 120000, windowsHide: true });
    if (cut.status !== 0 || !fs.existsSync(out)) {
      cleanup();
      return res.status(500).json({ error: 'ffmpeg failed to trim the clip.' });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}_${Math.round(s)}-${Math.round(e)}.mp4"`);
    return res.sendFile(out, cleanup);
  } catch (err) {
    cleanup();
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
});

// --- Boot: PORT or first free 30xx ----------------------------------------------
function listenOn(port) {
  if (port > 3099) { console.error('No free port in 3016-3099.'); process.exit(1); }
  const server = net.createServer();
  server.once('error', () => listenOn(port + 1));
  server.once('listening', () => {
    server.close(() => {
      app.listen(port, () => {
        console.log(`[shorts] listening on http://localhost:${port}`);
        console.log(`[shorts] mode: ${AI_MODE ? 'AI (provider: gemini)' : 'TRANSCRIPT-ONLY (no GEMINI_API_KEY set — add one for AI virality picks)'}`);
        console.log(`[shorts] ffmpeg clip downloads: ${FFMPEG ? 'ENABLED' : 'DISABLED (install ffmpeg to enable /api/clip)'}`);
        console.log(`[shorts] CORS origins: ${CORS_ORIGINS.join(', ')}`);
      });
    });
  });
  server.listen(port);
}
module.exports = app;

// Guarded so `require('./server')` (e.g. serverless) does not start a listener.
// Direct `node server.js` behavior is unchanged.
if (require.main === module) {
  listenOn(Number(process.env.PORT) || 3016);
}
