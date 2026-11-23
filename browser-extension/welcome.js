// Fills the welcome page's static texts from _locales (MV3 pages can't use inline scripts).
// data-i18n sets the text content; data-i18n-<attribute> sets title, aria-label or placeholder.
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
for (const attr of ['title', 'aria-label', 'placeholder']) {
  for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
    el.setAttribute(attr, chrome.i18n.getMessage(el.getAttribute(`data-i18n-${attr}`)));
  }
}
