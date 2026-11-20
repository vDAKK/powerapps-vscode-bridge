# Comment ça se connecte

```
Power Apps Studio (navigateur)
        │  extension navigateur « Power Apps X VS Code »
        ▼
ws://127.0.0.1:8765   (local uniquement)
        │
        ▼
VS Code (cette extension)
```

**Barre d'état de VS Code**

| Affichage | Signification |
|---|---|
| `⊘ Power Apps` | Serveur arrêté : *Redémarrer le serveur* |
| `Power Apps` débranché | En attente de Studio |
| `▣ NomDuContrôle` | Connecté, contrôle sélectionné |

Clique sur la barre d'état à tout moment pour ouvrir le menu d'aide.

**Ça ne se connecte pas ?**

- L'icône de l'extension navigateur affiche `ON` quand la connexion est établie.
- Le port doit être le même des deux côtés (8765 par défaut).
- Le menu de l'extension navigateur propose *Reconnecter* et un *Diagnostic de la page*.
