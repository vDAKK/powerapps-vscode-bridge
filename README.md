# Power Apps ↔ VS Code Bridge

Synchro temps réel entre la barre de formule de Power Apps Studio et VS Code.

```
Studio (page.js, MAIN world) ⇄ bridge.js ⇄ background.js (service worker)
        ⇄ ws://127.0.0.1:8765 ⇄ extension VS Code (fichiers virtuels powerfx:/Control/Control.Prop.fx)
```

## Installation

1. **VS Code** : `code --install-extension powerapps-bridge-0.1.0.vsix` (ou F5 depuis `vscode-extension/`).
   Barre d'état : `Power Apps` (déconnecté) → `Button1.OnSelect` (connecté).
2. **Chrome / Edge** : `chrome://extensions` → Mode développeur → *Charger l'extension non empaquetée* → `browser-extension/`.
3. Ouvrir une canvas app dans Power Apps Studio, panneau **Arborescence** visible.

## Fonctionnement

- Studio → VS Code : sondage toutes les 200 ms (contrôle sélectionné, propriété, formule). Changement de sélection → ouverture du fichier ; frappe dans Studio → mise à jour du document.
- VS Code → Studio : chaque frappe (anti-rebond de 150 ms) → `setFormula` → écriture dans l'éditeur Monaco de Studio (`executeEdits`, garde l'historique annuler/rétablir).
- Anti-écho et anti-conflit : pendant 1,5 s après une frappe dans VS Code, les mises à jour qui viennent de Studio sont ignorées. Une édition destinée à un autre contrôle que celui sélectionné dans Studio est refusée.
- Sécurité : serveur lié à 127.0.0.1 uniquement, et seules les origines `chrome-extension://` et `moz-extension://` sont acceptées.

## Réglage des sélecteurs (si rien n'est détecté)

L'interface de Studio n'est pas documentée. Popup de l'extension → **Diagnostic de la page** → Copier, puis ajuster
`FORMULA_BAR_SELECTORS`, `PROPERTY_SELECTORS` et `SELECTED_CONTROL_SELECTORS` en haut de `browser-extension/page.js`.

Modes de lecture et d'écriture (champ `mode`) :
- `monaco` : instance de l'éditeur trouvée (API `monaco` globale ou parcours des objets React internes). Lecture et écriture fiables.
- `monaco-dom` : instance introuvable. Lecture depuis le DOM ; écriture par sélection de tout + collage simulé, non garantie.
- `input` / `ce` : la barre de formule n'est pas Monaco.
