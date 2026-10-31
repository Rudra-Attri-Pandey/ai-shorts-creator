document.addEventListener('DOMContentLoaded', () => {
  const extractBtn = document.getElementById('extract-btn');
  const urlInput = document.getElementById('video-url');
  const uploader = document.getElementById('uploader');
  const clipsPanel = document.getElementById('clips-panel');
  const clipsGrid = document.getElementById('clips-grid');
  const clipsHeading = document.getElementById('clips-heading');
  const notice = document.getElementById('notice');
  const subtitleBubble = document.getElementById('subtitle-bubble');
  const handleEl = document.getElementById('screen-handle');
  const descEl = document.getElementById('screen-desc');
  const statusBadge = document.getElementById('engine-status');

  const captionPreset = document.getElementById('caption-preset');
  const fontSizeSlider = document.getElementById('font-size');

  let playbackTimer = null;
  let wordIndex = 0;
  let activeTranscriptWords = [];
  let state = null; // last /api/extract response

  function showNotice(msg) {
    notice.textContent = msg;
    notice.classList.remove('hidden');
  }
  function hideNotice() {
    notice.classList.add('hidden');
    notice.textContent = '';
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Backend mode badge — honest about AI vs transcript-only.
  fetch('/api/health')
    .then((r) => r.json())
    .then((h) => {
      if (h.ai) {
        statusBadge.textContent = 'AI Engine Active';
      } else {
        statusBadge.textContent = 'Transcript Mode — add GEMINI_API_KEY for AI picks';
      }
      if (h.ffmpeg === false) {
        statusBadge.title = 'ffmpeg not installed: MP4 clip downloads disabled, moments + captions work.';
      }
    })
    .catch(() => {
      statusBadge.textContent = 'Backend unreachable — start the server (npm start)';
    });

  // Captions configuration updates — applies to the REAL caption text.
  function updateCaptionStyling() {
    subtitleBubble.className = 'subtitle-bubble';
    subtitleBubble.classList.add(`preset-${captionPreset.value}`);
    subtitleBubble.style.fontSize = `${fontSizeSlider.value}px`;
  }

  captionPreset.addEventListener('change', updateCaptionStyling);
  fontSizeSlider.addEventListener('input', updateCaptionStyling);
  updateCaptionStyling();

  // Word-by-word punchy caption simulation over real transcript text.
  function playSubtitleSimulation(text) {
    if (playbackTimer) clearInterval(playbackTimer);
    activeTranscriptWords = String(text || '')
      .toUpperCase()
      .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
      .split(/\s+/)
      .filter(Boolean);
    if (!activeTranscriptWords.length) {
      subtitleBubble.textContent = '—';
      return;
    }
    wordIndex = 0;
    playbackTimer = setInterval(() => {
      if (wordIndex >= activeTranscriptWords.length) wordIndex = 0;
      const word1 = activeTranscriptWords[wordIndex] || '';
      const word2 = activeTranscriptWords[wordIndex + 1] || '';
      subtitleBubble.textContent = `${word1} ${word2}`.trim();
      wordIndex += 2;
    }, 450);
  }

  // Real caption text for a moment = transcript segments inside its window.
  function momentText(m) {
    if (!state || !Array.isArray(state.segments)) return m.hook || '';
    const words = state.segments
      .filter((s) => s.start < m.end && (s.start + (s.dur || 0)) > m.start)
      .map((s) => s.text);
    return words.length ? words.join(' ') : (m.hook || m.excerpt || '');
  }

  function badgeFor(m, i) {
    if (state && state.ai && typeof m.score === 'number') {
      return `🔥 ${m.score}% virality (AI)`;
    }
    if (state && state.ai) return `🤖 AI pick #${i + 1}`;
    return '📝 unscored excerpt';
  }

  function renderMoments(data) {
    clipsGrid.innerHTML = '';
    clipsHeading.textContent = data.ai
      ? `Top AI Extracted Moments (${data.moments.length})`
      : `Transcript Moments — unscored (${data.moments.length})`;
    data.moments.forEach((m, i) => {
      const card = document.createElement('div');
      card.classList.add('clip-card');
      const badge = badgeFor(m, i);
      const style = m.caption_style || 'tiktok';
      card.innerHTML = `
        <div class="clip-header">
          <span class="clip-score">${badge}</span>
          <span class="clip-time">${fmtClock(m.start)} - ${fmtClock(m.end)}</span>
        </div>
        <h4>${m.hook || 'Untitled moment'}</h4>
        <p class="clip-transcript">"${m.why || m.excerpt || ''}"</p>
        <p class="clip-style">Caption preset: ${style}</p>
        <div class="moment-actions">
          <button type="button" class="btn small preview-btn">Preview</button>
          <a class="btn small ghost" href="/api/captions?videoId=${encodeURIComponent(data.videoId)}&start=${m.start}&end=${m.end}&format=srt" download>↓ SRT</a>
          <a class="btn small ghost" href="/api/captions?videoId=${encodeURIComponent(data.videoId)}&start=${m.start}&end=${m.end}&format=vtt" download>↓ VTT</a>
        </div>
      `;
      const activate = () => {
        if (captionPreset) {
          const opt = [...captionPreset.options].find((o) => o.value === style);
          if (opt) { captionPreset.value = style; updateCaptionStyling(); }
        }
        playSubtitleSimulation(momentText(m));
        document.querySelectorAll('.clip-card').forEach((c) => { c.style.borderColor = 'var(--border)'; });
        card.style.borderColor = 'var(--accent)';
      };
      card.querySelector('.preview-btn').addEventListener('click', (ev) => { ev.stopPropagation(); activate(); });
      card.addEventListener('click', activate);
      clipsGrid.appendChild(card);
    });

    clipsPanel.classList.remove('hidden');
    clipsPanel.scrollIntoView({ behavior: 'smooth' });

    // Autoplay the first moment's real caption text.
    if (data.moments.length) {
      const first = data.moments[0];
      if (captionPreset && first.caption_style) {
        captionPreset.value = first.caption_style;
        updateCaptionStyling();
      }
      playSubtitleSimulation(momentText(first));
      const firstCard = clipsGrid.querySelector('.clip-card');
      if (firstCard) firstCard.style.borderColor = 'var(--accent)';
    }
  }

  extractBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) { showNotice('Paste a YouTube URL first.'); return; }
    hideNotice();
    extractBtn.disabled = true;
    extractBtn.textContent = 'Fetching transcript…';
    try {
      const r = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showNotice(data.error || `Request failed (HTTP ${r.status}).`);
        return;
      }
      state = data;
      if (data.notice) showNotice(data.notice);
      handleEl.textContent = '@creator';
      descEl.textContent = data.title
        ? `${data.title} — ${fmtClock(data.moments[0] ? data.moments[0].start : 0)} clip pick`
        : 'Real transcript moments — pick a card to preview.';
      renderMoments(data);
    } catch (e) {
      showNotice(`Could not reach the backend: ${(e && e.message) || e}. Is the server running (npm start)?`);
    } finally {
      extractBtn.disabled = false;
      extractBtn.textContent = 'Extract Viral Clips';
    }
  });

  // v1 supports YouTube URLs only — say so honestly, fake nothing.
  uploader.addEventListener('click', () => {
    showNotice('File upload is not supported in v1 — paste a YouTube URL above instead. No file was uploaded.');
  });
  uploader.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      showNotice('File upload is not supported in v1 — paste a YouTube URL above instead. No file was uploaded.');
    }
  });

  // Export = real artifacts: moments JSON (+ per-card SRT/VTT links).
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      if (!state || !state.moments) { showNotice('Extract moments first, then export.'); return; }
      const blob = new Blob([JSON.stringify({
        videoId: state.videoId,
        title: state.title,
        ai: state.ai,
        moments: state.moments,
      }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.videoId}_moments.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }
});
