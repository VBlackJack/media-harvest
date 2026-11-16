[English version](README.md)

# Media Harvest

Extension Chrome Manifest V3 (`v1.2.2`) pour détecter, prévisualiser et télécharger les vidéos, flux HLS (`.m3u8`) et DASH (`.mpd`) sans DRM, sous-titres, images et fichiers audio de l'onglet actif, en popup ou dans le panneau latéral Chrome.

## Fonctionnalités

- Analyse le DOM de la page (`<video>`, `<audio>`, `<img>`, `<canvas>` non corrompus, `<track>`, vecteurs `<svg>` en ligne avec résolution de symboles `<use>`, extraction de symboles sur sprites `.svg#id` et nettoyage XML via `svg_utils.js`, ressources CSS `data:image/svg+xml` / `background-image` / `mask-image`, liens directs, Shadow DOM ouvert, balises OpenGraph/Twitter et JSON-LD `VideoObject`/`AudioObject`/`ImageObject`) sur tous les cadres (`allFrames: true`), avec aperçu vidéo et lecture `<audio>` intégrée.
- Capture les réponses réseau média (`.mp4`, `.webm`, `.m3u8`, `.mpd`, `.vtt`, `.srt`, `.ttml`, `.ass`, audio, images) par onglet via `chrome.webRequest`, propage `Referer`/`Origin` via des règles temporaires `declarativeNetRequest` pour les CDN protégés, capture en secours les flux MSE (`MediaSource`) jusqu'à `150` Mo (`enableMseCapture`) et enregistre la vidéo+audio de l'onglet actif via `chrome.tabCapture` (`Capture onglet` / `Arrêter REC`).
- Parse les playlists HLS VOD et direct (y compris `#EXT-X-BYTERANGE`, réinitialisation sur `#EXT-X-DISCONTINUITY`, `#EXT-X-MEDIA:TYPE=SUBTITLES`, déchiffrement natif Web Crypto `AES-128`, extraction audio autonome dans le navigateur en `.m4a`, Ogg/Opus `.opus` compact via WebCodecs ou `.wav` PCM 16 bits sur flux HLS, DASH, MSE et médias directs HTTP MP4/WebM via `ogg_opus_muxer.js` et `wav_encoder.js`, et enregistrement DVR HLS/DASH en direct) ainsi que les manifestes DASH `.mpd` sans DRM ; réessaie automatiquement les segments en erreur transitoire, estime la taille des variantes avec alerte de flux volumineux configurable, propose un enregistrement direct sur disque via File System Access (`src/saver/` avec transmuxage incrémental MPEG-TS vers MP4) pour les vidéos HTTP progressives et playlists de plus de `512` Mo sans compagnon, permet l'annulation en cours de téléchargement et assemble les segments en document offscreen dans une limite mémoire de `512` Mo (fragments `Uint8Array` sans copie contiguë pour muxage fMP4 vidéo+audio et transmuxage MPEG-TS/ADTS vers MP4 via `mux-mp4.min.js`).
- Propose une vue galerie grille (`list` / `grid`), un onglet `SVG` avec copie du XML (`Copier SVG`) et isolation des symboles de sprites, des filtres rapides par dimension (`>= 100/300/800 px`), orientation (`paysage` / `portrait` / `carré`) et format d'image, une résolution d'export SVG configurable (`256` - `2048` px), un redimensionnement maximal des images (`512` - `3840` px) et une qualité de compression JPG (`50` - `100` %), une visionneuse Lightbox Pro (bascule de fond `Damier` / `Clair` / `Sombre`, extraction de palette SVG avec recolorisation en direct et conversion `currentColor`, copie SVG/URL et téléchargement), une conversion raster à la volée (`WebP` / `AVIF` / `SVG` -> `PNG` ou `JPG`), une sélection multiple avec export groupé en archive `.zip` compressée DEFLATE sélectivement (noms d'origine ou séquentiels indexés), persistance des réglages UI et panneau latéral Chrome.
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
| Seuil d'alerte flux volumineux | `250` Mo | `0` - `512` Mo | Affiche un badge d'alerte au-dessus du seuil (`0` désactive) ; les flux `>512` Mo proposent l'écriture directe sur disque (`src/saver/`) |
| Qualité de conversion JPG | `90` % | `50` - `100` % | Qualité de compression utilisée lors de la conversion raster ou SVG vers `.jpg` |
| Redimensionnement max image | `0` (Original) | `0`, `512`, `1024`, `1920`, `2560`, `3840` px | Réduit les images dépassant cette largeur maximale à l'export (`0` conserve la taille d'origine) |
| Format d'export audio | `m4a` | `m4a`, `opus`, `wav` | Conteneur cible pour l'extraction audio autonome (AAC `.m4a`, Ogg/Opus WebCodecs `.opus` ou `.wav` PCM 16 bits) |
| Débit Capture onglet | `5` Mbps | `1` - `16` Mbps | Débit vidéo cible pour les enregistrements `chrome.tabCapture` |
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

- **DRM / Chiffrement :** Les flux HLS chiffrés en `AES-128` (`METHOD=AES-128`) sont déchiffrés nativement en mémoire via Web Crypto, tandis que les flux DRM (`SAMPLE-AES` / `#EXT-X-SESSION-KEY` et DASH `ContentProtection`) sont détectés et refusés explicitement.
- **Flux directs (Live) :** Les diffusions HLS en direct et DASH dynamiques (`type="dynamic"`) peuvent être capturées en mode DVR (`Enregistrer` / `Arrêter & sauver` dans la limite de `512` Mo) avec indicateur `REC` sur l'icône d'extension.
- **Plafond mémoire :** L'assemblage en mémoire dans le document offscreen est plafonné à `512` Mo (`LIMITS.MAX_HLS_BUFFER_BYTES`) afin de préserver la stabilité du navigateur.

## Permissions

- `downloads` - Déclenche et suit les téléchargements (`chrome.downloads.download` / `.cancel` / `.onChanged`).
- `webRequest` + `<all_urls>` - Lit les en-têtes média (`Content-Type`, `Content-Length`) et les navigations principales par onglet.
- `activeTab` + `scripting` - Analyse le DOM média à la demande lors de l'ouverture de la popup.
- `storage` - Stocke l'état transitoire d'onglet dans `chrome.storage.session`, le dernier filtre/tri dans `chrome.storage.local` et les préférences utilisateur dans `chrome.storage.sync`.
- `offscreen` - Exécute le téléchargement des segments, la capture d'onglet MediaRecorder et le muxage MP4 dans un document offscreen MV3 isolé avec révocation des URL Blob.
- `tabCapture` - Autorise l'enregistrement vidéo+audio de l'onglet actif à la demande (`chrome.tabCapture.getMediaStreamId`) via le bouton **Capture onglet**.
- `sidePanel` - Permet d'ouvrir la liste capturée dans le panneau latéral Chrome pour la garder visible pendant la navigation.
- `declarativeNetRequest` - Applique temporairement les en-têtes `Referer` / `Origin` en session pour inspecter ou télécharger des médias sur CDN protégés.
- `nativeMessaging` - Communique avec le compagnon local optionnel `com.mediaharvest.companion` (`yt-dlp` + `ffmpeg`) lorsqu'il est installé.

## Architecture et documentation

- Architecture détaillée et contrats de messages : [docs/fr/ARCHITECTURE.md](docs/fr/ARCHITECTURE.md) ([EN](docs/ARCHITECTURE.md))
- Guide Chrome Web Store et confidentialité : [docs/fr/CHROME_WEB_STORE.md](docs/fr/CHROME_WEB_STORE.md) ([EN](docs/CHROME_WEB_STORE.md))
- Journal des modifications (EN) : [CHANGELOG.md](CHANGELOG.md)
- Vue des répertoires :
  - `src/config/constants.js` - Constantes partagées, extensions/MIME, seuils, clés de stockage, réglages par défaut et types de messages.
  - `src/shared/` - Modules ES purs (`media_classifier.js`, `fetch_utils.js`, `hls_parser.js`, `hls_crypto.js`, `dash_parser.js`, `fmp4_muxer.js`, `ts_transmuxer.js`, `wav_encoder.js`, `ogg_opus_muxer.js`, `svg_utils.js`, `zip_builder.js`, `preview_matcher.js`, `settings.js`, `i18n.js`).
  - `src/background/` - Capture réseau, état de session, badge, règles DNR temporaires (`dnr_manager.js`), cycle de vie offscreen, annulation, transfert au module d'écriture directe et téléchargements.
  - `src/offscreen/` - Document offscreen assemblant les segments HLS/DASH, décodant l'audio PCM `.wav`, convertissant les images/SVG et générant les archives ZIP.
  - `src/saver/` - Page dédiée d'écriture continue sur disque via File System Access (`stream_saver.html`, `stream_saver.js`) pour les flux progressifs et playlists de plus de `512` Mo.
  - `src/content/` - Scanner DOM à la demande (`srcset`, `<picture>` et sprites SVG `<use>`), capture MSE et boutons intégrés aux lecteurs vidéo.
  - `src/popup/` - Interface popup modulaire (`popup.js`, `media_card.js`, `preview_player.js`, `batch_runner.js`, `popup_helpers.js`) avec aperçu vidéo, Lightbox Pro, recherche/tri, file d'inspection bornée avec réessai, sélection de qualité, piste audio et sous-titres, action disque >512 Mo, export ZIP, annulation et suivi de progression.
  - `src/options/` - Page de paramètres synchronisés (`options.html`, `options.css`, `options.js`).

## Installation dans Chrome

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer le **Mode développeur** en haut à droite.
3. Cliquer sur **Charger l'extension non empaquetée** et sélectionner ce dossier.
4. Ouvrir une page ou un post (par exemple sur X), lancer ou recharger la vidéo, puis cliquer sur l'icône Media Harvest ou le bouton du post.

## Tests, intégration continue et distribution

Aucune dépendance npm externe n'est nécessaire : la vérification syntaxique, l'empaquetage et la suite de tests reposent uniquement sur `node --check`, `node:test` et `node:assert/strict` (`129` tests dans `tests/`, exécutés aussi en CI sous Node 22 via `.github/workflows/ci.yml`), ainsi qu'un test E2E MV3 sous Chromium/Edge headless (`npm run test:e2e`) :

```powershell
npm run check
npm test
npm run test:e2e
npm run test:coverage
npm run package
```
