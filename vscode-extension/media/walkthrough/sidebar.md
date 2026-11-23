# The Power Apps X VS Code side bar

```
POWER APPS X VS CODE
├ APPLICATION · scrHome
│  3 screens · 34 controls  ● 1 error
│  🔍 Search for a control          ⌖ ⌃
│  ⌄ ▭ scrHome                         9
│     › ▦ ctnHeader                    2
│     ⌄ ▦ ctnFooter                    2
│         ⬭ btnSubmit         ◀ selected
│         ⬭ Button3               ⚠ 1
└ CONTROL · btnSubmit
   ⬭ btnSubmit — Button
   scrHome › ctnFooter
   [Preview] [References 2] [✎] [⧉]
   🔍 Filter            Modified | All
   ⌄ BEHAVIOR
     OnSelect    Navigate(scrOrder)
```

- **Application**: every screen and control, loaded when Studio connects. The view follows Studio's selection; only its path is expanded. Type `/` to filter by name or type, use the arrow keys, `Enter` to select, `F2` to rename, right-click for more actions.
- **Control**: the inspector of the selected control. Click its path to go up, use the actions, filter properties by name or formula text, show only the **Modified** ones or **All** of them. Click a property to open its formula.
- Errors are in red; controls with a default name (Label3…) are in italics and get a suggested name.
