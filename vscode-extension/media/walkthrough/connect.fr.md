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

**Première connexion :** VS Code demande s’il peut faire confiance à l’extension navigateur. Réponds **Autoriser** ; la question n’est posée qu’une fois.

**Barre d’état de VS Code**

| Affichage | Signification |
|---|---|
| `⊘ Power Apps` | Serveur arrêté : *Redémarrer le serveur* |
| `Power Apps` débranché | En attente de Studio |
| `▣ NomDuContrôle` | Connecté, contrôle sélectionné |

Clique sur la barre d’état à tout moment pour ouvrir le menu d’aide.

**Ça ne se connecte pas ?**

- Le popup de l’extension navigateur indique l’état de la connexion et la marche à suivre.
- Le port doit être le même des deux côtés (8765 par défaut). Si une autre fenêtre VS Code l’utilise déjà, VS Code le signale et propose de réessayer ou de changer de port.
