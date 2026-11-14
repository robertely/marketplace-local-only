import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Run with Node.js 22 or later on Linux with Firefox and Bubblewrap installed.
// Use --live to open a separate, persistent Firefox profile on a Wayland desktop.
// An optional first argument supplies a signed Violentmonkey .xpi.
const ADDON_ID = '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}';
const USER_SCRIPT = 'marketplace-local-only.user.js';
const FIREFOX = '/usr/lib/firefox/firefox';
const LOCAL_ITEM_PATH = '/marketplace/item/92/';

function findViolentmonkey() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const roots = [join(config, 'mozilla', 'firefox'), join(homedir(), '.mozilla', 'firefox')];
  const packages = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, 'extensions', `${ADDON_ID}.xpi`);
      if (existsSync(path)) packages.add(path);
    }
  }
  assert.equal(packages.size, 1, 'Pass the path to the signed Violentmonkey .xpi as the first argument.');
  return [...packages][0];
}

function sandboxArgs() {
  return [
    '--unshare-all', '--new-session', '--clearenv', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', homedir(),
    '--ro-bind', '/etc/passwd', '/etc/passwd', '--ro-bind-try', '/etc/group', '/etc/group',
    '--ro-bind-try', '/etc/hosts', '/etc/hosts', '--ro-bind-try', '/etc/fonts', '/etc/fonts',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'XDG_CONFIG_HOME', '/tmp/config',
    '--setenv', 'XDG_CACHE_HOME', '/tmp/cache', '--setenv', 'XDG_DATA_HOME', '/tmp/data',
    '--chdir', '/tmp',
  ];
}

function runIsolated(addonPath, profile = null) {
  const script = fileURLToPath(new URL(USER_SCRIPT, import.meta.url));
  const runner = fileURLToPath(import.meta.url);
  // Test control and script installation share a private loopback network.
  const result = spawnSync('/usr/bin/bwrap', [
    ...sandboxArgs(), '--die-with-parent',
    '--ro-bind', process.execPath, '/test/node', '--ro-bind', runner, '/test/test-firefox.mjs',
    '--ro-bind', script, `/test/${USER_SCRIPT}`, '--ro-bind', addonPath, '/test/violentmonkey.xpi',
    ...(profile ? ['--bind', profile, '/profile'] : []),
    '--', '/test/node', '/test/test-firefox.mjs', profile ? '--seed-live' : '--isolated',
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function openLiveFirefox(addonPath) {
  const wayland = process.env.WAYLAND_DISPLAY;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const socket = wayland && resolve(runtime, wayland);
  assert.ok(socket && statSync(socket, { throwIfNoEntry: false })?.isSocket(), 'The Wayland desktop is unavailable.');

  const data = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'marketplace-local-only');
  const profile = join(data, 'firefox-live');
  const ready = join(data, 'firefox-live-ready');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (!existsSync(ready)) {
    const status = runIsolated(addonPath || findViolentmonkey(), profile);
    if (status !== 0) {
      process.exitCode = status;
      return;
    }
    writeFileSync(ready, 'Violentmonkey and Marketplace Local Only installed\n', { mode: 0o600 });
  }

  const display = '/run/marketplace-test';
  const systemFiles = ['/etc/resolv.conf', '/etc/nsswitch.conf', '/etc/ssl/certs', '/etc/ca-certificates'];
  const logPath = join(data, 'firefox-live.log');
  const log = openSync(logPath, 'a', 0o600);
  const firefox = spawn('/usr/bin/bwrap', [
    ...sandboxArgs(), '--share-net',
    ...systemFiles.flatMap(path => ['--ro-bind-try', path, path]),
    '--bind', profile, '/profile', '--dir', display, '--chmod', '0700', display,
    '--bind', socket, `${display}/wayland-0`,
    '--setenv', 'XDG_RUNTIME_DIR', display, '--setenv', 'WAYLAND_DISPLAY', 'wayland-0',
    '--setenv', 'GDK_BACKEND', 'wayland', '--setenv', 'MOZ_ENABLE_WAYLAND', '1',
    '--', FIREFOX, '--no-remote', '--profile', '/profile', '--new-window', 'https://www.facebook.com/marketplace/',
  ], { detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  await once(firefox, 'spawn');
  firefox.unref();
  await delay(1200);
  assert.ok(firefox.exitCode === null && firefox.signalCode === null, `Firefox stopped during startup. See ${logPath}`);
  console.log(`Opened Marketplace in the visible Firefox test profile. Process ${firefox.pid}.`);
}

async function waitFor(message, read, timeout = 10000) {
  const deadline = performance.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error(message);
}

async function connect(endpoint) {
  const socket = new WebSocket(`${endpoint}/session`);
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data);
    pending.get(reply.id)?.(reply);
  });

  return {
    close: () => socket.close(),
    async send(method, params = {}) {
      const id = ++nextId;
      const reply = await new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => reject(new Error(`Firefox timed out on ${method}`)), 8000);
        pending.set(id, value => {
          clearTimeout(timer);
          resolveReply(value);
        });
        socket.send(JSON.stringify({ id, method, params }));
      }).finally(() => pending.delete(id));
      if (reply.type === 'error') throw new Error(`${method}: ${reply.message}`);
      return reply.result;
    },
  };
}

async function evaluate(browser, context, expression, awaitPromise = false) {
  const evaluation = await browser.send('script.evaluate', {
    target: { context }, expression, awaitPromise,
  });
  assert.equal(evaluation.type, 'success', evaluation.exceptionDetails?.text);
  return evaluation.result.value;
}

function fixture() {
  const cards = [
    ['arvada', 'Shipping container', 'Arvada, CO'],
    ['broomfield', 'Stereo camera', 'Broomfield, CO'],
    ['utah', 'Raspberry Pi', 'South Jordan, UT'],
    ['pennsylvania', 'Radio', 'State College, PA'],
    ['shipped', 'Laptop', 'South Jordan, UT', 'Ships to you'],
    ['unknown', 'Bike', 'Location unavailable'],
    ['outside-label', 'Tools', 'Outside your search area'],
  ];
  const location = { latitude: 39.8338, longitude: -105.1503, radius: 65 };
  const route = { url: '/marketplace/', rootView: { props: { location } } };
  return `<!doctype html><html lang="en" class="__fb-light-mode"><head><meta charset="utf-8"><title>Marketplace fixture</title>
    <script type="application/json" data-sjs>${JSON.stringify({ initialRouteInfo: { route } })}</script>
    <style>
      .price { color: #606770; }
      .price span[dir="auto"] { color: #050505; }
      .__fb-dark-mode .price span[dir="auto"] { color: #e4e6eb; }
      .price span[dir="auto"]::before { display: block; content: ""; margin-block-start: -3px; }
      .price span[dir="auto"]::after { display: block; content: ""; margin-block-end: -4px; }
    </style>
    </head><body>
    <button id="location" aria-label="Location: Arvada, Colorado">Arvada, Colorado</button>
    <main id="feed">${cards.map(([id, title, city, shipping], index) => {
      const price = id === 'broomfield' || id === 'utah'
        ? '<span style="display:flex"><span style="display:flex; gap:4px">'
          + '<span dir="auto" style="display:block; font:600 17px/20px sans-serif">$50</span>'
          + (id === 'broomfield' ? '<span style="text-decoration:line-through"><span dir="auto" style="display:block; font-size:17px">$65</span></span>' : '')
          + '</span></span>'
        : '$50';
      return `<div id="${id}" style="width: 242px; min-width: 242px; max-width: 381px; display: flex">
        <a style="width: 100%" href="/marketplace/item/${index + 1}/"><div><div></div>
          <div><div class="price" style="font-size:12px">${price}</div><div>${title}</div><div class="city">${city}</div>${shipping ? `<div>${shipping}</div>` : ''}</div>
        </div></a>
      </div>`;
    }).join('')}
    </main></body></html>`;
}

function partnerTileFixture(id, badge = '') {
  return `<div id="partner-${id}" style="min-width: 242px; max-width: 381px; display: flex">
    <a href="/marketplace/item/${id}/?ref=search"><div><div><img alt="Tripod"><span aria-hidden="true">↗</span>
      <span style="position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%)">${badge}</span></div>
      <div><div class="price">$85</div><div>Partner listing</div><div class="city">Unknown region</div></div>
    </div></a>
  </div>`;
}

function poshmarkItemFixture() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partner listing fixture</title></head>
    <body><main>
      <section id="partner-item">
        <div><img alt="Product photo of Camera case"></div>
        <div>
          <h1>Camera case</h1><div>$35</div>
          <a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fposhmark.com%2Flisting%2Ftest">See item on Poshmark</a>
          <a href="https://poshmark.com/listing/test">Buy now on Poshmark</a>
        </div>
      </section>
      <section id="recommendations">
        <a href="/marketplace/item/1/">Local recommendation</a>
        <a href="https://www.ebay.com/itm/test">Buy now on eBay</a>
      </section>
    </main></body></html>`;
}

function localItemFixture() {
  const cards = [
    ['pick-near', 'Camera', 'Broomfield, CO'],
    ['pick-distant', 'Laptop', 'South Jordan, UT'],
    ['pick-far', 'Radio', 'State College, PA'],
    ['pick-shipped', 'Phone', 'Broomfield, CO', 'Ships to you'],
    ['pick-partner', 'Tripod', 'Listed on Poshmark'],
    ['pick-unknown', 'Bike', 'Location unavailable'],
  ];
  const route = {
    url: LOCAL_ITEM_PATH,
    rootView: { props: { location: { latitude: 40.7934, longitude: -77.86, radius: 25 } } },
  };
  return `<!doctype html><html lang="en" class="__fb-light-mode"><head><meta charset="utf-8"><title>Local listing fixture</title>
    <script type="application/json" data-sjs>${JSON.stringify({ initialRouteInfo: { route } })}</script>
    </head><body><main>
      <section id="local-item">
        <div><img alt="Product photo of Bookshelf"></div>
        <div><h1>Bookshelf</h1><div class="price">$35</div>
          <div aria-label="Seller location: State College, Pennsylvania">State College, Pennsylvania</div>
        </div>
      </section>
      <section aria-labelledby="picks-heading">
        <h2 id="picks-heading">Today's picks</h2>
        <div id="picks" style="display: flex; flex-wrap: wrap">${cards.map(([id, title, label, shipping], index) => `
          <div id="${id}" style="width: 242px; min-width: 242px; max-width: 381px; display: flex">
            <a style="width: 100%" href="/marketplace/item/${101 + index}/?ref=product_details&amp;referral_code=marketplace_top_picks&amp;referral_story_type=top_picks"><div><div></div>
              <div><div class="price">$50</div><div>${title}</div><div>${label}</div>${shipping ? `<div>${shipping}</div>` : ''}</div>
            </div></a>
          </div>`).join('')}
        </div>
      </section>
    </main></body></html>`;
}

async function installScript(browser, origin) {
  const { context } = await browser.send('browsingContext.create', { type: 'tab' });
  try {
    await browser.send('browsingContext.navigate', { context, url: `${origin}/${USER_SCRIPT}`, wait: 'none' });
  } catch (error) {
    // Firefox aborts the original navigation when Violentmonkey opens its installer.
    if (!error.message.includes('NS_ERROR_ABORT')) throw error;
  }
  const installer = await waitFor('Violentmonkey did not open its installer.', async () => {
    const { contexts } = await browser.send('browsingContext.getTree', { maxDepth: 0 });
    return contexts.find(tab => tab.url.startsWith('moz-extension:') && tab.url.includes('/confirm/index.html'));
  });
  await waitFor('Violentmonkey did not show an enabled Install button.', () => evaluate(browser, installer.context, `
    (() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Install');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()
  `));
  await waitFor('Violentmonkey did not finish installing the script.', async () => {
    const { contexts } = await browser.send('browsingContext.getTree', { maxDepth: 0 });
    if (!contexts.some(tab => tab.context === installer.context && tab.url === installer.url)) return true;
    return evaluate(browser, installer.context, "document.body.innerText.includes('Script installed.')");
  });
  return new URL('/options/index.html', installer.url).href;
}

function localInstallCode(source, seedLive) {
  const endOfMetadata = source.indexOf('// ==/UserScript==');
  assert.ok(endOfMetadata > 0, 'The userscript metadata block is missing.');
  let metadata = source.slice(0, endOfMetadata).replace(/^\/\/ @(?:downloadURL|updateURL)\b[^\n]*\n/gm, '');
  if (!seedLive) {
    metadata = metadata.replace(/^\/\/ @match[^\n]*\n/gm, '') + '// @match        http://localhost/*\n';
  }
  // Prevent Violentmonkey from falling back to the temporary localhost install URL.
  return metadata + '// @downloadURL  none\n// @updateURL    none\n' + source.slice(endOfMetadata);
}

async function checkForScriptUpdate(browser, optionsUrl) {
  const { context } = await browser.send('browsingContext.create', { type: 'tab' });
  await browser.send('browsingContext.navigate', { context, url: optionsUrl, wait: 'complete' });
  const result = await evaluate(browser, context, `
    (async () => {
      const send = (cmd, data) => browser.runtime.sendMessage({ cmd, data });
      const script = await send('GetScript', { meta: {
        name: 'Facebook Marketplace Local Only', namespace: 'marketplace-local-only',
      } });
      const { id } = script.props;
      const updates = await send('CheckUpdate', { ids: [id] });
      const current = await send('GetScript', { id });
      return JSON.stringify({ installUrl: script.custom.lastInstallURL, updates,
        before: script.meta.version, after: current.meta.version });
    })()
  `, true);
  await browser.send('browsingContext.close', { context });
  return JSON.parse(result);
}

async function checkFiltering(browser, origin, optionsUrl) {
  const { context } = await browser.send('browsingContext.create', { type: 'tab' });
  await browser.send('browsingContext.navigate', { context, url: `${origin}/marketplace/`, wait: 'complete' });
  const run = expression => evaluate(browser, context, expression);
  const verifyCards = (message, badges, hidden = ['shipped'], read = run, selector = '#feed > div') => waitFor(message, () => read(`
    (() => {
      const cards = [...document.querySelectorAll(${JSON.stringify(selector)})];
      if (!cards.length) return false;
      const hidden = cards.filter(card => getComputedStyle(card).display === 'none').map(card => card.id);
      const ordinaryRows = cards.filter(card => !card.querySelector('[data-vm-marketplace-distance]'));
      if (ordinaryRows.some(card => getComputedStyle(card.querySelector('.price')).display !== 'block')) return false;
      const badges = cards.flatMap(card => [...card.querySelectorAll('[data-vm-marketplace-distance]')].map(badge => {
        const row = card.querySelector('.price');
        const price = row.querySelector('span[dir="auto"]') ?? row;
        const style = getComputedStyle(badge);
        const textBox = node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect();
        };
        const amountBox = textBox(badge.previousElementSibling ?? row.firstChild);
        const badgeBox = badge.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const priceText = textBox(price.firstChild);
        const badgeText = textBox(badge.firstChild);
        const rightAligned = badge.parentElement === row && row.lastElementChild === badge
          && badgeBox.left >= amountBox.right - 1 && Math.abs(badgeBox.right - rowBox.right) <= 1
          && Math.abs(priceText.top - badgeText.top) <= 1 && price.firstChild.textContent === '$50';
        const color = badge.getAttribute('data-vm-marketplace-distance');
        const dark = document.documentElement.classList.contains('__fb-dark-mode');
        const expectedColor = document.createElement('span');
        expectedColor.style.color = {
          inherit: getComputedStyle(price).color,
          yellow: dark ? '#ffd34d' : '#805900',
          red: dark ? '#ff6b78' : '#b42332',
        }[color] ?? color;
        return [card.id, badge.textContent, color, style.color === expectedColor.style.color, rightAligned,
          style.fontSize === getComputedStyle(price).fontSize];
      }));
      return JSON.stringify({ hidden, badges }) === ${JSON.stringify(JSON.stringify({
        hidden, badges: Object.entries(badges).map(([id, [label, color]]) => [id, label, color, true, true, true]),
      }))};
    })()
  `));
  const setRadius = radius => run(`document.querySelector('#location').setAttribute('aria-label',
    ${JSON.stringify('Location: Arvada, Colorado, Within ' + radius)})`);
  const defaultHidden = ['utah', 'pennsylvania', 'shipped'];
  await verifyCards('The default cutoff should hide listings beyond five radii and shipping listings.', {}, defaultHidden);
  const changeRouteArea = (radius, city = 'Arvada, Colorado', latitude = 39.8338, longitude = -105.1503) => run(`
    (() => {
      history.replaceState({}, '', '/marketplace/category/cameras/');
      document.querySelector('#location').setAttribute('aria-label', ${JSON.stringify('Location: ' + city)});
      const data = document.createElement('script');
      data.type = 'application/json';
      data.setAttribute('data-sjs', '');
      data.textContent = JSON.stringify({ initialRouteInfo: { route: {
        url: location.pathname,
        rootView: { props: { location: ${JSON.stringify({ latitude, longitude, radius })} } },
      } } });
      document.head.append(data);
    })()
  `);
  await changeRouteArea(130);
  await verifyCards('New route data should replace the cached 65 km radius with 130 km.', {
    utah: ['≈ 364.4 mi', 'red'],
  }, ['pennsylvania', 'shipped']);
  await changeRouteArea(10, 'Broomfield, Colorado', 39.9539, -105.0509);
  await verifyCards('A new search center should survive the simultaneous sidebar city change.', {
    arvada: ['≈ 9.8 mi', 'yellow'],
  }, defaultHidden);
  await changeRouteArea(65);
  await verifyCards('The latest route should restore the original search area.', {}, defaultHidden);
  await run(`
    const data = document.createElement('script');
    data.id = 'delayed-route';
    data.type = 'application/json';
    data.setAttribute('data-sjs', '');
    data.textContent = '{"initialRouteInfo":';
    document.head.append(data);
  `);
  await verifyCards('Incomplete route data should leave the current area intact.', {}, defaultHidden);
  const completeRoute = radius => run(`
    document.querySelector('#delayed-route').textContent = JSON.stringify({ initialRouteInfo: { route: {
      url: location.pathname,
      rootView: { props: { location: { latitude: 39.8338, longitude: -105.1503, radius: ${radius} } } },
    } } });
  `);
  await completeRoute(130);
  await verifyCards('A repaired route script should refresh the cached radius.', {
    utah: ['≈ 364.4 mi', 'red'],
  }, ['pennsylvania', 'shipped']);
  await completeRoute(65);
  await verifyCards('An edited route script should refresh the radius again.', {}, defaultHidden);
  await run(`history.replaceState({}, '', '/marketplace/');`);
  console.log('PASS route updates refresh both the search radius and its center.');
  const broomfieldKm = await run(`
    (() => {
      const rad = Math.PI / 180;
      const a = Math.sin((39.9539 - 39.8338) * rad / 2) ** 2
        + Math.cos(39.8338 * rad) * Math.cos(39.9539 * rad) * Math.sin((-105.0509 + 105.1503) * rad / 2) ** 2;
      return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
    })()
  `);
  await setRadius(`${broomfieldKm} km`);
  await verifyCards('A listing exactly at the radius should have no badge.', {}, defaultHidden);
  await setRadius('9.8 mi');
  await verifyCards('A listing just outside the radius should have a yellow badge.', {
    broomfield: ['≈ 9.8 mi', 'yellow'],
  }, defaultHidden);
  await run(`document.documentElement.className = '__fb-dark-mode'`);
  await verifyCards('The yellow preset should adapt to the dark theme.', { broomfield: ['≈ 9.8 mi', 'yellow'] }, defaultHidden);
  await run(`document.documentElement.className = '__fb-light-mode'`);
  await setRadius(`${broomfieldKm / 2} km`);
  await verifyCards('Red starts at twice the radius.', { broomfield: ['≈ 15.8 km', 'red'] }, defaultHidden);
  await setRadius(`${broomfieldKm / 5} km`);
  await verifyCards('A listing exactly at the hide cutoff should remain visible.', { broomfield: ['≈ 15.8 km', 'red'] }, defaultHidden);
  await setRadius(`${broomfieldKm / 5 - 0.001} km`);
  await verifyCards('Listings beyond the hide cutoff should have neither a tile nor a badge.', {}, ['broomfield', ...defaultHidden]);
  console.log('PASS yellow just beyond the radius, red at 2×, and hiding beyond 5×.');

  const miles = {
    utah: ['≈ 364.4 mi', 'red'], pennsylvania: ['≈ 1,433.7 mi', 'red'],
  };
  const kilometers = {
    broomfield: ['≈ 15.8 km', '#3669c7'],
    utah: ['≈ 586.5 km', 'red'], pennsylvania: ['≈ 2,307.3 km', 'red'],
  };
  await setRadius('7 mi');
  await checkSettingsMenu(browser, context, origin, optionsUrl, verifyCards, miles);

  await setRadius('10 km');
  await verifyCards('A kilometer radius should use kilometers and honor the saved color band.', kilometers);
  await setRadius('40 mi');
  await verifyCards('The wider Marketplace radius should remove the Broomfield badge.', miles);

  await run(`
    document.querySelector('#location').setAttribute('aria-label', 'Location: Arvada, Colorado');
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Change location');
    dialog.innerHTML = '<input aria-label="Location" value="Arvada, Colorado">'
      + '<label role="combobox">Radius10 kilometers</label><button aria-label="Apply">Apply</button>';
    document.body.append(dialog);
    const apply = dialog.querySelector('button');
    apply.addEventListener('click', () => dialog.remove());
    apply.click();
  `);
  await verifyCards('The radius and unit applied through the location dialog should update the badges.', kilometers);
  await setRadius('40 mi');
  await verifyCards('The wider Marketplace radius should remove the Broomfield badge after Apply.', miles);
  console.log('PASS radius changes and distance units keep the badge aligned with the price.');

  await run(`
    const card = document.querySelector('#arvada').cloneNode(true);
    card.id = 'new-card';
    card.querySelector('.city').textContent = 'South Jordan, UT';
    document.querySelector('#feed').append(card);
  `);
  await verifyCards('The dynamically loaded card should show its distance.', { ...miles, 'new-card': miles.utah });
  await run(`document.querySelector('#new-card .city').textContent = 'State College, PA'`);
  await verifyCards('A reused distant card should show one badge with its new distance.', {
    ...miles, 'new-card': miles.pennsylvania,
  });
  await run(`document.querySelector('#new-card .city').textContent = 'Golden, CO'`);
  await verifyCards('A card reused for a nearby listing should lose its distance badge.', miles);
  await run(`document.querySelector('#new-card .city').textContent = 'Location unavailable'`);
  await verifyCards('A card reused without a known city should lose its distance.', miles);
  console.log('PASS newly loaded and reused cards show the right badges.');

  await run(`history.pushState({}, '', '/marketplace/item/1/')`);
  await verifyCards('Leaving the feed should clean up its badges and hiding.', {}, []);
  await run('history.back()');
  await verifyCards('Returning to the feed should restore filtering and badges.', miles);
  console.log('PASS leaving the feed cleans up badges and returning restores them.');
  await checkHidingOwnership(run);
  await checkPacking(run);
}

async function checkSettingsMenu(browser, context, origin, optionsUrl, verifyCards, miles) {
  const url = `${origin}/marketplace/`;
  const run = expression => evaluate(browser, context, expression);
  const { context: options } = await browser.send('browsingContext.create', { type: 'tab' });
  await browser.send('browsingContext.navigate', { context: options, url: optionsUrl, wait: 'complete' });
  const { context: peer } = await browser.send('browsingContext.create', { type: 'tab' });
  await browser.send('browsingContext.navigate', { context: peer, url: `${url}?peer`, wait: 'complete' });
  const readPeer = expression => evaluate(browser, peer, expression);
  const defaultHidden = ['utah', 'pennsylvania', 'shipped'];
  await verifyCards('A second tab should start with the defaults.', {}, defaultHidden, readPeer);

  const dialogOpen = () => run(`Boolean(document.querySelector('#vm-marketplace-settings')?.shadowRoot.querySelector('dialog:modal'))`);
  const open = () => waitFor('The Violentmonkey settings command should open one modal.', async () => {
    if (await dialogOpen()) return true;
    // Send the same command as the Violentmonkey popup, from its extension page.
    await evaluate(browser, options, `
      (async () => {
        const tabs = await browser.tabs.query({});
        const tab = tabs.find(entry => entry.url === ${JSON.stringify(url)});
        const script = await browser.runtime.sendMessage({ cmd: 'GetScript', data: {
          meta: { name: 'Facebook Marketplace Local Only', namespace: 'marketplace-local-only' },
        } });
        await browser.tabs.sendMessage(tab.id, { cmd: 'Command', data: {
          id: script.props.id, key: 'marketplace-local-only-settings', evt: { type: 'click', button: 0 },
        } }, { frameId: 0 });
      })()
    `, true);
    return dialogOpen();
  });
  const form = body => run(`
    (() => {
      const root = document.querySelector('#vm-marketplace-settings').shadowRoot;
      const field = selector => root.querySelector(selector);
      ${body}
    })()
  `);
  const closed = () => waitFor('The settings dialog should close.', async () => !await dialogOpen());
  const readForm = async () => JSON.parse(await form(`
    return JSON.stringify({
      bands: [...field('#bands').children].map(row => [
        row.querySelector('.cutoff').valueAsNumber,
        row.querySelector('.preset').value === 'custom'
          ? row.querySelector('.custom-color').value : row.querySelector('.preset').value,
      ]),
      hideBeyond: field('#hide-distance').checked ? field('#hide-cutoff').valueAsNumber : null,
      hideShipping: field('#hide-shipping').checked,
      hidePartners: field('#hide-partners').checked,
      showAllDistances: field('#show-all-distances').checked,
    });
  `));
  const defaults = {
    bands: [[1, 'yellow'], [2, 'red']], hideBeyond: 5, hideShipping: true, hidePartners: true, showAllDistances: false,
  };

  const itemUrl = `${origin}${LOCAL_ITEM_PATH}`;
  const distantPick = { 'pick-distant': ['≈ 586.5 km', 'red'] };
  const hiddenPicks = ['pick-far', 'pick-shipped', 'pick-partner'];
  const verifyPicks = (message, badges, hidden) => verifyCards(message, badges, hidden, readPeer, '#picks > div');
  const verifyLocalItem = async () => assert.equal(await readPeer(`
    document.querySelector('#local-item').getClientRects().length > 0
    && document.querySelector('#local-item .price').textContent === '$35'
    && !document.querySelector('[role="status"]')
  `), true, 'Filtering recommendations should preserve the open listing.');
  await browser.send('browsingContext.navigate', { context: peer, url: itemUrl, wait: 'complete' });
  await verifyPicks('A direct item visit should filter labeled recommendations without taking its seller location as the search center.',
    {}, ['pick-shipped', 'pick-partner']);
  await verifyLocalItem();

  await open();
  await form(`field('#hide-partners').click(); field('#show-all-distances').click(); field('#save').click();`);
  await closed();
  await verifyPicks('Direct recommendations should still filter shipping with partners off and show no distance without a search center.',
    {}, ['pick-shipped']);
  await open();
  await form(`field('#restore').click(); field('#save').click();`);
  await closed();
  await readPeer(`
    const sidebar = document.createElement('aside');
    sidebar.innerHTML = '<button aria-label="Location: Arvada, Colorado, Within 130 km">Arvada, Colorado</button>';
    document.querySelector('main').before(sidebar);
  `);
  await verifyPicks('A direct item visit should use the explicit Marketplace search sidebar.', distantPick, hiddenPicks);
  await verifyLocalItem();
  await readPeer(`document.querySelector('aside button').setAttribute('aria-label', 'Location: Arvada, Colorado, Within 10 km');`);
  await verifyPicks('Changing the search radius on an open item should update its recommendations.',
    { 'pick-near': ['≈ 15.8 km', 'yellow'] }, ['pick-distant', ...hiddenPicks]);

  await browser.send('browsingContext.navigate', { context: peer, url: `${url}?peer`, wait: 'complete' });
  await readPeer(`document.querySelector('#location').setAttribute('aria-label', 'Location: Arvada, Colorado, Within 10 km');`);
  await verifyCards('The feed should use the narrow search radius before opening an item.',
    { broomfield: ['≈ 15.8 km', 'yellow'] }, defaultHidden, readPeer);
  await readPeer(`
    (() => {
      const dialog = document.createElement('section');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'Change location');
      dialog.innerHTML = '<input aria-label="Location" value="Arvada, Colorado">'
        + '<label role="combobox">Radius130 kilometers</label><button aria-label="Apply">Apply</button>';
      document.body.append(dialog);
      const apply = dialog.querySelector('button');
      apply.addEventListener('click', () => {
        const detail = new DOMParser().parseFromString(${JSON.stringify(localItemFixture())}, 'text/html');
        history.pushState({}, '', ${JSON.stringify(LOCAL_ITEM_PATH)});
        document.head.append(detail.querySelector('[data-sjs]'));
        document.body.replaceChildren(...detail.body.children);
      });
      apply.click();
    })()
  `);
  await verifyPicks('Recommendations should use the newly applied radius and keep the feed search center.', distantPick, hiddenPicks);
  await verifyLocalItem();

  await readPeer(`
    (() => {
      const lateRoute = document.createElement('script');
      lateRoute.type = 'application/json';
      lateRoute.setAttribute('data-sjs', '');
      lateRoute.textContent = JSON.stringify({ initialRouteInfo: { route: {
        url: '/marketplace/',
        rootView: { props: { location: { latitude: 39.8338, longitude: -105.1503, radius: 10 } } },
      } } });
      document.head.append(lateRoute);
      const latePick = document.querySelector('#pick-distant').cloneNode(true);
      latePick.id = 'pick-late';
      latePick.querySelector('[data-vm-marketplace-distance]').remove();
      latePick.querySelector('a').setAttribute('href',
        '/marketplace/item/107/?tracking=test&referral_story_type=top_picks&referral_code=marketplace_top_picks&ref=product_details#photo');
      document.querySelector('#picks').append(latePick);
    })()
  `);
  await verifyPicks('A late recommendation with reordered referral parameters should use the retained search area despite newly inserted feed route data.',
    { ...distantPick, 'pick-late': distantPick['pick-distant'] }, hiddenPicks);
  await readPeer(`document.querySelector('#pick-late a').setAttribute('href', '/marketplace/item/107/?ref=search');`);
  await verifyPicks('Reusing a recommendation tile for an ordinary link should remove its old distance tag.', distantPick, hiddenPicks);
  await readPeer(`document.querySelector('#pick-late').remove();`);

  await open();
  await form(`field('#hide-partners').click(); field('#save').click();`);
  await closed();
  await verifyPicks('Disabling partner hiding should preserve shipping and distance filtering.',
    distantPick, ['pick-far', 'pick-shipped']);
  await open();
  await form(`field('#hide-distance').click(); field('#hide-shipping').click(); field('#save').click();`);
  await closed();
  await verifyPicks('Disabling hiding should restore all recommendations and keep their distance tags.',
    { ...distantPick, 'pick-far': ['≈ 2,307.3 km', 'red'] }, []);
  await open();
  await form(`field('#restore').click(); field('#save').click();`);
  await closed();
  await verifyPicks('Restoring defaults should filter the recommendations again.', distantPick, hiddenPicks);
  await readPeer(`history.pushState({}, '', '/marketplace/you/');`);
  await verifyPicks('Leaving the item for an unrelated Marketplace page should clean up recommendation filters.', {}, []);
  await verifyLocalItem();
  await browser.send('browsingContext.navigate', { context: peer, url: `${url}?peer`, wait: 'complete' });
  await verifyCards('The feed should start over with its original search area and default settings.', {}, defaultHidden, readPeer);
  console.log('PASS item recommendations honor shipping, partner, and distance settings and retain the feed search area on navigation.');

  await open();
  assert.deepEqual(await readForm(), defaults);
  assert.equal(await form(`return field('#show-all-distances').labels[0].textContent.trim();`), 'Show distance within my radius');
  assert.equal(await form(`return field('#hide-partners').labels[0].textContent.trim();`), 'Hide partner listings');
  const steps = await form(`
    function stepFrom(input, value) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.stepUp();
      const increased = input.valueAsNumber;
      input.stepDown();
      return [increased, input.valueAsNumber];
    }
    return JSON.stringify([
      stepFrom(field('.cutoff'), '1'),
      stepFrom(field('.cutoff'), '1.25'),
      stepFrom(field('#hide-cutoff'), '5'),
      stepFrom(field('#hide-cutoff'), '0.055'),
    ]);
  `);
  assert.deepEqual(JSON.parse(steps), [[1.1, 1], [1.35, 1.25], [5.1, 5], [0.155, 0.055]]);
  await form(`field('#restore').click();`);
  console.log('PASS both cutoff controls step by 0.1× from whole and fractional values.');
  await form(`field('.cutoff').value = '2'; field('#save').click();`);
  assert.match(await form(`return field('#error').textContent;`), /different cutoff/);
  await form(`field('.cutoff').value = '1'; field('#hide-cutoff').value = '0'; field('#save').click();`);
  assert.match(await form(`return field('#error').textContent;`), /greater than zero/);
  await form(`field('#cancel').click();`);
  await closed();
  await verifyCards('Invalid edits and Cancel should leave the feed unchanged.', {
    broomfield: ['≈ 9.8 mi', 'yellow'],
  }, defaultHidden);

  await open();
  await form(`
    field('#hide-cutoff').value = '1.3';
    field('#hide-shipping').click();
    field('#show-all-distances').click();
    field('#save').click();
  `);
  await closed();
  const atCenter = { arvada: ['≈ 0 mi', 'inherit'] };
  await verifyCards('Showing nearby distances should include the search center and respect the hide cutoff.',
    atCenter, ['broomfield', ...defaultHidden]);

  await open();
  await form(`
    field('#hide-distance').click();
    field('#add-band').click();
    const row = field('#bands').lastElementChild;
    row.querySelector('.cutoff').value = '1.25';
    const preset = row.querySelector('.preset');
    preset.value = 'custom';
    preset.dispatchEvent(new Event('change', { bubbles: true }));
    row.querySelector('.custom-color').value = '#3669c7';
    field('#add-band').click();
    field('#bands').lastElementChild.querySelector('button').click();
    field('#save').click();
  `);
  await closed();
  const withShipping = { ...miles, shipped: miles.utah };
  const withNearby = { ...atCenter, broomfield: ['≈ 9.8 mi', 'inherit'], ...withShipping };
  await verifyCards('Saving should recolor the current badge and restore the eligible tiles.', {
    ...atCenter, broomfield: ['≈ 9.8 mi', '#3669c7'], ...withShipping,
  }, []);
  await verifyCards('Saving should add neutral distance badges to nearby listings in another tab.', withNearby, [], readPeer);
  await readPeer(`document.documentElement.className = '__fb-dark-mode'`);
  await verifyCards('Nearby badges should follow the native price color after a theme change.', withNearby, [], readPeer);

  await browser.send('browsingContext.reload', { context, wait: 'complete' });
  await verifyCards('Saved colors, hiding rules, and nearby badges should survive refresh.', withNearby, []);
  await open();
  const customized = {
    bands: [defaults.bands[0], [1.25, '#3669c7'], defaults.bands[1]],
    hideBeyond: null,
    hideShipping: false,
    hidePartners: true,
    showAllDistances: true,
  };
  assert.deepEqual(await readForm(), customized);
  await form(`field('#restore').click();`);
  assert.deepEqual(await readForm(), defaults);
  await browser.send('browsingContext.activate', { context });
  await browser.send('input.performActions', { context, actions: [{
    type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE00C' }, { type: 'keyUp', value: '\uE00C' }],
  }] });
  await closed();
  await open();
  assert.deepEqual(await readForm(), customized);
  await form(`field('#hide-shipping').click(); field('#show-all-distances').click(); field('#save').click();`);
  await closed();
  await verifyCards('Turning off nearby distances should remove their badges and apply the shipping switch.', miles);
  await verifyCards('The shipping switch should also update the second tab.', miles, ['shipped'], readPeer);

  const photoCards = partnerTileFixture('90', 'Partner listing') + partnerTileFixture('91');
  const labeledPartners = ['poshmark-label', 'ebay-label', 'partner-90'];
  await run(`
    (() => {
      const feed = document.querySelector('#feed');
      for (const [id, listingId, title, label] of [
        ['poshmark-label', 81, 'Camera case', 'Listed on Poshmark'],
        ['poshmark-data', 82, 'Tripod', 'Location unavailable'],
        ['ordinary-partner', 83, 'Camera bag', 'Location unavailable'],
        ['ordinary-title', 84, 'Poshmark tote bag', 'Location unavailable'],
        ['ebay-label', 85, 'Telephoto lens', 'Sold on eBay'],
        ['other-partner-data', 86, 'Camera flash', 'Location unavailable'],
      ]) {
        const tile = document.querySelector('#unknown').cloneNode(true);
        tile.id = id;
        tile.querySelector('a').href = '/marketplace/item/' + listingId + '/';
        const row = tile.querySelector('.city');
        row.previousElementSibling.textContent = title;
        row.textContent = label;
        feed.append(tile);
      }
      feed.insertAdjacentHTML('beforeend', ${JSON.stringify(photoCards)});
    })()
  `);
  await verifyCards('Partner filtering should hide cards with a provider label or a partner photo badge by default.',
    miles, ['shipped', ...labeledPartners]);
  await open();
  await form(`field('#hide-shipping').click(); field('#save').click();`);
  await closed();
  await verifyCards('Turning off shipping filtering should leave partner filtering enabled.', withShipping, labeledPartners);
  await browser.send('browsingContext.activate', { context });
  await evaluate(browser, context, `
    (async () => {
      const data = document.createElement('script');
      data.id = 'partner-data-fixture';
      data.type = 'application/json';
      data.setAttribute('data-sjs', '');
      data.textContent = '{"listings":';
      document.head.append(data);
      // Let the script scan the incomplete data before finishing the same node.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      data.textContent = JSON.stringify({ listings: [
        { id: '82', partner_type: 'POSHMARK' },
        { id: '83', is_partner_listing: false, partner_type: 'OTHER_PARTNER' },
        { id: '86', is_partner_listing: true, partner_type: 'OTHER_PARTNER' },
      ] });
    })()
  `, true);
  await verifyCards('Completing provider data in the same script should hide only the matching partner cards.',
    withShipping, ['poshmark-label', 'poshmark-data', 'ebay-label', 'other-partner-data', 'partner-90']);
  await run(`
    (() => {
      const data = document.querySelector('#partner-data-fixture');
      const listings = JSON.parse(data.textContent);
      listings.listings.find(listing => listing.id === '86').is_partner_listing = false;
      data.textContent = JSON.stringify(listings);
    })()
  `);
  await verifyCards('Corrected provider data should restore the matching ordinary card.',
    withShipping, ['poshmark-label', 'poshmark-data', 'ebay-label', 'partner-90']);

  await browser.send('browsingContext.navigate', { context: peer, url: `${origin}/marketplace/item/81/?ref=search`, wait: 'complete' });
  await waitFor('The direct Poshmark item should be hidden while its recommendations stay visible.', () => readPeer(`
    getComputedStyle(document.querySelector('#partner-item')).display === 'none'
    && document.querySelector('[role="status"]').textContent.startsWith('Partner listing hidden')
    && [...document.querySelectorAll('#recommendations a')].every(link => link.getClientRects().length > 0)
  `));
  await browser.send('browsingContext.activate', { context: peer });
  await evaluate(browser, peer, `
    (async () => {
      // Facebook can change the URL while the previous item is still mounted.
      history.pushState({}, '', '/marketplace/item/1/');
      document.body.setAttribute('aria-label', 'Loading another listing');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const replacement = document.createElement('section');
      replacement.id = 'ordinary-item';
      replacement.innerHTML = '<h1>Ordinary local listing</h1><div>$50</div>';
      document.querySelector('#partner-item').replaceWith(replacement);
      history.pushState({}, '', '/marketplace/');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()
  `, true);
  assert.equal(await readPeer(`document.querySelector('#recommendations a').getClientRects().length > 0`), true,
    'Navigating away from a Poshmark panel must not cache the next ordinary listing as Poshmark.');
  assert.equal(await readPeer(`document.querySelector('[role="status"]') === null`), true);
  await browser.send('browsingContext.navigate', { context: peer, url: `${origin}/marketplace/item/81/?ref=search`, wait: 'complete' });
  await waitFor('The actual Poshmark item should still be hidden after the navigation regression.', () => readPeer(`
    getComputedStyle(document.querySelector('#partner-item')).display === 'none'
  `));
  console.log('PASS a stale Poshmark panel cannot poison the next listing ID.');
  await readPeer(`
    for (const link of document.querySelectorAll('#partner-item a, #recommendations a[href^="/marketplace/item/"]')) link.remove();
  `);
  await waitFor('A checkout in the recommendations must not hide the ordinary item or its recommendations.', () => readPeer(`
    document.querySelector('#partner-item').getClientRects().length > 0
    && document.querySelector('#recommendations a[href^="https://www.ebay.com/"]').getClientRects().length > 0
    && !document.querySelector('[role="status"]')
  `));
  await browser.send('browsingContext.reload', { context: peer, wait: 'complete' });
  await waitFor('Reloading the partner item should restore its checkout and filtering.', () => readPeer(`
    getComputedStyle(document.querySelector('#partner-item')).display === 'none'
  `));
  console.log('PASS a recommendation checkout does not hide the ordinary item beside it.');
  await open();
  assert.equal((await readForm()).hidePartners, true);
  await form(`field('#hide-partners').click(); field('#hide-shipping').click(); field('#save').click();`);
  await closed();
  await verifyCards('Disabling the partner switch should restore all its cards.', miles);
  await waitFor('Disabling the switch should restore the open item detail in the other tab.', () => readPeer(`
    document.querySelector('#partner-item').getClientRects().length > 0 && !document.querySelector('[role="status"]')
  `));
  await browser.send('browsingContext.reload', { context, wait: 'complete' });
  await browser.send('browsingContext.activate', { context });
  await open();
  assert.equal((await readForm()).hidePartners, false, 'Partner filtering should stay off after refresh.');
  await form(`field('#cancel').click();`);
  await closed();
  await evaluate(browser, context, `
    (async () => {
      document.querySelector('#feed').insertAdjacentHTML('beforeend', ${JSON.stringify(photoCards)});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()
  `, true);
  assert.equal(await run(`document.querySelector('#partner-90').getClientRects().length > 0`), true);
  await browser.send('browsingContext.close', { context: peer });
  await browser.send('browsingContext.close', { context: options });
  console.log('PASS nearby distances default to off, match the native price color, and persist when enabled.');
  console.log('PASS the Violentmonkey menu, custom bands, validation, Cancel and Escape, persistence, and cross-tab updates.');
  console.log('PASS partner filtering hides marked cards and the direct item, preserves ordinary listings, and stays off after refresh.');
}

async function checkHidingOwnership(run) {
  assert.equal(await run(`
    document.querySelector('#shipped').style.display = 'grid';
    getComputedStyle(document.querySelector('#shipped')).display === 'none'
  `), true, 'Native inline style changes must not reveal a filtered listing.');
  await run(`document.querySelector('#shipped .city + div').remove()`);
  await waitFor('A restored tile should retain Facebook\'s latest display value.', () => run(`
    getComputedStyle(document.querySelector('#shipped')).display === 'grid'
    && document.querySelector('#shipped').style.display === 'grid'
  `));
  await run(`
    (() => {
      const label = document.createElement('div');
      label.textContent = 'Ships to you';
      document.querySelector('#shipped .city').after(label);
    })()
  `);
  await waitFor('Restoring the shipping label should hide the tile again.', () => run(`
    getComputedStyle(document.querySelector('#shipped')).display === 'none'
  `));
  await run(`
    document.querySelector('#shipped').style.display = 'none';
    document.querySelector('#shipped .city + div').remove();
  `);
  await waitFor('The shipping badge should return after removing its shipping label.', () => run(`
    Boolean(document.querySelector('#shipped [data-vm-marketplace-distance]'))
  `));
  assert.equal(await run(`getComputedStyle(document.querySelector('#shipped')).display === 'none'`), true,
    'Removing a filter must preserve a tile that Facebook itself has hidden.');
  await run(`
    (() => {
      document.querySelector('#shipped').style.display = 'flex';
      const label = document.createElement('div');
      label.textContent = 'Ships to you';
      document.querySelector('#shipped .city').after(label);
    })()
  `);
  await waitFor('The shipping tile should be filtered before the layout tests.', () => run(`
    getComputedStyle(document.querySelector('#shipped')).display === 'none'
  `));
  console.log('PASS filtering survives native display changes and restores the latest native style.');
}

async function checkPacking(run) {
  await run(`
    (() => {
      const feed = document.querySelector('#feed');
      Object.assign(feed.style, { display: 'flex', flexWrap: 'wrap', width: '780px' });
      const shipped = document.querySelector('#shipped');
      shipped.removeAttribute('style');
      shipped.classList.add('packing-native-tile');
      const style = document.createElement('style');
      style.textContent = '.packing-native-tile { display: flex; min-width: 242px; max-width: 381px; }';
      document.querySelector('#utah').before(style, shipped);
    })()
  `);
  await waitFor('A shipping tile sized by a stylesheet should leave the flex row.', () => run(`
    (() => {
      const left = document.querySelector('#broomfield').getBoundingClientRect();
      const right = document.querySelector('#utah').getBoundingClientRect();
      return document.querySelector('#shipped').getClientRects().length === 0
        && left.top === right.top && left.right === right.left;
    })()
  `));

  await run(`
    (() => {
      const feed = document.querySelector('#feed');
      const card = id => {
        const tile = document.getElementById(id).cloneNode(true);
        tile.style.display = 'flex';
        tile.style.minWidth = '242px';
        tile.style.maxWidth = '381px';
        tile.style.removeProperty('width');
        tile.style.flex = '1 1 0px';
        tile.querySelector('a > div > div').style.height = '40vh';
        return tile.outerHTML;
      };
      const filler = '<div style="min-width:242px; max-width:381px"><div></div></div>';
      const batch = (cards, header = '', id = '') => '<div style="max-width:1872px"><div>' + header
        + '</div><div id="' + id + '" style="display:flex; flex-wrap:wrap">'
        + cards + filler + '</div></div>';
      feed.style.removeProperty('display');
      feed.style.removeProperty('flex-wrap');
      feed.innerHTML = batch(card('arvada') + card('shipped') + card('broomfield'))
        + batch('<div style="min-width:726px; max-width:1143px"><div style="display:none"></div></div>')
        + batch(card('utah') + card('pennsylvania') + card('unknown'), '', 'packing-batch')
        + batch(card('outside-label'), '<h2 id="packing-heading">More listings</h2>')
        + batch('<div id="loading-marker" style="height:22px" aria-label="Loading"></div>');
    })()
  `);
  const verifyRows = expected => waitFor('Visible listings should pack in order across batches.', () => run(`
    (() => {
      const feed = document.querySelector('#feed');
      const rows = new Map();
      for (const card of feed.querySelectorAll('div[id][style*="min-width:"]')) {
        if (card.getClientRects().length === 0) continue;
        const y = card.getBoundingClientRect().y;
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push(card.id);
      }
      const heading = document.querySelector('#packing-heading').getBoundingClientRect();
      const other = document.querySelector('#outside-label').getBoundingClientRect();
      const marker = document.querySelector('#loading-marker').getBoundingClientRect();
      return getComputedStyle(feed).display === 'grid'
        && !document.querySelector('#shipped').getClientRects().length
        && JSON.stringify([...rows.values()]) === ${JSON.stringify(JSON.stringify(expected))}
        && heading.bottom <= other.top + 1 && other.bottom <= marker.top + 1
        && marker.width === feed.clientWidth && marker.height === 22;
    })()
  `));
  await verifyRows([['arvada', 'broomfield', 'utah'], ['pennsylvania', 'unknown'], ['outside-label']]);

  await run(`
    (() => {
      const source = document.querySelector('#packing-batch').parentElement;
      for (const hiddenPart of ['batch', 'grid']) {
        const batch = source.cloneNode(true);
        for (const child of batch.querySelectorAll('[id]')) child.removeAttribute('id');
        batch.id = 'native-hidden-' + hiddenPart;
        const tile = batch.lastElementChild.lastElementChild.previousElementSibling;
        tile.id = 'native-hidden-' + hiddenPart + '-card';
        tile.querySelector('a').href = '/marketplace/item/93/';
        batch.lastElementChild.replaceChildren(tile);
        (hiddenPart === 'batch' ? batch : batch.lastElementChild).style.display = 'none';
        source.after(batch);
      }
      const style = document.createElement('style');
      style.textContent = '.native-collapsed { display: none; }';
      document.head.append(style);
    })()
  `);
  await verifyRows([['arvada', 'broomfield', 'utah'], ['pennsylvania', 'unknown'], ['outside-label']]);
  for (const part of ['batch', 'grid']) {
    assert.equal(await run(`document.querySelector('#native-hidden-${part}-card').getClientRects().length`), 0,
      'Packing must not reveal a batch or grid Facebook already hid.');
  }
  await run(`document.querySelector('#packing-batch').parentElement.classList.add('native-collapsed')`);
  await waitFor('A native class should hide an already packed batch.', () => run(`
    document.querySelector('#utah').getClientRects().length === 0
  `));
  await run(`document.querySelector('#packing-batch').parentElement.classList.remove('native-collapsed')`);
  await verifyRows([['arvada', 'broomfield', 'utah'], ['pennsylvania', 'unknown'], ['outside-label']]);
  await run(`document.querySelector('#packing-batch').style.display = 'none'`);
  await waitFor('A native inline style should hide an already packed grid.', () => run(`
    document.querySelector('#utah').getClientRects().length === 0
  `));
  await run(`document.querySelector('#packing-batch').style.display = 'flex'`);
  await verifyRows([['arvada', 'broomfield', 'utah'], ['pennsylvania', 'unknown'], ['outside-label']]);
  await run(`document.querySelector('#native-hidden-batch').remove(); document.querySelector('#native-hidden-grid').remove();`);
  console.log('PASS packing preserves initially hidden sections and follows native class and style changes.');

  await run(`
    (() => {
      const marker = document.querySelector('#loading-marker');
      if (marker.getBoundingClientRect().top < innerHeight) throw new Error('The marker should start below the viewport.');
      const observer = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const previous = document.querySelector('#packing-batch').parentElement;
        const next = previous.cloneNode(true);
        const tile = next.querySelector('#unknown');
        tile.id = 'loaded-card';
        tile.querySelector('a').href = '/marketplace/item/42/';
        next.lastElementChild.removeAttribute('id');
        next.lastElementChild.replaceChildren(tile);
        previous.after(next);
      });
      observer.observe(marker);
      marker.scrollIntoView();
    })()
  `);
  await verifyRows([['arvada', 'broomfield', 'utah'], ['pennsylvania', 'unknown', 'loaded-card'], ['outside-label']]);
  await run(`document.querySelector('#feed').style.width = '510px'`);
  await verifyRows([['arvada', 'broomfield'], ['utah', 'pennsylvania'], ['unknown', 'loaded-card'], ['outside-label']]);

  await run(`document.querySelector('#shipped .city + div').remove()`);
  await waitFor('When the last shipping card is restored, the original layout should return.', () => run(`
    getComputedStyle(document.querySelector('#feed')).display === 'block'
    && getComputedStyle(document.querySelector('#shipped')).display === 'flex'
    && getComputedStyle(document.querySelector('#packing-batch')).display === 'flex'
  `));
  console.log('PASS visible cards fill gaps across batches at both widths. Headings and the loading marker keep their own rows.');
}

async function testFirefox(seedLive) {
  const source = await readFile(`/test/${USER_SCRIPT}`, 'utf8');
  let code = localInstallCode(source, seedLive);
  let scriptRequests = 0;
  const unexpectedItemRequests = [];
  const pages = new Map([
    ['/marketplace/', fixture],
    ['/marketplace/item/81/', poshmarkItemFixture],
    [LOCAL_ITEM_PATH, localItemFixture],
  ]);
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0];
    if (request.url === `/${USER_SCRIPT}`) {
      scriptRequests++;
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(code);
    } else if (pages.has(path)) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'",
      });
      response.end(pages.get(path)());
    } else {
      if (path.startsWith('/marketplace/item/')) unexpectedItemRequests.push(path);
      response.writeHead(404).end();
    }
  });
  const profile = seedLive ? '/profile' : await mkdtemp('/tmp/marketplace-firefox-');
  let firefox;
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://localhost:${server.address().port}`;
    firefox = spawn(FIREFOX, [
      '--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0', 'about:blank',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Firefox requires this for its extension installer tab. The whole session is isolated above.
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    });
    let output = '';
    const append = chunk => { output = (output + chunk).slice(-4000); };
    firefox.stdout.on('data', append);
    firefox.stderr.on('data', append);
    firefox.on('error', error => append(error.message));
    const endpoint = await waitFor('Firefox did not start its test connection.', () => {
      if (firefox.exitCode !== null) throw new Error(`Firefox stopped during startup.\n${output}`);
      return /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(output)?.[1];
    });
    browser = await connect(endpoint);
    const session = await browser.send('session.new', { capabilities: { alwaysMatch: {} } });
    assert.equal(session.capabilities['moz:profile'], profile);
    const { extension } = await browser.send('webExtension.install', {
      extensionData: { type: 'archivePath', path: '/test/violentmonkey.xpi' }, 'moz:permanent': true,
    });
    assert.equal(extension, ADDON_ID);
    console.log(`Firefox ${session.capabilities.browserVersion} started with Violentmonkey.`);
    const optionsUrl = await installScript(browser, origin);
    if (seedLive) {
      await browser.send('browser.close');
      await waitFor('Firefox did not close the prepared profile.', () => firefox.exitCode !== null);
      assert.equal(firefox.exitCode, 0);
      console.log('Installed Marketplace Local Only in the visible test profile.');
    } else {
      // Simulate another process serving a higher version at the old install URL.
      code = code.replace(/^\/\/ @version[^\n]*/m, '// @version      999999.0.0');
      const requestsAfterInstall = scriptRequests;
      const update = await checkForScriptUpdate(browser, optionsUrl);
      assert.equal(update.installUrl, `${origin}/${USER_SCRIPT}`);
      assert.equal(scriptRequests, requestsAfterInstall, 'An update check requested the temporary install URL.');
      assert.equal(update.updates, 0);
      assert.equal(update.after, update.before);
      console.log('PASS Violentmonkey skips the temporary install URL during an update check.');
      await checkFiltering(browser, origin, optionsUrl);
      assert.deepEqual(unexpectedItemRequests, [], 'Partner filtering must not request listing detail pages.');
    }
  } finally {
    browser?.close();
    if (firefox?.exitCode === null && firefox.signalCode === null) {
      firefox.kill();
      await once(firefox, 'exit', { signal: AbortSignal.timeout(5000) }).catch(() => firefox.kill('SIGKILL'));
    }
    server.closeAllConnections();
    server.close();
  }
}

const mode = process.argv[2];
if (mode === '--isolated' || mode === '--seed-live') {
  assert.equal(process.execPath, '/test/node');
  await testFirefox(mode === '--seed-live');
} else if (mode === '--live') {
  await openLiveFirefox(process.argv[3] && resolve(process.argv[3]));
} else {
  process.exitCode = runIsolated(mode ? resolve(mode) : findViolentmonkey());
}
