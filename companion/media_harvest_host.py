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
import queue
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse

HOST_VERSION = '1.1.0'
HOST_NAME = 'com.mediaharvest.companion'
MAX_MESSAGE_BYTES = 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 600
VERSION_QUERY_TIMEOUT_SECONDS = 10
PROCESS_KILL_WAIT_SECONDS = 5
STREAM_POLL_INTERVAL_SECONDS = 0.25
MAX_OUTPUT_STEM_LENGTH = 96
DEFAULT_TITLE_MAX_BYTES = 100
DOWNLOAD_SUBFOLDER = 'MediaHarvest'
ALLOWED_COOKIE_BROWSERS = frozenset({'chrome', 'edge', 'firefox'})
ALLOWED_AUDIO_FORMATS = frozenset({'mp3', 'm4a', 'opus', 'wav'})
WINDOWS_RESERVED_STEMS = frozenset({
    'CON', 'PRN', 'AUX', 'NUL',
    *(f'COM{i}' for i in range(1, 10)),
    *(f'LPT{i}' for i in range(1, 10)),
})
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
    """Sanitizes a user-supplied filename stem against invalid chars, traversal, and yt-dlp templates."""
    if not isinstance(raw_name, str) or not raw_name.strip():
        return ''
    leaf = raw_name.replace('\\', '/').split('/')[-1]
    stem = re.sub(r'\.[^.]+$', '', leaf)
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f%]', '_', stem).strip(' ._')
    if not cleaned:
        return ''
    if cleaned.upper() in WINDOWS_RESERVED_STEMS:
        cleaned = f'_{cleaned}'
    return cleaned[:MAX_OUTPUT_STEM_LENGTH]


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
    template_name = f'{stem}.%(ext)s' if stem else f'%(title).{DEFAULT_TITLE_MAX_BYTES}B.%(ext)s'
    output_template = str(Path(output_dir) / template_name)

    quality = payload.get('quality', 'best')
    audio_only = bool(payload.get('audioOnly'))
    audio_format = str(payload.get('audioFormat', 'mp3') or 'mp3').strip().lower()
    if audio_format not in ALLOWED_AUDIO_FORMATS:
        audio_format = 'mp3'

    if audio_only:
        format_spec = 'bestaudio/best'
    else:
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
    if audio_only:
        args.extend(['--extract-audio', '--audio-format', audio_format])
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
            timeout=VERSION_QUERY_TIMEOUT_SECONDS,
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


def safe_write_native_message(payload, stream=None):
    """Writes a Native Messaging frame and returns False if the pipe is closed."""
    try:
        write_native_message(payload, stream)
        return True
    except (BrokenPipeError, OSError):
        return False


def terminate_process_tree(proc):
    """Terminates a subprocess and any child ffmpeg/yt-dlp processes without leaving orphans."""
    if proc is None:
        return
    try:
        if proc.poll() is not None:
            return
    except OSError:
        return
    try:
        if os.name == 'nt':
            subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                timeout=PROCESS_KILL_WAIT_SECONDS,
                check=False,
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(timeout=PROCESS_KILL_WAIT_SECONDS)
                return
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (OSError, ProcessLookupError, subprocess.SubprocessError):
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=PROCESS_KILL_WAIT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        pass


def stream_download(payload, stream=None, stdin_stream=None, timeout_seconds=DOWNLOAD_TIMEOUT_SECONDS):
    """Streams yt-dlp progress events over Native Messaging stdout with wall-clock timeout and cancellation."""
    ytdlp_bin = shutil.which('yt-dlp') or ''
    ffmpeg_bin = shutil.which('ffmpeg') or ''
    if not ytdlp_bin:
        safe_write_native_message({'event': 'done', 'ok': False, 'error': 'YTDLP_NOT_FOUND'}, stream)
        return

    popen_kwargs = {
        'stdout': subprocess.PIPE,
        'stderr': subprocess.STDOUT,
        'text': True,
        'shell': False,
    }
    if os.name == 'nt':
        popen_kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs['start_new_session'] = True

    try:
        out_dir = resolve_output_dir()
        cmd = build_ytdlp_command(ytdlp_bin, ffmpeg_bin, payload, out_dir)
        proc = subprocess.Popen(cmd, **popen_kwargs)
    except ValueError as exc:
        safe_write_native_message({'event': 'done', 'ok': False, 'error': str(exc)}, stream)
        return
    except OSError:
        safe_write_native_message({'event': 'done', 'ok': False, 'error': 'COMPANION_FAILED'}, stream)
        return

    line_queue = queue.Queue()
    cancel_event = threading.Event()
    disconnect_event = threading.Event()
    done_event = threading.Event()

    def read_stdout():
        try:
            if proc.stdout is not None:
                for line in proc.stdout:
                    line_queue.put(line)
        except OSError:
            pass
        finally:
            line_queue.put(None)

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stdout_thread.start()

    watch_stdin = stdin_stream if stdin_stream is not None else (sys.stdin.buffer if stream is None else None)
    if watch_stdin is not None:
        def read_control():
            while not done_event.is_set():
                try:
                    msg = read_native_message(watch_stdin)
                except (ValueError, OSError):
                    disconnect_event.set()
                    cancel_event.set()
                    return
                if msg is None:
                    disconnect_event.set()
                    cancel_event.set()
                    return
                if isinstance(msg, dict) and msg.get('action') == 'cancel':
                    cancel_event.set()
                    return

        threading.Thread(target=read_control, daemon=True).start()

    deadline = time.monotonic() + max(0.1, float(timeout_seconds))
    last_percent = -1
    eof_reached = False

    try:
        while not eof_reached:
            if cancel_event.is_set():
                terminate_process_tree(proc)
                if not disconnect_event.is_set():
                    safe_write_native_message({'event': 'done', 'ok': False, 'error': 'CANCELLED'}, stream)
                return

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                terminate_process_tree(proc)
                safe_write_native_message({'event': 'done', 'ok': False, 'error': 'COMPANION_TIMEOUT'}, stream)
                return

            try:
                line = line_queue.get(timeout=min(STREAM_POLL_INTERVAL_SECONDS, remaining))
            except queue.Empty:
                continue

            if line is None:
                eof_reached = True
                break

            match = PROGRESS_PERCENT_RE.search(line)
            if match:
                pct = int(float(match.group(1)))
                if pct != last_percent:
                    last_percent = pct
                    if not safe_write_native_message({'event': 'progress', 'percent': pct}, stream):
                        terminate_process_tree(proc)
                        return

        remaining = max(0.1, deadline - time.monotonic())
        try:
            code = proc.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            terminate_process_tree(proc)
            safe_write_native_message({'event': 'done', 'ok': False, 'error': 'COMPANION_TIMEOUT'}, stream)
            return

        if cancel_event.is_set():
            if not disconnect_event.is_set():
                safe_write_native_message({'event': 'done', 'ok': False, 'error': 'CANCELLED'}, stream)
            return

        if code != 0:
            safe_write_native_message({'event': 'done', 'ok': False, 'error': 'COMPANION_FAILED'}, stream)
            return
        safe_write_native_message({'event': 'done', 'ok': True, 'outputDir': str(out_dir)}, stream)
    finally:
        done_event.set()
        if proc.poll() is None:
            terminate_process_tree(proc)


def main():
    while True:
        try:
            message = read_native_message()
        except (ValueError, OSError):
            safe_write_native_message({'ok': False, 'error': 'COMPANION_FAILED'})
            break
        if message is None:
            break
        if isinstance(message, dict) and message.get('action') == 'download' and message.get('streamProgress'):
            stream_download(message)
        else:
            response = handle_message(message)
            if not safe_write_native_message(response):
                break


if __name__ == '__main__':
    main()
