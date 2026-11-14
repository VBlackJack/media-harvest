[English version](README.md)

# Media Harvest

Extension Chrome Manifest V3 pour detecter et telecharger les videos, flux HLS sans DRM (`.m3u8`), images et fichiers audio de l'onglet actif.

## Fonctionnalites

- Analyse le DOM de la page (`<video>`, `<audio>`, `<img>`, liens directs) a l'ouverture de la popup.
- Capture les requetes reseau media (`.mp4`, `.webm`, `.m3u8`, audio, images) par onglet via `chrome.webRequest`.
- Parse les playlists HLS sans DRM, propose les variantes de qualite et assemble les segments dans un document offscreen.
- Traduite en francais et en anglais (`_locales/fr`, `_locales/en`).

## Installation dans Chrome

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer le **Mode developpeur** en haut a droite.
3. Cliquer sur **Charger l'extension non empaquetee** et selectionner ce dossier.
4. Ouvrir le post sur X, lancer ou recharger la video, puis cliquer sur l'icone Media Harvest.

## Tests

```powershell
node --test tests/*.test.js
```
