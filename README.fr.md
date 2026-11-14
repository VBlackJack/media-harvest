[English version](README.md)

# Media Harvest

Extension Chrome Manifest V3 pour détecter, prévisualiser et télécharger les vidéos, flux HLS (`.m3u8`) et DASH (`.mpd`) sans DRM, images et fichiers audio de l'onglet actif.

## Fonctionnalités

- Analyse le DOM de la page (`<video>`, `<audio>`, `<img>`, liens directs) à l'ouverture de la popup, avec capture d'aperçu vidéo.
- Capture les réponses réseau média (`.mp4`, `.webm`, `.m3u8`, `.mpd`, audio, images) par onglet via `chrome.webRequest` avec compteur sur l'icône et nettoyage automatique lors des changements de page.
- Parse les playlists HLS sans DRM (y compris `#EXT-X-BYTERANGE`) et les manifestes DASH MPD statiques sans DRM, estime la taille des variantes avec alerte de flux volumineux, permet l'annulation en cours de téléchargement et assemble les segments en document offscreen dans une limite mémoire de 512 Mo (muxage fMP4 vidéo+audio et transmuxage MPEG-TS/ADTS vers MP4 via `mux-mp4.min.js`).
- Ajoute un bouton de téléchargement intégré directement dans les posts vidéo sur X/Twitter (`x.com` / `twitter.com`), activable en direct depuis les paramètres.
- Inclut une page d'options (`chrome.storage.sync`) pour la qualité par défaut, le modèle de nommage, la taille minimale d'image, le parallélisme et les seuils d'alerte, avec interface en français et en anglais (`_locales/fr`, `_locales/en`).

## Architecture

- `src/config/constants.js` - Constantes partagées, extensions/MIME, seuils, clés de stockage, réglages par défaut et types de messages.
- `src/shared/` - Modules ES purs (`media_classifier.js`, `hls_parser.js`, `dash_parser.js`, `fmp4_muxer.js`, `ts_transmuxer.js`, `preview_matcher.js`, `settings.js`, `i18n.js`).
- `src/background/service_worker.js` - Capture réseau, état de session, badge, cycle de vie offscreen, annulation et téléchargements.
- `src/offscreen/` - Document offscreen assemblant les segments HLS et DASH en URL Blob téléchargeable.
- `src/content/` - Scanner DOM à la demande et bouton intégré aux posts X/Twitter.
- `src/popup/` - Interface popup avec aperçu vidéo, sélection de qualité, annulation et suivi de progression.
- `src/options/` - Page de paramètres synchronisés (`options.html`, `options.css`, `options.js`).

## Installation dans Chrome

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer le **Mode développeur** en haut à droite.
3. Cliquer sur **Charger l'extension non empaquetée** et sélectionner ce dossier.
4. Ouvrir une page ou un post (par exemple sur X), lancer ou recharger la vidéo, puis cliquer sur l'icône Media Harvest ou le bouton du post.

## Tests

```powershell
npm test
```
