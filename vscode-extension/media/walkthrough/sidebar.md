# La barre latérale Power Apps

```
POWER APPS
├ ARBORESCENCE                         🔍 🖥 ⟳ ⇲ ↗ ?
│  ▸ 🚀 App                  Application
│  ▾ ▢ scrAccueil            Écran · 12 contrôles
│     ▸ ▦ conEntete          Conteneur · 3 contrôles
│     ▾ ☰ galProjets         Galerie · 2 contrôles
│         T lblNomProjet     Étiquette
│         ▶ btnOuvrir        ● sélectionné · Bouton
│  ▸ ▢ scrDetail             Écran · 8 contrôles
└ PROPRIÉTÉS · btnOuvrir
   ▾ ⚡ Comportement                 2 · ●
       ⚡ OnSelect    ● Navigate(scrDetail)
   ▾ 🗄 Données et contenu           3
       ▫ Text         "Ouvrir"
   ▸ 🎨 Apparence                   24
```

- **Toute l'app est chargée** à la connexion, même les écrans et conteneurs repliés dans Studio. L'arborescence de Studio est brièvement dépliée puis remise comme elle était. **⟳** recharge tout.
- Chaque contrôle affiche son **type**, le nombre de contrôles qu'il contient et ses erreurs. Survole-le pour voir son chemin (`scrAccueil › galProjets › btnOuvrir`) et des actions rapides.
- **Clic** : sélection dans Studio, même si le contrôle est replié (son chemin est déplié automatiquement).
- **🔍 Rechercher un contrôle** (`Ctrl+Alt+F`) : par nom, type ou écran.
- **Survol / clic droit** : *Ouvrir une propriété…*, *Afficher dans l'aperçu*, *Renommer…* (`F2`), *Copier le nom*.
- **Propriétés** : rangées par catégorie ; la catégorie de la propriété en cours se déplie toute seule.
- Tape au clavier dans une liste pour la filtrer.
