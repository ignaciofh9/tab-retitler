# Chrome Web Store listing: Tab Retitler

Everything to paste into the Developer Dashboard, tab by tab.

## Package

Upload `dist/tab-retitler-<version>.zip`, made by running `./build.sh`.

## Store listing

**Name:** Tab Retitler

**Summary** (taken from the manifest, 122 of 132 characters):

> Rename tabs and badge their icons using rules based on each page’s URL and content. Teach it by example in the side panel.

**Category:** Productivity › Tools

**Language:** English

**Description:**

```
Tab Retitler renames tabs and changes their icons based on each page's URL and content.

Type the title you want for a tab, like "4521 · Garden tools" instead of "Shop – Product page", and it works out the rule. Give it a few more tabs from the same site and it finds a rule that fits all of them. It can also change case and turn URL slugs like "fix-login-redirect" into "Fix login redirect".

Icons can get a dot, a short text badge, an outline or a tint. They can follow the page too: green when a task says Done, blue when it says In Review.

You edit rules in the side panel, and the tab updates as you type. You can pick page text with the mouse, turn rules on and off, and share them as a short code or a JSON file.

Nothing leaves your computer. No account, no tracking. It only runs on sites you allow.

Source code: https://github.com/ignaciofh9/tab-retitler
```

## Privacy practices

**Single purpose:**

> Tab Retitler changes the titles and icons of browser tabs, on sites the user chooses, according to rules the user sets up.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's rules, and examples they've taught, on their own device. |
| `scripting` | Runs Tab Retitler's own script on sites the user has allowed, to change those tabs' titles and icons and to read the text the user's rules ask for. |
| `favicon` | Reads a site's existing icon from Chrome's icon cache, so a badge or outline can be drawn on top of it. |
| `sidePanel` | Shows the rule editor in Chrome's side panel, next to the page it affects. |
| `tabs` | Reads the address and title of the tab beside the side panel, to show whether a rule applies to it and to offer creating a rule for that site. Also finds open tabs on a site the user is teaching, to check rules against them. |
| Host permissions (optional, `*://*/*`) | Nothing is granted at install. Access is requested one site at a time, only for sites the user adds a rule for, so Tab Retitler can run there. |

**Are you using remote code?** No, I am not using remote code. All code is in the package.

**Data usage:**

Tab Retitler reads page addresses, titles and text on sites the user allows, but only on the device, to apply the user's own rules. None of it is sent anywhere. Since the store's disclosure is about data an extension collects, leaving every data type unchecked is accurate. If you'd rather be conservative, you can tick "Website content" and "Web history" and explain they're processed on the device only.

Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://ignaciofh9.github.io/tab-retitler/privacy-policy.html

**Website** (from the manifest's `homepage_url`): https://github.com/ignaciofh9/tab-retitler

## Images

| What | Size | File |
|---|---|---|
| Store icon | 128×128 | `tab-retitler/icons/icon-128.png` (96×96 artwork with padding, as the store asks) |
| Screenshots | 1280×800 | `store-assets/screenshot-*.png` |
| Small promo tile | 440×280 | `store-assets/promo-small.png` |
| Marquee promo tile (optional, only used if featured) | 1400×560 | `store-assets/promo-marquee.png` |

## Before you submit

1. Check the privacy policy is live at the URL above (GitHub Pages serves it from `docs/`).
2. Run `./build.sh` and upload the zip from `dist/`.
3. Choose visibility: Public, Unlisted (only people with the link), or Private (a Google Workspace domain).
