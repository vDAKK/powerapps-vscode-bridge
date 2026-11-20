# Privacy policy — Power Apps X VS Code

Last updated: 2026-11-18

This policy covers the **Power Apps X VS Code** browser extension and VS Code extension.

## Data collected

None. The extensions do not collect, store, sell or transmit personal data, and contain no analytics or telemetry.

## Data processed locally

- **Formulas and control names** of the Power Apps app open in your browser are read from the Power Apps Studio page and sent to the VS Code extension running on the same computer, over a WebSocket connection to `127.0.0.1` (localhost). Edits made in VS Code travel back the same way. This data never leaves your computer through the extensions.
- **Screen preview**: when you open the screen preview in VS Code, the browser extension sends the layout and text of the current Power Apps Studio screen (HTML with computed styles, no scripts) to the VS Code extension over the same local connection. It is kept in memory only.
- **Settings**: the browser extension stores the local port number in the browser's extension storage. The VS Code extension stores its settings in VS Code.
- **Optional disk mirror**: if you set `powerappsBridge.mirrorFolder`, the VS Code extension writes copies of the formulas and of Studio error messages to that folder on your disk.

## Permissions (browser extension)

- Access to `https://*.powerapps.com/*`: read and write the formula bar and the selected control in Power Apps Studio.
- `scripting`, `activeTab`: run the page diagnostic from the popup on the current tab.
- `storage`: remember the local port number.

## Third parties

No data is shared with third parties. Power Apps itself is operated by Microsoft under its own privacy terms.

## Contact

Questions: open an issue at https://github.com/vDAKK/powerapps-vscode-bridge/issues
