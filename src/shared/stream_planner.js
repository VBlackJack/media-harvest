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

import { DEFAULT_FILENAMES, QUALITY_PREFERENCES } from '../config/constants.js';
import { parseDashManifest } from './dash_parser.js';
import { isDashDescriptor, looksLikeDashXml } from './fetch_utils.js';
import { parseHlsPlaylist, selectBestVariant } from './hls_parser.js';
import { isHttpUrl } from './media_classifier.js';

/**
 * Returns true when a parsed playlist carries DRM or unsupported encryption.
 * Non-DRM AES-128 HLS playlists are allowed and decrypted via Web Crypto.
 * @param {object | null | undefined} parsed
 * @returns {boolean}
 */
export function isBlockedPlaylistEncryption(parsed) {
  return Boolean(parsed && (parsed.drmEncrypted || (parsed.encrypted && !parsed.decryptableAes128)));
}

/**
 * Selects the target video variant from a parsed HLS/DASH manifest.
 * @param {Array<object>} variants
 * @param {string} preferredVariantUrl
 * @param {string} qualityPreference
 * @returns {object | null}
 */
export function pickStreamVariant(variants, preferredVariantUrl, qualityPreference) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }
  const explicit = preferredVariantUrl
    ? variants.find((v) => v.url === preferredVariantUrl)
    : null;
  if (explicit) {
    return explicit;
  }
  if (qualityPreference === QUALITY_PREFERENCES.LOWEST) {
    return [...variants].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
  }
  return selectBestVariant(variants);
}

/**
 * Selects the best matching DASH audio track for the chosen video container and user preference.
 * @param {Array<object>} audioTracks
 * @param {boolean} preferWebm
 * @param {string} [preferredAudioUrl='']
 * @returns {object | null}
 */
export function resolveDashAudioTrack(audioTracks, preferWebm, preferredAudioUrl = '', selectedAudioId = '') {
  if (!Array.isArray(audioTracks) || audioTracks.length === 0) {
    return null;
  }
  const usable = audioTracks.filter((track) => track && Array.isArray(track.segments) && track.segments.length > 0);
  if (usable.length === 0) {
    return null;
  }
  const compatible = usable.filter((a) => {
    const trackIsWebm = (a.mimeType || '').toLowerCase() === 'audio/webm';
    return preferWebm ? trackIsWebm : !trackIsWebm;
  });
  const pool = compatible.length > 0 ? compatible : usable;
  return (
    (selectedAudioId && pool.find((a) => a.id === selectedAudioId))
    || (preferredAudioUrl && pool.find((a) => a.url === preferredAudioUrl))
    || pool.find((a) => a.isDefault)
    || pool[0]
    || null
  );
}

/**
 * Selects the best matching HLS master audio track for a chosen video variant.
 * @param {Array<object>} audioTracks
 * @param {object} chosenVariant
 * @param {string} [preferredAudioUrl='']
 * @returns {object | null}
 */
export function resolveHlsMasterAudioTrack(audioTracks, chosenVariant, preferredAudioUrl = '') {
  if (!Array.isArray(audioTracks) || audioTracks.length === 0) {
    return null;
  }
  const groupAudioTracks = chosenVariant && chosenVariant.audioGroup
    ? audioTracks.filter((a) => a.groupId === chosenVariant.audioGroup && a.url)
    : [];
  return (
    (preferredAudioUrl && audioTracks.find((a) => a.url === preferredAudioUrl))
    || groupAudioTracks.find((a) => a.isDefault)
    || groupAudioTracks[0]
    || audioTracks.find((a) => a.url && a.isDefault)
    || audioTracks.find((a) => a.url)
    || null
  );
}

/**
 * Resolves an HLS or DASH manifest URL into concrete video and optional audio playlists.
 * Shared across offscreen assembly and direct-to-disk Stream Saver.
 * @param {object} params
 * @param {string} params.masterOrMediaUrl
 * @param {string} [params.preferredVariantUrl='']
 * @param {string} [params.qualityPreference='best']
 * @param {string} [params.preferredAudioUrl='']
 * @param {(url: string) => Promise<string>} params.fetchText
 * @param {boolean} [params.allowLiveHls=false]
 * @param {boolean} [params.allowLiveDash=false]
 * @param {string} [params.encryptedErrorCode='ENCRYPTED_STREAM']
 * @param {string} [params.emptyErrorCode='EMPTY_PLAYLIST']
 * @returns {Promise<{
 *   format: 'hls' | 'dash',
 *   mediaPlaylist: object,
 *   audioPlaylist: object | null,
 *   videoPlaylistUrl: string,
 *   audioPlaylistUrl: string,
 *   selectedVariantId?: string,
 *   selectedAudioId?: string
 * }>}
 */
export async function resolveStreamPlan({
  masterOrMediaUrl,
  preferredVariantUrl = '',
  qualityPreference = QUALITY_PREFERENCES.BEST,
  preferredAudioUrl = '',
  fetchText,
  allowLiveHls = false,
  allowLiveDash = false,
  encryptedErrorCode = 'ENCRYPTED_STREAM',
  emptyErrorCode = 'EMPTY_PLAYLIST'
}) {
  const rootText = await fetchText(masterOrMediaUrl);
  const looksDash = isDashDescriptor(masterOrMediaUrl) || looksLikeDashXml(rootText);

  if (looksDash) {
    const dashParsed = parseDashManifest(rootText, masterOrMediaUrl);
    if (dashParsed.encrypted || dashParsed.drmEncrypted) {
      throw new Error(encryptedErrorCode);
    }
    if (dashParsed.isDynamic && !allowLiveDash) {
      throw new Error('LIVE_STREAM');
    }
    const chosenVariant = pickStreamVariant(dashParsed.variants, preferredVariantUrl, qualityPreference);
    if (!chosenVariant || !Array.isArray(chosenVariant.segments) || chosenVariant.segments.length === 0) {
      throw new Error(emptyErrorCode);
    }
    const isWebm = chosenVariant.mimeType === 'video/webm';
    const chosenAudio = resolveDashAudioTrack(dashParsed.audioTracks, isWebm, preferredAudioUrl);
    return {
      format: 'dash',
      mediaPlaylist: {
        ...chosenVariant,
        isDynamic: Boolean(dashParsed.isDynamic),
        initSegmentByteRange: null,
        outputExtension: isWebm ? DEFAULT_FILENAMES.WEBM_EXT : DEFAULT_FILENAMES.HLS_FMP4_EXT
      },
      audioPlaylist: chosenAudio
        ? {
            ...chosenAudio,
            initSegmentByteRange: null,
            outputExtension: isWebm ? DEFAULT_FILENAMES.WEBM_EXT : DEFAULT_FILENAMES.AUDIO_M4A_EXT
          }
        : null,
      videoPlaylistUrl: masterOrMediaUrl.split('#')[0],
      audioPlaylistUrl: '',
      selectedVariantId: chosenVariant.id || '',
      selectedAudioId: chosenAudio && chosenAudio.id ? chosenAudio.id : ''
    };
  }

  const rootParsed = parseHlsPlaylist(rootText, masterOrMediaUrl);
  if (isBlockedPlaylistEncryption(rootParsed)) {
    throw new Error(encryptedErrorCode);
  }
  if (rootParsed.isDynamic && !allowLiveHls) {
    throw new Error('LIVE_STREAM');
  }

  if (!rootParsed.isMaster) {
    let siblingAudioParsed = null;
    let siblingAudioUrl = '';
    if (isHttpUrl(preferredAudioUrl) && preferredAudioUrl !== masterOrMediaUrl) {
      try {
        const audioText = await fetchText(preferredAudioUrl);
        const candidate = parseHlsPlaylist(audioText, preferredAudioUrl);
        if (!isBlockedPlaylistEncryption(candidate) && candidate.segments.length > 0) {
          siblingAudioParsed = candidate;
          siblingAudioUrl = preferredAudioUrl;
        }
      } catch {
        // Ignore companion audio sub-playlist failure and continue with media playlist
      }
    }
    return {
      format: 'hls',
      mediaPlaylist: rootParsed,
      audioPlaylist: siblingAudioParsed,
      videoPlaylistUrl: masterOrMediaUrl,
      audioPlaylistUrl: siblingAudioUrl
    };
  }

  const chosenVariant = pickStreamVariant(rootParsed.variants, preferredVariantUrl, qualityPreference);
  if (!chosenVariant) {
    throw new Error(emptyErrorCode);
  }

  const videoText = await fetchText(chosenVariant.url);
  const videoParsed = parseHlsPlaylist(videoText, chosenVariant.url);
  if (isBlockedPlaylistEncryption(videoParsed)) {
    throw new Error(encryptedErrorCode);
  }
  if (videoParsed.isDynamic && !allowLiveHls) {
    throw new Error('LIVE_STREAM');
  }

  let audioParsed = null;
  let audioPlaylistUrl = '';
  const matchingAudio = resolveHlsMasterAudioTrack(rootParsed.audioTracks, chosenVariant, preferredAudioUrl);
  if (matchingAudio && matchingAudio.url && matchingAudio.url !== chosenVariant.url) {
    const audioText = await fetchText(matchingAudio.url);
    const candidate = parseHlsPlaylist(audioText, matchingAudio.url);
    if (!isBlockedPlaylistEncryption(candidate) && candidate.segments.length > 0) {
      audioParsed = candidate;
      audioPlaylistUrl = matchingAudio.url;
    }
  }

  return {
    format: 'hls',
    mediaPlaylist: videoParsed,
    audioPlaylist: audioParsed,
    videoPlaylistUrl: chosenVariant.url,
    audioPlaylistUrl
  };
}
