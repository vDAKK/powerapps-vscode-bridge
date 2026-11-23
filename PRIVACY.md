# Privacy policy — Power Apps X VS Code

Last updated: 2026-11-23

This policy covers the **Power Apps X VS Code** browser extension and VS Code extension.

## Data collected

None. The extensions do not collect, sell or transmit personal data to the developer or to anyone else, and contain no analytics or telemetry.

## Data processed locally

Everything below stays on your computer.

- **Formulas and control names** of the Power Apps app open in your browser are read from the Power Apps Studio page and sent to the VS Code extension running on the same computer, over a WebSocket connection to `127.0.0.1` (localhost). Edits made in VS Code travel back the same way.
- **Screen preview**: when you open the screen preview in VS Code, the browser extension sends the layout and text of the current Power Apps Studio screen (HTML with computed styles, no scripts) to the VS Code extension over the same local connection. It is kept in memory only.
- **Workspace folder**: by default the VS Code extension writes the app's formulas, the list of its controls and Studio's formula errors as files in a `.powerapps` folder of the open VS Code workspace, so that you and tools working on files can read them. When such a file is saved, it is sent to Studio. The folder git-ignores itself. Set `powerappsBridge.mirrorFolder` to an empty value to turn this off.
- **Browser extension storage**: the local port number used to reach VS Code, and a flag recording that VS Code has answered at least once (so the popup stops suggesting to install the VS Code extension).
- **VS Code extension storage**: its settings, and the list of browser extensions you approved to connect (their `chrome-extension://` or `moz-extension://` identifiers).

## Permissions (browser extension)

- Access to `https://*.powerapps.com/*`: read and write the formula bar and the selected control in Power Apps Studio. No other site is accessed.
- `scripting`, `activeTab`: run the read-only page diagnostic from the popup on the current tab, when you click its button.
- `storage`: the two values listed above.

On first install, the browser extension opens a welcome page that is part of the extension; it loads nothing from the network.

## Third parties

No data is shared with third parties. Power Apps itself is operated by Microsoft under its own privacy terms.

## Contact

Questions: open an issue at https://github.com/vDAKK/powerapps-vscode-bridge/issues
