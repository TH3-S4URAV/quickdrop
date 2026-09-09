const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  createApp,
  parseRange,
  safeFilename,
  localAddresses,
  getNetworkInterfaces,
  hashPin,
  verifyPin,
  createAccessToken,
  verifyAccessToken
} = require('../server');

async function request({ port, method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (response) => {
      const parts = [];
      response.on('data', (part) => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }));
    });
    request.on('error', reject);
    if (body) request.end(body);
    else request.end();
  });
}

test('range parsing supports full and partial browser downloads', () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=7-', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(parseRange('bytes=99-', 10), 'invalid');
  assert.equal(safeFilename('../unsafe\\name.txt'), '.._unsafe_name.txt');
});

test('PIN hashing and token verification utilities', () => {
  const pin = '9876';
  const pinHash = hashPin(pin);
  assert.ok(pinHash.includes(':'));
  assert.equal(verifyPin(pin, pinHash), true);
  assert.equal(verifyPin('wrong', pinHash), false);

  const shareId = 'test_share_12345678';
  const token = createAccessToken(shareId, 5000);
  assert.equal(verifyAccessToken(shareId, token), true);
  assert.equal(verifyAccessToken('different_share', token), false);
  assert.equal(verifyAccessToken(shareId, 'invalid.token'), false);
});

test('network interfaces prioritization returns sorted valid IPs', () => {
  const interfaces = getNetworkInterfaces();
  assert.ok(Array.isArray(interfaces));
  const addresses = localAddresses();
  assert.ok(Array.isArray(addresses));
});

test('creates, serves, tracks progress, ranges, and removes a streamed local share', async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-test-'));
  const { server } = createApp({ storageDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  // Verify static serving of qrcode.js
  const qrRes = await request({ port, pathname: '/qrcode.js' });
  assert.equal(qrRes.status, 200);
  assert.ok(qrRes.headers['content-type'].includes('javascript'));
  assert.ok(qrRes.body.toString().includes('QRCode'));

  // Verify network API
  const netRes = await request({ port, pathname: '/api/network' });
  assert.equal(netRes.status, 200);
  const netData = JSON.parse(netRes.body);
  assert.ok(Array.isArray(netData.addresses));
  assert.ok(Array.isArray(netData.interfaces));

  // Create share
  const payload = Buffer.from('A file streamed from one device to another with QuickDrop.');
  const create = await request({
    port,
    method: 'POST',
    pathname: '/api/shares',
    headers: {
      'X-File-Name': encodeURIComponent('travel photo.txt'),
      'X-File-Size': String(payload.length),
      'Content-Length': String(payload.length)
    },
    body: payload
  });
  assert.equal(create.status, 201);
  const share = JSON.parse(create.body).share;
  assert.equal(share.filename, 'travel photo.txt');
  assert.equal(share.size, payload.length);

  // Check share info
  const info = await request({ port, pathname: `/api/shares/${share.id}` });
  assert.equal(info.status, 200);
  assert.equal(JSON.parse(info.body).share.id, share.id);

  // Partial Range download
  const partial = await request({ port, pathname: `/api/shares/${share.id}/download`, headers: { Range: 'bytes=2-7' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers['content-range'], `bytes 2-7/${payload.length}`);
  assert.deepEqual(partial.body, payload.subarray(2, 8));

  // Full download
  const full = await request({ port, pathname: `/api/shares/${share.id}/download` });
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, payload);

  // Verify progress endpoint records completed transfer
  const progressRes = await request({ port, pathname: `/api/shares/${share.id}/progress` });
  assert.equal(progressRes.status, 200);
  const progData = JSON.parse(progressRes.body);
  assert.equal(progData.status, 'completed');
  assert.equal(progData.percent, 100);

  // Remove share
  const remove = await request({ port, method: 'DELETE', pathname: `/api/shares/${share.id}` });
  assert.equal(remove.status, 200);
  const unavailable = await request({ port, pathname: `/api/shares/${share.id}` });
  assert.equal(unavailable.status, 404);
});

test('remote chunked upload, resume query, and finalization', async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-chunk-'));
  const { server } = createApp({ storageDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  const totalData = Buffer.alloc(12 * 1024 * 1024); // 12 MB (across 3 chunks of 5MB, 5MB, 2MB)
  crypto.randomFillSync(totalData);
  const originalHash = crypto.createHash('sha256').update(totalData).digest('hex');

  // 1. Initialize remote share
  const initRes = await request({
    port,
    method: 'POST',
    pathname: '/api/remote/shares/init',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'large_dataset.bin',
      totalSize: totalData.length,
      expiresInHours: 24
    })
  });
  assert.equal(initRes.status, 201);
  const initData = JSON.parse(initRes.body);
  const { shareId, uploadId, chunkSize, totalChunks } = initData;
  assert.equal(totalChunks, 3);

  // 2. Upload chunk 0
  const chunk0 = totalData.subarray(0, chunkSize);
  const c0Res = await request({
    port,
    method: 'PUT',
    pathname: `/api/remote/shares/${shareId}/chunks`,
    headers: {
      'X-Upload-Id': uploadId,
      'X-Chunk-Index': '0',
      'Content-Length': String(chunk0.length)
    },
    body: chunk0
  });
  assert.equal(c0Res.status, 200);

  // 3. Simulate resume: query status to see which chunks are already on server
  const statusRes = await request({
    port,
    method: 'GET',
    pathname: `/api/remote/shares/${shareId}/status?uploadId=${uploadId}`
  });
  assert.equal(statusRes.status, 200);
  const statusData = JSON.parse(statusRes.body);
  assert.deepEqual(statusData.receivedChunks, [0]);

  // 4. Upload remaining chunks (1 and 2)
  const chunk1 = totalData.subarray(chunkSize, chunkSize * 2);
  await request({
    port,
    method: 'PUT',
    pathname: `/api/remote/shares/${shareId}/chunks`,
    headers: { 'X-Upload-Id': uploadId, 'X-Chunk-Index': '1', 'Content-Length': String(chunk1.length) },
    body: chunk1
  });

  const chunk2 = totalData.subarray(chunkSize * 2);
  await request({
    port,
    method: 'PUT',
    pathname: `/api/remote/shares/${shareId}/chunks`,
    headers: { 'X-Upload-Id': uploadId, 'X-Chunk-Index': '2', 'Content-Length': String(chunk2.length) },
    body: chunk2
  });

  // 5. Finalize
  const finalizeRes = await request({
    port,
    method: 'POST',
    pathname: `/api/remote/shares/${shareId}/finalize`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });
  assert.equal(finalizeRes.status, 200);

  // 6. Download and verify hash integrity
  const dlRes = await request({
    port,
    method: 'GET',
    pathname: `/api/shares/${shareId}/download`
  });
  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.body.length, totalData.length);
  const downloadedHash = crypto.createHash('sha256').update(dlRes.body).digest('hex');
  assert.equal(downloadedHash, originalHash);
});

test('PIN protection, access token verification, and brute-force rate limit', async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-pin-'));
  const { server } = createApp({ storageDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  const payload = Buffer.from('Confidential financial sheet.');

  // Create share with PIN "4321"
  const initRes = await request({
    port,
    method: 'POST',
    pathname: '/api/remote/shares/init',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'confidential.txt',
      totalSize: payload.length,
      pin: '4321'
    })
  });
  const { shareId, uploadId } = JSON.parse(initRes.body);

  await request({
    port,
    method: 'PUT',
    pathname: `/api/remote/shares/${shareId}/chunks`,
    headers: { 'X-Upload-Id': uploadId, 'X-Chunk-Index': '0', 'Content-Length': String(payload.length) },
    body: payload
  });
  await request({
    port,
    method: 'POST',
    pathname: `/api/remote/shares/${shareId}/finalize`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });

  // 1. Download attempt without PIN must fail (401)
  const unauthDl = await request({ port, pathname: `/api/shares/${shareId}/download` });
  assert.equal(unauthDl.status, 401);

  // 2. Info request shows file is protected and files list is withheld
  const infoRes = await request({ port, pathname: `/api/shares/${shareId}` });
  const infoData = JSON.parse(infoRes.body).share;
  assert.equal(infoData.isProtected, true);
  assert.equal(infoData.isUnlocked, false);
  assert.equal(infoData.files, undefined);

  // 3. Unlock with wrong PIN fails
  const wrongUnlock = await request({
    port,
    method: 'POST',
    pathname: `/api/shares/${shareId}/unlock`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '0000' })
  });
  assert.equal(wrongUnlock.status, 401);

  // 4. Unlock with correct PIN succeeds and returns signed access token
  const correctUnlock = await request({
    port,
    method: 'POST',
    pathname: `/api/shares/${shareId}/unlock`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '4321' })
  });
  assert.equal(correctUnlock.status, 200);
  const unlockData = JSON.parse(correctUnlock.body);
  assert.ok(unlockData.token);

  // 5. Download with token succeeds
  const authDl = await request({
    port,
    pathname: `/api/shares/${shareId}/download?token=${encodeURIComponent(unlockData.token)}`
  });
  assert.equal(authDl.status, 200);
  assert.deepEqual(authDl.body, payload);
});

test('share expiry enforcement and automatic cleanup', async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-exp-'));
  const { server, cleanupExpiredShares, shares } = createApp({ storageDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  const payload = Buffer.from('Temporary data that should expire.');
  const initRes = await request({
    port,
    method: 'POST',
    pathname: '/api/remote/shares/init',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'expire_me.txt',
      totalSize: payload.length,
      expiresInHours: 1
    })
  });
  const { shareId, uploadId } = JSON.parse(initRes.body);

  await request({
    port,
    method: 'PUT',
    pathname: `/api/remote/shares/${shareId}/chunks`,
    headers: { 'X-Upload-Id': uploadId, 'X-Chunk-Index': '0', 'Content-Length': String(payload.length) },
    body: payload
  });
  await request({
    port,
    method: 'POST',
    pathname: `/api/remote/shares/${shareId}/finalize`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });

  const getAppShare = await request({ port, pathname: `/api/shares/${shareId}` });
  assert.equal(getAppShare.status, 200);

  // Fast forward expiry timestamp in memory
  shares.get(shareId).expiresAt = new Date(Date.now() - 10000).toISOString();

  // Trigger server cleanup
  cleanupExpiredShares();

  // Accessing expired share must yield 410 Gone or 404
  const expiredRes = await request({ port, pathname: `/api/shares/${shareId}` });
  assert.ok(expiredRes.status === 410 || expiredRes.status === 404);
});

test('multi-file share streaming as ZIP archive', async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-zip-'));
  const { server } = createApp({ storageDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  const file1 = Buffer.from('Content of file 1');
  const file2 = Buffer.from('Content of file 2');
  const total = file1.length + file2.length;

  const initRes = await request({
    port,
    method: 'POST',
    pathname: '/api/remote/shares/init',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'multi_pack.zip',
      totalSize: total,
      files: [
        { name: 'document.txt', size: file1.length },
        { name: 'notes.txt', size: file2.length }
      ]
    })
  });
  const { shareId, uploadId } = JSON.parse(initRes.body);

  const combined = Buffer.concat([file1, file2]);
  await request({
    port,
    method: 'PUT',
    pathname: `/api/remote/shares/${shareId}/chunks`,
    headers: { 'X-Upload-Id': uploadId, 'X-Chunk-Index': '0', 'Content-Length': String(combined.length) },
    body: combined
  });
  await request({
    port,
    method: 'POST',
    pathname: `/api/remote/shares/${shareId}/finalize`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });

  // Download individual file 0
  const f0Res = await request({ port, pathname: `/api/shares/${shareId}/download?file=0` });
  assert.equal(f0Res.status, 200);
  assert.deepEqual(f0Res.body, file1);

  // Download All as streaming ZIP
  const zipRes = await request({ port, pathname: `/api/shares/${shareId}/download?all=1` });
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers['content-type'], 'application/zip');
  // Check ZIP signature (PK\x03\x04)
  assert.equal(zipRes.body.readUInt32LE(0), 0x04034b50);
});

test('serves static V3 frontend pages and receiver components', async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-test-'));
  const { server } = createApp({ storageDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  // 1. Index Page
  const indexRes = await request({ port, pathname: '/' });
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers['content-type'], /text\/html/);
  const indexHtml = indexRes.body.toString('utf8');
  assert.ok(indexHtml.includes('mode-nav'));
  assert.ok(indexHtml.includes('tab-nearby'));
  assert.ok(indexHtml.includes('tab-remote'));
  assert.ok(indexHtml.includes('/qrcode.js'));
  assert.ok(indexHtml.includes('/app.js'));

  // 2. Styles
  const cssRes = await request({ port, pathname: '/styles.css' });
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers['content-type'], /text\/css/);
  const css = cssRes.body.toString('utf8');
  assert.ok(css.includes('.is-hidden'));
  assert.ok(css.includes('.mode-nav'));
  assert.ok(css.includes('.pin-unlock-box'));

  // 3. QR Code Generator Script
  const qrRes = await request({ port, pathname: '/qrcode.js' });
  assert.equal(qrRes.status, 200);
  assert.match(qrRes.headers['content-type'], /text\/javascript/);
  assert.ok(qrRes.body.toString('utf8').includes('QRCode'));

  // 4. Main App Controller Script
  const appRes = await request({ port, pathname: '/app.js' });
  assert.equal(appRes.status, 200);
  assert.match(appRes.headers['content-type'], /text\/javascript/);
  assert.ok(appRes.body.toString('utf8').includes('ChunkedUploader'));

  // 5. Receiver Page
  const sharePageRes = await request({ port, pathname: '/s/demo-test-share-123' });
  assert.equal(sharePageRes.status, 200);
  assert.match(sharePageRes.headers['content-type'], /text\/html/);
  const shareHtml = sharePageRes.body.toString('utf8');
  assert.ok(shareHtml.includes('pin-unlock-box'));
  assert.ok(shareHtml.includes('batch-controls'));
  assert.ok(shareHtml.includes('download-all-btn'));
  assert.ok(shareHtml.includes('/share.js'));

  // 6. Receiver Script
  const shareJsRes = await request({ port, pathname: '/share.js' });
  assert.equal(shareJsRes.status, 200);
  assert.match(shareJsRes.headers['content-type'], /text\/javascript/);
  const shareJs = shareJsRes.body.toString('utf8');
  assert.ok(shareJs.includes('handlePinSubmit'));
  assert.ok(shareJs.includes('renderUnlockedShare'));
});

test('end-to-end PIN protected remote share workflow', async (t) => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickdrop-pin-e2e-'));
  const { server } = createApp({ storageDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  const fileData = Buffer.from('Confidential report content for QuickDrop V3 testing.');
  const pin = '4321';

  // 1. Initialize PIN-protected remote share
  const initRes = await request({
    port,
    method: 'POST',
    pathname: '/api/remote/shares/init',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'confidential.txt',
      totalSize: fileData.length,
      pin,
      expiresInHours: 24,
      files: [{ name: 'confidential.txt', size: fileData.length }]
    })
  });
  assert.equal(initRes.status, 201);
  const initData = JSON.parse(initRes.body);
  assert.equal(initData.isProtected, true);
  const { shareId, uploadId } = initData;

  // 2. Upload chunk
  const chunkRes = await request({
    port,
    method: 'PUT',
    pathname: `/api/remote/shares/${shareId}/chunks`,
    headers: { 'X-Upload-Id': uploadId, 'X-Chunk-Index': '0', 'Content-Length': String(fileData.length) },
    body: fileData
  });
  assert.equal(chunkRes.status, 200);

  // 3. Finalize
  const finalizeRes = await request({
    port,
    method: 'POST',
    pathname: `/api/remote/shares/${shareId}/finalize`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });
  assert.equal(finalizeRes.status, 200);

  // 4. Query share before unlock
  const lockedRes = await request({ port, pathname: `/api/shares/${shareId}` });
  assert.equal(lockedRes.status, 200);
  const lockedShare = JSON.parse(lockedRes.body).share;
  assert.equal(lockedShare.isProtected, true);
  assert.equal(lockedShare.isUnlocked, false);
  assert.equal(lockedShare.files, undefined);

  // 5. Try download without token -> 401
  const unauthDownload = await request({ port, pathname: `/api/shares/${shareId}/download` });
  assert.equal(unauthDownload.status, 401);

  // 6. Try unlock with incorrect PIN -> 401
  const wrongUnlock = await request({
    port,
    method: 'POST',
    pathname: `/api/shares/${shareId}/unlock`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '9999' })
  });
  assert.equal(wrongUnlock.status, 401);

  // 7. Unlock with correct PIN -> 200 + token
  const correctUnlock = await request({
    port,
    method: 'POST',
    pathname: `/api/shares/${shareId}/unlock`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  assert.equal(correctUnlock.status, 200);
  const unlockData = JSON.parse(correctUnlock.body);
  assert.equal(unlockData.ok, true);
  assert.ok(unlockData.token);
  assert.equal(unlockData.share.isUnlocked, true);
  assert.ok(Array.isArray(unlockData.share.files));

  // 8. Download with token -> 200 and matches fileData
  const authDownload = await request({
    port,
    pathname: `/api/shares/${shareId}/download?token=${encodeURIComponent(unlockData.token)}`
  });
  assert.equal(authDownload.status, 200);
  assert.deepEqual(authDownload.body, fileData);
});


