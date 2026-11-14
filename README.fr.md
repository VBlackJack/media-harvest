[English version](README.md)

# Media Harvest

Extension Chrome Manifest V3 (`v1.0.0`) pour détecter, prévisualiser et télécharger les vidéos, flux HLS (`.m3u8`) et DASH (`.mpd`) sans DRM, images et fichiers audio de l'onglet actif.

## Fonctionnalités

- Analyse le DOM de la page (`<video>`, `<audio>`, `<img>`, liens directs) à l'ouverture de la popup, avec capture d'aperçu vidéo.
- Capture les réponses réseau média (`.mp4`, `.webm`, `.m3u8`, `.mpd`, audio, images) par onglet via `chrome.webRequest` avec compteur sur l'icône et nettoyage automatique lors des changements de page.
- Parse les playlists HLS sans DRM (y compris `#EXT-X-BYTERANGE`) et les manifestes DASH `.mpd` statiques sans DRM, estime la taille des variantes avec alerte de flux volumineux configurable, permet l'annulation en cours de téléchargement et assemble les segments en document offscreen dans une limite mémoire de `512` Mo (fragments `Uint8Array` sans copie contiguë pour muxage fMP4 vidéo+audio et transmuxage MPEG-TS/ADTS vers MP4 via `mux-mp4.min.js`).
- Ajoute un bouton de téléchargement intégré directement dans les posts vidéo sur X/Twitter (`x.com` / `twitter.com`), activable en direct depuis les paramètres.
- Inclut une page d'options (`chrome.storage.sync`) et une interface localisée en français et en anglais (`_locales/fr`, `_locales/en`).

## Paramètres (`src/options/`)

Ouvrir les paramètres via l'icône engrenage dans la popup ou depuis Chrome (Détails de l'extension -> Options de l'extension) :

| Paramètre | Défaut | Bornes / Valeurs | Description |
|---|---|---|---|
| Qualité par défaut | `best` | `best`, `lowest` | Variante présélectionnée à l'inspection des flux HLS/DASH |
| Modèle de nommage | `default` | `default`, `host_stem`, `date_stem` | Format des noms (`{name}.{ext}`, `{host}_{name}.{ext}`, `{YYYY-MM-DD}_{name}.{ext}`) |
| Taille minimale d'image | `64` px | `0` - `2000` px | Ignore les petites icônes DOM et pixels de suivi |
| Téléchargements parallèles | `4` | `1` - `8` | Concurrence maximale du pool de téléchargement dans `offscreen.js` |
| Seuil d'alerte flux volumineux | `250` Mo | `0` - `2048` Mo | Affiche un badge d'alerte au-dessus du seuil (`0` désactive) |
| Bouton sur X / Twitter | Activé | `true` / `false` | Active ou retire en direct le bouton de téléchargement sur `x.com` / `twitter.com` |

## Limites et garde-fous

- **DRM / Chiffrement :** Les flux HLS chiffrés (`#EXT-X-KEY` / `#EXT-X-SESSION-KEY`) et DASH protégés (`ContentProtection`) sont détectés et refusés explicitement.
- **Flux directs (Live) :** Les manifestes DASH dynamiques (`type="dynamic"`) ne peuvent pas être assemblés en fichier fini et sont refusés.
- **Plafond mémoire :** L'assemblage en mémoire dans le document offscreen est plafonné à `512` Mo (`LIMITS.MAX_HLS_BUFFER_BYTES`) afin de préserver la stabilité du navigateur.

## Permissions

- `downloads` - Déclenche et suit les téléchargements (`chrome.downloads.download` / `.cancel` / `.onChanged`).
- `webRequest` + `<all_urls>` - Lit les en-têtes média (`Content-Type`, `Content-Length`) et les navigations principales par onglet.
- `activeTab` + `scripting` - Analyse le DOM média à la demande lors de l'ouverture de la popup.
- `storage` - Stocke l'état transitoire d'onglet dans `chrome.storage.session` et les préférences utilisateur dans `chrome.storage.sync`.
- `offscreen` - Exécute le téléchargement des segments et le muxage MP4 dans un document offscreen MV3 isolé avec révocation des URL Blob.

## Architecture et documentation

- Architecture détaillée et contrats de messages : [docs/fr/ARCHITECTURE.md](docs/fr/ARCHITECTURE.md) ([EN](docs/ARCHITECTURE.md))
- Journal des modifications (EN) : [CHANGELOG.md](CHANGELOG.md)
- Vue des répertoires :
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

## Tests et intégration continue

Aucune dépendance npm externe n'est nécessaire : la suite repose uniquement sur `node:test` et `node:assert/strict` (`45` tests répartis dans `12` fichiers dans `tests/`, exécutés aussi en CI sous Node 22 via `.github/workflows/ci.yml`) :

```powershell
npm test
```
