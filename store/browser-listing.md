# Browser store listing — Power Apps X VS Code

Text to paste into the Chrome Web Store, Edge Add-ons and Firefox AMO forms.

## Name

Power Apps X VS Code

## Short description (max 132 characters)

Live two-way sync between the Power Apps Studio formula bar and VS Code. Unofficial, not affiliated with Microsoft.

## Detailed description

Edit Power Apps canvas app formulas in Visual Studio Code.

Power Apps X VS Code connects the formula bar of Power Apps Studio to VS Code, live and in both directions:
• Select a control in Studio and its formula opens in VS Code.
• Type in VS Code and the formula is written into Studio, keeping Studio's undo history.
• Studio formula errors appear in the VS Code Problems panel.
• Browse the app tree and control properties from the VS Code sidebar.

Requires the "Power Apps X VS Code" extension for VS Code (Visual Studio Marketplace or Open VSX).

Privacy: everything stays on your computer. The extension talks only to VS Code on 127.0.0.1 (localhost). No data collection, no analytics.

Unofficial project, not affiliated with or endorsed by Microsoft. Power Apps and Visual Studio Code are trademarks of Microsoft.

## Category

Developer Tools

## Single purpose (Chrome)

Synchronise the formula bar of Power Apps Studio with the Visual Studio Code editor running on the same computer.

## Permission justifications (Chrome / Edge)

- **Host permission `https://*.powerapps.com/*`**: the extension reads the selected control, property and formula from the Power Apps Studio page and writes formulas edited in VS Code back into its formula bar. It runs only on Power Apps pages.
- **scripting**: the popup's "Page diagnostic" button runs a read-only script on the current Power Apps tab to report which page elements were detected, to help troubleshoot.
- **activeTab**: gives the diagnostic access to the current tab only when the user clicks the button.
- **storage**: stores one setting, the local port number used to reach VS Code.
- **Remote code**: none. All code is in the package; the only connection is a WebSocket to 127.0.0.1.

## Data usage (Chrome privacy form)

- Data collected: none of the listed categories.
- Certify: not sold to third parties, not used for unrelated purposes, not used for creditworthiness.

## Privacy policy URL

https://github.com/vDAKK/powerapps-vscode-bridge/blob/main/PRIVACY.md

## Assets to provide

| Asset | Size | Status |
|---|---|---|
| Store icon | 128×128 | `browser-extension/icons/icon-128.png` |
| Screenshots (1 to 5) | 1280×800 or 640×400 | To capture: Studio and VS Code side by side |
| Small promo tile (Chrome) | 440×280 | Optional |
