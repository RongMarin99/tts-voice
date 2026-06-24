"use client";

import { useEffect, useRef, useState } from "react";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const LICENSE_KEY = "tts-voice:license-accepted:v1";

// Fallback voice list (used until model reports its own). id -> label.
const FALLBACK_VOICES = [
  { id: "af_heart", label: "Heart — US Female" },
  { id: "af_bella", label: "Bella — US Female" },
  { id: "af_nicole", label: "Nicole — US Female" },
  { id: "am_michael", label: "Michael — US Male" },
  { id: "am_adam", label: "Adam — US Male" },
  { id: "bf_emma", label: "Emma — UK Female" },
  { id: "bm_george", label: "George — UK Male" },
];

// Encode merged Float32 PCM into a 16-bit WAV blob.
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

// Split long text into model-friendly chunks (sentence-aware).
function chunkText(text, max = 400) {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      chunks.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

export default function Home() {
  const [text, setText] = useState(
    "Welcome. This voice is generated locally in your browser — free, unlimited, and downloadable."
  );
  const [voices, setVoices] = useState(FALLBACK_VOICES);
  const [voice, setVoice] = useState("af_heart");
  const [speed, setSpeed] = useState(1);
  const [modelState, setModelState] = useState("idle"); // idle | loading | ready | error
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState(""); // "" | ok | err
  const [audioUrl, setAudioUrl] = useState("");
  const [device, setDevice] = useState("");
  const [licensed, setLicensed] = useState(false);
  const [showLicense, setShowLicense] = useState(false);

  const ttsRef = useRef(null);
  const urlRef = useRef("");

  useEffect(() => {
    try {
      setLicensed(localStorage.getItem(LICENSE_KEY) === "1");
    } catch {}
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  function acceptLicense() {
    try {
      localStorage.setItem(LICENSE_KEY, "1");
    } catch {}
    setLicensed(true);
    setShowLicense(false);
  }

  function revokeLicense() {
    try {
      localStorage.removeItem(LICENSE_KEY);
    } catch {}
    setLicensed(false);
  }

  function say(msg, kind = "") {
    setStatus(msg);
    setStatusKind(kind);
  }

  async function loadModel() {
    if (ttsRef.current) return ttsRef.current;
    setModelState("loading");
    say("Loading voice model (~80–300MB, first time only)…");
    const { KokoroTTS } = await import("kokoro-js");
    const dev = typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm";
    setDevice(dev);
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: dev === "webgpu" ? "fp32" : "q8",
      device: dev,
    });
    ttsRef.current = tts;

    // Pull real voice list from the model if available.
    try {
      const v = tts.voices || {};
      const list = Object.keys(v).map((id) => {
        const meta = v[id] || {};
        const lang =
          meta.language === "en-gb" ? "UK" : meta.language === "en-us" ? "US" : meta.language || "";
        const g = meta.gender ? meta.gender : "";
        const name = meta.name || id;
        return { id, label: `${name} — ${lang} ${g}`.trim() };
      });
      if (list.length) setVoices(list);
    } catch {}

    setModelState("ready");
    say(`Model ready (${dev}).`, "ok");
    return tts;
  }

  async function generate() {
    if (!licensed) {
      setShowLicense(true);
      return;
    }
    if (!text.trim()) {
      say("Type some text first.", "err");
      return;
    }
    setBusy(true);
    setProgress(0);
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
      setAudioUrl("");
    }
    try {
      const tts = await loadModel();
      const chunks = chunkText(text);
      const parts = [];
      let sr = 24000;
      for (let i = 0; i < chunks.length; i++) {
        say(`Generating ${i + 1}/${chunks.length}…`);
        const audio = await tts.generate(chunks[i], { voice, speed: Number(speed) });
        parts.push(audio.audio); // RawAudio: .audio (Float32Array) + .sampling_rate
        sr = audio.sampling_rate || sr;
        setProgress(Math.round(((i + 1) / chunks.length) * 100));
      }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const merged = new Float32Array(total);
      let off = 0;
      for (const p of parts) {
        merged.set(p, off);
        off += p.length;
      }
      const blob = encodeWav(merged, sr);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setAudioUrl(url);
      say("Done. Play or download below.", "ok");
    } catch (e) {
      console.error(e);
      say("Error: " + (e?.message || String(e)), "err");
    } finally {
      setBusy(false);
    }
  }

  const dotColor =
    modelState === "ready" ? "bg-emerald-400" : modelState === "loading" ? "bg-amber-400 animate-pulse" : "bg-slate-500";

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* ambient gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(109,139,255,0.22),transparent)] blur-2xl" />
        <div className="absolute top-1/3 -right-24 h-[360px] w-[360px] rounded-full bg-[radial-gradient(closest-side,rgba(160,107,255,0.18),transparent)] blur-2xl" />
      </div>

      <div className="mx-auto w-full max-w-3xl px-5 py-12 sm:py-16">
        {/* header */}
        <header className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-brand-2 shadow-lg shadow-brand/30">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="currentColor">
                <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">TTS Voice</h1>
              <p className="text-xs text-slate-400">Natural · Unlimited · Local</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-line bg-panel/60 px-3 py-1.5 text-xs text-slate-300 backdrop-blur">
            <span className={`h-2 w-2 rounded-full ${dotColor}`} />
            {modelState === "ready" ? `Ready · ${device}` : modelState === "loading" ? "Loading…" : "Idle"}
          </div>
        </header>

        {/* hero */}
        <div className="mb-8">
          <h2 className="bg-gradient-to-r from-white to-slate-400 bg-clip-text text-3xl font-extrabold leading-tight tracking-tight text-transparent sm:text-4xl">
            Turn text into natural speech
          </h2>
          <p className="mt-2 max-w-xl text-sm text-slate-400">
            Free and unlimited. Runs entirely in your browser with the Kokoro neural model — no API key, no quota, your
            text never leaves the device.
          </p>
        </div>

        {/* main card */}
        <section className="rounded-2xl border border-line bg-panel/70 p-5 shadow-2xl shadow-black/40 backdrop-blur sm:p-6">
          {/* text */}
          <div className="mb-5">
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="txt" className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Text
              </label>
              <span className="text-xs tabular-nums text-slate-500">{text.length} chars</span>
            </div>
            <textarea
              id="txt"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste any text — long is fine, it's chunked automatically."
              className="min-h-44 w-full resize-y rounded-xl border border-line bg-panel-2 p-4 text-[15px] leading-relaxed text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-brand/60 focus:ring-2 focus:ring-brand/30"
            />
          </div>

          {/* controls */}
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="voice" className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Voice
              </label>
              <div className="relative">
                <select
                  id="voice"
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className="w-full appearance-none rounded-xl border border-line bg-panel-2 px-4 py-3 pr-10 text-[15px] text-slate-100 outline-none transition focus:border-brand/60 focus:ring-2 focus:ring-brand/30"
                >
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <svg
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="speed" className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Speed
                </label>
                <span className="text-xs tabular-nums text-slate-300">{Number(speed).toFixed(2)}×</span>
              </div>
              <input
                id="speed"
                type="range"
                min="0.5"
                max="2"
                step="0.05"
                value={speed}
                onChange={(e) => setSpeed(e.target.value)}
                className="mt-3 w-full cursor-pointer"
              />
            </div>
          </div>

          {/* actions */}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              onClick={generate}
              disabled={busy || modelState === "loading"}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-brand-2 px-5 py-3 text-[15px] font-semibold text-white shadow-lg shadow-brand/30 transition hover:opacity-95 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Generating…
                </>
              ) : modelState === "ready" ? (
                "Generate speech"
              ) : (
                "Load model & generate"
              )}
            </button>

            <a
              href={audioUrl || undefined}
              download={audioUrl ? "tts-voice.wav" : undefined}
              aria-disabled={!audioUrl}
              className={`inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-panel-2 px-5 py-3 text-[15px] font-semibold text-slate-100 transition hover:border-brand/50 ${
                audioUrl ? "" : "pointer-events-none opacity-50"
              }`}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Download WAV
            </a>
          </div>

          {/* progress */}
          {busy && (
            <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand to-brand-2 transition-all"
                style={{ width: progress + "%" }}
              />
            </div>
          )}

          {/* status */}
          {status && (
            <p
              className={`mt-4 text-sm ${
                statusKind === "ok" ? "text-emerald-400" : statusKind === "err" ? "text-rose-400" : "text-slate-400"
              }`}
            >
              {status}
            </p>
          )}

          {/* audio */}
          {audioUrl && (
            <div className="mt-5 rounded-xl border border-line bg-panel-2 p-3">
              <audio controls src={audioUrl} className="w-full" />
            </div>
          )}
        </section>

        {/* feature chips */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Natural", "Kokoro-82M neural"],
            ["Unlimited", "No quota, local"],
            ["Download", "16-bit WAV"],
            ["Private", "Stays on device"],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-line bg-panel/50 p-3 backdrop-blur">
              <div className="text-sm font-semibold text-slate-100">{t}</div>
              <div className="text-xs text-slate-400">{d}</div>
            </div>
          ))}
        </div>

        <footer className="mt-8 flex flex-col items-center gap-2 text-center text-xs text-slate-500">
          <div>
            Powered by Kokoro-82M (ONNX){device && ` · ${device}`} · no API key · no quota
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowLicense(true)}
              className="underline decoration-dotted underline-offset-2 transition hover:text-slate-300"
            >
              Voice license
            </button>
            {licensed && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-400">
                <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M7.5 13.5 4 10l1.4-1.4 2.1 2.1L14.6 3.6 16 5z" />
                </svg>
                Accepted
              </span>
            )}
          </div>
        </footer>
      </div>

      {/* license consent gate */}
      {showLicense && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowLicense(false)}
          />
          <div className="relative w-full max-w-lg rounded-2xl border border-line bg-panel p-6 shadow-2xl shadow-black/60">
            <div className="mb-4 flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand/15 text-brand">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" strokeLinejoin="round" />
                </svg>
              </div>
              <h3 className="text-lg font-bold tracking-tight">Voice & model license</h3>
            </div>

            <div className="max-h-64 space-y-3 overflow-y-auto pr-1 text-sm leading-relaxed text-slate-300">
              <p>
                This app uses the <strong>Kokoro-82M</strong> text-to-speech model and its bundled voice packs, released
                under the <strong>Apache License 2.0</strong>. The model and voices are free for personal and commercial
                use.
              </p>
              <p>By continuing you agree that:</p>
              <ul className="list-disc space-y-1 pl-5 text-slate-400">
                <li>You hold rights to the text you synthesize.</li>
                <li>You will not impersonate real people or generate deceptive, harmful, or unlawful audio.</li>
                <li>Generated audio is your responsibility, not the app's.</li>
                <li>Voices are synthetic; no real person's likeness is licensed to you.</li>
              </ul>
              <p className="text-xs text-slate-500">
                Kokoro-82M:{" "}
                <a
                  href="https://huggingface.co/hexgrad/Kokoro-82M"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-slate-300"
                >
                  model card
                </a>{" "}
                · Apache-2.0:{" "}
                <a
                  href="https://www.apache.org/licenses/LICENSE-2.0"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-slate-300"
                >
                  full text
                </a>
              </p>
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button
                onClick={acceptLicense}
                className="inline-flex flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-brand to-brand-2 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-brand/30 transition hover:opacity-95 active:translate-y-px"
              >
                Accept &amp; continue
              </button>
              {licensed ? (
                <button
                  onClick={revokeLicense}
                  className="inline-flex items-center justify-center rounded-xl border border-line bg-panel-2 px-5 py-3 text-sm font-semibold text-slate-200 transition hover:border-rose-500/50 hover:text-rose-300"
                >
                  Revoke
                </button>
              ) : (
                <button
                  onClick={() => setShowLicense(false)}
                  className="inline-flex items-center justify-center rounded-xl border border-line bg-panel-2 px-5 py-3 text-sm font-semibold text-slate-200 transition hover:border-brand/50"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
