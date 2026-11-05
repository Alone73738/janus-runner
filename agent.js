// JANUS Cloud agent core (v5.1: human status lines + intro line, up to 16 parallel sub-agents with live thumbnails, download_file; v5: shared browser with one tab per agent, extensions): portable (Cloudflare Worker + GitHub runner + Node test harness).
// ctx = { llm (router), browser() -> puppeteer Browser, logins: {get(site), list()}, images: {put, get}, now(),
//         optional: runCode, install, fs:{write,read,list}, testWebApp, progress(info) -> {cancel, inbox}, cookies, saveCookies }
import { makeRouter, firstJsonCall as _fjc, GEMINI_MODELS as _GM, classifyTask } from './router.js';
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
  { name: 'spawn_agents', description: 'Run several sub-agents AT THE SAME TIME, each on one independent part of the job, each working in its own TAB of the one cloud browser the user watches. "5 browser kholo, har ek me ye karo" → exactly 5 tasks with browser=true. Research / compare / check several shops, sites or topics → split it yourself into as many agents as the job needs (no fixed limit; tabs beyond the machine RAM simply queue). Each has web_search/read_url and, when browser=true, its own browser tab. They return short summaries; you then merge them into one answer. task = complete self-contained instructions for that part; title = 2–4 words.', parameters: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, task: { type: 'string' }, browser: { type: 'boolean' } }, required: ['task'] } } }, required: ['tasks'] } },
  { name: 'download_file', description: 'Download a file or a public video the user asked for (YouTube/Shorts, Instagram, X, Vimeo, Facebook, Reddit pages via yt-dlp; direct file links via HTTP) into the work folder; it is sent back to the user automatically as a file in the chat. url = the exact video page or file link (find it first). name = optional file name like "zach-king-short.mp4". Max ~24 MB (videos are fetched at ≤720p).', parameters: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } }, required: ['url'] } },
  { name: 'open_tabs', description: 'Open several web pages at once, each in a new tab of the cloud browser the user watches (e.g. "10 tabs mein Pinterest kholo" → 10 urls). Fast: no sub-agents. Returns each tab title. Use spawn_agents instead when every tab needs real work.', parameters: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'] } },
  { name: 'finish', description: 'The task is done (or truly impossible). result = the final short answer for the user in their language.', parameters: { type: 'object', properties: { result: { type: 'string' }, success: { type: 'boolean' } }, required: ['result', 'success'] } },
];
const RUNNER_ONLY = ['run_code', 'install_packages', 'write_file', 'read_file', 'test_web_app'];
const BROWSER = ['open_tabs', 'open_url', 'list_elements', 'click_element', 'type_into', 'select_option', 'scroll_page', 'read_page', 'look_at_screen', 'sign_in', 'upload_image'];

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
MAIN AGENT: you own this chat. Messages the user sends while you work arrive as [NEW MESSAGE …]: read them at once, treat them as a correction, an addition or a stop, start your next reply with ONE short line acknowledging it (user's language), then continue with the updated job. Never ignore them.
TOOLS: web_search/read_url for facts (cite sources as [1] with URLs when you use them); the cloud browser (open_url, list_elements, click/type by element number, look_at_screen to check); sign_in for login forms; generate_image for pictures; download_file for files/videos the user wants in the chat (never say you cannot download into the chat); open_tabs to open many pages at once; spawn_agents to run many sub-agents in parallel, each in its own tab of the same browser ("N browser kholo" → exactly N browser agents; research/compare → as many agents as useful), then merge their summaries into one answer.
${opts.chat ? 'BEFORE YOUR FIRST TOOL CALL write ONE short line (max 12 words, user\'s language) saying what you are about to do, e.g. "Theek hai, 5 browsers khol ke compare karta hun…", and call the tools in the same reply. Never wait for a plan confirmation; start right away. The user watches your browser live, so the final answer is just the result (no step lists, no element numbers).' : ''}
Saved logins you can use with sign_in: ${lg}. If the task needs a site whose login is not in this list (and Google is not usable for it), do not guess: say exactly "<site> ka login cloud mein share nahi hai. JANUS → Settings → Cloud → Logins mein Share dabao." Saved browser cookies may already keep you logged in, so open the site first and check.
If a site needs an OTP/captcha/approval you cannot do, stop and say what is needed.
${opts.chat ? 'When done, reply with the final answer as plain text (or call finish). Keep it short: the result, plus files/links if any.' : 'Never stop silently: every reply must call a tool, and the last one must be finish(result) in the user\'s language.'}
${SITE_TIPS}${GOOGLE_TIP}${opts.job || opts.chat ? '\n' + JOB_TIPS : ''}${isBuild(task) ? '\n' + GAME_PLAYBOOK + '\n' + SELFTEST : ''}
${opts.chat ? '' : 'TASK: ' + task}`;
}


/** Shared cloud browser: one Chromium per job, one page (tab) per agent. Extensions (userscripts) run on every page. */
export async function sharedBrowser(ctx) { if (!ctx._browser) ctx._browser = Promise.resolve(ctx.browser()); return ctx._browser; }
export async function newPage(ctx, owner) {
  const b = await sharedBrowser(ctx); const page = await b.newPage();
  const tab = registerTab(ctx, page, owner);
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
  if (ctx.cookies && ctx.cookies.length && !ctx._cookiesSet) { ctx._cookiesSet = true; try { const c = await page.createCDPSession(); await c.send('Network.setCookies', { cookies: ctx.cookies }); } catch { } }
  for (const e of ctx.extensions || []) { if (e && e.enabled !== false && e.code) { try { await page.evaluateOnNewDocument(e.code); } catch { } } }
  page._jt = tab; return page;
}
/** v5.2: every page is a TAB of the one cloud browser the phone shows (tab strip + live view of one tab).
 *  ctx.tabs = [{id, page, owner, u, t, s, ts, closed}], ctx.activeTab = the tab an agent acted on last. */
export function registerTab(ctx, page, owner) {
  ctx.tabs = ctx.tabs || []; ctx._tabN = (ctx._tabN || 0) + 1;
  const t = { id: 't' + ctx._tabN, page, owner: owner == null ? 'main' : owner, u: '', t: 'New tab', s: 'run', ts: Date.now() };
  ctx.tabs.push(t); ctx.activeTab = t.id;
  const upd = async () => { try { t.u = page.url(); const ti = await page.title(); t.t = clip(String(ti || '').trim(), 60) || host(t.u); t.ts = Date.now(); } catch { } };
  try {
    page.on('framenavigated', f => { try { if (f === page.mainFrame()) { t.u = f.url(); t.ts = Date.now(); upd(); } } catch { } });
    page.on('load', upd); page.on('domcontentloaded', upd);
    page.on('close', () => { t.closed = true; t.page = null; if (t.s === 'run') t.s = 'done'; });
  } catch { }
  return t;
}
/** Before a new page: close the oldest finished tabs so open pages never exceed the RAM-based pool (last screenshot kept). */
export async function roomPage(ctx, owner) { // serialized: free a slot, then open the page (no race between agents)
  const prev = ctx._room || Promise.resolve(); let done; ctx._room = new Promise(r => { done = r; });
  try { await prev; await makeRoom(ctx); return await newPage(ctx, owner); } finally { done(); } }
export async function makeRoom(ctx) { const lim = pagesFor(ctx); let open = (ctx.tabs || []).filter(t => t.page); for (const t of open.filter(t => t.s !== 'run')) { if (open.length < lim) break; if (ctx.snapTab) { try { await ctx.snapTab(t); } catch { } } const p = t.page; t.page = null; t.closed = true; open = open.filter(x => x !== t); try { await p.close(); } catch { } } }
export function tabOf(ctx, page) { return page && page._jt ? page._jt : null; }
export function markActive(ctx, page) { const t = tabOf(ctx, page); if (t) { ctx.activeTab = t.id; t.ts = Date.now(); } }
/** Close every page (stop button, end of a job); the tab entries keep their last screenshot for the phone. */
export async function closeAllTabs(ctx) { for (const t of ctx.tabs || []) { if (t.page) { const p = t.page; t.page = null; t.closed = true; try { await p.close(); } catch { } } } }
/** Best-effort URL for a sub-task / quick task, so a tab can open the site BEFORE the first (slow) model call. */
const SITE_URLS = { pinterest: 'https://www.pinterest.com/', youtube: 'https://m.youtube.com/', 'you tube': 'https://m.youtube.com/', google: 'https://www.google.com/', amazon: 'https://www.amazon.in/', flipkart: 'https://www.flipkart.com/', instagram: 'https://www.instagram.com/', facebook: 'https://www.facebook.com/', twitter: 'https://x.com/', linkedin: 'https://www.linkedin.com/', github: 'https://github.com/', reddit: 'https://www.reddit.com/', wikipedia: 'https://www.wikipedia.org/', myntra: 'https://www.myntra.com/', netflix: 'https://www.netflix.com/', spotify: 'https://open.spotify.com/', zomato: 'https://www.zomato.com/', swiggy: 'https://www.swiggy.com/', meesho: 'https://www.meesho.com/', ajio: 'https://www.ajio.com/', croma: 'https://www.croma.com/', nykaa: 'https://www.nykaa.com/', tumblr: 'https://www.tumblr.com/', bing: 'https://www.bing.com/', duckduckgo: 'https://duckduckgo.com/', chatgpt: 'https://chatgpt.com/', gmail: 'https://mail.google.com/', quora: 'https://www.quora.com/', imdb: 'https://www.imdb.com/', 'hacker news': 'https://news.ycombinator.com/' };
export function guessUrl(text) {
  const t = String(text || ''); const m = /https?:\/\/[^\s"'<>)]+/i.exec(t); if (m) return m[0];
  const d = /\b([a-z0-9-]+\.(?:com|in|org|net|io|co|dev|app|ai|me|tv)(?:\.[a-z]{2})?)(\/[^\s]*)?\b/i.exec(t); if (d) return 'https://' + d[1] + (d[2] || '/');
  const lo = t.toLowerCase(); let best = null, at = 1e9;
  for (const k of Object.keys(SITE_URLS)) { const i = lo.search(new RegExp('\\b' + k + '\\b')); if (i >= 0 && i < at) { at = i; best = SITE_URLS[k]; } }
  if (best) { const q = /(?:search|dhoondo|dhundo|find|search karo|par|pe)\s+(?:for\s+)?["“]?([^"”\n]{2,60})["”]?/i.exec(t); if (q && /youtube/.test(best)) return 'https://m.youtube.com/results?search_query=' + encodeURIComponent(q[1].replace(/\b(on|par|pe)\s+youtube.*$/i, '').trim()); return best; }
  return null;
}
/** "Open X" / "X kholo" with nothing else to do: a tab can finish without asking a model. */
export function isJustOpen(text) { const t = String(text || '').toLowerCase().replace(/[!?,]|\.(\s|$)/g, ' ').replace(/\s+/g, ' ').trim(); if (t.length > 80) return false; if (!guessUrl(t)) return false; const rest = t.replace(/https?:\/\/\S+/g, ' ').replace(/\b(open|kholo|khol|khol do|karo|kar do|please|plz|pls|jaldi|fast|quick|quickly|abhi|in|mein|me|ek|tab|tabs|new|naya|browser|site|website|the|a|par|pe|jao|go|to|and|aur|do|de|dena|show|dikhao|[0-9]+(st|nd|rd|th)?|no|number|wala|wali)\b/g, ' ');
  return !Object.keys(SITE_URLS).reduce((r, k) => r.replace(new RegExp('\\b' + k + '\\b', 'g'), ' '), rest.replace(/[a-z0-9-]+\.(com|in|org|net|io|co|dev|app|ai|me|tv)\S*/g, ' ')).trim(); }
const settle = async (p) => { try { await p.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }); } catch { } };
/** Browser tools bound to one page (main agent and every sub-agent get their own). info = {task, step()} */
export function pageTools(ctx, getPage0, info) {
  const getPage = async () => { const p = await getPage0(); markActive(ctx, p); return p; };
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


// ---------------- v5.1: short human status lines (same wording as the phone) ----------------
const SITE_NAMES = { 'youtube.com': 'YouTube', 'youtu.be': 'YouTube', 'google.com': 'Google', 'amazon.in': 'Amazon', 'amazon.com': 'Amazon', 'flipkart.com': 'Flipkart', 'instagram.com': 'Instagram', 'facebook.com': 'Facebook', 'x.com': 'X', 'twitter.com': 'X', 'linkedin.com': 'LinkedIn', 'github.com': 'GitHub', 'pinterest.com': 'Pinterest', 'reddit.com': 'Reddit', 'wikipedia.org': 'Wikipedia', 'duckduckgo.com': 'DuckDuckGo', 'bing.com': 'Bing', 'myntra.com': 'Myntra', 'croma.com': 'Croma', 'meesho.com': 'Meesho', 'vimeo.com': 'Vimeo' };
export const isHing = (t) => /\b(hai|hain|karo|kardo|kar do|karke|karna|mujhe|mera|meri|kya|kaise|kyun|nahi|nhi|yr|yaar|bhai|kholo|khol|dhoondo|dhundo|dikhao|batao|wala|wali|aur|abhi|chahiye|lekin|bhi|sab|kuch|mein|yah|yaha|yahan|usme|isme|bata|bolo|ka|ke|ki|ko|se|pe|par)\b/i.test(String(t || ''));
const siteName = (u) => { const k = siteKey(/^[a-z]+:\/\//i.test(String(u || '')) ? u : 'https://' + u); if (SITE_NAMES[k]) return SITE_NAMES[k]; const b = (k || 'site').split('.')[0]; return b.charAt(0).toUpperCase() + b.slice(1); };
const qq = (t, n = 34) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** → [line, iconKind] */
export function sayLine(name, a = {}, lang = 'en') {
  const hi = lang === 'hi'; const H = (x, y) => (hi ? x : y);
  switch (name) {
    case 'open_url': return [H(siteName(a.url) + ' khol raha hun', 'Opening ' + siteName(a.url)), 'globe'];
    case 'web_search': return [H('“' + qq(a.query) + '” dhoondh raha hun', 'Looking up “' + qq(a.query) + '”'), 'search'];
    case 'read_url': return [H(siteName(a.url) + ' padh raha hun', 'Reading ' + siteName(a.url)), 'read'];
    case 'list_elements': case 'read_page': return [H('Page padh raha hun', 'Reading the page'), 'read'];
    case 'click_element': return [H('Click kar raha hun', 'Clicking'), 'click'];
    case 'type_into': return a.press_enter ? [H('“' + qq(a.text, 28) + '” dhoondh raha hun', 'Searching “' + qq(a.text, 28) + '”'), 'search'] : [H('“' + qq(a.text, 28) + '” likh raha hun', 'Typing “' + qq(a.text, 28) + '”'), 'type'];
    case 'select_option': return [H('Option chun raha hun', 'Choosing an option'), 'click'];
    case 'scroll_page': return [H('Aage dekh raha hun', 'Scrolling'), 'read'];
    case 'look_at_screen': return [H('Screen dekh raha hun', 'Checking the screen'), 'eye'];
    case 'sign_in': return [H('Sign in kar raha hun', 'Signing in'), 'lock'];
    case 'upload_image': return [H('Upload kar raha hun', 'Uploading'), 'down'];
    case 'generate_image': return [H('Image bana raha hun', 'Creating your image'), 'spark'];
    case 'download_file': return [H('Video download kar raha hun', 'Downloading the video').replace(/Video|video/, /\.(pdf|zip|apk|docx?|xlsx?|png|jpe?g)(\?|$)/i.test(a.url || '') ? (hi ? 'File' : 'file') : '$&'), 'down'];
    case 'spawn_agents': { const n = Math.max(1, (a.tasks || []).length); return [H(n + ' agents ko kaam baant raha hun', 'Splitting the work across ' + n + ' agents'), 'agents']; }
    case 'write_file': return [H(qq(String(a.path || 'file'), 30) + ' likh raha hun', 'Writing ' + qq(String(a.path || 'a file'), 30)), 'type'];
    case 'read_file': return [H('File padh raha hun', 'Reading a file'), 'read'];
    case 'run_code': return [H('Code chala raha hun', 'Running code'), 'spark'];
    case 'install_packages': return [H('Tools install kar raha hun', 'Installing tools'), 'down'];
    case 'test_web_app': return [H('Phone screen pe test kar raha hun', 'Testing on a phone screen'), 'eye'];
    case 'finish': return [H('Result check kar raha hun', 'Checking the result'), 'ok'];
    case '_start': return [H('Shuru kar raha hun', 'Starting'), 'spark'];
    case '_wait': return [H('AI models busy hain, ek minute', 'AI models are busy, one minute'), 'spark'];
    case '_merge': return [H('Sabke results jod raha hun', 'Putting the results together'), 'agents'];
  }
  return [H('Kaam kar raha hun', 'Working on it'), 'spark'];
}
export function introLine(calls, lang = 'en') {
  const hi = lang === 'hi'; const H = (x, y) => (hi ? x : y); const c = (calls[0] || {}).functionCall || {}; const a = c.args || {};
  if (c.name === 'spawn_agents') { const n = (a.tasks || []).length; const br = (a.tasks || []).filter(t => t.browser).length; return br >= 2 ? H('Theek hai, ' + br + ' browsers ek saath khol ke karta hun…', 'On it — opening ' + br + ' browsers in parallel…') : H('Theek hai, ' + n + ' agents ek saath laga ke karta hun…', 'On it — running ' + n + ' agents in parallel…'); }
  if (c.name === 'open_url') return H('Theek hai, ' + siteName(a.url) + ' khol ke dekhta hun…', 'Sure — opening ' + siteName(a.url) + '…');
  if (c.name === 'web_search' || c.name === 'read_url') return H('Ek second, web pe check karta hun…', 'Let me check the web…');
  if (c.name === 'download_file') return H('Theek hai, download karke yahin chat mein deta hun…', 'Sure — downloading it right here…');
  if (c.name === 'write_file' || c.name === 'run_code') return H('Theek hai, cloud computer pe bana deta hun…', 'On it — building it on the cloud computer…');
  return H('Theek hai, abhi karta hun…', 'On it…');
}

// ---------------- Parallel sub-agents (orchestrator) ----------------
export const SUB_MAX = 60, SUB_PAGES = 12; // v5.1: up to 12 browser pages at once (fewer when the runner's free RAM is low), the rest queue
const PAGE_MB = 420; // measured: a heavy page (YouTube/Amazon) in headless Chrome ≈ 250–400 MB incl. renderer; keep 1.5 GB free
export function pagesFor(ctx) { const max = ctx.subPages || SUB_PAGES; if (!ctx.memFree) return max; const free = ctx.memFree() / 1048576; return Math.max(2, Math.min(max, Math.floor((free - 1536) / PAGE_MB))); }
const SUB_TOOLS = ['web_search', 'read_url', 'open_url', 'list_elements', 'click_element', 'type_into', 'select_option', 'scroll_page', 'read_page', 'look_at_screen', 'sign_in', 'finish'];
const subLabel = (n, a) => ({ web_search: 'Searching “' + clip(a.query || '', 36) + '”', read_url: 'Reading ' + host(a.url), open_url: 'Opening ' + host(a.url), list_elements: 'Reading the page', click_element: 'Clicking', type_into: 'Typing', select_option: 'Choosing', scroll_page: 'Scrolling', read_page: 'Reading the page', look_at_screen: 'Looking', sign_in: 'Signing in' })[n] || 'Working';
/** list = [{title, task, browser}] → runs all at once (≤10), each with its own tool loop and (if needed) its own page. */
export async function runSubAgents(ctx, list, parent = {}) {
  const items = (Array.isArray(list) ? list : []).filter(x => x && (x.task || x.title)).slice(0, SUB_MAX);
  if (!items.length) return 'No sub-tasks given. Pass tasks: [{title, task}].';
  const lang = parent.lang || (isHing(parent.task) ? 'hi' : 'en');
  const wants = (x) => x.browser === true || (x.browser !== false && /https?:\/\/|website|\bsite\b|\bopen\b|log ?in|sign ?in|\bbook\b|\bfill\b|\bclick\b|browser|kholo/i.test(String(x.task || x.title)));
  const state = items.map(x => ({ t: clip(String(x.title || x.task), 48), s: 'queued', l: '', b: !!(wants(x) && ctx.browser) }));
  let free = ctx.browser ? pagesFor(ctx) : 0, cancelled = false; const waiters = [];
  const acquire = async () => { while (free <= 0 || (ctx.memFree && ctx.memFree() < 900 * 1048576 && free < pagesFor(ctx))) { await new Promise(r => { waiters.push(r); setTimeout(r, 4000); }); } free--; };
  const release = () => { free++; const w = waiters.shift(); if (w) w(); };
  let lastPush = 0;
  const push = async (force) => {
    if (!parent.progress || (!force && Date.now() - lastPush < 1500)) return; lastPush = Date.now();
    const done = state.filter(s => s.s === 'done' || s.s === 'fail').length;
    const r = await parent.progress({ label: done < items.length ? groupLine(items, state, done, lang) : sayLine('_merge', {}, lang)[0], kind: 'agents', step: parent.step ? parent.step() : 0, agents: state.map(({ th, ...x }) => x) });
    if ((r && r.cancel) || ctx.cancelled) cancelled = true;
  };
  const one = async (x, i) => {
    const task = String(x.task || x.title);
    let page = null, gotPage = false, seen = (ctx.inboxAll || []).length; const t0 = Date.now(); const deadline = +x.deadline_ms || SUB_DEADLINE;
    if (state[i].b) { await push(); await acquire(); gotPage = true; }
    if (cancelled) { if (gotPage) release(); state[i].s = 'fail'; return { title: state[i].t, ok: false, result: 'Stopped.' }; }
    state[i].s = 'run'; state[i].l = sayLine('_start', {}, lang)[0]; await push();
    const getPage = async () => { if (!page) { page = await roomPage(ctx, 'a' + i); const tb = tabOf(ctx, page); if (tb) { tb.t = state[i].t; state[i].tab = tb.id; } } return page; };
    const thumb = async () => { };
    // v5.2: open the site right away (before the first, slow model call) so the tab shows real content at once
    const pre = gotPage ? guessUrl(task) : null;
    if (pre) { try { const pg = await getPage(); const [l, k] = sayLine('open_url', { url: pre }, lang); state[i].l = l; state[i].k = k; await push(); await pg.goto(pre, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch { } }
    if (pre && isJustOpen(task)) { // nothing else to do in this tab
      let ti = ''; try { ti = await page.title(); } catch { }
      if (page) { const tb = tabOf(ctx, page); if (tb) tb.s = 'done'; } if (gotPage) release();
      state[i].s = 'done'; state[i].l = ''; await push(true);
      return { title: state[i].t, ok: true, result: 'Opened ' + pre + (ti ? ' — "' + clip(ti, 80) + '"' : '') + ' (tab stays open for the user).' };
    }
    const tools = TOOLS.filter(t => SUB_TOOLS.includes(t.name) && (gotPage || !BROWSER.includes(t.name)));
    const impl = { web_search: async ({ query }) => S(await webSearch(query)), read_url: async ({ url }) => await readUrl(url), ...(gotPage ? pageTools(ctx, getPage, { task, step: () => 0 }) : {}) };
    const system = `You are sub-agent ${i + 1} of ${items.length}, working for JANUS on ONE part of a bigger job. Do only your part, quickly: use tools, then call finish(result, success) with a compact factual summary (max 12 lines; include the URLs, prices and numbers you found). Nobody can answer questions. Never type passwords (logins only via sign_in). Answer in the language of the task.\nPARENT JOB (context only): ${clip(String(parent.task || ''), 600)}\nYOUR PART: ${task}`;
    const contents = [{ role: 'user', parts: [{ text: pre ? 'Do your part now. Your tab already opened ' + pre + ' (call list_elements to see it).' : 'Do your part now.' }] }];
    let result = null;
    try {
      for (let k = 0; k < (x.steps || 14) && !result; k++) {
        if (cancelled || ctx.cancelled) { result = { ok: false, result: 'Stopped.' }; break; }
        if (Date.now() - t0 > deadline) { result = { ok: false, result: 'Time limit for this part reached (' + Math.round(deadline / 60000) + ' min). Partial: ' + clip(partsTextOf(contents), 600) }; break; }
        const all = ctx.inboxAll || []; if (all.length > seen) { const add = all.slice(seen); seen = all.length; const last = contents[contents.length - 1]; const note = { text: '[The user added while you work — follow it if it concerns your part]: ' + add.join(' | ') }; if (last.role === 'user') last.parts.push(note); else contents.push({ role: 'user', parts: [note] }); }
        const r = await ctx.llm(contents, tools, { route: gotPage ? 'agent' : (/research|compare|tulna|review|analy/i.test(String(parent.task || '') + ' ' + task) ? 'research' : 'fast'), system, timeoutMs: 90000, firstMs: 20000, spread: i + 1, maxTokens: 4096 });
        const parts = (r.parts || []).filter(p => p.text || p.functionCall); if (!parts.length) parts.push({ text: '' });
        contents.push({ role: 'model', parts });
        const calls = parts.filter(p => p.functionCall);
        if (!calls.length) { const t = parts.map(p => p.text || '').join('').trim(); if (t) { result = { ok: true, result: t }; break; } contents.push({ role: 'user', parts: [{ text: 'Call a tool, or finish(result).' }] }); continue; }
        const outs = [];
        for (const c of calls) {
          const { name, args = {} } = c.functionCall;
          if (name === 'finish') { result = { ok: args.success !== false, result: String(args.result || '') }; break; }
          { const [l, k] = sayLine(name, args, lang); state[i].l = l; state[i].k = k; } await push();
          let out; try { const f = impl[name]; if (!f) throw new Error('this tool is not available to sub-agents'); out = await f(args); if (out && typeof out === 'object') out = out.text; } catch (e) { out = 'ERROR: ' + (e && e.message || e); }
          if (gotPage && BROWSER.includes(name)) { await thumb(); await push(); }
          outs.push({ functionResponse: { name, response: { result: clip(String(out), 6000) } } });
        }
        if (!result && outs.length) contents.push({ role: 'user', parts: outs });
        if (contents.length > 24) for (const c of contents.slice(1, -8)) c.parts = (c.parts || []).map(p => p.functionResponse ? { functionResponse: { ...p.functionResponse, response: { result: clip(String(p.functionResponse.response.result || ''), 500) } } } : p);
      }
      if (!result) result = { ok: false, result: 'Step limit reached before finishing.' };
    } catch (e) { result = { ok: false, result: 'Failed: ' + clip(String(e && e.message || e), 160) }; }
    finally {
      if (page) { const tb = tabOf(ctx, page); if (tb) tb.s = result && result.ok ? 'done' : 'fail'; // the tab stays open (the user can look at it) until room is needed (makeRoom) or RAM runs low
        if (ctx.memFree && ctx.memFree() < 1200 * 1048576) { if (ctx.snapTab && tb) { try { await ctx.snapTab(tb); } catch { } } try { await page.close(); } catch { } } }
      if (gotPage) release();
    }
    state[i].s = result.ok ? 'done' : 'fail'; state[i].l = ''; await push(true);
    return { title: state[i].t, ok: result.ok, result: clip(String(result.result || ''), 2000) };
  };
  const out = await Promise.all(items.map(one));
  return S({ agents: out, note: 'All sub-agents finished. Merge their results into one clear answer (or continue the job with them).' });
}

const SUB_DEADLINE = 6 * 60000;
const partsTextOf = (contents) => contents.map(c => (c.parts || []).map(p => p.text || '').join(' ')).join(' ').replace(/\s+/g, ' ').trim();
/** "10 tabs mein Pinterest khol raha hun · 3 done" when every agent works on the same site, else "10 agents working · 3 done". */
function groupLine(items, state, done, lang) {
  const n = items.length; const urls = items.map(x => guessUrl(String(x.task || x.title)) || ''); const same = urls[0] && urls.every(u => u && siteKey(u) === siteKey(urls[0]));
  if (same && state.every(s => s.b)) { const nm = siteName(urls[0]); return lang === 'hi' ? `${n} tabs mein ${nm} khol raha hun · ${done} done` : `Opening ${nm} in ${n} tabs · ${done} done`; }
  return lang === 'hi' ? `${n} agents kaam kar rahe hain · ${done} ho gaye` : `${n} agents working · ${done} done`;
}
/** open_tabs: N pages at once (no sub-agents). */
export async function openTabs(ctx, urls, lang, progress) {
  const list = (Array.isArray(urls) ? urls : [urls]).map(u => String(u || '').trim()).filter(Boolean).map(u => /^[a-z]+:\/\//i.test(u) ? u : (guessUrl(u) || 'https://duckduckgo.com/?q=' + encodeURIComponent(u))).slice(0, 40);
  if (!list.length) return 'No urls given.';
  let done = 0; const nm = siteName(list[0]); const same = list.every(u => siteKey(u) === siteKey(list[0]));
  const line = () => same ? (lang === 'hi' ? `${list.length} tabs mein ${nm} khol raha hun · ${done} done` : `Opening ${nm} in ${list.length} tabs · ${done} done`) : (lang === 'hi' ? `${list.length} tabs khol raha hun · ${done} done` : `Opening ${list.length} tabs · ${done} done`);
  if (progress) await progress({ label: line(), kind: 'globe' });
  const lim = Math.max(2, pagesFor(ctx)); let next = 0; const out = new Array(list.length);
  const worker = async () => { while (next < list.length && !ctx.cancelled) { const k = next++; let pg; try { pg = await roomPage(ctx, 'tab'); await pg.goto(list[k], { waitUntil: 'domcontentloaded', timeout: 25000 }); const tb = tabOf(ctx, pg); if (tb) tb.s = 'done'; out[k] = 'tab ' + (k + 1) + ': ' + clip(await pg.title(), 80) + ' — ' + pg.url(); } catch (e) { out[k] = 'tab ' + (k + 1) + ': failed (' + clip(String(e && e.message || e), 60) + ')'; if (pg) { const tb = tabOf(ctx, pg); if (tb) tb.s = 'fail'; } } done++; if (progress) await progress({ label: line(), kind: 'globe' }); } };
  await Promise.all(Array.from({ length: Math.min(lim, list.length) }, worker));
  return out.join('\n') + '\n(All tabs stay open in the browser the user is watching.)';
}
export async function runAgent(ctx, task, opts = {}) {
  const maxSteps = opts.maxSteps || 25;
  const steps = []; const images = []; const files = [];
  let page = (() => { const t = (ctx.tabs || []).find(x => x.id === ctx.activeTab && x.page); return t ? t.page : null; })(); // v5.2: the browser from the last message is still open
  const openBefore = page ? (() => { try { return page.url(); } catch { return ''; } })() : '';
  const getPage = async () => { if (!page || (page.isClosed && page.isClosed())) { page = await roomPage(ctx, 'main'); } return page; };

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
    spawn_agents: async ({ tasks }) => { return runSubAgents(ctx, tasks, { task, lang, progress, step: () => stepNo }); },
    open_tabs: async ({ urls }) => openTabs(ctx, urls, lang, (i) => progress({ ...i, step: stepNo })),
    download_file: async ({ url, name }) => {
      if (!ctx.download) return 'download_file needs the cloud computer (GitHub runner); not available here.';
      const r = await ctx.download(String(url || ''), String(name || ''));
      if (r.file) { if (r.file.mime && r.file.mime.startsWith('image/')) images.push(r.file.id); else files.push(r.file.id); }
      return r.msg;
    },
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

  const lang = isHing(task + ' ' + ((opts.chat && opts.chat.history || []).filter(m => m.role === 'user').slice(-2).map(m => m.text).join(' '))) ? 'hi' : 'en';
  const label0 = (name, a) => ({ web_search: 'Searching “' + clip(a.query || '', 40) + '”', read_url: 'Reading ' + host(a.url), generate_image: 'Creating an image', open_url: 'Opening ' + host(a.url), list_elements: 'Reading the page', click_element: 'Clicking', type_into: 'Typing', select_option: 'Choosing an option', scroll_page: 'Scrolling', read_page: 'Reading the page', look_at_screen: 'Looking at the page', sign_in: 'Signing in', upload_image: 'Uploading', write_file: 'Writing ' + clip(String(a.path || 'a file'), 40), read_file: 'Reading ' + clip(String(a.path || 'a file'), 40), spawn_agents: 'Starting parallel agents', run_code: 'Running code', install_packages: 'Installing tools', test_web_app: 'Testing on a phone screen', finish: 'Checking the result' })[name] || 'Working';
  const label = (name, a) => sayLine(name, a, lang)[0]; const kindOf = (name, a) => sayLine(name, a, lang)[1];
  const t0 = ctx.now(); let stepNo = opts.state ? (opts.state.stepNo || 0) : 0; let lastShot = null; const tests = []; let lastShotAt = 0;
  const progress = async (info) => { if (!ctx.progress) return null; try { return await ctx.progress(info); } catch { return null; } };
  const loginSites = ctx.logins.list ? await ctx.logins.list() : [];
  const system = sysPrompt(task, new Date(ctx.now()).toISOString(), loginSites, opts);
  const route = opts.route || ((isCodeTask(task) || isBuild(task)) && (opts.job || opts.chat) ? 'code' : classifyTask(task, {}) === 'fast' ? 'main' : classifyTask(task, {})); // v5.1: strongest model for the task type
  let contents;
  if (opts.state && Array.isArray(opts.state.contents)) {
    contents = opts.state.contents;
    contents.push({ role: 'user', parts: [{ text: '[JANUS: the job moved to a fresh cloud computer to keep going. Your work folder was restored (files you wrote are still there), but the browser was closed and installed apt packages are gone (reinstall if needed). Continue the same task from where you stopped; do not redo finished steps.]' }] });
    (opts.state.images || []).forEach(x => images.push(x)); (opts.state.files || []).forEach(x => files.push(x)); (opts.state.steps || []).forEach(x => steps.push(x));
  } else if (opts.chat) {
    contents = [];
    for (const m of (opts.chat.history || []).slice(-24)) { const t = clip(String(m.text || ''), 6000); if (!t) continue; contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: t }] }); }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    const parts = [{ text: (task || 'See the attached image.') + (openBefore && !/^about:/.test(openBefore) ? '\n\n[The browser from before is still open on: ' + openBefore + ' (' + ((ctx.tabs || []).filter(t => t.page).length) + ' open tabs). If this message continues that, keep working there (list_elements first).]' : '') }]; for (const im of (opts.chat.images || []).slice(0, 4)) parts.push({ inlineData: { mimeType: im.mime || 'image/jpeg', data: im.b64 } });
    if (contents.length && contents[contents.length - 1].role === 'user') contents.push({ role: 'model', parts: [{ text: '…' }] });
    contents.push({ role: 'user', parts });
  } else contents = [{ role: 'user', parts: [{ text: 'Do the task now.' }] }];
  const hasImg = contents.some(c => (c.parts || []).some(p => p.inlineData));
  let result = null, nudges = 0, checks = 0, cont = null, cutHint = false, hintNow = false, llmFails = 0, introSent = !!opts.state;
  const tools = TOOLS.filter(t => (ctx.runCode || !RUNNER_ONLY.includes(t.name)) && (t.name !== 'write_file' || ctx.fs) && (t.name !== 'test_web_app' || ctx.testWebApp));
  // v5.2 main-agent inbox: every message the user sends while we work is read before the next step
  let pendingAck = false;
  const takeInbox = () => { const l = (ctx.inbox || []).splice(0); return l.filter(x => String(x || '').trim()); };
  const addInbox = (l, intoParts) => {
    const txt = l.map(t => '[NEW MESSAGE from the user while you work — treat it as a correction, an addition or a stop; first write ONE short line acknowledging it in their language, then continue with the updated job]: ' + t).join('\n');
    if (intoParts) intoParts.push({ text: txt }); else { const last = contents[contents.length - 1]; if (last && last.role === 'user') last.parts.push({ text: txt }); else contents.push({ role: 'user', parts: [{ text: txt }] }); }
    pendingAck = true; steps.push({ tool: 'inbox', args: {}, out: clip(l.join(' | '), 200) });
  };
  const waitIfPaused = async () => { let n = 0; while (ctx.pausedUntil && ctx.pausedUntil > ctx.now() && !ctx.cancelled && n++ < 600) { if (n === 1) await progress({ label: lang === 'hi' ? 'Aap browser chala rahe ho — ruka hua hun' : 'You are using the browser — paused', kind: 'eye', step: stepNo }); await new Promise(z => setTimeout(z, 500)); } };
  // v5.2 instant path: "Pinterest kholo" needs no model at all
  if (opts.chat && !opts.state && ctx.browser && isJustOpen(task) && !(opts.chat.images || []).length) {
    const url = guessUrl(task); const nm = siteName(url);
    try {
      await progress({ intro: lang === 'hi' ? `Theek hai, ${nm} khol raha hun…` : `Sure — opening ${nm}…`, label: sayLine('open_url', { url }, lang)[0], kind: 'globe', step: ++stepNo });
      const out = await impl.open_url({ url }); steps.push({ tool: 'open_url', args: { url }, out: clip(String(out), 300) });
      if (ctx.snapNow) { try { await ctx.snapNow(); } catch { } }
      let ti = ''; try { ti = await page.title(); } catch { }
      return { success: true, result: lang === 'hi' ? `${nm} khul gaya ✓${ti ? ' — “' + clip(ti, 60) + '”' : ''}. Upar browser mein dekh lo; text box pe tap karke seedha type bhi kar sakte ho. Aage kya karna hai?` : `${nm} is open ✓${ti ? ' — “' + clip(ti, 60) + '”' : ''}. It's in the browser above; tap any text box to type. What next?`, steps, images, files, keepTabs: true, model: 'instant' };
    } catch (e) { steps.push({ tool: 'open_url', args: { url }, out: 'ERROR ' + clip(String(e && e.message || e), 120) }); }
  }
  try {
    for (let i = 0; i < maxSteps && !result; i++) {
      if (opts.budgetMs && ctx.now() - t0 > opts.budgetMs) { cont = true; break; }
      if (ctx.cancelled) { result = { success: false, result: 'Stopped by you.' }; break; }
      { const l = takeInbox(); if (l.length) { addInbox(l); await progress({ label: lang === 'hi' ? 'Aapka naya message padh liya' : 'Got your new message', kind: 'spark', step: stepNo }); } }
      if (contents.length > 40) { // keep long jobs lean: old screenshots out, old tool outputs short
        for (const c of contents.slice(1, -12)) { if (c._c) continue; c._c = 1; c.parts = (c.parts || []).filter(p => !p.inlineData || c === contents[contents.length - 1]).map(p => p.functionResponse ? { functionResponse: { ...p.functionResponse, response: { result: clip(String(p.functionResponse.response?.result || ''), 700) } } } : (p.functionCall && p.functionCall.name === 'write_file') ? { functionCall: { name: 'write_file', args: { path: p.functionCall.args.path, content: '(written, ' + String(p.functionCall.args.content || '').length + ' chars; read_file to see it)' } } } : p); if (!c.parts.length) c.parts = [{ text: '(old screenshot removed)' }]; }
      }
      let resp;
      try { resp = await ctx.llm(contents, tools, { route: i === 0 && hasImg ? 'vision' : route, system, timeoutMs: route === 'code' ? 600000 : 120000, firstMs: route === 'code' ? 60000 : 20000 }); llmFails = 0; }
      catch (e) { // every free model busy: wait and retry this step instead of throwing the whole job away
        if (++llmFails <= 3 && !(opts.budgetMs && ctx.now() - t0 > opts.budgetMs)) { await progress({ label: sayLine('_wait', {}, lang)[0], kind: 'spark', step: stepNo }); for (let w = 0; w < 60 && !ctx.cancelled && !(ctx.inbox || []).length; w++) await new Promise(z => setTimeout(z, 1000)); i--; continue; }
        const made = files.length ? ' Jo files ban chuki hain woh neeche hain.' : '';
        result = { success: false, result: 'Abhi saare free AI models busy/limit pe hain, isliye kaam beech mein rukna pada (' + steps.length + ' steps ho chuke the).' + made + ' Thodi der baad "continue" bolo.' }; break;
      }
      const parts = (resp.parts || []).filter(p => p.text || p.functionCall);
      if (ctx.llm.takeCut && ctx.llm.takeCut() && !cutHint) { cutHint = true; hintNow = true; }
      if (!parts.length) parts.push({ text: '' });
      contents.push({ role: 'model', parts });
      const calls = parts.filter(p => p.functionCall);
      const fresh = []; // messages the user sent while we work (cloud chat inbox)
      if (pendingAck) { const said = parts.map(p => p.text || '').join('').replace(/\s+/g, ' ').trim(); pendingAck = false; if (said && calls.length) await progress({ ack: clip(said, 200), step: stepNo }); else if (calls.length) await progress({ ack: lang === 'hi' ? 'Theek hai, ye bhi dhyan mein rakh ke kar raha hun.' : 'Got it — adding that in.', step: stepNo }); }
      if (ctx.cancelled) { result = { success: false, result: 'Stopped by you.' }; break; }
      if (!calls.length && (ctx.inbox || []).length) { continue; } // a new message arrived while the model answered: read it first
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
      if (!introSent && calls.some(c => c.functionCall.name !== 'finish')) { // the short line JANUS writes before acting
        introSent = true; const said = parts.map(p => p.text || '').join('').replace(/\s+/g, ' ').trim();
        await progress({ intro: clip(said || introLine(calls, lang), 180), label: sayLine(calls[0].functionCall.name, calls[0].functionCall.args || {}, lang)[0], kind: kindOf(calls[0].functionCall.name, calls[0].functionCall.args || {}), step: stepNo });
      }
      const outs = [];
      for (const c of calls) {
        const { name, args = {} } = c.functionCall;
        if (name === 'finish') {
          const claim = { success: args.success !== false, result: String(args.result || '') };
          if (claim.success && checks < 2) {
            await progress({ label: label('finish', {}), kind: 'ok', step: stepNo });
            const v = await verify(ctx, task, steps, claim.result, tests);
            if (!v.ok) { checks++; outs.push({ functionResponse: { name, response: { result: 'NOT ACCEPTED by checker: ' + v.reason + '. The task is not done yet. Do the missing step now, or finish(success=false) with the exact reason.' } } }); steps.push({ tool: 'checker', args: {}, out: clip('rejected: ' + v.reason, 200) }); continue; }
          } else if (claim.success && checks >= 2) { const v = await verify(ctx, task, steps, claim.result, tests); if (!v.ok) { claim.success = false; claim.result = claim.result + '\n\n⚠ Poora verify nahi ho paya: ' + v.reason; } }
          result = claim; break;
        }
        stepNo++;
        await waitIfPaused();
        const pr = await progress({ label: label(name, args), kind: kindOf(name, args), step: stepNo, tool: name });
        if ((pr && pr.cancel) || ctx.cancelled) { result = { success: false, result: 'Stopped by you.' }; break; }
        if (pr && pr.inbox && pr.inbox.length && !ctx.inboxHandled) fresh.push(...pr.inbox);
        let out, img = null;
        try { const f = impl[name]; if (!f) throw new Error('unknown tool'); out = await f(args); if (out && typeof out === 'object') { img = out.image; out = out.text; } }
        catch (e) { out = 'ERROR: ' + (e && e.message || e); }
        steps.push({ tool: name, args: redact(args), out: clip(String(out), name === 'spawn_agents' ? 1600 : 400) });
        outs.push({ functionResponse: { name, response: { result: clip(String(out), 9000) } } });
        if (img) outs.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
        if (page && BROWSER.includes(name) && name !== 'look_at_screen' && ctx.progress && ctx.now() - lastShotAt > 2500) { // live view for the phone
          try { const b = await page.screenshot({ type: 'jpeg', quality: 45, encoding: 'base64' }); lastShotAt = ctx.now(); await progress({ label: label(name, args), kind: kindOf(name, args), step: stepNo, shot: b }); } catch { }
        }
      }
      if (hintNow) { hintNow = false; outs.push({ text: '[JANUS: one of your replies was too long and got cut off by the AI provider. Keep every tool call short from now on: write big files in parts of at most 150 lines (first write_file, then write_file with append=true).]' }); }
      { const l = fresh.concat(takeInbox()); if (l.length && !result) { addInbox(l, outs); await progress({ label: lang === 'hi' ? 'Aapka naya message padh liya' : 'Got your new message', kind: 'spark', step: stepNo }); } }
      if (!result && outs.length) contents.push({ role: 'user', parts: outs });
    }
  } finally {
    if (page && ctx.saveCookies) { try { const c = await page.createCDPSession(); const { cookies } = await c.send('Network.getAllCookies'); await ctx.saveCookies(cookies); } catch { } }
    try { if (ctx._browser && !opts.keepBrowser) { const b = await ctx._browser; ctx._browser = null; await b.close(); } } catch { }
    // (warm runner: keepBrowser = the browser process stays for the next job; run.mjs closes the pages)
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
    const log = steps.slice(-80).map((s, i) => (i + 1) + '. ' + s.tool + ' ' + JSON.stringify(s.args).slice(0, 120) + ' => ' + String(s.out).replace(/\s+/g, ' ').slice(0, s.tool === 'spawn_agents' ? 1500 : 160)).join('\n');
    const r = await ctx.llm([{ role: 'user', parts: [{ text: 'You are a strict checker. TASK:\n' + clip(task, 3000) + '\n\nSTEPS the agent actually did:\n' + log + '\n\nAGENT CLAIMS: ' + clip(claim, 2000) + '\n\nDo the steps PROVE every part of the task was really done (e.g. a post really published, a file really built and tested, not just a page opened)? For pure questions/answers with no action needed, answer done=true. Results reported by parallel sub-agents (spawn_agents) count as proof of what those agents did. Reply ONLY JSON: {"done": true|false, "reason": "short missing part"}' }] }], [], { route: 'fast', timeoutMs: 60000 });
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
