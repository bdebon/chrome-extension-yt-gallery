# YouTube Contemplatif

Extension Chrome qui ajoute un bouton **Contempler** sur l'onglet *Vidéos* d'une chaîne
YouTube et ouvre une galerie plein écran pensée pour les chaînes d'ambiances
(images générées, sons planants, vidéos d'une heure).

## Installation (mode développeur)

1. Ouvrir `chrome://extensions` (dans Arc : `arc://extensions`).
2. Activer **Mode développeur** (en haut à droite).
3. Cliquer **Charger l'extension non empaquetée** et choisir ce dossier.
4. Ouvrir une page chaîne, onglet Vidéos, par exemple
   <https://www.youtube.com/@spiritual_brother/videos>.
5. Le bouton **Contempler** apparaît à droite des filtres *Les plus récentes / Populaires / Les plus anciennes*.

Après chaque modification du code : bouton ⟳ sur la carte de l'extension dans
`chrome://extensions`, puis recharger l'onglet YouTube.

Pas de build, pas de dépendances : trois fichiers vanilla.

## Utilisation

| Action | Effet |
| --- | --- |
| Clic sur une miniature | lance la vidéo (navigation YouTube, sans rechargement) |
| Cmd + clic | ouvre la vidéo dans un nouvel onglet |
| Clic droit sur une miniature | ouvre cette vidéo en mode Cinéma |
| `C` | bascule Grille / Cinéma |
| `←` `→` | vidéo précédente / suivante (Cinéma) |
| `Entrée` | lance la vidéo affichée (Cinéma) |
| `Échap` | Cinéma → Grille, puis Grille → quitter |

La galerie charge automatiquement la suite de la chaîne quand on approche du bas
(elle fait défiler la page YouTube derrière elle pour déclencher le chargement).

## Fichiers

- `manifest.json` : Manifest V3, script de contenu sur `youtube.com`.
- `content.js` : détection de l'onglet Vidéos, lecture du DOM YouTube, galerie.
- `gallery.css` : styles de la galerie (rendus dans un Shadow DOM, isolés de YouTube).

## Contraintes techniques

- YouTube impose **Trusted Types** : pas de `innerHTML`, tout est construit avec `createElement`.
- YouTube est une SPA : le bouton est réinséré à chaque `yt-navigate-finish`.
- Miniatures : `maxresdefault.jpg` avec repli sur `hqdefault.jpg` quand la HD n'existe pas
  (YouTube renvoie alors un placeholder 120×90, détecté via `naturalWidth`).
