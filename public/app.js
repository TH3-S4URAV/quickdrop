/**
 * QuickDrop V3 Frontend Controller
 * Supports Nearby Transfer (LAN) and Remote Transfer (WAN) with chunked resumable upload
 */

// --- SHARED UTILITIES ---
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'ETA: --';
  if (seconds < 60) return `ETA: ${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `ETA: ${mins}m ${secs}s`;
}

function getFileIconAndType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext)) return { icon: '🎬', type: 'VIDEO' };
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic'].includes(ext)) return { icon: '🖼️', type: 'IMAGE' };
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return { icon: '🎵', type: 'AUDIO' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { icon: '📦', type: 'ARCHIVE' };
  if (['pdf', 'doc', 'docx', 'txt', 'csv', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return { icon: '📄', type: 'DOCUMENT' };
  if (['exe', 'msi', 'dmg', 'apk', 'iso'].includes(ext)) return { icon: '⚙️', type: 'APP/ISO' };
  return { icon: '▣', type: ext.toUpperCase() || 'FILE' };
}

function setHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle('is-hidden', hidden);
}

// --- TAB SWITCHING ---
const tabNearby = document.querySelector('#tab-nearby');
const tabRemote = document.querySelector('#tab-remote');
const sectionNearby = document.querySelector('#section-nearby');
const sectionRemote = document.querySelector('#section-remote');

function switchMode(mode) {
  const isNearby = mode === 'nearby';
  tabNearby.classList.toggle('is-active', isNearby);
  tabNearby.setAttribute('aria-selected', isNearby ? 'true' : 'false');
  tabRemote.classList.toggle('is-active', !isNearby);
  tabRemote.setAttribute('aria-selected', !isNearby ? 'true' : 'false');

  setHidden(sectionNearby, !isNearby);
  setHidden(sectionRemote, isNearby);
}

tabNearby.addEventListener('click', () => switchMode('nearby'));
tabRemote.addEventListener('click', () => switchMode('remote'));

// =====================================================================
// 1. NEARBY TRANSFER CONTROLLER (Preserves V1 Flow)
// =====================================================================
const nearbyFileInput = document.querySelector('#nearby-file-input');
const nearbyDropZone = document.querySelector('#nearby-drop-zone');
const nearbySelectedFile = document.querySelector('#nearby-selected-file');
const nearbyFileName = document.querySelector('#nearby-file-name');
const nearbyFileSize = document.querySelector('#nearby-file-size');
const nearbyFileIcon = document.querySelector('#nearby-file-icon');
const nearbyFileExt = document.querySelector('#nearby-file-ext');
const nearbyClearFile = document.querySelector('#nearby-clear-file');
const nearbyShareButton = document.querySelector('#nearby-share-button');

const nearbyUploadStatus = document.querySelector('#nearby-upload-status');
const nearbyUploadLabel = document.querySelector('#nearby-upload-label');
const nearbyUploadSpeed = document.querySelector('#nearby-upload-speed');
const nearbyUploadPercent = document.querySelector('#nearby-upload-percent');
const nearbyUploadTransferred = document.querySelector('#nearby-upload-transferred');
const nearbyUploadEta = document.querySelector('#nearby-upload-eta');
const nearbyProgressFill = document.querySelector('#nearby-progress-fill');
const nearbyErrorMessage = document.querySelector('#nearby-error-message');

const nearbyLinkPanel = document.querySelector('#nearby-link-panel');
const nearbyShareLink = document.querySelector('#nearby-share-link');
const nearbyCopyButton = document.querySelector('#nearby-copy-button');
const nearbyNewShare = document.querySelector('#nearby-new-share');
const nearbyStopShare = document.querySelector('#nearby-stop-share');
const nearbyNetworkRow = document.querySelector('#nearby-network-row');
const nearbyNetworkSelect = document.querySelector('#nearby-network-select');
const nearbyQrcodeContainer = document.querySelector('#nearby-qrcode');

const nearbyMonitorDot = document.querySelector('#nearby-monitor-dot');
const nearbyMonitorText = document.querySelector('#nearby-monitor-text');
const nearbyMonitorBar = document.querySelector('#nearby-monitor-bar');
const nearbyMonitorFill = document.querySelector('#nearby-monitor-fill');
const nearbyMonitorSpeed = document.querySelector('#nearby-monitor-speed');
const nearbyMonitorPercent = document.querySelector('#nearby-monitor-percent');

let nearbyChosenFile = null;
let nearbyActiveShareId = null;
let nearbyNetworkAddresses = [];
let nearbyNetworkInterfaces = [];
let nearbyServerPort = window.location.port || '4173';
let nearbyEventSource = null;

function chooseNearbyFile(file) {
  if (!file) return;
  nearbyChosenFile = file;
  nearbyFileName.textContent = file.name;
  nearbyFileSize.textContent = formatBytes(file.size);
  const meta = getFileIconAndType(file.name);
  if (nearbyFileIcon) nearbyFileIcon.textContent = meta.icon;
  if (nearbyFileExt) nearbyFileExt.textContent = meta.type;
  setHidden(nearbySelectedFile, false);
  nearbyShareButton.disabled = false;
  showNearbyError('');
}

function clearNearbyChosenFile() {
  nearbyChosenFile = null;
  nearbyFileInput.value = '';
  setHidden(nearbySelectedFile, true);
  nearbyShareButton.disabled = true;
}

function showNearbyError(message) {
  nearbyErrorMessage.textContent = message;
  setHidden(nearbyErrorMessage, !message);
}

async function fetchNearbyNetwork() {
  try {
    const response = await fetch('/api/network', { cache: 'no-store' });
    const network = await response.json();
    nearbyNetworkAddresses = network.addresses || [];
    nearbyNetworkInterfaces = network.interfaces || [];
    nearbyServerPort = String(network.port || nearbyServerPort || '4173');
    setupNearbyNetworkSelector();
  } catch {}
}

function setupNearbyNetworkSelector() {
  if (!nearbyNetworkSelect) return;
  nearbyNetworkSelect.innerHTML = '';
  const options = nearbyNetworkInterfaces.length > 0
    ? nearbyNetworkInterfaces
    : nearbyNetworkAddresses.map((addr) => ({ address: addr, name: 'Local Network' }));

  if (options.length > 1) {
    setHidden(nearbyNetworkRow, false);
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.address;
      el.textContent = `${opt.name} (${opt.address})`;
      nearbyNetworkSelect.appendChild(el);
    }
    nearbyNetworkSelect.addEventListener('change', () => {
      if (nearbyActiveShareId) updateNearbyShareUrlAndQR();
    });
  } else {
    setHidden(nearbyNetworkRow, true);
  }
}

function getNearbyHost() {
  if (nearbyNetworkSelect && nearbyNetworkSelect.value) return nearbyNetworkSelect.value;
  return nearbyNetworkAddresses[0] || window.location.hostname;
}

function buildNearbyShareUrl(id) {
  const host = getNearbyHost();
  const port = nearbyServerPort && nearbyServerPort !== '80' ? `:${nearbyServerPort}` : '';
  return `http://${host}${port}/s/${id}`;
}

function updateNearbyShareUrlAndQR() {
  if (!nearbyActiveShareId) return;
  const url = buildNearbyShareUrl(nearbyActiveShareId);
  nearbyShareLink.value = url;
  renderQrCode(nearbyQrcodeContainer, url);
}

function renderQrCode(container, url) {
  if (!container) return;
  container.innerHTML = '';
  try {
    if (typeof QRCode !== 'undefined') {
      new QRCode(container, {
        text: url,
        width: 190,
        height: 190,
        colorDark: '#0a1020',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  } catch (err) {
    console.error('QR code render error:', err);
  }
}

function uploadNearbyFile(file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/shares');
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    request.setRequestHeader('X-File-Size', String(file.size));

    let startTime = Date.now();
    let lastTime = startTime;
    let lastLoaded = 0;
    let currentSpeed = 0;

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const now = Date.now();
      const delta = (now - lastTime) / 1000;

      if (delta >= 0.3) {
        const bytesDiff = event.loaded - lastLoaded;
        const instantSpeed = bytesDiff / delta;
        currentSpeed = currentSpeed === 0 ? instantSpeed : 0.7 * instantSpeed + 0.3 * currentSpeed;
        lastLoaded = event.loaded;
        lastTime = now;
      }

      const percent = Math.round((event.loaded / event.total) * 100);
      nearbyProgressFill.style.width = `${percent}%`;
      nearbyUploadPercent.textContent = `${percent}%`;
      nearbyUploadLabel.textContent = `Preparing share: ${formatBytes(event.loaded)} of ${formatBytes(event.total)}`;
      if (nearbyUploadSpeed) nearbyUploadSpeed.textContent = formatSpeed(currentSpeed);
      if (nearbyUploadTransferred) nearbyUploadTransferred.textContent = `${formatBytes(event.loaded)} / ${formatBytes(event.total)}`;

      if (nearbyUploadEta) {
        const remainingBytes = event.total - event.loaded;
        const remainingSecs = currentSpeed > 0 ? remainingBytes / currentSpeed : 0;
        nearbyUploadEta.textContent = formatEta(remainingSecs);
      }
    };

    request.onerror = () => reject(new Error('Connection lost while preparing the share.'));
    request.onload = () => {
      let result;
      try { result = JSON.parse(request.responseText); } catch { result = {}; }
      if (request.status >= 200 && request.status < 300) resolve(result);
      else reject(new Error(result.error || 'The file could not be prepared for sharing.'));
    };
    request.send(file);
  });
}

function startNearbyTransferMonitor(shareId) {
  stopNearbyTransferMonitor();
  if (typeof EventSource === 'undefined') return;

  try {
    nearbyEventSource = new EventSource(`/api/shares/${shareId}/events`);
    nearbyEventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleNearbyTransferEvent(data);
      } catch {}
    };
  } catch {}
}

function stopNearbyTransferMonitor() {
  if (nearbyEventSource) {
    nearbyEventSource.close();
    nearbyEventSource = null;
  }
}

function handleNearbyTransferEvent(data) {
  if (!nearbyMonitorText) return;

  if (data.status === 'downloading' || data.type === 'progress' || data.type === 'start') {
    nearbyMonitorDot.className = 'monitor-indicator is-active';
    setHidden(nearbyMonitorBar, false);
    nearbyMonitorText.textContent = `📥 Receiver downloading: ${formatBytes(data.bytesSent)} of ${formatBytes(data.totalBytes)}`;
    if (nearbyMonitorFill) nearbyMonitorFill.style.width = `${data.percent || 0}%`;
    if (nearbyMonitorPercent) nearbyMonitorPercent.textContent = `${data.percent || 0}%`;
    if (nearbyMonitorSpeed) nearbyMonitorSpeed.textContent = formatSpeed(data.speed);
  } else if (data.status === 'completed' || data.type === 'complete') {
    nearbyMonitorDot.className = 'monitor-indicator is-success';
    nearbyMonitorText.textContent = `🎉 Transfer complete! File saved by receiver.`;
    if (nearbyMonitorFill) nearbyMonitorFill.style.width = '100%';
    if (nearbyMonitorPercent) nearbyMonitorPercent.textContent = '100%';
    if (nearbyMonitorSpeed) nearbyMonitorSpeed.textContent = 'Complete';
  } else if (data.status === 'cancelled' || data.type === 'cancelled') {
    nearbyMonitorDot.className = 'monitor-indicator is-idle';
    nearbyMonitorText.textContent = `Download paused or closed by receiver.`;
    setHidden(nearbyMonitorBar, true);
  }
}

nearbyFileInput.addEventListener('change', () => chooseNearbyFile(nearbyFileInput.files[0]));
nearbyClearFile.addEventListener('click', clearNearbyChosenFile);

['dragenter', 'dragover'].forEach((eventName) => {
  nearbyDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    nearbyDropZone.classList.add('is-dragging');
  });
});
['dragleave', 'drop'].forEach((eventName) => {
  nearbyDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    nearbyDropZone.classList.remove('is-dragging');
  });
});
nearbyDropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) chooseNearbyFile(e.dataTransfer.files[0]);
});

nearbyShareButton.addEventListener('click', async () => {
  if (!nearbyChosenFile) return;
  nearbyShareButton.disabled = true;
  setHidden(nearbyUploadStatus, false);
  showNearbyError('');
  nearbyProgressFill.style.width = '0%';
  nearbyUploadPercent.textContent = '0%';
  nearbyUploadLabel.textContent = 'Preparing your local share…';
  if (nearbyUploadSpeed) nearbyUploadSpeed.textContent = '0 B/s';
  if (nearbyUploadTransferred) nearbyUploadTransferred.textContent = '0 B';
  if (nearbyUploadEta) nearbyUploadEta.textContent = 'Calculating ETA…';

  try {
    const result = await uploadNearbyFile(nearbyChosenFile);
    nearbyActiveShareId = result.share.id;
    nearbyNetworkAddresses = result.addresses || nearbyNetworkAddresses;
    if (result.interfaces) nearbyNetworkInterfaces = result.interfaces;
    setupNearbyNetworkSelector();

    updateNearbyShareUrlAndQR();
    setHidden(nearbyLinkPanel, false);
    startNearbyTransferMonitor(nearbyActiveShareId);
    nearbyLinkPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showNearbyError(error.message);
    nearbyShareButton.disabled = false;
  } finally {
    setHidden(nearbyUploadStatus, true);
  }
});

nearbyCopyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(nearbyShareLink.value);
  } catch {
    nearbyShareLink.select();
    document.execCommand('copy');
  }
  nearbyCopyButton.textContent = 'Copied!';
  setTimeout(() => { nearbyCopyButton.textContent = 'Copy'; }, 1800);
});

nearbyNewShare.addEventListener('click', () => {
  stopNearbyTransferMonitor();
  setHidden(nearbyLinkPanel, true);
  nearbyActiveShareId = null;
  clearNearbyChosenFile();
  nearbyDropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

nearbyStopShare.addEventListener('click', async () => {
  if (!nearbyActiveShareId) return;
  nearbyStopShare.disabled = true;
  stopNearbyTransferMonitor();
  try {
    const res = await fetch(`/api/shares/${nearbyActiveShareId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    setHidden(nearbyLinkPanel, true);
    nearbyActiveShareId = null;
    clearNearbyChosenFile();
  } catch {
    showNearbyError('Could not stop the share. Please try again.');
  } finally {
    nearbyStopShare.disabled = false;
  }
});

fetchNearbyNetwork();

// =====================================================================
// 2. REMOTE TRANSFER CONTROLLER (WAN, Chunked & Resumable)
// =====================================================================
const remoteFileInput = document.querySelector('#remote-file-input');
const remoteDropZone = document.querySelector('#remote-drop-zone');
const remoteFilesListBox = document.querySelector('#remote-files-list-box');
const remoteFilesList = document.querySelector('#remote-files-list');
const remoteFilesCount = document.querySelector('#remote-files-count');
const remoteTotalSize = document.querySelector('#remote-total-size');
const remoteClearFiles = document.querySelector('#remote-clear-files');

const remoteExpirySelect = document.querySelector('#remote-expiry-select');
const remotePinToggle = document.querySelector('#remote-pin-toggle');
const remotePinInput = document.querySelector('#remote-pin-input');
const remoteShareButton = document.querySelector('#remote-share-button');
const remoteErrorMessage = document.querySelector('#remote-error-message');

const remoteUploadStatus = document.querySelector('#remote-upload-status');
const remoteUploadLabel = document.querySelector('#remote-upload-label');
const remoteUploadSpeed = document.querySelector('#remote-upload-speed');
const remoteUploadPercent = document.querySelector('#remote-upload-percent');
const remoteUploadTransferred = document.querySelector('#remote-upload-transferred');
const remoteUploadEta = document.querySelector('#remote-upload-eta');
const remoteProgressFill = document.querySelector('#remote-progress-fill');
const remotePauseBtn = document.querySelector('#remote-pause-btn');
const remoteCancelBtn = document.querySelector('#remote-cancel-btn');

const remoteLinkPanel = document.querySelector('#remote-link-panel');
const remoteShareLink = document.querySelector('#remote-share-link');
const remoteCopyButton = document.querySelector('#remote-copy-button');
const remoteQrcodeContainer = document.querySelector('#remote-qrcode');
const remoteNewShare = document.querySelector('#remote-new-share');
const remoteStopShare = document.querySelector('#remote-stop-share');

const remoteBadgeExpiry = document.querySelector('#remote-badge-expiry');
const remoteBadgePin = document.querySelector('#remote-badge-pin');
const remoteBadgeFiles = document.querySelector('#remote-badge-files');

const remoteMonitorDot = document.querySelector('#remote-monitor-dot');
const remoteMonitorText = document.querySelector('#remote-monitor-text');
const remoteMonitorBar = document.querySelector('#remote-monitor-bar');
const remoteMonitorFill = document.querySelector('#remote-monitor-fill');
const remoteMonitorSpeed = document.querySelector('#remote-monitor-speed');
const remoteMonitorPercent = document.querySelector('#remote-monitor-percent');
const remoteDownloadCount = document.querySelector('#remote-download-count');

let remoteSelectedFiles = [];
let remoteActiveShareId = null;
let remoteActiveUploadSession = null;
let remoteEventSource = null;

function showRemoteError(msg) {
  remoteErrorMessage.textContent = msg;
  setHidden(remoteErrorMessage, !msg);
}

function updateRemoteFilesList() {
  remoteFilesList.innerHTML = '';
  if (remoteSelectedFiles.length === 0) {
    setHidden(remoteFilesListBox, true);
    remoteShareButton.disabled = true;
    return;
  }

  setHidden(remoteFilesListBox, false);
  remoteShareButton.disabled = false;

  let totalBytes = 0;
  remoteSelectedFiles.forEach((file, index) => {
    totalBytes += file.size;
    const li = document.createElement('li');
    li.className = 'file-item';
    const meta = getFileIconAndType(file.name);
    li.innerHTML = `
      <span class="item-icon">${meta.icon}</span>
      <span class="item-name" title="${file.name}">${file.name}</span>
      <span class="item-size">${formatBytes(file.size)}</span>
      <button class="remove-file-btn" type="button" data-index="${index}" aria-label="Remove ${file.name}">×</button>
    `;
    remoteFilesList.appendChild(li);
  });

  remoteFilesCount.textContent = `${remoteSelectedFiles.length} file${remoteSelectedFiles.length > 1 ? 's' : ''} selected`;
  remoteTotalSize.textContent = formatBytes(totalBytes);

  // Attach individual remove handlers
  remoteFilesList.querySelectorAll('.remove-file-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = Number(e.currentTarget.getAttribute('data-index'));
      remoteSelectedFiles.splice(idx, 1);
      updateRemoteFilesList();
    });
  });
}

function addRemoteFiles(files) {
  if (!files || files.length === 0) return;
  for (const f of files) {
    // Prevent duplicate files by name and size
    if (!remoteSelectedFiles.some((item) => item.name === f.name && item.size === f.size)) {
      remoteSelectedFiles.push(f);
    }
  }
  updateRemoteFilesList();
  showRemoteError('');
}

remoteFileInput.addEventListener('change', () => {
  addRemoteFiles(remoteFileInput.files);
  remoteFileInput.value = '';
});

remoteClearFiles.addEventListener('click', () => {
  remoteSelectedFiles = [];
  updateRemoteFilesList();
});

['dragenter', 'dragover'].forEach((eventName) => {
  remoteDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    remoteDropZone.classList.add('is-dragging');
  });
});
['dragleave', 'drop'].forEach((eventName) => {
  remoteDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    remoteDropZone.classList.remove('is-dragging');
  });
});
remoteDropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) {
    addRemoteFiles(e.dataTransfer.files);
  }
});

// PIN Toggle
remotePinToggle.addEventListener('change', () => {
  setHidden(remotePinInput, !remotePinToggle.checked);
  if (remotePinToggle.checked) remotePinInput.focus();
  else remotePinInput.value = '';
});

// --- CHUNKED RESUMABLE UPLOADER CLASS ---
class ChunkedUploader {
  constructor({ files, expiresInHours, pin, onProgress, onError, onComplete }) {
    this.files = files;
    this.expiresInHours = expiresInHours;
    this.pin = pin;
    this.onProgress = onProgress;
    this.onError = onError;
    this.onComplete = onComplete;

    this.isPaused = false;
    this.isCancelled = false;
    this.currentXHR = null;
    this.shareId = null;
    this.uploadId = null;
    this.chunkSize = 5 * 1024 * 1024;
    this.totalChunks = 0;
    this.totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    this.uploadedBytes = 0;
    this.currentChunkIndex = 0;
    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.lastUploadedBytes = 0;
    this.smoothedSpeed = 0;
  }

  async start() {
    try {
      // 1. Initialize session
      const initPayload = {
        filename: this.files.length === 1 ? this.files[0].name : `${this.files.length} files.zip`,
        totalSize: this.totalBytes,
        expiresInHours: this.expiresInHours,
        pin: this.pin || undefined,
        files: this.files.map((f) => ({ name: f.name, size: f.size }))
      };

      const res = await fetch('/api/remote/shares/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initPayload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to initialize remote share.');

      this.shareId = data.shareId;
      this.uploadId = data.uploadId;
      this.chunkSize = data.chunkSize || this.chunkSize;
      this.totalChunks = data.totalChunks;

      // 2. Prepare combined slice buffer/stream
      // We will slice across all selected files sequentially
      await this.uploadNextChunk();
    } catch (err) {
      if (!this.isCancelled) this.onError(err);
    }
  }

  async getChunkBlob(chunkIndex) {
    const chunkStart = chunkIndex * this.chunkSize;
    const chunkEnd = Math.min(chunkStart + this.chunkSize, this.totalBytes);
    const chunkLength = chunkEnd - chunkStart;

    // Locate slices across files
    const blobParts = [];
    let fileOffset = 0;

    for (const file of this.files) {
      const fileStart = fileOffset;
      const fileEnd = fileOffset + file.size;

      if (chunkEnd > fileStart && chunkStart < fileEnd) {
        // Overlaps with this file
        const sliceStart = Math.max(0, chunkStart - fileStart);
        const sliceEnd = Math.min(file.size, chunkEnd - fileStart);
        blobParts.push(file.slice(sliceStart, sliceEnd));
      }
      fileOffset = fileEnd;
    }

    return new Blob(blobParts);
  }

  async uploadNextChunk() {
    if (this.isCancelled) return;
    if (this.isPaused) return;

    if (this.currentChunkIndex >= this.totalChunks) {
      // Finalize upload
      return this.finalize();
    }

    const chunkBlob = await this.getChunkBlob(this.currentChunkIndex);
    const index = this.currentChunkIndex;

    this.currentXHR = new XMLHttpRequest();
    this.currentXHR.open('PUT', `/api/remote/shares/${this.shareId}/chunks`);
    this.currentXHR.setRequestHeader('X-Upload-Id', this.uploadId);
    this.currentXHR.setRequestHeader('X-Chunk-Index', String(index));
    this.currentXHR.setRequestHeader('Content-Length', String(chunkBlob.size));

    let chunkUploaded = 0;
    this.currentXHR.upload.onprogress = (e) => {
      if (!e.lengthComputable || this.isPaused) return;
      const progressDelta = e.loaded - chunkUploaded;
      chunkUploaded = e.loaded;
      this.uploadedBytes += progressDelta;

      const now = Date.now();
      const timeDelta = (now - this.lastTime) / 1000;
      if (timeDelta >= 0.3) {
        const bytesDiff = this.uploadedBytes - this.lastUploadedBytes;
        const instantSpeed = bytesDiff / timeDelta;
        this.smoothedSpeed = this.smoothedSpeed === 0 ? instantSpeed : 0.7 * instantSpeed + 0.3 * this.smoothedSpeed;
        this.lastUploadedBytes = this.uploadedBytes;
        this.lastTime = now;
      }

      const percent = Math.min(100, Math.round((this.uploadedBytes / this.totalBytes) * 100));
      const remainingBytes = Math.max(0, this.totalBytes - this.uploadedBytes);
      const remainingSecs = this.smoothedSpeed > 0 ? remainingBytes / this.smoothedSpeed : 0;

      this.onProgress({
        percent,
        uploaded: this.uploadedBytes,
        total: this.totalBytes,
        speed: this.smoothedSpeed,
        eta: remainingSecs,
        chunk: index + 1,
        totalChunks: this.totalChunks
      });
    };

    this.currentXHR.onload = async () => {
      if (this.currentXHR.status >= 200 && this.currentXHR.status < 300) {
        this.currentChunkIndex++;
        this.uploadNextChunk();
      } else {
        let errResult;
        try { errResult = JSON.parse(this.currentXHR.responseText); } catch {}
        this.onError(new Error(errResult?.error || `Chunk ${index} upload failed.`));
      }
    };

    this.currentXHR.onerror = () => {
      this.onError(new Error('Network connection lost during chunk transfer.'));
    };

    this.currentXHR.send(chunkBlob);
  }

  pause() {
    this.isPaused = true;
    if (this.currentXHR) {
      this.currentXHR.abort();
      this.currentXHR = null;
    }
  }

  async resume() {
    this.isPaused = false;
    // Query server for received chunks to resume seamlessly without losing progress
    try {
      const res = await fetch(`/api/remote/shares/${this.shareId}/status?uploadId=${this.uploadId}`);
      if (res.ok) {
        const data = await res.json();
        const received = data.receivedChunks || [];
        // Find first chunk not received
        let nextIndex = 0;
        while (received.includes(nextIndex)) nextIndex++;
        this.currentChunkIndex = nextIndex;
        this.uploadedBytes = Math.min(this.totalBytes, nextIndex * this.chunkSize);
        this.lastUploadedBytes = this.uploadedBytes;
        this.lastTime = Date.now();
      }
    } catch {}
    this.uploadNextChunk();
  }

  cancel() {
    this.isCancelled = true;
    if (this.currentXHR) {
      this.currentXHR.abort();
      this.currentXHR = null;
    }
    if (this.shareId) {
      fetch(`/api/shares/${this.shareId}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  async finalize() {
    try {
      const res = await fetch(`/api/remote/shares/${this.shareId}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: this.uploadId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to assemble remote file.');
      this.onComplete(data.share);
    } catch (err) {
      this.onError(err);
    }
  }
}

// Upload button click
remoteShareButton.addEventListener('click', () => {
  if (remoteSelectedFiles.length === 0) return;
  remoteShareButton.disabled = true;
  setHidden(remoteUploadStatus, false);
  showRemoteError('');

  remotePauseBtn.textContent = 'Pause';
  remoteProgressFill.style.width = '0%';
  remoteUploadPercent.textContent = '0%';
  remoteUploadLabel.textContent = 'Initializing chunked upload…';
  remoteUploadSpeed.textContent = '0 B/s';
  remoteUploadTransferred.textContent = '0 B';
  remoteUploadEta.textContent = 'Calculating ETA…';

  const expiresInHours = Number(remoteExpirySelect.value) || 24;
  const pin = remotePinToggle.checked ? remotePinInput.value.trim() : null;

  remoteActiveUploadSession = new ChunkedUploader({
    files: remoteSelectedFiles,
    expiresInHours,
    pin,
    onProgress: (p) => {
      remoteProgressFill.style.width = `${p.percent}%`;
      remoteUploadPercent.textContent = `${p.percent}%`;
      remoteUploadLabel.textContent = `Uploading chunk ${p.chunk} of ${p.totalChunks}`;
      remoteUploadSpeed.textContent = formatSpeed(p.speed);
      remoteUploadTransferred.textContent = `${formatBytes(p.uploaded)} of ${formatBytes(p.total)}`;
      remoteUploadEta.textContent = formatEta(p.eta);
    },
    onError: (err) => {
      showRemoteError(err.message);
      remoteShareButton.disabled = false;
      setHidden(remoteUploadStatus, true);
    },
    onComplete: (share) => {
      setHidden(remoteUploadStatus, true);
      remoteActiveShareId = share.id;

      // Render Remote Link Panel
      const shareUrl = `${window.location.origin}/s/${share.id}`;
      remoteShareLink.value = shareUrl;
      renderQrCode(remoteQrcodeContainer, shareUrl);

      // Badges
      remoteBadgeExpiry.textContent = `⏳ Expires in ${expiresInHours}h`;
      setHidden(remoteBadgePin, !share.isProtected);
      remoteBadgeFiles.textContent = `📦 ${share.fileCount || 1} file${(share.fileCount || 1) > 1 ? 's' : ''}`;

      setHidden(remoteLinkPanel, false);
      startRemoteTransferMonitor(share.id);
      remoteLinkPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  remoteActiveUploadSession.start();
});

// Pause / Resume Upload
remotePauseBtn.addEventListener('click', () => {
  if (!remoteActiveUploadSession) return;
  if (remoteActiveUploadSession.isPaused) {
    remoteActiveUploadSession.resume();
    remotePauseBtn.textContent = 'Pause';
    remoteUploadLabel.textContent = 'Resuming upload…';
  } else {
    remoteActiveUploadSession.pause();
    remotePauseBtn.textContent = 'Resume';
    remoteUploadLabel.textContent = 'Upload paused. Click resume to continue.';
    remoteUploadSpeed.textContent = 'Paused';
  }
});

// Cancel Upload
remoteCancelBtn.addEventListener('click', () => {
  if (remoteActiveUploadSession) {
    remoteActiveUploadSession.cancel();
    remoteActiveUploadSession = null;
  }
  setHidden(remoteUploadStatus, true);
  remoteShareButton.disabled = false;
  showRemoteError('Upload cancelled.');
});

// Copy Remote Link
remoteCopyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(remoteShareLink.value);
  } catch {
    remoteShareLink.select();
    document.execCommand('copy');
  }
  remoteCopyButton.textContent = 'Copied!';
  setTimeout(() => { remoteCopyButton.textContent = 'Copy'; }, 1800);
});

// Remote Monitor (SSE)
function startRemoteTransferMonitor(shareId) {
  stopRemoteTransferMonitor();
  if (typeof EventSource === 'undefined') return;

  try {
    remoteEventSource = new EventSource(`/api/shares/${shareId}/events`);
    remoteEventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleRemoteTransferEvent(data);
      } catch {}
    };
  } catch {}
}

function stopRemoteTransferMonitor() {
  if (remoteEventSource) {
    remoteEventSource.close();
    remoteEventSource = null;
  }
}

function handleRemoteTransferEvent(data) {
  if (!remoteMonitorText) return;

  if (data.downloadCount !== undefined && remoteDownloadCount) {
    remoteDownloadCount.textContent = String(data.downloadCount);
  }

  if (data.status === 'downloading' || data.type === 'progress' || data.type === 'start') {
    remoteMonitorDot.className = 'monitor-indicator is-active';
    setHidden(remoteMonitorBar, false);
    remoteMonitorText.textContent = `📥 Receiver downloading: ${formatBytes(data.bytesSent)} of ${formatBytes(data.totalBytes)}`;
    if (remoteMonitorFill) remoteMonitorFill.style.width = `${data.percent || 0}%`;
    if (remoteMonitorPercent) remoteMonitorPercent.textContent = `${data.percent || 0}%`;
    if (remoteMonitorSpeed) remoteMonitorSpeed.textContent = formatSpeed(data.speed);
  } else if (data.status === 'completed' || data.type === 'complete') {
    remoteMonitorDot.className = 'monitor-indicator is-success';
    remoteMonitorText.textContent = `🎉 Transfer complete! Receiver downloaded the files.`;
    if (remoteMonitorFill) remoteMonitorFill.style.width = '100%';
    if (remoteMonitorPercent) remoteMonitorPercent.textContent = '100%';
    if (remoteMonitorSpeed) remoteMonitorSpeed.textContent = 'Complete';
  } else if (data.status === 'expired' || data.type === 'expired') {
    remoteMonitorDot.className = 'monitor-indicator is-idle';
    remoteMonitorText.textContent = `⏳ Share has expired and has been cleaned up.`;
    setHidden(remoteMonitorBar, true);
  }
}

// Reset / Share another
remoteNewShare.addEventListener('click', () => {
  stopRemoteTransferMonitor();
  setHidden(remoteLinkPanel, true);
  remoteActiveShareId = null;
  remoteSelectedFiles = [];
  updateRemoteFilesList();
  remoteDropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// Delete / Revoke Remote Share
remoteStopShare.addEventListener('click', async () => {
  if (!remoteActiveShareId) return;
  remoteStopShare.disabled = true;
  stopRemoteTransferMonitor();
  try {
    const res = await fetch(`/api/shares/${remoteActiveShareId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    setHidden(remoteLinkPanel, true);
    remoteActiveShareId = null;
    remoteSelectedFiles = [];
    updateRemoteFilesList();
  } catch {
    showRemoteError('Could not revoke remote share. Please try again.');
  } finally {
    remoteStopShare.disabled = false;
  }
});
