[English version](../ARCHITECTURE.md)

# Media Harvest - Architecture

## Vue d'ensemble

Media Harvest est une extension Chrome et Firefox Manifest V3 écrite en modules ES natifs (zéro dépendance npm à l'exécution) avec une seule bibliothèque UMD intégrée localement (`src/vendor/mux-mp4.min.js`).

## Composants d'exécution

| Composant | Point d'entrée | Responsabilité |
|---|---|---|
| Service Worker | `src/background/service_worker.js`, `src/background/dnr_manager.js`, `src/background/companion_client.js`, `src/background/download_history.js`, `src/background/batch_queue.js` | Capture `webRequest`, éviction préservant les playlists maître, relais qualité/audio des boutons intégrés, nettoyage par route d'onglet, règles temporaires `declarativeNetRequest` (`Referer`/`Origin`) persistées en session (`downloadId` et portée `tabIds` Stream Saver avec purge des orphelins au démarrage), suivi MSE, orchestration `chrome.tabCapture`, pont compagnon `nativeMessaging` avec annulation en direct, file de lots résiliente en arrière-plan (`START_BATCH_QUEUE` / `CANCEL_BATCH_QUEUE`), transfert `OPEN_STREAM_SAVER` vers disque, persistance de l'historique récent, état de session, badge icône, cycle de vie offscreen (`OFFSCREEN_GET_ACTIVE_BUILDS`), isolation des émetteurs (`isExtensionSender`), téléchargements et annulations |
| Document Offscreen | `src/offscreen/offscreen.js`, `src/offscreen/opfs_spool.js`, `src/offscreen/tab_capture.js`, `src/offscreen/audio_transcoder.js`, `src/offscreen/image_processor.js` | Résolution des manifestes (via `stream_planner.js`), enregistrement DVR HLS/DASH en direct et capture d'onglet `MediaRecorder` (`startTabCaptureRecording` avec `tabCaptureBitrateMbps`) adossés au spool disque OPFS (`createOpfsSpool` avec nettoyage automatique à la révocation du Blob), téléchargement parallèle / par plages d'octets, fusion des sous-titres WebVTT et conversion `.srt`, assemblage MSE fMP4/WebM/mixte avec alignement temporel ABR (`OFFSCREEN_BUILD_MSE_BLOB`), extraction audio `.m4a`, Ogg/Opus WebCodecs `.opus` et `.wav` PCM 16 bits (`OFFSCREEN_DECODE_WAV`), extraction de symboles SVG (`OFFSCREEN_EXTRACT_SVG_SYMBOL`), conversion image/SVG à qualité et redimensionnement (`maxImageResizePx`) réglables, assemblage ZIP zéro-copie avec DEFLATE sélectif, plafond mémoire 512 Mo, muxage fMP4, transmuxage TS/ADTS, gestion des URL Blob |
| Écrivain Disque (`>512` Mo) | `src/saver/stream_saver.html`, `src/saver/stream_saver.js` | Onglet dédié File System Access (`window.showSaveFilePicker`) écrivant en continu les flux HTTP progressifs et HLS/DASH (`>512` Mo) avec délais d'attente gérés, réessais à backoff exponentiel, streaming double piste fMP4/WebM/mixte avec suivi audio continu `baseMediaDecodeTime` / `startSequenceNumber` et transmuxage incrémental MPEG-TS vers MP4 via `mux-mp4.min.js` |
| Interface Popup / Panneau latéral | `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/lightbox_controller.js`, `src/popup/history_controller.js`, `src/popup/media_card.js`, `src/popup/preview_player.js`, `src/popup/batch_runner.js`, `src/popup/popup_helpers.js` | Liste réconciliée des médias avec pagination par lots de 40 cartes et recherche temporisée (`120` ms), tiroir d'historique des téléchargements récents avec relance et vidage, bascule panneau latéral Chrome, filtres (sous-titres/SVG inclus), filtres rapides images (taille/extension/orientation), Lightbox Pro (`checker`/`light`/`dark`, navigation clavier `ArrowLeft`/`ArrowRight`, piège et restauration du focus, palette SVG, recolorisation en direct, réinitialisation des couleurs, `currentColor`, copie SVG/URL et téléchargement), contrôles `REC` de capture d'onglet, persistance filtre/tri, file d'inspection bornée avec réessai, sélecteurs qualité/audio/sous-titres, boutons `SRT` en un clic, badges MSE, boutons compagnon `yt-dlp` (avec annulation en direct) et sauvegarde directe sur disque (flux et vidéos HTTP `>512` Mo), aperçus vidéo/audio, sélection multiple vers file de lots arrière-plan / ZIP (noms d'origine ou séquentiels) avec arrêt, alertes >512 Mo |
| Page d'Options | `src/options/options.html`, `src/options/options.js` | Éditeur de paramètres synchronisés (`chrome.storage.sync`) avec validation, qualité JPG %, largeur maximale d'image (`0`-`3840` px), format audio (`m4a`/`opus`/`wav`), débit capture d'onglet (`1`-`16` Mbps), bascules sociales/MSE, exclusions d'overlay par domaine (`disabledOverlayHosts`), option Enregistrer sous, modèles de dossiers, vérification du compagnon et réinitialisation |
| Scripts de contenu | `src/content/dom_scanner.js`, `src/content/overlay_common.js`, `src/content/overlay_common.css`, `src/content/x_overlay.js`, `src/content/site_overlay.js`, `src/content/mse_hook.js`, `src/content/mse_bridge.js` | Analyse DOM multi-cadres (Shadow DOM, balises méta, JSON-LD, `<canvas>` non corrompus, `<svg>` en ligne + symboles de sprites `.svg#id` via `<use>`, fonds/masques CSS, `srcset`/`<picture>`, `<track>`), boutons intégrés partagés X/Twitter et sociaux avec menu rapide qualité/audio navigable au clavier et filtrage par domaine exclu, capture MSE (`world: "MAIN"`) et pont de flux (`ISOLATED`) sur `MessageChannel` privé avec validation de schéma/plafond et éviction LRU SPA |
| Compagnon local (optionnel) | `companion/media_harvest_host.py`, `companion/install_companion.ps1`, `companion/install_companion.sh` | Hôte Chrome Native Messaging Windows, Linux et macOS encapsulant proprement `yt-dlp` et `ffmpeg` en JSON préfixé sur stdio avec exécution `shell=False`, délai maximal réel et terminaison d'arbre de processus sur `cancel` |

## Modules partagés (`src/shared/`)

- `media_classifier.js` - Classification URL/MIME (dont URI `data:image/*`), validation HTTP(S), assainissement des noms de fichiers, extraction d'identifiants de posts X et déduplication.
- `fetch_utils.js` - Délai d'attente géré, signal d'annulation, réservation du plafond d'octets en flux/en-tête et détection DASH (`fetchWithManagedTimeout`, `isDashDescriptor`, `looksLikeDashXml`).
- `hls_parser.js` - Parseur `#EXTM3U` maître/média, tri par résolution/débit, détection DRM (`#EXT-X-KEY`, `#EXT-X-SESSION-KEY`), suivi `#EXT-X-DISCONTINUITY`, `#EXT-X-MAP` par segment, LL-HLS `#EXT-X-PART` et suivi d'offsets `#EXT-X-BYTERANGE` par URL cible.
- `hls_crypto.js` - Déchiffrement Web Crypto AES-128-CBC des segments HLS avec gestion de l'IV explicite ou dérivé de la séquence média.
- `dash_parser.js` - Parseur XML pur JS pour manifestes DASH `.mpd` statiques et directs dynamiques sans DRM (concaténation multi-Period, `BaseURL`, `SegmentTemplate` avec `SegmentTimeline` ou `duration`, `SegmentList`, `SegmentBase`, vidéo progressive, détection `ContentProtection`).
- `stream_planner.js` - Planification partagée des manifestes HLS/DASH et sélection des variantes vidéo/audio/sous-titres utilisée par `offscreen.js` et `stream_saver.js`.
- `subtitle_utils.js` - Fusion des repères WebVTT et conversion client WebVTT vers SubRip (`.srt`) (`convertWebVttToSrt`).
- `fmp4_muxer.js` - Parseur de boîtes ISO BMFF, muxeur vidéo+audio par fragments (`mergeFmp4InitSegments`, `mergeFmp4VideoAndAudioParts`, `normalizeFmp4Fragment`, `splitFmp4InitAndFragments`, `countTracksInInit`, `hasAudioTrackInInit`), alignement temporel ABR MSE (`alignFmp4MseFragments`) et extracteur audio seul `'soun'` (`extractAudioOnlyFromFmp4Parts`).
- `webm_muxer.js` - Muxeur WebM double piste EBML/Matroska pur JS (`buildDualWebmStreamInit`, `rewriteAudioClusterForMux`, `splitWebmInitAndClusters`, `countTracksInWebmInit`, `mergeWebmVideoAndAudioParts` avec alignement ABR optionnel) remappant les VINT `TrackNumber` audio et entrelaçant les clusters chronologiquement.
- `mixed_mse_muxer.js` - Muxeur mixte pur JS convertissant l'audio WebM Opus en fMP4 `'soun'` (`transmuxWebmOpusToFmp4Parts` avec suivi monotone `baseMediaDecodeTime` / `startSequenceNumber`) et assemblant vidéo WebM + audio fMP4 AAC en Matroska `.mkv` (`mergeWebmVideoAndFmp4AacParts`).
- `stream_selector.js` - Éviction préservant les playlists maître (`mergeCapturedMediaEntry`), classement des variantes vidéo (`rankVideoCandidates`) et appariement audio (`findSiblingStreamAudioUrl`, `findMatchingStreamForDirectUrl`, `findCompanionAudioUrl`).
- `adts_transmuxer.js` - Parseur ADTS AAC pur JS (avec préfixe ID3v2 optionnel et resynchronisation) et convertisseur vers fMP4 audio ISO BMFF (`looksLikeAdtsAudio`, `parseAdtsFrames`, `transmuxAdtsSegmentsToFmp4Parts` avec suivi continu `baseMediaDecodeTime` / `startSequenceNumber`).
- `ts_transmuxer.js` - Adaptateur autour de `muxjs.Transmuxer` produisant des segments `Uint8Array` sans copie contiguë (`transmuxTsSegmentsToMp4Parts`) avec vidage sur discontinuités (`discontinuityIndices`) pour MPEG-TS.
- `wav_encoder.js` - Encodeur RIFF/WAVE PCM 16 bits (`encodePcmWav`) convertissant un `AudioBuffer` ou des canaux `Float32Array` en flux audio `.wav` stéréo.
- `ogg_opus_muxer.js` - Muxeur pur JS RFC 3533/7845 (`oggCrc32`, `buildOpusHeadPacket`, `buildOpusTagsPacket`, `muxOpusPacketsToOgg`) encapsulant les paquets Opus encodés par WebCodecs `AudioEncoder` en fichiers `.opus`.
- `svg_utils.js` - Assainisseur et nettoyeur SVG (`optimizeSvgMarkup`, supprimant `<script>`, `<foreignObject>` et liens `javascript:`), extracteur de symboles sur sprites (`extractSymbolFromSvgSprite`), découpeur de fragment (`splitSvgSpriteUrl`), décodeur UTF-8 `data:image/svg+xml` (`decodeSvgDataUrl`) et utilitaires de palette/recolorisation (`normalizeSvgColor`, `extractSvgPalette`, `replaceSvgColor`, `convertSvgToCurrentColor`).
- `zip_builder.js` - Calcul CRC-32, nommage des entrées (`resolveZipEntryFilename`) et générateur d'archives ZIP zéro-copie par fragments (`buildZipUint8Array`, `buildZipBlob`, `buildZipUint8ArrayAsync`, `buildZipBlobAsync`) avec compression sélective `CompressionStream('deflate-raw')` sur les ressources texte/vectorielles (`ZIP_COMPRESSIBLE_EXTENSIONS`).
- `preview_matcher.js` - Associe les identifiants de flux X/Twitter (`ext_tw_video`, `amplify_video`, `tweet_video`) aux images d'aperçu des balises `<video>`.
- `settings.js` - Normalisation bornée (`normalizeSettings`, `clampInteger`), normalisation des domaines exclus (`disabledOverlayHosts`), modèles de nommage (`default`, `host_stem`, `date_stem`, `host_folder`, `date_folder`) et persistance `chrome.storage.sync`.
- `i18n.js` - Utilitaire `chrome.i18n` avec repli par clé et traduction DOM (`data-i18n`, `data-i18n-title`, `data-i18n-aria`, `data-i18n-placeholder`).

## Stockage et concurrence

- `chrome.storage.session` :
  - `tab_media_<tabId>` - Liste des médias réseau capturés par onglet (plafonnée à `120` éléments).
  - `tab_route_<tabId>` - Clé de route normalisée (`origin + pathname`) servant à vider les captures lors des navigations ou changements d'URL SPA.
  - `tab_mse_<tabId>` - Métadonnées des flux MSE suivis par onglet.
  - `tab_referer_<tabId>` - Métadonnées d'origine/Referer par onglet pour les requêtes authentifiées.
  - `dnr_download_<downloadId>` - Identifiants des règles DNR temporaires liées aux téléchargements actifs pour nettoyage après suspension du Service Worker.
  - `dnr_saver_tab_<tabId>` - Identifiants des règles DNR temporaires liées aux onglets Stream Saver pour nettoyage des orphelins à la fermeture ou au démarrage.
  - `download_blob_<downloadId>` - Associe chaque téléchargement Chrome actif à son URL Blob offscreen pour garantir `URL.revokeObjectURL` (et la suppression des fichiers temporaires OPFS) via `chrome.downloads.onChanged`, même après suspension du Service Worker.
  - `stream_saver_job_<jobId>` - Descripteur transitoire transmis de `service_worker.js` à `src/saver/stream_saver.html` pour écrire un flux `>512` Mo sur disque via File System Access.
- `chrome.storage.sync` :
  - `user_settings` - Paramètres utilisateur (`DEFAULT_SETTINGS`).
- `chrome.storage.local` :
  - `download_history` - Historique récent des téléchargements plafonné à `LIMITS.MAX_DOWNLOAD_HISTORY` (`15` entrées).
  - `popup_ui_state` - Préférences persistées de filtres, tri et filtres images de la popup.
- Files de sérialisation dans `service_worker.js` :
  - `tabWriteQueues` sérialise les opérations lecture-modification-écriture par onglet.
  - `offscreenLifecycleQueue` sérialise `createDocument` / `closeDocument` selon `activeOffscreenBuilds` et le contrôle `OFFSCREEN_GET_ACTIVE_BUILDS`.
  - `activeBuilds` associe `requestId` -> `{ cancelled, downloadId }` pour annuler proprement l'assemblage offscreen ou un téléchargement Chrome déjà démarré.
  - Les commandes privilégiées vérifient `isExtensionSender(sender)` afin qu'une page web compromise ne puisse pas déclencher d'actions internes.

## Contrats de messages

Les types de messages sont centralisés dans `src/config/constants.js` (`MESSAGE_TYPES`) :

- Popup -> Service Worker : `GET_MEDIA_FOR_TAB`, `CLEAR_MEDIA_FOR_TAB`, `INSPECT_HLS`, `DOWNLOAD_MEDIA`, `DOWNLOAD_HLS_SUBTITLE`, `EXPORT_BATCH_ZIP`, `START_BATCH_QUEUE`, `CANCEL_BATCH_QUEUE`, `GET_BATCH_QUEUE_STATE`, `OPEN_STREAM_SAVER`, `START_TAB_CAPTURE`, `STOP_TAB_CAPTURE`, `STOP_LIVE_RECORD`, `CANCEL_DOWNLOAD`, `GET_ACTIVE_BUILDS`, `GET_DOWNLOAD_HISTORY`, `CLEAR_DOWNLOAD_HISTORY`, `CHECK_COMPANION`, `DOWNLOAD_WITH_COMPANION`, `CANCEL_COMPANION_DOWNLOAD`.
- Script de contenu -> Service Worker : `DOWNLOAD_TWEET_VIDEO`, `DOWNLOAD_SITE_VIDEO`, `MSE_STREAM_UPDATED`, `CANCEL_DOWNLOAD`.
- Service Worker <-> Pont MSE : `EXPORT_MSE_STREAM` (déclencheur d'export sur le cadre).
- Service Worker / Pont MSE -> Offscreen (`target: 'offscreen'`) : `OFFSCREEN_BUILD_HLS_BLOB`, `OFFSCREEN_BUILD_SUBTITLE_BLOB`, `OFFSCREEN_BUILD_MSE_BLOB`, `OFFSCREEN_CONVERT_IMAGE`, `OFFSCREEN_EXTRACT_SVG_SYMBOL`, `OFFSCREEN_DECODE_WAV`, `OFFSCREEN_BUILD_ZIP_BLOB`, `OFFSCREEN_RECORD_HLS_LIVE`, `OFFSCREEN_STOP_LIVE_RECORD`, `OFFSCREEN_START_TAB_CAPTURE`, `OFFSCREEN_STOP_TAB_CAPTURE`, `OFFSCREEN_GET_ACTIVE_BUILDS`, `OFFSCREEN_CANCEL_BUILD`, `OFFSCREEN_REVOKE_BLOB`.
- Offscreen / Service Worker -> Popup / Script de contenu : `DOWNLOAD_PROGRESS` (correspondance par `requestId` ou URL), `DOWNLOAD_FINISHED`, `COMPANION_PROGRESS`, `BATCH_QUEUE_PROGRESS`, `MEDIA_UPDATED` (regroupé par temporisation).

## Assemblage des flux et limites de sécurité

- Les flux protégés par DRM (`#EXT-X-KEY` en `SAMPLE-AES` / `SAMPLE-AES-CTR` / méthodes non supportées, `#EXT-X-SESSION-KEY` DRM ou `ContentProtection` DASH) sont explicitement refusés. Les flux HLS `AES-128` non-DRM sont déchiffrés via Web Crypto (`src/shared/hls_crypto.js`), et les flux HLS live / DASH dynamiques sont pris en charge en enregistrement DVR (`recordLiveHlsBlob`).
- Seuls les schémas `http:` et `https:` sont acceptés pour les manifestes et segments.
- L'assemblage en mémoire dans `offscreen.js` vérifie les en-têtes `Content-Length` et le cumul d'octets reçus face au plafond `LIMITS.MAX_HLS_BUFFER_BYTES` (`512` Mo), et interrompt immédiatement les requêtes parallèles en cas de dépassement. Les captures d'onglet et enregistrements Live DVR écrivent leurs blocs sur disque via OPFS (`src/offscreen/opfs_spool.js`) avec repli mémoire transparent et nettoyage automatique à la révocation du Blob.
- Si un serveur `#EXT-X-BYTERANGE` ignore l'en-tête `Range` et répond en HTTP `200`, les requêtes concurrentes sur la même URL partagent un unique téléchargement mis en cache pour cette opération.
- `mergeFmp4VideoAndAudioParts` et `transmuxTsSegmentsToMp4Parts` transmettent directement un tableau ordonné de fragments `Uint8Array` à `new Blob(outputParts)` puis libèrent immédiatement les références.
