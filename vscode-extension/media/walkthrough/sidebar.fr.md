# La barre latérale Power Apps X VS Code

```
POWER APPS X VS CODE
├ APPLICATION · scrAccueil
│  3 écrans · 34 contrôles  ● 1 erreur
│  🔍 Rechercher un contrôle        ⌖ ⌃
│  ⌄ ▭ scrAccueil                      9
│     › ▦ ctnEntete                    2
│     ⌄ ▦ ctnPied                      2
│         ⬭ btnValider      ◀ sélectionné
│         ⬭ Button3               ⚠ 1
└ CONTRÔLE · btnValider
   ⬭ btnValider — Bouton
   scrAccueil › ctnPied
   [Aperçu] [Références 2] [✎] [⧉]
   🔍 Filtrer        Modifiées | Toutes
   ⌄ COMPORTEMENT
     OnSelect    Navigate(scrDetail)
```

- **Application** : tous les écrans et contrôles, chargés à la connexion de Studio. La vue suit la sélection de Studio ; seul son chemin est déplié. Tape `/` pour filtrer par nom ou par type, utilise les flèches, `Entrée` pour sélectionner, `F2` pour renommer, clic droit pour plus d’actions.
- **Contrôle** : l’inspecteur du contrôle sélectionné. Clique sur son chemin pour remonter, utilise les actions, filtre les propriétés par nom ou par texte de formule, n’affiche que les **Modifiées** ou **Toutes**. Clique sur une propriété pour ouvrir sa formule.
- Les erreurs sont en rouge ; les contrôles au nom par défaut (Label3…) sont en italique et reçoivent un nom suggéré.
