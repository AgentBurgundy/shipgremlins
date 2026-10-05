/** Fixed browser program. Private inputs arrive on stdin, never Docker arguments. */
export const ENVIRONMENT_PROBE = String.raw`
const { chromium } = require('/opt/gremlins/node_modules/playwright');
(async () => {
  let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 196608) throw Error(); }
  const input = JSON.parse(raw); raw = '';
  const origin = new URL(input.url).origin;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const checks = []; let screenshot; let stage = 'open';
  try {
    const accounts = input.access?.accounts ?? [null];
    for (let index = 0; index < accounts.length; index++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(30000);
      await context.route('**/*', async route => {
        const request = route.request(); const same = new URL(request.url()).origin === origin;
        // Test credentials cannot be submitted to another origin, including redirect targets.
        if (!same && (request.isNavigationRequest() || !['GET','HEAD','OPTIONS'].includes(request.method()))) return route.abort();
        const headers = { ...request.headers() }; delete headers['x-vercel-protection-bypass'];
        if (same && (input.bypass || request.isNavigationRequest() || !['GET','HEAD','OPTIONS'].includes(request.method()))) {
          if (input.bypass) headers['x-vercel-protection-bypass'] = input.bypass;
          // continue({headers}) can inherit headers across a redirect. Fetch one
          // hop only; the browser's next request must pass the origin check again.
          const response = await route.fetch({ headers, maxRedirects: 0, timeout: 30000 });
          const destination = response.headers()['location'];
          if (response.status() >= 300 && response.status() < 400 && destination && new URL(destination, request.url()).origin !== origin) return route.abort();
          return route.fulfill({ response });
        }
        return route.continue({ headers });
      });
      stage = 'open';
      const response = await page.goto(input.url, { waitUntil: 'domcontentloaded' });
      if (!response || response.status() >= 400 || new URL(page.url()).origin !== origin) throw Error();
      checks.push({ name: 'Browser opens application', passed: true });
      if (accounts[index]) {
        stage = 'login';
        const login = new URL(input.access.loginPath, input.url);
        if (login.origin !== origin) throw Error();
        await page.goto(login.href, { waitUntil: 'domcontentloaded' });
        await page.locator(input.access.usernameSelector).fill(accounts[index].username);
        await page.locator(input.access.passwordSelector).fill(accounts[index].password);
        await page.locator(input.access.submitSelector).click();
        await page.locator(input.access.successSelector).waitFor({ state: 'visible' });
        if (new URL(page.url()).origin !== origin || await page.locator(input.access.passwordSelector).isVisible().catch(() => false)) throw Error();
        checks.push({ name: 'Test account ' + (index + 1) + ' signs in', passed: true });
      }
      // Mask entered credentials wherever rendered before producing a private screenshot.
      const secrets = accounts.filter(Boolean).flatMap(a => [a.username, a.password]);
      await page.evaluate(values => {
        for (const el of document.querySelectorAll('input,textarea')) el.style.visibility = 'hidden';
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) { const node = walker.currentNode; for (const value of values) if (value && node.textContent.includes(value)) node.textContent = node.textContent.split(value).join('[private]'); }
      }, secrets);
      screenshot = (await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' })).toString('base64');
      await context.close();
    }
    process.stdout.write(JSON.stringify({ ok: true, checks, screenshot }));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, checks, stage })); process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(() => { process.exitCode = 1; });
`;
