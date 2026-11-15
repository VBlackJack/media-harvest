[English version](../ARCHITECTURE.md)

# Media Harvest - Architecture

## Vue d'ensemble

Media Harvest est une extension Chrome Manifest V3 écrite en modules ES natifs (zéro dépendance npm à l'exécution) avec une seule bibliothèque UMD intégrée localement (`src/vendor/mux-mp4.min.js`).

## Composants d'exécution

| Composant | Point d'entrée | Responsabilité |
|---|---|---|
| Service Worker | `src/background/service_worker.js`, `src/background/dnr_manager.js` | Capture `webRequest`, nettoyage par route d'onglet, règles temporaires `declarativeNetRequest` (`Referer`/`Origin`), suivi MSE, orchestration `chrome.tabCapture`, pont compagnon `nativeMessaging`, état de session, badge icône, cycle de vie offscreen, téléchargements et annulations |
| Document Offscreen | `src/offscreen/offscreen.js` | Résolution des manifestes, enregistrement DVR HLS/DASH en direct, capture d'onglet `MediaRecorder` (`startTabCaptureRecording`), téléchargement parallèle / par plages d'octets, fusion des sous-titres WebVTT, assemblage MSE fMP4/WebM par morceaux (`OFFSCREEN_BUILD_MSE_BLOB`), extraction audio `.m4a` autonome, assemblage ZIP avec DEFLATE sélectif, plafond mémoire 512 Mo, muxage fMP4, transmuxage TS/ADTS, gestion des URL Blob |
| Interface Popup / Panneau latéral | `src/popup/popup.html`, `src/popup/popup.js`, `src/popup/media_card.js`, `src/popup/preview_player.js`, `src/popup/batch_runner.js`, `src/popup/popup_helpers.js` | Liste réconciliée des médias, bascule panneau latéral Chrome, filtres (sous-titres/SVG inclus), filtres rapides images, Lightbox Pro (`checker`/`light`/`dark` + copie + téléchargement), contrôles `REC` de capture d'onglet, persistance filtre/tri, recherche/tri, file d'inspection bornée avec réessai, sélecteurs qualité/audio/sous-titres, badges MSE, boutons compagnon `yt-dlp`, aperçus vidéo/audio, sélection multiple mixte/ZIP avec arrêt, alertes >512 Mo |
| Page d'Options | `src/options/options.html`, `src/options/options.js` | Éditeur de paramètres synchronisés (`chrome.storage.sync`) avec validation, bascules sociales/MSE, option Enregistrer sous, modèles de dossiers, vérification du compagnon et réinitialisation |
| Scripts de contenu | `src/content/dom_scanner.js`, `src/content/x_overlay.js`, `src/content/site_overlay.js`, `src/content/mse_hook.js`, `src/content/mse_bridge.js` | Analyse DOM multi-cadres (Shadow DOM, balises méta, JSON-LD, `<canvas>` non corrompus, `<svg>` en ligne + sprites `<use>` externes, fonds/masques CSS, `srcset`/`<picture>`, `<track>`), bouton X/Twitter, adaptateurs sociaux modulaires, capture MSE (`world: "MAIN"`) et pont de flux (`ISOLATED`) |
| Compagnon local (optionnel) | `companion/media_harvest_host.py`, `companion/install_companion.ps1`, `companion/install_companion.sh` | Hôte Chrome Native Messaging Windows, Linux et macOS encapsulant proprement `yt-dlp` et `ffmpeg` en JSON préfixé sur stdio avec exécution `shell=False` |

## Modules partagés (`src/shared/`)

- `media_classifier.js` - Classification URL/MIME (dont URI `data:image/*`), validation HTTP(S), assainissement des noms de fichiers, extraction d'identifiants de posts X et déduplication.
- `fetch_utils.js` - Délai d'attente géré, signal d'annulation, réservation du plafond d'octets en flux/en-tête et détection DASH (`fetchWithManagedTimeout`, `isDashDescriptor`, `looksLikeDashXml`).
- `hls_parser.js` - Parseur `#EXTM3U` maître/média, tri par résolution/débit, détection DRM (`#EXT-X-KEY`, `#EXT-X-SESSION-KEY`), suivi `#EXT-X-DISCONTINUITY`, suivi d'offsets `#EXT-X-MAP` et `#EXT-X-BYTERANGE` par URL cible.
- `dash_parser.js` - Parseur XML pur JS pour manifestes DASH `.mpd` statiques et directs dynamiques sans DRM (`BaseURL`, `SegmentTemplate` avec `SegmentTimeline` ou `duration`, `SegmentList`, vidéo progressive, détection `ContentProtection`).
- `fmp4_muxer.js` - Parseur de boîtes ISO BMFF, muxeur vidéo+audio par fragments (`mergeFmp4VideoAndAudioParts`, `splitFmp4InitAndFragments`, `countTracksInInit`) et extracteur audio seul `'soun'` (`extractAudioOnlyFromFmp4Parts`).
- `ts_transmuxer.js` - Adaptateur autour de `muxjs.Transmuxer` produisant des segments `Uint8Array` sans copie contiguë (`transmuxTsSegmentsToMp4Parts`) avec vidage sur discontinuités (`discontinuityIndices`) pour MPEG-TS et ADTS.
- `zip_builder.js` - Calcul CRC-32 et générateur d'archives ZIP (`buildZipUint8Array`, `buildZipBlob`, `buildZipUint8ArrayAsync`, `buildZipBlobAsync`) avec compression sélective `CompressionStream('deflate-raw')` sur les ressources texte/vectorielles (`ZIP_COMPRESSIBLE_EXTENSIONS`).
- `preview_matcher.js` - Associe les identifiants de flux X/Twitter (`ext_tw_video`, `amplify_video`, `tweet_video`) aux images d'aperçu des balises `<video>`.
- `settings.js` - Normalisation bornée (`normalizeSettings`, `clampInteger`), modèles de nommage (`default`, `host_stem`, `date_stem`) et persistance `chrome.storage.sync`.
- `i18n.js` - Utilitaire `chrome.i18n` avec repli par clé et traduction DOM (`data-i18n`, `data-i18n-title`, `data-i18n-aria`, `data-i18n-placeholder`).

## Stockage et concurrence

- `chrome.storage.session` :
  - `tab_media_<tabId>` - Liste des médias réseau capturés par onglet (plafonnée à `120` éléments).
  - `tab_route_<tabId>` - Clé de route normalisée (`origin + pathname`) servant à vider les captures lors des navigations ou changements d'URL SPA.
  - `download_blob_<downloadId>` - Associe chaque téléchargement Chrome actif à son URL Blob offscreen pour garantir `URL.revokeObjectURL` via `chrome.downloads.onChanged`, même après suspension du Service Worker.
- `chrome.storage.sync` :
  - `user_settings` - Paramètres utilisateur (`DEFAULT_SETTINGS`).
- Files de sérialisation dans `service_worker.js` :
  - `tabWriteQueues` sérialise les opérations lecture-modification-écriture par onglet.
  - `offscreenLifecycleQueue` sérialise `createDocument` / `closeDocument` selon `activeOffscreenBuilds`.
  - `activeBuilds` associe `requestId` -> `{ cancelled, downloadId }` pour annuler proprement l'assemblage offscreen ou un téléchargement Chrome déjà démarré.

## Contrats de messages

Les types de messages sont centralisés dans `src/config/constants.js` (`MESSAGE_TYPES`) :

- Popup -> Service Worker : `GET_MEDIA_FOR_TAB`, `CLEAR_MEDIA_FOR_TAB`, `INSPECT_HLS`, `DOWNLOAD_MEDIA`, `DOWNLOAD_HLS_SUBTITLE`, `EXPORT_BATCH_ZIP`, `START_TAB_CAPTURE`, `STOP_TAB_CAPTURE`, `STOP_LIVE_RECORD`, `CANCEL_DOWNLOAD`, `GET_ACTIVE_BUILDS`, `CHECK_COMPANION`, `DOWNLOAD_WITH_COMPANION`.
- Script de contenu -> Service Worker : `DOWNLOAD_TWEET_VIDEO`, `DOWNLOAD_SITE_VIDEO`, `MSE_STREAM_UPDATED`, `CANCEL_DOWNLOAD`.
- Service Worker <-> Pont MSE : `EXPORT_MSE_STREAM` (déclencheur d'export sur le cadre).
- Service Worker / Pont MSE -> Offscreen (`target: 'offscreen'`) : `OFFSCREEN_BUILD_HLS_BLOB`, `OFFSCREEN_BUILD_SUBTITLE_BLOB`, `OFFSCREEN_BUILD_MSE_BLOB`, `OFFSCREEN_CONVERT_IMAGE`, `OFFSCREEN_BUILD_ZIP_BLOB`, `OFFSCREEN_RECORD_HLS_LIVE`, `OFFSCREEN_STOP_LIVE_RECORD`, `OFFSCREEN_START_TAB_CAPTURE`, `OFFSCREEN_STOP_TAB_CAPTURE`, `OFFSCREEN_CANCEL_BUILD`, `OFFSCREEN_REVOKE_BLOB`.
- Offscreen / Service Worker -> Popup / Script de contenu : `DOWNLOAD_PROGRESS` (correspondance par `requestId` ou URL), `DOWNLOAD_FINISHED`, `MEDIA_UPDATED` (regroupé par temporisation).

## Assemblage des flux et limites de sécurité

- Les flux chiffrés (`#EXT-X-KEY` hors `METHOD=NONE`, `#EXT-X-SESSION-KEY`, ou `ContentProtection` DASH) et les manifestes DASH dynamiques (`type="dynamic"`) sont explicitement refusés.
- Seuls les schémas `http:` et `https:` sont acceptés pour les manifestes et segments.
- L'assemblage en mémoire dans `offscreen.js` vérifie les en-têtes `Content-Length` et le cumul d'octets reçus face au plafond `LIMITS.MAX_HLS_BUFFER_BYTES` (`512` Mo), et interrompt immédiatement les requêtes parallèles en cas de dépassement.
- Si un serveur `#EXT-X-BYTERANGE` ignore l'en-tête `Range` et répond en HTTP `200`, les requêtes concurrentes sur la même URL partagent un unique téléchargement mis en cache pour cette opération.
- `mergeFmp4VideoAndAudioParts` et `transmuxTsSegmentsToMp4Parts` transmettent directement un tableau ordonné de fragments `Uint8Array` à `new Blob(outputParts)` puis libèrent immédiatement les références.
