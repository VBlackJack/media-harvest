[English version](../CHROME_WEB_STORE.md)

# Guide de publication Chrome Web Store (`v1.3.0`)

## Construction du paquet

1. Générer l'archive distribuable et son empreinte SHA-256 :
   ```powershell
   npm run check
   npm test
   npm run test:e2e
   npm run package
   ```
2. Importer `dist/media-harvest-v1.3.0.zip` dans le tableau de bord développeur Chrome Web Store (**Package** -> **Upload new package**).

## Fiche du magasin

- **Nom :** Media Harvest
- **Résumé (132 caractères max) :** Détectez, prévisualisez et téléchargez vidéos, flux HLS/DASH sans DRM, palettes SVG, sous-titres, images et audio dans Chrome.
- **Catégorie :** Productivité (ou Outils pour les développeurs)
- **Langues :** Français (`fr`), Anglais (`en`)

### Description détaillée (Français)

Media Harvest est une extension Manifest V3 conçue pour inspecter et enregistrer les ressources média de l'onglet actif sans publicité, sans télémétrie et sans serveur externe :

- **Vidéos et flux :** Détecte les vidéos MP4/WebM et flux HLS (`.m3u8`) ou DASH (`.mpd`) sans DRM en popup ou panneau latéral Chrome, avec choix de résolution/débit, déchiffrement `AES-128`, enregistrement DVR en direct et muxage fMP4/MPEG-TS borné à `512` Mo en document offscreen.
- **Sauvegarde disque directe (>512 Mo) :** Écrit en continu les vidéos HTTP progressives et playlists HLS/DASH (avec transmuxage incrémental MPEG-TS vers MP4) directement sur disque via l'API File System Access.
- **Extraction audio autonome :** Extrait les pistes audio directement dans le navigateur en AAC `.m4a` sans réencodage, Ogg/Opus `.opus` compact via WebCodecs, ou `.wav` PCM 16 bits.
- **Images, SVG et Lightbox Pro :** Inspecte `<img>`, `<picture>`, `srcset`, Shadow DOM ouvert, `<canvas>`, `<svg>` en ligne et sprites `.svg#symbol`. Inclut les filtres d'orientation (`paysage`/`portrait`/`carré`), le redimensionnement maximal (`512` - `3840` px), l'extraction de palette SVG avec recolorisation en direct et conversion `currentColor`, la conversion WebP/AVIF/SVG vers PNG/JPG et l'export groupé `.zip` compressé DEFLATE.
- **Sous-titres et boutons intégrés :** Capture `.vtt`, `.srt`, `.ttml`, `.ass` et sous-titres HLS ; ajoute des boutons désactivables en direct sur X/Twitter, les principales plateformes sociales et les lecteurs HTML5 génériques, ainsi que l'enregistrement d'onglet `REC` via `chrome.tabCapture`.
- **Compagnon local optionnel :** Prend en charge un hôte Native Messaging (`companion/`) pilotant `yt-dlp` et `ffmpeg` installés localement par l'utilisateur.

## Politique de confidentialité et données

- **Zéro télémétrie :** Media Harvest ne collecte, ne stocke et ne transmet aucune statistique, historique de navigation ou donnée utilisateur vers un serveur tiers ou développeur.
- **Stockage strictement local :** Les URL capturées résident en mémoire transitoire (`chrome.storage.session`), les préférences d'interface dans `chrome.storage.local` et les paramètres dans le profil Chrome Sync de l'utilisateur (`chrome.storage.sync`).

## Justification des permissions

| Permission | Justification pour la revue Chrome Web Store |
|---|---|
| `downloads` | Déclenche les téléchargements demandés par l'utilisateur (`chrome.downloads.download`), permet l'annulation et nettoie les URL Blob temporaires à la fin du transfert. |
| `webRequest` + `<all_urls>` | Observe passivement les en-têtes média HTTP (`Content-Type`, `Content-Length`) afin de répertorier les flux vidéo, audio, HLS, DASH et sous-titres chargés par l'onglet actif. |
| `activeTab` + `scripting` | Injecte `dom_scanner.js` et `mse_bridge.js` uniquement lorsque l'utilisateur ouvre l'interface ou demande un export MSE sur les cadres de l'onglet actif. |
| `storage` | Enregistre l'état transitoire par onglet (`session`), les filtres de la popup (`local`) et les préférences utilisateur (`sync`). |
| `offscreen` | Exécute un document offscreen MV3 isolé (`src/offscreen/offscreen.html`) pour le décodage Web Audio, l'encodage Opus WebCodecs, la conversion Canvas, la création ZIP, `MediaRecorder` et le muxage MP4. |
| `tabCapture` | Enregistre l'audio et la vidéo de l'onglet actif via `chrome.tabCapture.getMediaStreamId` uniquement lorsque l'utilisateur clique sur **Capture onglet**. |
| `sidePanel` | Permet d'ancrer Media Harvest de manière persistante dans le panneau latéral Chrome à côté de la page consultée. |
| `declarativeNetRequest` | Ajoute des règles de session éphémères contenant `Referer` / `Origin` uniquement le temps d'inspecter ou de télécharger un média sur un CDN protégé, puis les supprime aussitôt. |
| `nativeMessaging` | Pont optionnel vers l'hôte local `com.mediaharvest.companion` (`yt-dlp` + `ffmpeg`) uniquement sur action explicite de l'utilisateur. |
