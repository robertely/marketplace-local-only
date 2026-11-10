# Marketplace Local Only

A Violentmonkey userscript for TheFaceBook Marketplace. The location and shipping filters in Marketplace are more of a suggestion than a rule. This userscript warns you about items outside your search radius and optionally hides them entirely. Not so much a complete overhaul as "just make it work the way it says it does."

I've allowed TheFaceBook a little grace here by showing visible distance warnings. I think a little fuzzy matching here is OK, but by default it hides posts more than 5x the search radius, because if my filter is 10 miles, I'm probably not stretching my range to 868.1 miles.

<img width="2297" height="1182" alt="A screenshot of facebook marketplace with textual warnings about listings that exceed the filter distance." src="https://github.com/user-attachments/assets/64499357-f438-4db5-a685-83a9d795db50" />

It also hides eBay, Poshmark, and listings labeled for shipping by default. This is not an "ad-blocker", but one *_could hypothetically_* pair it with something like [uBlock Origin.](https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/) which is also not an "ad blocker", but might make your browsing experience safer, and faster.

## Install in Firefox

1. Install Violentmonkey. [Official Firefox add-on](https://addons.mozilla.org/firefox/addon/violentmonkey/)
2. Open [Install Marketplace Local Only](https://raw.githubusercontent.com/robertely/marketplace-local-only/main/marketplace-local-only.user.js) and confirm the install in Violentmonkey.
3. Open Marketplace and select **Marketplace Local Only settings** from the Violentmonkey menu. [Facebook Marketplace](https://www.facebook.com/marketplace/)

## Settings

Defaults follow your Marketplace radius:

- **Distance tags:** yellow over 1x; red from 2x. Edit colors and cutoffs.
- **Show distance within my radius:** off.
- **Hide beyond:** over 5x. Change the cutoff or disable it.
- **Hide listings labeled for shipping:** on.
- **Hide partner listings:** on. Includes eBay, Poshmark, and other marked partners.

## Distance estimates and privacy

Designed for desktop Marketplace in English.

Distances are straight-line estimates from your search center to city coordinates. The [Census lookup](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2026.html) covers the 50 states, DC, and Puerto Rico. Unknown cities keep their location text and get no distance tag.

Shipping and partner filtering depend on TheFacebook's labels and data. Filtering runs locally; Violentmonkey stores settings in your browser.

## Developer tests (Linux)

Requires Linux, Node.js 22+, Bubblewrap, Firefox at `/usr/lib/firefox/firefox`, and signed Violentmonkey.

```sh
node test-firefox.mjs        # Offline tests in a disposable profile
node test-firefox.mjs --live # Persistent test profile on Wayland
```

Optionally pass the signed `.xpi` path as the first argument.

Live mode uses a separate profile and preserves login. Install script updates manually.

## License

[MIT](LICENSE).
