"use client";

import { useEffect, useRef, useState } from "react";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const LICENSE_KEY = "tts-voice:license-accepted:v1";

const FALLBACK_VOICES = [
  { id: "af_heart", label: "Heart — US Female" },
  { id: "af_bella", label: "Bella — US Female" },
  { id: "af_nicole", label: "Nicole — US Female" },
  { id: "am_michael", label: "Michael — US Male" },
  { id: "am_adam", label: "Adam — US Male" },
  { id: "am_puck", label: "Puck — US Male" },
  { id: "bf_emma", label: "Emma — UK Female" },
  { id: "bm_george", label: "George — UK Male" },
  { id: "bm_lewis", label: "Lewis — UK Male" },
];

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE"); w(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

function chunkText(text, max = 400) {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = []; let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { chunks.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

let _uid = 2;
const makeRow = () => ({ id: _uid++, text: "", voice: "am_puck", speed: 0.9 });

export default function Home() {
  const [rows, setRows] = useState([
    { id: 1, text: "Welcome. This voice is generated locally in your browser — free, unlimited, and downloadable.", voice: "am_puck", speed: 0.9 },
  ]);
  const [voices, setVoices] = useState(FALLBACK_VOICES);
  const [modelState, setModelState] = useState("idle");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState("");
  const [audioUrls, setAudioUrls] = useState({});
  const [device, setDevice] = useState("");
  const [licensed, setLicensed] = useState(false);
  const [showLicense, setShowLicense] = useState(false);

  const ttsRef = useRef(null);
  const blobsRef = useRef({});
  const urlsRef = useRef({});

  useEffect(() => {
    try { setLicensed(localStorage.getItem(LICENSE_KEY) === "1"); } catch {}
    return () => { Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  function acceptLicense() {
    try { localStorage.setItem(LICENSE_KEY, "1"); } catch {}
    setLicensed(true); setShowLicense(false);
  }
  function revokeLicense() {
    try { localStorage.removeItem(LICENSE_KEY); } catch {}
    setLicensed(false);
  }
  function say(msg, kind = "") { setStatus(msg); setStatusKind(kind); }

  function updateRow(id, patch) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addRow() { setRows((rs) => [...rs, makeRow()]); }
  function removeRow(id) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    if (urlsRef.current[id]) {
      URL.revokeObjectURL(urlsRef.current[id]);
      delete urlsRef.current[id]; delete blobsRef.current[id];
      setAudioUrls((p) => { const n = { ...p }; delete n[id]; return n; });
    }
  }

  async function loadModel() {
    if (ttsRef.current) return ttsRef.current;
    setModelState("loading");
    say("Loading voice model (~80–300 MB, first time only)…");
    const { KokoroTTS } = await import("kokoro-js");
    const dev = typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm";
    setDevice(dev);
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: dev === "webgpu" ? "fp32" : "q8", device: dev,
    });
    ttsRef.current = tts;
    try {
      const v = tts.voices || {};
      const list = Object.keys(v).map((id) => {
        const m = v[id] || {};
        const lang = m.language === "en-gb" ? "UK" : m.language === "en-us" ? "US" : m.language || "";
        return { id, label: `${m.name || id} — ${lang} ${m.gender || ""}`.trim() };
      });
      if (list.length) setVoices(list);
    } catch {}
    setModelState("ready");
    say(`Model ready (${dev}).`, "ok");
    return tts;
  }

  async function generate() {
    if (!licensed) { setShowLicense(true); return; }
    const activeRows = rows.filter((r) => r.text.trim());
    if (!activeRows.length) { say("Type some text first.", "err"); return; }
    setBusy(true); setProgress(0);
    Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = {}; blobsRef.current = {}; setAudioUrls({});
    try {
      const tts = await loadModel();
      const rowChunks = activeRows.map((r) => chunkText(r.text));
      const total = rowChunks.reduce((n, c) => n + c.length, 0);
      let done = 0;
      for (let ri = 0; ri < activeRows.length; ri++) {
        const row = activeRows[ri]; const chunks = rowChunks[ri];
        const parts = []; let sr = 24000;
        for (let ci = 0; ci < chunks.length; ci++) {
          say(`Row ${ri + 1}/${activeRows.length} · chunk ${ci + 1}/${chunks.length}…`);
          const audio = await tts.generate(chunks[ci], { voice: row.voice, speed: Number(row.speed) });
          parts.push(audio.audio); sr = audio.sampling_rate || sr;
          setProgress(Math.round((++done / total) * 100));
        }
        const len = parts.reduce((n, p) => n + p.length, 0);
        const merged = new Float32Array(len); let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.length; }
        const blob = encodeWav(merged, sr);
        const url = URL.createObjectURL(blob);
        urlsRef.current[row.id] = url; blobsRef.current[row.id] = blob;
        setAudioUrls((p) => ({ ...p, [row.id]: url }));
      }
      say("Done. Play or download below.", "ok");
    } catch (e) {
      console.error(e); say("Error: " + (e?.message || String(e)), "err");
    } finally { setBusy(false); }
  }

  async function downloadAll() {
    const rowsWithAudio = rows.filter((r) => blobsRef.current[r.id]);
    if (!rowsWithAudio.length) return;
    if (rowsWithAudio.length === 1) {
      const a = document.createElement("a");
      a.href = urlsRef.current[rowsWithAudio[0].id];
      a.download = "1.wav"; a.click(); return;
    }
    const { zipSync } = await import("fflate");
    const files = {};
    for (let i = 0; i < rows.length; i++) {
      const blob = blobsRef.current[rows[i].id]; if (!blob) continue;
      files[`${i + 1}.wav`] = new Uint8Array(await blob.arrayBuffer());
    }
    const url = URL.createObjectURL(new Blob([zipSync(files)], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url; a.download = "tts-voices.zip"; a.click();
    URL.revokeObjectURL(url);
  }

  const hasResults = Object.keys(audioUrls).length > 0;
  const resultCount = Object.keys(audioUrls).length;
  const dotColor = modelState === "ready" ? "bg-emerald-400" : modelState === "loading" ? "bg-amber-400 animate-pulse" : "bg-slate-500";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0d0f14]">
      {/* ── ambient ── */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(109,139,255,0.18),transparent)] blur-2xl" />
        <div className="absolute top-1/3 -right-24 h-[300px] w-[300px] rounded-full bg-[radial-gradient(closest-side,rgba(160,107,255,0.14),transparent)] blur-2xl" />
      </div>

      {/* ── sticky top bar ── */}
      <header className="shrink-0 border-b border-white/[0.06] bg-[#0d0f14]/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-2 shadow shadow-brand/30">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="currentColor">
                <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
              </svg>
            </div>
            <span className="text-sm font-bold tracking-tight text-white">TTS Voice</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowLicense(true)}
              className="text-xs text-slate-500 underline decoration-dotted underline-offset-2 transition hover:text-slate-300"
            >
              License
            </button>
            {licensed && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-400">
                <svg className="h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor"><path d="M7.5 13.5 4 10l1.4-1.4 2.1 2.1L14.6 3.6 16 5z" /></svg>
                Accepted
              </span>
            )}
            <div className="flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-400">
              <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
              {modelState === "ready" ? `Ready · ${device}` : modelState === "loading" ? "Loading…" : "Idle"}
            </div>
          </div>
        </div>
      </header>

      {/* ── scrollable rows area ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4 pb-2">
          <div className="space-y-3">
            {rows.map((row, idx) => (
              <RowCard
                key={row.id}
                row={row}
                idx={idx}
                voices={voices}
                audioUrl={audioUrls[row.id]}
                canRemove={rows.length > 1}
                onUpdate={(patch) => updateRow(row.id, patch)}
                onRemove={() => removeRow(row.id)}
              />
            ))}
          </div>

          {/* add row */}
          <button
            onClick={addRow}
            disabled={busy}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.09] py-2.5 text-sm text-slate-500 transition hover:border-brand/40 hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            Add row
          </button>

          {/* breathing room above sticky footer */}
          <div className="h-4" />
        </div>
      </div>

      {/* ── sticky bottom action bar ── */}
      <footer className="shrink-0 border-t border-white/[0.06] bg-[#0d0f14]/90 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 py-3">
          {/* progress + status */}
          {(busy || status) && (
            <div className="mb-2.5 flex items-center gap-3">
              {busy && (
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-brand to-brand-2 transition-all duration-300"
                    style={{ width: progress + "%" }}
                  />
                </div>
              )}
              {status && (
                <p className={`truncate text-xs ${statusKind === "ok" ? "text-emerald-400" : statusKind === "err" ? "text-rose-400" : "text-slate-400"}`}>
                  {status}
                </p>
              )}
            </div>
          )}

          {/* buttons */}
          <div className="flex gap-2.5">
            <button
              onClick={generate}
              disabled={busy || modelState === "loading"}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-brand-2 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand/25 transition hover:opacity-95 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Generating…
                </>
              ) : modelState === "ready" ? "Generate" : "Load & Generate"}
            </button>

            <button
              onClick={downloadAll}
              disabled={!hasResults}
              className={`inline-flex items-center justify-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-brand/40 hover:bg-white/[0.07] ${!hasResults ? "cursor-not-allowed opacity-40" : ""}`}
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {resultCount > 1 ? `ZIP (${resultCount})` : "WAV"}
            </button>
          </div>
        </div>
      </footer>

      {/* ── license modal ── */}
      {showLicense && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowLicense(false)} />
          <div className="relative w-full max-w-lg rounded-2xl border border-white/[0.09] bg-[#13151c] p-6 shadow-2xl shadow-black/60">
            <div className="mb-4 flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand/15 text-brand">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" strokeLinejoin="round" />
                </svg>
              </div>
              <h3 className="text-base font-bold tracking-tight text-white">Voice & model license</h3>
            </div>
            <div className="max-h-56 space-y-3 overflow-y-auto pr-1 text-sm leading-relaxed text-slate-300">
              <p>This app uses <strong>Kokoro-82M</strong> under <strong>Apache 2.0</strong> — free for personal and commercial use.</p>
              <p>By continuing you agree that:</p>
              <ul className="list-disc space-y-1 pl-5 text-slate-400">
                <li>You hold rights to the text you synthesize.</li>
                <li>You will not impersonate real people or generate deceptive, harmful, or unlawful audio.</li>
                <li>Generated audio is your responsibility.</li>
                <li>Voices are synthetic; no real person's likeness is licensed to you.</li>
              </ul>
              <p className="text-xs text-slate-500">
                <a href="https://huggingface.co/hexgrad/Kokoro-82M" target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-slate-300">Model card</a>
                {" · "}
                <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-slate-300">Apache-2.0</a>
              </p>
            </div>
            <div className="mt-5 flex gap-3">
              <button onClick={acceptLicense} className="inline-flex flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-brand to-brand-2 py-2.5 text-sm font-semibold text-white transition hover:opacity-95">
                Accept &amp; continue
              </button>
              {licensed ? (
                <button onClick={revokeLicense} className="inline-flex items-center justify-center rounded-xl border border-white/[0.09] bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-rose-500/50 hover:text-rose-300">
                  Revoke
                </button>
              ) : (
                <button onClick={() => setShowLicense(false)} className="inline-flex items-center justify-center rounded-xl border border-white/[0.09] bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-brand/40">
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RowCard({ row, idx, voices, audioUrl, canRemove, onUpdate, onRemove }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-4 transition hover:border-white/[0.11]">
      {/* row top: number + remove */}
      <div className="mb-3 flex items-center justify-between">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand/20 text-[11px] font-bold text-brand">
          {idx + 1}
        </span>
        {canRemove && (
          <button
            onClick={onRemove}
            className="rounded-md px-2 py-0.5 text-xs text-slate-600 transition hover:bg-rose-500/10 hover:text-rose-400"
          >
            Remove
          </button>
        )}
      </div>

      {/* textarea */}
      <textarea
        value={row.text}
        onChange={(e) => onUpdate({ text: e.target.value })}
        placeholder="Paste or type text here…"
        rows={3}
        className="mb-3 w-full resize-y rounded-lg border border-white/[0.07] bg-white/[0.04] px-3 py-2.5 text-sm leading-relaxed text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
      />

      {/* voice + speed inline */}
      <div className="flex items-center gap-3">
        {/* voice select */}
        <div className="relative min-w-0 flex-1">
          <select
            value={row.voice}
            onChange={(e) => onUpdate({ voice: e.target.value })}
            className="w-full appearance-none rounded-lg border border-white/[0.07] bg-white/[0.04] py-2 pl-3 pr-8 text-xs text-slate-200 outline-none transition focus:border-brand/50"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>

        {/* speed */}
        <div className="flex shrink-0 items-center gap-2">
          <span className="w-9 text-right text-[11px] tabular-nums text-slate-400">{Number(row.speed).toFixed(2)}×</span>
          <input
            type="range" min="0.5" max="2" step="0.05"
            value={row.speed}
            onChange={(e) => onUpdate({ speed: e.target.value })}
            className="w-24 cursor-pointer"
          />
        </div>
      </div>

      {/* audio player — only when ready */}
      {audioUrl && (
        <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.03] p-2">
          <audio controls src={audioUrl} className="h-8 w-full" />
        </div>
      )}
    </div>
  );
}
