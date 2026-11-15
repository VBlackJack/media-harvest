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
import { packageExtension } from '../scripts/package_extension.mjs';

test('packageExtension builds a valid distributable zip archive with correct metadata', () => {
  const result = packageExtension();

  assert.equal(result.version, '1.1.0');
  assert.ok(result.fileCount >= 30, `Expected at least 30 files in extension package, got ${result.fileCount}`);
  assert.ok(result.byteLength > 10000, `Expected zip byteLength > 10KB, got ${result.byteLength}`);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(fs.existsSync(result.zipFilePath), `Expected zip file at ${result.zipFilePath}`);

  const buffer = fs.readFileSync(result.zipFilePath);
  // Standard zip file begins with PK\x03\x04
  assert.equal(buffer[0], 0x50);
  assert.equal(buffer[1], 0x4b);
  assert.equal(buffer[2], 0x03);
  assert.equal(buffer[3], 0x04);
});
