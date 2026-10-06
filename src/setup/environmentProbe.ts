/** Fixed browser program. Private inputs arrive on stdin, never Docker arguments. */
export const ENVIRONMENT_PROBE = String.raw`
const { chromium } = require('/opt/gremlins/node_modules/playwright');
const { installBrowserAccess } = require('/opt/gremlins/browser-access.mjs');
(async () => {
  let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 196608) throw Error(); }
  const input = JSON.parse(raw); raw = '';
  const origin = new URL(input.url).origin;
  const checks = []; let browser, screenshot, currentCheck, routeFailure;
  let diagnosis = { code: 'browser_unavailable' }, stage = 'open', ok = false;
  const fail = (code, extra = {}) => { diagnosis = { code, ...extra }; throw Error('probe'); };
  const protectedUrl = value => {
    try { const u = new URL(value); return u.protocol === 'https:' && ['vercel.com','www.vercel.com'].includes(u.hostname) && /^\/(sso-api|login|auth)(\/|$)/.test(u.pathname); } catch { return false; }
  };
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const accounts = input.access?.accounts ?? [null];
    for (let index = 0; index < accounts.length; index++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(30000);
      let submitted = false, rejected = false;
      const redirected = destination => { routeFailure = input.vercel && protectedUrl(destination) ? 'vercel_protection' : stage === 'login' ? 'login_external_redirect' : 'external_redirect'; };
      await installBrowserAccess(page, {
        url: input.url, bypass: input.bypass || '', restrictLogin: true,
        onBlocked: (destination, navigation, mainFrame) => { if (navigation && mainFrame) redirected(destination); },
      });
      page.on('response', response => {
        try {
          const request = response.request();
          if (submitted && new URL(request.url()).origin === origin && !['GET','HEAD','OPTIONS'].includes(request.method()) && [400,401,403].includes(response.status())) rejected = true;
        } catch { /* An incomplete response is not evidence of rejected credentials. */ }
      });
      const open = async (url, login) => {
        let response;
        try { response = await page.goto(url, { waitUntil: 'domcontentloaded' }); } catch { fail(routeFailure || 'environment_unreachable'); }
        if (routeFailure) fail(routeFailure);
        if (!response) fail('environment_unreachable');
        if (new URL(page.url()).origin !== origin) fail(login ? 'login_external_redirect' : 'external_redirect');
        if (response.status() >= 400) {
          // HTTP status alone cannot distinguish app authorization from Vercel protection.
          const wall = input.vercel && [401,403].includes(response.status()) && await page.evaluate(() => {
            if (!/^(Authentication Required|Vercel Authentication)$/i.test(document.title.trim())) return false;
            return [...document.querySelectorAll('a[href]')].slice(0,100).some(a => {
              try { const u = new URL(a.href); return u.protocol === 'https:' && ['vercel.com','www.vercel.com'].includes(u.hostname) && /^\/(sso-api|login|auth)(\/|$)/.test(u.pathname); } catch { return false; }
            });
          }).catch(() => false);
          fail(wall ? 'vercel_protection' : login ? 'login_http_error' : 'application_http_error');
        }
        checks.push({ name: currentCheck, passed: true }); currentCheck = undefined;
      };
      const control = async (field, label, action) => {
        currentCheck = 'Test account ' + (index + 1) + ': ' + label;
        let locator;
        try {
          locator = page.locator(input.access[field]);
          await locator.waitFor({ state: 'visible' });
          const count = await locator.count();
          if (count !== 1) fail(count > 1 ? 'selector_ambiguous' : 'selector_not_found', { field, matchCount: Math.min(count,10000) });
          if (action) await action(locator);
        } catch {
          if (routeFailure) fail(routeFailure);
          if (field === 'successSelector' && rejected) {
            const invalid = await page.evaluate(() => [...document.querySelectorAll('[role="alert"],[aria-live="assertive"]')].slice(0,10).some(el => {
              if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false;
              return /^(invalid (email or password|username or password|credentials)|incorrect (email or password|username or password|password)|wrong password)[.!]?$/i.test((el.textContent || '').slice(0,256).trim());
            })).catch(() => false);
            fail(invalid ? 'login_credentials_rejected' : 'login_rejected');
          }
          const count = await locator?.count().catch(() => undefined);
          const extra = { field, ...(Number.isSafeInteger(count) ? { matchCount: Math.min(count,10000) } : {}) };
          if (count > 1) fail('selector_ambiguous', extra);
          if (field === 'successSelector') fail(count === 0 ? 'success_not_found' : 'success_not_visible', extra);
          fail(count === 0 ? 'selector_not_found' : 'selector_unusable', extra);
        }
        checks.push({ name: currentCheck, passed: true }); currentCheck = undefined;
        return locator;
      };
      routeFailure = undefined; stage = 'open'; currentCheck = 'Browser opens application';
      await open(input.url, false);
      if (accounts[index]) {
        stage = 'login'; currentCheck = 'Test account ' + (index + 1) + ': login page opens';
        const login = new URL(input.access.loginPath, input.url);
        if (login.origin !== origin) fail('login_external_redirect');
        await open(login.href, true);
        await control('usernameSelector', 'username field', locator => locator.fill(accounts[index].username));
        await control('passwordSelector', 'password field', locator => locator.fill(accounts[index].password));
        await control('submitSelector', 'submit control', locator => { submitted = true; return locator.click(); });
        const confirmation = await control('successSelector', 'signed-in confirmation');
        currentCheck = 'Test account ' + (index + 1) + ' signs in';
        if (routeFailure) fail(routeFailure);
        if (new URL(page.url()).origin !== origin) fail('login_external_redirect');
        // Auth state can update before an animated login dialog finishes closing.
        // Wait for that transition rather than sampling visibility once.
        try { await page.locator(input.access.passwordSelector).waitFor({ state: 'hidden', timeout: 15000 }); }
        catch { fail(routeFailure || 'login_incomplete', { field: 'successSelector' }); }
        if (routeFailure) fail(routeFailure);
        if (new URL(page.url()).origin !== origin) fail('login_external_redirect');
        // The initial success marker must still be present after the form closes.
        const count = await confirmation.count().catch(() => 0);
        if (count > 1) fail('selector_ambiguous', { field: 'successSelector', matchCount: Math.min(count,10000) });
        if (count === 0) fail('success_not_found', { field: 'successSelector', matchCount: 0 });
        if (!await confirmation.isVisible().catch(() => false)) fail('success_not_visible', { field: 'successSelector', matchCount: 1 });
        checks.push({ name: currentCheck, passed: true }); currentCheck = undefined;
      }
      diagnosis = { code: 'invalid_evidence' };
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
    ok = true;
  } catch {
    if (currentCheck) checks.push({ name: currentCheck, passed: false });
  } finally {
    try { await browser?.close(); } catch { ok = false; diagnosis = { code: 'cleanup_pending' }; }
  }
  process.stdout.write(JSON.stringify(ok ? { ok, checks, screenshot } : { ok, checks, stage, diagnosis }));
  if (!ok) process.exitCode = 1;
})().catch(() => { process.stdout.write(JSON.stringify({ ok: false, checks: [], diagnosis: { code: 'browser_unavailable' } })); process.exitCode = 1; });
`;
