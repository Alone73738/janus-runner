// JANUS runner tools (shared by run.mjs and the local test harness).
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve as presolve, relative } from 'node:path';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && existsSync(p));
const WD = process.env.JANUS_WD || '/tmp/janus-work';
const MIME = { apk: 'application/vnd.android.package-archive', aab: 'application/octet-stream', zip: 'application/zip', tgz: 'application/gzip', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', py: 'text/x-python', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', svg: 'image/svg+xml' };
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


export function setLLM(f) { llmRef = f; }
export { CHROME, WD, MIME, images, registerTop, sh, runCode, fs, testWebApp };
