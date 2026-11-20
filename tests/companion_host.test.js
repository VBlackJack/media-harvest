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
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOST_SCRIPT = path.join(ROOT, 'companion', 'media_harvest_host.py');

function detectPythonCommand() {
  for (const candidate of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const res = spawnSync(candidate[0], [...candidate[1], '--version'], { encoding: 'utf8' });
    if (res.status === 0) {
      return candidate;
    }
  }
  return null;
}

test('companion host validates URLs, sanitizes output stems, and handles Native Messaging framing', (t) => {
  const py = detectPythonCommand();
  if (!py) {
    t.skip('Python 3 runtime not available on test runner');
    return;
  }

  const script = `
import io, importlib.util, json, struct
spec = importlib.util.spec_from_file_location('media_harvest_host', ${JSON.stringify(HOST_SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.is_valid_http_url('https://example.com/watch?v=1') is True
assert mod.is_valid_http_url('file:///etc/passwd') is False
assert mod.is_valid_http_url('javascript:alert(1)') is False

assert mod.sanitize_output_stem('../../bad:name?.mp4') == 'bad_name'
assert '%' not in mod.sanitize_output_stem('video_%(id)s_100%.mp4')
assert mod.sanitize_output_stem('CON.mp4') == '_CON'
assert mod.sanitize_output_stem('nul.webm') == '_nul'
cmd = mod.build_ytdlp_command('C:\\\\tools\\\\yt-dlp.exe', '', {
    'url': 'https://example.com/v',
    'referer': 'https://example.com/',
    'filename': 'My Clip.mp4',
    'quality': 'best',
    'cookiesBrowser': 'chrome',
    'streamProgress': True
}, 'C:\\\\Downloads\\\\MediaHarvest')
assert cmd[0] == 'C:\\\\tools\\\\yt-dlp.exe'
assert '--referer' in cmd and 'https://example.com/' in cmd
assert '--cookies-from-browser' in cmd and 'chrome' in cmd
assert '--newline' in cmd
assert cmd[-2:] == ['--', 'https://example.com/v']

cmd_unsafe = mod.build_ytdlp_command('C:\\\\tools\\\\yt-dlp.exe', '', {
    'url': 'https://example.com/v',
    'cookiesBrowser': 'evil;rm -rf'
}, 'C:\\\\Downloads\\\\MediaHarvest')
assert '--cookies-from-browser' not in cmd_unsafe

cmd_audio = mod.build_ytdlp_command('C:\\\\tools\\\\yt-dlp.exe', '', {
    'url': 'https://example.com/v',
    'audioOnly': True,
    'audioFormat': 'mp3'
}, 'C:\\\\Downloads\\\\MediaHarvest')
assert '--extract-audio' in cmd_audio
assert '--audio-format' in cmd_audio and 'mp3' in cmd_audio
assert 'bestaudio/best' in cmd_audio

cmd_audio_invalid = mod.build_ytdlp_command('C:\\\\tools\\\\yt-dlp.exe', '', {
    'url': 'https://example.com/v',
    'audioOnly': True,
    'audioFormat': 'exe'
}, 'C:\\\\Downloads\\\\MediaHarvest')
assert 'mp3' in cmd_audio_invalid and 'exe' not in cmd_audio_invalid

buf = io.BytesIO()
mod.write_native_message({'ok': True, 'hostVersion': mod.HOST_VERSION}, buf)
buf.seek(0)
decoded = mod.read_native_message(buf)
assert decoded == {'ok': True, 'hostVersion': mod.HOST_VERSION}
print('PY_COMPANION_OK')
`;

  const result = spawnSync(py[0], [...py[1], '-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.includes('PY_COMPANION_OK'));
});

test('companion host stream_download enforces wall-clock timeout and cleans up hanging child process', (t) => {
  const py = detectPythonCommand();
  if (!py) {
    t.skip('Python 3 runtime not available on test runner');
    return;
  }

  const script = `
import io, importlib.util, shutil, sys
spec = importlib.util.spec_from_file_location('media_harvest_host', ${JSON.stringify(HOST_SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

orig_which = shutil.which
orig_build = mod.build_ytdlp_command
shutil.which = lambda name: sys.executable if name == 'yt-dlp' else ''
mod.build_ytdlp_command = lambda ytdlp, ff, payload, out_dir: [
    sys.executable, '-u', '-c', 'import time; print("[download] 12.5%", flush=True); time.sleep(30)'
]
try:
    out_buf = io.BytesIO()
    mod.stream_download({'url': 'https://example.com/v', 'streamProgress': True}, stream=out_buf, timeout_seconds=0.4)
    out_buf.seek(0)
    msgs = []
    while True:
        m = mod.read_native_message(out_buf)
        if m is None:
            break
        msgs.append(m)
    assert any(m.get('event') == 'progress' and m.get('percent') == 12 for m in msgs), msgs
    assert msgs[-1]['event'] == 'done' and msgs[-1]['ok'] is False and msgs[-1]['error'] == 'COMPANION_TIMEOUT', msgs
    print('PY_TIMEOUT_OK')
finally:
    shutil.which = orig_which
    mod.build_ytdlp_command = orig_build
`;

  const result = spawnSync(py[0], [...py[1], '-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.includes('PY_TIMEOUT_OK'));
});
