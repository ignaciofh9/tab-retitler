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
Too many tabs that all say the same thing? Tab Retitler renames them, and marks their icons, using what's on each page.

Type the title you want, and it works out the rule
Open the side panel on any page and type the title you'd like, such as "4521 · Garden tools" instead of "Shop – Product page". Tab Retitler finds where each part comes from (the address, the page title, or text on the page) and writes the rule for you. Switch to another tab on the same site and do the same; it keeps every rule that fits your examples and narrows them down as you go, asking you on other open tabs when it's unsure.

It understands addresses like "/posts/fix-login-redirect" and can turn them into "Fix login redirect", changing case and turning dashes into spaces when that's what you typed.

Icons that tell you something
• Add a dot or short text badge to a site's own icon: round, square or a corner flag, in any corner and size.
• Outline or tint the icon, or fade and gray it out.
• Let the icon follow the page: a green dot when a task is "Done", blue when it's "In Review", nothing otherwise. Tab Retitler suggests colors from the page's own status labels.

The tab is the preview
Edits apply to your open tabs as you type, and the side panel shows how the rule does on the tab you're looking at, with the actual values it finds there.

Also
• Pick text on the page with your mouse instead of writing CSS selectors.
• Turn rules on and off, reorder them, and see only the ones for the current site.
• Share rules as a short code or a readable JSON file, and import them with a preview of what each rule does.

Private by design
Your rules and everything Tab Retitler reads stay on your computer. Nothing is sent anywhere, there's no account, and no analytics. It only runs on sites you allow, one at a time.
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

## Before you submit

1. Check the privacy policy is live at the URL above (GitHub Pages serves it from `docs/`).
2. Run `./build.sh` and upload the zip from `dist/`.
3. Choose visibility: Public, Unlisted (only people with the link), or Private (a Google Workspace domain).
