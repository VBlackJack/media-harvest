[English version](README.md)

# Media Harvest

Extension Chrome et Firefox Manifest V3 (`v1.5.1`) pour détecter, prévisualiser et télécharger les vidéos, flux HLS (`.m3u8`) et DASH (`.mpd`) sans DRM, sous-titres (WebVTT et SubRip `.srt`), images et fichiers audio de l'onglet actif, en popup ou dans le panneau latéral Chrome.

## Fonctionnalités

- Analyse le DOM de la page (`<video>`, `<audio>`, `<img>`, `<canvas>` non corrompus, `<track>`, vecteurs `<svg>` en ligne avec résolution de symboles `<use>`, extraction de symboles sur sprites `.svg#id` et assainissement/nettoyage XML via `svg_utils.js`, ressources CSS `data:image/svg+xml` / `background-image` / `mask-image`, liens directs, Shadow DOM ouvert, balises OpenGraph/Twitter et JSON-LD `VideoObject`/`AudioObject`/`ImageObject`) sur tous les cadres (`allFrames: true`), avec aperçu vidéo et lecture `<audio>` intégrée.
- Capture les réponses réseau média (`.mp4`, `.webm`, `.m3u8`, `.mpd`, `.vtt`, `.srt`, `.ttml`, `.ass`, audio, images) par onglet via `chrome.webRequest`, propage `Referer`/`Origin` via des règles `declarativeNetRequest` persistées en session pour les CDN protégés, capture en secours les flux MSE (`MediaSource`) via un `MessageChannel` privé avec plafonds mémoire SPA (`enableMseCapture`) et enregistre la vidéo+audio de l'onglet actif via `chrome.tabCapture` (`Capture onglet` / `Arrêter REC` avec spool disque OPFS).
- Parse les playlists HLS VOD et direct (y compris `#EXT-X-BYTERANGE`, réinitialisation sur `#EXT-X-DISCONTINUITY`, suivi `#EXT-X-MAP` par segment, LL-HLS `#EXT-X-PART`, `#EXT-X-MEDIA:TYPE=SUBTITLES` avec conversion WebVTT vers SRT en un clic, déchiffrement natif Web Crypto `AES-128`, extraction audio autonome dans le navigateur en `.m4a`, Ogg/Opus `.opus` compact via WebCodecs ou `.wav` PCM 16 bits sur flux HLS, DASH, MSE et médias directs HTTP MP4/WebM, et enregistrement DVR HLS/DASH sur spool disque OPFS) ainsi que les manifestes DASH `.mpd` sans DRM (multi-Period et `SegmentBase`) ; réessaie automatiquement les segments avec backoff exponentiel, estime la taille des variantes avec alerte configurable, propose un enregistrement direct sur disque via File System Access (`src/saver/` avec continuité temporelle audio `tfdt` et transmuxage incrémental MPEG-TS vers MP4) pour les flux `>512` Mo sans compagnon, permet l'annulation en cours et assemble les segments en document offscreen (fragments `Uint8Array` sans copie contiguë pour fMP4, WebM, ZIP et MPEG-TS/ADTS via `mux-mp4.min.js`).
- Propose une vue galerie grille (`list` / `grid`), une recherche debouncée et une pagination incrémentale par 40 cartes, un onglet `SVG` avec copie du XML (`Copier SVG`) et isolation des symboles de sprites, des filtres rapides par dimension (`>= 100/300/800 px`), orientation (`paysage` / `portrait` / `carré`) et format d'image, une résolution d'export SVG configurable (`256` - `2048` px), un redimensionnement maximal des images (`512` - `3840` px) et une qualité JPG (`50` - `100` %), une visionneuse Lightbox Pro (bascule de fond `Damier` / `Clair` / `Sombre`, navigation clavier `ArrowLeft`/`ArrowRight`, palette SVG avec recolorisation en direct, `currentColor` et réinitialisation, copie SVG/URL et téléchargement), une conversion raster à la volée (`WebP` / `AVIF` / `SVG` -> `PNG` ou `JPG`), une sélection multiple avec export `.zip` DEFLATE sélectif, une file de lots résiliente en Service Worker, un tiroir d'historique récent, la persistance des réglages UI et le panneau latéral Chrome.
- Ajoute des boutons de téléchargement intégrés avec menu rapide qualité/audio accessible au clavier (`overlay_common.js`) directement sur X/Twitter (`x.com` / `twitter.com`), les lecteurs vidéo sociaux (`youtube.com`, `instagram.com`, `tiktok.com`, `reddit.com`, `facebook.com`, `bsky.app`, `vimeo.com`, `dailymotion.com`, `twitch.tv`, `linkedin.com`) et tout lecteur HTML5 générique (`enableGenericVideoOverlay`), activables en direct avec exclusion par domaine (`disabledOverlayHosts`).
- Inclut un compagnon optionnel Windows/Linux/macOS Native Messaging (`companion/` pilotant `yt-dlp` et `ffmpeg`) avec progression en direct, annulation temps réel avec arrêt de l'arbre de processus, timeout réel et transmission optionnelle des cookies Chrome/Edge (`enableCompanionCookies`) pour les vidéos lourdes (`>512` Mo) ou flux complexes.
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
| Domaines exclus des boutons intégrés | `[]` | Domaines séparés par virgule (max `100`) | Désactive les boutons intégrés sur les domaines listés et leurs sous-domaines |

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
  - `src/shared/` - Modules ES purs (`media_classifier.js`, `fetch_utils.js`, `hls_parser.js`, `hls_crypto.js`, `dash_parser.js`, `stream_planner.js`, `stream_selector.js`, `fmp4_muxer.js`, `webm_muxer.js`, `mixed_mse_muxer.js`, `adts_transmuxer.js`, `ts_transmuxer.js`, `wav_encoder.js`, `ogg_opus_muxer.js`, `subtitle_utils.js`, `svg_utils.js`, `zip_builder.js`, `preview_matcher.js`, `settings.js`, `i18n.js`).
  - `src/background/` - Capture réseau, état de session, badge, règles DNR persistées (`dnr_manager.js`), client compagnon (`companion_client.js`), historique (`download_history.js`), file de lots résiliente (`batch_queue.js`), cycle de vie offscreen, annulation, transfert au module d'écriture directe et téléchargements.
  - `src/offscreen/` - Document offscreen (`offscreen.js`), spool disque OPFS (`opfs_spool.js`), capture d'onglet (`tab_capture.js`), transcodeur Web Audio/Opus (`audio_transcoder.js`) et convertisseur image/SVG (`image_processor.js`).
  - `src/saver/` - Page dédiée d'écriture continue sur disque via File System Access (`stream_saver.html`, `stream_saver.js`) pour les flux progressifs et playlists de plus de `512` Mo.
  - `src/content/` - Scanner DOM à la demande (`dom_scanner.js`), pont MSE privé par `MessageChannel` (`mse_hook.js`, `mse_bridge.js`), base commune d'overlays (`overlay_common.js`, `overlay_common.css`) et boutons intégrés (`x_overlay.js`, `site_overlay.js`).
  - `src/popup/` - Interface popup modulaire (`popup.js`, `media_card.js`, `lightbox_controller.js`, `history_controller.js`, `preview_player.js`, `batch_runner.js`, `popup_helpers.js`) avec aperçu vidéo, Lightbox Pro, recherche debouncée et pagination par 40 cartes, file d'inspection bornée avec réessai, sélection qualité/audio/sous-titres (VTT/SRT), action disque >512 Mo, export ZIP, annulation et suivi de progression.
  - `src/options/` - Page de paramètres synchronisés (`options.html`, `options.css`, `options.js`).

## Installation dans Chrome

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer le **Mode développeur** en haut à droite.
3. Cliquer sur **Charger l'extension non empaquetée** et sélectionner ce dossier.
4. Ouvrir une page ou un post (par exemple sur X), lancer ou recharger la vidéo, puis cliquer sur l'icône Media Harvest ou le bouton du post.

## Tests, intégration continue et distribution

Aucune dépendance npm externe n'est nécessaire : la vérification syntaxique, l'empaquetage déterministe (Chromium et Firefox MV3) et la suite de tests reposent uniquement sur `node --check`, `node:test` et `node:assert/strict` (`171` tests dans `tests/`, exécutés en CI sous Node 22 via `.github/workflows/ci.yml` avec publication automatique sur tag via `.github/workflows/release.yml`), ainsi qu'un test E2E MV3 sous Chromium/Edge headless (`npm run test:e2e`) :

```powershell
npm run check
npm test
npm run test:e2e
npm run test:coverage
npm run package
npm run package:firefox
```
