# Marketplace Local Only

A Violentmonkey userscript for TheFaceBook Marketplace. The location and shipping filters in Marketplace are more of a suggestion than a rule. This userscript warns you about items outside your search radius and optionally hides them entirely. Not so much a complete overhaul as “just make it work the way it says it does.”

I've allowed TheFaceBook a little grace here by showing visible distance warnings. I think a little fuzzy matching here is OK, but by default it hides posts more than 5× the search radius, because if my filter is 10 miles, I'm probably not driving 868.1 miles.

<img width="2297" height="1182" alt="A screenshot of facebook marketplace with textual warnings about listings that exceed the filter distance." src="https://github.com/user-attachments/assets/64499357-f438-4db5-a685-83a9d795db50" />

It also hides eBay, Poshmark, and listings labeled for shipping by default. This is not an “ad blocker,” but one *_could hypothetically_* pair it with [uBlock Origin](https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/), a broader content blocker.

## Install in Firefox

1. Install [Violentmonkey from the official Firefox add-on page](https://addons.mozilla.org/firefox/addon/violentmonkey/).
2. Open [Install Marketplace Local Only](https://raw.githubusercontent.com/robertely/marketplace-local-only/main/marketplace-local-only.user.js) and confirm the install in Violentmonkey.
3. While browsing [Marketplace](https://www.facebook.com/marketplace/), open Violentmonkey’s toolbar menu and choose **Marketplace Local Only settings**.

## Settings

- **Distance tags** start yellow just beyond your Marketplace radius and turn red at twice that radius. Edit the cutoffs and colors or add your own bands.
- **Show distance within my radius** adds tags to nearby listings with a recognized location. This option starts off.
- **Hide beyond** starts at five times your radius. Change the multiplier or turn it off.
- **Hide listings labeled for shipping** starts on. Toggle it separately from the distance cutoff.
- **Hide partner listings** starts on. It hides eBay, Poshmark, and other cards Facebook marks as partner listings, and shows a notice on recognized partner item pages. Your previous Poshmark switch setting carries over when upgrading.

The multipliers follow your current Marketplace radius. With a 10 mi radius, the default red band starts at 20 mi and the default hide cutoff starts beyond 50 mi.

Save applies your settings across open Marketplace tabs. **Restore defaults → Save** restores the current defaults.

## Distance estimates and privacy

The script reads listing labels and provider information already available on Marketplace pages. It estimates straight-line distance from your Marketplace search center to the representative point of a recognized city, rather than driving distance or the seller’s exact address. The lookup covers places in the 50 states, the District of Columbia, and Puerto Rico.

Designed for desktop Marketplace in English. Listings in unrecognized cities keep Facebook’s own location text and get no distance estimate. Shipping and partner detection depend on the labels and provider information Facebook makes available.

The lookup and filtering run locally in your browser, without fetching extra listing pages. Violentmonkey stores your settings in your browser profile.

Place coordinates come from the U.S. Census Bureau’s national Places Gazetteer file. The embedded lookup normalizes place names and omits ambiguous matches. [2026 Census Gazetteer Files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2026.html)

## Test

The browser tests run on Linux with Node.js 22 or later, Bubblewrap, Firefox at `/usr/lib/firefox/firefox`, and the signed Violentmonkey extension. They use a disposable Firefox profile and offline Marketplace fixtures.

```sh
node test-firefox.mjs
```

Pass the path to the signed Violentmonkey `.xpi` as the first argument if the runner cannot find it in a local Firefox profile.

`node test-firefox.mjs --live` opens a separate, persistent Firefox profile on a Wayland desktop. Reopening it keeps the installed script and login session. Locally installed test copies disable automatic updates from the temporary installation server, so script updates must be installed explicitly.

## License

The userscript and tests are available under the [MIT License](LICENSE).
