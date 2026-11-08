// JANUS runner tools (shared by run.mjs and the local test harness).
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, readFileSync, chmodSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve as presolve, relative } from 'node:path';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && existsSync(p));
const WD = process.env.JANUS_WD || '/tmp/janus-work';
const MIME = { vtt: 'text/vtt', srt: 'text/plain', apk: 'application/vnd.android.package-archive', aab: 'application/octet-stream', zip: 'application/zip', tgz: 'application/gzip', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', py: 'text/x-python', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', svg: 'image/svg+xml' , mov: 'video/quicktime', mkv: 'video/x-matroska', m4a: 'audio/mp4', ogg: 'audio/ogg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const asNobody = !process.env.JANUS_NO_SUDO; // local tests run without sudo
mkdirSync(WD + '/inputs', { recursive: true }); try { chmodSync(WD, 0o777); chmodSync(WD + '/inputs', 0o777); } catch { }
const images = new Map(); // id → {bytes, mime, name}

function registerTop(n) { // a deliverable at the top level of the work folder → file id (newest copy per name wins)
  const ext = n.split('.').pop().toLowerCase(); const mime = MIME[ext]; if (!mime) return null;
  let st; try { st = statSync(WD + '/' + n); } catch { return null; } if (!st.isFile() || st.size > 24e6) return null;
  const id = 'img_' + rid(); images.set(id, { bytes: new Uint8Array(readFileSync(WD + '/' + n)), mime, name: n }); return { id, name: n, mime, bytes: st.size };
}
function sh(cmd, args, opts = {}) { return new Promise((res) => { const pr = spawn(cmd, args, { cwd: WD, stdio: ['ignore', 'pipe', 'pipe'], ...opts }); let o = ''; const add = (d) => { if (o.length < 200000) o += d.toString(); }; pr.stdout.on('data', add); pr.stderr.on('data', add); pr.on('close', (c) => res({ code: c, out: o })); pr.on('error', (e) => res({ code: -1, out: String(e.message) })); }); }

// run_code: separate low-privilege user (nobody), empty env (no secrets), own folder, time limit.
async function runCode(lang, code, secs, ids, imgs) {
  for (const [id, im] of imgs) { if (!im.mime || !im.mime.startsWith('image/')) continue; const ext = (Object.entries(MIME).find(([, m]) => m === im.mime) || ['bin'])[0]; const f = `${WD}/inputs/${id}.${ext}`; try { statSync(f); } catch { writeFileSync(f, im.bytes); chmodSync(f, 0o644); } }
  const before = new Map(readdirSync(WD).map(n => { try { return [n, statSync(WD + '/' + n).mtimeMs]; } catch { return [n, 0]; } }));
  const file = WD + '/_main.' + (lang === 'python' ? 'py' : lang === 'node' ? 'mjs' : 'sh'); writeFileSync(file, code); chmodSync(file, 0o644);
  const cmd = lang === 'python' ? ['python3', file] : lang === 'node' ? ['node', file] : ['bash', file];
  const pe = process.env; const extraPath = [pe.JAVA_HOME && pe.JAVA_HOME + '/bin', pe.ANDROID_HOME && pe.ANDROID_HOME + '/cmdline-tools/latest/bin', pe.ANDROID_HOME && pe.ANDROID_HOME + '/platform-tools', ...(String(pe.PATH || '').split(':'))].filter(Boolean).join(':');
  const env = ['HOME=' + WD, 'PATH=' + WD + '/.local/bin:' + extraPath, 'LANG=C.UTF-8', 'PYTHONUSERBASE=' + WD + '/.local', 'npm_config_cache=' + WD + '/.npm', 'MPLBACKEND=Agg'];
  for (const k of ['JAVA_HOME', 'JAVA_HOME_17_X64', 'JAVA_HOME_21_X64', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME', 'GRADLE_HOME']) if (pe[k]) env.push(k + '=' + pe[k]);
  env.push('GRADLE_USER_HOME=' + WD + '/.gradle', 'ANDROID_USER_HOME=' + WD + '/.android');
  const out = asNobody ? await sh('sudo', ['-n', '-u', 'nobody', 'env', '-i', ...env, 'timeout', String(secs), ...cmd]) : await sh('env', ['-i', ...env, 'timeout', String(secs), ...cmd]);
  const files = [];
  for (const n of readdirSync(WD)) {
    if (n.startsWith('_main.') || n === 'inputs' || n.startsWith('.')) continue;
    let st; try { st = statSync(WD + '/' + n); } catch { continue; } if (!st.isFile() || before.get(n) === st.mtimeMs) continue;
    const f = registerTop(n); if (f) files.push(f);
  }
  return { code: out.code, out: out.out, files };
}

const safe = (rel) => { const p = presolve(WD, String(rel || '').replace(/^\/+/, '')); if (relative(WD, p).startsWith('..')) throw new Error('path must stay inside the work folder'); return p; };
const fs = {
  async write(rel, content, append) {
    const p = safe(rel); mkdirSync(dirname(p), { recursive: true }); if (append && existsSync(p)) appendFileSync(p, content); else writeFileSync(p, content);
    try { chmodSync(p, 0o666); let d = dirname(p); while (d.length > WD.length) { chmodSync(d, 0o777); d = dirname(d); } } catch { }
    const top = dirname(p) === WD ? registerTop(relative(WD, p)) : null;
    return { msg: (append ? 'Appended to ' : 'Wrote ') + relative(WD, p) + ' (now ' + statSync(p).size + ' bytes)' + (top ? ' — will be sent to the user' : ''), file: top };
  },
  async read(rel) {
    const p = safe(rel);
    if (String(rel).endsWith('/') || (existsSync(p) && statSync(p).isDirectory())) return readdirSync(p).filter(n => !n.startsWith('.')).map(n => { const s = statSync(p + '/' + n); return (s.isDirectory() ? n + '/' : n + ' (' + s.size + ' B)'); }).join('\n') || '(empty)';
    if (!existsSync(p)) return 'No such file: ' + rel;
    return readFileSync(p, 'utf8');
  },
};

// ---- v5.3: persistent workspace helpers (the work folder IS the user's workspace; packed into KV between jobs) ----
const JANUS_DIR = WD + '/.janus';
const BUILTIN_SKILLS = new URL('./skills/', import.meta.url).pathname;
function parseSkill(txt, fallbackName) { const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(txt); const meta = {}; if (m) for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } return { name: meta.name || fallbackName, description: meta.description || '', body: (m ? m[2] : txt).trim() }; }
const skills = {
  list() { const out = new Map(); for (const [dir, own] of [[BUILTIN_SKILLS, false], [JANUS_DIR + '/skills', true]]) { try { for (const f of readdirSync(dir)) if (f.endsWith('.md')) { const k = parseSkill(readFileSync(dir + '/' + f, 'utf8'), f.slice(0, -3)); out.set(k.name, { ...k, own }); } } catch { } } return [...out.values()]; },
  get(name) { const n = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-'); return this.list().find(k => k.name === n || k.name === name) || null; },
  save(name, description, body) { const n = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); if (!n) throw new Error('skill needs a name'); mkdirSync(JANUS_DIR + '/skills', { recursive: true }); writeFileSync(JANUS_DIR + '/skills/' + n + '.md', `---\nname: ${n}\ndescription: ${String(description || '').replace(/\n/g, ' ').slice(0, 200)}\n---\n${String(body || '').slice(0, 20000)}\n`); return n; },
};
const installs = {
  file: JANUS_DIR + '/installs.json',
  get() { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return { apt: [], pip: [], npm: [] }; } },
  add(kind, names) { const o = this.get(); o[kind] = [...new Set([...(o[kind] || []), ...names])].slice(-60); mkdirSync(JANUS_DIR, { recursive: true }); writeFileSync(this.file, JSON.stringify(o)); },
};
async function pipInstall(names, secs = 900) { return runCode('bash', 'python3 -m pip install --user --quiet --disable-pip-version-check --break-system-packages ' + names.map(n => "'" + n.replace(/'/g, '') + "'").join(' ') + ' 2>&1 | tail -n 25', secs, [], new Map()); }
async function npmInstall(names, secs = 600) { return runCode('bash', 'npm install -g --silent --prefix "$HOME/.local" ' + names.map(n => "'" + n.replace(/'/g, '') + "'").join(' ') + ' 2>&1 | tail -n 25', secs, [], new Map()); }
function wsSummary() {
  let top = []; try { top = readdirSync(WD).filter(n => !n.startsWith('.') && !n.startsWith('_main.') && n !== 'inputs').slice(0, 40).map(n => { try { const s = statSync(WD + '/' + n); return s.isDirectory() ? n + '/' : n + ' (' + (s.size > 1e6 ? (s.size / 1e6).toFixed(1) + ' MB' : Math.ceil(s.size / 1e3) + ' KB') + ')'; } catch { return n; } }); } catch { }
  let inputs = []; try { inputs = readdirSync(WD + '/inputs').slice(0, 20); } catch { }
  const ins = installs.get(); const ks = skills.list();
  return { top, inputs, installs: ins, skills: ks.map(k => ({ name: k.name, description: k.description, own: k.own })) };
}
async function packHome(prevHash) { // → {path, bytes, hash} or null; v6.0: hash first (cheap), tar only when something changed
  const h = await sh('bash', ['-c', `cd "${WD}" && find . -type f ! -path './inputs/*' ! -path './.cache/*' ! -path './.npm/*' ! -name '_main.*' -printf '%p %s %T@\\n' 2>/dev/null | sort | md5sum | cut -c1-32; find . -type f ! -path './inputs/*' 2>/dev/null | wc -l`]);
  const [hash, files] = h.out.trim().split('\n'); if (prevHash && hash === prevHash) return { hash, unchanged: true };
  const ex = ['--exclude=./inputs', '--exclude=./_main.*', '--exclude=./.cache', '--exclude=./.npm', '--exclude=./.gradle', '--exclude=./.android', '--exclude=*/node_modules/.cache', '--exclude=./.local/lib/python3*/site-packages', '--exclude=./.local/lib/node_modules'];
  let t = await sh('tar', [...ex, '-czf', '/tmp/home.tgz', '-C', WD, '.']); let st; try { st = statSync('/tmp/home.tgz'); } catch { return null; }
  if (t.code !== 0) return null;
  if (st.size > 23e6) { t = await sh('bash', ['-c', `cd "${WD}" && find . -type f -size -4M ! -path './inputs/*' ! -path './.cache/*' ! -path './.npm/*' ! -path './.gradle/*' ! -path './.local/lib/*' ! -name '_main.*' | head -5000 > /tmp/home.list && tar -czf /tmp/home.tgz -T /tmp/home.list`]); try { st = statSync('/tmp/home.tgz'); } catch { return null; } if (st.size > 23e6) return null; }
  return { path: '/tmp/home.tgz', bytes: st.size, hash: hash || '', files: +files || 0 };
}
const fsx = {
  async edit(rel, oldT, newT) { const p = safe(rel); if (!existsSync(p)) return 'No such file: ' + rel; const t = readFileSync(p, 'utf8'); const n = t.split(String(oldT)).length - 1; if (!oldT || n === 0) return 'old_text not found in ' + rel + ' (read_file it and copy the exact text)'; if (n > 1) return 'old_text appears ' + n + ' times in ' + rel + '; give a longer unique piece'; writeFileSync(p, t.replace(String(oldT), () => String(newT ?? ''))); return 'Edited ' + rel; },
  send(rel) { const p = safe(rel); if (!existsSync(p) || !statSync(p).isFile()) return { msg: 'No such file: ' + rel }; let name = relative(WD, p); if (name.includes('/')) { const base = name.split('/').pop(); writeFileSync(WD + '/' + base, readFileSync(p)); name = base; } const f = registerTop(name); return f ? { msg: 'Sent ' + name + ' to the user', file: f } : { msg: 'Cannot send ' + name + ' (unknown type or > 24 MB)' }; },
};

// ---- self-test: phone-sized headless Chromium, screenshots, errors, vision critique ----
const CHECK = `Quality checklist: fills the phone screen in portrait (no letterbox/black bars, no tiny canvas), clear start screen, swipe/touch controls (no reliance on tiny arrow buttons), in-page game-over screen with score + retry (never alert()), a real-looking player/world (not a blob), HUD readable with safe-area padding, sound + mute, difficulty ramps up, smooth animation, no JS errors. Note: □ boxes in place of emoji are only a missing font on the test machine (phones show emoji) — ignore them.`;
let llmRef = null;
async function testWebApp(rel, focus, task) {
  let file; try { file = safe(rel); } catch (e) { return { text: String(e.message) }; }
  if (!existsSync(file)) return { text: 'File not found: ' + rel + '. Write it first with write_file.' };
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [], dialogs = [];
  try {
    const p = await b.newPage();
    await p.emulate({ viewport: { width: 412, height: 915, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' });
    p.on('pageerror', e => errors.push(String(e.message || e).slice(0, 220)));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 220)); });
    p.on('dialog', async d => { dialogs.push(d.type() + ': ' + d.message().slice(0, 80)); await d.dismiss().catch(() => { }); });
    await p.goto('file://' + file, { waitUntil: 'load', timeout: 30000 }).catch(e => errors.push('load: ' + e.message));
    await sleep(1500);
    const shots = []; const within = (pr, ms) => Promise.race([pr, sleep(ms).then(() => { throw new Error('timeout'); })]);
    const snap = async (lbl) => { try { shots.push({ lbl, b64: await within(p.screenshot({ type: 'jpeg', quality: 72, encoding: 'base64' }), 25000) }); } catch { errors.push('(screenshot "' + lbl + '" timed out: the page is very slow or frozen)'); } };
    const metrics = () => within(p.evaluate(() => {
      const vw = innerWidth, vh = innerHeight; let best = null, area = 0;
      for (const c of document.querySelectorAll('canvas,svg,#game,.game,#app,main')) { const r = c.getBoundingClientRect(); const a = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)); if (a > area) { area = a; best = c.tagName.toLowerCase() + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); } }
      const btn = [...document.querySelectorAll('button,[role=button]')].filter(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }).map(e => (e.innerText || e.getAttribute('aria-label') || '?').trim().slice(0, 18));
      const src = [...document.scripts].map(s => s.textContent).join('\n');
      return { viewport: vw + 'x' + vh, main_element: best, screen_use_pct: Math.round(100 * area / (vw * vh)), meta_viewport: !!document.querySelector('meta[name=viewport]'), page_scrolls: document.documentElement.scrollHeight > vh + 4 || document.documentElement.scrollWidth > vw + 4, visible_buttons: btn.slice(0, 12), uses_alert: /\b(alert|confirm|prompt)\s*\(/.test(src), touch_handlers: /touchstart|pointerdown|pointermove|touchmove/.test(src), web_audio: /AudioContext/.test(src), raf: /requestAnimationFrame/.test(src) };
    }), 15000).catch(e => ({ error: 'page did not respond: ' + String(e.message) }));
    await snap('1 start screen'); const m1 = await metrics();
    const started = await p.evaluate(() => { const re = /^(▶\s*)?(play|start|tap to (start|play)|begin|new game|shuru|khelo|let'?s go)/i; const b = [...document.querySelectorAll('button,[role=button],a,.btn,div,span')].find(e => re.test((e.innerText || '').trim()) && e.children.length < 3 && e.getBoundingClientRect().width > 0); if (b) { b.click(); return (b.innerText || '').trim().slice(0, 20); } return ''; }).catch(() => '');
    if (!started) await p.touchscreen.tap(206, 560).catch(() => { });
    await sleep(1300); await snap('2 after start');
    const cdp = await p.createCDPSession();
    const swipe = async (x1, y1, x2, y2) => { try { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] }); for (let k = 1; k <= 6; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + (x2 - x1) * k / 6, y: y1 + (y2 - y1) * k / 6 }] }); await sleep(16); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); } catch { } };
    for (const [dx, dy] of [[-150, 0], [150, 0], [0, -220], [0, 220], [-150, 0]]) { await swipe(206, 520, 206 + dx, 520 + dy); await sleep(450); }
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space']) { await p.keyboard.press(k).catch(() => { }); await sleep(250); }
    await sleep(1200); await snap('3 playing, after swipes');
    await sleep(7000); await snap('4 after ~12 s');
    const m2 = await metrics();
    // one montage image for the reviewer and the user
    let montage = null;
    if (shots.length) {
      const mp = await b.newPage(); await mp.setViewport({ width: 412 * shots.length + 10 * (shots.length + 1), height: 960, deviceScaleFactor: 1 });
      await mp.setContent(`<body style="margin:0;background:#e9e9ee;font:14px sans-serif;display:flex;gap:10px;padding:10px">${shots.map(s => `<div><div style="height:24px">${s.lbl}</div><img style="width:412px;height:915px;display:block;border-radius:12px" src="data:image/jpeg;base64,${s.b64}"></div>`).join('')}</body>`);
      await sleep(300); montage = await within(mp.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64', fullPage: true }), 30000).catch(() => null);
    }
    const facts = { start_button_clicked: started || '(none found, tapped the screen)', js_errors: [...new Set(errors)].slice(0, 8), dialogs_alerts: dialogs.slice(0, 5), start: m1, after_play: m2 };
    let critique = '';
    if (montage && llmRef) {
      try {
        const r = await llmRef([{ role: 'user', parts: [{ text: `You are a strict senior mobile game/app reviewer. The user asked for: "${String(task).slice(0, 600)}". These are 4 screenshots of the build on a phone (412x915 portrait), left to right: start, after pressing start, after swipe gestures, ~12 s later.${focus ? ' Focus this round: ' + focus + '.' : ''}\nMeasured facts: ${JSON.stringify(facts)}\n${CHECK}\nReply in this exact format:\nVERDICT: PASS or NEEDS WORK\nSCORES: layout x/10, controls x/10, visuals x/10, game-feel x/10\nPROBLEMS: numbered list of the concrete problems you SEE (be specific: what, where)\nFIXES: numbered list of exact code-level fixes, most important first (max 6).` }, { inlineData: { mimeType: 'image/jpeg', data: montage } }] }], [], { route: 'vision', timeoutMs: 120000 });
        critique = (r.parts || []).map(x => x.text || '').join('').trim();
      } catch (e) { critique = '(vision reviewer unavailable: ' + String(e.message).slice(0, 80) + ') Judge from the facts.'; }
    }
    const shotId = montage ? 'img_' + rid() : null; if (shotId) images.set(shotId, { bytes: unb64(montage), mime: 'image/jpeg', name: 'selftest.jpg' });
    const verdict = (/VERDICT:\s*(PASS|NEEDS WORK)/i.exec(critique) || [])[1] || '';
    return { text: 'SELF-TEST RESULT for ' + rel + '\nFACTS: ' + JSON.stringify(facts) + '\nREVIEW:\n' + (critique || '(no review)') + '\nNow fix every real problem, then run test_web_app again.', errors: facts.js_errors, verdict, shotId, shotB64: montage };
  } finally { try { await b.close(); } catch { } }
}

// ---- real Chrome extensions for the cloud browser (unpacked zip or .crx) ----
// Branded Google Chrome ≥137 ignores --load-extension, so extensions run in Chrome for Testing (downloaded on demand).
async function prepChromeExts(list, fetchImpl = fetch) {
  const dirs = []; const names = [];
  for (const e of (list || []).slice(0, 6)) {
    try {
      const r = await fetchImpl(e.url, { signal: AbortSignal.timeout(60000) }); if (!r.ok) continue;
      let b = new Uint8Array(await r.arrayBuffer()); if (b.length > 40e6) continue;
      if (b[0] === 0x43 && b[1] === 0x72 && b[2] === 0x32 && b[3] === 0x34) { // "Cr24" CRX header → strip to the zip
        const dv = new DataView(b.buffer, b.byteOffset); const ver = dv.getUint32(4, true);
        b = ver === 3 ? b.slice(12 + dv.getUint32(8, true)) : b.slice(16 + dv.getUint32(8, true) + dv.getUint32(12, true));
      }
      const id = String(e.id || rid()).replace(/[^\w-]/g, '').slice(0, 40) || rid(); const dir = '/tmp/janus-ext/' + id;
      mkdirSync(dir, { recursive: true }); writeFileSync(dir + '.zip', b);
      await sh('unzip', ['-o', '-q', dir + '.zip', '-d', dir]);
      if (existsSync(dir + '/manifest.json')) { dirs.push(dir); names.push(e.name || id); }
    } catch { }
  }
  if (!dirs.length) return null;
  let exe = process.env.JANUS_EXT_CHROME || null;
  if (!exe) {
    const r = await sh('npx', ['-y', '@puppeteer/browsers@2', 'install', 'chrome@stable', '--path', '/tmp/cft'], { cwd: '/tmp' });
    const m = /chrome@\S+\s+(\S+)/.exec(r.out || ''); if (m && existsSync(m[1])) exe = m[1];
  }
  if (!exe) return null;
  return { exe, names, args: ['--disable-extensions-except=' + dirs.join(','), '--load-extension=' + dirs.join(',')] };
}



// ---- v5.1 download_file: public videos via yt-dlp (≤720p, ≤24 MB), direct links via fetch → top-level file → sent to the phone ----
const VIDEO_RX = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|x\.com|twitter\.com|facebook\.com|fb\.watch|tiktok\.com|vimeo\.com|dailymotion\.com|reddit\.com|pinterest\.com|twitch\.tv|soundcloud\.com)$/i;
const MAX_DL = 24e6;
let ytdlp = null;
async function getYtDlp() {
  if (ytdlp) return ytdlp;
  const p = '/tmp/yt-dlp';
  if (!existsSync(p)) {
    const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', { redirect: 'follow' });
    if (!r.ok) throw new Error('could not get yt-dlp (' + r.status + ')');
    writeFileSync(p, Buffer.from(await r.arrayBuffer())); chmodSync(p, 0o755);
  }
  return (ytdlp = p);
}
const cleanName = (n, ext) => { let b = String(n || '').replace(/[^\w.() -]/g, '_').replace(/^\.+/, '').slice(0, 80); if (!b) b = 'download'; if (ext && !/\.[a-z0-9]{2,5}$/i.test(b)) b += '.' + ext; return b; };
async function download(url, name) {
  let u; try { u = new URL(url); } catch { return { msg: 'Not a valid URL: ' + url }; }
  if (!/^https?:$/.test(u.protocol)) return { msg: 'Only http(s) links.' };
  if (VIDEO_RX.test(u.hostname) && !/\.(mp4|webm|mov|m4a|mp3)$/i.test(u.pathname)) {
    let bin; try { bin = await getYtDlp(); } catch (e) { return { msg: 'ERROR: ' + e.message }; }
    const out = cleanName(name ? name.replace(/\.[a-z0-9]{2,5}$/i, '') : 'video', '') ;
    const base = ['--no-playlist', '--playlist-items', '1', '--no-progress', '--restrict-filenames', '--js-runtimes', 'node', '-f', 'b[ext=mp4][height<=720][filesize<24M]/b[ext=mp4][height<=720]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b', '--merge-output-format', 'mp4', '--max-filesize', '24M', '-o', out + '.%(ext)s', url];
    const tries = [base, ['--extractor-args', 'youtube:player_client=tv,web_safari,android_vr', ...base], ['--extractor-args', 'youtube:player_client=mweb,ios', ...base]];
    let last = '';
    for (const args of tries) {
      for (const f of readdirSync(WD)) if (f.startsWith(out + '.')) { try { unlinkSync(WD + '/' + f); } catch { } }
      const r = await sh('timeout', ['600', bin, ...args]);
      const got = readdirSync(WD).filter(f => f.startsWith(out + '.') && !/\.part$|\.ytdl$|\.f\d+\./.test(f));
      if (r.code === 0 && got.length) {
        const fn = got.find(f => /\.mp4$/.test(f)) || got[0]; const st = statSync(WD + '/' + fn);
        if (st.size > MAX_DL) return { msg: 'Video is ' + Math.round(st.size / 1e6) + ' MB (limit 24 MB for the chat). Try a shorter clip.' };
        const reg = registerTop(fn); if (!reg) return { msg: 'Downloaded ' + fn + ' but could not attach it (type/size).' };
        return { msg: 'DOWNLOADED ' + fn + ' (' + (st.size / 1e6).toFixed(1) + ' MB) — it is sent to the user in the chat automatically.', file: reg };
      }
      last = (r.out || '').split('\n').filter(l => /ERROR|WARNING: .*(sign in|bot|private|unavailable)/i.test(l)).slice(-2).join(' ') || ('exit ' + r.code);
    }
    return { msg: 'ERROR: could not download the video: ' + last.slice(0, 300) + (/bot|sign in/i.test(last) ? ' (the site blocks downloads from cloud servers right now; tell the user plainly).' : '') };
  }
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(300000) });
    if (!r.ok) return { msg: 'ERROR: HTTP ' + r.status };
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct === 'text/html') return { msg: 'ERROR: that link is a web page, not a file. Find the direct file link (or a video page for yt-dlp).' };
    const len = +(r.headers.get('content-length') || 0); if (len > MAX_DL) return { msg: 'File is ' + Math.round(len / 1e6) + ' MB (limit 24 MB).' };
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > MAX_DL) return { msg: 'File is too big (limit 24 MB).' };
    const ext = (Object.entries(MIME).find(([, m]) => m === ct) || [])[0] || (u.pathname.split('.').pop() || '').toLowerCase();
    let fn = cleanName(name || decodeURIComponent(u.pathname.split('/').pop() || ''), MIME[ext] ? ext : '');
    if (!MIME[(fn.split('.').pop() || '').toLowerCase()]) fn = fn + '.' + (MIME[ext] ? ext : 'zip'); // unknown type: wrap name so it is attachable
    writeFileSync(WD + '/' + fn, buf); try { chmodSync(WD + '/' + fn, 0o644); } catch { }
    const reg = registerTop(fn); if (!reg) return { msg: 'Saved ' + fn + ' but this file type cannot be attached.' };
    return { msg: 'DOWNLOADED ' + fn + ' (' + (buf.length / 1e6).toFixed(1) + ' MB) — sent to the user in the chat automatically.', file: reg };
  } catch (e) { return { msg: 'ERROR: ' + String(e && e.message || e).slice(0, 200) }; }
}

export function setLLM(f) { llmRef = f; }
export { CHROME, WD, MIME, images, registerTop, sh, runCode, fs, testWebApp, prepChromeExts, download, skills, installs, pipInstall, npmInstall, wsSummary, packHome, fsx };
