#!/usr/bin/env python3
# Copyright 2026 Julien Bombled
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Chrome Native Messaging companion host delegating media downloads to yt-dlp."""

import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
from urllib.parse import urlparse

HOST_VERSION = '1.0.0'
HOST_NAME = 'com.mediaharvest.companion'
MAX_MESSAGE_BYTES = 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 600
DOWNLOAD_SUBFOLDER = 'MediaHarvest'
ALLOWED_COOKIE_BROWSERS = frozenset({'chrome', 'edge', 'firefox'})
PROGRESS_PERCENT_RE = re.compile(r'\[download\]\s+(\d+(?:\.\d+)?)%')


def is_valid_http_url(raw_url):
    """Returns True when raw_url is a well-formed HTTP or HTTPS URL."""
    if not isinstance(raw_url, str) or not raw_url.strip():
        return False
    try:
        parsed = urlparse(raw_url.strip())
    except ValueError:
        return False
    return parsed.scheme in ('http', 'https') and bool(parsed.netloc)


def sanitize_output_stem(raw_name):
    """Sanitizes a user-supplied filename stem against invalid characters and traversal."""
    if not isinstance(raw_name, str) or not raw_name.strip():
        return ''
    leaf = raw_name.replace('\\', '/').split('/')[-1]
    stem = re.sub(r'\.[^.]+$', '', leaf)
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', stem).strip(' ._')
    return cleaned[:96]


def resolve_output_dir(base_dir=None):
    """Ensures the destination directory exists inside Downloads/MediaHarvest."""
    root = Path(base_dir) if base_dir else (Path.home() / 'Downloads' / DOWNLOAD_SUBFOLDER)
    root.mkdir(parents=True, exist_ok=True)
    return root


def build_ytdlp_command(ytdlp_bin, ffmpeg_bin, payload, output_dir):
    """Builds a safe argv list for yt-dlp without invoking a shell."""
    url = payload.get('url', '').strip()
    if not is_valid_http_url(url):
        raise ValueError('INVALID_URL')

    stem = sanitize_output_stem(payload.get('filename', ''))
    template_name = f'{stem}.%(ext)s' if stem else '%(title).100B.%(ext)s'
    output_template = str(Path(output_dir) / template_name)

    quality = payload.get('quality', 'best')
    format_spec = 'worst' if quality == 'lowest' else 'bestvideo*+bestaudio/best'

    args = [
        ytdlp_bin,
        '--no-playlist',
        '--no-warnings',
        '--restrict-filenames',
        '-f',
        format_spec,
        '-o',
        output_template,
    ]
    if ffmpeg_bin:
        args.extend(['--ffmpeg-location', str(Path(ffmpeg_bin).parent)])

    referer = payload.get('referer', '')
    if is_valid_http_url(referer):
        args.extend(['--referer', referer.strip()])

    cookies_browser = str(payload.get('cookiesBrowser', '') or '').strip().lower()
    if cookies_browser in ALLOWED_COOKIE_BROWSERS:
        args.extend(['--cookies-from-browser', cookies_browser])

    if payload.get('streamProgress'):
        args.append('--newline')

    args.append('--')
    args.append(url)
    return args


def query_ytdlp_version(ytdlp_bin):
    """Reads installed yt-dlp version string or returns empty string."""
    if not ytdlp_bin:
        return ''
    try:
        proc = subprocess.run(
            [ytdlp_bin, '--version'],
            capture_output=True,
            text=True,
            shell=False,
            timeout=10,
            check=False,
        )
        return proc.stdout.strip() if proc.returncode == 0 else ''
    except (OSError, subprocess.SubprocessError):
        return ''


def handle_message(payload):
    """Processes one Native Messaging JSON request object and returns a response dict."""
    if not isinstance(payload, dict):
        return {'ok': False, 'error': 'COMPANION_FAILED'}

    action = payload.get('action', '')
    ytdlp_bin = shutil.which('yt-dlp') or ''
    ffmpeg_bin = shutil.which('ffmpeg') or ''

    if action == 'ping':
        version = query_ytdlp_version(ytdlp_bin)
        return {
            'ok': bool(ytdlp_bin and version),
            'hostVersion': HOST_VERSION,
            'ytDlpVersion': version,
            'ffmpegAvailable': bool(ffmpeg_bin),
            'error': '' if (ytdlp_bin and version) else 'YTDLP_NOT_FOUND',
        }

    if action == 'download':
        if not ytdlp_bin:
            return {'ok': False, 'error': 'YTDLP_NOT_FOUND'}
        try:
            out_dir = resolve_output_dir()
            cmd = build_ytdlp_command(ytdlp_bin, ffmpeg_bin, payload, out_dir)
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                shell=False,
                timeout=DOWNLOAD_TIMEOUT_SECONDS,
                check=False,
            )
        except ValueError as exc:
            return {'ok': False, 'error': str(exc)}
        except (OSError, subprocess.SubprocessError):
            return {'ok': False, 'error': 'COMPANION_FAILED'}

        if proc.returncode != 0:
            return {'ok': False, 'error': 'COMPANION_FAILED'}
        return {'ok': True, 'outputDir': str(out_dir)}

    return {'ok': False, 'error': 'UNKNOWN_ACTION'}


def read_native_message(stream=None):
    """Reads one length-prefixed UTF-8 JSON message from stdin."""
    reader = stream or sys.stdin.buffer
    raw_len = reader.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    if msg_len == 0 or msg_len > MAX_MESSAGE_BYTES:
        return None
    raw_body = reader.read(msg_len)
    if not raw_body or len(raw_body) < msg_len:
        return None
    return json.loads(raw_body.decode('utf-8'))


def write_native_message(payload, stream=None):
    """Writes one length-prefixed UTF-8 JSON response to stdout."""
    writer = stream or sys.stdout.buffer
    encoded = json.dumps(payload, ensure_ascii=True).encode('utf-8')
    writer.write(struct.pack('<I', len(encoded)))
    writer.write(encoded)
    writer.flush()


def stream_download(payload, stream=None):
    """Streams yt-dlp progress events over Native Messaging stdout before emitting completion."""
    ytdlp_bin = shutil.which('yt-dlp') or ''
    ffmpeg_bin = shutil.which('ffmpeg') or ''
    if not ytdlp_bin:
        write_native_message({'event': 'done', 'ok': False, 'error': 'YTDLP_NOT_FOUND'}, stream)
        return
    try:
        out_dir = resolve_output_dir()
        cmd = build_ytdlp_command(ytdlp_bin, ffmpeg_bin, payload, out_dir)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            shell=False,
        )
    except ValueError as exc:
        write_native_message({'event': 'done', 'ok': False, 'error': str(exc)}, stream)
        return
    except OSError:
        write_native_message({'event': 'done', 'ok': False, 'error': 'COMPANION_FAILED'}, stream)
        return

    last_percent = -1
    if proc.stdout is not None:
        for line in proc.stdout:
            match = PROGRESS_PERCENT_RE.search(line)
            if match:
                pct = int(float(match.group(1)))
                if pct != last_percent:
                    last_percent = pct
                    write_native_message({'event': 'progress', 'percent': pct}, stream)

    try:
        code = proc.wait(timeout=DOWNLOAD_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        proc.kill()
        write_native_message({'event': 'done', 'ok': False, 'error': 'COMPANION_FAILED'}, stream)
        return

    if code != 0:
        write_native_message({'event': 'done', 'ok': False, 'error': 'COMPANION_FAILED'}, stream)
        return
    write_native_message({'event': 'done', 'ok': True, 'outputDir': str(out_dir)}, stream)


def main():
    while True:
        try:
            message = read_native_message()
        except (ValueError, OSError):
            write_native_message({'ok': False, 'error': 'COMPANION_FAILED'})
            break
        if message is None:
            break
        if isinstance(message, dict) and message.get('action') == 'download' and message.get('streamProgress'):
            stream_download(message)
        else:
            response = handle_message(message)
            write_native_message(response)


if __name__ == '__main__':
    main()
