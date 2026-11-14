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
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transmuxTsSegmentsToMp4 } from '../src/shared/ts_transmuxer.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('transmuxTsSegmentsToMp4 concatenates single initSegment and data segments', () => {
  class FakeTransmuxer {
    constructor() {
      this.handlers = {};
      this.pushed = [];
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    push(bytes) {
      this.pushed.push(bytes);
    }
    flush() {
      this.handlers.data({
        initSegment: new Uint8Array([1, 2]),
        data: new Uint8Array([3, 4])
      });
      this.handlers.data({
        initSegment: new Uint8Array([1, 2]),
        data: new Uint8Array([5, 6])
      });
    }
  }

  const out = transmuxTsSegmentsToMp4([new Uint8Array([0x47]), new Uint8Array([0x47])], FakeTransmuxer);
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5, 6]);
});

test('vendored mux-mp4.min.js exposes muxjs.Transmuxer in browser UMD context', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src/vendor/mux-mp4.min.js'), 'utf8');
  const context = {
    Uint8Array,
    DataView,
    ArrayBuffer,
    TextDecoder,
    console
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(code, context);

  assert.equal(typeof context.muxjs, 'object');
  assert.equal(typeof context.muxjs.Transmuxer, 'function');
  const instance = new context.muxjs.Transmuxer();
  assert.equal(typeof instance.push, 'function');
  assert.equal(typeof instance.flush, 'function');
});
