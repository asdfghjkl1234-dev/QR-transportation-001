# QR Transportation

**A no-internet, one-way, screen-to-camera visual data transfer protocol.**

No Wi-Fi, no Bluetooth, no pairing, no server. One device flashes encoded
patterns on its screen; another device points a camera at it and rebuilds the
file. That's the entire transport layer.

[繁體中文技術文件 (v1 protocol details)](README.zh-TW.md) · [v2: multi-QR speed mode](v2/README.md) · [v3: color matrix codec](v3/README.md)

[![Tests](https://github.com/asdfghjkl1234-dev/QR-transportation-001/actions/workflows/test.yml/badge.svg)](https://github.com/asdfghjkl1234-dev/QR-transportation-001/actions/workflows/test.yml)
[![Deploy to GitHub Pages](https://github.com/asdfghjkl1234-dev/QR-transportation-001/actions/workflows/static.yml/badge.svg)](https://github.com/asdfghjkl1234-dev/QR-transportation-001/actions/workflows/static.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/asdfghjkl1234-dev/QR-transportation-001?style=social)](https://github.com/asdfghjkl1234-dev/QR-transportation-001/stargazers)

<!-- TODO: replace with a real phone-scanning-a-screen capture — this is the single most persuasive
     asset this repo can have. A 10–15s clip/GIF of the flickering code grid + the receiver's
     live progress overlay goes here, above everything else. -->
> 🎥 **Demo — coming soon.** *(A screen-to-camera transfer is the kind of thing that has to be
> seen to be believed. Until the clip lands here, run it yourself in under two minutes — see
> [Quick start](#quick-start).)*

---

## How it works

```
  sender (any file)
        │
        │  encode — fountain code (LT) + error correction
        ▼
  screen flashes a code stream
        │
        │  optical channel — no cable, no network, just light
        ▼
  camera points at the screen
        │
        │  decode — inverse pipeline (locate → correct geometry → classify → ECC)
        ▼
  receiver — reassembled file, SHA-256 verified
```

There is no return channel — the receiver can never ask the sender to resend
a specific chunk. Every design decision in this repo exists to make that
constraint cheap: a **fountain code** (Luby Transform) turns "did you get
frame #412?" into a non-question, because every frame carries fresh,
statistically useful information regardless of what was missed before it.

## Three generations, one problem

The repo ships three independent, coexisting implementations. Each one
attacks the same bottleneck — how much *reliable* information can you push
through a consumer camera pointed at a consumer screen — from a different
angle.

| Version | Encoding | Measured throughput | Core technique |
|---|---|---|---|
| **[v1](README.zh-TW.md)** | Single flickering QR code | ~5–15 KB/s | LT fountain code (Robust Soliton degree distribution), systematic-block-first, CRC32-gated peeling decoder |
| **[v2](v2/README.md)** | Multi-QR grid (1×1–3×3) + Base45 | 8–108 KB/s (measured, headless Chromium) | Base45/RFC 9285 alphanumeric packing (97% code efficiency vs. 75% for base64), one decode pass over N codes/frame, inactivation decoding |
| **[v3](v3/README.md)** | Full-screen color matrix (libcimbar-style) | 6–72 KB/s theoretical *(no physical camera available yet — see [Known limitations](#known-limitations))* | Homography + radial-distortion geometric calibration, two-layer ECC (Reed–Solomon + LT), confidence-weighted erasure decoding |

Full derivations, test methodology, and every number's provenance live in
each version's own README — nothing above is asserted without a test behind
it.

## Why a fountain code

The naive approach — slice the file into N chunks, play them in order, loop
— breaks the moment you accept that this is a **one-way** channel. If frame
3 and frame 700 get missed, the receiver has to sit through an entire replay
loop to get them back, and 99% of that loop is data it already has.

A **Luby Transform fountain code** removes the concept of "the next chunk"
entirely. Every frame is a fresh, randomly generated XOR combination of
source blocks — the receiver doesn't care *which* frames it caught, only
*how many*. Drop 20%, drop 40%, drop them in any order: the transfer gets
slower, never stuck.

```
source blocks   [0] [1] [2] [3] [4] ...
                   \   |   /
                    XOR together
                       ↓
encoded block   ( 0 ⊕ 2 ⊕ 3 )     ← a brand-new combination, every single frame
```

## Highlights

- 🌊 **Fountain-code loss tolerance** — LT codes with Robust Soliton degree
  distribution; verified end-to-end at 0–90% simulated frame loss with zero
  transfer failures (only slowdowns). Systematic blocks are sent first so a
  clean signal decodes in exactly one pass, with zero fountain-code overhead.
- 🔤 **Base45 alphanumeric packing** — RFC 9285 encoding lands at 97% payload
  efficiency inside QR's alphanumeric mode, versus 75% for the naive
  base64-in-byte-mode approach v1 started with.
- 🎨 **Color-matrix modulation** — v3 drops QR entirely for a custom
  full-screen palette-coded grid (2–5 bits/cell), with CIELAB-distance-tuned
  palettes and an experimental corner-notch shape layer for extra density.
- 🧵 **Two-layer error correction** — GF(256) Reed–Solomon with
  confidence-based erasure marking (interleaved so a glare spot can't wipe
  out one codeword) wrapped in an outer LT fountain layer, so losing an
  entire frame is just a dropped fountain packet, not a failure.
- ⚡ **Geometry-first decode optimization** — profiling showed 90%+ of
  per-frame decode cost was homography/geometric calibration, not per-cell
  classification. Fixing *that* (not GPU-izing classification, which would
  have optimized the wrong 10%) delivered a 2.8× decode speedup (276 ms →
  99 ms/frame). WebGL2 remains the identified next step — for template
  matching in the experimental high-density shape layer, where it would
  actually move the needle.
- 📴 **Zero build, zero server, offline-capable** — static HTML/ES modules,
  CDN libraries with local `vendor/` fallbacks so it still works with no
  network reachability except the screen-to-camera link itself.

## Quick start

No build step — this is static HTML and ES modules. Push the folder to any
static host.

```sh
npx serve -l 8080 .
# open http://localhost:8080/test.html to run the offline verification
# suite (no camera required), then open sender.html / receiver.html
```

**Camera access requires a secure context** — `localhost` works for local
testing, but scanning from a real phone needs **HTTPS**.

**Deploy to GitHub Pages**
1. Push this repo to GitHub
2. Settings → Pages → Source: *Deploy from a branch* → branch `main` (or your
   default branch), folder `/ (root)`
3. Your sender lives at `https://<user>.github.io/<repo>/sender.html`

**Deploy to Vercel**
```sh
npm i -g vercel
vercel deploy --prod
```
No config file needed — Vercel serves the folder as-is.

**Local + HTTPS tunnel** (for testing against a phone without deploying)
```sh
npx serve -l 8080 .
cloudflared tunnel --url http://localhost:8080   # or ngrok / tailscale funnel
```
Open the sender at `localhost:8080` (no camera needed there) and the
receiver at the HTTPS tunnel URL on your phone.

## Simulate before you point a camera at it

Every generation in this repo was built and validated **against a synthetic
channel simulator before a single real photon hit a real camera sensor** —
because a decode failure on real hardware gives you almost no information
about *which* of geometry, color, blur, or glare broke it, while a simulator
lets you isolate each variable and sweep it independently.

- **v1/v2**: `test.html` exercises the full encode → QR-render → jsQR-decode
  → peeling-decode → SHA-256-verify round trip with 30% simulated frame loss
  and full reordering, with no camera involved.
- **v3**: [`v3/simulator.html`](v3/simulator.html) is a dedicated synthetic
  camera channel — perspective + barrel distortion, lens blur, lighting
  gradients and glare, white balance/gamma/saturation shift, sensor noise,
  JPEG recompression, rolling-shutter tearing — each as an independent
  slider, plus a distortion-intensity sweep that plots cell-error-rate,
  sector-success-rate, and effective throughput as curves.

This caught real bugs *before* they were camera bugs: a barrel-distortion
model that wasn't radially symmetric, a shape-layer geometry residual that
looked fine at the frame edges and was silently off by 0.3 cells in the
interior, a decoy timing-track path that could out-score the real one under
noise. All three were found and fixed by staring at simulator sweeps, not by
debugging blurry phone footage. **If you're extending this repo — or building
something like it — get your format right in the simulator first.** It's the
difference between a bug you can bisect in seconds and one you can only
guess at from a shaky video.

## Known limitations

- **No real-camera measurements for v3 yet.** All v3 throughput numbers are
  simulator- and headless-Chromium-derived; there's no physical screen/phone
  in this development environment. The repo ships a fill-in-yourself
  benchmark table for exactly this reason — see the "實機量測（待補）"
  section of [`v3/README.md`](v3/README.md).
- **Glare, hand shake, and focus hunting** are the dominant real-world
  failure modes — far more than resolution. Glare above ~0.5 intensity can
  drop sector success to 83%; locking focus/exposure/white-balance (after
  ~1s of stable marker detection) helps, a tripod helps more. Autofocus
  "breathing" is the main reason a v3 frame occasionally fails to decode
  even when everything else about the shot is fine.
- **No encryption.** Anyone who can photograph the screen can reconstruct the
  data. Encrypt before you transfer if that matters to you.
- **Not a replacement for AirDrop/USB/LAN transfer for large files** — it
  exists for the case where none of those are available (air-gapped, no
  shared network, no cable) and you're willing to trade throughput for that.
- **v3's experimental shape layer only pays off on a tripod, dead-on to the
  screen.** Handheld, its density advantage evaporates — see
  [`v3/README.md`](v3/README.md) for the measured breakdown.

## Discoverability

If you maintain this repo, adding GitHub Topics helps people find it through
search and the Explore page. Go to the repo's main page → click the ⚙️ gear
icon next to **About** (top right) → add topics → Save changes. Suggested
topics:

`fountain-code` · `luby-transform` · `qrcode` · `data-transmission` ·
`offline-transfer` · `visual-encoding` · `reed-solomon` · `air-gapped` ·
`webrtc-alternative` · `screen-to-camera`

## Star history

If this scratches an itch — offline demos, air-gapped transfer, or you just
like watching fountain codes eat frame loss for breakfast — a star helps
other people find it. Issues and PRs (especially real-device v3 benchmark
numbers) are very welcome.

## License

[MIT](LICENSE)
