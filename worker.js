import { CATALOG_DEFAULT } from './catalog.js';
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
    if (env.EMAIL && env.EMAIL.send) { await env.EMAIL.send({ to, from: { email: 'hello@muirtech.net', name: 'MUIR Tech' }, replyTo: 'muirtechnh@gmail.com', subject, text, html }); return true; }
  } catch (e) { console.log('email failed', e && (e.code || e.message)); }
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
const KINDS = ['Computer repair', 'Upgrade or new build', 'Wi-Fi or network', 'Printer or devices', 'Audio or studio setup', 'Website', 'Logo', 'Security cameras', 'AI coaching', 'Shipping', 'Something else'];
async function notifyCustomer(env, email, text, projectTitle) {
  const u = await env.DB.prepare('SELECT phone, notify FROM users WHERE email=?').bind(email).first() || {};
  const where = projectTitle ? ' about "' + projectTitle + '"' : '';
  const link = 'https://muirtech.net/account';
  const tasks = [];
  const noEmail = /@no-email\.muirtech\.net$/.test(email);
  if (u.notify !== 'text' && !noEmail) tasks.push(sendEmail(env, email, 'New message from MUIR Tech' + where, `MUIR Tech sent you a message${where}:\n\n${text}\n\nSee it and reply: ${link}`,
    `<div style="font:16px/1.5 system-ui,sans-serif"><p>MUIR Tech sent you a message${esc(where)}:</p><blockquote style="border-left:3px solid #C3AF75;margin:0;padding:6px 12px">${esc(text).replace(/\n/g, '<br>')}</blockquote><p><a href="${link}">See it and reply</a></p></div>`));
  if ((u.notify === 'text' || u.notify === 'both' || noEmail) && u.phone) tasks.push(sendText(env, u.phone, 'MUIR Tech' + where + ': ' + text.slice(0, 400) + ' — reply at muirtech.net/account'));
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
    await qensure(env);
    const quotes = (await env.DB.prepare("SELECT q.project_id, q.lines, q.status, q.notes, q.updated FROM quotes q JOIN projects p ON p.id=q.project_id WHERE p.email=? AND q.status!='draft'").bind(email).all()).results;
    return json({ ok: true, user: u, projects, messages, quotes, kinds: KINDS, textOn: textOn(env), owner: owners(env).includes(email) });
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
  if (path === '/api/portal/approve') {
    await qensure(env); const pid = Number(d.projectId);
    const q = await env.DB.prepare("SELECT q.status, p.title FROM quotes q JOIN projects p ON p.id=q.project_id WHERE q.project_id=? AND p.email=?").bind(pid, email).first();
    if (!q || q.status !== 'sent') return bad('That quote cannot be approved right now.');
    await env.DB.prepare("UPDATE quotes SET status='approved', updated=? WHERE project_id=?").bind(Date.now(), pid).run();
    await alertOwner(env, 'Quote approved: ' + pnum(pid) + ' ' + q.title, email + ' approved quote ' + pnum(pid) + ' for "' + q.title + '".\n\nhttps://muirtech.net/admin');
    return json({ ok: true });
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

// ---------- quotes, price book, admin password, QuickBooks export (11-27-2026) ----------
const pnum = (id) => 'MT-' + (1000 + Number(id));
const money = (v) => { const n = Math.round(parseFloat(String(v).replace(/[^0-9.\-]/g, '')) * 100) / 100; return isFinite(n) ? n : 0; };
const QSTAT = ['draft', 'sent', 'approved', 'invoiced', 'paid'];
const PB_DEFAULT = [
  // Security cameras
  { key: 'cam-kit', group: 'Security cameras', desc: 'Ring camera kit', m: 125, l: 0 },
  { key: 'cam-base', group: 'Security cameras', desc: 'Alarm base station / hub', m: 225, l: 0 },
  { key: 'cam-labor', group: 'Security cameras', desc: 'Camera install labor', m: 0, l: 175 },
  { key: 'cam-out', group: 'Security cameras', desc: 'Install outdoor camera(s)', m: 0, l: 0 },
  { key: 'cam-in', group: 'Security cameras', desc: 'Install indoor camera(s)', m: 0, l: 0 },
  { key: 'cam-door', group: 'Security cameras', desc: 'Install video doorbell', m: 0, l: 0 },
  { key: 'cam-flood', group: 'Security cameras', desc: 'Install floodlight camera', m: 0, l: 0 },
  { key: 'cam-alarm', group: 'Security cameras', desc: 'Alarm hub, keypad and door/window sensors', m: 0, l: 0 },
  { key: 'cam-mon', group: 'Security cameras', desc: 'Set up 24/7 monitoring plan', m: 0, l: 0 },
  { key: 'cam-wifi', group: 'Security cameras', desc: 'Extend Wi-Fi to reach cameras', m: 0, l: 0 },
  { key: 'cam-app', group: 'Security cameras', desc: 'Phone app setup and walkthrough', m: 0, l: 0 },
  // Logos
  { key: 'logo-1', group: 'Logos', desc: 'Logo Fix (redraw and clean up current logo)', m: 0, l: 299 },
  { key: 'logo-2', group: 'Logos', desc: 'Custom Logo (3 ideas, 3 rounds of changes)', m: 0, l: 699 },
  { key: 'logo-3', group: 'Logos', desc: 'Brand Kit (logo, cards, social, email signature, brand guide)', m: 0, l: 1299 },
  // Websites
  { key: 'web-1', group: 'Websites', desc: 'Website Level 1: Refresh', m: 0, l: 0 },
  { key: 'web-2', group: 'Websites', desc: 'Website Level 2: Tailored', m: 0, l: 0 },
  { key: 'web-3', group: 'Websites', desc: 'Website Level 3: Custom', m: 0, l: 0 },
  { key: 'web-4', group: 'Websites', desc: 'Website Level 4: Signature', m: 0, l: 0 },
  { key: 'web-page', group: 'Websites', desc: 'Extra page', m: 0, l: 0 },
  { key: 'web-domain', group: 'Websites', desc: 'Domain, hosting and email setup', m: 0, l: 0 },
  { key: 'web-feat', group: 'Websites', desc: 'Feature', m: 0, l: 0 },
  // General
  { key: 'gen-visit', group: 'General', desc: 'Service visit', m: 0, l: 0 },
  { key: 'gen-hour', group: 'General', desc: 'Labor (per hour)', m: 0, l: 0 },
];
async function getSet(env, k) { const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(k).first(); return r ? r.v : null; }
async function putSet(env, k, v) { await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, v).run(); }
async function catalog(env) { const v = await getSet(env, 'catalog'); try { const a = JSON.parse(v); if (Array.isArray(a) && a.length) return a; } catch {} return CATALOG_DEFAULT; }
function cleanCat(a, depth, box) {
  return (Array.isArray(a) ? a : []).slice(0, 400).map((n) => {
    if (!n || box.n++ > 6000) return null;
    const name = clean(n.n, 120); if (!name) return null;
    return { n: name, f: depth < 7 ? cleanCat(n.f, depth + 1, box) : [], i: (Array.isArray(n.i) ? n.i : []).slice(0, 600).map((x) => (box.n++, { n: clean(x && x.n, 200), m: money(x && x.m), l: money(x && x.l) })).filter((x) => x.n) };
  }).filter(Boolean);
}
async function pricebook(env) { const v = await getSet(env, 'pricebook'); try { const a = JSON.parse(v); if (Array.isArray(a) && a.length) return a; } catch {} return PB_DEFAULT; }
const ADMIN_SEED = { v: '1', pw: 'seed1:0474a7f04aa063d8071c0ec58252995127ae3dd7f0ab13e339816b3db2a57cb0' };
let qready = false;
async function qensure(env) {
  await ensure(env); if (qready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS quotes (project_id INTEGER PRIMARY KEY, lines TEXT, status TEXT DEFAULT \'draft\', notes TEXT, updated INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS admin_sessions (h TEXT PRIMARY KEY, exp INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS admin_tries (ip TEXT, t INTEGER)'),
  ]);
  try { await env.DB.prepare('ALTER TABLE projects ADD COLUMN extra TEXT').run(); } catch {}
  // Starting owner password, set by Claude at David's request. To reset it for him, change ADMIN_SEED (new version + salt:hash).
  if ((await getSet(env, 'admin_seed')) !== ADMIN_SEED.v) { await putSet(env, 'admin_pw', ADMIN_SEED.pw); await putSet(env, 'admin_seed', ADMIN_SEED.v); await env.DB.prepare('DELETE FROM admin_sessions').run(); }
  qready = true;
}
function cleanLines(lines) {
  return (Array.isArray(lines) ? lines : []).slice(0, 80).map((x) => ({ desc: clean(x && x.desc, 300), m: money(x && x.m), l: money(x && x.l) })).filter((x) => x.desc || x.m || x.l);
}
const totals = (lines) => { const m = lines.reduce((a, x) => a + money(x.m), 0), l = lines.reduce((a, x) => a + money(x.l), 0); return { m: Math.round(m * 100) / 100, l: Math.round(l * 100) / 100, t: Math.round((m + l) * 100) / 100 }; };
function draftLines(service, a, pb) {
  const P = {}; pb.forEach((x) => { P[x.key] = x; });
  const L = []; const add = (key, desc) => { const p = P[key] || { desc: '', m: 0, l: 0 }; L.push({ desc: desc || p.desc, m: money(p.m), l: money(p.l) }); };
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  if (service === 'Security cameras') {
    const n = String(a.count || '').trim(), N = n ? ' (' + n + ')' : '';
    arr(a.need).forEach((x) => {
      if (/outdoor/i.test(x)) add('cam-out', 'Install outdoor camera(s)' + N);
      else if (/indoor/i.test(x)) add('cam-in', 'Install indoor camera(s)' + N);
      else if (/doorbell/i.test(x)) add('cam-door');
      else if (/flood/i.test(x)) add('cam-flood');
      else if (/alarm|sensor/i.test(x)) add('cam-alarm');
      else if (/monitor/i.test(x)) add('cam-mon');
      else if (/wi-?fi/i.test(x)) add('cam-wifi');
      else L.push({ desc: x, m: 0, l: 0 });
    });
    if (/help me choose|no/i.test(String(a.have || ''))) add('cam-kit');
    add('cam-app');
  } else if (service === 'Logos') {
    const lv = String(a.level || ''); add(/brand/i.test(lv) ? 'logo-3' : /custom/i.test(lv) ? 'logo-2' : /fix/i.test(lv) ? 'logo-1' : 'logo-2');
  } else if (service === 'Websites') {
    const lv = String(a.level || ''); const m = lv.match(/[1-4]/); add('web-' + (m ? m[0] : '2'));
    if (a.pages) L.push({ desc: 'Pages: ' + a.pages, m: 0, l: 0 });
    arr(a.do).forEach((x) => add('web-feat', 'Feature: ' + x));
    if (arr(a.now).some((x) => /no website|domain/i.test(x))) add('web-domain');
  } else add('gen-visit');
  return L;
}
async function adminPwOk(env, pw) {
  const v = await getSet(env, 'admin_pw'); if (!v) return false;
  const [salt, h] = v.split(':'); return h === await sha('apw|' + salt + '|' + pw);
}
async function setAdminPw(env, pw) { const salt = token(16); await putSet(env, 'admin_pw', salt + ':' + await sha('apw|' + salt + '|' + pw)); await env.DB.prepare('DELETE FROM admin_sessions').run(); }
const adminCookie = (s, age) => `mt_admin=${s}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
async function adminUnlocked(env, req) { const s = cookie(req, 'mt_admin'); if (s.length < 30) return false; const r = await env.DB.prepare('SELECT exp FROM admin_sessions WHERE h=?').bind(await sha('a|' + s)).first(); return !!(r && r.exp > Date.now()); }
async function tooMany(env, req) { const ip = await sha('ip|' + ipOf(req)), t = Date.now(); const r = await env.DB.prepare('SELECT COUNT(*) c FROM admin_tries WHERE ip=? AND t>?').bind(ip, t - 15 * 60e3).first(); return { ip, block: r && r.c >= 6 }; }
const pwRule = (pw) => String(pw || '').length >= 4;
async function adminPw(path, req, env) {
  const email = await userOf(env, req);
  if (!email || !owners(env).includes(email)) return bad('Owner sign-in needed.', 403);
  await qensure(env);
  const has = !!(await getSet(env, 'admin_pw'));
  if (path === '/api/adminpw/status') return json({ ok: true, has, unlocked: has && await adminUnlocked(env, req), emailOn: emailOn(env) });
  let d; try { d = await req.json(); } catch { return bad('Bad request'); }
  const lim = await tooMany(env, req); if (lim.block) return bad('Too many tries. Wait 15 minutes and try again.', 429);
  const fail = async (m) => { await env.DB.prepare('INSERT INTO admin_tries (ip, t) VALUES (?, ?)').bind(lim.ip, Date.now()).run(); return bad(m, 401); };
  const unlock = async () => { const s = token(32); await env.DB.prepare('INSERT INTO admin_sessions (h, exp) VALUES (?, ?)').bind(await sha('a|' + s), Date.now() + 12 * 3600e3).run(); return json({ ok: true }, 200, { 'set-cookie': adminCookie(s, 12 * 3600) }); };
  if (path === '/api/adminpw/set') {
    if (has && !(await adminPwOk(env, d.current || ''))) return fail('Your current password is not right.');
    if (!pwRule(d.password)) return bad('Use at least 4 characters.');
    await setAdminPw(env, d.password); return unlock();
  }
  if (path === '/api/adminpw/unlock') { if (!has) return bad('Set a password first.'); if (!(await adminPwOk(env, d.password || ''))) return fail('That password is not right.'); return unlock(); }
  if (path === '/api/adminpw/lock') { await env.DB.prepare('DELETE FROM admin_sessions WHERE h=?').bind(await sha('a|' + cookie(req, 'mt_admin'))).run(); return json({ ok: true }, 200, { 'set-cookie': adminCookie('x', 0) }); }
  if (path === '/api/adminpw/forgot') {
    const code = six(); await putSet(env, 'admin_reset', JSON.stringify({ h: await sha('ar|' + code), exp: Date.now() + 15 * 60e3, tries: 0 }));
    const to = env.OWNER_EMAIL || 'muirtechnh@gmail.com';
    const ok = await sendEmail(env, to, 'MUIR Tech owner password reset code', 'Your reset code: ' + code + '\nIt works for 15 minutes. If you did not ask for this, ignore it.', '<p style="font:16px system-ui">Your MUIR Tech owner password reset code:</p><p style="font:700 34px monospace;letter-spacing:6px">' + code + '</p><p style="font:14px system-ui;color:#666">It works for 15 minutes. If you did not ask for this, ignore it.</p>');
    return ok ? json({ ok: true, to }) : bad('The email did not go out. Try again in a minute.', 502);
  }
  if (path === '/api/adminpw/reset') {
    let r; try { r = JSON.parse(await getSet(env, 'admin_reset')); } catch {}
    if (!r || r.exp < Date.now() || r.tries >= 5) return bad('That code has expired. Ask for a new one.');
    if (r.h !== await sha('ar|' + String(d.code || '').replace(/\D/g, ''))) { r.tries++; await putSet(env, 'admin_reset', JSON.stringify(r)); return fail('That code is not right.'); }
    if (!pwRule(d.password)) return bad('Use at least 4 characters.');
    await putSet(env, 'admin_reset', ''); await setAdminPw(env, d.password); return unlock();
  }
  return bad('Not found', 404);
}
function csvCell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function csv(rows) { return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
const mdy = (ms) => { const d = new Date(ms); return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear(); };
async function qbExport(env, url) {
  const kind = url.searchParams.get('type') || 'invoice', id = Number(url.searchParams.get('id') || 0);
  if (kind === 'customers') {
    const us = (await env.DB.prepare('SELECT email, name, phone, address FROM users ORDER BY name').all()).results;
    const rows = [['Name', 'Company', 'Email', 'Phone', 'Street', 'Notes']].concat(us.map((u) => [u.name || u.email, '', u.email, u.phone || '', u.address || '', '']));
    return new Response(csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="MUIR TECH CUSTOMERS.csv"', 'cache-control': 'no-store' } });
  }
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id=?').bind(id).first(); if (!p) return bad('Not found', 404);
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE project_id=?').bind(id).first() || { lines: '[]' };
  const u = await env.DB.prepare('SELECT name FROM users WHERE email=?').bind(p.email).first() || {};
  const lines = JSON.parse(q.lines || '[]'), now = Date.now(), cust = u.name || p.email, no = pnum(id);
  const rows = [['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Terms', 'Memo', 'Item(Product/Service)', 'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount', 'Taxable']];
  lines.forEach((x) => {
    if (money(x.m)) rows.push([no, cust, mdy(now), mdy(now + 30 * 864e5), 'Net 30', p.title, 'Materials', x.desc, 1, money(x.m).toFixed(2), money(x.m).toFixed(2), 'N']);
    if (money(x.l)) rows.push([no, cust, mdy(now), mdy(now + 30 * 864e5), 'Net 30', p.title, 'Labor', x.desc, 1, money(x.l).toFixed(2), money(x.l).toFixed(2), 'N']);
  });
  return new Response(csv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="MUIR TECH ${no} ${kind === 'estimate' ? 'ESTIMATE' : 'INVOICE'}.csv"`, 'cache-control': 'no-store' } });
}
async function quoteRequest(req, env) {
  if (!env.DB) return bad('Please call (603) 600-2843 for now.', 503);
  await qensure(env);
  const b = await req.json().catch(() => ({})); if (b.website) return json({ ok: true });
  const name = clean(b.name, 100), email = clean(b.email, 190).toLowerCase(), phone = clean(b.phone, 30), address = clean(b.address, 200), date = clean(b.date, 40), biz = clean(b.business, 120);
  const service = ['Websites', 'Logos', 'Security cameras'].includes(b.service) ? b.service : 'Something else';
  if (!name || (!okEmail(email) && phone.replace(/\D/g, '').length < 10)) return bad('Please add your name and an email or phone number.');
  const ip = await sha('ip|' + ipOf(req)), now = Date.now();
  const n = await env.DB.prepare("SELECT COUNT(*) c FROM sends WHERE ip=? AND email='quote' AND t>?").bind(ip, now - 3600e3).first();
  if (n && n.c >= 6) return bad('Too many requests. Please call or text (603) 600-2843.', 429);
  await env.DB.prepare("INSERT INTO sends (email, ip, t) VALUES ('quote', ?, ?)").bind(ip, now).run();
  const answers = {}; Object.entries(b.answers || {}).slice(0, 30).forEach(([k, v]) => { answers[clean(k, 40)] = Array.isArray(v) ? v.slice(0, 20).map((x) => clean(x, 120)) : clean(v, 600); });
  const who = okEmail(email) ? email : 'phone-' + phone.replace(/\D/g, '') + '@no-email.muirtech.net';
  await env.DB.prepare('INSERT OR IGNORE INTO users (email, created, last_in, notify) VALUES (?,?,0,\'email\')').bind(who, now).run();
  await env.DB.prepare("UPDATE users SET name=COALESCE(NULLIF(name,''),?), phone=COALESCE(NULLIF(phone,''),?), address=COALESCE(NULLIF(address,''),?) WHERE email=?").bind(name, phone, address, who).run();
  const kind = service === 'Websites' ? 'Website' : service === 'Something else' ? 'Something else' : service === 'Logos' ? 'Logo' : 'Security cameras';
  const lvl = answers.level ? ' · ' + (Array.isArray(answers.level) ? answers.level.join(', ') : answers.level) : '';
  const title = (service === 'Something else' ? 'Quote request' : service + ' quote') + lvl;
  const extra = JSON.stringify({ name, email: okEmail(email) ? email : '', phone, address, date, business: biz, service, answers, message: clean(b.message, 3000) });
  const details = clean(b.message, 3000);
  const r = await env.DB.prepare('INSERT INTO projects (email, title, kind, status, details, created, updated, extra) VALUES (?,?,?,?,?,?,?,?)').bind(who, title.slice(0, 100), kind, 'New request', details, now, now, extra).run();
  const id = r.meta && r.meta.last_row_id;
  const lines = draftLines(service, answers, await pricebook(env));
  await env.DB.prepare('INSERT INTO quotes (project_id, lines, status, notes, updated) VALUES (?,?,?,?,?)').bind(id, JSON.stringify(lines), 'draft', '', now).run();
  const ans = Object.entries(answers).map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v)).join('\n');
  await alertOwner(env, 'New quote request ' + pnum(id) + ': ' + title, `${pnum(id)} · ${title}\n\nName: ${name}\nEmail: ${email || '-'}\nPhone: ${phone || '-'}\nAddress: ${address || '-'}\nBest date: ${date || '-'}${biz ? '\nBusiness: ' + biz : ''}\n\n${ans}\n\n${details}\n\nA draft quote is ready to price: https://muirtech.net/admin`);
  return json({ ok: true, number: pnum(id) });
}

// ---------- David's view ----------
async function admin(path, req, env) {
  const email = await userOf(env, req);
  if (!email || !owners(env).includes(email)) return bad('Owner sign-in needed.', 403);
  await qensure(env);
  if (!(await adminUnlocked(env, req))) return json({ ok: false, locked: true, error: 'Enter your owner password.' }, 401);
  if (path === '/api/admin/export') return qbExport(env, new URL(req.url));
  if (path === '/api/admin' && req.method === 'GET') {
    const users = (await env.DB.prepare('SELECT email, name, phone, notify, address, created, last_in FROM users ORDER BY last_in DESC LIMIT 1000').all()).results;
    const projects = (await env.DB.prepare('SELECT id, email, title, kind, status, details, created, updated, extra FROM projects ORDER BY updated DESC LIMIT 2000').all()).results;
    const messages = (await env.DB.prepare('SELECT id, email, project_id, sender, body, created, seen_muir FROM messages ORDER BY id DESC LIMIT 5000').all()).results;
    const quotes = (await env.DB.prepare('SELECT project_id, lines, status, notes, updated FROM quotes').all()).results;
    return json({ ok: true, me: email, users, projects, messages, quotes, pricebook: await pricebook(env), catalog: await catalog(env), emailOn: emailOn(env), textOn: textOn(env) });
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
  if (path === '/api/admin/quote') {
    const pid = Number(d.projectId); const p = await env.DB.prepare('SELECT email, title FROM projects WHERE id=?').bind(pid).first(); if (!p) return bad('Job not found.', 404);
    const lines = cleanLines(d.lines), st = QSTAT.includes(d.status) ? d.status : 'draft', now = Date.now();
    const old = await env.DB.prepare('SELECT status FROM quotes WHERE project_id=?').bind(pid).first();
    await env.DB.prepare('INSERT INTO quotes (project_id, lines, status, notes, updated) VALUES (?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET lines=excluded.lines, status=excluded.status, notes=excluded.notes, updated=excluded.updated').bind(pid, JSON.stringify(lines), st, clean(d.notes, 2000), now).run();
    await env.DB.prepare('UPDATE projects SET updated=? WHERE id=?').bind(now, pid).run();
    if (d.tell && st !== 'draft' && (!old || old.status !== st)) { const t = totals(lines); await notifyCustomer(env, p.email, (st === 'sent' ? 'Your quote ' : st === 'invoiced' ? 'Your bill ' : 'Your quote ') + pnum(pid) + ' for "' + p.title + '" is ready: $' + t.t.toFixed(2) + '. See it in your account.', p.title); }
    return json({ ok: true });
  }
  if (path === '/api/admin/catalog') {
    const c = cleanCat(d.catalog, 0, { n: 0 }); const t = JSON.stringify(c);
    if (!c.length) return json({ ok: false, error: 'The catalog is empty.' });
    if (t.length > 900000) return json({ ok: false, error: 'The catalog is too big to save.' });
    await putSet(env, 'catalog', t); return json({ ok: true });
  }
  if (path === '/api/admin/pricebook') {
    const pb = (Array.isArray(d.items) ? d.items : []).slice(0, 300).map((x, i) => ({ key: clean(x.key, 40) || 'item-' + i, group: clean(x.group, 40) || 'General', desc: clean(x.desc, 200), m: money(x.m), l: money(x.l) })).filter((x) => x.desc);
    await putSet(env, 'pricebook', JSON.stringify(pb)); return json({ ok: true });
  }
  if (path === '/api/admin/contacts') {
    const now = Date.now(); let n = 0;
    for (const c of (Array.isArray(d.contacts) ? d.contacts : []).slice(0, 2000)) {
      const name = clean(c.name, 100), phone = clean(c.phone, 30); let em = clean(c.email, 190).toLowerCase();
      if (!okEmail(em)) { if (phone.replace(/\D/g, '').length < 10) continue; em = 'phone-' + phone.replace(/\D/g, '') + '@no-email.muirtech.net'; }
      await env.DB.prepare("INSERT OR IGNORE INTO users (email, created, last_in, notify) VALUES (?,?,0,'email')").bind(em, now).run();
      await env.DB.prepare("UPDATE users SET name=COALESCE(NULLIF(name,''),?), phone=COALESCE(NULLIF(phone,''),?), address=COALESCE(NULLIF(address,''),?) WHERE email=?").bind(name, phone, clean(c.address, 200), em).run(); n++;
    }
    return json({ ok: true, added: n });
  }
  if (path === '/api/admin/message') {
    const body = clean(d.body, 4000); if (!okEmail(cust) || !body) return bad('Customer and message are needed.');
    await env.DB.prepare("INSERT OR IGNORE INTO users (email, created, last_in, notify) VALUES (?,?,0,'email')").bind(cust, Date.now()).run();
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
    if (path === '/api/contact') {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      try {
        const b = await req.json().catch(() => ({}));
        if (b.website) return Response.json({ ok: true });
        const name = String(b.name || '').slice(0, 120).trim(), contact = String(b.contact || '').slice(0, 160).trim();
        const topic = String(b.topic || '').slice(0, 120), msg = String(b.message || '').slice(0, 4000).trim();
        if (!msg && !contact) return Response.json({ ok: false, error: 'Please add a message and how to reach you.' }, { status: 400 });
        if (env.DB) {
          await ensure(env); const ip = await sha('ip|' + ipOf(req)), now = Date.now();
          const n = await env.DB.prepare("SELECT COUNT(*) c FROM sends WHERE ip=? AND email='contact' AND t>?").bind(ip, now - 3600e3).first();
          if (n && n.c >= 8) return Response.json({ ok: false, error: 'Too many messages. Please call or text (603) 600-2843.' }, { status: 429 });
          await env.DB.prepare("INSERT INTO sends (email, ip, t) VALUES ('contact', ?, ?)").bind(ip, now).run();
        }
        const text = 'New message from the MUIR Tech website\n\nName: ' + (name || '-') + '\nPhone or email: ' + (contact || '-') + '\nTopic: ' + (topic || '-') + '\n\n' + (msg || '(no message)');
        const to = env.OWNER_EMAIL || 'muirtechnh@gmail.com';
        const ok = await sendEmail(env, to, 'Website message' + (name ? ' from ' + name : ''), text, '<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">' + esc(text) + '</pre>');
        if (!ok) return Response.json({ ok: false, error: 'Email is not going through right now. Please call or text (603) 600-2843.' }, { status: 502 });
        return Response.json({ ok: true });
      } catch (e) { return Response.json({ ok: false, error: 'Something went wrong. Please call or text (603) 600-2843.' }, { status: 500 }); }
    }
    if (path === '/api/quote' && req.method === 'POST') { try { return await quoteRequest(req, env); } catch (e) { return bad('Something went wrong. Please call (603) 600-2843.', 500); } }
    if (path.startsWith('/api/adminpw')) { if (!env.DB) return bad('Not ready', 503); try { return await adminPw(path, req, env); } catch (e) { return bad('Something went wrong.', 500); } }
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
