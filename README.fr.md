[English version](README.md)

# Media Harvest

Extension Chrome Manifest V3 (`v1.0.0`) pour détecter, prévisualiser et télécharger les vidéos, flux HLS (`.m3u8`) et DASH (`.mpd`) sans DRM, sous-titres, images et fichiers audio de l'onglet actif, en popup ou dans le panneau latéral Chrome.

## Fonctionnalités

- Analyse le DOM de la page (`<video>`, `<audio>`, `<img>`, `<track>`, liens directs, Shadow DOM ouvert, balises OpenGraph/Twitter, JSON-LD `VideoObject`/`AudioObject`/`ImageObject` et CSS `background-image` visibles) sur tous les cadres (`allFrames: true`), avec aperçu vidéo et lecture `<audio>` intégrée.
- Capture les réponses réseau média (`.mp4`, `.webm`, `.m3u8`, `.mpd`, `.vtt`, `.srt`, `.ttml`, `.ass`, audio, images) par onglet via `chrome.webRequest`, propage `Referer`/`Origin` via des règles temporaires `declarativeNetRequest` pour les CDN protégés et capture en secours les flux MSE (`MediaSource`) jusqu'à `150` Mo (`enableMseCapture`).
- Parse les playlists HLS VOD sans DRM (y compris `#EXT-X-BYTERANGE` et `#EXT-X-MEDIA:TYPE=SUBTITLES`) et les manifestes DASH `.mpd` statiques sans DRM, refuse les flux direct HLS/DASH, estime la taille des variantes avec alerte de flux volumineux configurable, permet l'annulation en cours de téléchargement et assemble les segments en document offscreen dans une limite mémoire de `512` Mo (fragments `Uint8Array` sans copie contiguë pour muxage fMP4 vidéo+audio et transmuxage MPEG-TS/ADTS vers MP4 via `mux-mp4.min.js`).
- Prend en charge la sélection multiple mixte (fichiers directs + flux), la persistance du filtre et du tri, et l'ouverture en panneau latéral Chrome.
- Ajoute des boutons de téléchargement intégrés directement sur X/Twitter (`x.com` / `twitter.com`), les lecteurs vidéo sociaux (`youtube.com`, `instagram.com`, `tiktok.com`, `reddit.com`, `facebook.com`, `bsky.app`, `vimeo.com`, `dailymotion.com`, `twitch.tv`, `linkedin.com`) et tout lecteur HTML5 générique (`enableGenericVideoOverlay`), activables en direct dans les paramètres.
- Inclut un compagnon Windows optionnel Native Messaging (`companion/` pilotant `yt-dlp` et `ffmpeg`) avec progression en direct et transmission optionnelle des cookies Chrome (`enableCompanionCookies`) pour les vidéos lourdes (`>512` Mo) ou flux complexes.
- Inclut une page d'options (`chrome.storage.sync`) et une interface localisée en français et en anglais (`_locales/fr`, `_locales/en`).

## Paramètres (`src/options/`)

Ouvrir les paramètres via l'icône engrenage dans la popup ou depuis Chrome (Détails de l'extension -> Options de l'extension) :

| Paramètre | Défaut | Bornes / Valeurs | Description |
|---|---|---|---|
| Qualité par défaut | `best` | `best`, `lowest` | Variante présélectionnée à l'inspection des flux HLS/DASH |
| Modèle de nommage | `default` | `default`, `host_stem`, `date_stem`, `host_folder`, `date_folder` | Format des noms (`{name}.{ext}`, `{host}_{name}.{ext}`, `{YYYY-MM-DD}_{name}.{ext}`, `{host}/{name}.{ext}`, `{YYYY-MM-DD}/{name}.{ext}`) |
| Taille minimale d'image | `64` px | `0` - `2000` px | Ignore les petites icônes DOM et pixels de suivi |
| Téléchargements parallèles | `4` | `1` - `8` | Concurrence maximale du pool de téléchargement dans `offscreen.js` |
| Seuil d'alerte flux volumineux | `250` Mo | `0` - `512` Mo | Affiche un badge d'alerte au-dessus du seuil (`0` désactive) |
| Bouton sur X / Twitter | Activé | `true` / `false` | Active ou retire en direct le bouton de téléchargement sur `x.com` / `twitter.com` |
| Bouton sur les réseaux sociaux | Activé | `true` / `false` | Active ou retire en direct le bouton flottant sur Instagram, TikTok, Reddit, YouTube, Facebook, Bluesky, Vimeo, Dailymotion, Twitch et LinkedIn |
| Bouton sur les autres sites | Activé | `true` / `false` | Active ou retire en direct le bouton flottant sur tout lecteur vidéo HTML5 générique (`>= 220x140` px) |
| Capture MSE (`MediaSource`) | Activé | `true` / `false` | Capture en secours les flux `MediaSource` en MP4/WebM sans DRM (plafond `150` Mo) |
| Cookies Chrome pour le compagnon | Désactivé | `true` / `false` | Transmet `--cookies-from-browser chrome` au compagnon local `yt-dlp` pour les pages nécessitant une session |
| Boîte Enregistrer sous | Désactivé | `true` / `false` | Demande où enregistrer chaque téléchargement individuel |

## Compagnon local optionnel (`companion/`)

Pour les vidéos dépassant la limite mémoire navigateur (`512` Mo) ou les formats complexes, il est possible d'installer l'hôte Chrome Native Messaging pilotant `yt-dlp` et `ffmpeg` (nécessite Python 3 et `yt-dlp` dans le PATH) :

- **Windows (PowerShell) :**
  ```powershell
  .\companion\install_companion.ps1 -ExtensionId <ID_DE_L_EXTENSION>
  ```
- **Linux / macOS (Bash) :**
  ```bash
  ./companion/install_companion.sh <ID_DE_L_EXTENSION>
  ```

Le bouton **Tester la connexion** dans les Options vérifie que l'hôte répond. Les téléchargements compagnon sont enregistrés dans `Téléchargements\MediaHarvest`.

## Raccourcis et contrôles

- `Alt+Shift+M` (ou `Option+Shift+M` sous macOS) : ouvre instantanément le popup Media Harvest depuis n'importe où dans Chrome.
- Bouton Panneau latéral Chrome (en-tête) : détache la liste des médias dans la barre latérale persistante de Chrome.

## Limites et garde-fous

- **DRM / Chiffrement :** Les flux HLS chiffrés (`#EXT-X-KEY` / `#EXT-X-SESSION-KEY`) et DASH protégés (`ContentProtection`) sont détectés et refusés explicitement.
- **Flux directs (Live) :** Les manifestes DASH dynamiques (`type="dynamic"`) et les playlists directes infinies ne peuvent pas être assemblés en fichier VOD fini et sont refusés.
- **Plafond mémoire :** L'assemblage en mémoire dans le document offscreen est plafonné à `512` Mo (`LIMITS.MAX_HLS_BUFFER_BYTES`) afin de préserver la stabilité du navigateur.

## Permissions

- `downloads` - Déclenche et suit les téléchargements (`chrome.downloads.download` / `.cancel` / `.onChanged`).
- `webRequest` + `<all_urls>` - Lit les en-têtes média (`Content-Type`, `Content-Length`) et les navigations principales par onglet.
- `activeTab` + `scripting` - Analyse le DOM média à la demande lors de l'ouverture de la popup.
- `storage` - Stocke l'état transitoire d'onglet dans `chrome.storage.session`, le dernier filtre/tri dans `chrome.storage.local` et les préférences utilisateur dans `chrome.storage.sync`.
- `offscreen` - Exécute le téléchargement des segments et le muxage MP4 dans un document offscreen MV3 isolé avec révocation des URL Blob.
- `sidePanel` - Permet d'ouvrir la liste capturée dans le panneau latéral Chrome pour la garder visible pendant la navigation.
- `declarativeNetRequest` - Applique temporairement les en-têtes `Referer` / `Origin` en session pour inspecter ou télécharger des médias sur CDN protégés.
- `nativeMessaging` - Communique avec le compagnon local optionnel `com.mediaharvest.companion` (`yt-dlp` + `ffmpeg`) lorsqu'il est installé.

## Architecture et documentation

- Architecture détaillée et contrats de messages : [docs/fr/ARCHITECTURE.md](docs/fr/ARCHITECTURE.md) ([EN](docs/ARCHITECTURE.md))
- Journal des modifications (EN) : [CHANGELOG.md](CHANGELOG.md)
- Vue des répertoires :
  - `src/config/constants.js` - Constantes partagées, extensions/MIME, seuils, clés de stockage, réglages par défaut et types de messages.
  - `src/shared/` - Modules ES purs (`media_classifier.js`, `fetch_utils.js`, `hls_parser.js`, `dash_parser.js`, `fmp4_muxer.js`, `ts_transmuxer.js`, `preview_matcher.js`, `settings.js`, `i18n.js`).
  - `src/background/` - Capture réseau, état de session, badge, règles DNR temporaires (`dnr_manager.js`), cycle de vie offscreen, annulation et téléchargements.
  - `src/offscreen/` - Document offscreen assemblant les segments HLS et DASH en URL Blob téléchargeable.
  - `src/content/` - Scanner DOM à la demande (support `srcset` et `<picture>`) et bouton intégré aux posts X/Twitter.
  - `src/popup/` - Interface popup modulaire (`popup.js`, `media_card.js`, `preview_player.js`, `batch_runner.js`, `popup_helpers.js`) avec aperçu vidéo, recherche/tri, file d'inspection bornée avec réessai, sélection de qualité et de piste audio, alerte >512 Mo, confirmation par lot, annulation et suivi de progression.
  - `src/options/` - Page de paramètres synchronisés (`options.html`, `options.css`, `options.js`).

## Installation dans Chrome

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer le **Mode développeur** en haut à droite.
3. Cliquer sur **Charger l'extension non empaquetée** et sélectionner ce dossier.
4. Ouvrir une page ou un post (par exemple sur X), lancer ou recharger la vidéo, puis cliquer sur l'icône Media Harvest ou le bouton du post.

## Tests, intégration continue et distribution

Aucune dépendance npm externe n'est nécessaire : la vérification syntaxique, l'empaquetage et la suite de tests reposent uniquement sur `node --check`, `node:test` et `node:assert/strict` (`94` tests dans `tests/`, exécutés aussi en CI sous Node 22 via `.github/workflows/ci.yml`) :

```powershell
npm run check
npm test
npm run test:coverage
npm run package
```
