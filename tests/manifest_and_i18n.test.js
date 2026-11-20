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
const SKIP_DIRS = new Set(['.git', 'node_modules', 'local']);

test('manifest.json references existing files and valid MV3 structure', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));
  assert.ok(manifest.options_ui && manifest.options_ui.page);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.options_ui.page)));
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

test('en and fr locale files have matching valid Chrome i18n keys used by popup.html', () => {
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

  const htmlPaths = ['src/popup/popup.html', 'src/options/options.html', 'src/saver/stream_saver.html'];
  for (const relHtml of htmlPaths) {
    const html = fs.readFileSync(path.join(ROOT, relHtml), 'utf8');
    const htmlKeys = [...html.matchAll(/data-i18n(?:-title|-aria|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(htmlKeys.length > 0, `No i18n keys found in ${relHtml}`);
    for (const key of htmlKeys) {
      assert.ok(Object.hasOwn(en, key), `Missing i18n key in en (${relHtml}): ${key}`);
      assert.ok(Object.hasOwn(fr, key), `Missing i18n key in fr (${relHtml}): ${key}`);
    }
  }

  const popupHtml = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
  assert.equal(popupHtml.includes('aria-selected'), false);
  assert.equal(popupHtml.includes('role="tab"'), false);
  assert.ok(popupHtml.includes('aria-pressed="true"'));

  const scanJsFiles = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') {
          out.push(...scanJsFiles(full));
        }
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
    return out;
  };

  const jsKeysChecked = [];
  for (const jsFile of scanJsFiles(path.join(ROOT, 'src'))) {
    const code = fs.readFileSync(jsFile, 'utf8');
    const rel = path.relative(ROOT, jsFile).replace(/\\/g, '/');
    for (const match of code.matchAll(/\b(?:t|msg|translateFn|translate)\(\s*'([a-zA-Z0-9_]+)'/g)) {
      const key = match[1];
      jsKeysChecked.push(key);
      assert.ok(Object.hasOwn(en, key), `Missing JS i18n key in en (${rel}): ${key}`);
      assert.ok(Object.hasOwn(fr, key), `Missing JS i18n key in fr (${rel}): ${key}`);
    }
  }
  assert.ok(jsKeysChecked.length > 15, 'Expected JS i18n key validation to scan t()/msg() calls');
});

test('no forbidden typographic characters exist in tracked text files (recursively)', () => {
  const forbidden = /[\u2010\u2013\u2014\u2212\u2018\u2019\u201c\u201d\u00ab\u00bb\u2026\u00a0\u202f\u200b\ufeff\u0152\u0153\u00c6\u00e6]/;
  const scannedFiles = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
        continue;
      }
      if (/\.(js|mjs|json|html|css|md|yml|yaml|py|ps1|sh)$/i.test(entry.name)) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full).replace(/\\/g, '/');
        scannedFiles.push(rel);
        const content = fs.readFileSync(full, 'utf8');
        const match = content.match(forbidden);
        assert.equal(
          match,
          null,
          `Forbidden typography character U+${match ? match[0].codePointAt(0).toString(16).toUpperCase() : ''} found in ${rel}`
        );
      }
    }
  };

  walk(ROOT);
  assert.ok(
    scannedFiles.includes('src/shared/media_classifier.js'),
    'Recursive typography guard must traverse nested subdirectories (src/shared/)'
  );
  assert.ok(
    scannedFiles.includes('_locales/fr/messages.json'),
    'Recursive typography guard must traverse _locales/fr/'
  );
  assert.ok(
    scannedFiles.includes('companion/media_harvest_host.py'),
    'Recursive typography guard must traverse companion Python script'
  );
  assert.ok(
    scannedFiles.includes('companion/install_companion.ps1'),
    'Recursive typography guard must traverse companion PowerShell installer'
  );
  assert.ok(
    scannedFiles.includes('companion/install_companion.sh'),
    'Recursive typography guard must traverse companion Shell installer'
  );
  assert.ok(
    scannedFiles.includes('docs/fr/ARCHITECTURE.md'),
    'Recursive typography guard must traverse docs/fr/'
  );
  assert.ok(
    scannedFiles.includes('docs/release-notes/v1.3.1.md'),
    'Recursive typography guard must traverse docs/release-notes/'
  );
});
