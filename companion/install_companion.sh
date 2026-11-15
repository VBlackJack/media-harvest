#!/usr/bin/env bash
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

set -euo pipefail

EXTENSION_ID="${1:-}"
HOST_NAME="com.mediaharvest.companion"

if [[ ! "${EXTENSION_ID}" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: ./companion/install_companion.sh <32-char-extension-id>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="${SCRIPT_DIR}/media_harvest_host.py"

if [[ ! -f "${HOST_SCRIPT}" ]]; then
  echo "Missing companion script: ${HOST_SCRIPT}" >&2
  exit 1
fi

chmod +x "${HOST_SCRIPT}"

TARGET_DIRS=()
if [[ "$(uname -s)" == "Darwin" ]]; then
  TARGET_DIRS+=(
    "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts"
    "${HOME}/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  )
else
  TARGET_DIRS+=(
    "${HOME}/.config/google-chrome/NativeMessagingHosts"
    "${HOME}/.config/chromium/NativeMessagingHosts"
    "${HOME}/.config/microsoft-edge/NativeMessagingHosts"
  )
fi

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "${HOST_NAME}",
  "description": "Media Harvest Native Messaging companion for yt-dlp and ffmpeg",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF
)

for target_dir in "${TARGET_DIRS[@]}"; do
  mkdir -p "${target_dir}"
  manifest_path="${target_dir}/${HOST_NAME}.json"
  echo "${MANIFEST_CONTENT}" > "${manifest_path}"
  echo "Registered host manifest at: ${manifest_path}"
done

HAS_PYTHON=$(command -v python3 >/dev/null 2>&1 && echo "yes" || echo "no")
HAS_YTDLP=$(command -v yt-dlp >/dev/null 2>&1 && echo "yes" || echo "no")
HAS_FFMPEG=$(command -v ffmpeg >/dev/null 2>&1 && echo "yes" || echo "no")

echo "Checks -> Python: ${HAS_PYTHON} | yt-dlp: ${HAS_YTDLP} | ffmpeg: ${HAS_FFMPEG}"
