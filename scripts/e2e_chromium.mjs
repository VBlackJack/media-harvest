/*
 * Copyright 2026 Julien Bombled
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH || '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome'
].filter(Boolean);

const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAYAAACOEfKtAAAAPElEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADg3w0AAf8BAAE0AAH4sAAAAABJRU5ErkJggg==';

function findChromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function createFixtureServer() {
  const pngBuffer = Buffer.from(SAMPLE_PNG_BASE64, 'base64');
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Media Harvest E2E Fixture</title></head>
<body>
  <img id="hero" src="/media/banner.png" width="120" height="80" alt="hero">
  <svg id="brandLogo" width="48" height="48" viewBox="0 0 48 48">
    <circle cx="24" cy="24" r="20" fill="#0369a1"/>
  </svg>
  <svg style="display:none">
    <symbol id="e2e-star" viewBox="0 0 24 24">
      <polygon points="12,2 15,9 22,9 16,14 18,21 12,17 6,21 8,14 2,9 9,9"/>
    </symbol>
  </svg>
  <svg id="useIcon" width="32" height="32"><use href="#e2e-star"/></svg>
  <canvas id="paintCanvas" width="160" height="160"></canvas>
  <script>
    const c = document.getElementById('paintCanvas');
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 160, 160);
    grad.addColorStop(0, '#0284c7');
    grad.addColorStop(0.5, '#10b981');
    grad.addColorStop(1, '#f59e0b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 160, 160);
    ctx.fillStyle = '#0f172a';
    for (let i = 0; i < 8; i += 1) {
      ctx.beginPath();
      ctx.arc(20 + i * 18, 80, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    const reqUrl = String(req.url || '/');
    if (reqUrl.startsWith('/media/banner.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pngBuffer.length });
      res.end(pngBuffer);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (ev) => reject(new Error(`CDP WebSocket error: ${ev.message || 'failed'}`)), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result || {});
        }
      }
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.reject(new Error('CDP connection closed'));
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

function terminateChromeProcess(proc) {
  if (!proc) {
    return;
  }
  try {
    if (proc.stdout) proc.stdout.destroy();
    if (proc.stderr) proc.stderr.destroy();
  } catch {
    // Ignore stream teardown errors
  }
  if (proc.exitCode === null && !proc.killed) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Ignore kill errors if already exited
    }
  }
}

async function launchChromeWithExtension(chromePath, userDataDir) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-gpu',
    `--disable-extensions-except=${ROOT_DIR}`,
    `--load-extension=${ROOT_DIR}`
  ];
  const env = { ...process.env };
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent';
  }

  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
  let stderrText = '';
  const wsUrl = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(portPoller);
      proc.stderr.off('data', onData);
      if (err) {
        terminateChromeProcess(proc);
        reject(err);
      } else {
        resolve(value);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for Chrome DevTools WS URL. Stderr: ${stderrText}`));
    }, 30000);

    const portPoller = setInterval(() => {
      try {
        if (!fs.existsSync(activePortFile)) {
          return;
        }
        const lines = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
        const port = Number(lines[0]);
        const wsPath = (lines[1] || '').trim();
        if (Number.isInteger(port) && port > 0 && wsPath.startsWith('/')) {
          finish(null, `ws://127.0.0.1:${port}${wsPath}`);
        }
      } catch {
        // File may still be flushing
      }
    }, 100);

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      stderrText += text;
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        finish(null, match[1]);
      }
    };
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      finish(new Error(`Chrome exited prematurely with code ${code}. Stderr: ${stderrText}`));
    });
  });

  return { proc, wsUrl };
}

async function waitForExtensionId(cdp, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const extTarget = (targetInfos || []).find((t) =>
      typeof t.url === 'string'
      && t.url.startsWith('chrome-extension://')
      && t.url.includes('/src/background/service_worker.js')
    );
    if (extTarget) {
      const hostMatch = extTarget.url.match(/^chrome-extension:\/\/([^/]+)/);
      if (hostMatch) {
        return { extensionId: hostMatch[1], targetInfos };
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { extensionId: '', targetInfos: [] };
}

async function waitForPredicate(cdp, sessionId, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true
      }, sessionId);
      if (res && res.result && res.result.value) {
        return true;
      }
    } catch {
      // Page context may still be navigating
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function createTargetSession(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function runE2E() {
  const chromePath = findChromeBinary();
  if (!chromePath) {
    console.log('SKIP: Chrome/Edge binary not found for E2E test.');
    return;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-harvest-e2e-'));
  const { server, baseUrl } = await createFixtureServer();
  let proc = null;
  let cdp = null;

  try {
    const launched = await launchChromeWithExtension(chromePath, userDataDir);
    proc = launched.proc;
    cdp = new CdpClient(launched.wsUrl);
    await cdp.connect();

    // 1. Navigate real page tab to local test fixture
    const { sessionId: pageSessionId } = await createTargetSession(cdp, `${baseUrl}/page.html`);

    const pageReady = await waitForPredicate(
      cdp,
      pageSessionId,
      'document.readyState === "complete" && document.images.length >= 1 && document.querySelectorAll("svg").length >= 3'
    );
    if (!pageReady) {
      const diag = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ href: location.href, ready: document.readyState, imgs: document.images.length, svgs: document.querySelectorAll("svg").length, body: document.body ? document.body.innerText.slice(0, 120) : "" })',
        returnByValue: true
      }, pageSessionId).catch((e) => ({ result: { value: String(e) } }));
      assert.fail(`Fixture page did not finish loading within timeout: ${diag && diag.result ? diag.result.value : ''}`);
    }
    const domCheck = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, svgs: document.querySelectorAll("svg").length, imgs: document.images.length })',
      returnByValue: true
    }, pageSessionId);
    const parsedDom = JSON.parse(domCheck.result.value);
    assert.equal(parsedDom.title, 'Media Harvest E2E Fixture');
    assert.equal(parsedDom.svgs, 3);
    assert.equal(parsedDom.imgs, 1);

    // 2. Verify Canvas SVG -> PNG rasterization and DEFLATE CompressionStream in real Chrome engine
    const canvasCheck = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="20" fill="#0369a1"/></svg>';
        const srcUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = srcUrl; });
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        canvas.getContext('2d').drawImage(img, 0, 0, 512, 512);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));

        const rawPayload = new TextEncoder().encode(svg.repeat(8));
        const compressedStream = new Blob([rawPayload]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const compressedBuf = new Uint8Array(await new Response(compressedStream).arrayBuffer());
        const restoredStream = new Blob([compressedBuf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const restoredText = await new Response(restoredStream).text();

        return {
          width: canvas.width,
          height: canvas.height,
          size: blob ? blob.size : 0,
          type: blob ? blob.type : '',
          deflateSmaller: compressedBuf.byteLength < rawPayload.byteLength,
          roundTripOk: restoredText === svg.repeat(8)
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, pageSessionId);
    assert.equal(canvasCheck.result.value.width, 512);
    assert.equal(canvasCheck.result.value.type, 'image/png');
    assert.ok(canvasCheck.result.value.size > 200);
    assert.equal(canvasCheck.result.value.deflateSmaller, true);
    assert.equal(canvasCheck.result.value.roundTripOk, true);

    // 3. Verify unpacked MV3 extension target / popup UI if allowed by browser build
    const { extensionId } = await waitForExtensionId(cdp, 5000);
    if (extensionId) {
      const { sessionId: popupSessionId } = await createTargetSession(
        cdp,
        `chrome-extension://${extensionId}/src/popup/popup.html`
      );

      const popupReady = await waitForPredicate(
        cdp,
        popupSessionId,
        'document.readyState === "complete" && Boolean(document.getElementById("minImagePxSelect"))'
      );
      assert.equal(popupReady, true, 'Extension popup UI did not initialize within timeout');

      const popupCheck = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          url: location.href,
          readyState: document.readyState,
          hasMinPxSelect: Boolean(document.getElementById('minImagePxSelect')),
          hasExtSelect: Boolean(document.getElementById('imageExtFilterSelect')),
          hasOrientationSelect: Boolean(document.getElementById('imageOrientationFilterSelect')),
          hasScaleSelect: Boolean(document.getElementById('imageScaleSelect')),
          hasZipBtn: Boolean(document.getElementById('downloadZipBtn')),
          hasTabCaptureBtn: Boolean(document.getElementById('tabCaptureBtn')),
          hasLightbox: Boolean(document.getElementById('imageLightbox')),
          hasLightboxToolbar: Boolean(document.getElementById('lightboxBgLightBtn') && document.getElementById('lightboxCopyBtn') && document.getElementById('lightboxDownloadBtn')),
          hasLightboxPalette: Boolean(document.getElementById('lightboxPaletteBar') && document.getElementById('lightboxCurrentColorBtn')),
          orientationOptions: document.getElementById('imageOrientationFilterSelect') ? document.getElementById('imageOrientationFilterSelect').options.length : 0,
          scaleOptions: document.getElementById('imageScaleSelect') ? document.getElementById('imageScaleSelect').options.length : 0
        })`,
        returnByValue: true
      }, popupSessionId);
      const popupState = JSON.parse(popupCheck.result.value);
      assert.equal(popupState.hasMinPxSelect, true, popupCheck.result.value);
      assert.equal(popupState.hasExtSelect, true, popupCheck.result.value);
      assert.equal(popupState.hasOrientationSelect, true, popupCheck.result.value);
      assert.equal(popupState.hasScaleSelect, true, popupCheck.result.value);
      assert.equal(popupState.hasZipBtn, true, popupCheck.result.value);
      assert.equal(popupState.hasTabCaptureBtn, true, popupCheck.result.value);
      assert.equal(popupState.hasLightbox, true, popupCheck.result.value);
      assert.equal(popupState.hasLightboxToolbar, true, popupCheck.result.value);
      assert.equal(popupState.hasLightboxPalette, true, popupCheck.result.value);
      assert.equal(popupState.orientationOptions, 4, popupCheck.result.value);
      assert.equal(popupState.scaleOptions, 4, popupCheck.result.value);

      const lightboxToggleCheck = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const lightBtn = document.getElementById('lightboxBgLightBtn');
          const stage = document.getElementById('lightboxStage');
          lightBtn.click();
          return {
            hasLightClass: stage ? stage.classList.contains('is-bg-light') : false,
            btnActive: lightBtn.classList.contains('is-active')
          };
        })()`,
        returnByValue: true
      }, popupSessionId);
      assert.equal(lightboxToggleCheck.result.value.hasLightClass, true);
      assert.equal(lightboxToggleCheck.result.value.btnActive, true);

      const mediaCheck = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const tabs = await chrome.tabs.query({ url: '${baseUrl}/*' });
          if (!tabs.length) return { ok: false, count: 0, error: 'NO_TABS_FOUND' };
          const res = await chrome.runtime.sendMessage({
            type: 'GET_MEDIA_FOR_TAB',
            tabId: tabs[0].id,
            tabUrl: tabs[0].url
          });
          return {
            ok: Boolean(res && res.ok),
            error: res && res.error ? res.error : '',
            count: res && Array.isArray(res.items) ? res.items.length : 0,
            hasSvg: res && Array.isArray(res.items) ? res.items.some((i) => i.ext === 'svg') : false,
            hasCanvasPng: res && Array.isArray(res.items) ? res.items.some((i) => i.ext === 'png' && typeof i.url === 'string' && i.url.startsWith('data:image/png;base64,')) : false,
            exts: res && Array.isArray(res.items) ? res.items.map((i) => i.ext) : []
          };
        })()`,
        awaitPromise: true,
        returnByValue: true
      }, popupSessionId);
      assert.equal(mediaCheck.result.value.ok, true, JSON.stringify(mediaCheck.result.value));
      assert.equal(mediaCheck.result.value.hasSvg, true, JSON.stringify(mediaCheck.result.value));
      assert.equal(mediaCheck.result.value.hasCanvasPng, true, JSON.stringify(mediaCheck.result.value));
      assert.ok(mediaCheck.result.value.count >= 3, JSON.stringify(mediaCheck.result.value));

      // 4. Verify stream_saver.html + vendored muxjs.Transmuxer availability in extension runtime
      const { sessionId: saverSessionId } = await createTargetSession(
        cdp,
        `chrome-extension://${extensionId}/src/saver/stream_saver.html`
      );
      const saverReady = await waitForPredicate(
        cdp,
        saverSessionId,
        'document.readyState === "complete" && Boolean(document.getElementById("startBtn"))'
      );
      assert.equal(saverReady, true, 'stream_saver.html did not initialize within timeout');
      const saverCheck = await cdp.send('Runtime.evaluate', {
        expression: '({ hasStart: Boolean(document.getElementById("startBtn")), hasMuxjs: typeof globalThis.muxjs === "object" && typeof globalThis.muxjs.Transmuxer === "function" })',
        returnByValue: true
      }, saverSessionId);
      assert.equal(saverCheck.result.value.hasStart, true);
      assert.equal(saverCheck.result.value.hasMuxjs, true);

      console.log(`Chromium MV3 E2E passed (extension loaded: ${extensionId}, detected ${mediaCheck.result.value.count} media items).`);
    } else {
      console.log('Chromium E2E passed (DOM & Canvas checks OK; --load-extension disabled on branded Chrome build).');
    }
  } finally {
    if (cdp) {
      await Promise.race([
        cdp.send('Browser.close').catch(() => {}),
        new Promise((r) => setTimeout(r, 1500))
      ]);
      cdp.close();
    }
    terminateChromeProcess(proc);
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold Chrome temp lock files
    }
  }
}

runE2E().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
