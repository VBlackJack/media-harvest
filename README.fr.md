[English version](README.md)

# Media Harvest

Extension Chrome Manifest V3 pour détecter, prévisualiser et télécharger les vidéos, flux HLS sans DRM (`.m3u8`), images et fichiers audio de l'onglet actif.

## Fonctionnalités

- Analyse le DOM de la page (`<video>`, `<audio>`, `<img>`, liens directs) à l'ouverture de la popup, avec capture d'aperçu vidéo.
- Capture les réponses réseau média (`.mp4`, `.webm`, `.m3u8`, audio, images) par onglet via `chrome.webRequest` avec compteur sur l'icône et nettoyage automatique lors des changements de page.
- Parse les playlists HLS sans DRM, estime la taille des variantes et assemble les segments dans un document offscreen (muxage fMP4 vidéo+audio et transmuxage MPEG-TS vers MP4 via `mux-mp4.min.js`).
- Ajoute un bouton de téléchargement intégré directement dans les posts vidéo sur X/Twitter (`x.com` / `twitter.com`).
- Propose le rechargement d'onglet pour capter les flux, les filtres par type, le téléchargement groupé et l'interface en français et en anglais (`_locales/fr`, `_locales/en`).

## Architecture

- `src/config/constants.js` - Constantes partagées, extensions/MIME, seuils, clés de stockage et types de messages.
- `src/shared/` - Modules ES purs (`media_classifier.js`, `hls_parser.js`, `fmp4_muxer.js`, `ts_transmuxer.js`, `preview_matcher.js`, `i18n.js`).
- `src/background/service_worker.js` - Capture réseau, état de session, badge, cycle de vie offscreen et téléchargements.
- `src/offscreen/` - Document offscreen assemblant les segments HLS en URL Blob téléchargeable.
- `src/content/` - Scanner DOM à la demande et bouton intégré aux posts X/Twitter.
- `src/popup/` - Interface popup avec aperçu vidéo, sélection de qualité et suivi de progression.

## Installation dans Chrome

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer le **Mode développeur** en haut à droite.
3. Cliquer sur **Charger l'extension non empaquetée** et sélectionner ce dossier.
4. Ouvrir une page ou un post (par exemple sur X), lancer ou recharger la vidéo, puis cliquer sur l'icône Media Harvest ou le bouton du post.

## Tests

```powershell
npm test
```
