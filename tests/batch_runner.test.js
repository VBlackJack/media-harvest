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

import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatchDownloads } from '../src/popup/batch_runner.js';
import { IMAGE_CONVERT_FORMATS, MESSAGE_TYPES } from '../src/config/constants.js';

test('runBatchDownloads exits early on empty batch or active running batch', async () => {
  const state = { batchRunning: false, batchAbortRequested: false };
  const resEmpty = await runBatchDownloads({
    batchItems: [],
    state,
    chromeApi: {},
    translateFn: (k) => k
  });
  assert.equal(resEmpty.startedCount, 0);

  state.batchRunning = true;
  const resRunning = await runBatchDownloads({
    batchItems: [{ url: 'https://example.com/1.mp4' }],
    state,
    chromeApi: {},
    translateFn: (k) => k
  });
  assert.equal(resRunning.startedCount, 0);
});

test('runBatchDownloads executes downloads sequentially and summarizes success', async () => {
  const sentMessages = [];
  const statusUpdates = [];
  const state = {
    batchRunning: false,
    batchAbortRequested: false,
    settings: { filenameTemplate: 'default' },
    activeTabUrl: 'https://example.com/page',
    activeTabId: 42,
    cardsByUrl: new Map(),
    localPendingRequestIds: new Set(),
    selectedUrls: new Set(['https://example.com/v1.mp4'])
  };

  const chromeApi = {
    runtime: {
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return { ok: true };
      }
    }
  };

  const batchItems = [
    { url: 'https://example.com/v1.mp4', suggestedFilename: 'v1.mp4', ext: 'mp4' },
    { url: 'https://example.com/v2.mp4', suggestedFilename: 'v2.mp4', ext: 'mp4' }
  ];

  const result = await runBatchDownloads({
    batchItems,
    state,
    chromeApi,
    translateFn: (k, subs) => `${k}${subs ? `(${subs.join(',')})` : ''}`,
    setStatusBanner: (text) => statusUpdates.push(text),
    hideBatchConfirm: () => {},
    renderList: () => {},
    isFolderFilenameTemplate: () => false,
    batchDelayMs: 0
  });

  assert.equal(result.startedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(result.aborted, false);
  assert.equal(state.selectedUrls.size, 0);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].type, MESSAGE_TYPES.DOWNLOAD_MEDIA);
  assert.equal(sentMessages[0].payload.url, 'https://example.com/v1.mp4');
  assert.ok(statusUpdates.some((s) => s.includes('popup_status_batch_progress(1,2)')));
  assert.ok(statusUpdates.some((s) => s.includes('popup_status_batch_progress(2,2)')));
  assert.ok(statusUpdates.includes('popup_status_download_started'));
  assert.equal(state.batchRunning, false);
});

test('runBatchDownloads aborts mid-flight when batchAbortRequested is triggered', async () => {
  const state = {
    batchRunning: false,
    batchAbortRequested: false,
    settings: { filenameTemplate: 'default' },
    cardsByUrl: new Map(),
    localPendingRequestIds: new Set(),
    selectedUrls: new Set(['https://example.com/v1.mp4'])
  };

  const sentMessages = [];
  const chromeApi = {
    runtime: {
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        state.batchAbortRequested = true; // request stop after first item
        return { ok: true };
      }
    }
  };

  const batchItems = [
    { url: 'https://example.com/v1.mp4', suggestedFilename: 'v1.mp4' },
    { url: 'https://example.com/v2.mp4', suggestedFilename: 'v2.mp4' },
    { url: 'https://example.com/v3.mp4', suggestedFilename: 'v3.mp4' }
  ];

  const result = await runBatchDownloads({
    batchItems,
    state,
    chromeApi,
    translateFn: (k) => k,
    setStatusBanner: () => {},
    batchDelayMs: 0
  });

  assert.equal(result.startedCount, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(result.aborted, true);
  assert.equal(state.batchRunning, false);
});

test('runBatchDownloads applies selected batch image conversion format only when different', async () => {
  const sentMessages = [];
  const state = {
    batchRunning: false,
    batchAbortRequested: false,
    imageConvertFormat: IMAGE_CONVERT_FORMATS.PNG,
    settings: { filenameTemplate: 'default' },
    activeTabUrl: 'https://example.com/gallery',
    activeTabId: 7,
    cardsByUrl: new Map(),
    localPendingRequestIds: new Set(),
    selectedUrls: new Set()
  };

  const chromeApi = {
    runtime: {
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return { ok: true };
      }
    }
  };

  const batchItems = [
    { url: 'https://cdn.example.com/hero.webp', type: 'image', ext: 'webp', width: 800, height: 600, suggestedFilename: 'hero.webp' },
    { url: 'https://cdn.example.com/icon.png', type: 'image', ext: 'png', width: 64, height: 64, suggestedFilename: 'icon.png' }
  ];

  const result = await runBatchDownloads({
    batchItems,
    state,
    chromeApi,
    translateFn: (k) => k,
    setStatusBanner: () => {},
    batchDelayMs: 0
  });

  assert.equal(result.startedCount, 2);
  assert.equal(sentMessages[0].payload.convertTo, 'png');
  assert.equal(sentMessages[0].payload.filename, 'hero.png');
  assert.ok(sentMessages[0].payload.requestId);
  assert.equal(sentMessages[1].payload.convertTo, '');
  assert.equal(sentMessages[1].payload.filename, 'icon.png');
  assert.equal(sentMessages[1].payload.requestId, '');
});
