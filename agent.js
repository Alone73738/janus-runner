// JANUS Cloud agent core: portable (Cloudflare Worker + Node test harness).
// ctx = { gemini(key-less fetch wrapper), ai (Workers AI binding, optional), browser() -> puppeteer Browser,
//         logins: {get(site)}, images: {put(bytes,mime)->id, get(id)}, log(fn), now() }

export const GEMINI_MODELS = [
  'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest', 'gemma-4-26b-a4b-it',
];

const S = (o) => JSON.stringify(o);
const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');

export const TOOLS = [
  { name: 'web_search', description: 'Search the web. Returns top results with snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_url', description: 'Read a web page as plain text (fast, no browser).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'generate_image', description: 'Create an image from a prompt. Returns image_id to use with upload_image.', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'open_url', description: 'Open a URL in the cloud browser. Returns title + numbered elements.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'list_elements', description: 'List numbered interactive elements of the current page.', parameters: { type: 'object', properties: {} } },
  { name: 'click_element', description: 'Click element by number.', parameters: { type: 'object', properties: { element_id: { type: 'integer' } }, required: ['element_id'] } },
  { name: 'type_into', description: 'Type normal text into element (never passwords/OTP).', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, text: { type: 'string' }, press_enter: { type: 'boolean' } }, required: ['element_id', 'text'] } },
  { name: 'select_option', description: 'Choose an option in a dropdown element.', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, option: { type: 'string' } }, required: ['element_id', 'option'] } },
  { name: 'scroll_page', description: 'Scroll down or up.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } } } },
  { name: 'read_page', description: 'Read visible text of the current page.', parameters: { type: 'object', properties: {} } },
  { name: 'look_at_screen', description: 'Take a screenshot of the current page and look at it.', parameters: { type: 'object', properties: {} } },
  { name: 'sign_in', description: 'Sign in on the current page with the saved login for this site: fills email/username + password and presses the sign-in button. You never see the password. Call when a login form is visible (call again on a second password page).', parameters: { type: 'object', properties: {} } },
  { name: 'upload_image', description: 'Put a generated image or a file from run_code (its id) into a file-upload element.', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, image_id: { type: 'string' } }, required: ['element_id', 'image_id'] } },
  { name: 'run_code', description: 'Run code on the cloud computer (Linux, Python 3, Node 20, ffmpeg if installed; internet on; pip install --user / npm i allowed; no sudo). Use for big scripts, data work, image/video editing (Pillow, ffmpeg, moviepy), making files. Files you save in the current folder come back as file ids (images/videos can then go to upload_image). Input files: generated images are in ./inputs/<image_id>.<ext>.', parameters: { type: 'object', properties: { language: { type: 'string', enum: ['python', 'node', 'bash'] }, code: { type: 'string' }, timeout_sec: { type: 'integer' } }, required: ['language', 'code'] } },
  { name: 'finish', description: 'Task done (or impossible). Give the final short result for the user.', parameters: { type: 'object', properties: { result: { type: 'string' }, success: { type: 'boolean' } }, required: ['result', 'success'] } },
];

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
function sysPrompt(task, nowIso, loginSites) {
  return `You are JANUS Cloud, the background worker of the JANUS app. You run a scheduled task by yourself while the user's phone may be off, so nobody can answer questions: decide sensibly and finish.
Now: ${nowIso} (user timezone Asia/Kolkata).
Saved logins you can use with sign_in: ${loginSites && loginSites.length ? loginSites.join(', ') : 'NONE'}. If the task needs a site that is not in this list and it asks you to log in, do not guess: finish(success=false) saying exactly: "<site> ka login cloud mein share nahi hai. JANUS → Scheduled → Logins mein Share dabao." Saved browser cookies may already keep you logged in, so open the site first and check.
Rules: use tools; be efficient; in the browser use open_url, list_elements, click/type by element number; for login forms call sign_in (you never see passwords); if a site needs an OTP/captcha/approval you cannot do, call finish with success=false and say what is needed. Never invent results. Never stop silently: every reply must call a tool, and the last one must be finish. On failure, say the exact reason and what the user should do. Always end with finish(result) in the user's language (short Hinglish if the task is Hinglish).
${SITE_TIPS}
TASK: ${task}`;
}

export async function runAgent(ctx, task, opts = {}) {
  const maxSteps = opts.maxSteps || 25;
  const steps = []; const images = [];
  let browser = null, page = null;
  const getPage = async () => {
    if (page) return page;
    browser = await ctx.browser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
    if (ctx.cookies && ctx.cookies.length) { try { const c = await page.createCDPSession(); await c.send('Network.setCookies', { cookies: ctx.cookies }); } catch { } }
    return page;
  };
  const el = async (id) => { const p = await getPage(); const h = await p.$(`[data-jn="${id}"]`); if (!h) throw new Error('element ' + id + ' not found; call list_elements'); return h; };
  const settle = async (p) => { try { await p.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }); } catch { } };

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
    look_at_screen: async () => { const p = await getPage(); const b64 = await p.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' }); return { text: 'screenshot attached', image: b64 }; },
    sign_in: async () => {
      const p = await getPage(); const site = siteKey(p.url()); const cred = await ctx.logins.get(site);
      if (!cred) return 'No saved login for ' + site + '. Ask the user (in finish) to add it in JANUS → Cloud tasks → Logins.';
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
      if (st.otp && !st.pw) return 'LOGIN NEEDS A CODE on ' + site + ': the site asks for a verification code (sent to the user\'s email/phone). You cannot get it. finish(success=false, "' + site + ' ne verification code maanga. Phone pe ek baar ' + site + ' mein login karke approve karo, phir JANUS → Scheduled → Run dabao").';
      if (st.err && (st.pw || onLogin)) return 'LOGIN FAILED on ' + site + ': page says "' + st.err + '". Do not retry more than once. If it is about password/email → finish(success=false, "' + site + ' ka saved password galat hai, JANUS → Scheduled → Logins mein sahi login dobara Share karo"). If it is a code/captcha/verification → finish(success=false) asking the user to log in once on their phone and approve.';
      if (st.pw && /password/.test(r) ) return 'LOGIN NOT CONFIRMED: still on a page with a password box (' + st.url + '). Call look_at_screen to see why (error, captcha, extra step).';
      if (st.pw && !/password/.test(r)) return 'Filled ' + r + ' and pressed ' + (how || 'Enter') + '. Now a password page is shown: call sign_in again.';
      return 'LOGIN OK: ' + site + ' accepted the sign-in. Now on: ' + st.url + (st.url === before ? ' (same URL; verify with list_elements that you are logged in)' : '');
    },
    run_code: async ({ language, code, timeout_sec }) => {
      if (!ctx.runCode) return 'run_code is not available on this runner (only on the GitHub runner).';
      const r = await ctx.runCode(language, String(code || ''), Math.min(Math.max(+timeout_sec || 120, 10), 600), images);
      for (const f of r.files || []) if (f.mime.startsWith('image/')) images.push(f.id);
      return 'exit ' + r.code + '\n' + clip(r.out || '', 5000) + (r.files && r.files.length ? '\nFILES: ' + r.files.map(f => f.name + ' → ' + f.id + ' (' + f.mime + ', ' + f.bytes + ' bytes)').join(', ') : '');
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
  };

  const loginSites = ctx.logins.list ? await ctx.logins.list() : [];
  const contents = [{ role: 'user', parts: [{ text: sysPrompt(task, new Date(ctx.now()).toISOString(), loginSites) }] }];
  let result = null, nudges = 0, checks = 0;
  try {
    for (let i = 0; i < maxSteps && !result; i++) {
      ctx.log && ctx.log('llm', {step: i});
      const resp = await ctx.llm(contents, ctx.runCode ? TOOLS : TOOLS.filter(t => t.name !== 'run_code'));
      const parts = resp.parts || [];
      contents.push({ role: 'model', parts });
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length) {
        const t = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
        if (nudges < 2) { nudges++; contents.push({ role: 'user', parts: [{ text: 'Continue the task now: call the next tool. When fully done (or truly impossible), call finish with the result' + (t ? '' : ' and the exact reason') + '.' }] }); continue; }
        result = { success: false, result: t || 'Task beech mein ruk gaya (AI ne jawab nahi diya). Dobara Run karke dekho.' }; break;
      }
      const outs = [];
      for (const c of calls) {
        const { name, args = {} } = c.functionCall;
        if (name === 'finish') {
          const claim = { success: args.success !== false, result: String(args.result || '') };
          if (claim.success && checks < 2) {
            const v = await verify(ctx, task, steps, claim.result);
            if (!v.ok) { checks++; outs.push({ functionResponse: { name, response: { result: 'NOT ACCEPTED by checker: ' + v.reason + '. The task is not done yet. Do the missing step now, or finish(success=false) with the exact reason.' } } }); steps.push({ tool: 'checker', args: {}, out: clip('rejected: ' + v.reason, 200) }); continue; }
          } else if (claim.success && checks >= 2) { const v = await verify(ctx, task, steps, claim.result); if (!v.ok) { claim.success = false; claim.result = 'Task poora nahi hua: ' + v.reason; } }
          result = claim; break;
        }
        let out, img = null;
        ctx.log && ctx.log('call:' + name, args);
        try { const f = impl[name]; if (!f) throw new Error('unknown tool'); out = await f(args); if (out && typeof out === 'object') { img = out.image; out = out.text; } }
        catch (e) { out = 'ERROR: ' + (e && e.message || e); }
        steps.push({ tool: name, args: redact(args), out: clip(String(out), 400) });
        ctx.log && ctx.log(name, args, out);
        outs.push({ functionResponse: { name, response: { result: clip(String(out), 7000) } } });
        if (img) outs.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
      }
      if (!result) contents.push({ role: 'user', parts: outs });
    }
  } finally {
    if (page && ctx.saveCookies) { try { const c = await page.createCDPSession(); const { cookies } = await c.send('Network.getAllCookies'); await ctx.saveCookies(cookies); } catch { } }
    try { if (browser) await browser.close(); } catch { }
  }
  if (!result) result = { success: false, result: 'Step limit khatam ho gaya, task poora nahi hua. Steps: ' + steps.slice(-3).map(x => x.tool).join(' → ') };
  return { ...result, steps, images, model: ctx.lastModel && ctx.lastModel() };
}

// Checker: never let the agent claim a success its own steps don't show.
export async function verify(ctx, task, steps, claim) {
  const t = task.toLowerCase(); const names = steps.map(s => s.tool);
  const negated = /(do ?n.?t|do not|never|without|mat|nahi|na)\s+(publish|post|upload|daal|dal)/.test(t);
  const wantsPost = !negated && /upload|post|publish|pin\b|pins\b|share on|daalo|dalo|kar do.*(pinterest|instagram|youtube)/.test(t) && /pinterest|instagram|youtube|facebook|twitter|\bx\b|reddit|linkedin|tumblr|site|account/.test(t);
  if (wantsPost) {
    const up = steps.findIndex(s => s.tool === 'upload_image' && /^image put/.test(s.out));
    if (/image|wallpaper|photo|pic/.test(t) && up < 0) return { ok: false, reason: 'no image was uploaded to the site (upload_image never succeeded)' };
    if (up >= 0 && !steps.slice(up + 1).some(s => s.tool === 'click_element')) return { ok: false, reason: 'the image was put in but Publish/Post was never clicked' };
  }
  if (steps.some(s => /^LOGIN FAILED/.test(s.out)) && !steps.some(s => /^LOGIN OK/.test(s.out))) return { ok: false, reason: 'login failed' };
  try {
    const log = steps.map((s, i) => (i + 1) + '. ' + s.tool + ' ' + JSON.stringify(s.args).slice(0, 120) + ' => ' + s.out.replace(/\s+/g, ' ').slice(0, 160)).join('\n');
    const r = await ctx.llm([{ role: 'user', parts: [{ text: 'You are a strict checker. TASK:\n' + task + '\n\nSTEPS the agent actually did:\n' + log + '\n\nAGENT CLAIMS: ' + claim + '\n\nDo the steps PROVE every part of the task was really done (e.g. a post really published, not just a page opened)? Reply ONLY JSON: {"done": true|false, "reason": "short missing part"}' }] }], []);
    const txt = (r.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    if (j.done === false) return { ok: false, reason: String(j.reason || 'steps do not show the task was completed').slice(0, 200) };
  } catch { }
  return { ok: true };
}

function redact(a) { const o = { ...a }; if (o.text && String(o.text).length > 80) o.text = String(o.text).slice(0, 80) + '…'; return o; }
export function btoaBytes(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

// ---- LLM: Gemini (fallback chain) then Workers AI ----
export function makeLLM({ geminiKey, ai, fetchImpl = fetch, models = GEMINI_MODELS, keyInHeader = true }) {
  let last = null;
  const llm = async (contents, tools) => {
    let lastErr;
    for (let round = 0; round < 3; round++) {
      try { return await once(contents, tools); } catch (e) { lastErr = e; if (!/429|empty|50\d|fetch/i.test(e.message)) break; await new Promise(r => setTimeout(r, 8000 * (round + 1))); }
    }
    throw lastErr;
  };
  const once = async (contents, tools) => {
    const errs = [];
    if (geminiKey !== null) for (const m of models) {
      const gemma = m.startsWith('gemma');
      const cts = (last && last !== m) ? contents.map(c => ({ role: c.role, parts: c.parts.map(p => p.thoughtSignature ? { ...p, thoughtSignature: 'skip_thought_signature_validator' } : p) })) : contents;
      const body = { contents: gemma ? cts.map(stripImg) : cts, ...(tools && tools.length ? { tools: [{ functionDeclarations: tools }] } : {}), generationConfig: { temperature: 0.3 } };
      const headers = { 'content-type': 'application/json' }; if (keyInHeader && geminiKey) headers['x-goog-api-key'] = geminiKey;
      try {
        const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers, body: S(body) });
        if (!r.ok) { errs.push(m + ':' + r.status); continue; }
        const j = await r.json(); const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
        if (!parts || !parts.length) { errs.push(m + ':empty(' + (j.candidates && j.candidates[0] && j.candidates[0].finishReason || (j.promptFeedback && j.promptFeedback.blockReason) || '?') + ')'); continue; }
        last = m; return { parts };
      } catch (e) { errs.push(m + ':' + e.message); }
    }
    if (ai) { const r = await workersAI(ai, contents, tools); last = 'workers-ai'; return r; }
    throw new Error('All models failed: ' + errs.join(', '));
  };
  llm.lastModel = () => last;
  return llm;
}
function stripImg(c) { return { role: c.role, parts: c.parts.filter(p => !p.inlineData) }; }

const WAI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
async function workersAI(ai, contents, tools) {
  const messages = [];
  for (const c of contents) for (const p of c.parts) {
    if (p.text) messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: p.text });
    else if (p.functionCall) messages.push({ role: 'assistant', content: 'CALL ' + S(p.functionCall) });
    else if (p.functionResponse) messages.push({ role: 'user', content: 'RESULT of ' + p.functionResponse.name + ': ' + p.functionResponse.response.result });
  }
  const r = await ai.run(WAI_MODEL, { messages, tools: tools.map(t => ({ type: 'function', function: t })), max_tokens: 1200 });
  const tc = r.tool_calls || (r.response && r.response.tool_calls) || [];
  if (tc.length) return { parts: tc.slice(0, 1).map(t => ({ functionCall: { name: t.name || (t.function && t.function.name), args: typeof (t.arguments || (t.function && t.function.arguments)) === 'string' ? JSON.parse(t.arguments || t.function.arguments) : (t.arguments || {}) } })) };
  let txt = typeof r.response === 'string' ? r.response : S(r.response || r);
  const call = firstJsonCall(txt); if (call) return { parts: [{ functionCall: call }] };
  return { parts: [{ text: txt }] };
}

export function firstJsonCall(txt) {
  for (let i = txt.indexOf('{'); i >= 0; i = txt.indexOf('{', i + 1)) {
    let d = 0, inS = false, esc = false;
    for (let k = i; k < txt.length; k++) {
      const ch = txt[k];
      if (inS) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inS = false; continue; }
      if (ch === '"') inS = true; else if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) { try { const x = JSON.parse(txt.slice(i, k + 1)); if (x && x.name && TOOLS.some(t => t.name === x.name)) return { name: x.name, args: x.args || x.arguments || x.parameters || {} }; } catch { } break; } }
    }
  }
  return null;
}
