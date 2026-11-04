// JANUS Cloud agent core (v5: parallel sub-agents, shared browser with one tab per agent, extensions): portable (Cloudflare Worker + GitHub runner + Node test harness).
// ctx = { llm (router), browser() -> puppeteer Browser, logins: {get(site), list()}, images: {put, get}, now(),
//         optional: runCode, install, fs:{write,read,list}, testWebApp, progress(info) -> {cancel, inbox}, cookies, saveCookies }
import { makeRouter, firstJsonCall as _fjc, GEMINI_MODELS as _GM } from './router.js';
export const GEMINI_MODELS = _GM;
export const firstJsonCall = (t) => _fjc(t, TOOLS);

const S = (o) => JSON.stringify(o);
const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');

export const TOOLS = [
  { name: 'web_search', description: 'Search the web. Returns top results with snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_url', description: 'Read a web page as plain text (fast, no browser).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'generate_image', description: 'Create an image from a prompt. Returns image_id (shown to the user; usable with upload_image).', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'open_url', description: 'Open a URL in the cloud browser. Returns title + numbered elements.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'list_elements', description: 'List numbered interactive elements of the current page.', parameters: { type: 'object', properties: {} } },
  { name: 'click_element', description: 'Click element by number.', parameters: { type: 'object', properties: { element_id: { type: 'integer' } }, required: ['element_id'] } },
  { name: 'type_into', description: 'Type normal text into element (never passwords/OTP).', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, text: { type: 'string' }, press_enter: { type: 'boolean' } }, required: ['element_id', 'text'] } },
  { name: 'select_option', description: 'Choose an option in a dropdown element.', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, option: { type: 'string' } }, required: ['element_id', 'option'] } },
  { name: 'scroll_page', description: 'Scroll down or up.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } } } },
  { name: 'read_page', description: 'Read visible text of the current page.', parameters: { type: 'object', properties: {} } },
  { name: 'look_at_screen', description: 'Screenshot the current page; returns a precise description of what is visible.', parameters: { type: 'object', properties: { question: { type: 'string', description: 'what you want to check on the screen' } } } },
  { name: 'sign_in', description: 'Sign in on the current page with the saved login for this site (or the saved Google login on accounts.google.com): fills email/username + password and presses the sign-in button. You never see the password. Call when a login form is visible (call again on a second password page).', parameters: { type: 'object', properties: {} } },
  { name: 'upload_image', description: 'Put a generated image or a file from run_code (its id) into a file-upload element.', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, image_id: { type: 'string' } }, required: ['element_id', 'image_id'] } },
  { name: 'write_file', description: 'Create or overwrite a text file in the work folder (code, html, json, md…). path is relative, e.g. "game/index.html". Write COMPLETE files, never placeholders. Big files (more than ~150 lines): write them in parts — the first call creates the file, the next calls use append=true with the following part (each part ≤ ~150 lines), in order. Long single calls get cut off by the AI provider.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] } },
  { name: 'read_file', description: 'Read a text file from the work folder (first 20000 chars), or list a folder when path ends with "/".', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_code', description: 'Run code on the cloud computer (Linux, Python 3, Node 20, Java 17, Android SDK, Gradle; internet on; pip install --user / npm i allowed; no sudo). Use for builds, tests, data work, image/video editing (Pillow, ffmpeg). Files saved at the TOP LEVEL of the work folder come back to the user as files. Input images are in ./inputs/<image_id>.<ext>.', parameters: { type: 'object', properties: { language: { type: 'string', enum: ['python', 'node', 'bash'] }, code: { type: 'string' }, timeout_sec: { type: 'integer' } }, required: ['language', 'code'] } },
  { name: 'install_packages', description: 'Install Ubuntu (apt) packages on the cloud computer, e.g. ["ffmpeg","imagemagick"]. pip/npm packages: install them inside run_code instead.', parameters: { type: 'object', properties: { apt: { type: 'array', items: { type: 'string' } } }, required: ['apt'] } },
  { name: 'test_web_app', description: 'SELF-TEST a web app/game you built: opens it in headless Chromium on a phone screen (412x915, touch), presses start, swipes/taps, takes screenshots over ~10 s, records JS errors, alert() calls and how much of the screen the game uses, then a vision reviewer critiques it against the quality checklist. Use after every build and after every fix (at least 2 rounds for games). path = html file in the work folder.', parameters: { type: 'object', properties: { path: { type: 'string' }, focus: { type: 'string', description: 'what to look at this round' } }, required: ['path'] } },
  { name: 'spawn_agents', description: 'Run up to 10 sub-agents AT THE SAME TIME, each on one independent part of the job (compare 5 shops, research 6 topics, check several sites, gather facts in parallel). Each sub-agent has web_search/read_url and, when browser=true, its own browser tab (max 6 tabs at once; the rest wait for a free tab). They return short summaries; you then merge them into one answer. Use it when the job splits into 2–10 independent parts; do not use it for one simple step. task = complete self-contained instructions for that part.', parameters: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, task: { type: 'string' }, browser: { type: 'boolean' } }, required: ['task'] } } }, required: ['tasks'] } },
  { name: 'finish', description: 'The task is done (or truly impossible). result = the final short answer for the user in their language.', parameters: { type: 'object', properties: { result: { type: 'string' }, success: { type: 'boolean' } }, required: ['result', 'success'] } },
];
const RUNNER_ONLY = ['run_code', 'install_packages', 'write_file', 'read_file', 'test_web_app'];
const BROWSER = ['open_url', 'list_elements', 'click_element', 'type_into', 'select_option', 'scroll_page', 'read_page', 'look_at_screen', 'sign_in', 'upload_image'];

const MARK_JS = `(() => {
  document.querySelectorAll('[data-jn]').forEach(e => e.removeAttribute('data-jn'));
  const sel = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=option],[role=textbox],[role=combobox],[role=switch],[contenteditable=true],[contenteditable=""],label[for]';
  const out = []; let i = 0;
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
    const fileIn = e.tagName === 'INPUT' && e.type === 'file';
    if (!fileIn && (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none')) continue;
    if (!fileIn && (r.bottom < 0 || r.top > innerHeight * 2.5)) continue;
    e.setAttribute('data-jn', ++i);
    const t = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.getAttribute('aria-placeholder') || e.getAttribute('data-placeholder') || e.title || e.name || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
    const tag = e.tagName.toLowerCase() + (e.type ? ':' + e.type : '');
    out.push(i + ' ' + tag + ' "' + t + '"');
    if (i >= 120) break;
  }
  return out.join('\\n');
})()`;

export function siteKey(u) {
  const s = String(u || '').trim(); if (!s) return '';
  let h; try { h = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  const p = h.split('.');
  if (p.length <= 2 || /^\d+$/.test(p[p.length - 1])) return h;
  const sl = p[p.length - 2];
  return (p[p.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu|gen|firm|ind)$/.test(sl)) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

export async function webSearch(q) {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' } });
  const h = await r.text(); const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m; while ((m = re.exec(h)) && out.length < 6) {
    let u = m[1]; const g = /uddg=([^&]+)/.exec(u); if (g) u = decodeURIComponent(g[1]);
    out.push({ title: m[2].replace(/<[^>]+>/g, ''), url: u, snippet: m[3].replace(/<[^>]+>/g, '') });
  }
  return out;
}

export async function readUrl(u) {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36' }, redirect: 'follow' });
  const h = await r.text();
  return clip(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(), 6000);
}

const SITE_TIPS = `Site tips: For any image the task needs, ALWAYS use generate_image (it is free and returns an image_id). If the task says to make the image on Bing Image Creator, Leonardo, Canva or another generator website, do NOT open that site (it needs a Microsoft/other account and downloads don't work here): silently use generate_image instead, which gives the same kind of image, and continue with the rest of the task. Never fail a task just because of the image site. Pinterest: first open https://www.pinterest.com/login/ and call sign_in (skip if already logged in: the page then redirects away from /login), then open https://www.pinterest.com/pin-creation-tool/ (if it redirects to the home page you are NOT logged in). On that page: upload_image into the "input:file" element (Upload your media; JPG/PNG up to 20MB, MP4 up to 200MB) → wait/list_elements until the image preview shows → type the title into "Tell everyone what your Pin is about" / "Add a title" → type the description into "Describe your Pin" / "Add a detailed description" (it is a text box, click it then type) → optional: link, "Choose a board" → click the red "Publish" button (it appears at the top only after the image is uploaded) → confirm with read_page that Pinterest says it was published / shows the new pin. If a "Save draft"/"Publish" choice appears, choose Publish. Instagram/Facebook/X posting from a browser often needs the app or 2FA; if blocked, finish with the reason.`;

const GOOGLE_TIP = ` Google sign-in: if a site needs a login and its own login is NOT in the saved list but google.com IS, use the site's "Continue with Google" / "Sign in with Google" button, then on accounts.google.com call sign_in (email page, then call sign_in again on the password page). If Google shows "This browser or app may not be secure", a captcha or asks for phone approval, you cannot pass it from the cloud: say so plainly and ask the user to share that site's own email+password login in JANUS → Settings → Cloud → Logins.`;

// Hark-level behaviour, shared by chat jobs, scheduled tasks and cloud computer jobs.
export const CORE_RULES = `HOW YOU WORK
- Answer first. Short, clear, in the user's language (Hinglish if they write Hinglish). No fluff, no "Great question", no long intros, no step lists unless asked. Use Markdown only when it helps.
- Plan → act → verify. For any multi-step task make a short plan in your head, do it step by step with tools, and CHECK the result (read the page, run the code, test the app) before you say it is done.
- Never fake success. Say "done" only when your own steps prove it (page shows it was posted, build produced the file, test passed). If something failed, say exactly what failed and what the user can do.
- Never promise abilities you do not have, and never promise to do something later unless a schedule exists. Never invent where a setting, code or account lives. If unsure, say you are unsure.
- Use the whole step budget on long tasks: keep working until the task is really finished. Never ask the user to say "continue", never stop half-way to report progress.
- No placeholders: complete production-quality code, real data, every file in full.
- Security: you never see or ask for passwords, OTP codes, API keys or card numbers. Logins happen only through sign_in (saved logins). Never type secrets yourself, never print them, never put them in files.
- Never buy, pay, delete accounts or publish publicly unless the user clearly asked for exactly that.`;

const GAME_PLAYBOOK = `QUALITY PLAYBOOK for web apps & games (follow every point):
- Phone-first, portrait, FULLSCREEN: <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">, html/body margin 0, overflow hidden, 100dvh; the canvas fills window.innerWidth × innerHeight (resize listener, devicePixelRatio scaling). No fixed 16:9 canvas, no black bars, no scrollbars.
- Controls built for touch: swipe gestures (touchstart/touchmove/touchend with a threshold ~30px) for left/right/jump/slide, tap where it makes sense; keyboard arrows/WASD also work on desktop. No tiny on-screen arrow buttons as the main control.
- Screens: a real START screen (title, short how-to-play, big Play button), an in-game pause/menu button, and a GAME-OVER screen drawn in the page (score, best score in localStorage, Retry and Menu buttons). NEVER use alert(), confirm() or prompt().
- Feel: smooth requestAnimationFrame loop with delta time, difficulty that ramps up (speed/spawn rate grow over time), score + coins/HUD with safe-area padding, juicy feedback (particles, screen shake, flashes), sound effects made with the Web Audio API (no external files) plus a mute toggle, vibration on hit (navigator.vibrate) when available.
- Look: a real character and world (drawn shapes with gradients, outlines, shadows, simple animation; pseudo-3D perspective with Canvas 2D for 3D runners: lanes converging to a horizon, objects scaled by depth), consistent colour palette, readable fonts. Never a plain blob or bare rectangles on a flat background. Prefer plain Canvas 2D (fast on every phone, works offline); use a CDN library (three.js) only when truly needed and handle it failing to load.
- Robust: no console errors, works offline from one index.html (inline CSS/JS) unless the user asked for more files; handle visibilitychange (pause), resize and orientation.`;

const SELFTEST = `SELF-TEST LOOP (mandatory for anything visual you build: games, web apps, pages):
1) write the files (ALWAYS in parts of at most 150 lines per write_file call: first part normally, the rest with append=true — long single calls get cut off) → 2) test_web_app(path) → 3) read the critique + errors + screen-usage numbers → 4) fix every real problem with write_file → 5) test_web_app again. Do at least 2 full polish rounds for a game; keep going while the reviewer finds real problems, but at most 5 rounds — once there are no JS errors and the big issues are fixed, finish. Ignore □ boxes where emoji should be (the test machine has no emoji font; phones show them). If you package it as an Android app (WebView wrapper APK), test the web part first, then build.`;

const JOB_TIPS = `CLOUD COMPUTER: you have a full Ubuntu machine: write_file/read_file, run_code (bash/python/node, up to ~50 min per call), install_packages (apt), internet, Java 17 (JAVA_HOME), Android SDK (ANDROID_HOME, platforms + build-tools), Gradle, Python 3, Node 20, headless Chromium (test_web_app). Work like a senior engineer: plan, write files, run, read errors, fix, repeat until it truly works.
- Android app: complete Gradle project (AGP + Gradle wrapper or a pinned distribution), ./gradlew assembleDebug --no-daemon, then COPY the .apk to the TOP LEVEL of the work folder (cp app/build/outputs/apk/debug/app-debug.apk ./MyApp.apk). For a game, a WebView wrapper around your tested index.html (fullscreen, portrait, immersive) is fine and fast.
- Deliverables (apk, zip, pdf, images, video, html) MUST be at the top level of the work folder; zip source code (zip -r project.zip project) when you wrote code.
- Finish with a short Hinglish summary: what you built, how to use it, anything that did not work.`;

const isBuild = (t) => /\b(game|games|app|apk|website|web ?site|webpage|landing page|html|ui|dashboard|calculator|todo|portfolio|khel|banao|bana do|build|code|script|program|bot)\b/i.test(t);
const isGame = (t) => /\b(game|games|khel|runner|shooter|puzzle|arcade|snake|flappy|tetris|racing|platformer)\b/i.test(t);
export const isCodeTask = (t) => /\b(code|coding|program|script|function|bug|debug|fix|refactor|app|apk|game|website|html|css|javascript|python|java|kotlin|react|api|build|compile|gradle)\b/i.test(t);

function sysPrompt(task, nowIso, loginSites, opts) {
  const lg = loginSites && loginSites.length ? loginSites.join(', ') : 'NONE';
  const mode = opts.chat ? `You are JANUS, the user's personal AI, running on JANUS Cloud (a real cloud computer that keeps working while the user's phone is off). You are answering the user's latest chat message. Simple questions: just answer (no tools needed). Anything that needs facts, the web, a website, files, code or building: use tools and finish the job.`
    : `You are JANUS Cloud, the background worker of the JANUS app. You run a task by yourself while the user's phone may be off, so nobody can answer questions: decide sensibly and finish.`;
  return `${mode}
Now: ${nowIso} (user timezone Asia/Kolkata).
${CORE_RULES}
TOOLS: web_search/read_url for facts (cite sources as [1] with URLs when you use them); the cloud browser (open_url, list_elements, click/type by element number, look_at_screen to check); sign_in for login forms; generate_image for pictures; spawn_agents to run up to 10 sub-agents in parallel when the job splits into independent parts (research many items, compare shops/sites), then merge their summaries.
Saved logins you can use with sign_in: ${lg}. If the task needs a site whose login is not in this list (and Google is not usable for it), do not guess: say exactly "<site> ka login cloud mein share nahi hai. JANUS → Settings → Cloud → Logins mein Share dabao." Saved browser cookies may already keep you logged in, so open the site first and check.
If a site needs an OTP/captcha/approval you cannot do, stop and say what is needed.
${opts.chat ? 'When done, reply with the final answer as plain text (or call finish). Keep it short: the result, plus files/links if any.' : 'Never stop silently: every reply must call a tool, and the last one must be finish(result) in the user\'s language.'}
${SITE_TIPS}${GOOGLE_TIP}${opts.job || opts.chat ? '\n' + JOB_TIPS : ''}${isBuild(task) ? '\n' + GAME_PLAYBOOK + '\n' + SELFTEST : ''}
${opts.chat ? '' : 'TASK: ' + task}`;
}


/** Shared cloud browser: one Chromium per job, one page (tab) per agent. Extensions (userscripts) run on every page. */
export async function sharedBrowser(ctx) { if (!ctx._browser) ctx._browser = Promise.resolve(ctx.browser()); return ctx._browser; }
export async function newPage(ctx) {
  const b = await sharedBrowser(ctx); const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
  if (ctx.cookies && ctx.cookies.length && !ctx._cookiesSet) { ctx._cookiesSet = true; try { const c = await page.createCDPSession(); await c.send('Network.setCookies', { cookies: ctx.cookies }); } catch { } }
  for (const e of ctx.extensions || []) { if (e && e.enabled !== false && e.code) { try { await page.evaluateOnNewDocument(e.code); } catch { } } }
  return page;
}
const settle = async (p) => { try { await p.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }); } catch { } };
/** Browser tools bound to one page (main agent and every sub-agent get their own). info = {task, step()} */
export function pageTools(ctx, getPage, info) {
  const el = async (id) => { const p = await getPage(); const h = await p.$(`[data-jn="${id}"]`); if (!h) throw new Error('element ' + id + ' not found; call list_elements'); return h; };
  return {
    open_url: async ({ url }) => { const p = await getPage(); await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await settle(p); return 'Title: ' + (await p.title()) + '\nURL: ' + p.url() + '\n' + (await p.evaluate(MARK_JS)); },
    list_elements: async () => { const p = await getPage(); return 'URL: ' + p.url() + '\n' + (await p.evaluate(MARK_JS)); },
    click_element: async ({ element_id }) => { const h = await el(element_id); const p = await getPage(); await h.evaluate(e => e.scrollIntoView({ block: 'center' })); await h.click(); await settle(p); return 'clicked. URL: ' + p.url() + '\n' + (await p.evaluate(MARK_JS)); },
    type_into: async ({ element_id, text, press_enter }) => {
      const h = await el(element_id); const typ = await h.evaluate(e => (e.type || '').toLowerCase());
      if (typ === 'password') return 'refused: use sign_in for passwords';
      await h.click({ clickCount: 3 }); await h.type(String(text), { delay: 10 });
      if (press_enter) { const p = await getPage(); await p.keyboard.press('Enter'); await settle(p); }
      return 'typed';
    },
    select_option: async ({ element_id, option }) => { const h = await el(element_id); const ok = await h.evaluate((e, o) => { const op = [...(e.options || [])].find(x => x.text.trim().toLowerCase() === o.toLowerCase() || x.value === o) || [...(e.options || [])].find(x => x.text.toLowerCase().includes(o.toLowerCase())); if (!op) return false; e.value = op.value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; }, String(option)); return ok ? 'selected' : 'option not found'; },
    scroll_page: async ({ direction }) => { const p = await getPage(); await p.evaluate(d => scrollBy(0, (d === 'up' ? -1 : 1) * innerHeight * 0.85), direction || 'down'); return await p.evaluate(MARK_JS); },
    read_page: async () => { const p = await getPage(); return clip(await p.evaluate(() => document.body.innerText), 6000); },
    sign_in: async () => {
      const p = await getPage(); const site = siteKey(p.url()); const cred = await ctx.logins.get(site);
      if (!cred) return 'No saved login for ' + site + '. Ask the user (in finish) to add it in JANUS → Settings → Cloud → Logins.';
      const r = await p.evaluate((u, pw) => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
        const set = (e, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); e.focus(); d.set.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
        const pass = [...document.querySelectorAll('input[type=password]')].find(vis);
        const user = [...document.querySelectorAll('input[type=email],input[autocomplete=username],input[name*=user i],input[name*=email i],input[id*=email i],input[type=text],input[type=tel]')].find(vis);
        let did = [];
        if (user && !user.value) { set(user, u); did.push('username'); }
        if (pass) { set(pass, pw); did.push('password'); }
        return did.join('+');
      }, cred.username, cred.password);
      if (!r) return 'No login field found on this page (open the site\'s sign-in form first, e.g. click "Log in").';
      const how = await p.evaluate(() => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
        const f = [...document.querySelectorAll('input[type=password],input[type=email],input[type=text]')].find(vis);
        const form = f && f.form;
        const btn = (form ? [...form.querySelectorAll('button,input[type=submit],[role=button]')] : [...document.querySelectorAll('button,input[type=submit],[role=button]')]).filter(vis)
          .find(b => /log ?in|sign ?in|next|continue|submit|aage|लॉग/i.test(b.innerText || b.value || b.getAttribute('aria-label') || '') || b.type === 'submit');
        if (btn) { btn.click(); return 'clicked ' + ((btn.innerText || btn.value || '').trim().slice(0, 30) || 'submit'); }
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'submitted form'; }
        return '';
      });
      if (!how) await p.keyboard.press('Enter');
      const before = p.url();
      try { await p.waitForNavigation({ timeout: 8000 }); } catch { }
      await settle(p); await new Promise(z => setTimeout(z, 1500));
      let st = null; for (let k = 0; k < 4 && !st; k++) { try { st = await p.evaluate(() => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
        const pw = [...document.querySelectorAll('input[type=password]')].some(vis);
        const txt = document.body.innerText || '';
        const lines = txt.split('\n').map(x => x.trim()).filter(x => x && x.length < 220);
        const bad = /(incorrect|wrong|doesn.t belong|not belong|no account|couldn.t find|isn.t right|not right|invalid|doesn.t match|try again|too many|captcha|robot|suspicious|unusual|blocked|locked|confirm it.s you|verify it.s you)/i;
        const err = lines.find(x => bad.test(x)) || '';
        const errEl = [...document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-live=polite],[class*=error i],[id*=error i]')].filter(vis).map(e => String(e.innerText || e.textContent || '').trim()).filter(x => x && x.length < 220)[0] || '';
        const otp = [...document.querySelectorAll('input[autocomplete=one-time-code],input[name*=code i],input[id*=code i],input[inputmode=numeric]')].some(vis);
        return { pw, otp, err: (errEl || err).slice(0, 200), url: location.href };
      }); } catch { await new Promise(z => setTimeout(z, 2000)); } }
      if (!st) return 'Login submitted but the page kept reloading. Call list_elements to check if you are logged in.';
      const onLogin = /log.?in|sign.?in|signin|auth/i.test(new URL(st.url).pathname);
      if (st.otp && !st.pw) return 'LOGIN NEEDS A CODE on ' + site + ': the site asks for a verification code (sent to the user\'s email/phone). You cannot get it. finish(success=false, "' + site + ' ne verification code maanga. Phone pe ek baar ' + site + ' mein login karke approve karo, phir JANUS → Settings → Scheduled → Run now dabao").';
      if (st.err && (st.pw || onLogin)) return 'LOGIN FAILED on ' + site + ': page says "' + st.err + '". Do not retry more than once. If it is about password/email → finish(success=false, "' + site + ' ka saved password galat hai, JANUS → Settings → Cloud → Logins mein sahi login dobara Share karo"). If it is a code/captcha/verification → finish(success=false) asking the user to log in once on their phone and approve.';
      if (st.pw && /password/.test(r) ) return 'LOGIN NOT CONFIRMED: still on a page with a password box (' + st.url + '). Call look_at_screen to see why (error, captcha, extra step).';
      if (st.pw && !/password/.test(r)) return 'Filled ' + r + ' and pressed ' + (how || 'Enter') + '. Now a password page is shown: call sign_in again.';
      return 'LOGIN OK: ' + site + ' accepted the sign-in. Now on: ' + st.url + (st.url === before ? ' (same URL; verify with list_elements that you are logged in)' : '');
    },
    upload_image: async ({ element_id, image_id }) => {
      const img = await ctx.images.get(image_id); if (!img) throw new Error('unknown image_id');
      const h = await el(element_id); const b64 = btoaBytes(img.bytes);
      const ok = await h.evaluate((e, b, mime) => {
        const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const ext = mime.includes('png') ? 'png' : mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'jpg'; const f = new File([u], 'janus.' + ext, { type: mime });
        const dt = new DataTransfer(); dt.items.add(f);
        let inp = e.tagName === 'INPUT' && e.type === 'file' ? e : (e.querySelector('input[type=file]') || document.querySelector('input[type=file]'));
        if (inp) { inp.files = dt.files; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); return 'input'; }
        e.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt })); return 'drop';
      }, b64, img.mime);
      const p = await getPage(); await settle(p); await new Promise(z => setTimeout(z, 2500));
      return 'image put into the page via ' + ok + '. Check the page shows the image now (if not, try another file input or look_at_screen):\n' + (await p.evaluate(MARK_JS));
    },
    look_at_screen: async ({ question }) => {
      const p = await getPage(); const b64 = await p.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64' });
      if (ctx.progress) { try { await ctx.progress({ label: 'Looking at the page', step: info.step(), shot: b64 }); } catch { } }
      try { // every brain can "see": the vision route turns the screenshot into precise text
        const r = await ctx.llm([{ role: 'user', parts: [{ text: 'You are the eyes of a web agent. Task: ' + clip(info.task, 600) + '\n' + (question ? 'Question: ' + question + '\n' : '') + 'Describe this screenshot precisely: page/site, main headings, visible buttons and fields (with their labels), messages/errors/popups, whether the user looks logged in, and anything blocking (captcha, cookie banner, login wall). Max 180 words.' }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }], [], { route: 'vision', timeoutMs: 90000 });
        return 'SCREEN (' + p.url() + '): ' + (r.parts || []).map(x => x.text || '').join('').trim();
      } catch (e) { return 'Screenshot taken but could not be described (' + clip(String(e.message), 80) + '). Use read_page / list_elements instead.\nURL: ' + p.url(); }
    },
  };
}

// ---------------- Parallel sub-agents (orchestrator) ----------------
export const SUB_MAX = 10, SUB_PAGES = 6;
const SUB_TOOLS = ['web_search', 'read_url', 'open_url', 'list_elements', 'click_element', 'type_into', 'select_option', 'scroll_page', 'read_page', 'look_at_screen', 'sign_in', 'finish'];
const subLabel = (n, a) => ({ web_search: 'Searching “' + clip(a.query || '', 36) + '”', read_url: 'Reading ' + host(a.url), open_url: 'Opening ' + host(a.url), list_elements: 'Reading the page', click_element: 'Clicking', type_into: 'Typing', select_option: 'Choosing', scroll_page: 'Scrolling', read_page: 'Reading the page', look_at_screen: 'Looking', sign_in: 'Signing in' })[n] || 'Working';
/** list = [{title, task, browser}] → runs all at once (≤10), each with its own tool loop and (if needed) its own page. */
export async function runSubAgents(ctx, list, parent = {}) {
  const items = (Array.isArray(list) ? list : []).filter(x => x && (x.task || x.title)).slice(0, SUB_MAX);
  if (!items.length) return 'No sub-tasks given. Pass tasks: [{title, task}].';
  const state = items.map(x => ({ t: clip(String(x.title || x.task), 48), s: 'queued', l: '' }));
  let free = ctx.browser ? (ctx.subPages || SUB_PAGES) : 0, cancelled = false; const waiters = [];
  const acquire = async () => { while (free <= 0) await new Promise(r => waiters.push(r)); free--; };
  const release = () => { free++; const w = waiters.shift(); if (w) w(); };
  let lastPush = 0;
  const push = async (force) => {
    if (!parent.progress || (!force && Date.now() - lastPush < 1500)) return; lastPush = Date.now();
    const done = state.filter(s => s.s === 'done' || s.s === 'fail').length;
    const r = await parent.progress({ label: items.length + ' agents working · ' + done + ' done', step: parent.step ? parent.step() : 0, agents: state });
    if (r && r.cancel) cancelled = true;
  };
  const one = async (x, i) => {
    const task = String(x.task || x.title);
    const wantsBrowser = x.browser === true || (x.browser !== false && /https?:\/\/|website|\bsite\b|\bopen\b|log ?in|sign ?in|\bbook\b|\bfill\b|\bclick\b|browser|kholo/i.test(task));
    let page = null, gotPage = false;
    if (wantsBrowser && ctx.browser) { state[i].l = 'waiting for a free browser tab'; await push(); await acquire(); gotPage = true; }
    state[i].s = 'run'; state[i].l = 'starting'; await push();
    const getPage = async () => { if (!page) page = await newPage(ctx); return page; };
    const tools = TOOLS.filter(t => SUB_TOOLS.includes(t.name) && (gotPage || !BROWSER.includes(t.name)));
    const impl = { web_search: async ({ query }) => S(await webSearch(query)), read_url: async ({ url }) => await readUrl(url), ...(gotPage ? pageTools(ctx, getPage, { task, step: () => 0 }) : {}) };
    const system = `You are sub-agent ${i + 1} of ${items.length}, working for JANUS on ONE part of a bigger job. Do only your part, quickly: use tools, then call finish(result, success) with a compact factual summary (max 12 lines; include the URLs, prices and numbers you found). Nobody can answer questions. Never type passwords (logins only via sign_in). Answer in the language of the task.\nPARENT JOB (context only): ${clip(String(parent.task || ''), 600)}\nYOUR PART: ${task}`;
    const contents = [{ role: 'user', parts: [{ text: 'Do your part now.' }] }];
    let result = null;
    try {
      for (let k = 0; k < (x.steps || 14) && !result; k++) {
        if (cancelled) { result = { ok: false, result: 'Stopped.' }; break; }
        const r = await ctx.llm(contents, tools, { route: gotPage ? 'main' : 'fast', system, timeoutMs: 240000, spread: i + 1, maxTokens: 4096 });
        const parts = (r.parts || []).filter(p => p.text || p.functionCall); if (!parts.length) parts.push({ text: '' });
        contents.push({ role: 'model', parts });
        const calls = parts.filter(p => p.functionCall);
        if (!calls.length) { const t = parts.map(p => p.text || '').join('').trim(); if (t) { result = { ok: true, result: t }; break; } contents.push({ role: 'user', parts: [{ text: 'Call a tool, or finish(result).' }] }); continue; }
        const outs = [];
        for (const c of calls) {
          const { name, args = {} } = c.functionCall;
          if (name === 'finish') { result = { ok: args.success !== false, result: String(args.result || '') }; break; }
          state[i].l = subLabel(name, args); await push();
          let out; try { const f = impl[name]; if (!f) throw new Error('this tool is not available to sub-agents'); out = await f(args); if (out && typeof out === 'object') out = out.text; } catch (e) { out = 'ERROR: ' + (e && e.message || e); }
          outs.push({ functionResponse: { name, response: { result: clip(String(out), 6000) } } });
        }
        if (!result && outs.length) contents.push({ role: 'user', parts: outs });
        if (contents.length > 24) for (const c of contents.slice(1, -8)) c.parts = (c.parts || []).map(p => p.functionResponse ? { functionResponse: { ...p.functionResponse, response: { result: clip(String(p.functionResponse.response.result || ''), 500) } } } : p);
      }
      if (!result) result = { ok: false, result: 'Step limit reached before finishing.' };
    } catch (e) { result = { ok: false, result: 'Failed: ' + clip(String(e && e.message || e), 160) }; }
    finally { if (page) { try { await page.close(); } catch { } } if (gotPage) release(); }
    state[i].s = result.ok ? 'done' : 'fail'; state[i].l = clip(String(result.result || '').replace(/\s+/g, ' '), 90); await push(true);
    return { title: state[i].t, ok: result.ok, result: clip(String(result.result || ''), 2000) };
  };
  const out = await Promise.all(items.map(one));
  return S({ agents: out, note: 'All sub-agents finished. Merge their results into one clear answer (or continue the job with them).' });
}

export async function runAgent(ctx, task, opts = {}) {
  const maxSteps = opts.maxSteps || 25;
  const steps = []; const images = []; const files = [];
  let page = null;
  const getPage = async () => { if (!page) page = await newPage(ctx); return page; };

  const impl = {
    web_search: async ({ query }) => S(await webSearch(query)),
    read_url: async ({ url }) => await readUrl(url),
    generate_image: async ({ prompt }) => {
      let b = null, mime = 'image/jpeg';
      for (const g of [ctx.genImage, ctx.genImage2]) { if (b || !g) continue; try { const o = await g(prompt); if (o && o.bytes && o.bytes.length > 2000) { b = o.bytes; mime = o.mime; } } catch (e) { } }
      if (!b) {
        const pl = prompt.toLowerCase(); const [w, h] = /pin|pinterest|wallpaper|portrait|vertical|story|reel|9:16|poster|phone/.test(pl) ? [1024, 1536] : /landscape|wide|banner|16:9|desktop|youtube|thumbnail/.test(pl) ? [1536, 864] : [1024, 1024];
        let r;
        for (let k = 0; k < 3; k++) {
          r = await fetch('https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt.slice(0, 900)) + '?width=' + w + '&height=' + h + '&nologo=true&enhance=true&seed=' + Math.floor(Math.random() * 1e6));
          if (r.ok) break;
          const t = await r.text().catch(() => ''); const wait = +((/Retry after (\d+)s/.exec(t) || [])[1] || 0);
          if (!(r.status === 402 || r.status === 429) || k === 2) throw new Error('image service busy (' + r.status + '), try generate_image again in a minute');
          await new Promise(z => setTimeout(z, Math.min(Math.max(wait, 5), 60) * 1000 + 1000));
        }
        b = new Uint8Array(await r.arrayBuffer()); mime = r.headers.get('content-type') || 'image/jpeg';
      }
      const id = await ctx.images.put(b, mime); images.push(id); return S({ image_id: id, bytes: b.length });
    },
    ...pageTools(ctx, getPage, { task, step: () => stepNo }),
    spawn_agents: async ({ tasks }) => { await progress({ label: 'Starting ' + Math.min((tasks || []).length, SUB_MAX) + ' agents', step: stepNo }); return runSubAgents(ctx, tasks, { task, progress, step: () => stepNo }); },
    run_code: async ({ language, code, timeout_sec }) => {
      if (!ctx.runCode) return 'run_code is not available on this runner (only on the GitHub runner).';
      const r = await ctx.runCode(language, String(code || ''), Math.min(Math.max(+timeout_sec || 120, 10), ctx.maxCodeSecs || 600), images);
      for (const f of r.files || []) { if (f.mime.startsWith('image/')) images.push(f.id); else files.push(f.id); }
      return 'exit ' + r.code + '\n' + clip(r.out || '', 5000) + (r.files && r.files.length ? '\nFILES: ' + r.files.map(f => f.name + ' → ' + f.id + ' (' + f.mime + ', ' + f.bytes + ' bytes)').join(', ') : '');
    },
    install_packages: async ({ apt }) => {
      if (!ctx.install) return 'Installing packages is only possible on the GitHub runner.';
      const names = (Array.isArray(apt) ? apt : [apt]).map(String).filter(n => /^[a-z0-9][a-z0-9+.\-]{0,80}$/.test(n)).slice(0, 30);
      if (!names.length) return 'No valid package names.';
      return await ctx.install(names);
    },
    write_file: async ({ path, content, append }) => { if (!ctx.fs) return 'write_file is only available on the cloud computer.'; const r = await ctx.fs.write(String(path || ''), String(content ?? ''), !!append); if (r.file) files.push(r.file.id); return r.msg; },
    read_file: async ({ path }) => { if (!ctx.fs) return 'read_file is only available on the cloud computer.'; return clip(await ctx.fs.read(String(path || '')), 20000); },
    test_web_app: async ({ path, focus }) => {
      if (!ctx.testWebApp) return 'test_web_app is only available on the cloud computer.';
      const r = await ctx.testWebApp(String(path || 'index.html'), String(focus || ''), task);
      if (r.shotId) { lastShot = r.shotId; }
      tests.push({ errors: r.errors ? r.errors.length : 0, verdict: r.verdict || '' });
      if (r.shotB64 && ctx.progress) { try { await ctx.progress({ label: 'Testing on a phone screen', step: stepNo, shot: r.shotB64 }); } catch { } }
      return r.text;
    },
  };

  const label = (name, a) => ({ web_search: 'Searching “' + clip(a.query || '', 40) + '”', read_url: 'Reading ' + host(a.url), generate_image: 'Creating an image', open_url: 'Opening ' + host(a.url), list_elements: 'Reading the page', click_element: 'Clicking', type_into: 'Typing', select_option: 'Choosing an option', scroll_page: 'Scrolling', read_page: 'Reading the page', look_at_screen: 'Looking at the page', sign_in: 'Signing in', upload_image: 'Uploading', write_file: 'Writing ' + clip(String(a.path || 'a file'), 40), read_file: 'Reading ' + clip(String(a.path || 'a file'), 40), spawn_agents: 'Starting parallel agents', run_code: 'Running code', install_packages: 'Installing tools', test_web_app: 'Testing on a phone screen', finish: 'Checking the result' })[name] || 'Working';
  const t0 = ctx.now(); let stepNo = opts.state ? (opts.state.stepNo || 0) : 0; let lastShot = null; const tests = []; let lastShotAt = 0;
  const progress = async (info) => { if (!ctx.progress) return null; try { return await ctx.progress(info); } catch { return null; } };
  const loginSites = ctx.logins.list ? await ctx.logins.list() : [];
  const system = sysPrompt(task, new Date(ctx.now()).toISOString(), loginSites, opts);
  const route = opts.route || (isCodeTask(task) && (opts.job || opts.chat) ? 'code' : 'main');
  let contents;
  if (opts.state && Array.isArray(opts.state.contents)) {
    contents = opts.state.contents;
    contents.push({ role: 'user', parts: [{ text: '[JANUS: the job moved to a fresh cloud computer to keep going. Your work folder was restored (files you wrote are still there), but the browser was closed and installed apt packages are gone (reinstall if needed). Continue the same task from where you stopped; do not redo finished steps.]' }] });
    (opts.state.images || []).forEach(x => images.push(x)); (opts.state.files || []).forEach(x => files.push(x)); (opts.state.steps || []).forEach(x => steps.push(x));
  } else if (opts.chat) {
    contents = [];
    for (const m of (opts.chat.history || []).slice(-24)) { const t = clip(String(m.text || ''), 6000); if (!t) continue; contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: t }] }); }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    const parts = [{ text: task || 'See the attached image.' }]; for (const im of (opts.chat.images || []).slice(0, 4)) parts.push({ inlineData: { mimeType: im.mime || 'image/jpeg', data: im.b64 } });
    if (contents.length && contents[contents.length - 1].role === 'user') contents.push({ role: 'model', parts: [{ text: '…' }] });
    contents.push({ role: 'user', parts });
  } else contents = [{ role: 'user', parts: [{ text: 'Do the task now.' }] }];
  const hasImg = contents.some(c => (c.parts || []).some(p => p.inlineData));
  let result = null, nudges = 0, checks = 0, cont = null, cutHint = false, hintNow = false, llmFails = 0;
  const tools = TOOLS.filter(t => (ctx.runCode || !RUNNER_ONLY.includes(t.name)) && (t.name !== 'write_file' || ctx.fs) && (t.name !== 'test_web_app' || ctx.testWebApp));
  try {
    for (let i = 0; i < maxSteps && !result; i++) {
      if (opts.budgetMs && ctx.now() - t0 > opts.budgetMs) { cont = true; break; }
      if (contents.length > 40) { // keep long jobs lean: old screenshots out, old tool outputs short
        for (const c of contents.slice(1, -12)) { if (c._c) continue; c._c = 1; c.parts = (c.parts || []).filter(p => !p.inlineData || c === contents[contents.length - 1]).map(p => p.functionResponse ? { functionResponse: { ...p.functionResponse, response: { result: clip(String(p.functionResponse.response?.result || ''), 700) } } } : (p.functionCall && p.functionCall.name === 'write_file') ? { functionCall: { name: 'write_file', args: { path: p.functionCall.args.path, content: '(written, ' + String(p.functionCall.args.content || '').length + ' chars; read_file to see it)' } } } : p); if (!c.parts.length) c.parts = [{ text: '(old screenshot removed)' }]; }
      }
      let resp;
      try { resp = await ctx.llm(contents, tools, { route: i === 0 && hasImg ? 'vision' : route, system, timeoutMs: 600000 }); llmFails = 0; }
      catch (e) { // every free model busy: wait and retry this step instead of throwing the whole job away
        if (++llmFails <= 3 && !(opts.budgetMs && ctx.now() - t0 > opts.budgetMs)) { await progress({ label: 'AI models are busy, waiting a minute', step: stepNo }); await new Promise(z => setTimeout(z, 60000)); i--; continue; }
        const made = files.length ? ' Jo files ban chuki hain woh neeche hain.' : '';
        result = { success: false, result: 'Abhi saare free AI models busy/limit pe hain, isliye kaam beech mein rukna pada (' + steps.length + ' steps ho chuke the).' + made + ' Thodi der baad "continue" bolo.' }; break;
      }
      const parts = (resp.parts || []).filter(p => p.text || p.functionCall);
      if (ctx.llm.takeCut && ctx.llm.takeCut() && !cutHint) { cutHint = true; hintNow = true; }
      if (!parts.length) parts.push({ text: '' });
      contents.push({ role: 'model', parts });
      const calls = parts.filter(p => p.functionCall);
      const fresh = []; // messages the user sent while we work (cloud chat inbox)
      if (!calls.length) {
        const t = parts.map(p => p.text || '').join('').trim();
        if (opts.chat && t) {
          const acted = steps.some(s => BROWSER.includes(s.tool) || ['run_code', 'write_file', 'upload_image', 'install_packages'].includes(s.tool));
          if (acted && checks < 2) { const v = await verify(ctx, task, steps, t, tests); if (!v.ok) { checks++; steps.push({ tool: 'checker', args: {}, out: clip('rejected: ' + v.reason, 200) }); contents.push({ role: 'user', parts: [{ text: 'CHECKER: not done yet — ' + v.reason + '. Do the missing part now, or reply honestly with what could not be done.' }] }); continue; } }
          result = { success: true, result: t }; break;
        }
        if (nudges < 2) { nudges++; contents.push({ role: 'user', parts: [{ text: 'Continue the task now: call the next tool. When fully done (or truly impossible), call finish with the result' + (t ? '' : ' and the exact reason') + '.' }] }); continue; }
        result = { success: false, result: t || 'Task beech mein ruk gaya (AI ne jawab nahi diya). Dobara try karo.' }; break;
      }
      const outs = [];
      for (const c of calls) {
        const { name, args = {} } = c.functionCall;
        if (name === 'finish') {
          const claim = { success: args.success !== false, result: String(args.result || '') };
          if (claim.success && checks < 2) {
            await progress({ label: label('finish', {}), step: stepNo });
            const v = await verify(ctx, task, steps, claim.result, tests);
            if (!v.ok) { checks++; outs.push({ functionResponse: { name, response: { result: 'NOT ACCEPTED by checker: ' + v.reason + '. The task is not done yet. Do the missing step now, or finish(success=false) with the exact reason.' } } }); steps.push({ tool: 'checker', args: {}, out: clip('rejected: ' + v.reason, 200) }); continue; }
          } else if (claim.success && checks >= 2) { const v = await verify(ctx, task, steps, claim.result, tests); if (!v.ok) { claim.success = false; claim.result = claim.result + '\n\n⚠ Poora verify nahi ho paya: ' + v.reason; } }
          result = claim; break;
        }
        stepNo++;
        const pr = await progress({ label: label(name, args), step: stepNo, tool: name });
        if (pr && pr.cancel) { result = { success: false, result: 'Stopped by you.' }; break; }
        if (pr && pr.inbox && pr.inbox.length) fresh.push(...pr.inbox);
        let out, img = null;
        try { const f = impl[name]; if (!f) throw new Error('unknown tool'); out = await f(args); if (out && typeof out === 'object') { img = out.image; out = out.text; } }
        catch (e) { out = 'ERROR: ' + (e && e.message || e); }
        steps.push({ tool: name, args: redact(args), out: clip(String(out), 400) });
        outs.push({ functionResponse: { name, response: { result: clip(String(out), 9000) } } });
        if (img) outs.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
        if (page && BROWSER.includes(name) && name !== 'look_at_screen' && ctx.progress && ctx.now() - lastShotAt > 5000) { // live view for the phone
          try { const b = await page.screenshot({ type: 'jpeg', quality: 45, encoding: 'base64' }); lastShotAt = ctx.now(); await progress({ label: label(name, args), step: stepNo, shot: b }); } catch { }
        }
      }
      if (hintNow) { hintNow = false; outs.push({ text: '[JANUS: one of your replies was too long and got cut off by the AI provider. Keep every tool call short from now on: write big files in parts of at most 150 lines (first write_file, then write_file with append=true).]' }); }
      if (fresh.length) outs.push({ text: fresh.map(t => '[NEW MESSAGE from the user while you work — handle it together with the current task]: ' + t).join('\n') });
      if (!result && outs.length) contents.push({ role: 'user', parts: outs });
    }
  } finally {
    if (page && ctx.saveCookies) { try { const c = await page.createCDPSession(); const { cookies } = await c.send('Network.getAllCookies'); await ctx.saveCookies(cookies); } catch { } }
    try { if (ctx._browser && !opts.keepBrowser) { const b = await ctx._browser; ctx._browser = null; await b.close(); } } catch { }
  }
  if (cont) return { cont: { contents: contents.map(c => ({ role: c.role, parts: (c.parts || []).filter(p => !p.inlineData) })).map(c => c.parts.length ? c : { role: c.role, parts: [{ text: '…' }] }), stepNo, steps: steps.slice(-60), images: images.slice(-6), files: files.slice(-8) }, success: false, result: '', steps, images, files: files.slice(-8), model: ctx.llm.lastModel && ctx.llm.lastModel() };
  if (!result) result = { success: false, result: 'Step limit khatam ho gaya, task poora nahi hua. Last steps: ' + steps.slice(-3).map(x => x.tool).join(' → ') };
  return { ...result, steps, images: images.concat(lastShot ? [lastShot] : []).filter((x, i, a) => a.indexOf(x) === i).slice(-6), files: files.filter((x, i, a) => a.indexOf(x) === i).slice(-8), model: ctx.llm.lastModel && ctx.llm.lastModel() };
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'the site'; } };

// Checker: never let the agent claim a success its own steps don't show.
export async function verify(ctx, task, steps, claim, tests = []) {
  const t = task.toLowerCase();
  const negated = /(do ?n.?t|do not|never|without|mat|nahi|na)\s+(publish|post|upload|daal|dal)/.test(t);
  const wantsPost = !negated && /upload|post|publish|pin\b|pins\b|share on|daalo|dalo|kar do.*(pinterest|instagram|youtube)/.test(t) && /pinterest|instagram|youtube|facebook|twitter|\bx\b|reddit|linkedin|tumblr|site|account/.test(t);
  if (wantsPost) {
    const up = steps.findIndex(s => s.tool === 'upload_image' && /^image put/.test(s.out));
    if (/image|wallpaper|photo|pic/.test(t) && up < 0) return { ok: false, reason: 'no image was uploaded to the site (upload_image never succeeded)' };
    if (up >= 0 && !steps.slice(up + 1).some(s => s.tool === 'click_element')) return { ok: false, reason: 'the image was put in but Publish/Post was never clicked' };
  }
  if (steps.some(s => /^LOGIN FAILED/.test(s.out)) && !steps.some(s => /^LOGIN OK/.test(s.out))) return { ok: false, reason: 'login failed' };
  const built = steps.some(s => s.tool === 'write_file' && /\.html?\b/i.test(JSON.stringify(s.args)));
  if (built && isGame(t) && steps.some(s => s.tool === 'test_web_app' || s.tool === 'write_file') && tests.length < 2 && steps.length < 260) return { ok: false, reason: `the game was self-tested ${tests.length} time(s); run test_web_app, fix what it finds, and test again (at least 2 rounds)` };
  if (tests.length && tests[tests.length - 1].errors > 0 && steps.length < 260) return { ok: false, reason: 'the last self-test still shows JavaScript errors; fix them and test again' };
  if (/\bapk\b/.test(t) && !/\.apk/i.test(steps.map(s => s.out).join(' ')) && !negated) return { ok: false, reason: 'no .apk file was produced at the top level of the work folder' };
  try {
    const log = steps.slice(-80).map((s, i) => (i + 1) + '. ' + s.tool + ' ' + JSON.stringify(s.args).slice(0, 120) + ' => ' + String(s.out).replace(/\s+/g, ' ').slice(0, 160)).join('\n');
    const r = await ctx.llm([{ role: 'user', parts: [{ text: 'You are a strict checker. TASK:\n' + clip(task, 3000) + '\n\nSTEPS the agent actually did:\n' + log + '\n\nAGENT CLAIMS: ' + clip(claim, 2000) + '\n\nDo the steps PROVE every part of the task was really done (e.g. a post really published, a file really built and tested, not just a page opened)? For pure questions/answers with no action needed, answer done=true. Reply ONLY JSON: {"done": true|false, "reason": "short missing part"}' }] }], [], { route: 'fast', timeoutMs: 60000 });
    const txt = (r.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (j.done === false) return { ok: false, reason: String(j.reason || 'steps do not show the task was completed').slice(0, 200) };
  } catch { }
  return { ok: true };
}

function redact(a) { const o = { ...a }; for (const k of ['text', 'content', 'code']) if (o[k] && String(o[k]).length > 80) o[k] = String(o[k]).slice(0, 80) + '…'; return o; }
export function btoaBytes(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

/** Compatibility wrapper (older callers): Gemini key + OpenAI-compatible keys → router. */
export function makeLLM({ geminiKey, ai, fetchImpl = fetch, oai = {}, keyInHeader = true, geminiBase } = {}) {
  return makeRouter({ keys: { gemini: geminiKey, ...oai }, ai, fetchImpl, geminiKeyInHeader: keyInHeader, ...(geminiBase ? { geminiBase } : {}) });
}
export { makeRouter };
