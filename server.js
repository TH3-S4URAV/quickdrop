const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = Number(process.env.PORT || 4173);
const DEFAULT_MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_BYTES || 10 * 1024 * 1024 * 1024); // 10 GB
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE_BYTES || (process.env.VERCEL ? 2.5 * 1024 * 1024 : 5 * 1024 * 1024));
const SECRET_KEY = process.env.SECRET_KEY || crypto.randomBytes(32).toString('hex');

// MIME Types table
const MIME_TYPES = {
  '.7z': 'application/x-7z-compressed',
  '.aac': 'audio/aac',
  '.apk': 'application/vnd.android.package-archive',
  '.avi': 'video/x-msvideo',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.dmg': 'application/x-apple-diskimage',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.epub': 'application/epub+zip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.html': 'text/html; charset=utf-8',
  '.iso': 'application/x-iso9660-image',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.msi': 'application/x-msi',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
};

// CRC32 Table for streaming ZIP generator
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  }
  CRC_TABLE[i] = c >>> 0;
}

function updateCrc32(buf, previousCrc = 0) {
  let crc = (previousCrc ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ -1) >>> 0;
}

function safeFilename(value) {
  const candidate = String(value || 'shared-file')
    .replace(/[\\/\0]/g, '_')
    .replace(/[\r\n]/g, ' ')
    .trim();
  return (candidate || 'shared-file').slice(0, 180);
}

function decodeFilename(headerValue) {
  try {
    return safeFilename(decodeURIComponent(String(headerValue || '')));
  } catch {
    return safeFilename(headerValue);
  }
}

function contentType(filename) {
  return MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function getNetworkInterfaces() {
  const interfaces = [];
  const nics = os.networkInterfaces();
  for (const [name, entries] of Object.entries(nics)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        const addr = entry.address;
        if (addr.startsWith('127.') || addr.startsWith('169.254.')) continue;
        let score = 10;
        const lowerName = name.toLowerCase();
        if (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wlan') || lowerName.includes('wireless')) {
          score += 100;
        } else if (lowerName.includes('eth') || lowerName.includes('ethernet') || lowerName.includes('lan')) {
          score += 50;
        }
        if (lowerName.includes('virtual') || lowerName.includes('vbox') || lowerName.includes('wsl') || lowerName.includes('hyper-v') || lowerName.includes('vethernet') || lowerName.includes('host-only') || addr.startsWith('192.168.56.')) {
          score -= 150;
        }
        if (addr.startsWith('192.168.') && !addr.startsWith('192.168.56.')) score += 40;
        else if (addr.startsWith('10.')) score += 30;
        else if (addr.startsWith('172.')) score += 20;

        interfaces.push({ address: addr, name, score });
      }
    }
  }
  interfaces.sort((a, b) => b.score - a.score);
  return interfaces;
}

function localAddresses() {
  return [...new Set(getNetworkInterfaces().map((i) => i.address))];
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function text(res, statusCode, message) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(message);
}

function isShareId(value) {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value || '');
}

function parseRange(rangeHeader, total) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return 'invalid';

  const [, startValue, endValue] = match;
  if (!startValue && !endValue) return 'invalid';
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(total - suffixLength, 0), end: total - 1 };
  }
  const start = Number(startValue);
  const end = endValue ? Number(endValue) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
    return 'invalid';
  }
  return { start, end: Math.min(end, total - 1) };
}

function encodeDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// PIN Hashing & Token utilities
function hashPin(pin) {
  if (!pin) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, storedPinHash) {
  if (!storedPinHash) return true;
  if (!pin) return false;
  const [salt, originalHash] = storedPinHash.split(':');
  if (!salt || !originalHash) return false;
  const candidateHash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(candidateHash, 'hex'));
}

function createAccessToken(shareId, validityMs = 24 * 3600 * 1000) {
  const expiresAt = Date.now() + validityMs;
  const payload = `${shareId}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex');
  return `${expiresAt}.${hmac}`;
}

function verifyAccessToken(shareId, token) {
  if (!token || typeof token !== 'string') return false;
  const [expiresAtStr, hmac] = token.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false;
  const payload = `${shareId}:${expiresAt}`;
  const expectedHmac = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expectedHmac, 'hex'));
  } catch {
    return false;
  }
}

// Streaming ZIP generator for multi-file downloads
function streamZip(res, filesList, storageDir) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': encodeDisposition('QuickDrop-Archive.zip'),
    'Cache-Control': 'no-store'
  });

  const centralDirectoryHeaders = [];
  let fileOffset = 0;

  (async function processNextFile(index) {
    if (index >= filesList.length) {
      // Write Central Directory
      const cdStart = fileOffset;
      for (const cdHeader of centralDirectoryHeaders) {
        res.write(cdHeader);
        fileOffset += cdHeader.length;
      }
      const cdEnd = fileOffset;
      const cdSize = cdEnd - cdStart;

      // End of Central Directory Record (22 bytes)
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); // Signature
      eocd.writeUInt16LE(0, 4); // Disk number
      eocd.writeUInt16LE(0, 6); // CD disk number
      eocd.writeUInt16LE(filesList.length, 8); // Disk entries
      eocd.writeUInt16LE(filesList.length, 10); // Total entries
      eocd.writeUInt32LE(cdSize, 12); // Size of CD
      eocd.writeUInt32LE(cdStart, 16); // Offset of CD
      eocd.writeUInt16LE(0, 20); // Comment length

      res.end(eocd);
      return;
    }

    const file = filesList[index];
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const localStart = fileOffset;
    let crc = 0;
    let bytesWritten = 0;

    // We write local header with CRC/size known from file stats
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
    localHeader.writeUInt16LE(0, 6); // Flags
    localHeader.writeUInt16LE(0, 8); // Compression method: 0 (Store)
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0, 12); // Mod date
    localHeader.writeUInt32LE(0, 14); // Temporary CRC (will fill if small, or use descriptor)
    localHeader.writeUInt32LE(file.size, 18); // Compressed size
    localHeader.writeUInt32LE(file.size, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // Filename length
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBuffer.copy(localHeader, 30);

    const filePath = path.join(storageDir, file.storedName);
    const readStream = fs.createReadStream(filePath);

    // Calculate CRC while streaming
    readStream.on('data', (chunk) => {
      crc = updateCrc32(chunk, crc);
      bytesWritten += chunk.length;
    });

    // Write file local header
    res.write(localHeader);
    fileOffset += localHeader.length;

    readStream.on('end', () => {
      fileOffset += bytesWritten;

      // Store Central Directory Header for later
      const cdHeader = Buffer.alloc(46 + nameBuffer.length);
      cdHeader.writeUInt32LE(0x02014b50, 0); // Signature
      cdHeader.writeUInt16LE(20, 4); // Version made by
      cdHeader.writeUInt16LE(20, 6); // Version needed
      cdHeader.writeUInt16LE(0, 8); // Flags
      cdHeader.writeUInt16LE(0, 10); // Compression method: 0
      cdHeader.writeUInt16LE(0, 12); // Mod time
      cdHeader.writeUInt16LE(0, 14); // Mod date
      cdHeader.writeUInt32LE(crc, 16); // CRC-32
      cdHeader.writeUInt32LE(file.size, 20); // Compressed size
      cdHeader.writeUInt32LE(file.size, 24); // Uncompressed size
      cdHeader.writeUInt16LE(nameBuffer.length, 28); // Filename length
      cdHeader.writeUInt16LE(0, 30); // Extra field length
      cdHeader.writeUInt16LE(0, 32); // Comment length
      cdHeader.writeUInt16LE(0, 34); // Disk number
      cdHeader.writeUInt16LE(0, 36); // Internal attributes
      cdHeader.writeUInt32LE(0, 38); // External attributes
      cdHeader.writeUInt32LE(localStart, 42); // Relative offset of local header
      nameBuffer.copy(cdHeader, 46);

      centralDirectoryHeaders.push(cdHeader);
      processNextFile(index + 1);
    });

    readStream.on('error', () => {
      res.destroy();
    });

    readStream.pipe(res, { end: false });
  })(0);
}

function createApp({ storageDir = process.env.STORAGE_DIR || (process.env.VERCEL ? path.join(os.tmpdir(), 'quickdrop') : path.join(__dirname, 'storage')) } = {}) {
  const nearbyDir = path.join(storageDir, 'nearby');
  const remoteDir = path.join(storageDir, 'remote');
  const partsDir = path.join(storageDir, 'parts');

  fs.mkdirSync(nearbyDir, { recursive: true });
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.mkdirSync(partsDir, { recursive: true });

  const nearbyManifestPath = path.join(nearbyDir, 'manifest.json');
  const remoteManifestPath = path.join(remoteDir, 'manifest.json');

  const shares = new Map(); // Combined registry
  const transferSubscribers = new Map(); // shareId -> Set of res
  const latestProgress = new Map(); // shareId -> progress object
  const pinAttemptLimit = new Map(); // ip:shareId -> { attempts, lockedUntil }

  function broadcastTransfer(id, data) {
    latestProgress.set(id, data);
    const subscribers = transferSubscribers.get(id);
    if (subscribers) {
      const message = `data: ${JSON.stringify(data)}\n\n`;
      for (const sub of subscribers) {
        try { sub.write(message); } catch {}
      }
    }
  }

  function loadManifest(filePath, mode) {
    try {
      const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const baseDir = mode === 'remote' ? remoteDir : nearbyDir;
      for (const share of Array.isArray(persisted) ? persisted : []) {
        if (!isShareId(share.id)) continue;
        // Verify files exist
        if (Array.isArray(share.files) && share.files.length > 0) {
          const valid = share.files.every((f) => fs.existsSync(path.join(baseDir, f.storedName)));
          if (valid) shares.set(share.id, share);
        } else if (share.storedName && fs.existsSync(path.join(baseDir, share.storedName))) {
          shares.set(share.id, {
            ...share,
            mode: share.mode || mode,
            files: share.files || [{ name: safeFilename(share.filename), size: share.size, storedName: share.storedName }]
          });
        }
      }
    } catch {}
  }

  function saveManifests() {
    const nearbyRecords = [];
    const remoteRecords = [];
    for (const share of shares.values()) {
      if (share.mode === 'remote') remoteRecords.push(share);
      else nearbyRecords.push(share);
    }
    try {
      fs.writeFileSync(`${nearbyManifestPath}.tmp`, JSON.stringify(nearbyRecords, null, 2));
      fs.renameSync(`${nearbyManifestPath}.tmp`, nearbyManifestPath);
    } catch {}
    try {
      fs.writeFileSync(`${remoteManifestPath}.tmp`, JSON.stringify(remoteRecords, null, 2));
      fs.renameSync(`${remoteManifestPath}.tmp`, remoteManifestPath);
    } catch {}
  }

  loadManifest(nearbyManifestPath, 'nearby');
  loadManifest(remoteManifestPath, 'remote');

  // Automatic Expiration & Temp File Cleanup Worker
  function cleanupExpiredShares() {
    const now = Date.now();
    let changed = false;
    for (const [id, share] of shares.entries()) {
      if (share.expiresAt && now > new Date(share.expiresAt).getTime()) {
        const baseDir = share.mode === 'remote' ? remoteDir : nearbyDir;
        if (Array.isArray(share.files)) {
          for (const f of share.files) {
            fs.rmSync(path.join(baseDir, f.storedName), { force: true });
          }
        }
        shares.delete(id);
        broadcastTransfer(id, { type: 'expired', status: 'expired' });
        changed = true;
      }
    }
    if (changed) saveManifests();
  }

  const cleanupTimer = setInterval(cleanupExpiredShares, 5 * 60 * 1000);

  function publicShare(share, token) {
    const isUnlocked = !share.pinHash || verifyAccessToken(share.id, token);
    return {
      id: share.id,
      mode: share.mode || 'nearby',
      filename: share.filename,
      size: share.totalSize || share.size,
      totalSize: share.totalSize || share.size,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt || null,
      isProtected: Boolean(share.pinHash),
      isUnlocked,
      downloadCount: share.downloadCount || 0,
      fileCount: Array.isArray(share.files) ? share.files.length : 1,
      files: isUnlocked && Array.isArray(share.files)
        ? share.files.map((f, i) => ({ index: i, name: f.name, size: f.size }))
        : undefined
    };
  }

  async function serveStatic(res, filename) {
    const fullPath = path.join(PUBLIC_DIR, filename);
    try {
      const data = await fsp.readFile(fullPath);
      res.writeHead(200, {
        'Content-Type': contentType(filename),
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
    } catch {
      text(res, 404, 'Not found');
    }
  }

  // --- NEARBY / LOCAL SHARE (Preserves V1 Flow) ---
  async function createNearbyShare(req, res) {
    const filename = decodeFilename(req.headers['x-file-name']);
    const expectedSize = Number(req.headers['x-file-size']);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      json(res, 400, { error: 'A valid file size is required.' });
      return;
    }
    if (expectedSize > DEFAULT_MAX_FILE_SIZE) {
      json(res, 400, { error: `File exceeds maximum allowed size (${Math.round(DEFAULT_MAX_FILE_SIZE / 1073741824)} GB).` });
      return;
    }

    const id = crypto.randomBytes(18).toString('base64url');
    const storedName = `${id}.bin`;
    const temporaryName = `${id}.part`;
    const targetPath = path.join(nearbyDir, storedName);
    const temporaryPath = path.join(nearbyDir, temporaryName);
    let receivedSize = 0;

    const meter = new Transform({
      transform(chunk, encoding, callback) {
        receivedSize += chunk.length;
        callback(null, chunk);
      }
    });

    try {
      await pipeline(req, meter, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
      if (receivedSize !== expectedSize) {
        await fsp.rm(temporaryPath, { force: true });
        json(res, 400, { error: 'The received bytes did not match the selected file.' });
        return;
      }
      await fsp.rename(temporaryPath, targetPath);
      const share = {
        id,
        mode: 'nearby',
        filename,
        size: receivedSize,
        totalSize: receivedSize,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        pinHash: null,
        storedName,
        files: [{ name: filename, size: receivedSize, storedName }],
        downloadCount: 0
      };
      shares.set(id, share);
      saveManifests();
      json(res, 201, {
        share: publicShare(share),
        addresses: localAddresses(),
        interfaces: getNetworkInterfaces().map((i) => ({ address: i.address, name: i.name }))
      });
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      if (!res.headersSent) {
        json(res, 500, { error: error.code === 'ENOSPC' ? 'There is not enough free disk space to prepare this share.' : 'The file could not be prepared for sharing.' });
      }
    }
  }

  // --- REMOTE SHARE: CHUNKED RESUMABLE FLOW ---
  async function initRemoteShare(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const filename = safeFilename(payload.filename);
        const totalSize = Number(payload.totalSize);
        const expiresInHours = Math.min(Math.max(Number(payload.expiresInHours) || 24, 1), 168); // 1h to 7 days
        const rawFiles = Array.isArray(payload.files) && payload.files.length > 0 ? payload.files : [{ name: filename, size: totalSize }];

        if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
          return json(res, 400, { error: 'Valid totalSize is required.' });
        }
        if (totalSize > DEFAULT_MAX_FILE_SIZE) {
          return json(res, 400, { error: `Total size exceeds maximum limit (${Math.round(DEFAULT_MAX_FILE_SIZE / 1073741824)} GB).` });
        }

        const id = crypto.randomBytes(20).toString('base64url');
        const uploadId = crypto.randomBytes(16).toString('hex');
        const sharePartsDir = path.join(partsDir, `${id}_${uploadId}`);
        await fsp.mkdir(sharePartsDir, { recursive: true });

        const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
        const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();
        const pinHash = payload.pin ? hashPin(payload.pin) : null;

        const files = rawFiles.map((f, idx) => ({
          name: safeFilename(f.name),
          size: Number(f.size) || 0,
          storedName: `${id}_${idx}.bin`
        }));

        const share = {
          id,
          uploadId,
          mode: 'remote',
          filename: rawFiles.length > 1 ? `${rawFiles.length} files.zip` : filename,
          totalSize,
          size: totalSize,
          files,
          createdAt: new Date().toISOString(),
          expiresAt,
          pinHash,
          status: 'uploading',
          totalChunks,
          chunkSize: CHUNK_SIZE,
          receivedChunks: [],
          downloadCount: 0
        };

        shares.set(id, share);
        saveManifests();

        json(res, 201, {
          shareId: id,
          uploadId,
          chunkSize: CHUNK_SIZE,
          totalChunks,
          expiresAt,
          isProtected: Boolean(pinHash)
        });
      } catch (err) {
        json(res, 400, { error: 'Invalid initialization request.' });
      }
    });
  }

  async function uploadChunk(req, res, shareId) {
    const share = shares.get(shareId);
    if (!share) return json(res, 404, { error: 'Share session not found.' });

    const uploadId = req.headers['x-upload-id'];
    const chunkIndex = Number(req.headers['x-chunk-index']);

    if (!uploadId || uploadId !== share.uploadId) {
      return json(res, 400, { error: 'Invalid upload session ID.' });
    }
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= share.totalChunks) {
      return json(res, 400, { error: 'Invalid chunk index.' });
    }

    const sharePartsDir = path.join(partsDir, `${shareId}_${uploadId}`);
    const chunkPath = path.join(sharePartsDir, `chunk_${chunkIndex}.part`);

    try {
      await pipeline(req, fs.createWriteStream(chunkPath));
      if (!share.receivedChunks.includes(chunkIndex)) {
        share.receivedChunks.push(chunkIndex);
      }
      json(res, 200, {
        received: true,
        chunkIndex,
        receivedCount: share.receivedChunks.length,
        totalChunks: share.totalChunks
      });
    } catch (err) {
      json(res, 500, { error: 'Failed to write chunk.' });
    }
  }

  async function getUploadStatus(res, shareId, uploadId) {
    const share = shares.get(shareId);
    if (!share) return json(res, 404, { error: 'Share not found.' });
    if (uploadId && share.uploadId !== uploadId) {
      return json(res, 400, { error: 'Upload ID mismatch.' });
    }
    json(res, 200, {
      shareId,
      status: share.status,
      receivedChunks: share.receivedChunks || [],
      totalChunks: share.totalChunks,
      totalSize: share.totalSize
    });
  }

  async function finalizeRemoteShare(req, res, shareId) {
    const share = shares.get(shareId);
    if (!share) return json(res, 404, { error: 'Share not found.' });

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.uploadId !== share.uploadId) {
          return json(res, 400, { error: 'Upload session ID mismatch.' });
        }

        const sharePartsDir = path.join(partsDir, `${shareId}_${share.uploadId}`);
        // Ensure all chunks are received
        for (let i = 0; i < share.totalChunks; i++) {
          const chunkPath = path.join(sharePartsDir, `chunk_${i}.part`);
          if (!fs.existsSync(chunkPath)) {
            return json(res, 400, { error: `Missing chunk ${i}. Please resume upload.` });
          }
        }

        // Concatenate chunks into assembled file
        const combinedTempPath = path.join(sharePartsDir, 'assembled.tmp');
        const writeStream = fs.createWriteStream(combinedTempPath);

        for (let i = 0; i < share.totalChunks; i++) {
          const chunkPath = path.join(sharePartsDir, `chunk_${i}.part`);
          const readChunk = fs.createReadStream(chunkPath);
          await new Promise((resolve, reject) => {
            readChunk.pipe(writeStream, { end: false });
            readChunk.on('end', resolve);
            readChunk.on('error', reject);
          });
        }
        await new Promise((resolve) => writeStream.end(resolve));

        // If single file: move directly to remote storage
        if (share.files.length <= 1) {
          const targetPath = path.join(remoteDir, share.files[0].storedName);
          await fsp.rename(combinedTempPath, targetPath);
        } else {
          // Multi-file batch: slice assembled stream into each individual file
          let currentOffset = 0;
          for (const file of share.files) {
            const targetPath = path.join(remoteDir, file.storedName);
            const sliceStream = fs.createReadStream(combinedTempPath, {
              start: currentOffset,
              end: Math.max(currentOffset, currentOffset + file.size - 1)
            });
            await pipeline(sliceStream, fs.createWriteStream(targetPath));
            currentOffset += file.size;
          }
          await fsp.rm(combinedTempPath, { force: true }).catch(() => {});
        }

        // Clean up parts dir
        await fsp.rm(sharePartsDir, { recursive: true, force: true }).catch(() => {});

        share.status = 'ready';
        delete share.receivedChunks;
        delete share.uploadId;
        saveManifests();

        json(res, 200, { share: publicShare(share) });
      } catch (err) {
        json(res, 500, { error: 'Could not assemble upload.' });
      }
    });
  }

  // --- PIN UNLOCK & VERIFICATION ---
  async function unlockShare(req, res, shareId) {
    const share = shares.get(shareId);
    if (!share) return json(res, 404, { error: 'Share not found.' });

    const clientIp = req.socket.remoteAddress || 'unknown';
    const limitKey = `${clientIp}:${shareId}`;
    const limitRecord = pinAttemptLimit.get(limitKey) || { attempts: 0, lockedUntil: 0 };

    if (Date.now() < limitRecord.lockedUntil) {
      const waitSecs = Math.ceil((limitRecord.lockedUntil - Date.now()) / 1000);
      return json(res, 429, { error: `Too many failed attempts. Try again in ${waitSecs} seconds.` });
    }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { pin } = JSON.parse(body || '{}');
        if (!share.pinHash) {
          const token = createAccessToken(shareId);
          return json(res, 200, { ok: true, token, share: publicShare(share, token) });
        }

        if (verifyPin(pin, share.pinHash)) {
          pinAttemptLimit.delete(limitKey);
          const token = createAccessToken(shareId);
          return json(res, 200, { ok: true, token, share: publicShare(share, token) });
        } else {
          limitRecord.attempts++;
          if (limitRecord.attempts >= 5) {
            limitRecord.lockedUntil = Date.now() + 60 * 1000; // 1 min lockout
          }
          pinAttemptLimit.set(limitKey, limitRecord);
          return json(res, 401, { error: 'Incorrect PIN. Access denied.' });
        }
      } catch {
        json(res, 400, { error: 'Invalid unlock payload.' });
      }
    });
  }

  // --- DOWNLOAD ENGINE ---
  async function sendDownload(req, res, id) {
    const share = shares.get(id);
    if (!share) {
      return text(res, 404, 'This share is no longer available.');
    }
    // Check expiry
    if (share.expiresAt && Date.now() > new Date(share.expiresAt).getTime()) {
      return json(res, 410, { error: 'This share has expired and has been removed.' });
    }

    // Check PIN requirement
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (share.pinHash && !verifyAccessToken(id, token)) {
      return json(res, 401, { error: 'This file is protected by a PIN. Please enter PIN to unlock.' });
    }

    const baseDir = share.mode === 'remote' ? remoteDir : nearbyDir;
    const fileIndexParam = url.searchParams.get('file');

    // Multi-file ZIP download request
    if (url.searchParams.get('all') === '1' && Array.isArray(share.files) && share.files.length > 1) {
      share.downloadCount = (share.downloadCount || 0) + 1;
      saveManifests();
      return streamZip(res, share.files, baseDir);
    }

    const targetFile = (fileIndexParam !== null && Array.isArray(share.files) && share.files[Number(fileIndexParam)])
      ? share.files[Number(fileIndexParam)]
      : (share.files ? share.files[0] : { name: share.filename, storedName: share.storedName });

    const filePath = path.join(baseDir, targetFile.storedName);
    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch {
      shares.delete(id);
      saveManifests();
      return text(res, 404, 'This share is no longer available.');
    }

    const total = stats.size;
    const range = parseRange(req.headers.range, total);
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType(targetFile.name),
      'Content-Disposition': encodeDisposition(targetFile.name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    if (range === 'invalid') {
      res.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${total}` });
      return res.end();
    }

    const isPartial = Boolean(range);
    const start = isPartial ? range.start : 0;
    const end = isPartial ? range.end : total - 1;
    res.writeHead(isPartial ? 206 : 200, {
      ...commonHeaders,
      'Content-Length': end - start + 1,
      ...(isPartial ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {})
    });

    const transferId = crypto.randomBytes(6).toString('hex');
    let sentBytes = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let speed = 0;

    broadcastTransfer(id, {
      type: 'start',
      transferId,
      totalBytes: total,
      bytesSent: start,
      percent: Math.round((start / total) * 100),
      speed: 0,
      status: 'downloading',
      downloadCount: share.downloadCount || 0
    });

    const meter = new Transform({
      transform(chunk, encoding, callback) {
        sentBytes += chunk.length;
        const now = Date.now();
        const delta = now - lastTime;
        if (delta >= 350) {
          speed = ((sentBytes - lastBytes) / delta) * 1000;
          lastBytes = sentBytes;
          lastTime = now;
          const currentProgress = start + sentBytes;
          const percent = Math.min(100, Math.round((currentProgress / total) * 100));
          broadcastTransfer(id, {
            type: 'progress',
            transferId,
            totalBytes: total,
            bytesSent: currentProgress,
            percent,
            speed: Math.round(speed),
            status: 'downloading',
            downloadCount: share.downloadCount || 0
          });
        }
        callback(null, chunk);
      }
    });

    const fileStream = fs.createReadStream(filePath, { start, end });
    fileStream.on('error', () => {
      broadcastTransfer(id, { type: 'error', transferId, status: 'error' });
      res.destroy();
    });

    res.on('finish', () => {
      share.downloadCount = (share.downloadCount || 0) + 1;
      saveManifests();
      broadcastTransfer(id, {
        type: 'complete',
        transferId,
        totalBytes: total,
        bytesSent: end + 1,
        percent: 100,
        speed: 0,
        status: 'completed',
        downloadCount: share.downloadCount
      });
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        broadcastTransfer(id, {
          type: 'cancelled',
          transferId,
          bytesSent: start + sentBytes,
          totalBytes: total,
          status: 'cancelled',
          downloadCount: share.downloadCount || 0
        });
      }
    });

    fileStream.pipe(meter).pipe(res);
  }

  async function removeShare(res, id) {
    const share = shares.get(id);
    if (!share) return json(res, 404, { error: 'Share not found.' });

    const baseDir = share.mode === 'remote' ? remoteDir : nearbyDir;
    if (Array.isArray(share.files)) {
      for (const f of share.files) {
        await fsp.rm(path.join(baseDir, f.storedName), { force: true }).catch(() => {});
      }
    }
    shares.delete(id);
    saveManifests();
    broadcastTransfer(id, { type: 'removed', status: 'removed' });
    json(res, 200, { ok: true });
  }

  const handler = async (req, res) => {
    const rawPath = req.headers['x-matched-path'] || req.url;
    const url = new URL(rawPath, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // Static routes
      if (req.method === 'GET' && pathname === '/') return serveStatic(res, 'index.html');
      if (req.method === 'GET' && pathname === '/app.js') return serveStatic(res, 'app.js');
      if (req.method === 'GET' && pathname === '/styles.css') return serveStatic(res, 'styles.css');
      if (req.method === 'GET' && pathname === '/qrcode.js') return serveStatic(res, 'qrcode.js');
      if (req.method === 'GET' && /^\/s\/[A-Za-z0-9_-]+$/.test(pathname)) return serveStatic(res, 'share.html');
      if (req.method === 'GET' && pathname === '/share.js') return serveStatic(res, 'share.js');

      // Network API
      if (req.method === 'GET' && pathname === '/api/network') {
        const interfaces = getNetworkInterfaces();
        return json(res, 200, {
          addresses: localAddresses(),
          interfaces: interfaces.map((i) => ({ address: i.address, name: i.name })),
          port: server.address()?.port || DEFAULT_PORT
        });
      }

      // Nearby share creation
      if (req.method === 'POST' && pathname === '/api/shares') return createNearbyShare(req, res);

      // Remote share chunked upload APIs
      if (req.method === 'POST' && pathname === '/api/remote/shares/init') return initRemoteShare(req, res);

      const chunkMatch = /^\/api\/remote\/shares\/([A-Za-z0-9_-]+)\/chunks$/.exec(pathname);
      if (req.method === 'PUT' && chunkMatch && isShareId(chunkMatch[1])) {
        return uploadChunk(req, res, chunkMatch[1]);
      }

      const statusMatch = /^\/api\/remote\/shares\/([A-Za-z0-9_-]+)\/status$/.exec(pathname);
      if (req.method === 'GET' && statusMatch && isShareId(statusMatch[1])) {
        return getUploadStatus(res, statusMatch[1], url.searchParams.get('uploadId'));
      }

      const finalizeMatch = /^\/api\/remote\/shares\/([A-Za-z0-9_-]+)\/finalize$/.exec(pathname);
      if (req.method === 'POST' && finalizeMatch && isShareId(finalizeMatch[1])) {
        return finalizeRemoteShare(req, res, finalizeMatch[1]);
      }

      // PIN Unlock API
      const unlockMatch = /^\/api\/shares\/([A-Za-z0-9_-]+)\/unlock$/.exec(pathname);
      if (req.method === 'POST' && unlockMatch && isShareId(unlockMatch[1])) {
        return unlockShare(req, res, unlockMatch[1]);
      }

      // SSE Live Transfer Events
      const eventsMatch = /^\/api\/shares\/([A-Za-z0-9_-]+)\/events$/.exec(pathname);
      if (req.method === 'GET' && eventsMatch && isShareId(eventsMatch[1])) {
        const shareId = eventsMatch[1];
        const share = shares.get(shareId);
        if (!share) return text(res, 404, 'Share not found');

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Content-Type-Options': 'nosniff'
        });
        res.write(': heartbeat\n\n');
        const initial = latestProgress.get(shareId) || {
          type: 'ready',
          status: 'ready',
          totalBytes: share.totalSize || share.size,
          downloadCount: share.downloadCount || 0
        };
        res.write(`data: ${JSON.stringify(initial)}\n\n`);

        if (!transferSubscribers.has(shareId)) {
          transferSubscribers.set(shareId, new Set());
        }
        const subs = transferSubscribers.get(shareId);
        subs.add(res);

        const heartbeat = setInterval(() => {
          try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
        }, 15000);

        res.on('close', () => {
          clearInterval(heartbeat);
          subs.delete(res);
          if (subs.size === 0) transferSubscribers.delete(shareId);
        });
        return;
      }

      // Progress Snapshot API
      const progressMatch = /^\/api\/shares\/([A-Za-z0-9_-]+)\/progress$/.exec(pathname);
      if (req.method === 'GET' && progressMatch && isShareId(progressMatch[1])) {
        const shareId = progressMatch[1];
        const share = shares.get(shareId);
        if (!share) return json(res, 404, { error: 'Share not found.' });
        const progress = latestProgress.get(shareId) || {
          status: 'idle',
          totalBytes: share.totalSize || share.size,
          downloadCount: share.downloadCount || 0
        };
        return json(res, 200, progress);
      }

      // Share Info API
      const apiMatch = /^\/api\/shares\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (apiMatch && !isShareId(apiMatch[1])) return json(res, 404, { error: 'Share not found.' });
      if (req.method === 'GET' && apiMatch) {
        const share = shares.get(apiMatch[1]);
        if (!share) return json(res, 404, { error: 'Share not found.' });
        if (share.expiresAt && Date.now() > new Date(share.expiresAt).getTime()) {
          return json(res, 410, { error: 'This share has expired.' });
        }
        const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        return json(res, 200, { share: publicShare(share, token) });
      }
      if (req.method === 'DELETE' && apiMatch) return removeShare(res, apiMatch[1]);

      // Download Stream API
      const downloadMatch = /^\/api\/shares\/([A-Za-z0-9_-]+)\/download$/.exec(pathname);
      if (req.method === 'GET' && downloadMatch && isShareId(downloadMatch[1])) {
        return sendDownload(req, res, downloadMatch[1]);
      }

      text(res, 404, 'Not found');
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: 'Unexpected server error.' });
    }
  };

  const server = http.createServer(handler);
  server.on('close', () => {
    clearInterval(cleanupTimer);
  });

  return {
    server,
    handler,
    shares,
    storageDir,
    nearbyDir,
    remoteDir,
    partsDir,
    latestProgress,
    broadcastTransfer,
    cleanupExpiredShares
  };
}

if (require.main === module) {
  const { server } = createApp();
  server.listen(DEFAULT_PORT, '0.0.0.0', () => {
    const addresses = localAddresses();
    console.log(`QuickDrop V3 is ready at http://localhost:${DEFAULT_PORT}`);
    for (const address of addresses) console.log(`Nearby network URL: http://${address}:${DEFAULT_PORT}`);
    if (process.env.PUBLIC_BASE_URL) {
      console.log(`Public Remote URL: ${process.env.PUBLIC_BASE_URL}`);
    }
  });
}

let defaultApp = null;
function getHandler(req, res) {
  if (!defaultApp) defaultApp = createApp();
  return defaultApp.handler(req, res);
}

getHandler.createApp = createApp;
getHandler.parseRange = parseRange;
getHandler.safeFilename = safeFilename;
getHandler.localAddresses = localAddresses;
getHandler.getNetworkInterfaces = getNetworkInterfaces;
getHandler.hashPin = hashPin;
getHandler.verifyPin = verifyPin;
getHandler.createAccessToken = createAccessToken;
getHandler.verifyAccessToken = verifyAccessToken;
getHandler.updateCrc32 = updateCrc32;

module.exports = getHandler;
