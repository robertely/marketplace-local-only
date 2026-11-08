# Marketplace Local Only

A Violentmonkey userscript for Facebook Marketplace. See estimated distance beside the price and filter listings by shipping, distance, and Poshmark.

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

Designed for desktop Marketplace in English. Unrecognized cities keep Facebook's own location text. Shipping and Poshmark detection depend on the labels and provider information Facebook makes available.

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
