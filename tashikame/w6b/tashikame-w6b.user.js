// ==UserScript==
// @name         たしかめW6b
// @namespace    urn:yomu-probe-w6b
// @version      0.1.0
// @description  工程W6b の確かめ用(鍵をかける道具と縮める道具が使えるか・ページの決まり)。本物の Blendio とは別。保存は使わない。確かめが済んだら消す
// @match        https://syosetu.com/*
// @match        https://*.syosetu.com/*
// @match        https://kakuyomu.jp/*
// @match        https://yukisasami7350-debug.github.io/yomu/tashikame/w6b/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @run-at       document-end
// @noframes
// @sandbox      DOM
// ==/UserScript==
// tools/probe/w6b_probe.js — 確かめ用スクリプト「たしかめW6b」の中身(工程W6b。設計書 §8-12 の 3・7)
//   tools/probe/w6b.js が、頭書きと、PC(node)で作った手本の値(下の V)を足して、1 つのスクリプトにする。
//   確かめること:
//     ① WebCrypto(乱数・SHA-256・HKDF・HMAC・AES-GCM)と CompressionStream / DecompressionStream が使えるか
//     ② PC で作った鍵・名前・中身を、この端末でも同じに作れるか・開けるか(端末どうしで話が通じるか)
//     ③ この端末で作った中身(下の mine)を、PC で開けるか(部屋が w6b.js --read で開く)
//     ④ 1MB ほどの中身に鍵をかける・開ける時間
//     ⑤ このページの決まり(CSP)で、ほかのサイトへの通信が止められないか
//   ページの本文は読まない。結果に入れるのは、ホスト名・決まりの名前と値・数・手本の値だけ(合言葉は、にせの決まった字)
(function(){
  'use strict';
  const V = {"probe":"w6b-0.1.0","secret":"W6b-probe-secret","t":"YalbQKKQNc4pz6Xp64EECpvnR0KsX5zK1rNQ4PrBf3I","k":"1Vqp_zfgXoPjj3BBJt6YJL","k2":"eppYDIqSkmAmuCqnXR74Ki","km":"wZdCJKmUs2OjSJRaQy60Lk","sha":"c4d022a163818137ed4e1b6a7a431733e477a6bafea75eda65d69373c98dc940","iv":"AAECAwQFBgcICQoL","gz":"H4sIAAAAAAAACi2NMQrCQBBF7_Lric5ukWLOYWUjm-xAUsSEbFiEsBC1ETyReJw0egtZFR58XvPfjAgxhCMEsa9dtQ0geI0Q-MMw9pWC4CYILNuyMKaw5Y5ZvmyYeQ_CqDVk_l-1k3Yha2jaIW-jzkN-SujU5djr9livz_dyXi93pEQ4QeaU0gev0wM-kQAAAA","d":"AAECAwQFBgcICQoLkC35v4KuGkwmtEqsmBrJ-DxXOQKKwJooSeaFYAY02yRwSMRA4mUTXDtvZfpwfdgvOSi-HDa5TEBeTaW6OwXhBcgzgoEyUi0fQjlYE_NdLQyue8zAqyGrBXb7Ipd7ZvtYYzFNdjq1LwyoyaGcpkJV8Z1oU3jgOF6w0giTh-9P3WRb_zI9xOFNad0S0c56QobS_7RqN44wPROvArAqDTQPeMU","plain":"{\"v\":1,\"n\":\"vocab/s\",\"dev\":\"d_probe\",\"at\":\"2026-11-26T00:00:00.000Z\",\"rec\":{\"v\":1,\"items\":{\"ship\":{\"head\":\"ship\",\"mean\":\"船・送る\"}},\"x\":{}}}","plainB":"{\"probe\":\"W6b\",\"ja\":\"単語帳と復習\",\"n\":12345}","ping":"https://yukisasami7350-debug.github.io/yomu/tashikame/w6b/ping.txt","pingText":"w6b-ping"};
  const win = window, doc = document;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const out = { probe: V.probe, host: location.hostname, at: new Date().toISOString(), env: {}, ck: {}, ms: {}, size: {}, csp: {}, err: {} };
  const viol = [];
  try {
    doc.addEventListener('securitypolicyviolation', e => {
      let b = String(e.blockedURI || '');
      try { b = new URL(b).hostname; } catch (x){}
      if (viol.length < 8) viol.push({ d: String(e.effectiveDirective || e.violatedDirective || ''), b: b.slice(0, 80) });
    });
  } catch (e){}

  // ---- 板(赤い枠。ページのいちばん上) ----
  const host = doc.createElement('div');
  host.setAttribute('data-yomu-probe-w6b', '');
  host.style.cssText = 'all:initial;position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;';
  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  const box = doc.createElement('div');
  box.style.cssText = 'font:15px/1.5 system-ui,-apple-system,sans-serif;color:#111;background:#fff;border:3px solid #c62828;border-radius:10px;padding:10px 12px;max-height:70vh;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,.25);';
  const title = doc.createElement('div');
  title.style.cssText = 'font-weight:700;margin-bottom:4px;';
  title.textContent = 'たしかめW6b(' + out.host + ')';
  const sum = doc.createElement('div');
  sum.style.cssText = 'font-weight:700;margin:4px 0;';
  sum.textContent = '確かめています…(数秒)';
  const list = doc.createElement('div');
  const row = doc.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;';
  const area = doc.createElement('textarea');
  area.style.cssText = 'display:none;width:100%;height:120px;margin-top:8px;font:12px monospace;';
  area.readOnly = true;
  const note = doc.createElement('div');
  note.style.cssText = 'margin-top:6px;color:#444;font-size:13px;';
  function button(label, fn){
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'font:15px system-ui,sans-serif;min-height:44px;padding:0 16px;border:2px solid #1a237e;border-radius:8px;background:#fff;color:#1a237e;';
    b.addEventListener('click', fn);
    return b;
  }
  const copyBtn = button('結果をコピー', copy);
  copyBtn.disabled = true;
  row.appendChild(copyBtn);
  row.appendChild(button('とじる', () => host.remove()));
  [title, sum, list, row, area, note].forEach(n => box.appendChild(n));
  root.appendChild(box);
  const put = () => { if (!host.isConnected) doc.documentElement.appendChild(host); };
  put();
  [800, 2500].forEach(n => setTimeout(put, n));
  function line(ok, label, extra){
    const d = doc.createElement('div');
    d.textContent = (ok ? '✅ ' : '❌ ') + label + (extra ? '(' + extra + ')' : '');
    if (!ok) d.style.color = '#b71c1c';
    list.appendChild(d);
  }
  function text(){ return 'W6b ' + JSON.stringify(out); }
  function copy(){
    const t = text();
    const shown = () => { area.style.display = 'block'; area.value = t; area.focus(); area.select(); };
    try {
      win.navigator.clipboard.writeText(t).then(() => { note.textContent = 'コピーしました(' + t.length + ' 文字)。部屋に貼ってください。'; },
        () => { shown(); note.textContent = 'コピーできなかったので、下の字を全部えらんでコピーしてください。'; });
    } catch (e){ shown(); note.textContent = 'コピーできなかったので、下の字を全部えらんでコピーしてください。'; }
  }

  // ---- 道具 ----
  const now = () => (win.performance && win.performance.now ? win.performance.now() : Date.now());
  const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  function b64u(bytes){
    let s = '';
    const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/, '');
  }
  function unb64u(str){
    let s = String(str).split('-').join('+').split('_').join('/');
    while (s.length % 4) s += '=';
    const b = atob(s), a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  }
  const hex = buf => Array.from(new Uint8Array(buf)).map(x => (x < 16 ? '0' : '') + x.toString(16)).join('');
  const cat = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a, 0); c.set(b, a.length); return c; };
  const subtle = () => win.crypto.subtle;
  async function hkdf(secret, info){
    const key = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, key, 256));
  }
  const hmacKey = raw => subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const aesKey = raw => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  async function nameOf(nk, p){ return b64u(new Uint8Array(await subtle().sign('HMAC', nk, enc.encode(p)))).slice(0, 22); }
  async function pipe(bytes, Stream){
    const s = new Blob([bytes]).stream().pipeThrough(new Stream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const gzip = b => pipe(b, win.CompressionStream || CompressionStream);
  const gunzip = b => pipe(b, win.DecompressionStream || DecompressionStream);
  async function seal(ek, k, bytes, iv){
    iv = iv || win.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(k) }, ek, bytes));
    return b64u(cat(iv, ct));
  }
  async function open(ek, k, d){
    const a = unb64u(d);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: a.subarray(0, 12), additionalData: enc.encode(k) }, ek, a.subarray(12)));
  }
  async function step(name, label, fn){
    try {
      const r = await fn();
      const ok = r === true || (r && r.ok === true);
      out.ck[name] = ok ? 1 : 0;
      line(ok, label, r && r.note);
      return ok;
    } catch (e){
      out.ck[name] = 0;
      out.err[name] = String((e && e.name ? e.name + ': ' : '') + (e && e.message || e)).slice(0, 160);
      line(false, label, out.err[name].slice(0, 60));
      return false;
    }
  }
  function brief(ua){
    const m = [];
    const os = /(iPhone OS|CPU OS|Mac OS X|Windows NT|Android)[ 0-9_.]*/.exec(ua);
    if (os) m.push(os[0].trim());
    (ua.match(/(Version|Edg|Chrome|Firefox|Mobile)\/[0-9A-Za-z.]+/g) || []).forEach(x => m.push(x));
    return m.join(' ');
  }

  // ---- 確かめ ----
  let nk = null, ek = null, k = null;   // 名前の鍵・中身の鍵・手本のかたまりの名前(下の big も使う)
  async function run(){
    const gi = typeof GM_info === 'object' && GM_info ? GM_info : null;
    out.env = {
      ua: brief(String(win.navigator.userAgent || '')),
      tm: gi ? String(gi.scriptHandler || '') + ' ' + String(gi.version || '') : '?',
      sandbox: gi && gi.sandboxMode ? String(gi.sandboxMode) : '?',
      secure: !!win.isSecureContext,
      has: {
        crypto: typeof win.crypto, subtle: typeof (win.crypto && win.crypto.subtle), cs: typeof win.CompressionStream, ds: typeof win.DecompressionStream,
        blobStream: typeof (win.Blob && win.Blob.prototype && win.Blob.prototype.stream), response: typeof win.Response, te: typeof win.TextEncoder
      }
    };
    const S = enc.encode(V.secret);
    await step('rand', '乱数を作る', () => { const a = win.crypto.getRandomValues(new Uint8Array(16)); return a.some(x => x !== 0); });
    await step('sha', 'SHA-256 が PC と同じ', async () => hex(await subtle().digest('SHA-256', enc.encode('yomu-sync/space/1:' + V.t))) === V.sha);
    await step('t', '合言葉から置き場の鍵(HKDF)が PC と同じ', async () => {
      const a = now(); const t = b64u(await hkdf(S, 'yomu-sync/auth/1')); out.ms.hkdf = Math.round((now() - a) * 10) / 10;
      return t === V.t;
    });
    await step('k', 'かたまりの名前(HMAC)が PC と同じ', async () => {
      nk = await hmacKey(await hkdf(S, 'yomu-sync/name/1'));
      ek = await aesKey(await hkdf(S, 'yomu-sync/enc/1'));
      k = await nameOf(nk, 'vocab/s');
      return k === V.k;
    });
    await step('open', 'PC で作った中身を開ける(AES-GCM と gzip)', async () => dec.decode(await gunzip(await open(ek, k, V.d))) === V.plain);
    await step('seal', 'PC と同じ中身を作れる', async () => (await seal(ek, k, unb64u(V.gz), unb64u(V.iv))) === V.d);
    await step('aad', '名前を入れかえた中身は開けない(見分ける)', async () => {
      try { await open(ek, V.k2, V.d); } catch (e){ return true; }
      return false;
    });
    await step('gz', '縮めて、戻す(CompressionStream)', async () => {
      const b = enc.encode(V.plain + V.plain);
      const z = await gzip(b);
      return dec.decode(await gunzip(z)) === V.plain + V.plain && z.length < b.length;
    });
    await step('mine', 'この端末で中身を作る(PC で開いて確かめる)', async () => {
      const km = await nameOf(nk, 'probe/mine');
      out.mine = { k: km, d: await seal(ek, km, await gzip(enc.encode(V.plainB))) };
      return km === V.km;
    });
    await step('dk', '鍵の別の作り方(deriveKey)', async () => {
      const base = await subtle().importKey('raw', S, 'HKDF', false, ['deriveKey']);
      const key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('yomu-sync/enc/1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return dec.decode(await gunzip(await open(key, k, V.d))) === V.plain;
    });
    await step('big', '1MB ほどの中身に鍵をかけて、開ける', big);
    await step('head', 'このページの決まり(CSP)を読む', csp);
    await step('cors', 'ほかのサイト(github.io)へ通信できる', async () => {
      const a = now();
      const res = await win.fetch(V.ping, { credentials: 'omit', redirect: 'error', cache: 'no-store' });
      const t = (await res.text()).trim();
      out.ms.ping = Math.round(now() - a);
      return { ok: res.ok && t === V.pingText, note: res.status + '・' + out.ms.ping + 'ms' };
    });
    out.csp.viol = viol;
    const bad = Object.keys(out.ck).filter(n => !out.ck[n]);
    sum.textContent = bad.length ? '❌ できないものがあります。「結果をコピー」を押して、部屋に貼ってください。' : '✅ 全部できました。「結果をコピー」を押して、部屋に貼ってください。';
    sum.style.color = bad.length ? '#b71c1c' : '#1b5e20';
    copyBtn.disabled = false;
  }

  // 1MB ほどの、単語帳のかたまりに似た中身(創作のでたらめな字)。作る → JSON → 縮める → 鍵 → 字にする、と、その逆を 3 回ずつ
  async function big(){
    let seed = 20261126;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const pick = a => a[Math.floor(rnd() * a.length)];
    const SYL = ['ba', 'ko', 'ti', 'mer', 'lan', 'do', 'vi', 'sha', 'nor', 'pel', 'ist', 'ar', 'en', 'ou', 'zu', 'gra', 'tem', 'lo', 'ne', 'ri'];
    const JP = ['かりの意味', 'ためしの語', '見本の言い回し', '霧の町の郵便屋', '灯りをともす', '港へ向かう', 'ほんとうの辞書ではない'];
    const word = () => { let w = ''; const n = 2 + Math.floor(rnd() * 3); for (let i = 0; i < n; i++) w += pick(SYL); return w; };
    const rec = { v: 1, items: {}, x: {} };
    let n = 0;
    const T = 1790000000;
    while (JSON.stringify(rec).length < 1000000){
      const id = 's' + word() + n++;
      const h = [];
      for (let i = 0; i < 6; i++) h.push([T + i * 86400 + n, 1 + Math.floor(rnd() * 4), 'd_probe']);
      rec.items[id] = { v: 1, id, head: id, kind: 'word', mean: pick(JP) + '・' + pick(JP), meanSrc: 'dict', forms: [word()],
        ex: [{ en: 'The ' + word() + ' ' + word() + ' walked to the ' + word() + ' by the sea.', jp: pick(JP) + '、' + pick(JP) + '。' }],
        at: '2026-11-26T00:00:00.000Z', upd: '2026-11-26T00:00:00.000Z', del: null, rv: { r: { h } }, x: {} };
    }
    const kb = await nameOf(nk, 'vocab/b');
    const t = { json: [], gz: [], seal: [], open: [], gunzip: [], parse: [] };
    let d = '', z = null, b = null;
    for (let i = 0; i < 3; i++){
      let a = now(); const s = JSON.stringify(rec); b = enc.encode(s); t.json.push(now() - a);
      a = now(); z = await gzip(b); t.gz.push(now() - a);
      a = now(); d = await seal(ek, kb, z); t.seal.push(now() - a);
      a = now(); const z2 = await open(ek, kb, d); t.open.push(now() - a);
      a = now(); const b2 = await gunzip(z2); t.gunzip.push(now() - a);
      a = now(); const back = JSON.parse(dec.decode(b2)); t.parse.push(now() - a);
      if (Object.keys(back.items).length !== n) throw new Error('戻した中身が合わない');
    }
    Object.keys(t).forEach(x => { out.ms[x] = Math.round(med(t[x])); });
    out.size = { items: n, chars: JSON.stringify(rec).length, bytes: b.length, gz: z.length, d: d.length };
    const total = ['json', 'gz', 'seal'].reduce((m, x) => m + out.ms[x], 0);
    return { ok: true, note: '鍵をかけるまで ' + total + 'ms・縮めて ' + Math.round(z.length / 1024) + 'KB' };
  }

  // このページの決まり(CSP): 見出し(同じページを HEAD で 1 回)と、ページの中の meta。値は長ければ切る
  async function csp(){
    const pick = (s, name) => {
      const m = String(s || '').split(';').map(x => x.trim()).filter(Boolean);
      const d = m.find(x => x.split(/\s+/)[0].toLowerCase() === name);
      return d ? d.slice(0, 240) : null;
    };
    const names = s => String(s || '').split(';').map(x => x.trim().split(/\s+/)[0].toLowerCase()).filter(Boolean);
    let res = null;
    try { res = await win.fetch(location.href, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' }); } catch (e){ out.err.headFetch = String(e && e.message || e).slice(0, 120); }
    const h = res && res.headers ? res.headers.get('content-security-policy') : null;
    const ro = res && res.headers ? res.headers.get('content-security-policy-report-only') : null;
    const metas = Array.from(doc.querySelectorAll('meta[http-equiv]')).filter(m => String(m.getAttribute('http-equiv')).toLowerCase() === 'content-security-policy').map(m => m.getAttribute('content') || '');
    out.csp = {
      status: res ? res.status : null, h: !!h, ro: !!ro, meta: metas.length,
      dirs: names(h).concat(metas.map(names).reduce((a, x) => a.concat(x), [])).slice(0, 20),
      connect: pick(h, 'connect-src') || metas.map(m => pick(m, 'connect-src')).find(Boolean) || null,
      def: pick(h, 'default-src') || metas.map(m => pick(m, 'default-src')).find(Boolean) || null
    };
    const limited = !!(out.csp.connect || out.csp.def);
    return { ok: !!res, note: res ? (limited ? '通信の決まりがある=部屋が読む' : '通信の決まりは無い') : '読めない' };
  }

  setTimeout(() => { run().catch(e => { sum.textContent = '❌ 途中で止まりました: ' + (e && e.message || e); copyBtn.disabled = false; }); }, 300);
})();
