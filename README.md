# TTS Voice

Natural text-to-speech. Free, unlimited, no API key. Runs **fully in your browser** with the Kokoro-82M neural model (ONNX/WASM, WebGPU when available). Text never leaves your device.

## Features

- Natural neural voices (Kokoro-82M)
- Unlimited length — long text auto-chunked then merged into one file
- Voice picker (US/UK, male/female)
- Speed control (0.5x–2x)
- Play in-page + **Download WAV**
- No backend, no quota, offline after first model download

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000

First generate downloads the model (~80–300MB) once, then caches in the browser.

## Build

```bash
npm run build
npm start
```

## Stack

- Next.js 15 (App Router)
- React 19
- [kokoro-js](https://www.npmjs.com/package/kokoro-js) (Kokoro-82M via Transformers.js / onnxruntime-web)

## Notes

- WebGPU (Chrome/Edge) = fastest. Falls back to WASM (q8) elsewhere.
- Output is 16-bit mono WAV at the model sample rate (24kHz).
- Want MP3 download or server-side generation? Ask — easy to add.
