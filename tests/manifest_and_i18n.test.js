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

const ROOT = path.resolve(import.meta.dirname, '..');

test('manifest.json references existing files and valid MV3 structure', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));
  assert.ok(fs.existsSync(path.join(ROOT, 'src/vendor/mux-mp4.min.js')));

  for (const cs of manifest.content_scripts || []) {
    for (const file of [...(cs.js || []), ...(cs.css || [])]) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `Missing content script file: ${file}`);
    }
  }

  for (const iconPath of Object.values(manifest.icons)) {
    const absIcon = path.join(ROOT, iconPath);
    assert.ok(fs.existsSync(absIcon), `Missing icon: ${iconPath}`);
    const header = fs.readFileSync(absIcon).subarray(0, 4);
    assert.deepEqual(Array.from(header), [0x89, 0x50, 0x4e, 0x47]);
  }
});

test('en and fr locale files have matching valid Chrome i18n keys', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));
  const fr = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/fr/messages.json'), 'utf8'));

  const enKeys = Object.keys(en).sort();
  const frKeys = Object.keys(fr).sort();
  assert.deepEqual(enKeys, frKeys);

  for (const key of enKeys) {
    assert.match(key, /^[a-zA-Z0-9_@]+$/);
    assert.ok(en[key].message.length > 0, `Empty en message for ${key}`);
    assert.ok(fr[key].message.length > 0, `Empty fr message for ${key}`);
  }
});

test('no forbidden typographic dashes exist in project files', () => {
  const forbidden = /[\u2013\u2014]/;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|json|html|css|md)$/i.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        assert.equal(forbidden.test(content), false, `Forbidden dash found in ${full}`);
      }
    }
  };
  walk(ROOT);
});
