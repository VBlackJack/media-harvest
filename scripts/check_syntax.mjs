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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['src', 'tests', 'scripts'];
const SKIP_DIR_PATHS = new Set([path.join(ROOT_DIR, 'src', 'vendor')]);

/**
 * Recursively collects JavaScript files to syntax-check.
 * @param {string} dir
 * @returns {Array<string>}
 */
function collectJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR_PATHS.has(fullPath)) {
        results.push(...collectJsFiles(fullPath));
      }
    } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = TARGET_DIRS.flatMap((rel) => collectJsFiles(path.join(ROOT_DIR, rel)));
let failed = false;

for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (res.status !== 0) {
    failed = true;
  }
}

function checkPythonSyntax() {
  const pyScript = path.join(ROOT_DIR, 'companion', 'media_harvest_host.py');
  if (!fs.existsSync(pyScript)) {
    return true;
  }
  for (const candidate of [['python', []], ['py', ['-3']]]) {
    const probe = spawnSync(candidate[0], [...candidate[1], '--version'], { stdio: 'ignore' });
    if (probe.status === 0) {
      const res = spawnSync(candidate[0], [...candidate[1], '-m', 'py_compile', pyScript], { stdio: 'inherit' });
      return res.status === 0;
    }
  }
  return true;
}

if (!checkPythonSyntax()) {
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} files and companion scripts.`);
