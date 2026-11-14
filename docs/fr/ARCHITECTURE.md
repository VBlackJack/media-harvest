[English version](../ARCHITECTURE.md)

# Media Harvest - Architecture

## Vue d'ensemble

Media Harvest est une extension Chrome Manifest V3 écrite en modules ES natifs (zéro dépendance npm à l'exécution) avec une seule bibliothèque UMD intégrée localement (`src/vendor/mux-mp4.min.js`).

## Composants d'exécution

| Composant | Point d'entrée | Responsabilité |
|---|---|---|
| Service Worker | `src/background/service_worker.js` | Capture `webRequest`, nettoyage par route d'onglet, état de session, badge icône, cycle de vie offscreen, téléchargements et annulations |
| Document Offscreen | `src/offscreen/offscreen.js` | Résolution des manifestes, téléchargement parallèle / par plages d'octets, plafond mémoire 512 Mo, muxage fMP4, transmuxage TS/ADTS, gestion des URL Blob |
| Interface Popup | `src/popup/popup.html`, `src/popup/popup.js` | Liste réconciliée des médias, filtres par type, sélecteur de qualité, aperçus vidéo, contrôles de téléchargement/annulation, badges d'alerte |
| Page d'Options | `src/options/options.html`, `src/options/options.js` | Éditeur de paramètres synchronisés (`chrome.storage.sync`) avec validation et réinitialisation |
| Scripts de contenu | `src/content/dom_scanner.js`, `src/content/x_overlay.js` | Analyse DOM à la demande (`<video>`, `<audio>`, `<img>`, liens médias) et bouton X/Twitter activable en direct |

## Modules partagés (`src/shared/`)

- `media_classifier.js` - Classification URL/MIME, validation HTTP(S), assainissement des noms de fichiers, extraction d'identifiants de posts X et déduplication.
- `hls_parser.js` - Parseur `#EXTM3U` maître/média, tri par résolution/débit, détection DRM (`#EXT-X-KEY`, `#EXT-X-SESSION-KEY`), suivi d'offsets `#EXT-X-MAP` et `#EXT-X-BYTERANGE` par URL cible.
- `dash_parser.js` - Parseur XML pur JS pour manifestes DASH `.mpd` statiques sans DRM (`BaseURL`, `SegmentTemplate` avec `SegmentTimeline` ou `duration`, `SegmentList`, vidéo progressive, détection `ContentProtection`).
- `fmp4_muxer.js` - Parseur de boîtes ISO BMFF et muxeur vidéo+audio par fragments (`mergeFmp4VideoAndAudioParts`, `splitFmp4InitAndFragments`, `countTracksInInit`).
- `ts_transmuxer.js` - Adaptateur autour de `muxjs.Transmuxer` produisant des segments `Uint8Array` sans copie contiguë (`transmuxTsSegmentsToMp4Parts`) pour MPEG-TS et ADTS.
- `preview_matcher.js` - Associe les identifiants de flux X/Twitter (`ext_tw_video`, `amplify_video`, `tweet_video`) aux images d'aperçu des balises `<video>`.
- `settings.js` - Normalisation bornée (`normalizeSettings`), modèles de nommage (`default`, `host_stem`, `date_stem`) et persistance `chrome.storage.sync`.
- `i18n.js` - Utilitaire `chrome.i18n` avec repli par clé et traduction DOM (`data-i18n`, `data-i18n-title`).

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

- Popup -> Service Worker : `GET_MEDIA_FOR_TAB`, `CLEAR_MEDIA_FOR_TAB`, `INSPECT_HLS`, `DOWNLOAD_MEDIA`, `CANCEL_DOWNLOAD`.
- Script de contenu -> Service Worker : `DOWNLOAD_TWEET_VIDEO`.
- Service Worker -> Offscreen (`target: 'offscreen'`) : `OFFSCREEN_BUILD_HLS_BLOB`, `OFFSCREEN_CANCEL_BUILD`, `OFFSCREEN_REVOKE_BLOB`.
- Offscreen / Service Worker -> Popup : `DOWNLOAD_PROGRESS` (correspondance par `requestId`), `MEDIA_UPDATED` (regroupé par temporisation).

## Assemblage des flux et limites de sécurité

- Les flux chiffrés (`#EXT-X-KEY` hors `METHOD=NONE`, `#EXT-X-SESSION-KEY`, ou `ContentProtection` DASH) et les manifestes DASH dynamiques (`type="dynamic"`) sont explicitement refusés.
- Seuls les schémas `http:` et `https:` sont acceptés pour les manifestes et segments.
- L'assemblage en mémoire dans `offscreen.js` vérifie les en-têtes `Content-Length` et le cumul d'octets reçus face au plafond `LIMITS.MAX_HLS_BUFFER_BYTES` (`512` Mo), et interrompt immédiatement les requêtes parallèles en cas de dépassement.
- Si un serveur `#EXT-X-BYTERANGE` ignore l'en-tête `Range` et répond en HTTP `200`, les requêtes concurrentes sur la même URL partagent un unique téléchargement mis en cache pour cette opération.
- `mergeFmp4VideoAndAudioParts` et `transmuxTsSegmentsToMp4Parts` transmettent directement un tableau ordonné de fragments `Uint8Array` à `new Blob(outputParts)` puis libèrent immédiatement les références.
