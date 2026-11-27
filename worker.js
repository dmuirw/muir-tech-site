// MUIR Tech worker: the website (static files in ./public) plus
//  - /api/translate              Spanish/Portuguese -> English for the contact form (Workers AI)
//  - /api/auth/*                 customer sign-in: Google, Apple, or a 6-digit code by email (no passwords)
//  - /api/portal/*               the customer's own space: profile, project folders, messages with MUIR Tech
//  - /api/admin/*                David's view: every customer, project and message; add projects; reply
// Data lives in the D1 database bound as DB (tables are created on first use).
// Settings (Cloudflare > Worker > Settings > Variables and secrets), each optional; a feature switches on when its keys are set:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET                         Continue with Google
//   APPLE_SERVICE_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY  Continue with Apple
//   RESEND_API_KEY  (or an EMAIL send binding)                     sign-in codes + "you have a new message" emails
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM                          text messages
//   OWNER_EMAIL (default muirtechnh@gmail.com), OWNER_PHONE         where new-message alerts go
//   OWNER_EMAILS  extra sign-in emails that open the admin view (dmuirw@gmail.com and muirtechnh@gmail.com always do)

const LANGS = { es: 'spanish', pt: 'portuguese' };
const DAYS = 60, CODE_MIN = 15;
const OWNERS = ['dmuirw@gmail.com', 'muirtechnh@gmail.com'];
const FROM = 'MUIR Tech <hello@muirtech.net>';

// ---------- helpers ----------
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const bad = (m, s = 400) => json({ ok: false, error: m }, s);
const okEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e || '');
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function token(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64u(a); }
function six() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 1000000).padStart(6, '0'); }
async function sha(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function b64u(bytes) { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
const jwtPayload = (j) => { try { return JSON.parse(new TextDecoder().decode(unb64u(String(j).split('.')[1]))); } catch { return null; } };
const safeRet = (r) => { r = String(r || '/account'); return /^\/[^/\\]/.test(r) || r === '/' ? r.slice(0, 300) : '/account'; };
const ipOf = (req) => req.headers.get('cf-connecting-ip') || '0';
const cookie = (req, name) => { const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9._~-]+)')); return m ? m[1] : ''; };
const setSession = (s) => `mt_session=${s}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
const googleOn = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const appleOn = (env) => !!(env.APPLE_SERVICE_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
const emailOn = (env) => !!(env.RESEND_API_KEY || env.EMAIL);
const textOn = (env) => !!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM);
const owners = (env) => OWNERS.concat(String(env.OWNER_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean));

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, phone TEXT, notify TEXT DEFAULT \'email\', address TEXT, created INTEGER, last_in INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, email TEXT, created INTEGER, exp INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, h TEXT, exp INTEGER, tries INTEGER DEFAULT 0, ret TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sends (email TEXT, ip TEXT, t INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, title TEXT, kind TEXT, status TEXT DEFAULT \'New request\', details TEXT, created INTEGER, updated INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS projects_email ON projects (email)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, project_id INTEGER, sender TEXT, body TEXT, created INTEGER, seen_customer INTEGER DEFAULT 0, seen_muir INTEGER DEFAULT 0)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS messages_email ON messages (email)'),
  ]);
  ready = true;
}
async function userOf(env, req) {
  const s = cookie(req, 'mt_session'); if (s.length < 30) return null;
  await ensure(env);
  const r = await env.DB.prepare('SELECT email FROM sessions WHERE h=? AND exp>?').bind(await sha('s|' + s), Date.now()).first();
  return r ? r.email : null;
}

// ---------- sending ----------
async function sendEmail(env, to, subject, text, html) {
  try {
    if (env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM || FROM, to: [to], subject, text, html }) });
      return r.ok;
    }
    if (env.EMAIL && env.EMAIL.send) { await env.EMAIL.send({ to, from: env.EMAIL_FROM || 'hello@muirtech.net', subject, text, html }); return true; }
  } catch (e) {}
  return false;
}
async function sendText(env, to, body) {
  if (!textOn(env) || !to) return false;
  const num = String(to).replace(/[^\d+]/g, ''); const e164 = num.startsWith('+') ? num : '+1' + num.replace(/^1/, '');
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, { method: 'POST',
      headers: { authorization: 'Basic ' + btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: e164, From: env.TWILIO_FROM, Body: body.slice(0, 600) }) });
    return r.ok;
  } catch (e) { return false; }
}
async function alertOwner(env, subject, text) {
  const to = env.OWNER_EMAIL || 'muirtechnh@gmail.com';
  await Promise.all([sendEmail(env, to, subject, text, '<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">' + esc(text) + '</pre>'),
    env.OWNER_PHONE ? sendText(env, env.OWNER_PHONE, 'MUIR Tech: ' + text.slice(0, 300)) : null]);
}

// ---------- sign-in ----------
async function finish(env, email, ret, asJson) {
  email = String(email || '').toLowerCase().trim();
  if (!okEmail(email)) return asJson ? bad('That email does not look right.') : back(ret, 'noemail');
  await ensure(env);
  const now = Date.now(), s = token(32);
  const isNew = !(await env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first());
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO users (email, created, last_in, notify) VALUES (?,?,?,\'email\')').bind(email, now, now),
    env.DB.prepare('UPDATE users SET last_in=? WHERE email=?').bind(now, email),
    env.DB.prepare('INSERT INTO sessions (h, email, created, exp) VALUES (?,?,?,?)').bind(await sha('s|' + s), email, now, now + DAYS * 86400e3),
    env.DB.prepare('DELETE FROM sessions WHERE exp<?').bind(now),
    env.DB.prepare('DELETE FROM codes WHERE email=?').bind(email),
  ]);
  if (isNew) await alertOwner(env, 'New MUIR Tech customer account', 'New customer account: ' + email);
  const go = owners(env).includes(email) && /^\/account/.test(safeRet(ret)) ? '/admin' : safeRet(ret) + (isNew ? (safeRet(ret).includes('?') ? '&' : '?') + 'welcome=1' : '');
  if (asJson) return json({ ok: true, go }, 200, { 'set-cookie': setSession(s) });
  const h = new Headers({ location: go, 'cache-control': 'no-store' });
  h.append('set-cookie', setSession(s)); h.append('set-cookie', 'mt_oauth=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=None');
  return new Response(null, { status: 303, headers: h });
}
function back(ret, err) {
  const u = safeRet(ret);
  return new Response(null, { status: 303, headers: { location: u + (u.includes('?') ? '&' : '?') + 'signin=' + encodeURIComponent(err), 'cache-control': 'no-store', 'set-cookie': 'mt_oauth=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=None' } });
}
const makeState = (ret) => token(16) + '.' + b64u(new TextEncoder().encode(safeRet(ret)));
const retOf = (st) => { try { return safeRet(new TextDecoder().decode(unb64u(String(st).split('.')[1] || ''))); } catch { return '/account'; } };
const stateCookie = (v) => `mt_oauth=${v}; Path=/api/auth; Max-Age=600; HttpOnly; Secure; SameSite=None`;
async function appleSecret(env) {
  const pem = String(env.APPLE_PRIVATE_KEY).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o))); const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'ES256', kid: env.APPLE_KEY_ID }), body = enc({ iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_SERVICE_ID });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head + '.' + body)));
  return head + '.' + body + '.' + b64u(sig);
}

async function auth(path, req, env, url) {
  if (path === '/api/auth/me') {
    const email = await userOf(env, req);
    return json({ ok: true, email, owner: !!email && owners(env).includes(email), google: googleOn(env), apple: appleOn(env), emailCode: emailOn(env) });
  }
  if (path === '/api/auth/out' && req.method === 'POST') {
    const s = cookie(req, 'mt_session'); if (s) { await ensure(env); await env.DB.prepare('DELETE FROM sessions WHERE h=?').bind(await sha('s|' + s)).run(); }
    return json({ ok: true }, 200, { 'set-cookie': 'mt_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
  }
  if (path === '/api/auth/start' && req.method === 'POST') {
    let d; try { d = await req.json(); } catch { return bad('Bad request'); }
    const email = String(d.email || '').trim().toLowerCase();
    if (!okEmail(email)) return bad('Please type a full email address.');
    if (!emailOn(env)) return bad('Email codes are not switched on yet. Please use Google or Apple.', 503);
    await ensure(env);
    const now = Date.now(), ih = await sha('ip|' + ipOf(req));
    const c = await env.DB.prepare('SELECT SUM(email=?) e, SUM(ip=?) i FROM sends WHERE t>?').bind(email, ih, now - 3600e3).first();
    if ((c.e || 0) >= 5 || (c.i || 0) >= 20) return bad('Too many codes asked for. Please wait a little and try again.', 429);
    const code = six();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO sends (email, ip, t) VALUES (?,?,?)').bind(email, ih, now),
      env.DB.prepare('DELETE FROM sends WHERE t<?').bind(now - 86400e3),
      env.DB.prepare('INSERT OR REPLACE INTO codes (email, h, exp, tries, ret) VALUES (?,?,?,0,?)').bind(email, await sha('c|' + email + '|' + code), now + CODE_MIN * 60e3, safeRet(d.ret)),
    ]);
    const okSend = await sendEmail(env, email, 'Your MUIR Tech code: ' + code,
      `Your MUIR Tech sign-in code is ${code}\n\nType it on the sign-in page. It works for ${CODE_MIN} minutes.\nIf you did not ask for this, you can ignore this email.\n\nMUIR Tech · muirtech.net`,
      `<div style="font:16px/1.5 system-ui,sans-serif"><p>Your MUIR Tech sign-in code:</p><p style="font:700 34px/1 monospace;letter-spacing:6px">${code}</p><p>Type it on the sign-in page. It works for ${CODE_MIN} minutes.</p><p style="color:#666;font-size:13px">If you did not ask for this, you can ignore this email. · muirtech.net</p></div>`);
    if (!okSend) return bad('We could not send the email just now. Please try Google or Apple.', 502);
    return json({ ok: true });
  }
  if (path === '/api/auth/code' && req.method === 'POST') {
    let d; try { d = await req.json(); } catch { return bad('Bad request'); }
    const email = String(d.email || '').trim().toLowerCase(), code = String(d.code || '').replace(/\D/g, '');
    if (!okEmail(email) || code.length !== 6) return bad('Type the 6-digit code from the email.');
    await ensure(env);
    const r = await env.DB.prepare('SELECT h, exp, tries, ret FROM codes WHERE email=?').bind(email).first();
    if (!r || r.exp < Date.now() || r.tries >= 5) return bad('That code has expired. Ask for a new one.', 410);
    if (r.h !== await sha('c|' + email + '|' + code)) { await env.DB.prepare('UPDATE codes SET tries=tries+1 WHERE email=?').bind(email).run(); return bad('That code is not right. Check the email and try again.'); }
    return finish(env, email, r.ret, true);
  }
  if (path === '/api/auth/google/start') {
    const ret = url.searchParams.get('ret') || '/account'; if (!googleOn(env)) return back(ret, 'google-off');
    const state = makeState(ret);
    const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/auth/google/callback', response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
    return new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q, 'set-cookie': stateCookie(state), 'cache-control': 'no-store' } });
  }
  if (path === '/api/auth/google/callback') {
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '', ret = retOf(state);
    if (!googleOn(env)) return back(ret, 'google-off');
    if (!state || state !== cookie(req, 'mt_oauth')) return back(ret, 'expired');
    if (!code) return back(ret, 'cancelled');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/api/auth/google/callback', grant_type: 'authorization_code' }) }).catch(() => null);
    if (!r || !r.ok) return back(ret, 'failed');
    const p = jwtPayload((await r.json().catch(() => ({}))).id_token);
    if (!p || p.aud !== env.GOOGLE_CLIENT_ID || !p.email || p.email_verified === false) return back(ret, 'failed');
    const resp = await finish(env, p.email, ret);
    if (p.name) { try { await env.DB.prepare("UPDATE users SET name=? WHERE email=? AND (name IS NULL OR name='')").bind(clean(p.name, 80), p.email.toLowerCase()).run(); } catch (e) {} }
    return resp;
  }
  if (path === '/api/auth/apple/start') {
    const ret = url.searchParams.get('ret') || '/account'; if (!appleOn(env)) return back(ret, 'apple-off');
    const state = makeState(ret);
    const q = new URLSearchParams({ client_id: env.APPLE_SERVICE_ID, redirect_uri: url.origin + '/api/auth/apple/callback', response_type: 'code', response_mode: 'form_post', scope: 'name email', state });
    return new Response(null, { status: 302, headers: { location: 'https://appleid.apple.com/auth/authorize?' + q, 'set-cookie': stateCookie(state), 'cache-control': 'no-store' } });
  }
  if (path === '/api/auth/apple/callback' && req.method === 'POST') {
    const f = await req.formData().catch(() => null); const state = f ? String(f.get('state') || '') : '', code = f ? String(f.get('code') || '') : '', ret = retOf(state);
    if (!appleOn(env)) return back(ret, 'apple-off');
    if (!state || state !== cookie(req, 'mt_oauth')) return back(ret, 'expired');
    if (!code) return back(ret, 'cancelled');
    const r = await fetch('https://appleid.apple.com/auth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.APPLE_SERVICE_ID, client_secret: await appleSecret(env), code, grant_type: 'authorization_code', redirect_uri: url.origin + '/api/auth/apple/callback' }) }).catch(() => null);
    if (!r || !r.ok) return back(ret, 'failed');
    const p = jwtPayload((await r.json().catch(() => ({}))).id_token);
    if (!p || p.aud !== env.APPLE_SERVICE_ID || !p.email) return back(ret, 'failed');
    const resp = await finish(env, p.email, ret);
    try { const u = JSON.parse(String(f.get('user') || 'null')); const nm = u && u.name ? [u.name.firstName, u.name.lastName].filter(Boolean).join(' ') : ''; if (nm) await env.DB.prepare("UPDATE users SET name=? WHERE email=? AND (name IS NULL OR name='')").bind(clean(nm, 80), p.email.toLowerCase()).run(); } catch (e) {}
    return resp;
  }
  return bad('Not found', 404);
}

// ---------- the customer's own space ----------
const KINDS = ['Computer repair', 'Upgrade or new build', 'Wi-Fi or network', 'Printer or devices', 'Audio or studio setup', 'Website', 'AI coaching', 'Shipping', 'Something else'];
async function notifyCustomer(env, email, text, projectTitle) {
  const u = await env.DB.prepare('SELECT phone, notify FROM users WHERE email=?').bind(email).first() || {};
  const where = projectTitle ? ' about "' + projectTitle + '"' : '';
  const link = 'https://muirtech.net/account';
  const tasks = [];
  if (u.notify !== 'text') tasks.push(sendEmail(env, email, 'New message from MUIR Tech' + where, `MUIR Tech sent you a message${where}:\n\n${text}\n\nSee it and reply: ${link}`,
    `<div style="font:16px/1.5 system-ui,sans-serif"><p>MUIR Tech sent you a message${esc(where)}:</p><blockquote style="border-left:3px solid #C3AF75;margin:0;padding:6px 12px">${esc(text).replace(/\n/g, '<br>')}</blockquote><p><a href="${link}">See it and reply</a></p></div>`));
  if ((u.notify === 'text' || u.notify === 'both') && u.phone) tasks.push(sendText(env, u.phone, 'MUIR Tech' + where + ': ' + text.slice(0, 400) + ' — reply at muirtech.net/account'));
  await Promise.all(tasks);
}
async function portal(path, req, env) {
  const email = await userOf(env, req);
  if (!email) return bad('Please sign in first.', 401);
  if (path === '/api/portal' && req.method === 'GET') {
    const u = await env.DB.prepare('SELECT email, name, phone, notify, address, created FROM users WHERE email=?').bind(email).first();
    const projects = (await env.DB.prepare('SELECT id, title, kind, status, details, created, updated FROM projects WHERE email=? ORDER BY updated DESC').bind(email).all()).results;
    const messages = (await env.DB.prepare('SELECT id, project_id, sender, body, created, seen_customer FROM messages WHERE email=? ORDER BY id').bind(email).all()).results;
    await env.DB.prepare("UPDATE messages SET seen_customer=1 WHERE email=? AND sender='muir' AND seen_customer=0").bind(email).run();
    return json({ ok: true, user: u, projects, messages, kinds: KINDS, textOn: textOn(env), owner: owners(env).includes(email) });
  }
  let d; try { d = await req.json(); } catch { return bad('Bad request'); }
  if (path === '/api/portal/profile') {
    const notify = ['email', 'text', 'both'].includes(d.notify) ? d.notify : 'email';
    const phone = clean(d.phone, 30);
    if (notify !== 'email' && phone.replace(/\D/g, '').length < 10) return bad('Please add a cell phone number for texts.');
    await env.DB.prepare('UPDATE users SET name=?, phone=?, notify=?, address=? WHERE email=?').bind(clean(d.name, 80), phone, notify, clean(d.address, 200), email).run();
    return json({ ok: true });
  }
  if (path === '/api/portal/project') {
    const title = clean(d.title, 100), details = clean(d.details, 4000), kind = KINDS.includes(d.kind) ? d.kind : 'Something else';
    if (title.length < 3) return bad('Please give the job a short name, like "Laptop won\'t start".');
    const now = Date.now();
    const r = await env.DB.prepare('INSERT INTO projects (email, title, kind, status, details, created, updated) VALUES (?,?,?,?,?,?,?)').bind(email, title, kind, 'New request', details, now, now).run();
    await alertOwner(env, 'New MUIR Tech job request: ' + title, `${email} started a new job.\n\n${kind}: ${title}\n\n${details}\n\nOpen: https://muirtech.net/admin`);
    return json({ ok: true, id: r.meta && r.meta.last_row_id });
  }
  if (path === '/api/portal/message') {
    const body = clean(d.body, 4000); if (!body) return bad('Please type a message.');
    let pid = d.projectId ? Number(d.projectId) : null, title = '';
    if (pid) { const p = await env.DB.prepare('SELECT title FROM projects WHERE id=? AND email=?').bind(pid, email).first(); if (!p) return bad('That job was not found.', 404); title = p.title; }
    const now = Date.now();
    await env.DB.prepare('INSERT INTO messages (email, project_id, sender, body, created, seen_customer, seen_muir) VALUES (?,?,?,?,?,1,0)').bind(email, pid, 'customer', body, now).run();
    if (pid) await env.DB.prepare('UPDATE projects SET updated=? WHERE id=?').bind(now, pid).run();
    const u = await env.DB.prepare('SELECT name, phone FROM users WHERE email=?').bind(email).first() || {};
    await alertOwner(env, 'New message from ' + (u.name || email) + (title ? ' about ' + title : ''), `${u.name || ''} <${email}>${u.phone ? ' ' + u.phone : ''}${title ? '\nJob: ' + title : ''}\n\n${body}\n\nReply: https://muirtech.net/admin`);
    return json({ ok: true });
  }
  return bad('Not found', 404);
}

// ---------- David's view ----------
async function admin(path, req, env) {
  const email = await userOf(env, req);
  if (!email || !owners(env).includes(email)) return bad('Owner sign-in needed.', 403);
  if (path === '/api/admin' && req.method === 'GET') {
    const users = (await env.DB.prepare('SELECT email, name, phone, notify, address, created, last_in FROM users ORDER BY last_in DESC LIMIT 1000').all()).results;
    const projects = (await env.DB.prepare('SELECT id, email, title, kind, status, details, created, updated FROM projects ORDER BY updated DESC LIMIT 2000').all()).results;
    const messages = (await env.DB.prepare('SELECT id, email, project_id, sender, body, created, seen_muir FROM messages ORDER BY id DESC LIMIT 5000').all()).results;
    return json({ ok: true, me: email, users, projects, messages, emailOn: emailOn(env), textOn: textOn(env) });
  }
  let d; try { d = await req.json(); } catch { return bad('Bad request'); }
  const cust = String(d.email || '').toLowerCase().trim();
  if (path === '/api/admin/seen') { await env.DB.prepare("UPDATE messages SET seen_muir=1 WHERE email=? AND sender='customer'").bind(cust).run(); return json({ ok: true }); }
  if (path === '/api/admin/project') {
    const now = Date.now(), title = clean(d.title, 100);
    if (d.id) {
      await env.DB.prepare('UPDATE projects SET title=COALESCE(NULLIF(?,\'\'),title), status=COALESCE(NULLIF(?,\'\'),status), details=COALESCE(?,details), updated=? WHERE id=?').bind(title, clean(d.status, 40), d.details == null ? null : clean(d.details, 4000), now, Number(d.id)).run();
      if (d.status) { const p = await env.DB.prepare('SELECT email, title FROM projects WHERE id=?').bind(Number(d.id)).first(); if (p && d.tell) await notifyCustomer(env, p.email, 'Your job "' + p.title + '" is now: ' + clean(d.status, 40), p.title); }
      return json({ ok: true });
    }
    if (!okEmail(cust) || title.length < 2) return bad('Customer email and a job name are needed.');
    await env.DB.prepare('INSERT OR IGNORE INTO users (email, created, last_in, notify) VALUES (?,?,0,\'email\')').bind(cust, now).run();
    const r = await env.DB.prepare('INSERT INTO projects (email, title, kind, status, details, created, updated) VALUES (?,?,?,?,?,?,?)').bind(cust, title, KINDS.includes(d.kind) ? d.kind : 'Something else', clean(d.status, 40) || 'Scheduled', clean(d.details, 4000), now, now).run();
    return json({ ok: true, id: r.meta && r.meta.last_row_id });
  }
  if (path === '/api/admin/message') {
    const body = clean(d.body, 4000); if (!okEmail(cust) || !body) return bad('Customer and message are needed.');
    const pid = d.projectId ? Number(d.projectId) : null; let title = '';
    if (pid) { const p = await env.DB.prepare('SELECT title FROM projects WHERE id=? AND email=?').bind(pid, cust).first(); title = p ? p.title : ''; }
    const now = Date.now();
    await env.DB.prepare('INSERT INTO messages (email, project_id, sender, body, created, seen_customer, seen_muir) VALUES (?,?,?,?,?,0,1)').bind(cust, pid, 'muir', body, now).run();
    if (pid) await env.DB.prepare('UPDATE projects SET updated=? WHERE id=?').bind(now, pid).run();
    await notifyCustomer(env, cust, body, title);
    return json({ ok: true });
  }
  return bad('Not found', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/translate') {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      try {
        const b = await req.json(); const src = LANGS[b.lang]; const text = String(b.text || '').slice(0, 2000);
        if (!src || !text.trim()) return Response.json({ ok: true, text });
        const r = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: src, target_lang: 'english' });
        return Response.json({ ok: true, text: (r && r.translated_text) || text });
      } catch (e) { return Response.json({ ok: false, error: 'translate failed' }, { status: 500 }); }
    }
    if (path.startsWith('/api/auth') || path.startsWith('/api/portal') || path.startsWith('/api/admin')) {
      if (!env.DB) return bad('Customer accounts are being set up. Please call or email us for now.', 503);
      try {
        if (path.startsWith('/api/auth')) return await auth(path, req, env, url);
        if (path.startsWith('/api/portal')) return await portal(path, req, env);
        return await admin(path, req, env);
      } catch (e) { return bad('Something went wrong. Please try again.', 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
