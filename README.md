# Marketplace Local Only

A Violentmonkey userscript for TheFaceBook Marketplace. The location and/or shipping filters in marketplace are more of a suggestion then a rule. This userscript will warn you about items outside your search radius and optionally hide them entirely. Not so much a complete overhaul as "just make it work the way it says it does."

I've allowed TheFaceBook a little grace here by showing visible distance warnings. I think a little fuzzy matching here is OK, but it will hide posts more than 5x the search radius because if my filter is 10 miles I'm probably not driving 868.1 miles.

<img width="2297" height="1182" alt="A screenshot of facebook marketplace with textual warnings about listings that exceed the filter distance." src="https://github.com/user-attachments/assets/64499357-f438-4db5-a685-83a9d795db50" />

Also hides Poshmark, and postings that will ship to you by default. This is not an "ad-blocker", but one *_could hypothetically_* pair it with something like [uBlock Origin.](https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/) which is also not an "ad blocker", but might make your browsing experience safer, and faster.

## Install in Firefox

1. Install Violentmonkey. [Official Firefox add-on](https://addons.mozilla.org/firefox/addon/violentmonkey/)
2. Open [Install Marketplace Local Only](https://raw.githubusercontent.com/robertely/marketplace-local-only/main/marketplace-local-only.user.js) and confirm the install in Violentmonkey.
3. Open Marketplace and select **Marketplace Local Only settings** from the Violentmonkey menu. [Facebook Marketplace](https://www.facebook.com/marketplace/)

## Settings

- **Distance tags** start yellow just beyond your Marketplace radius and turn red at twice that radius. Edit the cutoffs and colors or add your own bands.
- **Show distance within my radius** adds tags to nearby listings with a recognized location. This option starts off.
- **Hide beyond** starts at five times your radius. Change the multiplier or turn it off.
- **Hide listings labeled for shipping** starts on. Toggle it separately from the distance cutoff.
- **Hide Poshmark listings** starts on. It hides cards identified as Poshmark and shows a notice on direct Poshmark item pages.

The multipliers follow your current Marketplace radius. With a 10 mi radius, the default red band starts at 20 mi and the default hide cutoff starts beyond 50 mi.

## Distance estimates and privacy

The script reads listing labels and provider information available on Marketplace pages. It estimates straight-line distance from your Marketplace search center to the representative point of a recognized city. The lookup covers places in the 50 states, the District of Columbia, and Puerto Rico.

Designed for desktop Marketplace in English. Unrecognized cities keep 's own location text. Shipping and Poshmark detection depend on the labels and provider information  makes available.

The lookup and filtering run locally in your browser. Violentmonkey stores your settings in your browser profile.

Place coordinates come from the U.S. Census Bureau's national Places Gazetteer file. The embedded lookup normalizes place names and omits ambiguous matches. [2026 Census Gazetteer Files](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2026.html)

## Test

The browser tests run on Linux with Node.js 22 or later, Bubblewrap, Firefox at `/usr/lib/firefox/firefox`, and the signed Violentmonkey extension. They use a disposable Firefox profile and offline Marketplace fixtures.

```sh
node test-firefox.mjs
```

Pass the path to the signed Violentmonkey `.xpi` as the first argument if the runner cannot find it in a local Firefox profile.

`node test-firefox.mjs --live` opens a separate, persistent Firefox profile on a Wayland desktop. Reopening it keeps the installed script and login session. Locally installed test copies disable automatic updates from the temporary installation server, so script updates must be installed explicitly.

## License

The userscript and tests are available under the [MIT License](LICENSE).
