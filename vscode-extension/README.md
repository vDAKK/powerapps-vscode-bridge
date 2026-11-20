# Power Apps X VS Code

Edit Power Apps canvas app formulas in VS Code, with a live two-way sync to the formula bar of Power Apps Studio.

> Unofficial project, not affiliated with or endorsed by Microsoft. Power Apps and Visual Studio Code are trademarks of Microsoft.

## How it works

```
Power Apps Studio (browser)  ⇄  companion browser extension  ⇄  ws://127.0.0.1  ⇄  this VS Code extension
```

- Select a control in Studio: its formula opens in VS Code as a `powerfx:/Control/Control.Property.fx` file.
- Type in VS Code: the formula is written into Studio's formula bar, keeping Studio's undo history.
- Type in Studio: the open VS Code document updates.
- Formula errors reported by Studio appear in the VS Code **Problems** panel.

## Requirements

1. This extension.
2. The **Power Apps X VS Code** browser extension (Chrome, Edge or Firefox), which reads and writes Studio's formula bar.
3. A canvas app open in Power Apps Studio.

When both are running, the status bar shows the selected control. If it shows a disconnected plug, open the browser extension popup and click **Reconnect**.

## Features

- **Screen preview**: the current Studio screen with one clickable box per control. Click a control to select it in Studio and open its formula, search controls by name, switch screens. It is a live copy of the screen (rendered from the HTML of Studio's canvas, no screenshot, no extra permission) that follows your edits. Controls with formula errors are outlined in red.
- **Getting started walkthrough** (opens on first install, or *Help: Get Started*) and a help menu on the status bar item.
- **Ctrl+click** a control name in a formula to select it in Studio, or `Control.Property` to open that formula.
- **Power Apps sidebar** with the app tree (screens and controls) and the properties of the selected control, with error icons.
- **Go to formula** (`Ctrl+Alt+G`): jump to any `Control.Property`.
- **Go to property** (`Ctrl+Alt+P`): switch property of the current control.
- **Power Fx syntax highlighting** and completion of Power Fx functions and of control properties (after `Control.`).
- **Follow selection**: the editor follows what you select in Studio (toggle from the command palette).
- **Disk mirror** (optional): a read-only copy of the formulas and of Studio errors in a folder, for tools that only read real files.

## Settings

| Setting | Default | Description |
|---|---|---|
| `powerappsBridge.port` | `8765` | Local WebSocket port the browser extension connects to (127.0.0.1 only). Must match the port set in the browser extension. |
| `powerappsBridge.followSelection` | `true` | Open the formula selected in Studio automatically. |
| `powerappsBridge.navigateOnEdit` | `true` | When you edit a formula that Studio is not showing, switch Studio to it before writing. |
| `powerappsBridge.singleTab` | `true` | Keep one formula tab open; pinned tabs are kept. |
| `powerappsBridge.mirrorFolder` | empty | Folder for the read-only disk mirror (relative to the workspace). Writes `<Control>/<Control>.<Property>.fx` and `_state.json`. Empty disables it. |

## Commands

All commands are in the command palette under **Power Apps X VS Code**: restart server, show log, toggle follow selection, go to formula, go to property, go to control, refresh tree, load properties.

## Privacy and security

- The WebSocket server listens on `127.0.0.1` only and accepts connections from browser extensions only (`chrome-extension://`, `moz-extension://` origins).
- No data leaves your machine: formulas travel between your browser and VS Code locally. No telemetry.

See the [privacy policy](https://github.com/vDAKK/powerapps-vscode-bridge/blob/main/PRIVACY.md).

## Limitations

Power Apps Studio's interface is not a public API. A Studio update can break detection of the formula bar or of the selected control until the browser extension is updated. Report issues on [GitHub](https://github.com/vDAKK/powerapps-vscode-bridge/issues).
