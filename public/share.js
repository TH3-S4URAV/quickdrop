const receiverTitle = document.querySelector('#receiver-title');
const receiverDetail = document.querySelector('#receiver-detail');
const receiverStatus = document.querySelector('#receiver-status');
const receiverSize = document.querySelector('#receiver-size');
const receiverExt = document.querySelector('#receiver-ext');
const receiverIcon = document.querySelector('#receiver-icon');
const receiverBadge = document.querySelector('#receiver-badge');
const receiverExpiryBox = document.querySelector('#receiver-expiry-box');
const receiverExpiryText = document.querySelector('#receiver-expiry-text');
const networkStateText = document.querySelector('#network-state-text');
const receiverPrivacyNote = document.querySelector('#receiver-privacy-note');

const pinUnlockBox = document.querySelector('#pin-unlock-box');
const pinForm = document.querySelector('#pin-form');
const pinInput = document.querySelector('#pin-input');
const pinSubmitBtn = document.querySelector('#pin-submit-btn');
const pinError = document.querySelector('#pin-error');

const receiverActionsBox = document.querySelector('#receiver-actions-box');
const downloadButton = document.querySelector('#download-button');
const batchControls = document.querySelector('#batch-controls');
const downloadAllBtn = document.querySelector('#download-all-btn');
const batchFilesCount = document.querySelector('#batch-files-count');
const batchFilesList = document.querySelector('#batch-files-list');

const receiverProgressBox = document.querySelector('#receiver-progress-box');
const downloadStatusLabel = document.querySelector('#download-status-label');
const downloadSpeed = document.querySelector('#download-speed');
const downloadPercent = document.querySelector('#download-percent');
const downloadFill = document.querySelector('#download-fill');
const downloadTransferred = document.querySelector('#download-transferred');
const downloadEta = document.querySelector('#download-eta');
const completionBox = document.querySelector('#completion-box');
const receiverError = document.querySelector('#receiver-error');

const shareId = window.location.pathname.split('/').filter(Boolean).pop();
let activeToken = sessionStorage.getItem(`quickdrop_token_${shareId}`) || '';
let totalFileSize = 0;
let eventSource = null;
let pollInterval = null;

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

function formatRemainingTime(expiresAtIso) {
  if (!expiresAtIso) return null;
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (diffMs <= 0) return 'Expired';
  const hours = Math.floor(diffMs / (3600 * 1000));
  const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h remaining`;
  }
  if (hours > 0) return `${hours}h ${mins}m remaining`;
  return `${Math.max(1, mins)}m remaining`;
}

function getFileIconAndType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext)) return { icon: '🎬', type: 'VIDEO' };
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic'].includes(ext)) return { icon: '🖼️', type: 'IMAGE' };
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return { icon: '🎵', type: 'AUDIO' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { icon: '📦', type: 'ARCHIVE' };
  if (['pdf', 'doc', 'docx', 'txt', 'csv', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return { icon: '📄', type: 'DOCUMENT' };
  if (['exe', 'msi', 'dmg', 'apk', 'iso'].includes(ext)) return { icon: '⚙️', type: 'INSTALLER/ISO' };
  return { icon: '▣', type: ext.toUpperCase() || 'FILE' };
}

function setHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle('is-hidden', hidden);
}

function updateDownloadProgress(data) {
  if (!data) return;

  if (data.status === 'downloading' || data.type === 'progress' || data.type === 'start') {
    setHidden(receiverProgressBox, false);
    setHidden(completionBox, true);
    if (downloadStatusLabel) downloadStatusLabel.textContent = 'Transferring file…';
    if (downloadFill) downloadFill.style.width = `${data.percent || 0}%`;
    if (downloadPercent) downloadPercent.textContent = `${data.percent || 0}%`;
    if (downloadSpeed) downloadSpeed.textContent = formatSpeed(data.speed);
    if (downloadTransferred) {
      downloadTransferred.textContent = `${formatBytes(data.bytesSent || 0)} of ${formatBytes(totalFileSize)}`;
    }
    if (downloadEta && data.speed > 0) {
      const remainingBytes = totalFileSize - (data.bytesSent || 0);
      downloadEta.textContent = formatEta(remainingBytes / data.speed);
    }
    receiverStatus.textContent = 'Transfer in progress…';
  } else if (data.status === 'completed' || data.type === 'complete') {
    if (downloadFill) downloadFill.style.width = '100%';
    if (downloadPercent) downloadPercent.textContent = '100%';
    if (downloadSpeed) downloadSpeed.textContent = 'Done';
    setHidden(completionBox, false);
    if (downloadButton) downloadButton.textContent = 'Download Again ↓';
    receiverStatus.textContent = 'Transfer finished. File saved to your downloads.';
    stopProgressListening();
  } else if (data.status === 'cancelled') {
    if (downloadStatusLabel) downloadStatusLabel.textContent = 'Download paused';
  } else if (data.status === 'expired' || data.type === 'expired') {
    showExpiredState();
  }
}

function startProgressListening() {
  stopProgressListening();

  if (typeof EventSource !== 'undefined') {
    try {
      eventSource = new EventSource(`/api/shares/${shareId}/events`);
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          updateDownloadProgress(data);
        } catch {}
      };
      eventSource.onerror = () => {
        fallbackPolling();
      };
      return;
    } catch {}
  }
  fallbackPolling();
}

function fallbackPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/shares/${shareId}/progress`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        updateDownloadProgress(data);
      }
    } catch {}
  }, 1000);
}

function stopProgressListening() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function showExpiredState() {
  receiverTitle.textContent = 'Share Expired';
  receiverDetail.textContent = 'This file transfer has reached its expiration time and was automatically removed.';
  receiverStatus.textContent = 'Please ask the sender to share the files again.';
  setHidden(downloadButton, true);
  setHidden(batchControls, true);
  setHidden(pinUnlockBox, true);
  setHidden(receiverProgressBox, true);
  setHidden(receiverExpiryBox, true);
  if (receiverIcon) receiverIcon.textContent = '⌛';
  if (receiverBadge) receiverBadge.textContent = 'EXPIRED';
}

function renderUnlockedShare(share, token) {
  setHidden(pinUnlockBox, true);
  setHidden(receiverActionsBox, false);

  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
  const tokenFirstParam = token ? `?token=${encodeURIComponent(token)}` : '';

  if (Array.isArray(share.files) && share.files.length > 1) {
    // Multi-file batch mode
    setHidden(downloadButton, true);
    setHidden(batchControls, false);
    receiverTitle.textContent = share.filename || `${share.files.length} Files Package`;
    if (batchFilesCount) batchFilesCount.textContent = share.files.length;

    downloadAllBtn.href = `/api/shares/${shareId}/download?all=1${tokenParam}`;
    downloadAllBtn.onclick = () => {
      receiverStatus.textContent = 'Generating & streaming ZIP archive…';
      setHidden(receiverProgressBox, false);
      startProgressListening();
    };

    batchFilesList.innerHTML = '';
    share.files.forEach((file) => {
      const meta = getFileIconAndType(file.name);
      const li = document.createElement('li');
      li.className = 'batch-file-item';
      li.innerHTML = `
        <div class="batch-file-left">
          <span class="file-icon-small" aria-hidden="true">${meta.icon}</span>
          <div class="batch-file-info">
            <strong title="${file.name}">${file.name}</strong>
            <span>${formatBytes(file.size)}</span>
          </div>
        </div>
        <a class="secondary-button download-sub-btn" href="/api/shares/${shareId}/download?file=${file.index}${tokenParam}" download="${file.name}">
          Download ↓
        </a>
      `;
      const btn = li.querySelector('.download-sub-btn');
      btn.addEventListener('click', () => {
        receiverStatus.textContent = `Downloading ${file.name}…`;
        setHidden(receiverProgressBox, false);
        startProgressListening();
      });
      batchFilesList.appendChild(li);
    });
  } else {
    // Single file mode
    setHidden(batchControls, true);
    setHidden(downloadButton, false);

    const singleFileName = (share.files && share.files[0]?.name) || share.filename;
    receiverTitle.textContent = singleFileName;
    downloadButton.href = `/api/shares/${shareId}/download${tokenFirstParam}`;
    downloadButton.setAttribute('download', singleFileName);
    downloadButton.onclick = () => {
      receiverStatus.textContent = 'Starting direct download…';
      setHidden(receiverProgressBox, false);
      startProgressListening();
    };
  }

  receiverStatus.textContent = 'Tap Download to save directly to this device.';
}

async function handlePinSubmit(e) {
  e.preventDefault();
  const enteredPin = pinInput.value.trim();
  if (!enteredPin) return;

  pinSubmitBtn.disabled = true;
  setHidden(pinError, true);

  try {
    const res = await fetch(`/api/shares/${shareId}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: enteredPin })
    });
    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || 'Failed to unlock share.');
    }

    activeToken = result.token;
    sessionStorage.setItem(`quickdrop_token_${shareId}`, activeToken);
    renderUnlockedShare(result.share, activeToken);
  } catch (err) {
    pinError.textContent = err.message;
    setHidden(pinError, false);
  } finally {
    pinSubmitBtn.disabled = false;
  }
}

async function loadShare() {
  try {
    const tokenQuery = activeToken ? `?token=${encodeURIComponent(activeToken)}` : '';
    const response = await fetch(`/api/shares/${shareId}${tokenQuery}`, { cache: 'no-store' });
    const result = await response.json();

    if (response.status === 410) {
      showExpiredState();
      return;
    }
    if (!response.ok) {
      throw new Error(result.error || 'This share is unavailable or has expired.');
    }

    const share = result.share;
    totalFileSize = share.totalSize || share.size;

    // Header & network mode setup
    if (share.mode === 'remote') {
      if (networkStateText) networkStateText.textContent = 'Remote Cloud Transfer';
      if (receiverPrivacyNote) {
        receiverPrivacyNote.innerHTML = '<span aria-hidden="true">☁</span> Secure remote transfer. Auto-expiring storage.';
      }
      receiverDetail.textContent = 'Ready to download over public internet / WAN.';
    } else {
      if (networkStateText) networkStateText.textContent = 'Direct Local Wi‑Fi';
      if (receiverPrivacyNote) {
        receiverPrivacyNote.innerHTML = '<span aria-hidden="true">⌁</span> Direct peer transfer over your local network. No cloud storage used.';
      }
      receiverDetail.textContent = 'Ready to download over your local Wi‑Fi.';
    }

    // Expiry badge
    if (share.expiresAt) {
      const remaining = formatRemainingTime(share.expiresAt);
      if (remaining === 'Expired') {
        showExpiredState();
        return;
      }
      receiverExpiryText.textContent = `⏳ ${remaining}`;
      setHidden(receiverExpiryBox, false);
    } else {
      setHidden(receiverExpiryBox, true);
    }

    receiverSize.textContent = formatBytes(totalFileSize);
    const meta = getFileIconAndType(share.filename || 'file');
    receiverIcon.textContent = meta.icon;
    receiverExt.textContent = share.fileCount > 1 ? `${share.fileCount} FILES` : meta.type;

    if (share.isProtected && !share.isUnlocked) {
      // Show PIN Form
      receiverBadge.textContent = 'PIN PROTECTED';
      receiverIcon.textContent = '🔒';
      setHidden(pinUnlockBox, false);
      setHidden(receiverActionsBox, true);
      receiverStatus.textContent = 'Enter security PIN to download.';
      pinForm.onsubmit = handlePinSubmit;
    } else {
      receiverBadge.textContent = share.mode === 'remote' ? 'REMOTE FILE READY' : 'LOCAL FILE READY';
      renderUnlockedShare(share, activeToken);
    }
  } catch (error) {
    receiverTitle.textContent = 'This share is unavailable';
    receiverDetail.textContent = error.message;
    receiverStatus.textContent = 'Please ask the sender to create a new sharing link.';
    setHidden(downloadButton, true);
    setHidden(batchControls, true);
    setHidden(pinUnlockBox, true);
    if (receiverError) {
      receiverError.textContent = error.message;
      setHidden(receiverError, false);
    }
  }
}

loadShare();

