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

import { DEFAULT_FILENAMES } from '../config/constants.js';

const MAX_TIMELINE_SEGMENTS = 10000;

/**
 * Decodes standard XML entities in attribute values and text nodes.
 * @param {string} raw
 * @returns {string}
 */
export function decodeXmlEntities(raw) {
  if (typeof raw !== 'string' || !raw.includes('&')) {
    return raw || '';
  }
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/**
 * Parses an ISO-8601 duration (e.g. PT1M30.5S) into seconds.
 * @param {string} iso
 * @returns {number}
 */
export function parseIsoDurationSec(iso) {
  if (typeof iso !== 'string' || !iso) {
    return 0;
  }
  const match = iso.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
  );
  if (!match) {
    return 0;
  }
  const years = Number.parseInt(match[1] || '0', 10);
  const months = Number.parseInt(match[2] || '0', 10);
  const weeks = Number.parseInt(match[3] || '0', 10);
  const days = Number.parseFloat(match[4] || '0');
  const hours = Number.parseFloat(match[5] || '0');
  const minutes = Number.parseFloat(match[6] || '0');
  const seconds = Number.parseFloat(match[7] || '0');
  return Math.round(
    (years * 365 * 86400) +
    (months * 30 * 86400) +
    (weeks * 7 * 86400) +
    (days * 86400) +
    (hours * 3600) +
    (minutes * 60) +
    seconds
  );
}

/**
 * Parses XML attributes from a tag header string.
 * @param {string} attrChunk
 * @returns {Record<string, string>}
 */
function parseXmlAttributes(attrChunk) {
  const attrs = {};
  const attrPattern = /([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = attrPattern.exec(attrChunk);
  while (match !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2] !== undefined ? match[2] : match[3]);
    match = attrPattern.exec(attrChunk);
  }
  return attrs;
}

/**
 * Minimal pure-JS XML parser for DASH MPD documents (safe in MV3 Service Workers and Node).
 * @param {string} xmlText
 * @returns {object | null}
 */
export function parseXmlTree(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    return null;
  }
  const cleaned = xmlText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<![^>]*>/g, '');

  const root = { tag: '#root', attrs: {}, text: '', children: [] };
  const stack = [root];
  const tokenPattern = /<(\/?)([A-Za-z0-9_:-]+)([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let match = tokenPattern.exec(cleaned);

  while (match !== null) {
    const parent = stack[stack.length - 1];
    if (match.index > lastIndex) {
      const textChunk = decodeXmlEntities(cleaned.slice(lastIndex, match.index)).trim();
      if (textChunk) {
        parent.text += textChunk;
      }
    }
    lastIndex = tokenPattern.lastIndex;

    const isClosing = match[1] === '/';
    const tag = match[2].includes(':') ? match[2].split(':').pop() : match[2];
    const attrStr = match[3] || '';
    const isSelfClosing = match[4] === '/' || /\/\s*$/.test(attrStr);

    if (isClosing) {
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      const node = {
        tag,
        attrs: parseXmlAttributes(attrStr),
        text: '',
        children: []
      };
      parent.children.push(node);
      if (!isSelfClosing) {
        stack.push(node);
      }
    }

    match = tokenPattern.exec(cleaned);
  }

  return root.children[0] || null;
}

/**
 * Resolves a child URL or BaseURL against an existing base URL safely.
 * @param {string} raw
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveUrlSafe(raw, baseUrl) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return baseUrl;
  }
  try {
    const resolved = new URL(raw.trim(), baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return '';
    }
    return resolved.href;
  } catch {
    return '';
  }
}

/**
 * Collects direct child elements matching a tag name.
 * @param {object} node
 * @param {string} tagName
 * @returns {Array<object>}
 */
function findChildren(node, tagName) {
  return (node && node.children ? node.children : []).filter((c) => c.tag === tagName);
}

/**
 * Resolves hierarchical BaseURL value for a DASH element.
 * @param {object} node
 * @param {string} parentBase
 * @returns {string}
 */
function resolveElementBaseUrl(node, parentBase) {
  const baseNode = findChildren(node, 'BaseURL')[0];
  if (!baseNode || !baseNode.text) {
    return parentBase;
  }
  return resolveUrlSafe(baseNode.text, parentBase);
}

/**
 * Substitutes DASH SegmentTemplate placeholders ($Number$, $Time$, $RepresentationID$, $Bandwidth$).
 * @param {string} template
 * @param {{ repId: string, bandwidth: number, number: number, time: number }} vars
 * @returns {string}
 */
export function expandDashTemplate(template, vars) {
  if (!template) {
    return '';
  }
  return template.replace(
    /\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
    (full, name, widthStr) => {
      if (full === '$$') {
        return '$';
      }
      if (name === 'RepresentationID') {
        return vars.repId || '';
      }
      const rawValue = name === 'Bandwidth'
        ? vars.bandwidth
        : (name === 'Number' ? vars.number : vars.time);
      const str = String(rawValue ?? 0);
      const width = widthStr ? Number.parseInt(widthStr, 10) : 0;
      return width > 0 ? str.padStart(width, '0') : str;
    }
  );
}

/**
 * Merges inherited SegmentTemplate / SegmentList fields from ancestor containers.
 * @param {object} node
 * @param {object | null} inheritedTemplate
 * @param {object | null} inheritedList
 * @returns {{ template: object | null, list: object | null }}
 */
function mergeSegmentConfigs(node, inheritedTemplate, inheritedList) {
  const ownTemplate = findChildren(node, 'SegmentTemplate')[0];
  const ownList = findChildren(node, 'SegmentList')[0];

  let template = inheritedTemplate;
  if (ownTemplate) {
    const timeline = findChildren(ownTemplate, 'SegmentTimeline')[0]
      || (inheritedTemplate && inheritedTemplate.timeline)
      || null;
    template = {
      attrs: { ...(inheritedTemplate ? inheritedTemplate.attrs : {}), ...ownTemplate.attrs },
      timeline
    };
  }

  let list = inheritedList;
  if (ownList) {
    list = ownList;
  }

  return { template, list };
}

/**
 * Builds resolved init segment and media segment URLs for a Representation.
 * @param {object} repNode
 * @param {string} repBaseUrl
 * @param {{ template: object | null, list: object | null }} segConfig
 * @param {number} periodDurationSec
 * @returns {{ initSegmentUrl: string | null, segments: Array<{ url: string, duration: number, byteRange: null }>, isProgressive: boolean }}
 */
function buildRepresentationSegments(repNode, repBaseUrl, segConfig, periodDurationSec) {
  const repId = repNode.attrs.id || '';
  const bandwidth = Number.parseInt(repNode.attrs.bandwidth, 10) || 0;
  const { template, list } = segConfig;

  if (template) {
    const attrs = template.attrs;
    const timescale = Number.parseInt(attrs.timescale, 10) || 1;
    const parsedStart = Number.parseInt(attrs.startNumber, 10);
    const startNumber = Number.isFinite(parsedStart) ? parsedStart : 1;
    const initUrlCandidate = attrs.initialization
      ? resolveUrlSafe(expandDashTemplate(attrs.initialization, { repId, bandwidth, number: startNumber, time: 0 }), repBaseUrl)
      : '';
    const initSegmentUrl = initUrlCandidate || null;

    const segments = [];
    if (template.timeline) {
      let currentTime = 0;
      let segNumber = startNumber;
      for (const sNode of findChildren(template.timeline, 'S')) {
        if (sNode.attrs.t !== undefined) {
          currentTime = Number.parseInt(sNode.attrs.t, 10) || 0;
        }
        const d = Number.parseInt(sNode.attrs.d, 10) || 0;
        let r = sNode.attrs.r !== undefined ? Number.parseInt(sNode.attrs.r, 10) : 0;
        if (r < 0) {
          if (d > 0 && periodDurationSec > 0) {
            const totalTicks = Math.ceil((periodDurationSec * timescale - currentTime) / d);
            r = Math.max(0, Math.min(MAX_TIMELINE_SEGMENTS, totalTicks - 1));
          } else {
            r = 0;
          }
        }
        const count = Math.min(r + 1, MAX_TIMELINE_SEGMENTS - segments.length);
        for (let i = 0; i < count; i += 1) {
          const mediaPath = expandDashTemplate(attrs.media, {
            repId,
            bandwidth,
            number: segNumber,
            time: currentTime
          });
          if (mediaPath) {
            const url = resolveUrlSafe(mediaPath, repBaseUrl);
            if (url) {
              segments.push({
                url,
                duration: d / timescale,
                byteRange: null
              });
            }
          }
          currentTime += d;
          segNumber += 1;
        }
        if (segments.length >= MAX_TIMELINE_SEGMENTS) {
          break;
        }
      }
    } else if (attrs.duration && periodDurationSec > 0 && attrs.media) {
      const segDurationSec = (Number.parseInt(attrs.duration, 10) || 0) / timescale;
      if (segDurationSec > 0) {
        const count = Math.min(MAX_TIMELINE_SEGMENTS, Math.ceil(periodDurationSec / segDurationSec));
        for (let i = 0; i < count; i += 1) {
          const mediaPath = expandDashTemplate(attrs.media, {
            repId,
            bandwidth,
            number: startNumber + i,
            time: i * (Number.parseInt(attrs.duration, 10) || 0)
          });
          const url = resolveUrlSafe(mediaPath, repBaseUrl);
          if (url) {
            segments.push({
              url,
              duration: segDurationSec,
              byteRange: null
            });
          }
        }
      }
    }

    return { initSegmentUrl, segments, isProgressive: false };
  }

  if (list) {
    const initEl = findChildren(list, 'Initialization')[0];
    const initSegmentUrl = initEl && initEl.attrs.sourceURL
      ? resolveUrlSafe(initEl.attrs.sourceURL, repBaseUrl)
      : null;
    const timescale = Number.parseInt(list.attrs.timescale, 10) || 1;
    const duration = (Number.parseInt(list.attrs.duration, 10) || 0) / timescale;
    const segments = findChildren(list, 'SegmentURL')
      .filter((s) => s.attrs.media)
      .map((s) => ({
        url: resolveUrlSafe(s.attrs.media, repBaseUrl),
        duration,
        byteRange: null
      }));
    return { initSegmentUrl, segments, isProgressive: false };
  }

  const ownBase = findChildren(repNode, 'BaseURL')[0];
  if (ownBase && ownBase.text) {
    return {
      initSegmentUrl: null,
      segments: [{ url: repBaseUrl, duration: periodDurationSec, byteRange: null }],
      isProgressive: true
    };
  }

  return { initSegmentUrl: null, segments: [], isProgressive: false };
}

/**
 * Parses a DASH MPD XML manifest into a unified stream descriptor compatible with HLS inspection and muxing.
 * Refuses DRM-protected (ContentProtection) and dynamic live manifests explicitly.
 * @param {string} xmlText
 * @param {string} baseUrl
 * @returns {object}
 */
export function parseDashManifest(xmlText, baseUrl) {
  const mpd = parseXmlTree(xmlText);
  if (!mpd || mpd.tag !== 'MPD') {
    throw new Error('INVALID_DASH_MANIFEST');
  }

  const isDynamic = (mpd.attrs.type || 'static').toLowerCase() === 'dynamic';
  const mpdDurationSec = parseIsoDurationSec(mpd.attrs.mediaPresentationDuration);
  const mpdBaseUrl = resolveElementBaseUrl(mpd, baseUrl);
  const mpdConfig = mergeSegmentConfigs(mpd, null, null);

  let encrypted = false;
  let encryptionMethod = 'NONE';
  const variants = [];
  const audioTracks = [];
  let totalDurationSec = mpdDurationSec;

  const markProtection = (node) => {
    const prot = findChildren(node, 'ContentProtection')[0];
    if (prot) {
      encrypted = true;
      encryptionMethod = prot.attrs.value || prot.attrs.schemeIdUri || 'DRM';
    }
  };

  for (const period of findChildren(mpd, 'Period')) {
    const periodBaseUrl = resolveElementBaseUrl(period, mpdBaseUrl);
    const periodDurationSec = parseIsoDurationSec(period.attrs.duration) || mpdDurationSec;
    if (!totalDurationSec && periodDurationSec) {
      totalDurationSec = periodDurationSec;
    }
    const periodConfig = mergeSegmentConfigs(period, mpdConfig.template, mpdConfig.list);

    for (const adaptation of findChildren(period, 'AdaptationSet')) {
      markProtection(adaptation);
      const adaptationBaseUrl = resolveElementBaseUrl(adaptation, periodBaseUrl);
      const adaptationConfig = mergeSegmentConfigs(adaptation, periodConfig.template, periodConfig.list);
      const contentType = (adaptation.attrs.contentType || '').toLowerCase();
      const adaptationMime = (adaptation.attrs.mimeType || '').toLowerCase();
      const lang = adaptation.attrs.lang || '';

      for (const rep of findChildren(adaptation, 'Representation')) {
        markProtection(rep);
        const repMime = (rep.attrs.mimeType || adaptationMime).toLowerCase();
        const isAudio = contentType === 'audio' || repMime.startsWith('audio/');
        const isVideo = contentType === 'video' || repMime.startsWith('video/');
        if (!isAudio && !isVideo) {
          continue;
        }

        const repBaseUrl = resolveElementBaseUrl(rep, adaptationBaseUrl);
        const repConfig = mergeSegmentConfigs(rep, adaptationConfig.template, adaptationConfig.list);
        const built = buildRepresentationSegments(rep, repBaseUrl, repConfig, periodDurationSec);
        if (built.segments.length === 0) {
          continue;
        }

        const width = Number.parseInt(rep.attrs.width || adaptation.attrs.width, 10) || 0;
        const height = Number.parseInt(rep.attrs.height || adaptation.attrs.height, 10) || 0;
        const bandwidth = Number.parseInt(rep.attrs.bandwidth, 10) || 0;
        const repId = rep.attrs.id || `${width}x${height}_${bandwidth}`;

        if (isAudio) {
          audioTracks.push({
            groupId: 'dash-audio',
            name: lang || repId || 'audio',
            language: lang,
            mimeType: repMime,
            bandwidth,
            url: `${baseUrl}#dash-audio-${repId}`,
            initSegmentUrl: built.initSegmentUrl,
            segments: built.segments,
            isProgressive: built.isProgressive
          });
        } else {
          variants.push({
            id: repId,
            bandwidth,
            width,
            height,
            resolution: width && height ? `${width}x${height}` : '',
            mimeType: repMime,
            audioGroup: 'dash-audio',
            url: `${baseUrl}#dash-video-${repId}`,
            initSegmentUrl: built.initSegmentUrl,
            segments: built.segments,
            isProgressive: built.isProgressive
          });
        }
      }
    }
  }

  // Prefer MP4 representations when both MP4 and WebM exist so fMP4 muxer works cleanly
  const hasMp4Video = variants.some((v) => v.mimeType === 'video/mp4');
  const filteredVariants = hasMp4Video
    ? variants.filter((v) => !v.mimeType || v.mimeType === 'video/mp4')
    : variants;
  filteredVariants.sort((a, b) => (b.width * b.height - a.width * a.height) || (b.bandwidth - a.bandwidth));

  const hasMp4Audio = audioTracks.some((a) => a.mimeType === 'audio/mp4');
  const filteredAudio = hasMp4Audio
    ? audioTracks.filter((a) => !a.mimeType || a.mimeType === 'audio/mp4')
    : audioTracks;
  filteredAudio.sort((a, b) => b.bandwidth - a.bandwidth);

  if (!totalDurationSec && filteredVariants.length > 0) {
    totalDurationSec = Math.round(
      filteredVariants[0].segments.reduce((acc, s) => acc + (s.duration || 0), 0)
    );
  }

  return {
    format: 'dash',
    isMaster: filteredVariants.length > 0,
    isDynamic,
    encrypted,
    encryptionMethod,
    variants: filteredVariants,
    audioTracks: filteredAudio,
    initSegmentUrl: null,
    segments: [],
    totalDurationSec,
    outputExtension: DEFAULT_FILENAMES.HLS_FMP4_EXT
  };
}
