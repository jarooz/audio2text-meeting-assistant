/* ─────────────────────────────────────────────────────────────────────────── *
 *  Transcribe — Audio to Text                                                 *
 *  Frontend logic: drag-and-drop, waveform animation, upload, haptics         *
 * ─────────────────────────────────────────────────────────────────────────── */

"use strict";

// ─── HAPTICS ──────────────────────────────────────────────────────────────────
const haptic = (pattern) => {
  try { navigator.vibrate?.(pattern); } catch (_) {}
};
const HP = {
  drop:    [35],
  success: [40, 25, 80],
  error:   [60, 30, 60, 30, 120],
  copy:    [20],
  click:   [12],
};

// ─── WAVEFORM ANIMATOR ────────────────────────────────────────────────────────
class WaveformAnimator {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");
    this.n      = opts.bars ?? 44;
    this.heights = new Float32Array(this.n).fill(0.15);
    this.targets = new Float32Array(this.n).fill(0.15);
    this.phase   = 0;
    this.mode    = "idle";   // idle | active | done
    this._raf    = null;
    this._lastT  = 0;
  }

  setMode(m) { this.mode = m; }

  start() {
    if (this._raf) return;
    const loop = (t) => {
      this._raf = requestAnimationFrame(loop);
      // Throttle target updates to ~12 fps for smoother look
      if (t - this._lastT > 80) {
        this._updateTargets();
        this._lastT = t;
      }
      this._lerp();
      this._draw();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  _updateTargets() {
    this.phase += this.mode === "active" ? 0.18 : 0.035;
    for (let i = 0; i < this.n; i++) {
      if (this.mode === "idle") {
        const v = 0.18 + 0.16 * Math.sin(this.phase + i * 0.38);
        this.targets[i] = v;
      } else if (this.mode === "active") {
        // Organic-looking "speech" envelope
        const envelope = Math.abs(
          Math.sin(this.phase * 1.6 + i * 0.55) *
          Math.sin(this.phase * 0.9 + i * 0.22)
        );
        this.targets[i] = 0.08 + 0.76 * envelope;
      } else {
        this.targets[i] = 0.06;
      }
    }
  }

  _lerp() {
    const spd = this.mode === "active" ? 0.28 : this.mode === "done" ? 0.06 : 0.09;
    for (let i = 0; i < this.n; i++) {
      this.heights[i] += (this.targets[i] - this.heights[i]) * spd;
    }
  }

  _draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w   = canvas.offsetWidth;
    const h   = canvas.offsetHeight;
    if (!w || !h) return;

    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width  = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const gap   = 2.8;
    const barW  = (w - (this.n - 1) * gap) / this.n;
    const maxH  = h * 0.88;
    const cy    = h * 0.5;

    for (let i = 0; i < this.n; i++) {
      const bh  = Math.max(2.5, this.heights[i] * maxH);
      const x   = i * (barW + gap);
      const y   = cy - bh / 2;
      const t   = i / (this.n - 1);

      let r, g, b, a;
      if (this.mode === "done") {
        r = 16; g = 217; b = 164;
        a = 0.65;
      } else if (this.mode === "active") {
        r = Math.round(82  + (192 - 82)  * t);
        g = Math.round(84  + (132 - 84)  * t);
        b = Math.round(240 + (250 - 240) * t);
        a = 0.55 + 0.45 * this.heights[i];
      } else {
        // idle — muted gradient
        r = Math.round(82  + 90  * t);
        g = Math.round(84  + 55  * t);
        b = 244;
        a = 0.25 + 0.35 * this.heights[i];
      }

      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      roundRect(ctx, x, y, Math.max(1, barW), bh, Math.min(barW / 2, 3));
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (h < r * 2) r = h / 2;
  if (w < r * 2) r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const STATE = { IDLE: "idle", FILES: "files", TRANSCRIBING: "transcribing", DONE: "done" };
let appState        = STATE.IDLE;
let queuedFiles     = [];
let currentText     = "";
let progressCurrent = 0;
let progressTimer   = null;

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const dz          = $("drop-zone");
const fileInput   = $("file-input");
const browseBtn   = $("browse-btn");
const fileQueue   = $("file-queue");
const fileList    = $("file-list");
const queuePill   = $("queue-pill");
const transcribeBtn = $("transcribe-btn");
const clearBtn    = $("clear-btn");
const errorBox    = $("error-container");
const progSection = $("progress-section");
const progLabel   = $("progress-label");
const progPct     = $("progress-pct");
const progFill    = $("progress-fill");
const progCanvas  = $("progress-canvas");
const tSection    = $("transcript-section");
const tText       = $("transcript-text");
const tStats      = $("transcript-stats");
const copyBtn     = $("copy-btn");
const dlBtn       = $("download-btn");
const newBtn      = $("new-btn");
const langSelect  = $("language");
const wfCanvas    = $("waveform-canvas");

// ─── ANIMATORS ────────────────────────────────────────────────────────────────
const dropWave = new WaveformAnimator(wfCanvas, { bars: 48 });
const progWave = new WaveformAnimator(progCanvas, { bars: 36 });
dropWave.start();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmtBytes = (b) => {
  if (b < 1024)       return `${b} B`;
  if (b < 1048576)    return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
};

const getExt  = (name) => (name.split(".").pop() || "").toLowerCase().slice(0, 4);

const wordCnt = (txt) => txt.trim().split(/\s+/).filter(Boolean).length;

// ─── FILE MANAGEMENT ──────────────────────────────────────────────────────────
const ALLOWED_EXT = /\.(m4a|mp3|wav|ogg|aac|mp4|webm)$/i;

function addFiles(incoming) {
  let added = 0;
  for (const f of incoming) {
    if (queuedFiles.length >= 15) break;
    if (!ALLOWED_EXT.test(f.name)) continue;
    if (queuedFiles.some((x) => x.name === f.name && x.size === f.size)) continue;
    queuedFiles.push(f);
    added++;
  }
  if (added) renderFiles();
  return added;
}

function removeFile(i) {
  queuedFiles.splice(i, 1);
  renderFiles();
  haptic(HP.click);
}

function clearAll() {
  queuedFiles = [];
  renderFiles();
  haptic(HP.click);
}

function renderFiles() {
  const n = queuedFiles.length;
  queuePill.textContent = `${n} file${n !== 1 ? "s" : ""}`;
  fileList.innerHTML = "";

  if (n === 0) {
    fileQueue.hidden = true;
    if (appState !== STATE.TRANSCRIBING && appState !== STATE.DONE) {
      setState(STATE.IDLE);
    }
    return;
  }

  fileQueue.hidden = false;
  if (appState === STATE.IDLE) setState(STATE.FILES);

  queuedFiles.forEach((file, idx) => {
    const ext  = getExt(file.name);
    const card = document.createElement("div");
    card.className = "file-card";
    card.setAttribute("role", "listitem");
    card.style.animationDelay = `${idx * 38}ms`;

    card.innerHTML = `
      <div class="file-badge">${ext}</div>
      <div class="file-info">
        <div class="file-name" title="${escHtml(file.name)}">${escHtml(file.name)}</div>
        <div class="file-meta">${fmtBytes(file.size)}</div>
      </div>
      <div class="file-status" id="fst-${idx}">Ready</div>
      <button class="file-remove" aria-label="Remove ${escHtml(file.name)}" data-i="${idx}">×</button>
    `;
    fileList.appendChild(card);
  });

  fileList.querySelectorAll(".file-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      removeFile(parseInt(e.currentTarget.dataset.i, 10));
    });
  });
}

function setFileStatus(idx, cls, html) {
  const el = document.getElementById(`fst-${idx}`);
  if (!el) return;
  el.className = `file-status s-${cls}`;
  el.innerHTML = html;
  const card = el.closest(".file-card");
  if (card) card.className = `file-card state-${cls}`;
}

function escHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── STATE MACHINE ────────────────────────────────────────────────────────────
function setState(s) {
  appState = s;
  const idle  = s === STATE.IDLE;
  const files = s === STATE.FILES;
  const proc  = s === STATE.TRANSCRIBING;
  const done  = s === STATE.DONE;

  // Drop zone
  dz.hidden = done;
  dz.classList.toggle("dz-shrink", files || proc);
  dz.style.pointerEvents = proc ? "none" : "";
  dz.style.opacity       = proc ? "0.5" : "1";

  // File queue
  fileQueue.hidden = idle || proc || done;

  // Progress
  progSection.hidden = !proc;
  if (proc) {
    progWave.setMode("active");
    progWave.start();
    dropWave.setMode("active");
  } else {
    progWave.stop();
    progWave.setMode("idle");
    dropWave.setMode(done ? "done" : "idle");
  }

  // Transcript
  tSection.hidden = !done;

  // Buttons
  if (transcribeBtn) transcribeBtn.disabled = proc || queuedFiles.length === 0;
  if (clearBtn)      clearBtn.disabled      = proc;
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────
function setProgress(pct, labelHtml) {
  progressCurrent = Math.max(progressCurrent, Math.min(98, pct));
  progFill.style.width   = `${Math.round(progressCurrent)}%`;
  progPct.textContent    = `${Math.round(progressCurrent)}%`;
  progLabel.innerHTML    = labelHtml;
}

function startProgressSim(n) {
  progressCurrent = 0;
  progFill.style.width = "0%";
  progPct.textContent  = "0%";
  setProgress(4, `<span class="spin"></span> Preparing ${n} file${n > 1 ? "s" : ""}…`);

  progressTimer = setInterval(() => {
    if (progressCurrent < 80) {
      const label =
        progressCurrent < 45
          ? `<span class="spin"></span> Uploading file${n > 1 ? "s" : ""}…`
          : `<span class="spin"></span> Transcribing with Whisper AI…`;
      setProgress(progressCurrent + 0.7, label);
    }
  }, 450);
}

function stopProgressSim() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function finishProgress() {
  stopProgressSim();
  progressCurrent = 100;
  progFill.style.width = "100%";
  progPct.textContent  = "100%";
  progLabel.innerHTML  = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="var(--green)" stroke-width="3" stroke-linecap="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Complete
  `;
}

// ─── ERROR ────────────────────────────────────────────────────────────────────
function showError(title, msg, hint) {
  errorBox.innerHTML = `
    <div class="error-banner">
      <span class="err-icon">⚠</span>
      <div class="err-body">
        <div class="err-title">${escHtml(title)}</div>
        <div class="err-msg">${escHtml(msg)}</div>
        ${hint ? `<div class="err-hint">${escHtml(hint)}</div>` : ""}
      </div>
    </div>
  `;
}

function clearError() {
  errorBox.innerHTML = "";
}

// ─── TRANSCRIPTION ────────────────────────────────────────────────────────────
async function runTranscription() {
  if (!queuedFiles.length || appState === STATE.TRANSCRIBING) return;
  clearError();
  setState(STATE.TRANSCRIBING);
  haptic(HP.click);
  startProgressSim(queuedFiles.length);

  const formData = new FormData();
  for (const f of queuedFiles) formData.append("audio", f);
  formData.append("language", langSelect.value);

  const filesToProcess = [...queuedFiles];

  try {
    const data = await xhrUpload("/api/transcribe", formData, {
      onUploadProgress(pct) {
        const mapped = Math.round(pct * 0.45) + 5;
        setProgress(
          mapped,
          `<span class="spin"></span> Uploading (${Math.round(pct)}%)…`
        );
      },
      onUploadDone() {
        setProgress(55, `<span class="spin"></span> Transcribing with Whisper AI…`);
        // Mark all files as processing
        filesToProcess.forEach((_, i) => {
          setFileStatus(i, "processing", `<span class="spin"></span> Processing`);
        });
      },
    });

    stopProgressSim();
    finishProgress();
    progWave.setMode("done");

    // Mark all files as done
    filesToProcess.forEach((_, i) => {
      setFileStatus(
        i,
        "done",
        `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Done`
      );
    });

    const text = (data.transcript || "").trim();
    currentText = text;

    await sleep(550);
    setState(STATE.DONE);
    renderTranscript(text);
    haptic(HP.success);
    flashSuccess();

  } catch (err) {
    stopProgressSim();
    progressCurrent = 0;
    progFill.style.width = "0%";
    setState(STATE.FILES);
    renderFiles(); // Re-render to reset card states
    haptic(HP.error);
    showError(
      "Transcription failed",
      err.message || "Something went wrong.",
      err.hint || ""
    );
  }
}

// XHR wrapper with progress
function xhrUpload(url, formData, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        callbacks.onUploadProgress?.(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.upload.addEventListener("load", () => callbacks.onUploadDone?.());

    xhr.addEventListener("load", () => {
      const d = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(d);
      } else {
        const e = new Error(d.error || `Server error ${xhr.status}`);
        e.hint  = d.details?.hint || d.details?.ffmpeg || "";
        reject(e);
      }
    });

    xhr.addEventListener("error", () =>
      reject(new Error("Network error. Check your connection and try again."))
    );
    xhr.addEventListener("abort", () =>
      reject(new Error("Upload was cancelled."))
    );

    xhr.send(formData);
  });
}

// ─── TRANSCRIPT DISPLAY ───────────────────────────────────────────────────────
function renderTranscript(text) {
  const words = wordCnt(text);
  const chars = text.length;
  tStats.textContent = `${words.toLocaleString()} words · ${chars.toLocaleString()} chars`;

  tText.innerHTML = "";

  if (!text.trim()) {
    tText.textContent = "(No speech detected)";
    return;
  }

  // Split on double newlines; fall back to single newlines for dense text
  let paras = text.split(/\n{2,}/).filter(Boolean);
  if (paras.length === 1) {
    paras = text.split(/\n/).filter(Boolean);
  }

  paras.forEach((para, i) => {
    const p = document.createElement("p");
    p.textContent = para.trim();
    // Staggered fade-in
    p.style.opacity   = "0";
    p.style.transform = "translateY(7px)";
    p.style.transition = `opacity 0.35s ease ${i * 50}ms, transform 0.35s ease ${i * 50}ms`;
    tText.appendChild(p);

    // Double rAF to ensure transition triggers
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        p.style.opacity   = "1";
        p.style.transform = "translateY(0)";
      })
    );
  });
}

// ─── SUCCESS FLASH ────────────────────────────────────────────────────────────
function flashSuccess() {
  const el = document.createElement("div");
  el.id = "success-flash";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

// ─── COPY ─────────────────────────────────────────────────────────────────────
async function copyTranscript() {
  if (!currentText) return;
  try {
    await navigator.clipboard.writeText(currentText);
    haptic(HP.copy);
    copyBtn.classList.add("btn-copy-done");
    copyBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="3" stroke-linecap="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Copied!
    `;
    setTimeout(() => {
      copyBtn.classList.remove("btn-copy-done");
      copyBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy text
      `;
    }, 2200);
  } catch {
    showError("Clipboard error", "Could not write to clipboard.");
  }
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
function downloadTranscript() {
  if (!currentText) return;
  haptic(HP.click);
  const blob = new Blob([currentText], { type: "text/plain;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  const base = queuedFiles[0]?.name?.replace(/\.[^.]+$/, "") || "transcript";
  a.download = `${base}-transcript.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ─── RESET ────────────────────────────────────────────────────────────────────
function resetApp() {
  currentText = "";
  queuedFiles = [];
  progressCurrent = 0;
  stopProgressSim();
  clearError();
  tText.innerHTML  = "";
  tStats.textContent = "";
  progFill.style.width = "0%";
  progPct.textContent  = "0%";
  fileList.innerHTML   = "";
  setState(STATE.IDLE);
  haptic(HP.click);
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── DRAG & DROP ──────────────────────────────────────────────────────────────
let dragEnterCount = 0;

// Drop zone events
dz.addEventListener("click", (e) => {
  if (e.target === browseBtn || browseBtn.contains(e.target)) return;
  fileInput.click();
});

dz.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});

browseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});

// Drag events on drop zone
dz.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragEnterCount++;
  dz.classList.add("drag-active");
  dropWave.setMode("active");
});

dz.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragEnterCount = Math.max(0, dragEnterCount - 1);
  if (dragEnterCount === 0) {
    dz.classList.remove("drag-active");
    dropWave.setMode(appState === STATE.TRANSCRIBING ? "active" : "idle");
  }
});

dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dragEnterCount = 0;
  dz.classList.remove("drag-active");
  dropWave.setMode("idle");
  const dropped = Array.from(e.dataTransfer.files);
  const n = addFiles(dropped);
  if (n) haptic(HP.drop);
});

// Allow dropping anywhere on the page
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop",     (e) => {
  if (dz.contains(e.target)) return; // handled above
  e.preventDefault();
  const dropped = Array.from(e.dataTransfer.files);
  const n = addFiles(dropped);
  if (n) haptic(HP.drop);
});

// File input change
fileInput.addEventListener("change", () => {
  const n = addFiles(Array.from(fileInput.files));
  if (n) haptic(HP.click);
  fileInput.value = "";
});

// ─── BUTTONS ──────────────────────────────────────────────────────────────────
transcribeBtn.addEventListener("click", runTranscription);
clearBtn.addEventListener("click", () => { clearAll(); clearError(); });
copyBtn.addEventListener("click", copyTranscript);
dlBtn.addEventListener("click", downloadTranscript);
newBtn.addEventListener("click", resetApp);

// ─── CANVAS RESIZE ────────────────────────────────────────────────────────────
const resizeObs = new ResizeObserver(() => {
  // Re-draw will happen on next animation frame automatically
});
resizeObs.observe(wfCanvas);
resizeObs.observe(progCanvas);

// ─── INIT ─────────────────────────────────────────────────────────────────────
setState(STATE.IDLE);
