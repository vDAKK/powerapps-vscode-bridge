# How it connects

```
Power Apps Studio (browser)
        │  "Power Apps X VS Code" browser extension
        ▼
ws://127.0.0.1:8765   (local only)
        │
        ▼
VS Code (this extension)
```

**First connection:** VS Code asks whether it can trust the browser extension. Answer **Allow**; it only asks once.

**VS Code status bar**

| Shows | Meaning |
|---|---|
| `⊘ Power Apps` | Server stopped: *Restart server* |
| `Power Apps` unplugged | Waiting for Studio |
| `▣ ControlName` | Connected, control selected |

Click the status bar item at any time for the help menu.

**Not connecting?**

- The browser extension's popup shows the connection state and what to do next.
- The port must be the same on both sides (8765 by default). If another VS Code window already uses it, VS Code says so and offers to retry or change the port.
