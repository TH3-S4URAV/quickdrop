# QuickDrop Final V3 🚀

QuickDrop is a fast, lightweight, browser-based file-sharing application supporting both **Nearby Transfer** (local Wi-Fi) and **Remote Transfer** (public internet/WAN).

It transfers small documents or massive files (up to 10+ GB) seamlessly across laptops and smartphones without requiring third-party cloud apps, account registration, or native app installations.

---

## 🌟 What's New in V3

### 1. Dual Transfer Modes
- **📶 Nearby Transfer (Local Network)**
  - Direct peer transfers across devices connected to the same Wi-Fi router.
  - 100% offline-ready: requires zero internet connectivity and never touches external servers.
  - Full Wi-Fi bandwidth utilization (30–80+ MB/s depending on router).
  - Preserves the streamlined V1 local sharing workflow.
- **🌐 Remote Transfer (Any Device, Any Network)**
  - Share files across distant locations and cellular networks (e.g. from Patna to another city).
  - Chunked, resumable upload engine (5 MB slices) with pause, resume, and cancel capabilities.
  - Multi-file batch selection with automatic on-the-fly streaming ZIP generation.
  - Security & Privacy: Optional PIN protection with `scrypt` password hashing and brute-force rate-limiting (lockout after 5 failed attempts).
  - Self-Destructing Expiry: Configurable lifetimes (1 hour, 24 hours, 7 days) with background cleanup worker that automatically prunes storage.

### 2. Core Technical Strengths
- **Zero Dependencies**: Pure Node.js built-ins (`http`, `fs`, `crypto`, `stream`, `zlib`, `os`). Zero `npm install` requirements.
- **Memory-Safe Architecture**: Handles files up to 10+ GB with bounded RAM usage (<50 MB) through Node.js streaming pipelines and slice-based temporary storage.
- **Offline QR Code Engine**: Standalone pure-JS QR code generator embedded directly in the frontend; works without third-party APIs.
- **Resumable Downloads**: Full HTTP Range header (`206 Partial Content`) support for reliable large-file downloads on mobile and desktop browsers.
- **Real-Time Progress & ETA**: Live transfer metrics (speed in `MB/s`, transferred bytes, percentage, ETA) via Server-Sent Events (SSE) with fallback polling.

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js version 20 or newer (installed at `D:\Downloads\node` on this system).

### 2. Start the Application
In PowerShell:
```powershell
$env:PATH = "D:\Downloads\node;" + $env:PATH
node server.js
```
The server will start on `http://0.0.0.0:4173`.

### 3. Environment Variables
Create a `.env` file (based on `.env.example`) to customize settings:
```bash
PORT=4173
PUBLIC_BASE_URL=https://drop.yourdomain.com
MAX_FILE_SIZE_BYTES=10737418240  # 10 GB
CHUNK_SIZE_BYTES=5242880         # 5 MB
STORAGE_BACKEND=local            # local | s3
STORAGE_DIR=./storage
SECRET_KEY=secure-random-32-byte-hex-string
```

---

## 📱 User Guides

### Mode 1: Nearby Transfer (Wi-Fi)
1. Ensure both devices (Laptop & Phone, or two Laptops) are connected to the same Wi-Fi network.
2. Select the **Nearby** tab at the top of QuickDrop.
3. Drop or browse for a file and click **Create local sharing link →**.
4. Scan the QR code with your phone camera (or copy the local IP link to another computer).
5. Receiver taps **Download File ↓** to stream directly from device to device at full local Wi-Fi speed.

### Mode 2: Remote Transfer (Anywhere)
1. Select the **Remote** tab.
2. Select one or multiple files.
3. Configure your preferences:
   - **Share Expiry**: Choose between 1 hour, 24 hours (default), or 7 days.
   - **PIN Protection**: Check the box and enter a 4–8 digit PIN if you want encrypted token-gated access.
4. Click **Upload & Generate Remote Link →**.
   - Monitor real-time upload speed, chunk progress, and estimated time remaining.
   - Use **Pause** or **Resume** at any time.
5. Once uploaded, share the public URL or QR code with the receiver anywhere in the world.
6. **Receiver Experience**:
   - If protected: Enter the sender's PIN to unlock access.
   - For multi-file batches: Download individual files or click **Download All as ZIP (📦)** to stream an on-the-fly generated ZIP archive.

---

## 🧪 Automated Testing

QuickDrop includes a comprehensive automated test suite built with the Node.js native test runner (`node:test`):
```powershell
$env:PATH = "D:\Downloads\node;" + $env:PATH
node --test
```

### Verified Test Suites:
1. **Range Parsing**: Full and partial byte-range downloads (`206 Partial Content`).
2. **PIN Security**: `scrypt` key derivation, HMAC-SHA256 bearer tokens, and brute-force lockout.
3. **Network Priority**: Intelligent sorting of physical Wi-Fi/Ethernet adapters over virtual adapters.
4. **Local Streaming**: End-to-end streamed local upload, download, and manifest synchronization.
5. **Remote Chunking & Resuming**: 5 MB slice uploads, `/status` verification, and assembly.
6. **Brute-Force Rate Limiting**: 5 failed PIN attempts trigger automatic 60-second lockout (HTTP 429).
7. **Automated Expiration Cleanup**: Auto-deletion of expired files and manifests.
8. **Streaming ZIP Generator**: Dynamic multi-file archive streaming with valid binary CRC-32 checksums.
9. **Static Frontend Serving**: Verifies `index.html`, `share.html`, `styles.css`, `qrcode.js`, `app.js`, and `share.js`.
10. **End-to-End Workflow**: Full token-gated, PIN-protected multi-step remote transfer workflow.

---

## 📁 Project Structure

```
quickdrop/
├── .env.example         # Environment configuration template
├── .gitignore           # Git ignore for temp files & storage
├── package.json         # Project metadata and npm test script
├── README.md            # Comprehensive documentation
├── server.js            # Dual-mode HTTP server, streaming ZIP & security engine
├── public/
│   ├── index.html       # Dual-mode desktop/mobile UI (Nearby & Remote)
│   ├── share.html       # Receiver page (PIN unlock & multi-file/ZIP downloads)
│   ├── app.js           # Client-side controller & ChunkedUploader
│   ├── share.js         # Receiver controller (SSE listener & PIN unlock)
│   ├── styles.css       # Clean, modern dark responsive design
│   └── qrcode.js        # Pure-JS offline QR code generator
├── storage/             # Managed storage directories
│   ├── nearby/          # Temporary local shares
│   ├── remote/          # Remote transfer assets
│   └── parts/           # Active chunked upload temporary slices
└── test/
    └── server.test.js   # Native Node.js test suite (10 test suites)
```

