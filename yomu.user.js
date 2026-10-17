// ==UserScript==
// @name         Blendio
// @namespace    urn:yomu-reader
// @version      0.1.31
// @description  Web 小説を、英語まじりで読む(読むエンジン)
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM_registerMenuCommand
// @run-at       document-end
// @noframes
// @sandbox      DOM
// @downloadURL  https://raw.githubusercontent.com/yukisasami7350-debug/yomu/main/yomu.user.js
// @updateURL    https://raw.githubusercontent.com/yukisasami7350-debug/yomu/main/yomu.user.js
// ==/UserScript==

/* yomu userscript 0.1.31 — tools/build.js が作る。手で直さない */
(function(){
'use strict';
var Yomu = {};
Yomu.t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();   // 束が動き始めた時(どのページでもの見分けの時間を測る=§9-8)
Yomu.build = {"target":"userscript","dev":false,"name":"Blendio","dictUrl":"https://raw.githubusercontent.com/yukisasami7350-debug/yomu/main/dict-v1.txt","dictBytes":4510087};

/* ---- shell/env_userscript.js ---- */
// shell/env_userscript.js — Tampermonkey の中で動く入れ物(部品の約束 §2-1・§2-2。iPhone の Safari と、PC の Edge)
//   env_page.js と同じ形。違うのは、shared が Tampermonkey の保存(GM_*。全サイト共通・消えにくい)になること。
//   site はページの IndexedDB(サイトごと。訳したページ・辞書の写し)。通信はページの fetch を少しずつ読む。
//   見出しの @sandbox DOM で、ページから切り離した世界で動く(§2-2)。ページの側の window には、何も置かない。
//   にせの翻訳サーバーには向けない(apiBase は null。dev の束には、この入れ物を入れない)
(function(){
  'use strict';
  const Y = Yomu;
  const win = typeof window !== 'undefined' ? window : null;
  const safe = fn => { try { return fn(); } catch (e){ return undefined; } };   // プライベートブラウズなどで、さわるだけで失敗することがある
  const attempt = fn => new Promise(resolve => resolve(fn()));                  // 同期の失敗も、Promise の失敗にする

  // Tampermonkey の保存(§2-2)。同期の関数(GM_*)があれば、それを使う。無い入れ物(Userscripts など)は GM.*(Promise の形)
  //   値は JSON の文字にして置く(入れ物ごとの、値の写し方の違いに頼らない。読めない値は「無い」と同じ)
  const gmSync = typeof GM_getValue === 'function' && typeof GM_setValue === 'function'
    && typeof GM_deleteValue === 'function' && typeof GM_listValues === 'function';
  const gmObj = typeof GM === 'object' && GM ? GM : null;
  const gmAsync = !!gmObj && ['getValue', 'setValue', 'deleteValue', 'listValues'].every(n => typeof gmObj[n] === 'function');
  const raw = gmSync ? {
    get: k => GM_getValue(k), set: (k, s) => GM_setValue(k, s), del: k => GM_deleteValue(k), list: () => GM_listValues()
  } : gmAsync ? {
    get: k => gmObj.getValue(k), set: (k, s) => gmObj.setValue(k, s), del: k => gmObj.deleteValue(k), list: () => gmObj.listValues()
  } : null;
  const parse = s => { if (typeof s !== 'string') return undefined; try { return JSON.parse(s); } catch (e){ return undefined; } };
  function gmKV(){
    return {
      backend: 'gm',
      get: k => attempt(() => raw.get(k)).then(parse),
      set: (k, v) => attempt(() => raw.set(k, JSON.stringify(v))).then(() => {}),
      del: k => attempt(() => raw.del(k)).then(() => {}),
      keys: prefix => attempt(() => raw.list()).then(ks => Array.from(ks || []).map(String).filter(k => !prefix || k.startsWith(prefix)).sort())
    };
  }

  // 初めて使うときに、保存先を選ぶ(IndexedDB → localStorage → メモリ。選ぶ処理は core/store.js の kv.pick に1つだけ)
  function lazyKV(name){
    let kv = null, picking = null;
    const ready = () => picking || (picking = Y.store.kv.pick({
      indexedDB: safe(() => win && win.indexedDB), localStorage: safe(() => win && win.localStorage), name
    }).then(k => { kv = k; return k; }));
    return {
      get backend(){ return kv ? kv.backend : null; },   // 選ぶ前は null(store.init が meta を読むので、起動のあとは決まっている)
      get: key => ready().then(k => k.get(key)),
      set: (key, value) => ready().then(k => k.set(key, value)),
      del: key => ready().then(k => k.del(key)),
      keys: prefix => ready().then(k => k.keys(prefix))
    };
  }

  // 通信(§5-1): fetch → body.getReader() → TextDecoder(stream)。文字の途中で切れた塊は、次の塊を待つ
  //   行き先を変える返事には、ついていかない(API キーの付いた要求を、別の行き先へ送り直さない)
  const http = {
    async stream(req){
      const res = await win.fetch(req.url, { method: req.method || 'GET', headers: req.headers || {}, body: req.body, signal: req.signal, redirect: 'error' });
      if (!res.ok) return { status: res.status, ok: false, text: await res.text() };
      const reader = res.body.getReader();
      const dec = new win.TextDecoder('utf-8');
      for (;;){
        const { done, value } = await reader.read();
        if (done) break;
        const t = dec.decode(value, { stream: true });
        if (t && req.onChunk) req.onChunk(t);
      }
      const tail = dec.decode();
      if (tail && req.onChunk) req.onChunk(tail);
      return { status: res.status, ok: true, text: '' };
    }
  };

  // 内蔵辞書を、配る場所から取ってくる(§7-3 の A)→ 辞書の文字。取っている間、onProgress(届いたバイト数, 全体のバイト数か null)
  //   配る場所は、ビルドが入れる(Yomu.build.dictUrl = build.config.json の baseUrl + 辞書のファイル名。ページからは受け取らない)
  const dictUrl = (Y.build && typeof Y.build.dictUrl === 'string' && Y.build.dictUrl) || null;
  async function dictLoad(opt){
    opt = opt || {};
    if (!dictUrl) throw Object.assign(new Error('内蔵辞書を配る場所が、この束に入っていない(build.config.json の baseUrl)'), { kind: 'bad' });
    const res = await win.fetch(dictUrl, { signal: opt.signal, redirect: 'error', credentials: 'omit' });
    if (!res.ok) throw Object.assign(new Error('内蔵辞書を取ってこられなかった: ' + res.status), { kind: 'network', status: res.status });
    const total = Number(Y.build && Y.build.dictBytes) || null;       // 全体の量は、ビルドが入れる(縮んで届くので、届いた見出しの量は当てにならない)
    const reader = res.body.getReader();
    const dec = new win.TextDecoder('utf-8');
    let out = '', got = 0;
    for (;;){
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      out += dec.decode(value, { stream: true });
      if (opt.onProgress) opt.onProgress(got, total);
    }
    return out + dec.decode();
  }

  const nav = (win && win.navigator) || {};
  const ua = String(nav.userAgent || '');
  const touch = !!win && (('ontouchstart' in win) || (nav.maxTouchPoints || 0) > 0);
  const gmInfo = safe(() => (typeof GM_info === 'object' && GM_info) || (gmObj && gmObj.info)) || null;

  Y.env = {
    kind: 'userscript',
    dev: false,
    shared: raw ? gmKV() : lazyKV('yomu-shared'),                     // GM の保存が無い入れ物では、ページの保存(サイトごとになる。設定の「この版」に出る)
    site: lazyKV('yomu-site'),
    http,
    apiBase: null,
    dict: { load: dictLoad },
    info: { handler: String((gmInfo && gmInfo.scriptHandler) || 'userscript'), ios: /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && touch), touch },
    // Tampermonkey のメニューに 1 行(§2-2。v1.50 工程8c-1)。PC の Tampermonkey では、拡張機能のメニューに出る見込み。
    //   iPhone でも出る(工程8c-1。版 0.1.26 で確かめた=§11-1。工程1 では、前の版の項目が出なかった)。
    //   入口は、今までどおりページの上にもある(メニューに出なくても、困らない)
    onToggle(fn, opt){
      if (typeof fn !== 'function' || typeof GM_registerMenuCommand !== 'function') return;
      const label = String((opt && opt.label) || '');
      if (!label) return;
      safe(() => GM_registerMenuCommand(label, () => { try { fn(); } catch (e){} }));
    }
  };
})();

/* ---- core/config.js ---- */
// core/config.js — 数値と初期値の正(部品の約束 §1-6)。部品の中に数字を書かず、ここから読む
(function(){
  'use strict';
  Yomu.config = {
    version: '0.1.31',              // エンジンの版(@version と同じ。出すたびに上げる)
    schema: 1,                     // 保存の形の版(§8-2)
    dayBoundaryHour: 4,            // 「学習日」の境(端末の時刻で午前4時。§1-2)
    text: {
      min: 8,                      // 地の文は、これより短ければ訳さない
      minQuoted: 5,                // 「」のせりふと、カッコを含む文は、これより短ければ訳さない
      long: 90,                    // これを超える文は、順番をいちばん後ろにする
      short: 60,                   // a1(3級)で先に出す文の長さ
      mergeLen: 8,                 // これ以下の文は、すぐ後ろの文と合体する
      mergeMax: 80,                // 合体は、合わせてこの長さまで
      labelMax: 12                 // 「 の前が、これ以下の長さで、読点が無く、ひらがなで終わらなければ「名前だけ」(台本のような書き方)と見て、地の文とは数えない
    },
    ratio: { step: 5, initial: 40 },
    page: {                        // ページへの当てはめ(§3)
      waitMs: 5000,                // 本文の入れ物がまだ無いとき、待って探し直す時間
      sweepLegacy: true,           // 今の版(小説まぜりんご)が動いていなければ、それがサイトの保存に残したもの(API キーの控え など)を消す(§9-8)
      pollMs: 250,                 // 探し直す間隔
      watchMs: 1000,               // URL が変わったかを見る間隔
      stuckMs: 6000,               // 本文ページなのに、起動(保存を読む)がこれだけ終わらなければ、知らせる(store.openMs より長く。§9-8)
      // どのページでも: 記事のあるページの見分け(§3。v1.51 工程8c-1。線は工程8b が本物の 27 ページで決めた案3 改。出さなすぎ寄り=設計メモ 2-6。使いながら直す)
      detect: {
        w: 2.5,                    // 日本語の字(かな・漢字・全角の記号)1 字を、英語の何字と数えるか(見本の英訳で 2.50〜2.66)
        kana: 0.15,                // かなの割合が、これより少なければ、日本語のページと見ない
        sample: 3000,              // 日本語の確かめで、本文の字を前から何字まで見るか(空白を除く)
        chars: 500,                // いちばん長く続いた所の、リンクでない字(重みつき。日本語で約 200 字)がこれ以上
        ends: 3,                   // 文の終わり(。！？ など)がこれ以上
        same: 0.4,                 // その字の、この割合以上が、同じ親にある(節 section はまたぐ)
        list: 0.5,                 // 箇条書きと表の中の字が、この割合より少ない
        link: 0.5, linkMin: 25,    // リンクの字がこの割合以上で、linkMin 字以上のまとまりで、続きを切る(見出しのリンク・記事の一覧)
        at: [2000, 6000],          // 起動のあと、もう一度見る時(ms)。ほかに、load のあとと、最初のタップかキーの tapMs あと
        tapMs: 1000,
        redrawMs: 1000,            // 記事と分かったあと、この間隔で、ページの側が本文を作り直していないか(覚えた段落・描いた英文がページから外れたか)を見る(工程8d: Yahoo!ニュース。0 = 見ない)
        redrawMax: 5,              // 作り直しに付き合うのは、1 ページでこの回数まで(何度も作り直すページで、探し直しを続けない)
        log: false,                // 版 0.1.28・0.1.29(工程8d の測る版)だけ true にした(0.1.30 で false に戻した)。確かめ用の版だけ true: 見分けにかかった時間を、全サイト共通の保存の logKey に新しい logMax 件だけ残す(工程8d。ふだんは、記事と分かるまで保存にさわらない)
        logKey: 'diag/detect',
        logMax: 20
      },
      web: {                       // どのページでもの鍵(§3 の「鍵」。あとから変えにくい=§8)
        dropQuery: '^(utm_.*|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|ttclid|igshid|mc_cid|mc_eid|_ga|_gl)$',   // URL の ? から後ろで、見ない名前(広告の追跡の印。正規表現の字・大文字小文字は見ない)
        epMax: 200, epHead: 120,   // pageKey の / のあとが epMax 字を超えたら、頭の epHead 字+~+全体のハッシュ
        hideMax: 200               // 右下のボタンを出さないサイトの数の上限(設定 hide。工程8c-2。超えたら古い方から落とす)
      }
    },
    diag: {                        // 調べるための記録(§9-8)
      leave: true,                 // ページを離れたときの様子を、全サイト共通の保存に1つ控えるか
      leaveKey: 'diag/leave',      // その置き場所
      leaveMax: 30,                // 離れたあと、控えを書き直す回数の上限
      readMs: 500                  // 控えを読むのを待つ時間(保存が止まっていても、記録は出せるように)
    },
    wire: {
      K: 6,                        // 目印の長さ(文字)。0 = 目印なし、-1 = 全文の復唱(§6-2)
      kMax: 16,                    // ページのほかの文と目印が同じになるページでは、区別が付くまで、ここまで目印を長くする(K 以下なら、長くしない)
      ruby: 'aozora',              // ルビの渡し方('none' で渡さない)
      keySlack: 1,                 // 1 文字短い目印は、いつも受ける。目印を長くするときは、この分だけ余分に長くする
      keyShare: 0.66,              // 返ってきた目印が、頼んだ長さの、この割合より短ければ、ふつうは受けない(6 文字なら 4 文字・13 文字なら 9 文字は要る)
      keyMin: 3,                   // それより短くても、ページ全体で1つの文にだけ合い、番号の並びとも合う目印は、この文字数まで受ける(工程T-4。§6-4)
      E: 6,                        // 終わりの目印の長さ(文字)。AI に、英文のあとに、その英文が訳している文の末尾 E 文字を書かせる。0 = 頼まない(工程T-4。§6-2・§6-4)
      eMax: 12,                    // 近くの文と終わりの目印が同じになるページでは、区別が付くまで、ここまで長くする(E 以下なら、長くしない)
      endMin: 3,                   // AI が頼んだ長さより短く書いた終わりの目印の、比べる文字がこれより少なければ(「た。」「す」)、比べずに使う(手がかりにならない。工程T-4 の本物の返事)
      splitMax: 3,                 // まとめ訳を分けるとき(工程T-4b。§6-4)、範囲に見るのは、同じ段落の、うしろ何文までか
      splitRatio: 3,               // 分けた英文と日本語の長さの比が、範囲全体の比から、この倍より離れていたら、分けない
      splitMin: 6,                 // 長さの比を見るのは、日本語がこの長さ以上の文だけ(短い文は、比がゆれる)
      // 目印の照らし合わせを、ゆるめる(工程8e-2a。設計メモ 2-2・§6-4 の「ゆるめた照らし合わせ」。AI の写しまちがい「待つ → 待る」で、正しい英文を捨てないため)。0 = ゆるめない
      endLoose: 0.6,               // 終わりの目印: 終わりの字が同じで、字の並びのこの割合以上が、その文の終わりのあたりに順に入っていれば使う(前後の送った文の方が近くないときだけ)
      endPad: 4,                   //   その文の終わりのあたり = "e" と比べる長さ + この字数
      headLoose: 0.7,              // 頭の目印: 番号の指す文の書き出しと、字の並びのこの割合以上が合えば使う(ページのほかのどの文より headGap 以上はっきり合うときだけ)
      headGap: 0.15,
      realign: 3,                  // 目印の合う文が2つ以上あるとき、ずれを見込んだ位置の前後いくつまでを、候補にするか
      maxTargets: 0,               // 1回の通信で送る対象の文の上限。0 = 上限なし(まるごと1回)
      fallbackMax: 400000          // 配列の形で読めなかった返事を、終わりに読み直すために取っておく文字数の上限
    },
    check: {                       // 返ってきた訳の確かめの物差し(§6-4。見当の数字。§6-8 の実測で直す)
      jaMax: 0.3, minLen: 20, shortDrop: 0.05, shortFlag: 0.1,
      sameMax: 6,                  // 文の中の、ちがう字の数が、これ以下なら「同じ字ばかりの文」(長い叫び声)と見て、短すぎの確かめをしない
      longFlag: [1.2, 6], longDrop: [2.5, 10]
    },
    idioms: {                      // 熟語さがしの結果の受け取り方(§6-5)
      max: 5,                      // 1文に付ける熟語の数の上限
      mMax: 80,                    // 熟語の意味の長さの上限(これより長いものは、意味として受け取らない)
      noteShare: 0.5,              // 送った文のうち、この割合以上が届かなかったときだけ「途中までしか届きませんでした」と知らせる(目分量。2026-10-17 利用者。工程T-5b)
      gapMax: 6,                   // 離れた熟語(handed ... back)の間に入ってよい語の数(core/tokens.js。工程T-5c。試しで 7 語の 1 個を取りこぼした。広げるほど、熟語でない所に当たりやすい)
      gMax: 20, gLen: 40           // 文法の印(g。工程G1 のあと)を、いくつまで・何文字まで受け取るか
    },
    llm: {
      temp: { translate: null, idiom: null, dict: null },   // null = 指定しない(§5-3)
      maxOut: null,                // null = モデルの上限まで
      keyIn: 'header',             // API キーの送り方。'header' = 見出し / 'query' = 現行と同じ ?key=(自動では切り替えない。§5-3)
      lightBudget: 1024,           // 思考「軽い」の量(gemini-3 系でないモデル。現行と同じ)
      midBudget: 8192,             // 思考「中」「高」の量(gemini-3 系でないモデル。工程T-3。目分量=2.5 Flash の上限が 24576)
      highBudget: 24576
    },
    quota: {
      tz: 'America/Los_Angeles',   // 回数の日の区切り(§8-5)
      keepMonths: 13               // 回数の記録を残す月の数(今の月との差が、これを超えた月は捨てる)
    },
    store: {
      openMs: 4000,                // IndexedDB が開くのを待つ時間。過ぎたら、次の保存先にする(§8-1)
      holdOnHide: true,            // ページを離れるとき(凍らせて取っておかれるとき・iPhone と iPad)は、IndexedDB の取引を新しく始めない・つながりを閉じる(§8-1。工程5b-2b)
      holdCheckMs: 1000,           // 離れた合図のあとも、ページが生きていて見えていたら、取っておいた読み書きを始める(見に行く間隔)
      evictFactor: 2               // 保存がいっぱいのとき、書こうとしているものの大きさの何倍ぶんまで捨てるか(§8-1)
    },
    pages: {
      keep: { idb: 300, ls: 40 },  // 訳したページを何件まで残すか(§8-4)
      evictShare: 0.1, evictMin: 3,   // 保存がいっぱいのとき、1回に捨てる割合と、最少の件数(§8-1)
      drawLateMs: 250,             // 届いた文を描くのを、画面の1コマの合図が来なくても、これだけ待ったら描く(ms。裏に回っている間は、合図が来ない)
      saveEveryMs: 3000,
      quietMiss: { rate: 0.05, min: 3 }   // 未訳が少ないとき(対象の文の rate 以下、または min 文以下)は、「残り ○ 文は未訳です」の知らせを出さない(設計メモ 2-5。操作部のつまみの下の小さな字と、メニューには出す)
    },
    voice: { rate: 0.95, delayMs: 15 },   // 読み上げの速さの初期値(§8-3)・iPhone 以外で、鳴らし始めを遅らせる時間(止める処理とぶつからないように。§9-7)
    dict: {                        // 内蔵辞書(§7-3)
      ver: 1,                      // 辞書データの版。上げると、端末に置いた写しを取り直す
      key: 'dict/main',            // サイトの保存に置く場所(§8-3)
      checkEvery: 97,              // 取ってきた辞書の形を、何行おきに見るか
      qMax: 80,                    // 引く語句の長さ(これより長いものは引かない)
      alsoMax: 3                   // いっしょに返す見出し(もとの語 など)の数
    },
    aidict: {                      // AI辞書(§7-4・§8-7)
      keep: 2000,                  // 結果を何件まで残すか(サイトごと)
      qMax: 200,                   // 聞く語句の長さ(これより長いものは送らない)
      dropShare: 0.25, dropTries: 4   // 保存がいっぱいのとき、1回に捨てる古い結果の割合と、やり直す回数
    },
    runs: {
      keepDays: 45,                // 通信の記録を残す日数(§8-6)
      rawMax: 600,                 // 相手が返した中身(err.raw)を控える文字数
      textMax: 120                 // そのほかの文字の欄の長さ
    },
    log: {                         // 読んだ記録(§8-8)
      idleSec: 120, settleMs: 3000, minSec: 5, seenMinDs: 10, keepDays: 400,
      flushSec: 30,                // 読んでいる間、保存に書く間隔
      tickMs: 1000,                // 画面に出ている段落を見る間隔(page/watch.js)
      evMax: 400,                  // 1つのひと続きに残す、操作の明細の数
      titleMax: 80,                // 題名の長さ
      xKeepDays: { idb: 400, ls: 30 }   // 詳しい分を残す日数(保存先が IndexedDB のとき/それ以外)
    },
    vocab: { exMax: 3, headMax: 80 },  // 単語帳の例文の数・見出しの長さ(§8-7)
    links: { geminiKey: 'https://aistudio.google.com/apikey' },   // 設定の「AI につなぐ」から開く、API キーを作るページ(Google AI Studio)
    plan: { kind: 'own' },         // つなぎ方(core/plan.js)。own = 各自が、自分の API キーで使う(通信の数・モデルの名前を見せる)
    ui: {                          // 操作部(§9-2・§9-3)
      bottom: 12,                  // 操作部の、画面の下のふちからの高さ(px。Safari の帯と安全な余白の上)
      modelMinVer: 3,              // 「一覧から取ってくる」で、版の数字が、これより小さい AI は、並べない(古い世代。数字の無い名前は、見ない)
      shortMax: 480,               // 画面の高さがこれ以下(iPhone の横向き)なら、下から出る板は、画面いっぱいまで・単語の板の下の行を固定しない(px)
      wideMin: 560, wideWidth: 358,   // 画面の幅がこれ以上なら、操作部を右下に寄せて、この幅にする(px)
      wideSheet: 440,              // 広い画面での、板(単語の板・メニュー・設定)の幅(px。中の1行が、英字で 50 字ほど=読みやすい1行の長さ 45〜75 字の中。§9-9)
      offlineEntry: false,         // メニューに「オフライン保存」の入口を出すか(工程5c-3 利用者: 当面、作らない。許されるかは、最後の段階で調べて決める。あとから組み込めるように、入口の場所は残す=true にすると、「準備中」の札が出る)
      themePick: false,            // テーマを手で選ぶ所を出すか(false = いつもサイトの色に合わせる。手で選ぶと、サイトの色と合わずに浮く=設計メモ 2-5。機能は残す: サイトを足すときに確かめ直す)
      thinkPick: false,            // 訳す AI の「考える深さ」を選ぶ所を出すか(false = 出さず、訳はいつも思考なし=settings.modelFor。工程T-2c 利用者: 確かめるまで隠す。
                                   //   「軽く考える」は、本物の AI に送って結果が残っている 70 回(うち「軽く考える」11 回)のどれも、考えた量が 0 だった。工程T-3 で試した、Flash-Lite に本当に考えさせる「中」「高」は、3級らしさが変わらず、待ち時間だけ延びた=工程T-3b の終わりに、利用者が、出さないと決めた。
                                   //   出すなら、効き目を確かめ、名前と添え書きを事実に合わせてから=設計メモ 2-3)
      hideOnScroll: true,          // 下へ読み進めている間は、操作部を隠す(設計メモ 2-5)
      hideDy: 40, showDy: 12,      // 下へこれだけ送ったら隠す・上へこれだけ戻したら出す(px)
      quietMs: 600,                // 操作のすぐあと(表示が変わって、読んでいる場所を合わせ直している間)は、隠す・出すを決めない
      tipMs: 1200,                 // つまみを離したあと、割合の数字を出しておく時間
      voiceFirst: 6,               // 設定の「音声」で、先に並べる声の数(残りは「ほかの声も見る」)
      fileName: 'yomu',            // 設定の「書き出す」で作るファイルの名前の頭(yomu-all-年月日.json。アプリ名は入れない)
      runsPage: 20,                // 設定の「通信の記録」を、1回に出す件数(「もっと見る」で、この数ずつ)
      toastMs: 2400,               // 短い知らせを出しておく時間
      toastLongMs: 6000,           // 長い短い知らせ(右下のボタンを出さないサイトにした など。戻し方まで読めるように)
      twoTapMs: 4000,              // 2回タップで確かめる操作の、2回目を待つ時間
      aiWaitMs: 30000,             // 「AIに聞く」: これだけの間、何も届かなければ、止めて知らせる(工程5c-3: Google の側が混んで、返事が来ないまま「聞いています…」が続いた。数は目分量=ふだんの答えは数秒)
      twoTapMinMs: 350,            // 1回目から、これより早い2回目は数えない(指が弾んだ二度押し)
      modelHide: 'image|tts|audio|live|embed|robotics|computer-use|banana|omni|latest|transcribe|customtools',   // 「一覧から取ってくる」で、並べない AI(名前に、この字が入るもの=絵・音声・読み上げ・埋め込み など、文を訳す用でないもの。設定の画面だけの決まり)
      guardMs: 300,                // 入口の台が出てきたすぐあと(隠れていたのが出た・中止で戻った)は、この間「ブレンド」を受けつけない(押しまちがいで回数を使わない。§9-3)
      foldMs: 4000,                // 操作部: ひらいたつまみを、さわらずにこれだけたったら、たたむ(ロゴと「60%」だけの形に。設計メモ 2-5)
      lift: { on: true, max: 120, everyMs: 2000, sideGain: 0.5 },   // サイトが画面の下に固定しているもの(広告など)をよける: 低い帯(高さ max まで)は、その上へ上げる/もっと大きいものは、左へよける(重なりが、右に置くときの sideGain 倍より小さくなるときだけ)。everyMs = 見に行く間隔
      noteMax: 120,                // 知らせの行に添える、相手の返した文の長さ
      meanLines: 3,                // 単語の板: 内蔵辞書の意味を、はじめに何行まで出すか(残りは「ほかの意味も見る」)
      meanChars: 44,               // 単語の板: 内蔵辞書の意味の1行を、はじめに何文字まで出すか(長い行は、区切りのよい所で切って「…」。全部は「ほかの意味も見る」「つづきを見る」)
      headLong: 18,                // 単語の板: 語句がこれより長いとき、見出しの字を小さくする(文字数)
      // 画面の物差し(§9-9。操作部の CSS=ui/style.js は、ここの値だけを使う。外すと check_ui_dock が止める。根拠と出どころは設計書)
      type: [14, 16, 18, 20, 28],  // 字の大きさの段階(px)。14 = 補足と、16 では収まらない小さなボタン/16 = 読む文と主な字/18 = いちばん伝えたい1行/20 = 小さい見出し/28 = 見出し語
      leading: [1.3, 1.5, 1.7],    // 行間(字の大きさの何倍か)。1.3 = ボタンや見出しの中(2行まで)/1.5 = ふつう/1.7 = 何行も読む文
      tap: { min: 44, std: 48, big: 56, gap: 8 },   // 押せる所の高さ(いちばん小さい・ふつう・主なボタン)と、となりとの間(px)
      grid: 4,                     // 余白の刻み(px。細かい合わせに限り、半分の 2 も使える)
      lineMax: 40,                 // 1行の長さの上限(全角の字数)
      motion: { sheet: 220, bay: 220, tip: 150, fill: 200 },   // 動きの長さ(ms。§9-9。100〜400 の間。板が出る・操作部が隠れる出る・割合の数字・進み具合の帯)
      chip: { font: 12, pad: 4 }   // 本文の中の「あ/A」: 字の大きさと、押せる範囲を、丸のまわりへ見えない形で広げる幅(px。行の中に入るので、tap.min は当てはめない)
    }
  };
})();

/* ---- core/util.js ---- */
// core/util.js — 日付の境(午前4時)・複製・パスなどの小道具(部品の約束 §1-2)。CMA学習の core/util.js を写して直した
(function(){
  'use strict';
  const util = {};

  const pad2 = n => (n < 10 ? '0' : '') + n;
  // Date → 端末の時刻での日付 'YYYY-MM-DD'
  util.isoDate = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  // 'YYYY-MM-DD' → Date(端末の時刻で 00:00)
  util.parseDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  // 「学習日」= 端末の時刻を dayBoundaryHour(初期値 4 時)ぶん戻した日付。「回数の日」は別(§8-5)
  util.today = function(now, boundaryHour){
    const h = boundaryHour ?? Yomu.config?.dayBoundaryHour ?? 4;
    const d = now ? new Date(now) : new Date();
    return util.isoDate(new Date(d.getTime() - h * 3600 * 1000));
  };
  // ISO の時刻 → 学習日
  util.dayOf = (ts, boundaryHour) => util.today(new Date(ts), boundaryHour);
  util.addDays = (day, n) => { const d = util.parseDate(day); d.setDate(d.getDate() + n); return util.isoDate(d); };
  util.diffDays = (a, b) => Math.round((util.parseDate(b) - util.parseDate(a)) / 86400000);   // b - a
  util.nowISO = () => new Date().toISOString();
  util.clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  util.isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
  // path: 'a/b/c' または ['a','b','c']
  util.splitPath = path => (Array.isArray(path) ? path.slice() : String(path).split('/').filter(Boolean));
  util.getIn = (obj, path) => util.splitPath(path).reduce((o, k) => (o == null ? undefined : o[k]), obj);
  util.setIn = function(obj, path, val){
    const ks = util.splitPath(path); if (!ks.length) throw new Error('empty path');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++){ if (!util.isPlain(o[ks[i]]) && !Array.isArray(o[ks[i]])) o[ks[i]] = {}; o = o[ks[i]]; }
    if (val === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = val;
    return obj;
  };
  // 文字列の 53bit ハッシュ(36進)。暗号の強さは要らない。同じ文字なら、どの端末でも同じ値になる(cyrb53)
  util.hash53 = function(s){
    s = String(s);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++){
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  // 'tr_m1x9ab3f' の形の、その場かぎりの番号
  util.uid = prefix => (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // n 文字の、でたらめな英数字(端末の番号など)
  util.rand = n => { let s = ''; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
  // 種類つきの失敗(呼んだ側は e.kind で見分ける。§5-5・§8-1)
  util.error = (kind, message, extra) => Object.assign(new Error(message || kind), { kind }, extra);
  // 外から来た名前を、オブジェクトの鍵にしてよいか(読み込んだファイルの中身で、入れ物そのものを書き換えられないように)
  util.safeKey = k => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

  Yomu.util = util;
})();

/* ---- core/diag.js ---- */
// core/diag.js — 調べるための記録(部品の約束 §9-8。工程5b-2b)。動きは変えない
//   起動がどこまで進んだか(段階の名前と、起動からの ms)と、返事を待っている保存の読み書きを、このページのメモリの中に控える。
//   入れるのは、短い名前と数字だけ(ページの文章・題名・作品の番号・API キーは入れない。保存の鍵は、頭の区切りまで)。
//   見せるのは、設定の「この版」と、知らせ stuck の「直し方」の「記録を写す」(ui/settings_diag.js)
(function(){
  'use strict';
  const Y = Yomu;
  const MAX = 60;                 // 控える段階の数(あふれた分は、数だけ数える)
  const clock = () => Date.now();
  const cut = (s, n) => String(s == null ? '' : s).slice(0, n);
  let t0 = clock(), marks = [], more = 0, stageNow = '', seq = 0;
  const wait = new Map();         // 番号 → [名前, 始めた時刻](返事を待っている読み書き)
  const subs = new Set();
  const changed = () => subs.forEach(fn => { try { fn(); } catch (e){} });

  Y.diag = {
    // 起動し直すとき(URL が変わった)に、時計と段階を初めに戻す。待っている読み書きは、そのまま(まだ待っているものは、待っている)
    restart(){ t0 = clock(); marks = []; more = 0; stageNow = ''; },
    // 段階を1つ控える。x は、数字か短い字(省ける)
    mark(name, x){
      stageNow = cut(name, 24);
      if (marks.length >= MAX){ more++; return; }
      const m = [stageNow, clock() - t0];
      if (x !== undefined && x !== null) m.push(typeof x === 'number' ? x : cut(x, 40));
      marks.push(m);
    },
    stage: () => stageNow,
    // 返事を待つ読み書きの、始まりと終わり(保存の部品が呼ぶ)。begin → 番号。end(番号)
    begin(name){ const id = ++seq; wait.set(id, [cut(name, 48), clock()]); changed(); return id; },
    end(id){ if (wait.delete(id)) changed(); },
    // 今、返事を待っているもの → [[名前, 待っている ms]…](始めた順)
    waiting(){ const now = clock(); return Array.from(wait.values()).map(w => [w[0], now - w[1]]); },
    // 待っているものが、増えた・減ったときに呼ぶ(離れたときの控えを書き直すため)→ やめる関数
    onWait(fn){ subs.add(fn); return () => subs.delete(fn); },
    poke: changed,               // 待っているもののほかに、控えを書き直したいとき(離れている間に、読み書きを取っておいた)
    snapshot(){ return { ms: clock() - t0, stage: stageNow, marks: marks.map(m => m.slice()), more, wait: Y.diag.waiting() }; }
  };
})();

/* ---- core/plan.js ---- */
// core/plan.js — つなぎ方ごとの、画面の見せ方の決まり(部品の約束 §9-2。設計メモ 2-2・5章)
//   つなぎ方 = AI の使い方の形。今あるのは own(各自が、自分の API キーを入れて使う)だけ。
//   managed(こちらで用意した従量課金の API を使う=販売のとき)は、まだ作っていない。ここにあるのは、そのときに「内部のことを見せない」ための決まりだけ。
//   画面の部品は、通信の数・モデルの名前などを出す前に、ここに聞く(出し分けを、部品の中に散らさない)。文言の差しかえは ui/text.js(鍵@つなぎ方)
(function(){
  'use strict';
  const cfg = Yomu.config;
  // 見せるもの: cost = 回数を使う押せる所の「通信2回」/ model = モデルの名前(Flash など)/ quota = 今日つかった回数 / runs = 通信の記録 / modelChoice = モデルと思考を選ぶ所
  const SHOWS = {
    own:     { cost: true,  model: true,  quota: true,  runs: true,  modelChoice: true },
    managed: { cost: false, model: false, quota: false, runs: false, modelChoice: false }
  };

  Yomu.plan = {
    kinds: () => Object.keys(SHOWS),
    // 今のつなぎ方(知らない名前なら own)。今は、初期値(config.plan.kind)だけ。つなぎ方を選ぶ画面(工程4c)ができたら、ここが設定を読む
    kind(){ const k = cfg.plan && cfg.plan.kind; return Object.prototype.hasOwnProperty.call(SHOWS, k) ? k : 'own'; },
    // それを画面に見せるか(知らない名前は、見せない)
    shows(what){ return SHOWS[this.kind()][what] === true; }
  };
})();

/* ---- page/sites.js ---- */
// page/sites.js — サイトへの当てはめ(部品の約束 §3)
//   本文ページかどうかを見分け、本文の段落と、前書き・後書きの段落を分けて返す。本文ページでなければ null(操作部を出さない)。
//   なろうとカクヨムの形は、2026-10-03 に工程4a-1 が実物で確かめた(§3 の表)。見本ページ(localhost)は、dev の束だけが同じ当てはめを効かせる。
(function(){
  'use strict';
  const Y = Yomu;
  const config = Yomu.config, util = Yomu.util;
  const adapters = [];
  const LOCAL = ['localhost', '127.0.0.1'];

  const textOf = el => (el ? String(el.textContent || '').replace(/[ \t\r\n]+/g, ' ').trim() : '');   // 全角の空白は、題名の一部として残す
  const pathOf = a => { try { return new URL(a.getAttribute('href'), a.ownerDocument.baseURI).pathname.toLowerCase(); } catch (e){ return ''; } };
  const hrefOf = a => { try { return a ? new URL(a.getAttribute('href'), a.ownerDocument.baseURI).href : null; } catch (e){ return null; } };
  const allP = roots => roots.reduce((out, r) => out.concat(Array.from(r.querySelectorAll('p'))), []);

  // なろう(narou・narou18)。作品は n+4けた+英字、話は数字。短編は話の番号が無い(ep '0')
  //   本文の段落は id が L数字。前書きは .p-novel__text--preface の中の Lp数字、後書きは .p-novel__text--afterword の中の La数字(確かめた)
  const NOTE_BLOCK = '.p-novel__text--preface, .p-novel__text--afterword';
  const narou = (id, host) => ({
    id, hosts: [host],
    page(loc){
      const m = /^\/(n\d{4}[a-z]{1,3})\/(?:(\d+)\/?)?$/i.exec(loc.pathname);
      return m ? { work: m[1].toLowerCase(), ep: m[2] ? String(Number(m[2])) : '0' } : null;
    },
    roots(doc){ const b = doc.querySelector('.p-novel__body') || doc.getElementById('novel_honbun'); return b ? [b] : []; },
    paras(roots){
      const all = allP(roots);
      const inNote = p => !!p.closest(NOTE_BLOCK);
      const main = all.filter(p => /^L\d+$/.test(p.id) && !inNote(p));
      // 本文の段落が1つも見つからないときは、入れ物の中の p を全部本文として扱う(見分けが外れても、訳せなくならない)
      if (!main.length) return { main: all, notes: [] };
      return { main, notes: all.filter(p => main.indexOf(p) < 0 && (/^L[pa]\d+$/.test(p.id) || inNote(p))) };
    },
    title(doc, pg){
      const h1 = textOf(doc.querySelector('.p-novel__title'));
      if (pg.ep === '0') return { work: h1, ep: '' };                                   // 短編: h1 が作品名
      const want = '/' + pg.work + '/';
      const link = Array.from(doc.querySelectorAll('.c-announce a')).find(a => pathOf(a) === want);
      return { work: textOf(link), ep: h1 };
    },
    next(doc){ return hrefOf(doc.querySelector('a.c-pager__item--next')); }
  });

  // カクヨム。本文は .widget-episodeBody の中の p(前書き・後書きの入れ物は無い)。縦組みは body の writingDirection-vertical(確かめた)
  const kakuyomu = {
    id: 'kakuyomu', hosts: ['kakuyomu.jp'],
    page(loc){
      const m = /^\/works\/(\d+)\/episodes\/(\d+)\/?$/.exec(loc.pathname);
      return m ? { work: m[1], ep: m[2] } : null;
    },
    roots(doc){ const b = doc.querySelector('.widget-episodeBody') || doc.querySelector('.js-episode-body'); return b ? [b] : []; },
    paras(roots){ return { main: allP(roots), notes: [] }; },
    title(doc){ return { work: textOf(doc.querySelector('#worksEpisodesEpisodeHeader h1')), ep: textOf(doc.querySelector('.widget-episodeTitle')) }; },
    next(doc){ return hrefOf(doc.getElementById('contentMain-readNextEpisode')); },
    vertical(doc){ return !!(doc.body && doc.body.classList.contains('writingDirection-vertical')); }
  };

  // 縦組みか(当てはめが見分け方を持っていればそれ、無ければ本文の入れ物の writing-mode)
  function isVertical(adapter, doc, roots){
    if (adapter.vertical && adapter.vertical(doc)) return true;
    const view = doc.defaultView, el = roots[0];
    if (!view || !view.getComputedStyle || !el) return false;
    return /^(vertical|tb|sideways)/.test(String(view.getComputedStyle(el).writingMode || ''));
  }

  // URL → { adapter, pg } | null
  function pick(loc){
    if (!loc || typeof loc.pathname !== 'string') return null;
    const host = String(loc.hostname || '').toLowerCase();
    // 見本ページ: dev の束だけ。/samples/narou.html・/samples/kakuyomu.html(-名前 を付けると、話の番号がその名前になる)
    if (LOCAL.indexOf(host) >= 0){
      if (!(Y.env && Y.env.dev)) return null;
      const m = /^\/samples\/(narou|kakuyomu)(?:-([a-z0-9_]+))?\.html$/i.exec(loc.pathname);
      const a = m && adapters.find(x => x.id === m[1].toLowerCase());
      return a ? { adapter: a, pg: { work: 'sample', ep: m[2] ? m[2].toLowerCase() : '1' } } : null;
    }
    for (const a of adapters){
      if (a.hosts.indexOf(host) < 0) continue;
      const pg = a.page(loc);
      if (pg) return { adapter: a, pg };
    }
    return null;
  }

  // 本文ページなら PageInfo、でなければ null
  function detect(loc, doc){
    const hit = pick(loc);
    if (!hit || !doc) return null;
    const { adapter, pg } = hit;
    const roots = (adapter.roots(doc) || []).filter(Boolean);
    if (!roots.length) return null;
    const { main, notes } = adapter.paras(roots);
    if (!main.length) return null;
    const t = adapter.title(doc, pg) || {};
    const workKey = adapter.id + ':' + pg.work;
    return {
      site: adapter.id, scene: 'novel', workKey, pageKey: workKey + '/' + pg.ep,   // scene = 場面(v1.51。どのページでもは 'article'=page/detect.js)
      title: { work: t.work || textOf(doc.querySelector('title')), ep: t.ep || '' },
      roots, paras: main, notes,
      skip: adapter.skip || 'rt,rp',
      next: adapter.next ? adapter.next(doc) : null,
      vertical: isVertical(adapter, doc, roots)
    };
  }

  // 既知のサイトか(なろう・カクヨムのホスト・dev の束の見本ページ)。既知のサイトでは、本文ページでなくても、今までどおりの起動(§9-8)。
  //   既知でないページは、どのページでもの見分け(page/detect.js)
  function known(loc){
    if (!loc || typeof loc.pathname !== 'string') return false;
    const host = String(loc.hostname || '').toLowerCase();
    if (LOCAL.indexOf(host) >= 0) return !!pick(loc);
    return adapters.some(a => a.hosts.indexOf(host) >= 0);
  }
  const WEB = {};   // どのページでも(site: 'web')の当てはめ: 縦組みは本文の入れ物の writing-mode だけで見る

  Yomu.sites = {
    detect,
    known,
    add(adapter){
      if (!adapter || typeof adapter.id !== 'string' || !Array.isArray(adapter.hosts) || typeof adapter.page !== 'function'
        || typeof adapter.roots !== 'function' || typeof adapter.paras !== 'function' || typeof adapter.title !== 'function') throw util.error('bad', '当てはめの形がおかしい');
      const i = adapters.findIndex(a => a.id === adapter.id);
      if (i >= 0) adapters[i] = adapter; else adapters.push(adapter);
    },
    // 本文ページの URL なのに、本文の入れ物がまだ無いとき(あとから描くサイト)は、opt.ms(初期値 config.page.waitMs)まで探し直す。
    //   本文ページの URL でなければ、すぐに null。opt.signal が中止されたら null
    wait(loc, doc, opt){
      opt = opt || {};
      const ms = opt.ms == null ? config.page.waitMs : opt.ms, every = opt.every || config.page.pollMs;
      return new Promise(resolve => {
        const t0 = Date.now();
        (function again(){
          if (opt.signal && opt.signal.aborted) return resolve(null);
          const info = detect(loc, doc);
          if (info || !pick(loc) || Date.now() - t0 >= ms) return resolve(info);
          setTimeout(again, every);
        })();
      });
    },
    // いまの表示が縦組みか(カクヨムは、ページを読み込み直さずに縦組みへ切り替えられる)
    vertical(info, doc){
      const hit = info && (adapters.find(a => a.id === info.site) || (info.site === 'web' ? WEB : null));
      const d = doc || (info && info.roots[0] && info.roots[0].ownerDocument);
      return !!(hit && d && isVertical(hit, d, info.roots));
    },
    // 本文の背景の色(CSS の色の文字)。本文の入れ物から上へたどって、最初に見つかった、透けていない背景。見つからなければ null
    //   確かめた(2026-10-09 工程4b-2): カクヨムは #contentMain-inner(body のクラス colorTheme-○○ で変わる)、なろうは body(クラス js-customlayout数字 で変わる)
    background(info, doc){
      const d = doc || (info && info.roots[0] && info.roots[0].ownerDocument);
      const view = d && d.defaultView;
      if (!view || !view.getComputedStyle || !info) return null;
      for (let el = info.roots[0]; el && el.nodeType === 1; el = el.parentElement){
        let c = '';
        try { c = view.getComputedStyle(el).backgroundColor; } catch (e){}
        const p = Y.theme.parse(c);
        if (p && p[3] >= 0.5) return c;
      }
      return null;
    },
    // URL が変わったら fn(新しい URL)。ページを読み込み直さずに移るサイトへの備え。戻りは見張りを止める関数
    watch(fn, opt){
      opt = opt || {};
      const get = opt.get || (() => location.href);
      let last = get();
      const t = setInterval(() => {
        const now = get();
        if (now === last) return;
        last = now;
        try { fn(now); } catch (e){ /* 見張りは止めない */ }
      }, opt.every || config.page.watchMs);
      return () => clearInterval(t);
    },
    _pick: pick   // 検査用
  };

  Yomu.sites.add(narou('narou', 'ncode.syosetu.com'));
  Yomu.sites.add(narou('narou18', 'novel18.syosetu.com'));   // 〔未確認〕作りはなろうと同じと見ている(年齢の確かめがあるので開いていない)
  Yomu.sites.add(kakuyomu);
})();

/* ---- page/detect.js ---- */
// page/detect.js — どのページでも: 記事のあるページの見分けと、本文の取り出し・鍵(部品の約束 §3 の「どのページでも」。v1.51 工程8c-1)
//   なろう・カクヨム(既知のサイト)は page/sites.js。ここは、既知でないページだけを見る。
//   見分けは、工程8b の試作 tools/readerable_proto.js の planC と案3 改(E)を移したもの(数を見るための欄は移していない)。
//   束の、先に動く小さな部分に入る(§2-3): 読み込むときに使うのは config と util だけ。ページの保存・画面の部品には、さわらない
(function(){
  'use strict';
  const Y = Yomu;
  const config = Yomu.config, util = Yomu.util;
  const LOCAL = ['localhost', '127.0.0.1'];

  const BLOCK = 'p,div,section,article,main,td,th,li,dd,dt,blockquote,pre,h1,h2,h3,h4,h5,h6,header,footer,nav,aside,figure,figcaption,form,table,tr,tbody,ul,ol,dl,body,center,details,summary,fieldset,address';
  const SKIP = 'script,style,noscript,template,textarea,select,option,button,svg,math,iframe,object,label';
  const BAD = 'nav,aside,footer,header,form,menu,dialog,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"],[role="dialog"],[hidden],[aria-hidden="true"]';
  // Readability の「本文でなさそうな名前」と「本文かもしれない名前」(class か id に当たるか)
  const UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
  const MAYBE = /and|article|body|column|content|main|mathjax|shadow/i;
  const LISTY = /^(LI|DD|DT|TD|TH)$/;
  // 本文の段落にしないもの(日本語のまま。2026-10-17 利用者=設計メモ 2-6): 見出し・写真の説明・表・pre の中
  const NOT_PARA = 'h1,h2,h3,h4,h5,h6,figure,table,pre';

  const cfgD = () => config.page.detect;

  // 字を数える: n = 字の数・wide = 日本語の字(かな・漢字・全角の記号)・kana・sp = 空白・ends = 文の終わり(。！？ と、うしろが空白か終わりの . ! ?)
  function count(s){
    let wide = 0, kana = 0, sp = 0, ends = 0;
    for (let i = 0; i < s.length; i++){
      const c = s.charCodeAt(i);
      if (c <= 32 || c === 0xa0){ sp++; continue; }
      if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)){ kana++; wide++; continue; }
      if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)){ wide++; continue; }
      if ((c >= 0x3000 && c <= 0x303f) || (c >= 0xff01 && c <= 0xff60)){
        wide++;
        if (c === 0x3002 || c === 0xff01 || c === 0xff1f) ends++;
        continue;
      }
      if (c === 46 || c === 33 || c === 63){ const d = s.charCodeAt(i + 1); if (!(d > 32) && d !== 46) ends++; }
    }
    return { n: s.length, wide, kana, sp, ends };
  }
  const unlikely = el => { const m = (el.getAttribute('class') || '') + ' ' + (el.id || ''); return UNLIKELY.test(m) && !MAYBE.test(m); };
  // 画面の形があるか(jsdom には無い=画面に出ているかの確かめを切る)
  const hasLayout = doc => { try { return !!(doc.body && doc.body.getClientRects && doc.body.getClientRects().length > 0); } catch (e){ return false; } };
  const shown = el => { try { return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0; } catch (e){ return true; } };
  const hiddenByAttr = el => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement){
      if (e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true' || (e.style && e.style.display === 'none')) return true;
    }
    return false;
  };

  // 本文の文字の節を、文書の順に(飛ばす要素の中は、まるごと見ない)
  function texts(doc, each){
    const body = doc.body;
    if (!body) return;
    const view = doc.defaultView, NF = (view && view.NodeFilter) || { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
    const tw = doc.createTreeWalker(body, NF.SHOW_ELEMENT | NF.SHOW_TEXT, {
      acceptNode: n => (n.nodeType === 1 ? (n.matches(SKIP) ? NF.FILTER_REJECT : NF.FILTER_SKIP) : NF.FILTER_ACCEPT)
    });
    for (let t = tw.nextNode(); t; t = tw.nextNode()){
      const v = t.nodeValue;
      if (!v || !/\S/.test(v)) continue;
      if (each(t, v) === false) return;
    }
  }

  // 止める条件: 画面に出ているパスワードの入力欄(ログイン・お金の手続きの画面)
  function stop(doc){
    if (!doc || !doc.querySelectorAll) return true;
    const vis = hasLayout(doc);
    return Array.from(doc.querySelectorAll('input[type="password" i]')).some(el => !hiddenByAttr(el) && (!vis || shown(el)) && !el.disabled);
  }

  // 日本語の確かめ(軽い。先にする): 本文の字を前から sample 字まで(空白を除く)見て、かなの割合
  function kana(doc){
    const max = cfgD().sample;
    let n = 0, k = 0;
    texts(doc, (t, v) => {
      const c = count(v);
      n += c.n - c.sp; k += c.kana;
      return n < max;
    });
    return { n, kana: k, share: n ? k / n : 0 };
  }

  // 見分け(案3 改): 文書の順に並んだまとまりを前から見て、いちばん長く続いた所を選ぶ
  //   loose = メニューから(線をゆるめる: かなと、文が 1 つ以上だけ)。vis = 画面に出ていないまとまりを除く(省くと、画面の形があるときだけ)
  function scan(doc, opt){
    opt = opt || {};
    const D = cfgD(), W = D.w;
    const body = doc && doc.body;
    const none = why => ({ ok: false, why, s: 0, ends: 0, nb: 0, grpS: 0, liS: 0, kana: 0, blocks: [] });
    if (!body) return none('short');
    const vis = opt.vis == null ? hasLayout(doc) : !!opt.vis;
    const blocks = new Map();   // 文書の順(最初の字が出た順)
    texts(doc, (t, v) => {
      const pe = t.parentElement;
      if (!pe) return;
      const b = pe.closest(BLOCK) || body;
      let r = blocks.get(b);
      if (!r){ r = { all: 0, link: 0, ends: 0, kana: 0, ch: 0 }; blocks.set(b, r); }
      const s = v.replace(/\s+/g, ' ');
      const c = count(s);
      const w = s.length + (W - 1) * c.wide;
      r.all += w; r.ends += c.ends; r.kana += c.kana; r.ch += c.n - c.sp;
      if (pe.closest('a[href]')) r.link += w;
    });
    const cache = new Map();
    const bad = el => {
      const path = [];
      let res = false;
      for (let e = el; e && e !== body && e.nodeType === 1; e = e.parentElement){
        if (cache.has(e)){ res = cache.get(e); break; }
        path.push(e);
        if (e.matches(BAD) || (e.style && e.style.display === 'none') || unlikely(e)){ res = true; break; }
      }
      path.forEach(e => cache.set(e, res));
      return res;
    };
    let best = null, cur = null;
    const close = () => { if (cur && (!best || cur.s > best.s)) best = cur; cur = null; };
    blocks.forEach((r, b) => {
      if (!r.all) return;
      if (b.closest('figure')) return;                                              // 写真・図の中(説明の字)は、続きを切らず、数えない(v1.53 工程8d: ログインした日経は、説明の入れ物の名前に footer があり、本文がそこで切れた)
      if (bad(b) || (vis && !shown(b))){ close(); return; }                        // 頭・足・メニュー・関連の記事・画面に出ていない所 などで切る
      if (r.link / r.all >= D.link && r.link >= D.linkMin){ close(); return; }     // リンクの多いまとまり(見出しのリンク・一覧)で切る
      if (!cur) cur = { s: 0, ends: 0, kana: 0, ch: 0, list: [] };
      const own = r.all - r.link;
      cur.s += own; cur.ends += r.ends; cur.kana += r.kana; cur.ch += r.ch;
      cur.list.push([b, own, r]);
    });
    close();
    if (!best) return none('short');
    // まとまりの形: 同じ親にある字の割合(節 section はまたぐ)・箇条書きと表の中の字の割合
    let inList = 0;
    const byS = new Map();
    best.list.forEach(([b, own]) => {
      if (LISTY.test(b.tagName)) inList += own;
      let q = b.parentElement;
      while (q && q.tagName === 'SECTION' && q.parentElement && q.parentElement !== body) q = q.parentElement;
      byS.set(q, (byS.get(q) || 0) + own);
    });
    let top = 0;
    byS.forEach(v => { top = Math.max(top, v); });
    const out = {
      s: Math.round(best.s), ends: best.ends, nb: best.list.length,
      grpS: best.s ? top / best.s : 0, liS: best.s ? inList / best.s : 0, kana: best.ch ? best.kana / best.ch : 0,
      blocks: best.list.map(x => x[0]), _list: best.list, _all: blocks
    };
    let why = null;
    if (out.kana < D.kana) why = 'nojp';
    else if (opt.loose){ if (out.ends < 1) why = 'few'; }
    else if (out.s < D.chars) why = 'short';
    else if (out.ends < D.ends) why = 'few';
    else if (out.grpS < D.same) why = 'scattered';
    else if (out.liS >= D.list) why = 'list';
    out.ok = !why; out.why = why;
    return out;
  }

  // 本文の取り出し: いちばん長く続いた所のまとまり → 段落(§3 の「本文の場所」)
  function parasOf(sc){
    const all = sc._all, inner = new Set();
    all.forEach((r, b) => { for (let e = b.parentElement; e; e = e.parentElement){ if (inner.has(e)) break; inner.add(e); } });   // ほかのまとまりを中に持つ入れ物
    return sc._list.filter(([b, own, r]) => !inner.has(b) && !b.closest(NOT_PARA) && own > 0 && r.link / r.all < config.page.detect.link).map(x => x[0]);
  }
  function common(els){
    if (!els.length) return null;
    let a = els[0].parentElement;
    while (a && !els.every(e => a.contains(e))) a = a.parentElement;
    return a;
  }

  // 鍵(§3 の「鍵」。あとから変えにくい=§8)
  function queryOf(search, drop){
    const out = [];
    String(search || '').replace(/^\?/, '').split('&').forEach(kv => {
      if (!kv) return;
      const i = kv.indexOf('=');
      const k = i < 0 ? kv : kv.slice(0, i);
      let name = k;
      try { name = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e){}
      if (drop.test(name)) return;
      out.push(kv);
    });
    return out.sort().join('&');
  }
  const pathOf = p => String(p || '').replace(/\/{2,}/g, '/').replace(/^\//, '').replace(/\/$/, '');
  function keys(loc, doc){
    const W = config.page.web;
    const drop = new RegExp(W.dropQuery, 'i');
    const host = String(loc.hostname || '').toLowerCase();
    const workKey = 'web:' + host;
    const path = pathOf(loc.pathname);
    let search = loc.search;
    // 同じホストで同じ道の正規の URL があれば、問いは、そちらのもの
    const link = doc && doc.querySelector && doc.querySelector('link[rel="canonical" i][href]');
    if (link){
      try {
        const c = new URL(link.getAttribute('href'), doc.baseURI || loc.href);
        if (c.hostname.toLowerCase() === host && pathOf(c.pathname) === path) search = c.search;
      } catch (e){}
    }
    const qs = queryOf(search, drop);
    let ep = (path || '_') + (qs ? '?' + qs : '');
    if (ep.length > W.epMax) ep = ep.slice(0, W.epHead) + '~' + util.hash53(ep);
    return { workKey, pageKey: workKey + '/' + ep };
  }

  const clean = s => String(s || '').replace(/[ \t\r\n]+/g, ' ').trim();
  function titleOf(doc, host){
    const m = doc.querySelector('meta[property="og:site_name"][content]');
    const h1 = doc.querySelector('h1');
    const t = doc.querySelector('title');
    return { work: clean(m && m.getAttribute('content')) || host, ep: clean(h1 && h1.textContent) || clean(t && t.textContent) };
  }
  function vertical(doc, el){
    const view = doc.defaultView;
    if (!view || !view.getComputedStyle || !el) return false;
    try { return /^(vertical|tb|sideways)/.test(String(view.getComputedStyle(el).writingMode || '')); } catch (e){ return false; }
  }

  // 止める条件 → 日本語の確かめ → 見分け → 本文の取り出し → PageInfo
  function page(loc, doc, opt){
    opt = opt || {};
    if (!loc || !doc || !doc.body) return { info: null, why: 'short', scan: null };
    if (stop(doc)) return { info: null, why: 'stop', scan: null };
    const k = kana(doc);
    if (k.share < cfgD().kana) return { info: null, why: 'nojp', scan: null };
    const sc = scan(doc, { loose: !!opt.loose, vis: opt.vis });
    const pub = { ok: sc.ok, why: sc.why, s: sc.s, ends: sc.ends, nb: sc.nb, grpS: sc.grpS, liS: sc.liS, kana: sc.kana, blocks: sc.blocks };
    if (!sc.ok) return { info: null, why: sc.why, scan: pub };
    const paras = parasOf(sc);
    if (!paras.length) return { info: null, why: 'none', scan: Object.assign(pub, { ok: false, why: 'none' }) };
    const root = common(paras) || doc.body;
    const host = String(loc.hostname || '').toLowerCase();
    const kk = keys(loc, doc);
    return {
      info: {
        site: 'web', scene: 'article', workKey: kk.workKey, pageKey: kk.pageKey,
        title: titleOf(doc, host),
        roots: [root], paras, notes: [], skip: 'rt,rp', next: null,
        vertical: vertical(doc, root)
      },
      why: null, scan: pub
    };
  }

  // 本文の頭の字のハッシュ(URL が変わったあと、本文が入れかわったかを見る)
  function sig(info){
    if (!info || !info.paras) return '';
    let s = '';
    for (const p of info.paras){ s += clean(p.textContent); if (s.length >= 300) break; }
    return util.hash53(s.slice(0, 300));
  }

  // 見分けをするページか(既知のサイトでない。localhost・127.0.0.1 は、dev の束の /samples/web/ だけ)
  function web(loc){
    if (!loc || typeof loc.pathname !== 'string') return false;
    if (!/^https?:$/.test(String(loc.protocol || ''))) return false;
    if (Y.sites && Y.sites.known(loc)) return false;
    const host = String(loc.hostname || '').toLowerCase();
    if (LOCAL.indexOf(host) >= 0) return !!(Y.env && Y.env.dev) && /^\/samples\/web\//.test(loc.pathname);
    return !!host;
  }

  Yomu.detect = { web, stop, kana, scan: (doc, opt) => { const r = scan(doc, opt); delete r._list; delete r._all; return r; }, page, keys, sig, _count: count };
})();

/* ---- ui/text.js ---- */
// ui/text.js — 画面の文言の表(部品の約束 §9-2・§9-5)。画面に出す日本語は、ここに1か所
//   つなぎ方ごとに文言を変えるときは、「鍵@つなぎ方」の行を足す(例: 'note.partial@managed')。あれば、そちらを使う(core/plan.js)
//   {名前} の所は、t(key, vars) の vars で入れかえる。{app} は、いつもアプリ名(仮の名前なので、ここには書かない。ビルドが build.config.json の displayName を Yomu.build.name に入れる=§1-1)
(function(){
  'use strict';
  const Y = Yomu;
  const plan = Yomu.plan;
  const appName = () => (Y.build && Y.build.name) || 'yomu';
  const T = {
    // 回数を使う押せる所に書く、通信の数(設計メモ 2-2)。見せるかどうかは、つなぎ方で決まる(Yomu.plan.shows('cost')。出すのは Yomu.ui.cost・withCost)
    'cost.1': '通信1回',
    'cost.2': '通信2回',
    'cost.wrap': '{label}({cost})',
    // 入口のボタン・進み具合・操作部
    'dock.blend': 'ブレンド',
    'dock.blendName': '{label}、{cost}',
    'dock.menu': '{app} のメニュー',
    'dock.ratio': '英語の割合',
    'dock.ratioValue': '{v}%',
    'dock.orig': '原文',
    'dock.fold': '英語の割合 {v}%',
    'dock.progress': '英訳しています',
    'dock.stay': 'この画面のままで、お待ちください',
    'dock.missing': '未訳 {n} / {all} 文',   // all = 対象の文の数(分母があると、だいたい訳せている、と分かる=工程5c-1 利用者)
    'dock.count': '{got} / {total} 文',
    'dock.cancel': '中止する',
    // 知らせの行(§9-5)。押せる所のうち、回数を使うものには、部品が通信の数を足す(Yomu.ui.withCost)
    'note.close': 'とじる',
    'note.noKey': 'API キーがまだ入っていません',
    'note.limitMin': '混み合っています。{sec} 秒ほど待ってから、もう一度押してください',
    'note.limitMinSoon': '混み合っています。少し待ってから、もう一度押してください',
    'note.switched': '{from} が今日の上限のため、{to} で訳しました',
    'note.partial': '残り {n} 文は未訳です',
    // 途中で切れたときは、わけと、どうすればよいかを添える(設計メモ 2-5。工程5c-1)
    'note.cutBusy': 'Google の側が混んでいて、途中で止まりました。残り {n} 文は、少し待ってから訳してください',
    'note.cutNet': '通信がとぎれて、途中で止まりました。残り {n} 文は未訳です',
    'note.needTranslate': 'この目標では、まだ訳していません',
    'note.blocked': 'この話は、AI が内容を理由に訳せませんでした(届いた分は出ています)',
    'note.idioms': '熟語さがしができませんでした(英文は読めます)',
    'note.idiomsLimit': '今日の上限のため、熟語さがしができませんでした(英文は読めます)',
    'note.idiomsPart': '熟語さがしが、途中までしか届きませんでした(英文は読めます)',
    'note.suspect': '訳の並びがずれているおそれがあるため、{n} 文を出しませんでした',
    'note.vertical': '縦組みでは英語を出せません。横組みにすると、英語まじりで読めます',
    'note.full': '端末の保存がいっぱいで、保存できませんでした',
    'note.evicted': '保存がいっぱいなので、古い訳を {n} ページ消しました',
    'note.newer': '新しい版で保存したデータがあります。{app} を新しくしてください',
    'note.conflict': '今の版(小説まぜりんご)と同時には動かせません。どちらかを止めてください',
    'note.stuckIos': 'アプリの準備が止まっています。Safari をいったん閉じて、開き直すと直ります',
    'note.stuck': 'アプリの準備が止まっています。ブラウザをいったん閉じて、開き直すと直ります',
    'act.fix': '直し方を見る',
    // Tampermonkey のメニューから押したのに、日本語の文が見つからなかった(どのページでも。工程8c-2。行き止まりにしない=どうすればよいかを添える)
    'note.nojp': '英語まじりにできる日本語の文が、見つかりませんでした。本文が出てから、もう一度押してください',
    'act.settings': '設定をひらく',
    'act.more': '続きを訳す',
    'act.translate': '訳す',
    'act.redo': '訳し直す',
    'act.idioms': 'やり直す',
    // 1日の上限(キャンバス「無料枠を使い切ったとき」)
    'limit.title': '{model} は今日の無料枠を使い切りました',
    'limit.descLite': '{lite} でも訳せますが、文の組み立てが少し固くなります。無料枠は毎日 夕方(16〜17時ごろ)に戻ります。',
    'limit.desc': '無料枠は毎日 夕方(16〜17時ごろ)に戻ります。',
    'limit.later': 'あとにする',
    'limit.lite': '{lite} で訳す',
    // 失敗の種類ごとの文(§5-5)
    'err.auth': 'API キーが正しくないか、使えません。設定で確かめてください',
    'err.limit': '上限に当たりました。少し待ってから、もう一度押してください(続くときは、今日の上限かもしれません)',
    'err.billing': 'Google の側で、支払いの設定が必要だと言われました',
    'err.model': 'このモデルは使えません。翻訳の設定で選び直してください',
    'err.bad': 'Google が設定を受け付けませんでした',
    'err.busy': 'Google の側が混み合っています。少し待ってから、もう一度押してください',
    'err.network': 'つながりませんでした。電波を確かめてください',
    'err.parse': '返事を読めませんでした。もう一度押してください',
    'err.empty': '使える訳が返ってきませんでした。もう一度押してください',
    'err.other': 'うまくいきませんでした。もう一度押してください',
    'err.detail': '{text}({detail})',
    'clip': '{text}…',
    // Tampermonkey のメニュー(ブラウザの拡張機能のメニューの中。§2-2 の env.onToggle。v1.50 工程8c-1。文言は工程8c-2)
    'tm.toggle': 'このページをブレンド / 日本語に戻す',
    // メニュー(キャンバス3ページ目。学習レベルは出さない=設計メモ 2-5)
    'menu.page': 'このページ',
    'menu.offline': 'オフライン保存',
    'menu.redo': '訳し直す',
    'menu.blend': 'ブレンド(このページを訳す)',
    'menu.redoArmed': 'もう一度押すと、訳し直します',
    'menu.more': '続きを訳す(残り {n} 文)',
    'menu.idioms': '熟語さがしをやり直す',
    'menu.look': '見た目',
    'menu.settings': '設定',
    'menu.learn': '学ぶ画面をひらく',
    // 右下のボタンを出さないサイト(どのページでも。工程8c-2。設計メモ 2-6)。2回タップで決める
    'menu.hide': 'このサイトでは、右下のボタンを出さない',
    'menu.hideArmed': 'もう一度押すと、このサイトでは出しません',
    'menu.hidden': '{site} では、右下のボタンを出しません。戻すときは、設定の「ボタンを出さないサイト」から',
    // 見た目(キャンバス3ページ目の「メニュー › 見た目」)。色の組の呼び名は 'theme.名前'(core/theme.js の組と、そろえる)
    'look.back': 'メニューにもどる',
    'look.theme': 'テーマ(操作部と板、英文の色)',
    'look.auto': 'サイトの色に合わせる(自動)',
    'look.autoShort': 'サイトの色に合わせる',
    'look.autoNow': '今は「{name}」',
    'look.abc': 'Abc',
    'theme.white': '白',
    'theme.cream': '生成り',
    'theme.dark': '暗い',
    'theme.sky': '水色',
    'look.font': '英文の書体',
    'look.font.sans': 'ゴシック体',
    'look.font.serif': 'セリフ体',
    'look.font.site': 'サイトと同じ',
    'look.size': '英文の文字の大きさ',
    'look.size.s': '小さめ',
    'look.size.m': 'サイトと同じ',
    'look.size.l': '大きめ',
    'look.style': '英文の見せ方',
    'look.marker': 'マーカー',
    'look.quiet': '書体だけ',
    'look.sampleJp': '彼女は笑った。',
    'look.sampleEn': 'It was true.',
    // 単語の板(§9-4。キャンバス 4・4b・3ページ目の「単語の板 — もとの語」)
    'word.label': '単語の意味',
    'word.idiom': '熟語',
    'word.srcDict': '内蔵辞書(通信なし)',
    'word.base': 'もとの形',
    'word.viaTail': ' の{kind}',
    'word.kind.s': '複数形・三単現',
    'word.kind.pl': '複数形',
    'word.kind.3sg': '三単現',
    'word.kind.pres': '現在形',
    'word.kind.ed': '過去形・過去分詞',
    'word.kind.past': '過去形',
    'word.kind.pp': '過去分詞',
    'word.kind.ing': '-ing の形',
    'word.kind.comp': '比較級',
    'word.kind.sup': '最上級',
    'word.kind.adv': '副詞の形',
    'word.kind.poss': '「’s」の付いた形',
    'word.kind.contr': '短縮形',
    'word.kind.other': '変化した形',
    'word.also': 'もとの語',
    'word.alsoCase': '同じつづりの語',
    'word.more': 'ほかの意味も見る(あと {n})',
    'word.moreCut': 'つづきを見る',
    'word.none': '内蔵辞書にありません',
    'word.loading': '辞書を用意しています…',
    'word.loadingPct': '辞書を用意しています… {pct}%',
    'word.dictNet': '辞書を取ってこられませんでした。電波を確かめてください',
    'word.dictBad': '辞書を使えませんでした',
    'word.retry': 'もう一度',
    'word.say': '発音を聞く',
    'word.saySent': 'この文を聞く',
    'word.ask': 'この文での意味をAIに聞く',
    'word.asking': 'AIに聞いています…',
    'word.aiSame': 'AI(この文での意味)',
    'word.aiOther': 'AI(前に、別の文で聞いた意味)',
    'word.aiLimit': '今日の上限のため、AIに聞けません',
    'word.aiBlocked': 'AI が、内容を理由に答えませんでした',
    'word.aiEmpty': '答えが返ってきませんでした。もう一度押してください',
    'word.aiSlow': '{sec} 秒待っても、返事がありませんでした。Google の側が混んでいるのかもしれません。少し待ってから、もう一度押してください',
    'word.add': '単語帳に追加',
    'word.added': '単語帳に入っています',
    'word.addedHint': '外すときは、ここを押す',
    'word.removeArmed': 'もう一度押すと外します',
    'word.removed': '単語帳から外しました',
    'word.addFail': '単語帳に入れられませんでした',
    'word.removeFail': '単語帳から外せませんでした',
    'word.prev': '前へひろげる',
    'word.next': '後ろへひろげる',
    'word.reset': 'もとに戻す',
    // 設定(§9-6。画面いっぱいに出す)。トップは、行き先の一覧(まだ無い行き先は、右に「準備中」)
    'set.title': '設定',
    'set.back': '設定にもどる',
    'set.groupAi': 'AI',
    'set.connect': 'AI につなぐ',
    'set.keyIn': 'キーが入っています',
    'set.keyNone': 'キーがまだです',
    'set.models': '翻訳の設定',
    'set.groupRead': '読み方',
    'set.goal': '目標',
    'set.groupMore': '記録とデータ',
    'set.runs': '通信の記録',
    'set.voice': '音声',
    'set.data': '記録・書き出しと読み込み',
    'set.soon': '準備中',
    // 設定 › AI につなぐ(キャンバス3ページ目の「AI につなぐ」)
    'con.lead': '英語にするときだけ、AI に文を送ります。いまは、自分の Gemini のキーで使います(無料の枠があります)。',
    'con.way': 'つなぎ方',
    'con.way.own': '自分の Gemini のキー',
    'con.step1': 'Google AI Studio をひらく(Google のアカウントで入る)',
    'con.step2': '「API キーを作成」を押す',
    'con.step3': 'できたキーをコピーして、下に貼る',
    'con.open': 'Google AI Studio をひらく(別のタブ)',
    'con.key': 'API キー',
    'con.has': 'キーは入っています(画面には出しません)。入れかえるときは、新しいキーを貼ってください。',
    'con.paste': '貼り付け',
    'con.pasteFail': '貼り付けられませんでした。欄を長押しして、貼り付けてください',
    'con.check': 'つながるかを確かめる',
    'con.checkNote': '貼ったキーは、ここで保存します。',
    'con.checkFree': '確かめには、回数を使いません。',
    'con.checking': '確かめています…',
    'con.ok': 'つながりました',
    'con.empty': 'API キーを貼ってください',
    'con.bad': 'このキーでは、つながりませんでした。キーを確かめてください',
    'con.unchecked': 'キーは保存しました。つながるかは、確かめられませんでした。{why}',
    'con.local': 'キーは、この端末の中にだけ保存します。書き出すデータにも入りません。',
    'con.drop': 'キーを消す',
    'con.dropArmed': 'もう一度押すと消します',
    'con.dropped': 'キーを消しました',
    // 設定 › 目標(キャンバス3ページ目。ある人だけ。学習レベルを変える入口は、ここだけ)。級の呼び名は core/levels.js
    'set.goalNone': '決めない',
    'goal.h1': '目標は、ある人だけ',
    'goal.lead': 'はじめは、自然な英語のまま読みます。試験などの目標がある人は、それに合わせた英文にできます。',
    'goal.none': '目標は決めない',
    'goal.noneSub': '自然な英語のまま、気楽に読む',
    'goal.some': '目標がある人は',
    'goal.eiken': '英検・学校',
    'goal.eikenSub': '級に合わせた英文で読む',
    'goal.now': '今は「{name}」',
    'goal.toeic': 'TOEIC・ビジネス',
    'goal.toeicSub': '仕事で使う英語を目指す',
    'goal.toefl': 'TOEFL・学術',
    'goal.toeflSub': '留学や論文の英語を目指す',
    'goal.pick': 'これにする',
    'goal.toGrade': '級を選ぶ',
    'goal.h2': '目標を選んでください',
    'goal.lead2': '今の力は聞きません。目指す所だけで決めます。',
    'goal.grade.a1': '中学卒業程度',
    'goal.grade.a2': '高校中級程度',
    'goal.grade.b1': '高校卒業程度',
    'goal.grade.b2': '大学中級程度',
    'goal.gives': 'この目標で用意するもの',
    'goal.diff': '英文のむずかしさ',
    'goal.diffVal': '{name}向けの英文',
    'goal.ai': '訳す AI',
    'goal.aiLimit': '{model}(1日の目安 {n} 回)',
    'goal.set': '目標を「{name}」にしました',
    'goal.setNone': '目標を決めない(自然な英語)にしました',
    'goal.busy': '訳している間は、変えられません。終わってから、もう一度押してください',
    'act.goal': '目標を変える',
    // 最初の設定(3枚: ようこそ → AI につなぐ → 使い方。キャンバス3ページ目の1段目。見本の文は創作)
    'setup.label': 'はじめに',
    'setup.skip': 'とばす',
    'setup.back': 'もどる',
    'setup.step': '2つのうち {n} つ目',
    'setup.hero1': 'いつもの小説が、',
    'setup.hero2': '少しずつ英語になる。',
    'setup.demoA': '朝の霧は、灯台の足もとまで這い上がってきていた。',
    'setup.demoEn': 'I wiped the cold glass with my sleeve and looked out at the sea.',
    'setup.demoB': '波の音だけが、いつもと同じ調子で続いている。',
    'setup.welcomeNote': 'はじめに、AI につなぎます。1分ほどです。むずかしさは選びません。自然な英語のまま読みます。',
    'setup.start': 'はじめる',
    'setup.checkNext': 'つながるか確かめて、つぎへ',
    'setup.later': 'あとで入れる',
    'setup.howTitle': '使い方は、4つだけ',
    'setup.how1': '「ブレンド」を押すと、英語がまざります',
    'setup.how1d': '押すまでは、何も送りません。',
    'setup.how2': 'つまみで、英語の割合を変えます',
    'setup.how2d': '何度動かしても、通信しません。',
    'setup.how3': '「あ」で、その文だけ日本語に戻せます',
    'setup.how3d': '単語をタップすると、意味が出ます。',
    'setup.how4': 'ロゴを押すと、メニューがひらきます',
    'setup.how4d': '設定や、試験などの目標は、ここから。',
    'setup.chip': 'あ',
    'setup.howNote': 'キーも、メニューの「設定」で変えられます。',
    'setup.go': '読みはじめる',
    // まだ無い機能の入口(設計メモ 2-5)
    'set.saveFail': '保存できませんでした',
    'set.saved': '保存しました',
    'set.voiceAuto': '端末に合わせる',
    'set.voiceAuto.pick': '自動で選ぶ',
    'set.hide': 'ボタンを出さないサイト',
    'set.hideNone': 'なし',
    'set.hideN': '{n} 件',
    'hide.title': 'ボタンを出さないサイト',
    'hide.lead': 'ここにあるサイトでは、記事のページでも、右下のボタンを出しません。英語まじりにしたいときは、Tampermonkey のメニューの「{tm}」から。',
    'hide.none': 'まだ、ありません。記事のページで、右下のロゴを押して出るメニューから選べます。',
    'hide.back': '出すように戻す',
    'hide.backName': '{site} で、ボタンを出すように戻す',
    'hide.backDone': '{site} で、右下のボタンを出すようにしました',
    'mod.lead': '訳すのに使う AI と、今日つかった回数です。',
    'mod.loading': '読んでいます…',
    'mod.today': '今日つかった回数',
    'mod.used': '今日 {n} 回',
    'mod.hit': '今日は、上限に当たりました',
    'mod.limit': '1日の目安',
    'mod.times': '回',
    'mod.limitBad': '目安は、0〜99999 の数字で入れてください',
    'mod.limitSaved': '目安を保存しました',
    'mod.limitReset': '空にしたので、はじめの値({n} 回)に戻しました',
    'mod.none': 'まだ、数えたものはありません',
    'mod.todayNote': '目安は、自分で決める数です(本当の上限は、Google AI Studio で見られます)。目安に達しても、止めません。回数は、毎日 夕方(16〜17時ごろ)に 0 に戻ります。',
    'mod.perLevel': '訳す AI(目標ごと)',
    'mod.std': '目標は決めない',
    'mod.nowMark': '(今)',
    'mod.pair': '{model}・{think}',
    'mod.perLevelNote': '熟語さがしと「AIに聞く」は、いつも Flash-Lite を使います。',
    'mod.think': '考える深さ',
    'mod.think.none': '考えない',
    'mod.think.light': '軽く考える',
    'mod.think.auto': 'おまかせ',
    'mod.thinkSub.none': 'いちばん速い。ふつうは、これで足ります',
    'mod.thinkSub.light': '少し考えてから訳す(やさしい英文に組み直すとき向き)',
    'mod.thinkSub.auto': 'AI が決める(時間がかかることがあります)',
    'mod.onLimit': '1日の上限に達したとき',
    'mod.onLimit.ask': 'そのつど聞く',
    'mod.onLimit.askSub': 'あとにするか、Flash-Lite で訳すかを選びます',
    'mod.onLimit.lite': 'Flash-Lite で訳す',
    'mod.onLimit.liteSub': '聞かずに切りかえて、訳したあとで知らせます',
    'mod.title': '訳す AI',
    'mod.ai': 'AI',
    'mod.list': 'ほかの AI を、一覧から取ってくる',
    'mod.listFree': '回数は使いません',
    'mod.listing': '取っています…',
    'mod.listed': '{n} 個の AI が見つかりました',
    'mod.listNoKey': 'API キーがまだ入っていません。「AI につなぐ」で入れてください',
    'mod.reset': 'はじめの設定に戻す({model}・{think})',
    'mod.resetM': 'はじめの設定に戻す({model})',              // 考える深さを選ぶ所を出していない間(config.ui.thinkPick)
    'mod.resetDone': 'はじめの設定に戻しました',
    'mod.first': 'はじめの設定',
    'mod.now': '今の設定',
    'mod.fetched': '一覧から取ってきた AI',
    'mod.pick': 'これにする',
    'mod.set': '「{level}」の訳す AI を、{model}・{think}にしました',
    'mod.setM': '「{level}」の訳す AI を、{model}にしました',   // 同上
    'mod.onLimit.lead': '訳す AI が、その日の上限に達して、訳せなかったときの動きです。',
    'mod.onLimit.set': '上限に達したときは「{name}」にしました',
    'runs.lead': '翻訳と熟語さがしの通信を、新しい順に並べています({days} 日分)。',
    'runs.rate': '翻訳で使えた文',
    'runs.today': '今日',
    'runs.week': '直近7日',
    'runs.sum': '{got} / {sent} 文({pct}%)・翻訳 {n} 回',
    'runs.sumNone': '翻訳は、まだありません',
    'runs.list': '通信の一覧',
    'runs.none': 'まだ、記録はありません',
    'runs.more': 'もっと見る',
    'runs.role.tr': '翻訳',
    'runs.role.idiom': '熟語さがし',
    'runs.tr': '送った {sent} 文・使えた {got} 文・未訳 {miss} 文・{s} 秒',
    'runs.idiom': '送った {sent} 文・{s} 秒',
    'runs.err': '失敗: {kind}',
    'runs.abort': '中止',
    'runs.drop': '並びがずれた疑いで、使わなかった',
    'runs.length': '長さの上限で、途中まで',
    'voice.lead': '単語と文を読み上げる声です。',
    'voice.voice': '声',
    'voice.auto': '端末の設定に合わせる',
    'voice.auto.pick': '自動で選ぶ',
    'voice.autoSub.ios': 'iPhone の設定で選ばれている声で読みます',
    'voice.autoSub': 'この端末で、いちばん自然な声を自動で選びます',
    'voice.lang.en-US': 'アメリカの英語',
    'voice.lang.en-GB': 'イギリスの英語',
    'voice.lang.en-AU': 'オーストラリアの英語',
    'voice.lang.en-IN': 'インドの英語',
    'voice.lang.en-IE': 'アイルランドの英語',
    'voice.lang.en-ZA': '南アフリカの英語',
    'voice.lang.other': '英語({lang})',
    'voice.wide': 'ほかの声も見る({n})',
    'voice.rate': '速さ',
    'voice.rate.slow': 'ゆっくり',
    'voice.rate.mid': 'ふつう',
    'voice.rate.fast': 'はやい',
    'voice.try': '試しに聞く',
    'voice.stop': '止める',
    'voice.sample': 'The fog never lifts in this harbor town.',
    'voice.cannot': 'この端末では、読み上げが使えません',
    'voice.good': 'enhanced|premium|natural|拡張|プレミアム',
    'voice.tip': 'より自然な声にするには',
    'voice.tip.ios.1': 'iPhone の「設定」→「アクセシビリティ」→「リーダーと読み上げ」→「声」→「英語」をひらく(見つからなければ、設定の検索で「声」)',
    'voice.tip.ios.2': '名前に「拡張」か「プレミアム」と付いた声を選んで、ダウンロードする(1つ 100〜300MB ほど。Wi-Fi で)',
    'voice.tip.ios.3': 'この画面をひらき直して、上の「声」から、入れた声を選ぶ',
    'voice.tipNote.ios': '上の道順は、iOS 26 のものです。Apple の側の画面なので、名前や場所は、iOS の版で変わることがあります。',
    'voice.tip.android.1': '端末の「設定」→「ユーザー補助」→「テキスト読み上げの設定」をひらく',
    'voice.tip.android.2': '優先するエンジンを Google のものにして、歯車の印 →「音声データをインストール」→ 英語を選ぶ',
    'voice.tip.android.3': 'この画面をひらき直して、上の「声」を選ぶ',
    'voice.tipNote.android': '機種によって、名前や場所が違います。',
    'voice.tipNote.edge': 'Edge には、自然な声(名前に Natural と付く声)が、はじめから入っています。「自動で選ぶ」のままで、その声を選びます。入れるものは、ありません。',
    // 設定 › 記録・書き出しと読み込み(§9-6。工程4c-2b)
    'data.log': '読んだ記録を残す',
    'data.log.on': '残す',
    'data.log.off': '残さない',
    'data.logNote': '読んだ時間や、英語で読んだ文の数を、この端末に残します。「残さない」にしても、今までの記録は消えません。',
    'data.restore': '開き直したら、自動で戻す',
    'data.restore.on': '戻す',
    'data.restore.off': '戻さない',
    'data.restoreNote': '前に訳したページを開き直したとき、押さなくても、前と同じ表示に戻します(通信はしません)。',
    'data.out': '書き出す',
    'data.outNote': 'ファイルにして、この端末に保存します。機種を変えるときや、ほかの端末へ写すときに使います。API キーと、訳したページは入りません。',
    'data.outVocab': '単語帳を書き出す',
    'data.words': '{n} 語',
    'data.outAll': '全部を書き出す',
    'data.outAllSub': '設定・単語帳・記録',
    'data.outing': '用意しています…',
    'data.outDone': '「{name}」を用意しました。保存の画面が出たら、保存してください。',
    'data.outLink': '保存が始まらないときは、ここを押す',
    'data.outNone': 'まだ、書き出すものがありません',
    'data.outFail': '書き出せませんでした。もう一度押してください',
    'data.in': '読み込む',
    'data.inNote': 'このアプリで書き出したファイルを選びます。選んだだけでは、まだ何も変わりません。',
    'data.inPick': 'ファイルを選ぶ',
    'data.inTip': 'iPhone で、ファイルが見つからないとき',
    'data.inTip.ios.1': '選ぶ画面の下の「最近使った項目」を見る(書き出したすぐあとは、ここに出ます)',
    'data.inTip.ios.2': '無ければ、下の「ブラウズ」を、場所の一覧が出るまで押して、「ダウンロード」をひらく',
    'data.inTip.ios.3': '上の検索の欄に「{name}」と入れて、「{name}-all-日付.json」を選ぶ(このアプリのファイルのほかは、うすい色で、選べません)',
    'data.inFile': '選んだファイル',
    'data.inAt': '書き出した日時',
    'data.inAtNone': '分かりません',
    'data.inHas': '入っているもの',
    'data.inPicked': 'ファイルを読みました。入っているもの: {has}',
    'data.part.settings': '設定',
    'data.part.vocab': '単語帳 {n} 語',
    'data.part.log': '読んだ記録 {n} 日分',
    'data.part.logx': '読んだ記録の詳しい分',
    'data.part.runs': '通信の記録',
    'data.part.quota': '回数の記録',
    'data.inMerge': '手元に足す',
    'data.inMergeNote': '「手元に足す」では、手元のものは消えません。同じ単語は、新しい方を残します。設定は、入っていれば、ファイルの中身になります。',
    'data.inReplace': '手元を消して、置きかえる',
    'data.inReplaceArmed': 'もう一度押すと、置きかえます',
    'data.inReplaceNote': '「置きかえる」では、ファイルに入っている種類(単語帳・記録・今日つかった回数など)の、手元の分を消してから入れます。もとに戻せません。',
    'data.inDoing': '読み込んでいます…',
    'data.inDone': '読み込みました',
    'data.inDoneReplace': '置きかえました',
    'data.inVocab': '単語帳は、{n} 語になりました。',
    'data.inReload': '読み込んだ設定(目標など)は、ページを開き直すと、そろいます。',
    'data.inSkipped': '読めなかったものが {n} つあり、飛ばしました。',
    'data.inKey': 'API キーは、ファイルに入っていません。「AI につなぐ」で入れてください。',
    'data.inBad.format': 'このファイルは、読み込めません(このアプリで書き出したファイルではないようです)',
    'data.inBad.newer': '新しい版で書き出したファイルなので、読み込めません。先に、このアプリを新しくしてください',
    'data.inBad.full': '保存がいっぱいで、途中で止まりました。空きを作ってから、同じファイルをもう一度読み込むと、続きが入ります',
    'data.inBad.read': 'ファイルを読めませんでした。もう一度選んでください',
    'data.busy': '前の読み込みか、消す操作が、まだ終わっていません。少し待ってから、もう一度',
    'data.inBad.empty': 'このファイルには、読み込めるものが入っていません',
    'data.site': 'このサイトの保存',
    'data.pages': 'このサイトで保存したページ',
    'data.pagesN': '{n} 件',
    'data.clear': 'このサイトの保存を消す',
    'data.clearArmed': 'もう一度押すと、消します',
    'data.cleared': '{n} 件を消しました',
    'data.clearCost': '({cost})',
    'data.clearNote': '消すのは、訳したページの保存だけです。消したページをもう一度英語にするときは、訳し直しになります{cost}。単語帳・記録・「AIに聞く」の答え・辞書は、消えません。',
    'data.clearBusy': '訳している間は、消せません',
    'data.about': 'この版',
    'data.ver': '版',
    'data.env': '入れ物',
    'data.env.page': 'ページに直接(見本ページ)',
    'data.env.userscript': 'ユーザースクリプト',
    'data.env.extension': '拡張機能',
    'data.storeShared': '保存先(全サイト共通)',
    'data.storeSite': '保存先(このサイト)',
    'data.store.gm': 'Tampermonkey の保存',
    'data.store.ext': '拡張機能の保存',
    'data.store.idb': 'この端末の中(IndexedDB)',
    'data.store.ls': 'この端末の中(localStorage。入る量は少なめ)',
    'data.store.mem': '保存できていません(このページを閉じると消えます)',
    'data.memWarn': 'この端末では、保存ができていません。訳したページや記録は、このページを閉じると消えます。',
    // うまく動かないときの画面(ui/settings_diag.js)
    'fix.title': '直し方',
    'fix.head': 'アプリの準備が止まっています',
    'fix.lead': 'この端末の保存を読むのを、待ったままになっています。訳したページや単語帳は、消えていません。',
    'fix.ios1': '画面の下のふちから、上へゆっくりなぞって、途中で指を止めます',
    'fix.ios1d': 'ホームボタンのある iPhone は、ホームボタンを2回押します。',
    'fix.ios2': 'Safari の画面を、上へ払って閉じます',
    'fix.ios2d': 'ホーム画面に戻るだけでは、直りません。',
    'fix.ios3': 'Safari を開き直します',
    'fix.ios3d': '開いていたページは、そのまま残っています。',
    'fix.pc1': 'ブラウザの窓を、全部閉じます',
    'fix.pc1d': 'このページを読み込み直すだけでは、直らないことがあります。',
    'fix.pc2': 'ブラウザを開き直して、このページを開きます',
    'fix.pc2d': '訳したページは、そのまま出ます。',
    'diag.label': '調べるための記録',
    'diag.note': 'うまく動かないわけを調べるための記録です。入っているのは、数字と、段階の名前だけです。小説の文と API キーは、入りません。',
    'diag.copy': '記録を写す',
    'diag.copied': '写しました。メッセージに貼り付けて、送ってください',
    'diag.copyFail': '自動では写せませんでした。下の字を長押しして、全部を選んで写してください',
    'soon': '準備中です'
  };

  const own = key => Object.prototype.hasOwnProperty.call(T, key);
  function t(key, vars){
    const alt = key + '@' + plan.kind();
    const s = own(alt) ? T[alt] : T[key];
    if (s == null) return String(key);
    return s.replace(/\{(\w+)\}/g, (m, k) => (k === 'app' ? appName() : vars && vars[k] != null ? String(vars[k]) : ''));
  }

  Yomu.msg = { t, app: appName, has: own, keys: () => Object.keys(T) };
})();

/* ---- Yomu.rest: 残りの部品。起動が呼ぶまで動かさない(§2-3) ---- */
Yomu.rest = function(){

/* ---- core/levels.js ---- */
// core/levels.js — 学習レベルの一覧と、モデル・思考の初期値(部品の約束 §1-3・§5-3・§8-3、設計メモ 2-3)
//   レベルの ID は CEFR。英検の呼び名は表示だけ(目的ごとの着せ替えは、設計メモ 2-7 が決まってから足す)
(function(){
  'use strict';
  // legacy = 現行スクリプトの learningMode(指示文を移すときの対応。工程3c)
  const LIST = [
    { id: 'std', cefr: null, name: '通常',      shortFirst: false, legacy: 'standard' },
    { id: 'a1',  cefr: 'A1', name: '英検3級',   shortFirst: true,  legacy: 'eiken_grade3' },
    { id: 'a2',  cefr: 'A2', name: '英検準2級', shortFirst: false, legacy: 'eiken_grade_pre2' },
    { id: 'b1',  cefr: 'B1', name: '英検2級',   shortFirst: false, legacy: 'eiken_grade2' },
    { id: 'b2',  cefr: 'B2', name: '英検準1級', shortFirst: false, legacy: 'eiken_grade_pre1' }
  ];
  const BY_ID = {};
  LIST.forEach(l => { BY_ID[l.id] = l; });

  const LITE = 'gemini-3.5-flash-lite';
  const FLASH = 'gemini-3.6-flash';
  // Google が、ほかの名前へ回している名前(工程5c-3: gemini-3.5-flash への通信は、3.6 Flash として数えられていた=利用者の AI Studio の写真)。
  //   設定に残っている古い名前は、読むときに、新しい名前に読みかえる(core/settings.js)
  const MOVED = { 'gemini-3.5-flash': FLASH };

  const levels = {
    initial: 'std',
    list: LIST,
    ids: LIST.map(l => l.id),
    has: id => Object.prototype.hasOwnProperty.call(BY_ID, id),
    get: id => BY_ID[id] || null,
    name: id => (BY_ID[id] ? BY_ID[id].name : String(id)),
    // 短い文を先に英語にするレベルか(§4-3。今は a1 だけ)
    shortFirst: id => !!(BY_ID[id] && BY_ID[id].shortFirst),

    // 思考の選び方('none' = なし / 'light' = 軽い / 'auto' = おまかせ。現行の 0 / 1024 / -1)
    //   'mid' = 中 / 'high' = 高(工程T-3。比べる台本で、Flash-Lite に本当に考えさせると訳が変わるかを試すため。送れるだけ)
    thinkModes: ['none', 'light', 'auto', 'mid', 'high'],
    // 設定の画面に並べる思考(mid・high を並べるかは、工程T-3 の結果を見て、利用者が決める)
    thinkPicks: ['none', 'light', 'auto'],

    // 設定の初期値(§8-3 の Settings と同じ。利用者が設定で変えられる)
    //   3級・準2級も Flash-Lite・思考なし(工程T-2c。2026-10-16 利用者。3.6 Flash は、無料の枠で混雑 503 が続き、終わりまで届かなかった=設計メモ 2-3)
    defaults: {
      provider: 'gemini',
      models: {
        std: { m: LITE, think: 'none' },
        a1:  { m: LITE, think: 'none' },
        a2:  { m: LITE, think: 'none' },
        b1:  { m: LITE, think: 'none' },
        b2:  { m: LITE, think: 'none' }
      },
      aux: { idiom: LITE, dict: LITE, lite: LITE },        // 熟語さがし・AI辞書・「Flash-Lite で訳す」
      limits: { [FLASH]: 20, [LITE]: 500 }                  // 1日の目安(利用者が直す数。設計メモ 2-2)
    },
    // 翻訳のモデルの初期値の版(設定の modelsV。§8-3)。初期値を変えたら上げて、前の初期値を prior に残す
    //   設定には、初期値のままでも、レベルごとのモデルが書き込まれている(最初に読んだとき、初期値を丸ごと書く)。
    //   だから、初期値を変えても、そのままでは前の初期値が残る。前の初期値のままのレベルだけを、新しい初期値に移す(core/settings.js。1回だけ)
    modelsV: 2,
    prior: {
      1: { a1: { m: FLASH, think: 'light' }, a2: { m: FLASH, think: 'light' } }   // 版 0.1.21 まで(工程T-2c で Flash-Lite・思考なしに。名前の読みかえ moved のあとで比べる)
    },

    // モデルごとの例外(§5-3)。noMinimal = 思考「なし」の書き方(MINIMAL)がエラーになるので 'low' にする
    quirks: {
      'gemini-3.8-flash': { noMinimal: true }
    },
    quirk: model => levels.quirks[model] || {},
    moved: MOVED,
    current: model => (Object.prototype.hasOwnProperty.call(MOVED, model) ? MOVED[model] : model)
  };

  Yomu.levels = levels;
})();

/* ---- core/theme.js ---- */
// core/theme.js — 色の組(テーマ)。名前を付けた色の値の正(部品の約束 §9-2)
//   操作部・板(ui)と、ページの中の英文(page/render.js)の色は、ここの名前から取る(色の値を、部品の中に直接書かない)。
//   組を足すときは SETS に1つ足す(同じ名前をそろえる)。文言の表(ui/text.js)に、組の呼び名 'theme.名前' も足す。
//   値の出どころ: design/round3/gen.js の TH(white・cream・dark)と、design/round2/gen.js の T・MARKER・QUIET・PENDING。
//   sky(水色)と、キャンバスに無い名前の値は、工程4b-2 が決めた(2026-10-09 利用者: カクヨムの背景の4色=白・黒・生成り・水色に合わせる)
(function(){
  'use strict';
  const SETS = {
    white: {
      // ページの中(英文・熟語の下線・「あ/A」・これから英語になる文の点線・「あ」で戻した日本語)
      enBg: '#DDF5EA', enInk: '#10231C', idiom: '#0F9960',
      chipBg: '#FFFFFF', chipBd: '#9FD9BD', chipInk: '#0B6E49',
      wait: '#8FD3B6', backBg: '#ECEEFF', backBd: '#B9C1FF', backInk: '#2A38B0',
      // ページの中(見せ方が「書体だけ」のとき)
      quietInk: '#1F2A5C', quietIdiom: '#0B7A5B', quietBack: '#2F3E9E', quietChipBd: '#C9CCD6', quietChipInk: '#5B6072',
      // 操作部・板・メニュー
      panel: '#FFFFFF', panelInk: '#14181F', panelMuted: '#5A6372',
      well: '#F3F5F8', line: '#E3E7ED', grip: '#D5DAE2', ring: '#878D98',
      accent: '#0B6E49', soft: '#E8EBFF', softInk: '#2A38B0',
      go: '#0B8457', goInk: '#FFFFFF', key: '#3D4EDB', keyInk: '#FFFFFF',
      warnBg: '#FDECEA', warnInk: '#A5281B',                    // うまくいかなかったことの知らせ(板の中。答えや意味と、見分けがつくように)
      knob: '#FFFFFF', tip: '#14181F', tipInk: '#FFFFFF',
      scrim: 'rgba(20,24,31,0.28)',
      shadow: '0 10px 30px rgba(20,24,31,0.18),0 0 0 1px rgba(20,24,31,0.06)',
      sheetShadow: '0 -12px 40px rgba(20,24,31,0.22)',
      knobShadow: '0 2px 8px rgba(20,24,31,0.28),0 0 0 1px rgba(20,24,31,0.06)',
      grad: 'linear-gradient(90deg,#3D4EDB 0%,#0FA36B 100%)',
      logoA: '#3D4EDB', logoB: '#0FA36B'
    },
    // 生成り
    cream: {
      enBg: '#DDE6BF', enInk: '#22301A', idiom: '#4E7F2E',
      chipBg: '#FBF6E6', chipBd: '#A9BE86', chipInk: '#3F6622',
      wait: '#A9BE86', backBg: '#E4E3F3', backBd: '#B9BCE8', backInk: '#2A38B0',
      quietInk: '#2B3470', quietIdiom: '#4E7F2E', quietBack: '#2F3E9E', quietChipBd: '#CFC6AC', quietChipInk: '#6A5D49',
      panel: '#FBF6E6', panelInk: '#2E261B', panelMuted: '#6A5D49',
      well: '#EFE6CF', line: '#E3D9BD', grip: '#D3C7A6', ring: '#8D826F',
      accent: '#3F6622', soft: '#E4E3F3', softInk: '#2A38B0',
      go: '#3F6F22', goInk: '#FFFFFF', key: '#3D4EDB', keyInk: '#FFFFFF',
      warnBg: '#F8E1D8', warnInk: '#9C2A1C',
      knob: '#FFFFFF', tip: '#2E261B', tipInk: '#FBF6E6',
      scrim: 'rgba(40,30,15,0.30)',
      shadow: '0 10px 30px rgba(40,30,15,0.18),0 0 0 1px rgba(40,30,15,0.08)',
      sheetShadow: '0 -12px 40px rgba(40,30,15,0.22)',
      knobShadow: '0 2px 8px rgba(40,30,15,0.28),0 0 0 1px rgba(40,30,15,0.08)',
      grad: 'linear-gradient(90deg,#3D4EDB 0%,#0FA36B 100%)',
      logoA: '#3D4EDB', logoB: '#0FA36B'
    },
    // 暗い
    dark: {
      enBg: '#17392D', enInk: '#D9F3E6', idiom: '#3CC28E',
      chipBg: '#22252C', chipBd: '#2F6B55', chipInk: '#7FDDB4',
      wait: '#2F6B55', backBg: '#2B3166', backBd: '#4A54A8', backInk: '#C5CBFF',
      quietInk: '#B9C3FF', quietIdiom: '#3CC28E', quietBack: '#C5CBFF', quietChipBd: '#454A55', quietChipInk: '#A3AAB7',
      panel: '#22252C', panelInk: '#ECEEF2', panelMuted: '#A3AAB7',
      well: '#2D313A', line: '#363B45', grip: '#454A55', ring: '#757A85',
      accent: '#7FDDB4', soft: '#2B3166', softInk: '#C5CBFF',
      go: '#0B8457', goInk: '#FFFFFF', key: '#5565EC', keyInk: '#FFFFFF',
      warnBg: '#4A1F1B', warnInk: '#FFB4A8',
      knob: '#FFFFFF', tip: '#ECEEF2', tipInk: '#14181F',
      scrim: 'rgba(0,0,0,0.45)',
      shadow: '0 10px 30px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.08)',
      sheetShadow: '0 -12px 40px rgba(0,0,0,0.55)',
      knobShadow: '0 2px 8px rgba(0,0,0,0.5),0 0 0 1px rgba(0,0,0,0.2)',
      grad: 'linear-gradient(90deg,#5B6BF0 0%,#1DB87E 100%)',
      logoA: '#6C7BFF', logoB: '#2CC48A'
    },
    // 水色
    sky: {
      enBg: '#B8E6CC', enInk: '#10231C', idiom: '#0C8A55',
      chipBg: '#F4F9FC', chipBd: '#8FCFB0', chipInk: '#0B6E49',
      wait: '#7CC7A6', backBg: '#D9DBFA', backBd: '#AEB6F5', backInk: '#2A38B0',
      quietInk: '#1F2A5C', quietIdiom: '#0B7A5B', quietBack: '#2F3E9E', quietChipBd: '#B4C3CF', quietChipInk: '#52606C',
      panel: '#F4F9FC', panelInk: '#14202A', panelMuted: '#52606C',
      well: '#E3EDF4', line: '#D3E0EA', grip: '#BCCCD8', ring: '#7E8993',
      accent: '#0B6E49', soft: '#DEE3FF', softInk: '#2A38B0',
      go: '#0B8457', goInk: '#FFFFFF', key: '#3D4EDB', keyInk: '#FFFFFF',
      warnBg: '#FBE4E1', warnInk: '#A5281B',
      knob: '#FFFFFF', tip: '#14202A', tipInk: '#FFFFFF',
      scrim: 'rgba(15,30,45,0.30)',
      shadow: '0 10px 30px rgba(15,30,45,0.18),0 0 0 1px rgba(15,30,45,0.08)',
      sheetShadow: '0 -12px 40px rgba(15,30,45,0.22)',
      knobShadow: '0 2px 8px rgba(15,30,45,0.28),0 0 0 1px rgba(15,30,45,0.08)',
      grad: 'linear-gradient(90deg,#3D4EDB 0%,#0FA36B 100%)',
      logoA: '#3D4EDB', logoB: '#0FA36B'
    }
  };
  // ページの中の CSS(page/render.js)が読む名前(操作部の色は、ページの側に並べない)
  const PAGE_KEYS = ['enBg', 'enInk', 'idiom', 'chipBg', 'chipBd', 'chipInk', 'wait', 'backBg', 'backBd', 'backInk', 'quietInk', 'quietIdiom', 'quietBack', 'quietChipBd', 'quietChipInk'];
  const AUTO = 'auto';             // 「サイトの色に合わせる」(設定の値。色の組の名前ではない)
  // 英文の書体と文字の大きさ(組から選ぶ。足すときは、ここと、page/render.js の CSS と、文言の表)
  //   sans = ゴシック体/serif = セリフ体/site = サイトと同じ。s = 小さめ/m = サイトと同じ/l = 大きめ
  const FONTS = ['sans', 'serif', 'site'], SIZES = ['s', 'm', 'l'];
  const STYLE_FONT = { marker: 'sans', quiet: 'serif' };   // 見せ方を切り替えたときに、一緒に変える書体(そのあとで、選び直せる)

  // CSS の色の文字(rgb(…)・rgba(…)・#RGB・#RRGGBB)→ [r, g, b, a]。読めなければ null
  const NUM = '([0-9.]+%?)', SEP = '[ ,/]+';
  const RGB = new RegExp('^rgba?[(] *' + NUM + SEP + NUM + SEP + NUM + '(?:' + SEP + NUM + ')? *[)]$');
  function parse(c){
    const s = String(c == null ? '' : c).trim().toLowerCase();
    let m = RGB.exec(s);
    if (m){
      const ch = x => (x.slice(-1) === '%' ? parseFloat(x) * 2.55 : parseFloat(x));
      const a = m[4] == null ? 1 : m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      const out = [ch(m[1]), ch(m[2]), ch(m[3]), a];
      return out.every(isFinite) ? out : null;
    }
    m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  // サイトの背景の色 → 近い色の組の名前(「サイトの色に合わせる」)。読めない色・透けた色は、初めの組
  //   確かめた背景(2026-10-09 工程4b-2): カクヨム 白 #FFFFFF・黒 #171B1D・生成り #F7F6EB・水色 #DFECF4/なろう 白・黒 #000000・薄い紫 #CCCCFF・薄い緑 #CCFFCC・#FAFAFA・水色 #EDF7FF
  //   生成りは白にとても近いので、色の近さではなく、明るさと色みで分ける: 暗い → dark/青み → sky/黄み・緑み → cream/ほかは white
  function pick(color){
    const c = parse(color);
    if (!c || !(c[3] >= 0.5)) return 'white';
    const r = c[0], g = c[1], b = c[2];
    if ((r * 299 + g * 587 + b * 114) / 1000 < 128) return 'dark';
    if (b - r >= 6) return 'sky';
    if (r - b >= 6 || g - Math.max(r, b) >= 20) return 'cream';
    return 'white';
  }
  // 色を直すときの物差し(check_ui_dock が、どの組でも見る。2026-10-09 利用者: 読みやすい配色か、理屈で確かめる):
  //   字と地の明るさの比(WCAG のコントラスト比)が、字は 4.5 以上(本文になる英文・板の字は 7 以上)・線や印は 3 以上。
  //   色みは、緑(英文・単語帳)と藍(操作・選んだ印)の2つだけ。赤は、失敗の知らせだけ。あざやかな色は、小さい面(ボタン・下線・ロゴ)にだけ使い、
  //   広い面(板・くぼみ・マーカーの地)は、サイトの背景の色みに寄せた、うすい色にする
  const KEYS = Object.keys(SETS.white);
  const kebab = k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

  Yomu.theme = {
    initial: 'white', AUTO,
    fonts: () => FONTS.slice(), sizes: () => SIZES.slice(),
    fontFor: style => STYLE_FONT[style] || FONTS[0],
    // 設定の値(auto か、色の組の名前)として、使えるか
    choice: name => name === AUTO || Object.prototype.hasOwnProperty.call(SETS, name),
    names: () => Object.keys(SETS),
    keys: () => KEYS.slice(),
    pageKeys: () => PAGE_KEYS.slice(),
    parse, pick,
    has: name => Object.prototype.hasOwnProperty.call(SETS, name),
    // その組の値(知らない名前なら、初めの組)
    get(name){ return Object.assign({}, SETS[this.has(name) ? name : this.initial]); },
    // CSS の変数の名前(panelInk → --y-panel-ink)
    varName: (key, prefix) => (prefix || '--y-') + kebab(key),
    // CSS の変数の宣言を並べた文字('--y-panel:#FFFFFF;--y-panel-ink:#14181F;…')。keys を渡したら、その名前だけ
    vars(name, prefix, keys){
      const set = this.get(name);
      return (keys || KEYS).map(k => this.varName(k, prefix) + ':' + set[k]).join(';') + ';';
    }
  };
})();

/* ---- core/text.js ---- */
// core/text.js — 文の分割と、訳す対象かどうかの見分け(部品の約束 §4-1)
//   切り方は現行(小説まぜりんご v1.6.7 の splitIntoSentences)が土台。手本は tests/fixtures/legacy_split.js、突き合わせは tests/check_text.js。
//   現行と変えた所は6つだけ: ①合体はすぐ後ろに続く文とだけ ②90文字超は外さず long を付ける ③かな・漢字の無い文は対象外 ④「」のせりふは5文字から
//                            ⑤地の文の中の「」は、前後の地の文と合わせて1つの文 ⑥！？ の仲間(半角・1文字の記号)が並んでいる間は切らない
(function(){
  'use strict';
  const text = {};

  // 記号だけの行(場面の切れ目・飾り)。現行 isSceneBreak そのまま
  text.isSceneBreak = function(s){
    const trimmed = s.trim();
    if (!trimmed) return true;
    return /^[^a-zA-Z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3400-\u4DBF]+$/.test(trimmed);
  };

  // 短すぎる文か(「あっ」「え?」など)。現行 isTrivialSentence の数え方(記号を除いた文字数)。
  //   q = 「」のせりふか。現行は「」が分割で取り除かれるので、せりふに minQuoted が効いていなかった(変えた所④)
  const BRACKETS = /[「」『』【】（）()""“”＜＞<>]/;
  const SYMBOLS = /[「」『』【】（）()…・！？!?\s""“”＜＞<>\-―_]/g;
  //   1文字の ！？ の仲間と、その後ろに付く見えない文字(下の BANGS・VS)も、記号として数えない(変えた所⑥)
  const SYMBOLS2 = new RegExp('[' + String.fromCharCode(0x203C, 0x2047, 0x2048, 0x2049, 0xFE0E, 0xFE0F) + ']', 'g');
  text.isTrivial = function(s, min, minQuoted, q){
    const quoted = !!q || BRACKETS.test(s);
    const clean = s.replace(SYMBOLS, '').replace(SYMBOLS2, '');
    return clean.length < (quoted ? Math.min(minQuoted, min) : min);
  };

  // かな・漢字を含むか(中黒・長音・濁点の記号だけでは「含む」にしない)
  const JA = /[\u3041-\u3096\u30A1-\u30FA\uFF66-\uFF9D\u3400-\u4DBF\u4E00-\u9FFF\u3005\u3006]/;
  text.hasJa = s => JA.test(s);

  const isWs = ch => ch.trim() === '';   // String.prototype.trim と同じ空白の決まり(全角の空白・改行を含む)

  // ！？ の仲間(変えた所⑥): 全角・半角と、1文字で2つ分の記号(番号 203C・2047・2048・2049。番号で書く=engine/README.md の「書くときの注意」)。
  //   並んでいる間は切らず、並びの終わりで切る(現行は、次が全角の ！？ のときだけ切らなかったので、半角の !? は ! のあとで切れて ? が残った)。
  //   VS = 絵文字の形を選ぶ見えない文字(番号 FE0E・FE0F)。！？ の仲間のすぐ後ろに付いていれば、並びの続きとして扱う(記号と離さない)
  const BANGS = '！？!?' + String.fromCharCode(0x203C, 0x2047, 0x2048, 0x2049);
  const VS = String.fromCharCode(0xFE0E, 0xFE0F);
  const isBang = ch => ch !== '' && BANGS.includes(ch);
  const isVs = ch => ch !== '' && VS.includes(ch);
  const afterBang = function(t, i){
    let k = i - 1;
    while (k >= 0 && isVs(t[k])) k--;
    return k >= 0 && isBang(t[k]);
  };

  // ---- 地の文の中の「」(変えた所⑤) ----
  const WORD = /[\p{L}\p{N}]/u;                    // 文字か数(記号・空白でないもの)
  const HIRA = /[ぁ-ゖ]/;
  const COMMA = '、，,';
  // 「」のほかのかっこ(開く・閉じる)。」 のすぐ後ろがこれなら、文は続いていない。「 の前の、これで閉じたまとまり(（心の声）・【名前】)は、地の文に数えない
  const OPENS = '『（(【《〈＜<［[〔｛{〝｢', CLOSES = '』）)】》〉＞>］]〕｝}〟〞｣';
  const STOP = '」' + OPENS + CLOSES + '“”"‘’。' + BANGS;   // 」 のすぐ後ろがこれなら、文は続いていない(かっこ・引用符・文の終わりの記号)。「 は、continues が別に見る
  const TITLES = ['さん', 'ちゃん', 'くん', 'さま', 'たち'];   // ひらがなで終わっていても、名前と見る終わり方(お姉ちゃん「…」)

  // 位置 i の文字(サロゲートの組=2つで1文字の字は、2つまとめて返す。番号で見る)
  const charAt = function(t, i){
    const c = t.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < t.length){
      const d = t.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) return t.slice(i, i + 2);
    }
    return t[i];
  };

  // 」(位置 j)のすぐ後ろに、文が続いているか(「行こう」と彼女は言った。)。後ろが、読点か、文字か数なら、続いている。
  //   空白・段落の終わり・STOP なら、続いていない。ほかの記号(…・― など)は、その先を見る。
  //   次の「」が続くとき(「はい」「いいえ」「たぶん」の三つだった。)は、その「」の後ろを見る(対になっていない・中に改行のある「 なら、続いていない)。
  //   ただし、「」の並びを通して見るときは、並びの終わりの後ろが、読点か、ひらがなのときだけ「続いている」とする(…「たぶん」の三つ・…「待てよ」と二人は)。
  //   カタカナや漢字で始まる地の文(「おはよう」「おはよう」ミオは笑った。)まで、前の「」をまとめない(別の人のせりふが、いくつも1つの文になるため)。
  //   match = 「 → 」 の対 / closed(i) = 位置 i の「 が、対になっていて、中に改行が無いか
  //   memo = 」 の位置 → [並びの終わりの後ろの種類, その 」 が並びの終わりか](同じ並びを、何度もたどらない)。種類: 0 = 続いていない / 1 = 文字か数 / 2 = 読点か、ひらがな
  function continues(t, j, match, closed, memo){
    const first = memo.get(j);
    if (first) return first[1] ? first[0] > 0 : first[0] === 2;
    const seen = [];
    let kind = 0, end = -1;
    for (;;){
      const m = memo.get(j);
      if (m){ kind = m[0]; break; }
      let next = -1, here = 0;
      for (let k = j + 1; k < t.length; k++){
        const ch = charAt(t, k);
        if (ch === '「'){ next = k; break; }
        if (isWs(ch) || STOP.includes(ch)) break;
        if (COMMA.includes(ch)){ here = 2; break; }
        if (WORD.test(ch)){ here = HIRA.test(ch) ? 2 : 1; break; }
        if (ch.length === 2) k++;
      }
      if (next >= 0 && closed(next)){ seen.push(j); j = match.get(next); continue; }
      kind = here; end = j;
      break;
    }
    seen.forEach(x => memo.set(x, [kind, false]));
    if (end >= 0) memo.set(end, [kind, true]);
    return seen.length ? kind === 2 : kind > 0;
  }
  // 「 の前にあるのが、名前だけか(台本のような書き方: ミオ「おはよう」)。短くて、読点も「」も無く、ひらがなで終わらないもの。
  //   ひらがなで終わっていても、さん・ちゃん などで終わるものは、名前(お姉ちゃん「…」)。
  //   s = 「 の前の文字から、閉じたかっこのまとまりと、前後の空白を除いたもの(ミオ（小声で）「…」は「ミオ」=名前・彼は（たぶん）「…」は「彼は」=地の文)。長さは、字の数(2つで1文字の字は、1文字)
  function labelLike(s, max){
    if (!s || Array.from(s).length > max) return false;
    for (let k = 0; k < s.length; k++){ if (COMMA.includes(s[k]) || s[k] === '「' || s[k] === '」') return false; }
    if (!HIRA.test(s[s.length - 1])) return true;
    return TITLES.some(x => s.endsWith(x));
  }
  // 対になった「」→ Map(「 の位置 → 」 の位置)。閉じていない「・開いていない」は、入らない
  function pairs(t){
    const m = new Map(), st = [];
    for (let i = 0; i < t.length; i++){
      if (t[i] === '「') st.push(i);
      else if (t[i] === '」' && st.length) m.set(st.pop(), i);
    }
    return m;
  }

  // 合体する前の切り方。現行の for 文と同じ順で見て、文字の位置で返す
  //   「」は、ふつうは文の境界(文には含めない)。**地の文の中の「」**(閉じていて、中に改行が無く、下のどちらかに当たるもの)は、境界にせず、
  //   中の 。！？ でも切らずに、前後の地の文と合わせて1つの文にする(『』【】（）の中で切らないのと同じ扱い):
  //     1. 」 のすぐ後ろに、文が続いている  2. 同じ文の中で、「 の前に地の文がある(名前だけなら、当たらない)
  function raw(t){
    const out = [];
    const match = pairs(t), embClose = new Set(), memo = new Map();
    const labelMax = Yomu.config.text.labelMax;
    // 位置 i の「 が、対になっていて、中に改行が無いか(nl = その位置より前の、改行の数)
    const nl = new Int32Array(t.length + 1);
    for (let i = 0; i < t.length; i++) nl[i + 1] = nl[i] + (t[i] === '\n' || t[i] === '\r' ? 1 : 0);
    const closed = function(i){ const j = match.get(i); return j != null && nl[j] === nl[i]; };
    let start = 0;        // 今の文が始まる位置(前後の空白は cut が除く)
    let depth = 0;        // 「」(境界にしたもの)の深さ
    let emb = 0;          // 地の文の中の「」の深さ。この中では切らない
    // 「 の前に地の文があるか = 今の文に、文字か数(か、地の文の中の「」)があるか。ただし、閉じたかっこのまとまり(（心の声）・【名前】)の中のものは、数えない。
    //   gen = 今の文の番号(切るたびに進む)/ baseGen = かっこの外に文字があった文の番号 / blk = まだ閉じていないかっこごとの「中に文字があった文の番号」/
    //   open = blk のうち、今の文で中に文字があったものの数。blk は、切っても持ち越す(かっこは、文をまたいで続く: 《…。…》「よし」の 》 は、前の文で開いたかっこを閉じる)
    let gen = 1, baseGen = 0, blk = [], open = 0;
    const mark = function(){
      if (!blk.length) baseGen = gen;
      else if (blk[blk.length - 1] !== gen){ blk[blk.length - 1] = gen; open++; }
    };
    // 名前だけか(labelLike)を見るための文字: 今の文の頭から今までの、閉じたかっこのまとまりを除いたもの。読みながら作る(「 のたびに読み直さない)。
    //   outs = その文字(前の空白は入れない)/ ost = まだ閉じていないかっこごとの [開いたときの outs の長さ, そのときの last] / last = outs の中の、最後の空白でない文字の位置。
    //   こちらは、文ごとに始めからやり直す(名前は、今の文の頭から 「 までの文字だけで見る。前の文で開いたかっこが、今の文で閉じたら、そこまでを除く)
    let outs = [], ost = [], last = -1;
    const put = function(ch){
      if (isWs(ch)){ if (outs.length) outs.push(ch); return; }
      outs.push(ch);
      last = outs.length - 1;
    };
    let inDouble = 0, inBracket = 0, inParen = 0;   // 『』【】（）の深さ。この中では切らない
    const cut = function(end, next){
      let a = start, b = end;
      while (a < b && isWs(t[a])) a++;
      while (b > a && isWs(t[b - 1])) b--;
      if (b > a) out.push({ a, b, q: depth > 0 });
      start = next;
      gen++; open = 0;
      outs = []; ost = []; last = -1;
    };
    for (let i = 0; i < t.length; i++){
      const ch = t[i];
      if (ch === '「'){
        // 名前だけなら、(2) には当たらない。字の数が labelMax 以下なら、文字の数(番号の単位)は、その2倍以下
        const narration = (baseGen === gen || open > 0) && !(last + 1 <= labelMax * 2 && labelLike(outs.slice(0, last + 1).join(''), labelMax));
        if (closed(i) && (emb > 0 || continues(t, match.get(i), match, closed, memo) || narration)){
          emb++; embClose.add(match.get(i));
          mark();           // 地の文の中の「」は、開く所でも閉じる所でも「文字がある」と数える(かっこが「」をまたいで閉じる形でも、どちらかが残る)
          put(ch);
          continue;
        }
        cut(i, i + 1);      // 境界(文には含めない)
        depth++;
        continue;
      }
      if (ch === '」'){
        if (embClose.has(i)){ emb--; mark(); put(ch); continue; }
        cut(i, i + 1);
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (OPENS.includes(ch)){ blk.push(0); ost.push([outs.length, last]); put(ch); }
      else if (CLOSES.includes(ch)){
        const had = blk.length > 0;
        if (had && blk.pop() === gen) open--;
        if (ost.length){ const s = ost.pop(); outs.length = s[0]; last = s[1]; }   // 今の文で開いたかっこが閉じた: その中を除く
        else if (had){ outs = []; last = -1; }                                    // 前の文で開いたかっこが閉じた(《…。…》ミオ「…」): 文の頭からここまでが、まとまりの中
        else put(ch);                                                             // 開いていない、閉じるかっこ
      } else {
        if (WORD.test(charAt(t, i))) mark();
        put(ch);
      }
      if (ch === '『') inDouble++;
      else if (ch === '』') inDouble = Math.max(0, inDouble - 1);
      else if (ch === '【') inBracket++;
      else if (ch === '】') inBracket = Math.max(0, inBracket - 1);
      else if (ch === '（' || ch === '(') inParen++;
      else if (ch === '）' || ch === ')') inParen = Math.max(0, inParen - 1);
      if (inDouble > 0 || inBracket > 0 || inParen > 0 || emb > 0) continue;

      if (ch === '。' || ch === '\n' || ch === '\r'){
        cut(i + 1, i + 1);
      } else if (isBang(ch) || (isVs(ch) && afterBang(t, i))){
        const nx = i + 1 < t.length ? t[i + 1] : '';
        if (nx !== '」' && nx !== '』' && nx !== '）' && nx !== '】' && !isBang(nx) && !isVs(nx)) cut(i + 1, i + 1);
      }
    }
    cut(t.length, t.length);
    return out;
  }

  // 文に分ける → [{a, b, q}](t.slice(a, b) が文。q = 「」の中か)
  //   合体: mergeLen 文字以下の文は、すぐ後ろに続く文と1つにする(合わせて mergeMax 文字以下のとき。合体したものを、さらに次とは合体しない)。
  //   現行は「」をまたいでも合体したが、別の人のせりふが1つの英文になるので、間に空白以外の文字があるときは合体しない(変えた所①)
  text.split = function(t){
    const cfg = Yomu.config.text;
    const r = raw(t), out = [];
    for (let i = 0; i < r.length; i++){
      const s = r[i], n = r[i + 1];
      if (n && s.b - s.a <= cfg.mergeLen && (s.b - s.a) + (n.b - n.a) <= cfg.mergeMax && t.slice(s.b, n.a).trim() === ''){
        out.push({ a: s.a, b: n.b, q: s.q || n.q });
        i++;
        continue;
      }
      out.push(s);
    }
    return out;
  };
  text._raw = raw;   // 検査用(現行との突き合わせ)

  // 対象か・長いか・短いか。長さは、前後の空白を除いた文字数(現行と同じ数え方)
  //   why = 対象でない理由('nojp' = かな・漢字が無い / 'short' = 短すぎる)。cfg は Yomu.config.text
  text.classify = function(s, q, cfg){
    const c = cfg || Yomu.config.text;
    const len = s.trim().length;
    let why = null;
    if (!text.hasJa(s)) why = 'nojp';
    else if (text.isTrivial(s, c.min, c.minQuoted, q)) why = 'short';
    return { target: !why, why, long: len > c.long, short: len <= c.short };
  };

  // 比べるための形(空白を除く)と、そのハッシュ
  text.norm = s => String(s).replace(/\s+/g, '');
  text.hash = s => Yomu.util.hash53(text.norm(s));

  // 英文の語数(don't・well-known は1語)
  text.words = en => (String(en).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;

  Yomu.text = text;
})();

/* ---- core/order.js ---- */
// core/order.js — 文の並び順(部品の約束 §4-3)。乱数は使わない。順番は、ページの文とレベルだけから決まる(保存しない)
//   検査が確かめる性質(tests/check_order.js): ①入れ子 ②間隔がほぼそろう ③段の順 ④同じ入力なら同じ結果 ⑤0% は 0 文・100% は全部
(function(){
  'use strict';
  const PHI = 0.6180339887498949;   // 黄金比の小数部分
  const frac = x => x - Math.floor(x);
  const order = {};

  // 対象の文に 0〜M-1 の順番を付ける → { [sid]: rank }
  //   段: shortFirst(a1)は 60文字以下 → 61〜90文字 → 90文字超。ほかは 90文字以下 → 90文字超
  //   段の中: 文書の順に j = 0, 1, 2… と数え、(j+1) × PHI の小数部分が小さい順(英語になる文が全体に散る)
  order.rank = function(model, opts){
    const shortFirst = !!(opts && opts.shortFirst);
    const tiers = [[], [], []];
    model.sents.forEach(s => {
      if (!s.target) return;
      tiers[s.long ? 2 : (shortFirst && !s.short ? 1 : 0)].push(s.sid);
    });
    const ranks = {};
    let r = 0;
    tiers.forEach(tier => {
      tier.map((sid, j) => ({ sid, j, key: frac((j + 1) * PHI) }))
        .sort((x, y) => x.key - y.key || x.j - y.j)
        .forEach(x => { ranks[x.sid] = r++; });
    });
    return ranks;
  };

  // 英語にする文の数 = round(M × ratio / 100)。ratio > 0 なら 1 以上
  order.count = function(M, ratio){
    if (!(M > 0) || !(ratio > 0)) return 0;
    return Math.min(M, Math.max(1, Math.round(M * ratio / 100)));
  };

  // その割合で英語にする文 → Set<sid>(rank < k の文)
  order.shown = function(ranks, ratio){
    const sids = Object.keys(ranks);
    const k = order.count(sids.length, ratio);
    const out = new Set();
    sids.forEach(sid => { if (ranks[sid] < k) out.add(Number(sid)); });
    return out;
  };

  // 英語にする文(shown)の中の、英文の無い文(未訳)の数だけ、ほかの文で埋める → Set<sid>(shown に、埋めた文を足したもの)
  //   未訳の文ごとに(本文の順に)、すぐ後ろ(本文の順で次)の、英文があって(ok)、まだ英語にしていない対象の文を選ぶ。後ろに無ければ、すぐ前(工程T-2c 利用者:
  //   割合 N% を保つ・埋める文は、取り消した文より先の所に。読みながら訳を待つ人の目に入るように)。targets = 対象の文(本文の順)
  //   埋め方は、文と訳だけで決まる(同じ入力なら同じ結果。開き直しても同じ文が英語になる)
  order.fill = function(shown, targets, ok){
    const out = new Set(shown);
    const lack = targets.filter(sid => shown.has(sid) && !ok(sid));
    if (!lack.length) return out;
    const free = targets.filter(sid => !shown.has(sid) && ok(sid));   // 埋めに使える文(本文の順)
    const used = new Set();
    lack.forEach(m => {
      let pick = null;
      for (let i = 0; i < free.length && pick == null; i++) if (free[i] > m && !used.has(free[i])) pick = free[i];
      for (let i = free.length - 1; i >= 0 && pick == null; i--) if (free[i] < m && !used.has(free[i])) pick = free[i];
      if (pick != null){ used.add(pick); out.add(pick); }
    });
    return out;
  };

  Yomu.order = order;
})();

/* ---- core/sse.js ---- */
// core/sse.js — 少しずつ届く返事を、1件ずつに分ける(部品の約束 §5-2)
//   塊は、どこで切れていてもよい(行の途中・\r と \n の間)。data: の行をつないで、空行で1件として渡す。
//   data: の付かない行(Gemini が途中のエラーを送る形)は、ためて onBare に渡す。
(function(){
  'use strict';
  const SKIP = /^(?:event|id|retry)(?::|$)/;   // 使わない行
  const DONE = '[DONE]';                        // 終わりの印(OpenAI 互換にある。Gemini には無い)

  function reader(opt){
    opt = opt || {};
    const onData = typeof opt.onData === 'function' ? opt.onData : () => {};
    const onBare = typeof opt.onBare === 'function' ? opt.onBare : () => {};
    let buf = '';        // まだ行になっていない文字
    let seek = 0;        // buf の、ここより前には改行が無い
    let data = null;     // ためている data: の行(null = 無い)
    let bare = [];       // ためている、data: の付かない行
    let first = true, ended = false;

    function flushBare(){
      if (!bare.length) return;
      const s = bare.join('\n');
      bare = [];
      if (s.trim() !== '') onBare(s);
    }
    function flushData(){
      if (data === null) return;
      const s = data.join('\n');
      data = null;
      if (s !== '' && s.trim() !== DONE) onData(s);
    }
    function line(l){
      if (l === ''){ flushBare(); flushData(); return; }
      if (l.charAt(0) === ':') return;
      if (l.startsWith('data:')){
        flushBare();
        (data = data || []).push(l.charAt(5) === ' ' ? l.slice(6) : l.slice(5));
        return;
      }
      if (SKIP.test(l)) return;
      flushData();
      bare.push(l);
    }
    // buf から、終わりまで届いた行を取り出す(終わりが \r のときは、次が \n かどうかを見るまで待つ)
    function takeLines(){
      const out = [];
      let start = 0;
      for (;;){
        let i = seek;
        while (i < buf.length){ const c = buf.charCodeAt(i); if (c === 10 || c === 13) break; i++; }
        if (i >= buf.length || (buf.charCodeAt(i) === 13 && i + 1 >= buf.length)){ seek = i; break; }
        out.push(buf.slice(start, i));
        start = seek = i + (buf.charCodeAt(i) === 13 && buf.charCodeAt(i + 1) === 10 ? 2 : 1);
      }
      buf = buf.slice(start);
      seek -= start;
      return out;
    }

    return {
      push(text){
        if (ended || typeof text !== 'string' || text === '') return;
        if (first){ first = false; if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); }
        buf += text;
        takeLines().forEach(line);
      },
      end(){
        if (ended) return;
        ended = true;
        const rest = buf.charCodeAt(buf.length - 1) === 13 ? buf.slice(0, -1) : buf;
        if (rest !== '') line(rest);
        flushBare();
        flushData();
      }
    };
  }

  Yomu.sse = { reader };
})();

/* ---- core/provider_gemini.js ---- */
// core/provider_gemini.js — Gemini の形(部品の約束 §5-3)。送る形を作る・1件ぶんを読む・失敗を見分ける
//   通信そのものは core/llm.js が行う。ここは、相手ごとに違う所だけを持つ(通信しない・保存しない)
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, levels = Yomu.levels;
  const isPlain = util.isPlain;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const bad = msg => util.error('bad', msg);

  const BASE = 'https://generativelanguage.googleapis.com/v1beta';
  // 終わり方の読みかえ(表に無いものは other)
  const FINISH = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'blocked', RECITATION: 'blocked', BLOCKLIST: 'blocked', PROHIBITED_CONTENT: 'blocked', SPII: 'blocked' };
  // 途中のエラーに HTTP の番号が無いとき、種類の名前から番号を出す
  const CODE = { INVALID_ARGUMENT: 400, FAILED_PRECONDITION: 400, UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404,
    RESOURCE_EXHAUSTED: 429, INTERNAL: 500, UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504 };

  const cleanModel = m => String(m == null ? '' : m).trim().replace(/^models\//, '');
  const cleanBase = b => String(b || BASE).replace(/\/+$/, '');
  const isGemini3 = model => model.toLowerCase().includes('gemini-3');

  // 思考の書き方(§5-3 の表。現行と同じ)。null = 書かない
  function thinking(model, think){
    if (think === 'none') return isGemini3(model) ? { thinkingLevel: levels.quirk(model).noMinimal ? 'low' : 'MINIMAL' } : { thinkingBudget: 0 };
    if (think === 'light') return isGemini3(model) ? { thinkingLevel: 'low' } : { thinkingBudget: config.llm.lightBudget };
    if (think === 'mid') return isGemini3(model) ? { thinkingLevel: 'medium' } : { thinkingBudget: config.llm.midBudget };
    if (think === 'high') return isGemini3(model) ? { thinkingLevel: 'high' } : { thinkingBudget: config.llm.highBudget };
    return null;
  }
  // キーは、keyIn が 'query' のときだけ URL に入れる。それ以外は見出し(req.url には、もう ? が付いている)
  function withKey(req, key, keyIn){
    if (keyIn === 'query') req.url += '&key=' + encodeURIComponent(key);
    else req.headers['x-goog-api-key'] = key;
    return req;
  }

  function request(o){
    o = o || {};
    const model = cleanModel(o.model);
    if (!model) throw bad('モデルの名前が無い');
    if (typeof o.prompt !== 'string' || !o.prompt) throw bad('指示文が無い');
    if (typeof o.key !== 'string' || !o.key) throw bad('API キーが無い');
    if (!levels.thinkModes.includes(o.think)) throw bad('思考の指定がおかしい: ' + o.think);
    const gen = {};
    if (o.json) gen.responseMimeType = 'application/json';
    if (typeof o.temp === 'number') gen.temperature = o.temp;
    if (typeof o.maxOut === 'number') gen.maxOutputTokens = o.maxOut;
    const t = thinking(model, o.think);
    if (t) gen.thinkingConfig = t;
    return withKey({
      url: cleanBase(o.baseUrl) + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: o.prompt }] }], generationConfig: gen })
    }, o.key, o.keyIn);
  }

  // ---- 失敗の見分け(§5-3 の表) ----
  const SEC = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s)\s*$/i;
  const IN_TEXT = /retry in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|s)/i;
  const toMs = m => parseFloat(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
  // 待つ秒数: details の retryDelay("56s")。無ければ、文の中の "Please retry in 56s" から。切り上げる
  function retrySec(details, message){
    let ms = null;
    details.forEach(d => { if (ms === null && typeof d.retryDelay === 'string'){ const m = SEC.exec(d.retryDelay); if (m) ms = toMs(m); } });
    if (ms === null){ const m = IN_TEXT.exec(message); if (m) ms = toMs(m); }
    return ms === null ? null : Math.ceil(ms / 1000);
  }
  function kindOf(status, details, message){
    if (status === 400) return details.some(d => d.reason === 'API_KEY_INVALID') || /API key not valid/i.test(message) ? 'auth' : 'bad';
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'billing';
    if (status === 404) return 'model';
    if (status === 503) return 'overload';
    if (status >= 400 && status < 500) return 'bad';
    return 'server';     // 500 番台と、番号の分からないもの
  }
  // err = 相手が返した { code, message, status, details }(無ければ null)
  function classify(status, err){
    const details = err && Array.isArray(err.details) ? err.details.filter(isPlain) : [];
    const message = err && typeof err.message === 'string' && err.message ? err.message : 'HTTP ' + status;
    const out = { kind: 'limit', status, message };
    if (status === 429){
      // 1日の上限か、1分の上限か(quotaId で見分ける。分からなければ、決めつけない)
      const ids = [];
      details.forEach(d => (Array.isArray(d.violations) ? d.violations : []).forEach(v => { if (isPlain(v) && typeof v.quotaId === 'string' && v.quotaId) ids.push(v.quotaId); }));
      const day = ids.find(id => /PerDay|Daily/i.test(id)), min = ids.find(id => /PerMinute/i.test(id));
      if (day) out.kind = 'limit-day'; else if (min) out.kind = 'limit-min';
      const id = day || min || ids[0];
      if (id) out.quotaId = id;
    } else out.kind = kindOf(status, details, message);
    const sec = retrySec(details, message);
    if (sec !== null) out.retrySec = sec;
    return out;
  }
  // 返ってきた中身から { error } を探す(少しずつ受け取らない形では、配列に包まれて届く)
  function errorIn(j){
    if (Array.isArray(j)) j = j.find(x => isPlain(x) && isPlain(x.error));
    return isPlain(j) && isPlain(j.error) ? j.error : null;
  }
  function error(status, bodyText){
    let err = null;
    try { err = errorIn(JSON.parse(bodyText)); } catch (e){}
    return classify(typeof status === 'number' && isFinite(status) ? status : 0, err);
  }

  // ---- 1件ぶんを読む ----
  const count = v => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  function data(text){
    let j;
    try { j = JSON.parse(text); } catch (e){ return null; }
    const err = errorIn(j);
    if (err){
      const code = typeof err.code === 'number' && isFinite(err.code) ? err.code : (has(CODE, err.status) ? CODE[err.status] : 0);
      return { text: '', error: classify(code, err) };
    }
    if (!isPlain(j)) return null;
    const out = { text: '' };
    let known = false;
    const c = Array.isArray(j.candidates) && isPlain(j.candidates[0]) ? j.candidates[0] : null;
    if (c){
      known = true;
      const parts = isPlain(c.content) && Array.isArray(c.content.parts) ? c.content.parts : [];
      parts.forEach(p => { if (isPlain(p) && typeof p.text === 'string' && p.thought !== true) out.text += p.text; });
      const r = c.finishReason;
      if (typeof r === 'string' && r && r !== 'FINISH_REASON_UNSPECIFIED'){
        out.finish = has(FINISH, r) ? FINISH[r] : 'other';
        if (out.finish === 'blocked') out.block = r;
      }
    }
    const fb = j.promptFeedback;
    if (isPlain(fb) && typeof fb.blockReason === 'string' && fb.blockReason && fb.blockReason !== 'BLOCK_REASON_UNSPECIFIED'){
      known = true;
      out.finish = 'blocked';
      out.block = fb.blockReason;
    }
    const u = j.usageMetadata;
    if (isPlain(u)){
      known = true;
      out.usage = { tin: count(u.promptTokenCount), tout: count(u.candidatesTokenCount), tthink: count(u.thoughtsTokenCount) };
    }
    return known ? out : null;
  }

  // ---- モデルの一覧 ----
  function models(o){
    o = o || {};
    if (typeof o.key !== 'string' || !o.key) throw bad('API キーが無い');
    return withKey({ url: cleanBase(o.baseUrl) + '/models?pageSize=1000', method: 'GET', headers: {} }, o.key, o.keyIn);
  }
  function modelList(json){
    const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
    return (isPlain(json) && Array.isArray(json.models) ? json.models : [])
      .filter(m => isPlain(m) && typeof m.name === 'string' && cleanModel(m.name))
      .map(m => {
        const id = cleanModel(m.name);
        return {
          id,
          name: typeof m.displayName === 'string' && m.displayName ? m.displayName : id,
          canGenerate: Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'),
          thinking: m.thinking === true,
          inMax: num(m.inputTokenLimit),
          outMax: num(m.outputTokenLimit)
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  Yomu.providers = Yomu.providers || {};
  Yomu.providers.gemini = { id: 'gemini', ready: true, request, data, error, models, modelList };
})();

/* ---- core/provider_openai.js ---- */
// core/provider_openai.js — OpenAI 互換の形(部品の約束 §5-3)。**口だけ**(中身は工程E)
//   ready が false の相手には、core/llm.js は送らない。どの口も kind:'bad' の失敗を投げる
(function(){
  'use strict';
  const util = Yomu.util;
  const notYet = () => { throw util.error('bad', 'この相手(OpenAI 互換)は、まだ使えない'); };

  Yomu.providers = Yomu.providers || {};
  Yomu.providers.openai = { id: 'openai', ready: false, request: notYet, data: notYet, error: notYet, models: notYet, modelList: notYet };
})();

/* ---- core/schema.js ---- */
// core/schema.js — 保存の形の版・空の記録・欠けた欄の足し方・合流の決まり(部品の約束 §8-2・§8-3・§8-9)
//   保存にはさわらない(読み書きは core/store.js)。ここは、形と計算だけ
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, levels = Yomu.levels;
  const isPlain = util.isPlain;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const schema = {
    // 保存の形の版(§8-2 の 1)。meta.schema と比べる
    get current(){ return config.schema; },
    // 記録の種類ごとの、形の版(§8-2 の 4)。上げるときは config.schema も上げる
    V: { meta: 1, siteMeta: 1, settings: 1, secrets: 1, pgi: 1, page: 1, quota: 1, runs: 1, vocab: 1, log: 1, logx: 1, ai: 1,
      run: 1, vitem: 1, stretch: 1, detail: 1 },   // 下の4つは、かたまりの中の1件ごとの形
    // 読んだ記録の、操作の種類(§8-8 の Stretch.n)。足すときは、後ろに足す
    acts: ['tap', 'idiom', 'dict', 'ai', 'toJp', 'toEn', 'say', 'star', 'expand']
  };
  // 回数の、空の数字(§8-5)。hitDay(上限に当たった時刻)は、当たったときにだけ付く
  schema.counts = () => ({ sent: 0, ok: 0, lim: 0, net: 0, err: 0, tin: 0, tout: 0, tthink: 0 });

  // ---- 空の記録(§8-3〜§8-8 の形) ----
  schema.make = {
    meta(){
      const now = util.nowISO();
      return { schema: schema.current, createdAt: now, profiles: [{ id: 'me', name: '', createdAt: now }], lastProfile: 'me', deviceId: 'd_' + util.rand(12) };
    },
    siteMeta(){ return { schema: schema.current }; },
    settings(){
      const now = util.nowISO(), d = levels.defaults;
      return {
        v: schema.V.settings, createdAt: now, updatedAt: now,
        profile: { purpose: null, now: null, goal: null, setupDone: false },   // 利用者の属性(設計メモ 2-7)
        level: levels.initial,
        ratio: config.ratio.initial,
        style: 'marker',
        theme: 'auto', enFont: 'sans', enSize: 'm',                            // 見た目(§8-3。theme は 'auto' か、色の組の名前)
        restore: true,
        provider: d.provider,
        modelsV: levels.modelsV,                                                // 翻訳のモデルの初期値の版(levels.modelsV。前の初期値のままの所を移すため=core/settings.js)
        models: util.clone(d.models),
        aux: util.clone(d.aux),
        limits: util.clone(d.limits),
        onLimit: 'ask',
        voice: { name: '', rate: config.voice.rate },
        log: { on: true, detail: 'full' },
        hide: [],                                                              // 右下のボタンを出さないサイト(どのページでも。工程8c-2)= [{ h: ホスト名, at }]
        x: {}
      };
    },
    secrets(){ return { v: schema.V.secrets, providers: { gemini: { apiKey: '' } }, x: {} }; },
    pgi(){ return { v: schema.V.pgi, items: {}, x: {} }; },
    quotaMonth(dev){ return { v: schema.V.quota, dev: dev || null, days: {}, others: {}, x: {} }; },
    runsMonth(){ return { v: schema.V.runs, items: [], x: {} }; },
    vocabChunk(){ return { v: schema.V.vocab, items: {}, x: {} }; },
    logDay(day){ return { v: schema.V.log, day, items: [], x: {} }; },
    logxDay(day){ return { v: schema.V.logx, day, items: {}, x: {} }; },
    // ---- 1件ごとの形(§8-6・§8-7・§8-8) ----
    run(){
      return {
        v: schema.V.run, id: null, dev: null, at: null, qday: null,
        role: null, model: null, think: null, provider: null, promptV: null, wireV: null,
        sent: { targets: 0, chars: 0 }, rep: {}, finish: null, ms: 0, firstMs: null,
        usage: null, err: null, x: {}
      };
    },
    vocabItem(){
      return { v: schema.V.vitem, id: null, head: '', kind: 'word', mean: '', meanSrc: null, forms: [], ex: [], at: null, upd: null, del: null, x: {} };
    },
    stretch(){
      const n = {};
      schema.acts.forEach(k => { n[k] = 0; });
      return {
        v: schema.V.stretch, id: null, dev: null, visit: null, t0: null, t1: null,
        page: null, work: null, site: null, level: null, tr: null, title: { work: '', ep: '' },
        ratio: 0, orig: 0, style: null, vis: 0, act: 0,
        all: { paras: 0, sents: 0, targets: 0, jpChars: 0, enSents: 0, enWords: 0, enJpChars: 0 },
        seen: { paras: 0, sents: 0, jpChars: 0, enSents: 0, enWords: 0, enJpChars: 0 },
        reach: 0, n, x: {}
      };
    },
    detail(){ return { v: schema.V.detail, t1: null, model: null, promptV: null, paras: [], ev: [], x: {} }; }
  };

  // ---- 欠けた欄だけを足す(§8-2 の 3) ----
  //   ある欄・知らない欄には、さわらない。配列の中には入らない。
  //   入れ物(オブジェクト)であるはずの欄に、入れ物でない値が入っていたら、空の記録の値に置きかえる
  schema.fill = function(rec, base){
    if (!isPlain(base)) return rec === undefined ? util.clone(base) : rec;
    if (!isPlain(rec)) return util.clone(base);
    Object.keys(base).forEach(k => {
      if (rec[k] === undefined) rec[k] = util.clone(base[k]);
      else if (isPlain(base[k])) rec[k] = schema.fill(rec[k], base[k]);
    });
    return rec;
  };

  // 形の版が、このエンジンの知っているものより新しいか(§8-2 の 2)
  schema.newer = (kind, rec) => isPlain(rec) && typeof rec.v === 'number' && rec.v > schema.V[kind];

  // 読んだ記録を、使える形にする: 無ければ make()。形の版が新しければ失敗(書き換えない)。そうでなければ、欠けた欄を足す
  schema.open = function(kind, rec, make){
    if (!has(schema.V, kind)) throw util.error('bad', '知らない記録の種類: ' + kind);
    if (!isPlain(rec)) return make();
    if (schema.newer(kind, rec)) throw util.error('newer', '新しい版のデータなので、書き換えない: ' + kind + ' v' + rec.v);
    return schema.fill(rec, make());
  };

  // ---- 移行(§8-2 の 1)。足すだけ。すでにある関数は変えない ----
  //   { [版]: { shared?(kv) → Promise, site?(kv) → Promise } }。kv は Yomu.env の KV(前に何も付かない鍵)
  schema.migrations = {};

  // ---- 書き出しの区画(§8-9)。API キー(secrets)と、訳したページ(pg)は、ここに無い=書き出さない ----
  const MONTH = /^\d{4}-\d{2}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, INITIAL = /^[a-z_]$/;
  schema.parts = {
    settings: { area: 'shared', path: 'settings', kind: 'settings' },
    vocab:    { area: 'shared', prefix: 'vocab/', kind: 'vocab', name: INITIAL, merge: 'newer' },
    quota:    { area: 'shared', prefix: 'quota/', kind: 'quota', name: MONTH,   merge: 'quota' },
    runs:     { area: 'shared', prefix: 'runs/',  kind: 'runs',  name: MONTH,   merge: 'union', sort: 'at' },
    log:      { area: 'shared', prefix: 'log/',   kind: 'log',   name: DAY,     merge: 'union', sort: 't0', prefer: 't1' },
    logx:     { area: 'site',   prefix: 'logx/',  kind: 'logx',  name: DAY,     merge: 'union', prefer: 't1' }
  };

  // ---- 合流の決まり(§8-9・§8-10) ----
  //   どれも (手元のかたまり | undefined, 読み込んだかたまり, opt) → { rec, added, changed }
  //   手元のかたまりに重ねる(手元にある知らない欄は消さない)。読み込んだ方は書き換えない
  const count = items => (Array.isArray(items) ? items.length : isPlain(items) ? Object.keys(items).length : 0);
  const byField = f => (a, b) => { const x = String(a[f] || ''), y = String(b[f] || ''); return x < y ? -1 : x > y ? 1 : 0; };
  // いちばん新しい「変えた時刻」(ISO の文字なので、文字として比べられる)
  const stamp = it => [it.upd, it.del, it.at].reduce((m, t) => (typeof t === 'string' && t > m ? t : m), '');

  schema.merge = {
    // id の和集合(同じ id は手元を残す)。items は、配列([{ id, … }])か、入れ物({ [id]: … })
    //   opt.sort = 並べ直す欄 / opt.prefer = 同じ id のとき、この欄(時刻)の新しい方を採る(読んだ記録の t1。書き足されていく記録のため)
    union(mine, theirs, opt){
      if (!isPlain(mine)) return { rec: util.clone(theirs), added: count(theirs.items), changed: 0 };
      let added = 0, changed = 0;
      const prefer = opt && opt.prefer;
      const fresher = (t, m) => !!prefer && isPlain(t) && typeof t[prefer] === 'string' && t[prefer] > String((isPlain(m) && m[prefer]) || '');
      if (mine.items === undefined) mine.items = Array.isArray(theirs.items) ? [] : {};
      if (Array.isArray(mine.items) && Array.isArray(theirs.items)){
        const at = new Map();
        mine.items.forEach((e, i) => { if (e && e.id != null && !at.has(e.id)) at.set(e.id, i); });
        theirs.items.forEach(e => {
          if (!isPlain(e) || e.id == null) return;
          if (!at.has(e.id)){ at.set(e.id, mine.items.push(util.clone(e)) - 1); added++; }
          else if (fresher(e, mine.items[at.get(e.id)])){ mine.items[at.get(e.id)] = util.clone(e); changed++; }
        });
        if ((added || changed) && opt && opt.sort) mine.items.sort(byField(opt.sort));
      } else if (isPlain(mine.items) && isPlain(theirs.items)){
        Object.keys(theirs.items).forEach(k => {
          if (!util.safeKey(k)) return;
          if (!has(mine.items, k)){ mine.items[k] = util.clone(theirs.items[k]); added++; }
          else if (fresher(theirs.items[k], mine.items[k])){ mine.items[k] = util.clone(theirs.items[k]); changed++; }
        });
      }
      return { rec: mine, added, changed };
    },
    // 単語帳: 無い語は足す。両方にある語は、変えた時刻の新しい方(同じなら手元)
    newer(mine, theirs){
      if (!isPlain(mine)) return { rec: util.clone(theirs), added: count(theirs.items), changed: 0 };
      let added = 0, changed = 0;
      if (!isPlain(mine.items)) mine.items = {};
      Object.keys(isPlain(theirs.items) ? theirs.items : {}).forEach(k => {
        const t = theirs.items[k];
        if (!util.safeKey(k) || !isPlain(t)) return;
        if (!has(mine.items, k)){ mine.items[k] = util.clone(t); added++; }
        else if (stamp(t) > stamp(isPlain(mine.items[k]) ? mine.items[k] : {})){ mine.items[k] = util.clone(t); changed++; }
      });
      return { rec: mine, added, changed };
    },
    // 回数: 端末ごとに分けて持ち、同じ端末・同じ日・同じモデルの数字は大きい方(回数は増えるだけ)
    //   opt.dev = この端末の番号。戻りは、いつも「この端末から見た形」
    quota(mine, theirs, opt){
      const rec = schema.quotaView(mine, opt.dev);
      let added = 0, changed = 0;
      const from = {};   // 端末の番号 → その端末の days
      const take = (dev, days) => { if (isPlain(days) && util.safeKey(dev)) (from[dev] = from[dev] || []).push(days); };
      take(theirs.dev || '_', theirs.days);
      Object.keys(isPlain(theirs.others) ? theirs.others : {}).forEach(dev => take(dev, theirs.others[dev]));
      Object.keys(from).forEach(dev => {
        const into = dev === opt.dev ? rec.days : (rec.others[dev] = isPlain(rec.others[dev]) ? rec.others[dev] : {});
        from[dev].forEach(days => { const r = maxDays(into, days); added += r.added; changed += r.changed; });
      });
      return { rec, added, changed };
    }
  };

  // days(日 → モデル → 数字)を、大きい方で重ねる
  function maxDays(into, days){
    let added = 0, changed = 0;
    Object.keys(days).forEach(day => {
      if (!DAY.test(day) || !isPlain(days[day])) return;
      const d = into[day] = isPlain(into[day]) ? into[day] : {};
      Object.keys(days[day]).forEach(model => {
        const src = days[day][model];
        if (!util.safeKey(model) || !isPlain(src)) return;
        if (!isPlain(d[model])){ d[model] = util.clone(src); added++; return; }
        let touched = false;
        Object.keys(src).forEach(f => {
          if (!util.safeKey(f)) return;
          const a = d[model][f], b = src[f];
          if (typeof b === 'number'){ if (typeof a !== 'number' || b > a){ d[model][f] = b; touched = true; } }
          else if (a == null && b != null){ d[model][f] = util.clone(b); touched = true; }
        });
        if (touched) changed++;
      });
    });
    return { added, changed };
  }

  // 回数のかたまりを「この端末から見た形」に直す: days はこの端末の分だけ、ほかの端末の分は others へ(§8-5)
  schema.quotaView = function(rec, dev){
    const base = schema.make.quotaMonth(dev);
    if (!isPlain(rec)) return base;
    rec = schema.fill(rec, base);
    if (rec.dev !== dev){
      if (rec.dev != null){   // ほかの端末が書いたかたまり → その端末の分として others へ(端末の番号が無いものは、この端末の分とみなす)
        if (util.safeKey(rec.dev) && Object.keys(rec.days).length){
          maxDays(rec.others[rec.dev] = isPlain(rec.others[rec.dev]) ? rec.others[rec.dev] : {}, rec.days);
        }
        rec.days = {};
      }
      rec.dev = dev;
    }
    if (isPlain(rec.others[dev])){ maxDays(rec.days, rec.others[dev]); delete rec.others[dev]; }
    return rec;
  };

  Yomu.schema = schema;
})();

/* ---- core/store.js ---- */
// core/store.js — 保存の口(部品の約束 §8-1・§8-4・§8-9)。CMA学習の core/store.js の考え方を写して直した
//   shared = 全サイト共通の保存(小さく保つ。設定・単語帳・記録) / site = このサイトだけの保存(消えることがある。訳したページ・詳しい記録)
//   入れ物ごとの違いは Yomu.env.shared / Yomu.env.site(KV)が持つ。ここは、その上に次を足す:
//     人の段(p/{pid}/)・同じ所への書き込みの順番・形の版と移行・保存がいっぱいのときの動き・訳したページの件数・書き出しと読み込み
(function(){
  'use strict';
  const Y = Yomu;   // 先頭で受けておく(関数の中から Yomu を読まない。検査で2つの端末を同時に動かしても混ざらないように)
  const util = Y.util, config = Y.config, schema = Y.schema;
  const isPlain = util.isPlain;
  const diag = Y.diag || { mark(){}, begin(){ return 0; }, end(){} };   // 調べるための記録(控えるだけ。動きは変えない。部品だけを読み込む検査では、無い)
  const head = k => String(k == null ? '' : k).split('/')[0];             // 記録に出す鍵は、頭の区切りまで(作品の番号を入れない)
  const FORMAT = 'yomu-export';

  const store = { pid: 'me', deviceId: null };

  // ---- 失敗の種類(§8-1) ----
  //   容量の理由かどうかは、名前・番号・文面で見分ける(文面は「quota」と「exceed」の両方があるときだけ。鍵の名前に quota があっても取り違えない)
  const isFull = e => !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014
    || (/quota/i.test(String(e.message)) && /exceed/i.test(String(e.message))));
  const wrap = e => (e && e.kind ? e : util.error('store', '保存の失敗: ' + (e && e.message || e), { cause: e }));
  const attempt = fn => Promise.resolve().then(fn);

  // ---- 合図 ----
  const subs = {};
  store.on = function(name, fn){
    (subs[name] = subs[name] || new Set()).add(fn);
    return () => subs[name].delete(fn);
  };
  function emit(name, data){ (subs[name] || []).forEach(fn => { try { fn(data); } catch (e){} }); }

  // ---- ページの保存の KV(入れ物が使う。§2-2)。indexedDB・localStorage は、入れ物が渡す ----
  const OS = 'kv', PROBE = '__probe';
  // 離れている間(§8-1。工程5b-2b): IndexedDB の取引を新しく始めない・つながりを閉じておく。
  //   iPhone の Safari は、前のページを「戻る」用に凍らせて取っておくことがある。離れるときに始めた取引は、凍ったページの中で終わらないまま残り、
  //   同じ保存を使う次のページの読み書きが、その後ろで、いつまでも待たされる(なろうで「次へ」のあと、アプリの準備が止まる=利用者の iPhone で起きた)。
  //   hold() から release() までに頼まれた読み書きは、始めずに取っておき、release() のあと、頼まれた順に始める(ページが戻ってこなければ、そのまま消える)。
  //   呼ぶのは、起動の部品(shell/boot.js。pagehide・pageshow)
  let gate = null, heldN = 0;
  const shuts = new Set();        // 開いているつながりを閉じる関数(IndexedDB の KV ごと)
  function hold(){
    if (!gate){
      let open;
      const p = new Promise(r => { open = r; });
      gate = { p, open };
      heldN = 0;
      diag.mark('idb.hold');
    }
    shuts.forEach(fn => { try { fn(); } catch (e){} });
  }
  function release(){
    if (!gate) return;
    const g = gate;
    gate = null;
    diag.mark('idb.release', heldN);
    g.open();
  }
  // 開く → IDBDatabase。待つのは store.openMs まで
  function idbOpen(idb, name){
    return new Promise((res, rej) => {
      if (!idb) return rej(new Error('no indexedDB'));
      let req, settled = false;
      const w = diag.begin('idb open ' + name);
      const timer = setTimeout(() => fail(new Error('indexedDB open timeout')), config.store.openMs);
      const fail = e => { if (!settled){ settled = true; clearTimeout(timer); diag.end(w); diag.mark('idb.fail', e && e.message); rej(e); } };
      try { req = idb.open(name, 1); } catch (e){ return fail(e); }
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(OS)) db.createObjectStore(OS); };
      req.onsuccess = () => {
        if (settled){ try { req.result.close(); } catch (e){} return; }   // 待ちきれずに次の保存先へ進んだあと
        settled = true; clearTimeout(timer); diag.end(w); diag.mark('idb.open');
        res(req.result);
      };
      req.onerror = () => fail(req.error || new Error('indexedDB open failed'));
      req.onblocked = () => fail(new Error('indexedDB blocked'));
    });
  }
  function idbKV(idb, name){
    return idbOpen(idb, name).then(first => {
      let db = null, opening = null;
      // つながりを持つ。切れた(ブラウザが切った)ら、次に使うときに開き直す。ほかのタブが形を変えようとしている、は控えるだけ
      const keep = d => {
        db = d;
        try { d.onclose = () => { diag.mark('idb.closed'); if (db === d) db = null; }; d.onversionchange = () => diag.mark('idb.verchange'); } catch (e){}
        return d;
      };
      const shut = () => { const d = db; db = null; if (d){ diag.mark('idb.shut'); try { d.close(); } catch (e){} } };
      keep(first);
      shuts.add(shut);
      // 閉じてあれば、開き直す。開き直している間に離れたら(hold)、閉じ直す
      const conn = () => (db ? Promise.resolve(db) : opening || (opening = idbOpen(idb, name).then(d => { opening = null; keep(d); if (gate) shut(); return d; }, e => { opening = null; throw e; })));
      const start = (d, mode, fn, op, key, again) => new Promise((res, rej) => {
        let t, out;
        try { t = d.transaction(OS, mode); }
        catch (e){
          diag.mark('idb.txfail', e && e.message);
          // つながりが、知らない間に切れていた・開き直している間に閉じた: 1回だけ、開き直してやり直す
          if (!again){ if (db === d) db = null; return res(tx(mode, fn, op, key, true)); }
          return rej(e);
        }
        const w = diag.begin('idb ' + op + ' ' + head(key));     // 返事を待っている読み書き(終わらないものが、記録に残る)
        const no = e => { diag.end(w); rej(e); };
        let req;
        try { req = fn(t.objectStore(OS)); } catch (e){ return no(e); }
        req.onsuccess = () => { out = req.result; };
        req.onerror = () => no(req.error || new Error('idb request failed'));
        t.oncomplete = () => { diag.end(w); res(out); };
        t.onerror = () => no(t.error || new Error('idb tx failed'));
        t.onabort = () => no(t.error || new Error('idb tx aborted'));
      });
      function tx(mode, fn, op, key, again){
        if (gate){                                               // 離れている間: 始めずに、取っておく(戻ったあとで、もう一度ここから)
          heldN++;
          if (diag.poke) diag.poke();
          return gate.p.then(() => tx(mode, fn, op, key, again));
        }
        return db ? start(db, mode, fn, op, key, again) : conn().then(() => tx(mode, fn, op, key, again));
      }
      const kv = {
        backend: 'idb',
        get: k => tx('readonly', st => st.get(k), 'get', k),
        set: (k, v) => tx('readwrite', st => st.put(v, k), 'set', k).then(() => undefined),
        del: k => tx('readwrite', st => st.delete(k), 'del', k).then(() => undefined),
        keys: prefix => tx('readonly', st => st.getAllKeys(), 'keys', prefix).then(ks => (ks || []).map(String).filter(k => !prefix || k.startsWith(prefix)).sort())
      };
      // 書いて・消せるかを確かめる(開けても書けない場合がある)
      return kv.set(PROBE, 1).then(() => kv.del(PROBE)).then(() => kv);
    });
  }
  function lsKV(ls, name){
    return attempt(() => {
      if (!ls) throw new Error('no localStorage');
      const pre = name + ':';
      ls.setItem(pre + PROBE, '1'); ls.removeItem(pre + PROBE);
      return {
        backend: 'ls',
        get: k => attempt(() => { const s = ls.getItem(pre + k); if (s == null) return undefined; try { return JSON.parse(s); } catch (e){ return undefined; } }),
        set: (k, v) => attempt(() => { ls.setItem(pre + k, JSON.stringify(v)); }),
        del: k => attempt(() => { ls.removeItem(pre + k); }),
        keys: prefix => attempt(() => {
          const out = [];
          for (let i = 0; i < ls.length; i++){
            const k = ls.key(i);
            if (k && k.startsWith(pre) && k !== pre + PROBE && (!prefix || k.startsWith(pre + prefix))) out.push(k.slice(pre.length));
          }
          return out.sort();
        })
      };
    });
  }
  function memKV(){
    const m = new Map();
    return {
      backend: 'mem',
      get: k => attempt(() => util.clone(m.get(k))),
      set: (k, v) => attempt(() => { m.set(k, util.clone(v)); }),
      del: k => attempt(() => { m.delete(k); }),
      keys: prefix => attempt(() => Array.from(m.keys()).filter(k => !prefix || k.startsWith(prefix)).sort())
    };
  }
  store.kv = {
    idb: idbKV, ls: lsKV, mem: memKV,
    hold, release,
    state: () => ({ held: !!gate, n: heldN }),   // 離れている間か・その間に取っておいた読み書きの数(調べるための記録)
    // IndexedDB → localStorage → メモリの順に、使えた最初のもの
    pick(opt){
      opt = opt || {};
      const name = opt.name || 'yomu-site';
      const tries = [() => idbKV(opt.indexedDB, name), () => lsKV(opt.localStorage, name), () => Promise.resolve(memKV())];
      return tries.reduce((p, t) => p.then(kv => kv || t().catch(() => null)), Promise.resolve(null))
        .then(kv => { diag.mark('kv', name + '=' + (kv && kv.backend)); return kv; });
    }
  };

  // ---- 保存がいっぱいのとき(§8-1): 作り直せるもの(site)を古い順に捨てて、やり直す ----
  const siteKV = () => Y.env.site;
  const PG = 'pg/', PGI = 'pgi', LOGX = 'logx/';
  const openIndex = v => schema.open('pgi', v, schema.make.pgi);
  const sizeOf = v => (v === undefined ? 0 : JSON.stringify(v).length);

  // 索引を実物に合わせる(Safari が保存を消した・別のタブが書いた、のあとでも合うように)→ 直したか
  async function reconcile(idx){
    const kv = siteKV();
    const have = new Set((await kv.keys(PG)).map(k => k.slice(PG.length)));
    let dirty = false;
    Object.keys(idx.items).forEach(id => { if (!have.has(id)){ delete idx.items[id]; dirty = true; } });
    for (const id of have){
      if (isPlain(idx.items[id])) continue;
      const rec = await kv.get(PG + id);
      idx.items[id] = { u: (rec && (rec.used || rec.upd || rec.at)) || '', k: rec && rec.keep ? 1 : 0, b: sizeOf(rec) };
      dirty = true;
    }
    return dirty;
  }
  // いま書いている最中のページ(捨てない)
  const busy = new Set();
  const spared = (key, exceptKey) => key === exceptKey || busy.has(key);
  // 捨ててよいページ(keep の印が無く、いま書いている最中でもない)を、開いたのが古い順に
  const oldestFirst = (items, exceptKey) => Object.keys(items).filter(id => !items[id].k && !spared(PG + id, exceptKey))
    .sort((a, b) => (items[a].u < items[b].u ? -1 : items[a].u > items[b].u ? 1 : a < b ? -1 : a > b ? 1 : 0));
  // 古い順に n 件捨てる → { n: 捨てた件数, bytes: 空いた大きさの目安 }
  async function dropOldest(items, n, exceptKey){
    const ids = oldestFirst(items, exceptKey).slice(0, Math.max(0, n));
    let bytes = 0;
    for (const id of ids){ await siteKV().del(PG + id); bytes += items[id].b || 0; delete items[id]; }
    return { n: ids.length, bytes };
  }
  // 訳したページを、ひとかたまり捨てる。順番待ち(下の queue)の外で動く。索引が書けなくても、次に合わせ直すので害は無い
  async function evictPages(exceptKey){
    const kv = siteKV();
    const idx = openIndex(await kv.get(PGI));
    await reconcile(idx);
    const can = oldestFirst(idx.items, exceptKey).length;
    if (!can) return { n: 0, bytes: 0 };
    const r = await dropOldest(idx.items, Math.max(config.pages.evictMin, Math.ceil(can * config.pages.evictShare)), exceptKey);
    try { await kv.set(PGI, idx); } catch (e){}
    return r;
  }
  // 読んだ記録の詳しい分を、古い日から半分捨てる
  async function evictLogx(exceptKey){
    const kv = siteKV();
    const keys = (await kv.keys(LOGX)).filter(k => !spared(k, exceptKey)).sort();
    const drop = keys.slice(0, Math.ceil(keys.length / 2));
    let bytes = 0;
    for (const k of drop){ bytes += sizeOf(await kv.get(k)); await kv.del(k); }
    return { n: drop.length, bytes };
  }
  // 1つ書く。容量で失敗したら、古いものを捨ててやり直す。key は、前に付くものを付けたあとの鍵
  //   捨てるのは、書こうとしているものの大きさの store.evictFactor 倍ぶんまで
  //   (それだけ空けても書けないなら、ほかに理由がある。入るはずのないものを書こうとして、訳したページを全部捨てないため)
  //   opt.evict === false: 何も捨てない・合図も出さない(どうするかは、呼んだ側が決める。読んだ記録の詳しい分・辞書の写し)
  async function write(area, key, value, opt){
    const kv = Y.env[area];
    const tryOnce = async () => {
      try { await kv.set(key, value); return true; }
      catch (e){ if (!isFull(e)) throw wrap(e); return false; }
    };
    if (await tryOnce()) return;
    if (opt && opt.evict === false) throw util.error('full', '保存がいっぱいで書けない(何も捨てない書き方): ' + key);
    const except = area === 'site' ? key : null;
    const budget = sizeOf(value) * config.store.evictFactor;
    const freed = { pages: 0, logx: 0, bytes: 0 };
    const tell = () => { if (freed.pages || freed.logx) emit('evict', freed); };
    // site を捨てて空くのは、ページの保存だけ。shared が Tampermonkey や拡張機能の保存のときは、捨てても空かないので、捨てない
    const helps = area === 'site' || kv.backend === 'idb' || kv.backend === 'ls';
    for (const [name, evict] of (helps ? [['pages', evictPages], ['logx', evictLogx]] : [])){
      while (freed.bytes < budget){
        const r = await evict(except).catch(() => null);
        if (!r || !r.n) break;
        freed[name] += r.n;
        freed.bytes += r.bytes || r.n;
        let ok;
        try { ok = await tryOnce(); } catch (e){ tell(); throw e; }
        if (ok){ tell(); return; }
      }
    }
    tell();
    emit('full', { area, path: key });
    throw util.error('full', '保存がいっぱいで、古いものを捨てても書けない: ' + key);
  }

  // ---- shared / site の口 ----
  function makeArea(area){
    const kv = () => Y.env[area];
    // shared の path には p/{pid}/ が前に付く(meta だけは付かない)。site には付かない
    const pre = () => (area === 'shared' ? 'p/' + store.pid + '/' : '');
    const raw = path => (area === 'shared' && path !== 'meta' ? pre() + path : String(path));
    // 同じ所への書き込み(update・set・del)は、呼んだ順に1つずつ
    const tails = new Map();
    function queue(key, job){
      const run = (tails.get(key) || Promise.resolve()).then(job);
      const tail = run.then(() => {}, () => {});   // 失敗しても、次の順番は進む
      tails.set(key, tail);
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return run;
    }
    return {
      get backend(){ return kv().backend; },
      get(path){ return attempt(() => kv().get(raw(path))).catch(e => { throw wrap(e); }); },
      set(path, value, opt){
        if (value === undefined) return Promise.reject(util.error('bad', 'undefined は保存できない(消すなら del): ' + path));
        const key = raw(path);
        return queue(key, () => write(area, key, value, opt));
      },
      del(path){
        const key = raw(path);
        return queue(key, () => attempt(() => kv().del(key)).catch(e => { throw wrap(e); }));
      },
      keys(prefix){
        const p = pre();
        return attempt(() => kv().keys(p + (prefix || ''))).then(ks => ks.map(k => k.slice(p.length)), e => { throw wrap(e); });
      },
      // 読む → fn(今の値) → 書く。fn が undefined を返したら書かない
      update(path, fn, opt){
        const key = raw(path);
        return queue(key, async () => {
          let cur;
          try { cur = await kv().get(key); } catch (e){ throw wrap(e); }
          const next = await fn(cur);
          if (next === undefined) return cur;
          await write(area, key, next, opt);
          return next;
        });
      }
    };
  }
  store.shared = makeArea('shared');
  store.site = makeArea('site');

  // ---- 起動(§8-1・§8-2 の 1・2) ----
  let opening = null;
  store.init = function(){
    if (!opening) opening = start();
    return opening;
  };
  async function start(){
    const cur = schema.current;
    const areas = [['shared', schema.make.meta], ['site', schema.make.siteMeta]];
    // 先に両方を読んで確かめる(新しい版のデータがあれば、何も書かずに止まる)
    const metas = [];
    for (const [area] of areas){
      let m;
      diag.mark('meta.' + area);
      try { m = await Y.env[area].get('meta'); } catch (e){ throw wrap(e); }
      if (isPlain(m) && typeof m.schema === 'number' && m.schema > cur){
        throw util.error('newer', '新しい版のエンジンが作ったデータなので、書き換えない(' + area + ' の版 ' + m.schema + ' > ' + cur + ')', { area, found: m.schema, current: cur });
      }
      metas.push(m);
    }
    for (let i = 0; i < areas.length; i++){
      const [area, make] = areas[i];
      const kv = Y.env[area];
      let meta = metas[i];
      const before = JSON.stringify(meta);
      if (!isPlain(meta)) meta = make();                          // 初めて: 今の版で作る(移すものは無い)
      else {
        meta = schema.fill(meta, Object.assign(make(), { schema: 0 }));   // 欠けた欄を足す(知らない欄は消さない)
        if (typeof meta.schema !== 'number') meta.schema = 0;
        while (meta.schema < cur){                                // 版の順に1つずつ。1つ済むごとに版を進める
          const step = schema.migrations[meta.schema + 1];
          if (step && typeof step[area] === 'function'){
            try { await step[area](kv); } catch (e){ throw util.error('store', '保存の形を移せなかった(' + area + ' の版 ' + (meta.schema + 1) + '): ' + (e && e.message || e), { cause: e }); }
          }
          meta.schema++;
          await write(area, 'meta', meta);
        }
      }
      if (JSON.stringify(meta) !== before) await write(area, 'meta', meta);
      if (area === 'shared'){
        const ids = (Array.isArray(meta.profiles) ? meta.profiles : []).map(p => p && p.id);
        store.pid = ids.includes(meta.lastProfile) ? meta.lastProfile : 'me';
        store.deviceId = meta.deviceId;
      }
    }
    diag.mark('meta.ok');
  }
  store.meta = () => store.init().then(() => Y.env.shared.get('meta'));

  // ---- 訳したページ(§8-4)。件数の上限と、捨てる順を、ここで守る ----
  const pageId = (page, level) => {
    if (typeof page !== 'string' || !page || typeof level !== 'string' || !level || level.includes('/')) throw util.error('bad', 'ページの鍵がおかしい: ' + page + ' / ' + level);
    return page + '/' + level;
  };
  const splitId = id => { const i = id.lastIndexOf('/'); return { page: id.slice(0, i), level: id.slice(i + 1) }; };
  const pageLimit = () => (store.site.backend === 'idb' ? config.pages.keep.idb : config.pages.keep.ls);
  // 索引を読んで直す。fn(items, idx) が true を返したら書く
  const withIndex = (fn, opt) => store.site.update(PGI, async cur => {
    const idx = openIndex(cur);
    let dirty = opt && opt.reconcile ? await reconcile(idx) : false;
    if (await fn(idx.items, idx)) dirty = true;
    return dirty ? idx : undefined;
  });

  store.pages = {
    get(page, level){
      return attempt(() => store.site.get(PG + pageId(page, level))).then(rec => {
        if (schema.newer('page', rec)) throw util.error('newer', '新しい版のデータなので、使わない: ' + page);
        return rec;
      });
    },
    async put(rec){
      if (!isPlain(rec)) throw util.error('bad', 'ページの記録がおかしい');
      const id = pageId(rec.page, rec.level);
      const now = util.nowISO();
      const out = Object.assign({}, rec, { upd: now, used: now });
      if (out.v === undefined) out.v = schema.V.page;
      if (!out.at) out.at = now;
      if (!isPlain(out.x)) out.x = {};
      const entry = { u: now, k: out.keep ? 1 : 0, b: sizeOf(out) };
      busy.add(PG + id);                                          // 索引を書く間に保存がいっぱいになっても、このページは捨てない
      try {
        await store.site.set(PG + id, out);
        await withIndex(async (items, idx) => {
          items[id] = entry;
          // 件数は実物で数える(索引が消えていても、上限を守る)。索引と合わなければ、先に合わせ直す
          if ((await siteKV().keys(PG)).length !== Object.keys(items).length){ await reconcile(idx); items[id] = entry; }
          const over = Object.keys(items).length - pageLimit();
          if (over > 0) await dropOldest(items, over, PG + id);
          return true;
        });
      } finally { busy.delete(PG + id); }
      return out;
    },
    touch(page, level){
      return attempt(() => pageId(page, level)).then(id => withIndex(items => {
        if (!isPlain(items[id])) return false;
        items[id].u = util.nowISO();
        return true;
      })).then(() => undefined);
    },
    async del(page, level){
      if (typeof page !== 'string' || !page) throw util.error('bad', 'ページの鍵がおかしい: ' + page);
      const keys = (await store.site.keys(PG + page + '/')).filter(k => {
        const lv = k.slice(PG.length + page.length + 1);
        return !lv.includes('/') && (level === undefined || lv === level);
      });
      for (const k of keys) await store.site.del(k);
      if (keys.length) await withIndex(items => { keys.forEach(k => { delete items[k.slice(PG.length)]; }); return true; });
      return keys.length;
    },
    async saved(page){
      const out = {};
      (await store.site.keys(PG + page + '/')).forEach(k => { const lv = k.slice(PG.length + page.length + 1); if (!lv.includes('/')) out[lv] = true; });
      return out;
    },
    async list(){
      let out = [];
      await withIndex(items => {
        out = Object.keys(items).map(id => Object.assign(splitId(id), { used: items[id].u, keep: items[id].k ? 1 : 0, bytes: items[id].b || 0 }));
        return false;
      }, { reconcile: true });
      const id = p => p.page + '/' + p.level;   // 時刻が同じときは、鍵の順(いつも同じ並びにする)
      return out.sort((a, b) => (a.used < b.used ? 1 : a.used > b.used ? -1 : id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
    },
    count(){ return store.site.keys(PG).then(ks => ks.length); },
    async clear(){
      const keys = await store.site.keys(PG);
      for (const k of keys) await store.site.del(k);
      await withIndex(items => { Object.keys(items).forEach(id => { delete items[id]; }); return true; });
      return keys.length;
    }
  };

  // ---- 書き出しと読み込み(§8-9)。API キーと、訳したページは入らない(schema.parts に無い) ----
  store.export = async function(opt){
    await store.init();
    const names = (opt && opt.parts) || Object.keys(schema.parts);
    const out = { format: FORMAT, schema: schema.current, exportedAt: util.nowISO(), app: { version: config.version }, dev: store.deviceId, parts: {} };
    for (const name of names){
      const p = Object.prototype.hasOwnProperty.call(schema.parts, name) ? schema.parts[name] : null;
      if (!p) throw util.error('bad', '知らない区画: ' + name);
      const area = store[p.area];
      if (p.path){
        const v = await area.get(p.path);
        if (v !== undefined) out.parts[name] = v;
        continue;
      }
      const box = {};
      for (const k of await area.keys(p.prefix)){
        const v = await area.get(k);
        if (v !== undefined) box[k.slice(p.prefix.length)] = v;
      }
      if (Object.keys(box).length) out.parts[name] = box;
    }
    return out;
  };

  store.import = async function(obj, opt){
    await store.init();
    const mode = (opt && opt.mode) || 'merge';
    if (mode !== 'merge' && mode !== 'replace') throw util.error('bad', '読み込み方がおかしい: ' + mode);
    if (typeof obj === 'string'){ try { obj = JSON.parse(obj); } catch (e){ throw util.error('format', '読み込めないファイルです(形式が違います)'); } }
    if (!isPlain(obj) || obj.format !== FORMAT || !isPlain(obj.parts) || typeof obj.schema !== 'number') throw util.error('format', '読み込めないファイルです(形式が違います)');
    const tooNew = () => util.error('newer', '新しい版で書き出したファイルなので、読み込めません。先にエンジンを新しくしてください');
    if (obj.schema > schema.current) throw tooNew();

    // 先に全部を確かめる(断るときは、何も書かない)
    const plan = [], skipped = [];
    Object.keys(obj.parts).forEach(name => {
      const p = Object.prototype.hasOwnProperty.call(schema.parts, name) ? schema.parts[name] : null;
      const val = obj.parts[name];
      if (!p || !isPlain(val)){ skipped.push(name); return; }
      if (p.path){
        if (schema.newer(p.kind, val)) throw tooNew();
        plan.push({ name, p, single: val });
        return;
      }
      const chunks = {};
      Object.keys(val).forEach(k => {
        if (!p.name.test(k) || !isPlain(val[k])){ skipped.push(name + '/' + k); return; }
        if (schema.newer(p.kind, val[k])) throw tooNew();
        chunks[k] = val[k];
      });
      plan.push({ name, p, chunks });
    });

    const result = { mode, parts: {}, skipped };
    try {
      for (const job of plan){
        const p = job.p, area = store[p.area];
        const r = result.parts[job.name] = { keys: 0, added: 0, changed: 0 };
        if (job.single){
          await area.set(p.path, util.clone(job.single));
          r.keys = 1; r.changed = 1;
          continue;
        }
        if (mode === 'replace'){
          for (const k of await area.keys(p.prefix)) if (!Object.prototype.hasOwnProperty.call(job.chunks, k.slice(p.prefix.length))) await area.del(k);
        }
        for (const k of Object.keys(job.chunks)){
          await area.update(p.prefix + k, cur => {
            if (schema.newer(p.kind, cur)) throw tooNew();
            const res = schema.merge[p.merge](mode === 'replace' ? undefined : cur, job.chunks[k], { dev: store.deviceId, sort: p.sort, prefer: p.prefer });
            r.keys++; r.added += res.added; r.changed += res.changed;
            return res.rec;
          });
        }
      }
    } finally {
      if (Object.keys(result.parts).length) emit('import', { mode, parts: Object.keys(result.parts) });
    }
    return result;
  };

  // ---- 使っている量(設定の画面。§9-6)。bytes は JSON にしたときの文字数(目安) ----
  store.usage = async function(){
    const shared = Y.env.shared, site = siteKV();
    const out = { shared: { keys: 0, bytes: 0 }, site: { keys: 0, bytes: 0, pages: 0 } };
    for (const k of await shared.keys('')){ out.shared.keys++; out.shared.bytes += sizeOf(await shared.get(k)); }
    let idx = null;
    try { idx = openIndex(await site.get(PGI)); } catch (e){}
    for (const k of await site.keys('')){
      out.site.keys++;
      if (k.startsWith(PG)){
        out.site.pages++;
        const e = idx && idx.items[k.slice(PG.length)];
        out.site.bytes += (isPlain(e) && e.b) || sizeOf(await site.get(k));   // 索引に大きさがあれば、1ページ分を読まない
      } else out.site.bytes += sizeOf(await site.get(k));
    }
    return out;
  };

  Y.store = store;
})();

/* ---- core/settings.js ---- */
// core/settings.js — 設定と API キー(部品の約束 §8-3)
//   設定は shared の p/{pid}/settings、API キーは別の区画 p/{pid}/secrets(書き出しにも、合図にも入れない)
(function(){
  'use strict';
  const util = Yomu.util, schema = Yomu.schema, store = Yomu.store, levels = Yomu.levels, config = Yomu.config, theme = Yomu.theme;
  const isPlain = util.isPlain;
  const PATH = 'settings', SECRETS = 'secrets';

  const STYLES = ['marker', 'quiet'];
  const ON_LIMIT = ['ask', 'lite'];
  const DETAILS = ['full', 'lite'];
  const PURPOSES = [null, 'eiken', 'toeic', 'toefl', 'none'];
  const GOAL_KINDS = ['eiken', 'toeic', 'toefl', 'cefr'];
  const FIXED = ['v', 'createdAt', 'updatedAt'];   // set では変えられない欄

  const text = v => typeof v === 'string' && v.length > 0;
  const bool = v => typeof v === 'boolean';
  const num = v => typeof v === 'number' && isFinite(v);
  const goal = v => v === null || (isPlain(v) && GOAL_KINDS.includes(v.kind));

  // 知っている欄の値を確かめる。strict = おかしければ断る(set)/そうでなければ、その欄だけ初期値に戻す(読んだとき)
  function check(s, strict){
    const base = schema.make.settings();
    const want = (path, ok) => {
      if (ok) return;
      if (strict) throw util.error('bad', '設定の値がおかしい: ' + path);
      util.setIn(s, path, util.clone(util.getIn(base, path)));
    };
    ['profile', 'models', 'aux', 'limits', 'voice', 'log', 'x'].forEach(k => want(k, isPlain(s[k])));
    levels.ids.forEach(id => want('models/' + id, isPlain(s.models[id])));
    want('level', levels.has(s.level));
    want('modelsV', num(s.modelsV));
    want('ratio', num(s.ratio));
    s.ratio = Math.min(100, Math.max(0, Math.round(s.ratio / config.ratio.step) * config.ratio.step));
    want('style', STYLES.includes(s.style));
    want('theme', theme.choice(s.theme));
    want('enFont', theme.fonts().includes(s.enFont));
    want('enSize', theme.sizes().includes(s.enSize));
    want('restore', bool(s.restore));
    want('provider', text(s.provider));
    want('onLimit', ON_LIMIT.includes(s.onLimit));
    want('profile/purpose', PURPOSES.includes(s.profile.purpose));
    want('profile/now', goal(s.profile.now));
    want('profile/goal', goal(s.profile.goal));
    want('profile/setupDone', bool(s.profile.setupDone));
    want('voice/name', typeof s.voice.name === 'string');
    want('voice/rate', num(s.voice.rate) && s.voice.rate > 0);
    want('log/on', bool(s.log.on));
    want('log/detail', DETAILS.includes(s.log.detail));
    levels.ids.forEach(id => {
      want('models/' + id + '/m', text(s.models[id].m));
      want('models/' + id + '/think', levels.thinkModes.includes(s.models[id].think));
    });
    // 右下のボタンを出さないサイト(工程8c-2): [{ h: ホスト名(小文字), at }]。同じホストは 1 つ・config.page.web.hideMax まで(新しい方を残す)
    want('hide', Array.isArray(s.hide));
    const okHide = s.hide.filter(e => isPlain(e) && text(e.h));
    if (strict && okHide.length !== s.hide.length) throw util.error('bad', '設定の値がおかしい: hide');
    const seen = new Set();
    s.hide = okHide.map(e => ({ h: e.h.toLowerCase(), at: text(e.at) ? e.at : '' }))
      .filter(e => (seen.has(e.h) ? false : (seen.add(e.h), true)))
      .slice(-config.page.web.hideMax);
    Object.keys(base.aux).forEach(k => want('aux/' + k, text(s.aux[k])));
    Object.keys(s.limits).forEach(model => {   // 1日の目安(利用者が直す数)。数でないものは置かない
      if (num(s.limits[model]) && s.limits[model] >= 0) return;
      if (strict) throw util.error('bad', '設定の値がおかしい: limits/' + model);
      delete s.limits[model];
    });
    return s;
  }
  // 保存から読んだものを、使える形にする(欠けた欄を足す。おかしい値は、その欄だけ初期値。形の版が新しければ失敗)
  const open = stored => check(schema.open('settings', renamed(stored), schema.make.settings), false);
  // Google が、ほかの名前へ回している AI の名前を、新しい名前に読みかえる(levels.moved。読むときだけ。次に設定を変えたとき、保存にも入る)。
  //   1日の目安は、新しい名前の欄が無いときだけ、古い名前の数を移す。欠けた欄を足す(schema.open)より前に、保存の写しの上で行う(初期値の目安が、先に入らないように)
  function renamed(stored){
    if (!isPlain(stored)) return stored;
    const s = util.clone(stored);
    const fix = (o, k) => { if (isPlain(o) && typeof o[k] === 'string') o[k] = levels.current(o[k]); };
    if (isPlain(s.models)) Object.keys(s.models).forEach(id => fix(s.models[id], 'm'));
    if (isPlain(s.aux)) Object.keys(s.aux).forEach(k => fix(s.aux, k));
    if (isPlain(s.limits)) Object.keys(levels.moved).forEach(old => {
      if (!Object.prototype.hasOwnProperty.call(s.limits, old)) return;
      const to = levels.moved[old];
      if (!Object.prototype.hasOwnProperty.call(s.limits, to)) s.limits[to] = s.limits[old];
      delete s.limits[old];
    });
    return moveDefaults(s);
  }
  // 翻訳のモデルの初期値を変えたとき(levels.modelsV・levels.prior。工程T-2c)、前の初期値のままのレベルだけを、新しい初期値に移す。
  //   自分で選び直したレベルは、触らない。modelsV の無い設定は、版 1(版 0.1.21 まで)。移したら modelsV を今の版にする
  //   (読むときに行う。次に設定を変えたとき、保存にも入る。それまでは、読むたびに同じように移す=何度行っても同じ結果)
  function moveDefaults(s){
    const from = typeof s.modelsV === 'number' && isFinite(s.modelsV) ? s.modelsV : 1;
    if (from >= levels.modelsV) return s;
    for (let v = from; v < levels.modelsV; v++){
      const old = levels.prior[v] || {};
      Object.keys(old).forEach(id => {
        const m = isPlain(s.models) ? s.models[id] : null;
        if (isPlain(m) && m.m === old[id].m && m.think === old[id].think) s.models[id] = Object.assign({}, m, util.clone(levels.defaults.models[id]));
      });
    }
    s.modelsV = levels.modelsV;
    return s;
  }

  // 深く重ねる(値が undefined の欄は消す。配列は置きかえる)
  function overlay(dst, patch, top){
    Object.keys(patch).forEach(k => {
      if (!util.safeKey(k) || (top && FIXED.includes(k))) return;
      const v = patch[k];
      if (v === undefined) delete dst[k];
      else if (isPlain(v) && isPlain(dst[k])) overlay(dst[k], v, false);
      else dst[k] = util.clone(v);
    });
    return dst;
  }
  // 「変わったか」を比べるための形(変えた時刻は数えない)
  const view = s => { const c = util.clone(s); delete c.updatedAt; return JSON.stringify(c); };

  let cur = null;               // 手元の写し(load・set のあと)
  const subs = new Set();
  function swap(next){
    const prev = cur;
    cur = next;
    if (prev && view(prev) !== view(next)) subs.forEach(fn => { try { fn(util.clone(next), util.clone(prev)); } catch (e){} });
  }

  const settings = {
    // 保存から読む(無ければ、初期値を作って書く)。何度呼んでもよい(別のタブで変えた分を取り直す)
    async load(){
      await store.init();
      let stored = await store.shared.get(PATH);
      if (stored === undefined) stored = await store.shared.update(PATH, now => (now === undefined ? schema.make.settings() : undefined));
      swap(open(stored));
      return settings.get();
    },
    get(){ return util.clone(cur || schema.make.settings()); },
    // 深く重ねて保存する。保存にある今の値に重ねる(手元の写しが古くても、別のタブで変えた欄を消さない)
    set(patch){
      if (!isPlain(patch)) return Promise.reject(util.error('bad', '設定の変え方がおかしい'));
      let next = null;
      return store.shared.update(PATH, stored => {
        const s = open(stored);
        const before = view(s);
        check(overlay(s, patch, true), true);
        next = s;
        if (stored !== undefined && view(s) === before) return undefined;   // 変わらないなら書かない
        if (stored !== undefined) s.updatedAt = util.nowISO();
        return s;
      }).then(() => { swap(next); return settings.get(); });
    },
    // そのレベルの、翻訳のモデルと思考。考える深さを選ぶ所を出していない間(config.ui.thinkPick が false)は、いつも思考なし
    //   (保存にある思考の選び方は、消さずに残す。工程T-2c: 「軽く考える」は、訳では効き目が見えなかった=設計メモ 2-3)
    modelFor(level){
      const s = cur || schema.make.settings();
      const m = (isPlain(s.models[level]) && s.models[level]) || levels.defaults.models[level] || levels.defaults.models[levels.initial];
      return { m: m.m, think: config.ui.thinkPick ? m.think : 'none' };
    },
    on(fn){ subs.add(fn); return () => subs.delete(fn); },
    // 右下のボタンを出さないサイト(工程8c-2。設計メモ 2-6)。host はホスト名(www. も、そのまま)
    hidden(host){ const h = String(host || '').toLowerCase(); return !!h && settings.get().hide.some(e => e.h === h); },
    hide(host){
      const h = String(host || '').toLowerCase();
      if (!h) return Promise.reject(util.error('bad', 'サイトの名前が無い'));
      const list = settings.get().hide.filter(e => e.h !== h);
      list.push({ h, at: util.nowISO() });
      return settings.set({ hide: list });
    },
    unhide(host){
      const h = String(host || '').toLowerCase();
      return settings.set({ hide: settings.get().hide.filter(e => e.h !== h) });
    }
  };

  // ---- API キー(§8-2 の 10)。手元に持ち続けない(使うたびに読む) ----
  const openSecrets = stored => schema.open('secrets', stored, schema.make.secrets);
  const keyOf = (s, provider) => {
    const p = s.providers[provider || (cur && cur.provider) || levels.defaults.provider];
    return isPlain(p) && typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
  };
  settings.secrets = {
    get(){ return store.shared.get(SECRETS).then(openSecrets); },
    key(provider){ return settings.secrets.get().then(s => keyOf(s, provider)); },
    has(provider){ return settings.secrets.key(provider).then(k => k.length > 0); },
    set(patch){
      if (!isPlain(patch)) return Promise.reject(util.error('bad', 'API キーの入れ方がおかしい'));
      return store.shared.update(SECRETS, stored => {
        const s = overlay(openSecrets(stored), patch, true);
        if (!isPlain(s.providers)) s.providers = {};
        Object.keys(s.providers).forEach(id => { const p = s.providers[id]; if (isPlain(p) && typeof p.apiKey === 'string') p.apiKey = p.apiKey.trim(); });
        return s;
      }).then(() => undefined);
    }
  };

  // 読み込み(§8-9)で設定が変わったら、読み直して合図を出す
  store.on('import', e => { if (e.parts.includes(PATH)) settings.load().catch(() => {}); });

  Yomu.settings = settings;
})();

/* ---- core/quota.js ---- */
// core/quota.js — 回数の記録(部品の約束 §8-5)。モデルごとの「今日つかった回数」を、端末で数える
//   shared の p/{pid}/quota/{YYYY-MM}(月 = 回数の日の月)。「回数の日」は太平洋時間の日付(1日の上限が戻る境。日本では夕方)
//   days = この端末の分 / others = ほかの端末の分(読み込みで入る)。部品が書くのは days だけ
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, schema = Yomu.schema, store = Yomu.store, settings = Yomu.settings;
  const isPlain = util.isPlain;
  const KINDS = ['sent', 'ok', 'lim', 'net', 'err'];
  const USAGE = ['tin', 'tout', 'tthink'];
  const DAY = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-\d{2}$/;
  const PRE = 'quota/';
  const HOUR = 3600000;

  const bad = msg => util.error('bad', msg);
  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const attempt = fn => Promise.resolve().then(fn);

  // ---- 回数の日 ----
  // now(Date・ミリ秒・ISO の文字。省くと今)→ ミリ秒
  function toMs(now){
    const ms = now == null ? Date.parse(util.nowISO()) : now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
    if (!isFinite(ms)) throw bad('時刻がおかしい: ' + now);
    return ms;
  }
  // ブラウザの時刻の道具で出す(夏時間は、道具が知っている)。使えなければ null
  let fmt = null, fmtTz = null;
  function dayByIntl(ms){
    try {
      if (fmtTz !== config.quota.tz){
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: config.quota.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        fmtTz = config.quota.tz;
      }
      const got = {};
      fmt.formatToParts(new Date(ms)).forEach(p => { got[p.type] = p.value; });
      const s = got.year + '-' + got.month + '-' + got.day;
      return DAY.test(s) ? s : null;
    } catch (e){ return null; }
  }
  // 予備: 米国の夏時間の決まりで出す(3月の第2日曜の午前2時から、11月の第1日曜の午前2時まで、1時間すすむ)
  const nthSunday = (year, month, n) => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - first) % 7) + 7 * (n - 1));
  };
  function dayByRule(ms){
    const year = new Date(ms - 8 * HOUR).getUTCFullYear();
    const start = nthSunday(year, 2, 2) + 10 * HOUR;    // 標準時(UTC-8)の午前2時 = 10:00 UTC
    const end = nthSunday(year, 10, 1) + 9 * HOUR;      // 夏時間(UTC-7)の午前2時 = 09:00 UTC
    const off = ms >= start && ms < end ? 7 : 8;
    return new Date(ms - off * HOUR).toISOString().slice(0, 10);
  }

  const quota = {
    day(now){ const ms = toMs(now); return dayByIntl(ms) || dayByRule(ms); },
    dayByRule(now){ return dayByRule(toMs(now)); }
  };

  // ---- 読み書き ----
  const checkModel = model => { if (typeof model !== 'string' || !model || !util.safeKey(model)) throw bad('モデルの名前がおかしい: ' + model); };
  const dayArg = day => {
    if (day == null) return quota.day();
    if (typeof day !== 'string' || !DAY.test(day)) throw bad('回数の日がおかしい: ' + day);
    return day;
  };
  const pathOf = day => PRE + day.slice(0, 7);
  // 読んだかたまりを、この端末から見た形にする(無ければ空。形の版が新しければ失敗=書き換えない)
  const view = cur => {
    const dev = store.deviceId;
    return schema.quotaView(schema.open('quota', cur, () => schema.make.quotaMonth(dev)), dev);
  };
  // この端末の、その日・そのモデルの数字(無ければ作る。こわれた値は 0 から)
  function cell(rec, day, model){
    const d = rec.days[day] = isPlain(rec.days[day]) ? rec.days[day] : {};
    const c = d[model] = schema.fill(d[model], schema.counts());
    Object.keys(schema.counts()).forEach(k => { c[k] = num(c[k]); });
    return c;
  }
  let pruned = false;   // 古い月を捨てるのは、ページを開いてから最初に数えたあとの1回
  function write(day, model, fn){
    return store.init()
      .then(() => store.shared.update(pathOf(day), cur => { const rec = view(cur); fn(cell(rec, day, model)); return rec; }))
      .then(() => { if (pruned) return; pruned = true; return quota.prune().catch(() => 0); })
      .then(() => day);
  }
  const month = day => store.init().then(() => store.shared.get(pathOf(day))).then(view);
  // その日・そのモデルの数字を、全部の端末から集める
  function cells(rec, day, model){
    const out = [];
    const take = days => { const c = isPlain(days) && isPlain(days[day]) ? days[day][model] : null; if (isPlain(c)) out.push(c); };
    take(rec.days);
    Object.keys(rec.others).forEach(dev => take(rec.others[dev]));
    return out;
  }
  // 使った回数 = 送った − 上限で断られた − つながらなかった
  const usedOf = list => Math.max(0, list.reduce((s, c) => s + num(c.sent) - num(c.lim) - num(c.net), 0));
  const hitOf = list => list.some(c => !!c.hitDay);

  // 1つ数える。戻りは、数えた回数の日(通信の結果は、送ったときの日を day に渡して、同じ日に数える)
  quota.note = (model, kind, usage, day) => attempt(() => {
    checkModel(model);
    if (!KINDS.includes(kind)) throw bad('数える種類がおかしい: ' + kind);
    return write(dayArg(day), model, c => {
      c[kind]++;
      if (isPlain(usage)) USAGE.forEach(k => { if (num(usage[k]) > 0) c[k] += usage[k]; });
    });
  });
  // 「その日、このモデルで1日の上限に当たった」の印
  quota.markHit = (model, day) => attempt(() => {
    checkModel(model);
    return write(dayArg(day), model, c => { if (!c.hitDay) c.hitDay = util.nowISO(); });
  });
  quota.used = (model, day) => attempt(() => {
    checkModel(model);
    const d = dayArg(day);
    return month(d).then(rec => usedOf(cells(rec, d, model)));
  });
  quota.hit = (model, day) => attempt(() => {
    checkModel(model);
    const d = dayArg(day);
    return month(d).then(rec => hitOf(cells(rec, d, model)));
  });
  // 今日の分。並ぶのは、設定の目安(limits)にあるモデルと、今日(どれかの端末で)数えたモデル
  quota.today = async function(){
    const day = quota.day();
    const rec = await month(day);
    const limits = settings.get().limits;
    const models = Object.keys(limits);
    const add = days => {
      if (isPlain(days) && isPlain(days[day])) Object.keys(days[day]).forEach(m => { if (!models.includes(m)) models.push(m); });
    };
    add(rec.days);
    Object.keys(rec.others).forEach(dev => add(rec.others[dev]));
    const out = {};
    models.filter(util.safeKey).forEach(m => {
      const list = cells(rec, day, m);
      out[m] = { used: usedOf(list), limit: typeof limits[m] === 'number' ? limits[m] : null, hitDay: hitOf(list) };
    });
    return out;
  };
  // 古い月を捨てる(今の月との差が quota.keepMonths を超えた月)→ 捨てた月の数
  quota.prune = async function(now){
    await store.init();
    const index = m => +m.slice(0, 4) * 12 + (+m.slice(5, 7) - 1);
    const cur = index(quota.day(now));
    let n = 0;
    for (const k of await store.shared.keys(PRE)){
      const m = k.slice(PRE.length);
      if (!MONTH.test(m) || cur - index(m) <= config.quota.keepMonths) continue;
      await store.shared.del(k);
      n++;
    }
    return n;
  };

  Yomu.quota = quota;
})();

/* ---- core/runs.js ---- */
// core/runs.js — 通信の記録(部品の約束 §8-6)。翻訳と熟語さがしの1回ごとに、送った数・使えた数・未訳・かかった時間を残す
//   shared の p/{pid}/runs/{YYYY-MM}(月 = at の UTC の月)。AI辞書の通信は残さない(回数だけ数える=core/quota.js)
//   API キーとページの文章が、まぎれて入らないように、決まった欄だけを写す
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, schema = Yomu.schema, store = Yomu.store, settings = Yomu.settings, quota = Yomu.quota;
  const isPlain = util.isPlain;
  const ROLES = ['translate', 'idiom'];
  const SKIP = 'dict';                       // 残さない通信
  const DAY = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-\d{2}$/;
  const PRE = 'runs/';
  const DAYMS = 86400000;
  const MASK = '[key]';

  const bad = msg => util.error('bad', msg);
  const attempt = fn => Promise.resolve().then(fn);
  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const numOrNull = v => (typeof v === 'number' && isFinite(v) ? v : null);
  // 文字の欄: 長さを runs.textMax までにする(数は、そのまま。ほかは null)
  const text = v => (typeof v === 'string' ? v.slice(0, config.runs.textMax) : numOrNull(v));
  // 時刻(Date・ミリ秒・ISO の文字)→ ISO の文字。おかしければ null
  const iso = v => {
    const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    return isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const byAt = (a, b) => { const x = String((a && a.at) || ''), y = String((b && b.at) || ''); return x < y ? -1 : x > y ? 1 : 0; };
  const cutoffOf = now => new Date(Date.parse(now) - config.runs.keepDays * DAYMS).toISOString();

  // ---- API キーに見えるものを伏せる(相手が返した中身 err.raw に、まぎれていたときのため) ----
  async function apiKeys(){
    try {
      const s = await settings.secrets.get();
      return Object.keys(s.providers).map(id => (isPlain(s.providers[id]) && typeof s.providers[id].apiKey === 'string' ? s.providers[id].apiKey.trim() : '')).filter(k => k.length >= 8);
    } catch (e){ return []; }
  }
  function scrub(s, keys){
    keys.forEach(k => { s = s.split(k).join(MASK); });
    return s
      .replace(/AIza[0-9A-Za-z_\-]{16,}/g, MASK)
      .replace(/([?&]key=)[^&\s"'<>\\]+/gi, '$1' + MASK)
      .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',}\\]+/gi, '$1' + MASK)
      .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1' + MASK);
  }

  // ---- 返ってきた訳の確かめの数字(§6-4)を、小さくする ----
  //   0 でない数だけ/missing(未訳の文の番号の並び)は件数に/tenths は、未訳があるときだけ/そのほかは入れない
  function compact(rep){
    const out = {};
    if (!isPlain(rep)) return out;
    Object.keys(rep).forEach(k => { if (util.safeKey(k) && num(rep[k]) !== 0) out[k] = rep[k]; });
    if (Array.isArray(rep.missing) && rep.missing.length) out.missing = rep.missing.length;
    if (Array.isArray(rep.tenths) && num(rep.got) < num(rep.sent)) out.tenths = rep.tenths.slice(0, 10).map(num);
    return out;
  }

  // 渡されたものから、決まった欄だけを写す(§8-6 の Run)
  function build(run, now, keys){
    const rec = schema.make.run();
    rec.id = util.uid('run');
    rec.dev = store.deviceId;
    rec.at = iso(run.at) || now;
    rec.qday = typeof run.qday === 'string' && DAY.test(run.qday) ? run.qday : quota.day(rec.at);
    rec.role = run.role;
    ['model', 'think', 'provider', 'promptV', 'wireV', 'finish'].forEach(k => { rec[k] = text(run[k]); });
    ['page', 'level', 'tr'].forEach(k => { if (typeof run[k] === 'string') rec[k] = text(run[k]); });
    if (isPlain(run.sent)) rec.sent = { targets: num(run.sent.targets), chars: num(run.sent.chars) };
    rec.rep = compact(run.rep);
    rec.ms = num(run.ms);
    rec.firstMs = numOrNull(run.firstMs);
    if (isPlain(run.usage)) rec.usage = { tin: num(run.usage.tin), tout: num(run.usage.tout), tthink: num(run.usage.tthink) };
    if (isPlain(run.err)){
      rec.err = { kind: text(run.err.kind), status: numOrNull(run.err.status) };
      if (run.err.quotaId != null) rec.err.quotaId = text(run.err.quotaId);
      if (typeof run.err.raw === 'string') rec.err.raw = scrub(run.err.raw, keys).slice(0, config.runs.rawMax);
    }
    if (isPlain(run.x)) rec.x = util.clone(run.x);
    return rec;
  }

  let pruned = false;   // 月まるごと古いかたまりを消すのは、ページを開いてから最初に書いたあとの1回
  const runs = {
    // 1件残す → id。AI辞書の通信(role 'dict')は、何も残さずに null
    add: run => attempt(async () => {
      if (!isPlain(run)) throw bad('通信の記録がおかしい');
      if (run.role === SKIP) return null;
      if (!ROLES.includes(run.role)) throw bad('通信の種類がおかしい: ' + run.role);
      await store.init();
      const now = util.nowISO();
      const rec = build(run, now, await apiKeys());
      const cutoff = cutoffOf(now);
      await store.shared.update(PRE + rec.at.slice(0, 7), cur => {
        const chunk = schema.open('runs', cur, schema.make.runsMonth);
        // 残す日数より前の分は、書くついでに落とす
        chunk.items = (Array.isArray(chunk.items) ? chunk.items : []).filter(e => !(isPlain(e) && typeof e.at === 'string' && e.at < cutoff));
        chunk.items.push(rec);
        chunk.items.sort(byAt);
        return chunk;
      });
      if (!pruned){ pruned = true; await runs.prune().catch(() => 0); }
      return rec.id;
    }),
    // 新しい順。from ≤ at < to(Date・ミリ秒・ISO の文字)。role で絞れる
    list: opt => attempt(async () => {
      opt = opt || {};
      const bound = (v, name) => { if (v == null) return null; const s = iso(v); if (!s) throw bad(name + ' の時刻がおかしい: ' + v); return s; };
      const from = bound(opt.from, 'from'), to = bound(opt.to, 'to');
      await store.init();
      const out = [];
      for (const k of await store.shared.keys(PRE)){
        const m = k.slice(PRE.length);
        if (!MONTH.test(m)) continue;
        if ((from && monthEnd(m) <= from) || (to && m + '-01T00:00:00.000Z' >= to)) continue;   // 月まるごと、範囲の外
        const chunk = await store.shared.get(k);
        if (schema.newer('runs', chunk)) throw util.error('newer', '新しい版のデータなので、読まない: ' + k);
        (isPlain(chunk) && Array.isArray(chunk.items) ? chunk.items : []).forEach(e => {
          if (!isPlain(e) || typeof e.at !== 'string') return;
          if ((from && e.at < from) || (to && e.at >= to) || (opt.role && e.role !== opt.role)) return;
          out.push(e);
        });
      }
      return out.sort((a, b) => byAt(b, a) || (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0));
    }),
    // 月まるごと、残す日数より前のかたまりを消す → 消した月の数
    async prune(now){
      await store.init();
      const cutoff = cutoffOf(now == null ? util.nowISO() : iso(now) || util.nowISO());
      let n = 0;
      for (const k of await store.shared.keys(PRE)){
        const m = k.slice(PRE.length);
        if (!MONTH.test(m) || monthEnd(m) > cutoff) continue;
        await store.shared.del(k);
        n++;
      }
      return n;
    }
  };
  // その月の終わり(次の月の始まり。UTC)
  function monthEnd(m){ return new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString(); }

  Yomu.runs = runs;
})();

/* ---- core/llm.js ---- */
// core/llm.js — AI を1回呼ぶ(部品の約束 §5-4)。1回の呼び出し = 1回の通信。**自動の再試行はしない**
//   送る形と読み方は相手の部品(core/provider_*.js)、少しずつ届く行の読み取りは core/sse.js、通信そのものは Yomu.env.http。
//   ここが持つのは: API キーを取る・回数を数える(§8-5)・結果と失敗を分ける・API キーを失敗の文に出さない。
//   通信の記録(§8-6)は書かない(確かめの数字とページの番号を知っている、呼んだ側が書く)
(function(){
  'use strict';
  const Y = Yomu;   // 先頭で受けておく(あとから差し替わる Yomu.env は、Y.env と読む)
  const util = Y.util, config = Y.config, levels = Y.levels, sse = Y.sse, providers = Y.providers;
  const store = Y.store, settings = Y.settings, quota = Y.quota;
  const ROLES = ['translate', 'idiom', 'dict'];
  const MASK = '[key]';
  const KEY_OK = /^[\x21-\x7e]+$/;    // 見出しに入れられる文字だけ(空白・全角が混ざったキーは、送る前に断る)

  const attempt = fn => Promise.resolve().then(fn);
  const fail = (kind, message, extra) => util.error(kind, message, extra);
  const now = () => Date.parse(util.nowISO());
  // 数えの失敗(保存がいっぱい など)では、通信を止めない
  const quiet = fn => attempt(fn).catch(() => null);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // 相手の部品と API キー。使えなければ、送る前に断る
  async function prepare(providerId){
    await store.init();
    const id = providerId == null ? settings.get().provider : providerId;
    const p = typeof id === 'string' && util.safeKey(id) && hasOwn(providers, id) ? providers[id] : null;
    if (!p || p.ready === false) throw fail('bad', 'この相手は使えない: ' + id);
    const key = await settings.secrets.key(id);
    if (!key) throw fail('no-key', 'API キーが入っていない');
    if (!KEY_OK.test(key)) throw fail('auth', 'API キーに、使えない文字(空白や全角の文字)が入っている');
    return { p, id, key };
  }
  // にせの翻訳サーバーに向けるのは、dev の束だけ(§2-2)
  const baseUrl = () => (Y.env.dev === true && typeof Y.env.apiBase === 'string' && Y.env.apiBase ? Y.env.apiBase : undefined);
  // 保存してあるキーそのものを伏せる(相手が、送った URL やキーを、エラーの文に入れて返すことがある)
  const scrubber = key => s => (typeof s === 'string' ? s.split(key).join(MASK) : '');
  const aborted = (e, signal) => (!!e && e.name === 'AbortError') || !!(signal && signal.aborted);

  const llm = {
    call: o => attempt(async () => {
      o = o || {};
      if (!ROLES.includes(o.role)) throw fail('bad', '通信の種類がおかしい: ' + o.role);
      const model = typeof o.model === 'string' ? o.model.trim().replace(/^models\//, '') : '';
      if (!model || !util.safeKey(model)) throw fail('bad', 'モデルの名前がおかしい: ' + o.model);
      if (typeof o.prompt !== 'string' || !o.prompt) throw fail('bad', '指示文が無い');
      if (!levels.thinkModes.includes(o.think)) throw fail('bad', '思考の指定がおかしい: ' + o.think);
      if (o.onText != null && typeof o.onText !== 'function') throw fail('bad', 'onText が関数でない');
      const signal = o.signal || undefined;
      const { p, id, key } = await prepare(o.provider);
      const scrub = scrubber(key);
      const req = p.request({ key, baseUrl: baseUrl(), model, prompt: o.prompt, json: !!o.json, think: o.think,
        temp: config.llm.temp[o.role], maxOut: config.llm.maxOut, keyIn: config.llm.keyIn });
      if (signal && signal.aborted) throw fail('abort', '中止した', { sent: false, status: null, partial: false, text: '', usage: null, ms: 0, firstMs: null, model, provider: id, qday: null });

      // ここから先は「送った」。回数は、送った日の1回として数える(§8-5)
      const day = await quiet(() => quota.note(model, 'sent'));
      const t0 = now();
      const st = { text: '', finish: null, block: null, usage: null, firstMs: null, started: false, read: false, err: null, raw: '', cbErr: null };
      const onData = s => {
        let d = null;
        try { d = p.data(s); } catch (e){}
        if (!d) return;                              // 読めない1件は、飛ばす
        st.read = true;
        if (st.err || st.finish) return;             // エラーや終わりの印のあとに届いたものは、使わない
        if (d.error){ st.err = d.error; st.raw = s; return; }
        if (d.usage) st.usage = d.usage;
        if (d.text){
          if (st.firstMs === null) st.firstMs = now() - t0;
          st.text += d.text;
          if (o.onText && !st.cbErr){ try { o.onText(d.text); } catch (e){ st.cbErr = e || new Error('onText の中の失敗'); } }
        }
        if (d.finish){ st.finish = d.finish; st.block = d.block || null; }
      };
      const rd = sse.reader({ onData, onBare: onData });
      let res = null, thrown = null;
      try {
        res = await Y.env.http.stream({ url: req.url, method: req.method, headers: req.headers, body: req.body, signal,
          onChunk: t => { st.started = true; rd.push(t); } });
      } catch (e){ thrown = e || new Error('通信の失敗'); }
      rd.end();

      const ms = now() - t0;
      const info = () => ({ sent: true, partial: st.text.length > 0, text: st.text, usage: st.usage, ms, firstMs: st.firstMs, model, provider: id, qday: day });
      // 「送った」を数えられなかったときは、結果も数えない(使った回数が、ずれないように)
      const note = kind => (day ? quiet(() => quota.note(model, kind, st.usage, day)) : Promise.resolve(null));
      const hitDay = kind => (kind === 'limit-day' ? quiet(() => quota.markHit(model, day || undefined)) : Promise.resolve(null));
      const cut = s => scrub(s).slice(0, config.runs.rawMax);

      // 始まる前のエラー(HTTP の失敗)
      if (res && !res.ok){
        const body = typeof res.text === 'string' ? res.text : '';
        const e = p.error(res.status, body);
        await note(res.status === 429 ? 'lim' : 'err');
        await hitDay(e.kind);
        throw fail(e.kind, scrub(e.message), Object.assign({ status: e.status, retrySec: e.retrySec, quotaId: e.quotaId, raw: cut(body) }, info()));
      }
      // 途中のエラー({ error } の行)
      if (st.err){
        const e = st.err;
        await note(st.text ? 'ok' : e.status === 429 ? 'lim' : 'err');
        await hitDay(e.kind);
        throw fail(e.kind, scrub(e.message), Object.assign({ status: e.status, retrySec: e.retrySec, quotaId: e.quotaId, raw: cut(st.raw) }, info()));
      }
      // つながらない・途中で切れた・中止(終わりの印まで届いていれば、返事は全部ある=成功として扱う)
      if (thrown && !st.finish){
        const stop = aborted(thrown, signal);
        await note(st.started ? 'ok' : 'net');
        throw fail(stop ? 'abort' : 'network', stop ? '中止した' : 'つながらなかった: ' + scrub(String(thrown.message || thrown)), Object.assign({ status: null }, info()));
      }
      await note('ok');
      if (!st.read) throw fail('parse', '返事を読めなかった', Object.assign({ status: res ? res.status : null }, info()));
      if (st.cbErr) throw st.cbErr;
      const out = { text: st.text, finish: st.finish || 'drop', usage: st.usage, ms, firstMs: st.firstMs, model, provider: id, qday: day };
      if (st.block) out.block = st.block;
      return out;
    }),

    // モデルの一覧(回数にも、通信の記録にも入れない)
    models: o => attempt(async () => {
      o = o || {};
      const signal = o.signal || undefined;
      const { p, key } = await prepare(o.provider);
      const scrub = scrubber(key);
      const req = p.models({ key, baseUrl: baseUrl(), keyIn: config.llm.keyIn });
      let text = '', res;
      try {
        res = await Y.env.http.stream({ url: req.url, method: req.method, headers: req.headers, signal, onChunk: t => { text += t; } });
      } catch (e){
        const stop = aborted(e, signal);
        throw fail(stop ? 'abort' : 'network', stop ? '中止した' : 'つながらなかった: ' + scrub(String((e && e.message) || e)), { status: null });
      }
      if (!res.ok){
        const e = p.error(res.status, typeof res.text === 'string' ? res.text : '');
        throw fail(e.kind, scrub(e.message), { status: e.status, retrySec: e.retrySec, quotaId: e.quotaId });
      }
      let json;
      try { json = JSON.parse(text); } catch (e){ throw fail('parse', 'モデルの一覧を読めなかった', { status: res.status }); }
      return p.modelList(json);
    })
  };

  Yomu.llm = llm;
})();

/* ---- core/prompts.js ---- */
// core/prompts.js — AI への指示文(部品の約束 §6-1・§6-5・§6-6)
//   文面は、現行(iPhone 版 v1.6.7)で実地に調整済みのもの。**変えた所は §6-1 の表だけ**で、あとは一字も変えていない
//   (tests/check_prompts.js が、現行の写し tests/fixtures/legacy_prompts.js と1行ずつ突き合わせる)。
//   文面を変えたら V を上げて、理由を §6-1 に1行残す。通信の種類と目印の長さを、にせの翻訳サーバーが文面から見分けているので、
//   tools/fake_server.js の roleOf・anchorLen も合わせる。
(function(){
  'use strict';
  const util = Yomu.util, levels = Yomu.levels;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // 翻訳の、レベルごとの文面(鍵は、現行の learningMode の名前 = levels の legacy)
  //   通常・2級・準1級は、現行 getLearningModeInstruction のまま。3級・準2級は、工程T-2 の案 c3(engine/exp_out/a1c3.txt・a2c3.txt の @level の下)を
  //   機械で写した(v4。tests/check_prompts.js が、案のファイルと1字ずつ突き合わせる)。
  //   v6(工程T-6): 3級は案2(exp_out/a1t6b.txt=直訳ぐせを避ける頼み 3 行+創作の例)・準2級は案1(exp_out/a2t6a.txt=頼み 3 行)の @level の下を、機械で写した
  const LEVEL = {
    eiken_grade3: `【英語学習モード: 英検3級レベル（中学卒業程度）】
- 英語を学んでいる中学卒業程度の読者が、辞書をあまり引かずに読めるように翻訳してください。
- 使う語は、中学校で習う基本語（CEFR の A1〜A2 の語。日常でよく使う約2,000語）に限ってください。それより難しい語は、やさしい語の組み合わせや短い言いかえにしてください。言いかえるとニュアンスが変わりすぎるときだけ、難しい語を使ってかまいません。
- 話に欠かせない物や場所の名前は、言いかえると不自然になるなら、そのまま使ってかまいません。
- 人の呼び方（「様」などの敬称や、身分・立場の呼び名）は、やさしい語の決まりに当てはめず、場面に合うふつうの英語の呼び方にしてください。
- 文法は、中学で習う形だけで書いてください（現在・過去・未来・進行形・現在完了・受け身・助動詞・不定詞・動名詞・比較・関係代名詞の who・which・that・名詞のすぐ後ろに付く分詞・接続詞・会話の短縮形の I'm・don't など）。
- 次の形は中学で習わないので使わず、かっこの中の形にしてください: 過去完了の had＋過去分詞（過去形にする）／助動詞＋have＋過去分詞（過去形にするか、I'm sure などを使う）／-ing や -ed の句をカンマでつなぐ分詞構文（2つの文に分けるか、and・when・because でつなぐ）／場所を文の頭に出して主語をあとに置く倒置（There was … の形にするか、主語から始める）／whose・whom・前置詞＋which（2つの文に分ける）／with＋名詞＋分詞（and でつなぐ）。
- 長くなる文は、2つの短い文に分けてかまいません。
- 地の文の時制は、まわりの語りにそろえてください（過去形の語りの中では、日本語が現在形でも過去形にします）。
- 日本語の文を、語の順に1語ずつ英語へ置きかえないでください。先に、その場面で何が起きているか（だれが何をしたか・どう感じたか）をつかみ、英語を話す人が同じ場面でふつうに言う文を考えてから、語と文法をこのモードの範囲に合わせてください。
- 次の所は、日本語の形をなぞった英語になりやすいので、特に気をつけてください: 時を表す言葉／顔や体の動きと表情／あいさつ・お礼・ねぎらいのように、決まった場面で言う言葉／声・音・色・形の言い方／物の置き場所や、建物・家具の中の位置／気持ちや様子を表す言葉（動作の様子を表す副詞など）。英語で同じことをふつう何と言うかを考え、日本語の名詞や動詞を、そのまま英語の語に置きかえないでください。
- give up・pick up・get off のような、やさしい語を組み合わせた言い方は、やさしい語の範囲に入ります。英語でふつうに使う言い方なら、使ってください。
- 例（日本語の形をなぞった英語 → ふつうの英語）: 「彼女は目を丸くした」→ × She made her eyes round. → ○ Her eyes went wide.／「彼は首をかしげた」→ × He bent his neck. → ○ He tilted his head.／「歩き回って、足が棒になった」→ × My legs became sticks. → ○ My legs were so tired from walking.
- やさしくしても、子どもっぽい英語にはしないでください。原文の内容は、省かず・足さずに伝えてください。`,
    eiken_grade_pre2: `【英語学習モード: 英検準2級レベル（高校中級程度）】
- 英語を学んでいる高校中級程度の読者が、辞書をあまり引かずに読めるように翻訳してください。
- 使う語は、高校1年生までに習う語（CEFR の A2 までの語を中心に、B1 の語は少しなら可。約3,000語）を目安にしてください。それより難しい語や、書き言葉らしい硬い語は、よく使う語に言いかえてください。言いかえるとニュアンスが変わりすぎるときだけ、難しい語を使ってかまいません。
- 話に欠かせない物や場所の名前は、言いかえると不自然になるなら、そのまま使ってかまいません。
- 人の呼び方（「様」などの敬称や、身分・立場の呼び名）は、やさしい語の決まりに当てはめず、場面に合うふつうの英語の呼び方にしてください。
- 文法は、高校1年までに習う形を目安にしてください（会話の短縮形の I'm・don't などをふくむ、中学で習う形に加えて、過去完了・whose・関係副詞の where と when は使ってかまいません）。
- 次の形は避け、かっこの中の形にしてください: -ing や -ed の句をカンマでつなぐ分詞構文（2つの文に分けるか、接続詞でつなぐ）／場所を文の頭に出して主語をあとに置く倒置（主語から始める）／助動詞＋have＋過去分詞（過去形にするか、I'm sure などを使う）／with＋名詞＋分詞（and でつなぐ）。
- 地の文の時制は、まわりの語りにそろえてください（過去形の語りの中では、日本語が現在形でも過去形にします）。
- 日本語の文を、語の順に1語ずつ英語へ置きかえないでください。先に、その場面で何が起きているか（だれが何をしたか・どう感じたか）をつかみ、英語を話す人が同じ場面でふつうに言う文を考えてから、語と文法をこのモードの範囲に合わせてください。
- 次の所は、日本語の形をなぞった英語になりやすいので、特に気をつけてください: 時を表す言葉／顔や体の動きと表情／あいさつ・お礼・ねぎらいのように、決まった場面で言う言葉／声・音・色・形の言い方／物の置き場所や、建物・家具の中の位置／気持ちや様子を表す言葉（動作の様子を表す副詞など）。英語で同じことをふつう何と言うかを考え、日本語の名詞や動詞を、そのまま英語の語に置きかえないでください。
- give up・pick up・get off のような、よく使う語を組み合わせた言い方は、英語でふつうに使う言い方なら、使ってください。
- 子どもっぽい英語にはしないでください。原文の内容は、省かず・足さずに伝えてください。`,
    eiken_grade2: `【英語学習モード: 英検2級レベル（高校卒業・大学入試・CEFR B1相当）】
- 英検2級（高校卒業・大学入学共通テスト程度）相当の実践的な重要語彙を目安とし、文脈に合った自然な現代英語に翻訳してください。`,
    eiken_grade_pre1: `【英語学習モード: 英検準1級レベル（大学上級・難関大・CEFR B2〜C1相当）】
- 英検準1級相当の洗練された高度な語彙・構文を目安とし、小説の情景や心情を豊かに表現する現代英語に翻訳してください。
- 学術論文のような硬すぎる表現を避け、また元の文章にない過剰な脚色を避け、原文の意味に忠実で格調高い小説トーンを維持してください。`,
    standard: `【通常モード（自然な現代英語）】
- 日本のWeb小説です。前後の文脈や登場人物の口調、主語の補完、自然な文法構造を意識して、最も自然で読みやすい現代英語に翻訳してください。
- 日本語の直訳構文を避け、英語ネイティブが実際に小説で使う自然な表現を用いてください。
- 無理なスラングを詰め込まず自然な文章にしてください（ただし、ネット掲示板や配信チャット等の文脈に限り、それに適した自然な口語・ネット表現を用いて構いません）。`
  };
  // 熟語さがしの、レベルごとの文面(現行 getVocabLevelInstruction のまま)
  const VOCAB = {
    eiken_grade3: `対象読者は中学生〜英検3級学習者です。中学・英検3級レベルで学ぶべき【基本句動詞・重要熟語・前置詞の定型表現】を抽出してください。難解な熟語は避けてください。`,
    eiken_grade_pre2: `対象読者は高校中級〜英検準2級学習者です。英検準2級レベルの【重要熟語・日常句動詞・コロケーション】を抽出してください。`,
    eiken_grade2: `対象読者は高校生〜英検2級受験者です。高校入試〜共通テスト・英検2級レベルで頻出の【重要熟語・群動詞・構文】を抽出してください。`,
    eiken_grade_pre1: `対象読者は大学生〜英検準1級学習者です。英検準1級レベルの【洗練された語彙・成句・文学的コロケーション】を抽出してください。`,
    standard: `対象読者は一般の小説読者・英語学習者です。英文に含まれる【句動詞・熟語・イディオム・定型表現・重要構文（2語以上からなる表現）】を最優先で抽出してください。単体の基本単語や単なる名詞・形容詞は抽出不要です。`
  };
  // 記事の場面の文面(設計メモ 2-6。工程8e-1 で、本物の AI の返事を読んで決めた。工程8e-2a で、案のファイルから機械で写した=手で書き写していない。
  //   tests/check_prompts.js の H が、案のファイルと1字ずつ・工程8e-1 で本物の AI に送った指示文とまるごと同じことを確かめる)
  //   翻訳 = engine/exp_out/wb2.txt(頭の 3 行=@head・訳の出し方のルール 8 つ・通常の級の文面=@level)/ 熟語さがし = iv_w1.txt(通常の級の文面)/「AIに聞く」= dict_article.txt
  //   級の文面を差しかえるのは、通常だけ(3級・準2級などは、記事でも小説と同じ級の文面。3級・準2級は、記事でも効くことを確かめた=工程8e-1)
  const ARTICLE_HEAD = [
    "あなたは英語学習者向けの、日本語の記事を英語に翻訳するアシスタントです。",
    "下の【本文】は、日本語のWebページ（ニュース・解説・ブログなどの記事）の本文です。<t id=\"番号\">…</t> で囲んだ文が翻訳対象です。囲まれていない部分は、話題や文脈を読み取るためのものです。",
    "本文全体を参照し、話題、書き手の立場、文章の種類（報道・解説・コラムやエッセイ・くだけたブログ など）と調子を正確に反映して、翻訳対象の各文を自然な現代英語に翻訳してください。本文が物語（小説）なら、物語として訳してください。"
  ];
  const ARTICLE_STYLE = [
    "【書き手と主語】: 地の文を \"I\" \"my\" \"we\" で書くのは、書き手が自分のことを書いている文（「筆者」「私」など）だけです。「筆者」は \"I\" にしてください。読む人に話しかける文は \"you\" を使ってください。",
    "【人の名前と肩書】: 人名は、英語の記事のふつうの書き方にしてください。初めて出てくる人は、肩書があれば肩書も名前と一緒に書き（肩書を落とさない）、2回目からは名字だけにします。肩書（社長・首相・教授 など）は、英語の記事で使う肩書にしてください。人名に付く「さん・氏・様・君・ちゃん」は英語に出さず、\"Mr.\" \"Ms.\" も付けません。\"-san\" のようなローマ字の敬称も付けないでください。",
    "【人物の性別】: he / she を使うのは、本文から性別がはっきり分かる人だけです。分からない人は、he / she を当てずに、名字や肩書（the analyst など）で受けてください（記事の人物は実在の人なので、性別を決めつけないでください）。",
    "【数と単位】: 数は、英語の数え方に正しく直してください（万・億・兆は thousand・million・billion・trillion に。例: 4万5000人 → 45,000 people、6億円 → 600 million yen、3兆円 → 3 trillion yen）。「割」は % にしてください（2割 → 20%）。数そのものを変えたり、丸めたりしないでください。",
    "【2けたの年】: 「29年3月期」「29年春」のように年を2けたで書いた所は、4けたの年にしてください（29年3月期 → the fiscal year ending March 2029）。",
    "【発言の言い方】: 「」の中の発言は、その人が実際に口にする英語にしてください。会話では I'm・don't・it's のような短縮形を使うのがふつうです。",
    "【文の中の「」】: <t> の中に「…」（せりふ・呼び名・引用）がある場合は、その部分を英語の二重引用符で囲み、地の文と合わせて1つの英文にしてください（例: 「行こう」とケンは言った。→ \"en\": \"\\\"Let's go,\\\" Ken said.\"）。<t> が「 で始まっていても、引用符を省かないでください。JSON の文字列の中なので、英文中の \" は \\\" と書いてください。せりふだけの文（<t> の外側に「」がある文）は、引用符を付けずに、英文だけを出力してください。",
    "【モードの指示を守る】: 冒頭の【…モード】に書かれた、使う語と文法の決まりを、最初の文から最後の文まで守ってください。"
  ];
  const ARTICLE_LEVEL = { standard: "【通常モード（自然な現代英語）】\n- 日本語のWeb記事です。英語圏のニュースサイト・解説記事・ブログで、書き手が実際に使う自然な英語にしてください（報道の記事なら報道の英語、コラムやエッセイなら書き手の語り口を生かした英語、読む人に話しかける記事なら、話しかける英語）。\n- 日本語の直訳構文を避けてください。主語が省かれた文は、文脈から主語（会社・団体・人物・書き手・読む人 など）を補ってください。体言止めや「〜とのこと」のような終わり方も、英語のふつうの文にしてください。\n- 原文の内容（数・名前・事実）は、省かず・足さず・変えずに伝えてください。" };
  const ARTICLE_VOCAB = { standard: "対象読者は、ニュース・解説・コラムなどの記事を読む英語学習者です。英文に含まれる【句動詞・熟語・イディオム・定型表現・重要構文（2語以上からなる表現）】に加えて、記事でよく使う2語以上の決まった言い方（ニュースや経済・社会の記事の定型表現・用語）を最優先で抽出してください。単体の基本単語は抽出不要です。" };
  const ARTICLE_DICT = "記事（ニュース・解説・コラム）での使われ方やニュアンス";

  // レベルの ID(std・a1…)→ 現行の名前。知らないレベルは、現行と同じく「通常」
  function legacyOf(levelId){
    const l = levels.has(levelId) ? levels.get(levelId) : null;
    return l && has(LEVEL, l.legacy) ? l.legacy : 'standard';
  }
  // 場面(省くと novel)→ 下の SCENE の1行。知らない場面は bad(だまって小説にしない)
  function sceneOf(scene, who){
    const k = scene == null ? 'novel' : scene;
    if (typeof k !== 'string' || !has(SCENE, k)) throw util.error('bad', who + ': 知らない場面: ' + scene);
    return SCENE[k];
  }
  // 級の文面。場面に、そのレベルの文面があれば、そちら(記事は、通常だけ)
  const level = (levelId, scene) => { const l = legacyOf(levelId), sc = sceneOf(scene, 'prompts.level'); return has(sc.level, l) ? sc.level[l] : LEVEL[l]; };
  const vocabLevel = (levelId, scene) => { const l = legacyOf(levelId), sc = sceneOf(scene, 'prompts.vocabLevel'); return has(sc.vocab, l) ? sc.vocab[l] : VOCAB[l]; };

  // 訳の出し方(設計メモ 2-3。現行には無い。どのレベルにも入る「共通の部分」)。本物の AI の返事を読んで決めた
  //   (v2 = 工程3c-4 の2つ・v3 = 工程E1b の4つ・v4 = 工程T-2 の案 c3 の7つ=engine/exp_out/c3.txt を機械で写した)
  //   ルール4(語り手・主語)のすぐ後ろに、この順で入る。比べる台本(tools/exp_translate.js)は、translate の o.style で、別の案に差しかえる
  //   「様」の所に、敬称の例(Mr.・Lord など)を書かない: 本物の AI は、例に引かれる(Lord を例に出すと、灯台守を Lord と呼んだ。部品の約束 §6-8 の「工程E1b の結果」)
  //   c3 で足した「身分の高い相手には Mr.・Ms. にしない」の副作用(さん・君の人に Mr.)は、エンジンが機械で外す(core/fix.js)
  const STYLE = [
    '【主語と視点】: 日本語で主語が省かれた地の文（人物の気持ち・体の感じ・考えを表す短い文も）は、語り手が三人称なら、he / she や名前を主語にしてください。地の文を "I" "my" "me" で書くのは、語り手が一人称の話のときだけです（せりふや、人物が書いた手紙・メモの文面は、その人物から見た人称のままにします）。',
    '【せりふの言い方】: せりふは、その人物が実際に口にする、ふだんの会話の英語にしてください。会話では I\'m・don\'t・it\'s のような短縮形を使うのがふつうで、学習モードでも同じです（短縮しない形は、強く言い張る・よそよそしい響きになるので、あらたまった口調の人物や、強調したい所だけにしてください）。',
    '【話し相手の呼び方】: せりふの中で、話している相手を名前や呼び名で指している文は、相手を "you" で表し、名前は呼びかけとして残してください（例: 相手のケンに向かって言う「ケンはどう思う？」→ "What do you think, Ken?"）。その場にいない人物を指している場合は、he / she や名前のままにしてください。',
    '【敬称の扱い】: 人名に付く「さん・君・ちゃん」は英語に出さず、名前だけにしてください（例: ケンさん・ケンさーん → Ken。"Mr." "Ms." も付けません）。"-san" "-kun" "-sama" のようなローマ字の敬称は、どの敬称でも付けないでください。「様」は、相手との関係に合う自然な英語の呼び方にしてください（貴族や領主、仕えている家の人のように身分の高い相手には、"Mr." "Ms." ではなく、身分に合う呼び方にします）。「先生」「先輩」のように呼び名そのものである語は、文脈に合う自然な英語にしてください。',
    '【人物の性別】: 登場人物の性別は、本文全体（一人称・呼ばれ方・まわりの描写）から判断し、人物ごとに he / she のどちらかに決めて、すべての文でそろえてください。はっきり書かれていない人物も、文脈からいちばん自然な方に決めてください。1人の人物を they / their で受けたり、代名詞を避けるために名前をくり返したり、不自然な文にしたりしないでください。',
    '【文の中の「」】: <t> の中に「…」（せりふ・呼び名・引用）がある場合は、その部分を英語の二重引用符で囲み、地の文と合わせて1つの英文にしてください（例: 「行こう」とケンは言った。→ "en": "\\"Let\'s go,\\" Ken said."）。<t> が「 で始まっていても、引用符を省かないでください。JSON の文字列の中なので、英文中の " は \\" と書いてください。せりふだけの文（<t> の外側に「」がある文）は、引用符を付けずに、英文だけを出力してください。',
    '【モードの指示を守る】: 冒頭の【…モード】に書かれた、使う語と文法の決まりを、最初の文から最後の文まで守ってください。'
  ];

  // 終わりの目印の頼み方に添える例の文(17 文字。見本の話に出てこない名前と文。E が 17 以上なら、全文が例になる)
  const END_EG = 'ケンは駅前の広場まで一気に走った。';

  // 小説の指示文の頭(はじめの空行までの 3 行。現行の冒頭を、本文を1回だけ送る形に言いかえたもの=§6-1 の表)
  const NOVEL_HEAD = [
    'あなたは英語学習者向けの高度な小説・文芸翻訳アシスタントです。',
    '下の【本文】は、日本のWeb小説の1話分です。<t id="番号">…</t> で囲んだ文が翻訳対象です。囲まれていない部分は、語り手の視点や状況を読み取るための文脈です。',
    '本文全体を参照し、物語の語り手の視点（一人称／三人称）、話者、性別、トーンを正確に反映して、翻訳対象の各文を自然な現代英語に翻訳してください。'
  ];
  // ---- 場面の表(設計メモ 2-6。工程8e-2a)----
  //   場面ごとに変わるのは: 翻訳の指示文の頭(head)・訳の出し方のルール(style)・級の文面(level。無いレベルは小説と同じ)・
  //   熟語さがしの級の文面(vocab。同じ)・「AIに聞く」の、どんなニュアンスを添えるかの言い方(dict)。ほかの所(ルール1〜4・省略の禁止・出力形式 など)は、どの場面も同じ。
  //   場面を足すときは、ここに1行足し、文面は本物の AI で比べてから決める(設計メモ 2-6 の「考え直せるようにしておく」)。どの場面で送るかを決めるのは、呼ぶ側(1 か所)
  const SCENE = {
    novel: { head: NOVEL_HEAD, style: STYLE, level: {}, vocab: {}, dict: '小説や会話でのニュアンス' },
    article: { head: ARTICLE_HEAD, style: ARTICLE_STYLE, level: ARTICLE_LEVEL, vocab: ARTICLE_VOCAB, dict: ARTICLE_DICT }
  };

  // ---- 翻訳(§6-1) ----
  //   body = 送る本文(wire.build の body)/ M = 翻訳対象の文の数 / K = 目印の長さ(0 = 目印なし、-1 = 全文の復唱)/ ruby = 本文にルビの印があるか
  //   E = 終わりの目印の長さ(省く・0 = 頼まない=v4 と同じ文面。v5 = 工程T-4: "en" のあとに、その "en" が訳している文の末尾 E 文字を "e" に書かせる)
  //   style = 訳の出し方のルールの並び(省くと、その場面のルール。[] なら入れない)。エンジンは渡さない(比べる台本だけが使う)
  //   scene = 場面(省くと novel。'article' = 記事=頭・ルール・通常の級の文面が記事向け。v7 = 工程8e-2a)
  function translate(o){
    o = o || {};
    const M = o.M, K = o.K, E = o.E == null ? 0 : o.E;
    const sc = sceneOf(o.scene, 'prompts.translate');
    if (typeof o.body !== 'string' || !o.body) throw util.error('bad', 'prompts.translate: body が無い');
    if (!Number.isInteger(M) || M < 1) throw util.error('bad', 'prompts.translate: M がおかしい');
    if (!Number.isInteger(K) || K < -1) throw util.error('bad', 'prompts.translate: K がおかしい');
    if (!Number.isInteger(E) || E < 0) throw util.error('bad', 'prompts.translate: E がおかしい');
    const style = o.style == null ? sc.style : o.style;
    if (!Array.isArray(style) || !style.every(r => typeof r === 'string' && r.trim() && r.indexOf(String.fromCharCode(10)) < 0 && r.indexOf(String.fromCharCode(13)) < 0)) throw util.error('bad', 'prompts.translate: style がおかしい');

    const rules = [];
    rules.push('【翻訳対象の厳密な限定】: 翻訳対象は <t> で囲まれた文【そのものだけ】です（囲まれていない部分や前後の文は、語り手の視点や状況の判定用であり、絶対に "en" に混入させないでください）。各 <t> の内容に一対一で対応する英文のみを出力してください。');
    // 終わりの目印(v5)。"en" を書いたあとに書かせる: AI が英文を1文先の文の訳にしたとき、終わりの目印も、その文のものになる見込み(エンジンが、合わない文を未訳に戻す)
    //   工程T-4 の本物の返事で、「末尾 E 文字(E 文字より短い文は全文)」と頼むと、1〜2 文字しか書かない回・文をまるごと書く回があったので、
    //   「最後の E 文字だけ」「文全体は書かない」と書き、例を 1 つ添える(例の文は、見本の話に出てこない文。E 文字ちょうどに切った形を、その場で作る)
    const ends = E > 0 ? '"en" を書き終えたら、"e" に、その "en" が訳している日本語原文の最後の' + E + '文字だけを、そのまま出力してください（文全体は書きません。' + E + '文字より短い文は全文。例: 「' + END_EG + '」なら "' + Array.from(END_EG).slice(-E).join('') + '"）。' : '';
    if (K > 0) rules.push('【目印による整合性保証】: 各要素の "k" に、その文の日本語原文の先頭' + K + '文字をそのまま出力してください（' + K + '文字より短い文は全文）。' + ends);
    else if (K < 0) rules.push('【復唱による整合性保証】: 各要素の出力JSONには、翻訳対象である日本語原文をそのまま "k" フィールドに必ず出力してください。' + ends);
    else if (ends) rules.push('【目印による整合性保証】: ' + ends);
    rules.push('【原文構造・引用符の整理】: 原文に含まれる話者表記（例: 【リスナー】等）は英訳（例: [Listener] 等）に反映してください。文全体を囲む外側の引用符（" " や \' \'）や日本語のカギ括弧（「」）は出力に含めず、純粋な英文テキストのみを出力してください。');
    rules.push('前後の文脈から語り手・主語を正確に判定してください（一人称なら "I"、三人称なら客観人称）。');
    style.forEach(r => rules.push(r));
    rules.push('【省略の禁止】: すべての <t> について、id の小さい順に、1つも飛ばさず・まとめず・要約せずに出力してください。必ず <t> と同じ個数・同じ id の JSON 配列を返してください。');
    rules.push(['出力形式:', '[', '  {', '    "id": 0,']
      .concat(K > 0 ? ['    "k": "原文の先頭' + K + '文字",'] : K < 0 ? ['    "k": "翻訳対象の日本語文",'] : [])
      .concat(E > 0 ? ['    "en": "Translated natural English sentence.",', '    "e": "原文の最後の' + E + '文字"'] : ['    "en": "Translated natural English sentence."'])
      .concat(['  }', ']']).join('\n'));
    rules.push('Markdownコードブロックや余計な解説は一切含めず、純粋なJSON配列のみを出力してください。');
    rules.push('各英文（"en"）は必ず文頭を大文字で始め、文末に適切な句読点を配置してください。');

    return sc.head.concat([
      '',
      level(o.level, o.scene),
      '',
      '※HTML実体参照（&quot; や &amp; 等）は出力に含めず、純粋な記号（" や \' など）をそのまま出力してください。'
    ]).concat(o.ruby ? ['※《》は直前の語のふりがな（ルビ）です。読みや意味の手がかりとして使い、出力には含めないでください。'] : []).concat([
      '',
      '【本文】（翻訳対象は ' + M + ' 文。id は 0〜' + (M - 1) + '）',
      o.body,
      '',
      '【必須ルール】'
    ]).concat(rules.map((r, i) => (i + 1) + '. ' + r)).join('\n');
  }

  // ---- 熟語さがし(§6-5)。現行 callGeminiExtractVocab の文面に足したもの ----
  //   IV(熟語さがしの指示文の版。翻訳の V とは別): 1 = 見出しの形 "b" だけを足した / 2 = 工程T-5b で 3 つ足した
  //     ルール6【省略の禁止】(AI が途中で「…((TRUNCATED))」と書いて終えたため)・"w" は英文の形のまま、間の語は ... でつなぐ・JSON の文字列の書き方(" を書き落としたため)
  //     / 3 = 記事の場面の、通常の級の文面(工程8e-2a。小説の文面は 2 と同じ)
  //   list = [{ id, en, target_jp }](id は、その通信の中の通し番号)/ scene = 場面(省くと novel。変わるのは、級の文面の段だけ)
  const IV = 3;
  function idioms(o){
    o = o || {};
    if (!Array.isArray(o.list) || !o.list.length) throw util.error('bad', 'prompts.idioms: list が無い');
    const vl = vocabLevel(o.level, o.scene);
    return `あなたは英語学習者向けの英和辞書・語彙解析アシスタントです。
以下の【確定した英文リスト】を読み、英語学習者のために、各英文に含まれる重要熟語・表現を抽出してください。

${vl}

【抽出ルール】
1. 【テキスト実在の絶対制約（Grounding）】:
   抽出する熟語・表現（"w"）は、必ず上記の確定英文（en）の中に書かれている表現（活用形含む）を抜き出してください。英文中に実在しない熟語や、連想された別の表現（例: 英文が単なる "As" なのに勝手に "as a result" を抽出するなど）は重大なエラーです。
2. 単独の平易な基本単語（Hey, go, book等）や単なる名詞・形容詞は抽出不要です。
3. 読者が一目で意味を取りにくい「句動詞」「慣用句」「前置詞を含む定型句」を最優先で抽出してください。
4. 平易な文や特筆すべき表現がない文は、無理に抽出せず空配列 "words": [] にしてください。
5. 各文につき最大2〜3個程度を目安にしてください。
6. 【省略の禁止】: 【確定英文リスト】のすべての id について、id の小さい順に、最後の id まで1つも飛ばさずに出力してください（熟語が無い文も "words": [] として出力します）。途中で「省略」「(TRUNCATED)」のように書いて、出力を終えないでください。
7. 出力形式:
[
  {
    "id": 0,
    "words": [
      { "w": "idiom or phrasal verb", "b": "dictionary form of w", "m": "文脈に即した簡潔な日本語訳" }
    ]
  }
]
   ※ "w" は、英文に書かれている形のまま（活用形も、one's にあたる his・her などもそのまま）出力してください。熟語の途中に、目的語などのほかの語が入っている場合は、その語を書かずに ... でつないでください（例: 英文 Ken switched the heater off. → w "switched ... off"、b "switch off"）。
   ※ "b" は "w" を辞書の見出しの形に直したものです（例: w "gave up on" → b "give up on"、w "set her mind to" → b "set one's mind to"）。
8. Markdownコードブロック等は含めず、純粋なJSON配列のみを出力してください。JSON として正しく読める形にしてください（文字列の値は、必ず " で始めて " で閉じます。文字列の中で " を使うときは \\" と書きます）。

【確定英文リスト】
${JSON.stringify(o.list.map(t => ({ id: t.id, en: t.en, target_jp: t.target_jp })))}`;
  }

  // ---- AI辞書(§6-6)。現行は語だけを聞いていた。新しくは、文を添えて、文脈での意味を聞く ----
  //   q = 聞く語・語句 / en = その英文 / jp = その英文の日本語原文(無ければ、その行を入れない)
  //   scene = 読んでいるものの場面(省くと novel)。場面で変わるのは、「どんなニュアンスを添えるか」の言い方だけ(上の SCENE の dict)
  function dict(o){
    o = o || {};
    const q = String(o.q == null ? '' : o.q).trim(), en = String(o.en == null ? '' : o.en).trim(), jp = String(o.jp == null ? '' : o.jp).trim();
    if (!q) throw util.error('bad', 'prompts.dict: q が無い');
    if (!en) throw util.error('bad', 'prompts.dict: en が無い');
    const sc = sceneOf(o.scene, 'prompts.dict');
    return [
      'あなたは英語学習者向けの英和辞書アシスタントです。',
      '次の英文の中での「' + q + '」の意味を説明してください。',
      '英文: ' + en
    ].concat(jp ? ['この英文の日本語原文: ' + jp] : []).concat([
      '最初に、この文の中での意味を1行で。続けて、品詞、主要な日本語の意味、' + sc.dict + 'があれば簡潔に。全体で60文字〜120文字程度の簡潔な日本語で出力してください。',
      '※「はい」等の挨拶やマークダウン装飾記号（**や*など）は含めず、純粋な説明テキストのみを出力してください。'
    ]).join('\n');
  }

  //   V 7 = 記事の場面の文面を足した(工程8e-2a。小説の文面は v6 と1字も変わらない)
  //   STYLES = 場面ごとの訳の出し方のルール(写し)/ SCENES = 場面の名前の一覧(はじめが、省いたときの場面)
  Yomu.prompts = { V: 7, IV, STYLE: STYLE.slice(), STYLES: { novel: STYLE.slice(), article: ARTICLE_STYLE.slice() }, SCENES: Object.keys(SCENE), level, translate, vocabLevel, idioms, dict };
})();

/* ---- core/wire.js ---- */
// core/wire.js — AI に送る本文の形(部品の約束 §6-2)と、返事の読み取り(§6-3)・返ってきた訳の確かめ(§6-4)
//   build:  1話を段落のまま並べ、訳す文だけを <t id="n">…</t> で囲む(n は、その通信の中の通し番号。sid との対応は map)
//   array:  少しずつ届く JSON の配列を、要素が閉じるたびに1つずつ読む(翻訳と熟語さがしの両方が使う)
//   reader: 翻訳の返事を1文ずつ確かめ、通ったものだけを渡す。通らなかった文は「未訳」(Report.missing)
//   いちばん避けたいのは「別の文の訳が付く」こと。迷ったら、決めつけずに未訳にする(「続きを訳す」で拾える)
//   形を変えたら V を上げる(保存した訳と通信の記録に、どの形で送ったかが残る)
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, T = Yomu.text;
  const bad = msg => util.error('bad', msg);

  const HAN = /\p{sc=Han}/u;             // 漢字(々 を含む)
  const READING = /[\p{L}\p{N}]/u;       // 読みとして意味のあるルビか(傍点の「・」だけのルビは渡さない)
  const TAG = /<(?=t id=|\/t>)/g;        // ページの文章に、たまたま同じ形の印があったとき(< を全角にして、印と取り違えないようにする)
  const MARKS = /[《》｜]/;              // ページの文章そのものに、ルビの印と同じ文字があるか(《スキル名》など)
  const NOT_WORD = /[^\p{L}\p{N}]+/gu;   // 文字と数のほか(記号・空白・ルビの印)
  const neutral = s => String(s).replace(TAG, '＜');
  // 前の文字に付く文字(あとから付く濁点などの印・半角の濁点と半濁点。番号 FF9E・FF9F)
  const JOINS = new RegExp('[\\p{M}' + String.fromCharCode(0xFF9E, 0xFF9F) + ']', 'u');
  // 目印を比べるための形: 全角と半角などをそろえ(NFKC)、文字と数だけを残す。
  //   AI が、目印の記号を落としたり(「――どうして」→「どうして」)、全角の数を半角に直したりしても、合うように
  const canon = s => String(s).normalize('NFKC').replace(NOT_WORD, '');

  const sentsBySid = model => { const m = new Map(); model.sents.forEach(s => m.set(s.sid, s)); return m; };
  function checkModel(model){
    if (!model || !Array.isArray(model.paras) || !Array.isArray(model.sents) || !Array.isArray(model.targets)) throw bad('文のデータがおかしい');
  }
  function checkK(K){
    if (!Number.isInteger(K) || K < -1) throw bad('目印の長さがおかしい: ' + K);
    return K;
  }
  // その文の文字(空白を除く。ルビの印は入っていない)
  const normOf = s => T.norm(neutral(s.text));
  const cut = (s, K) => (K < 0 ? s : s.slice(0, K));

  // そのページで使う、目印の長さ。送る文の目印が、ページのほかの文(送らない文もふくめて)の書き出しにもなっている所があれば、
  //   そうでなくなるまで長くする(config.wire.kMax まで)。reader が「書き出しの合う文が、ページ全体で1つだけ」と言えるようにするため
  //   (2つ以上あると、その場で決められずに待たせることになり、番号だけが頼りになる)。
  //   文字がまるごと同じ文どうしは、数えない(取り違えても、同じ訳)。比べるのは、reader と同じ形(canon)。
  //   短い文が、長い文の先頭にまるごと入っているとき: 長い方の目印は、短い文より長くすれば区別できる。短い方の目印は、どうしても長い文の書き出しになる(数は減らない)。
  //   長くするときは、config.wire.keySlack の分だけ、余分に長くする(AI が、1文字短い目印を返してきても、区別できるように)
  function pickK(norms, page, K){
    const max = config.wire.kMax;
    if (K <= 0 || !(max > K)) return K;
    const whole = page.map(canon);
    const clash = k => {
      let count = 0;
      norms.forEach(nm => { const a = canon(nm.slice(0, k)); whole.forEach((w, j) => { if (page[j] !== nm && w.startsWith(a)) count++; }); });
      return count;
    };
    let best = K, least = clash(K);
    for (let k = K + 1; k <= max && least > 0; k++){ const c = clash(k); if (c < least){ best = k; least = c; } }
    return best > K ? Math.min(max, best + config.wire.keySlack) : best;
  }
  // そのページで使う、終わりの目印の長さ(工程T-4)。送る文の終わりの目印(末尾 E 文字)が、近くの送る文(送る順で前後 config.wire.realign 文まで)の
  //   全文の終わりにもなっている所があれば、そうでなくなるまで長くする(config.wire.eMax まで。長くしたら keySlack の分だけ余分に)。
  //   終わりの目印は、文を決めるのには使わない(決めるのは頭の目印)。AI が、英文を1文先(や後ろ)の文の訳にしたとき、
  //   終わりの目印も、その文のものになる見込み=そのずれに気づけるように、となりの文と見分けがつく長さにする。
  //   日本語の文は「…った。」「…ていた。」で終わるものが多いので、短いと、となりと同じになる。文字がまるごと同じ文どうしは、数えない
  function pickE(norms, E){
    const max = config.wire.eMax, R = config.wire.realign;
    if (!(E > 0) || !(max > E)) return E > 0 ? E : 0;
    const whole = norms.map(canon);
    const clash = e => {
      let count = 0;
      const tails = norms.map(nm => canon(nm.slice(-e)));
      norms.forEach((nm, n) => {
        for (let d = -R; d <= R; d++){
          const m = n + d;
          if (!d || m < 0 || m >= norms.length || whole[m] === whole[n]) continue;
          const L = Math.min(tails[m].length, tails[n].length);
          if (L > 0 && tails[m].slice(-L) === tails[n].slice(-L)) count++;      // 受け取り(endsAt)と同じ比べ方
        }
      });
      return count;
    };
    let best = E, least = clash(E);
    for (let e = E + 1; e <= max && least > 0; e++){ const c = clash(e); if (c < least){ best = e; least = c; } }
    return best > E ? Math.min(max, best + config.wire.keySlack) : best;
  }

  // ---- 送る本文(§6-2) ----
  //   sids = 囲む文(省くと、対象の文の全部)。対象でない文と、無い番号は、囲まない
  //   opt.K = 目印の長さ(省くと config.wire.K。ページに、同じ書き出しの文があれば、長くなる=戻りの K)/ opt.ruby = 'aozora' | 'none'(省くと config.wire.ruby)
  //   opt.E = 終わりの目印の長さ(省くと config.wire.E。0 = 終わりの目印を頼まない。近くの文と終わりが同じなら、長くなる=戻りの E。工程T-4)
  //   → { body, M, map:[sid…], anchors:[目印…], ends:[終わりの目印…], marked:[囲みの中身(ルビの印つき)…] | null, K: 使った目印の長さ, E: 使った終わりの目印の長さ, ruby: ルビの印を入れたか, chars: 囲んだ文の文字数 }
  function build(model, sids, opt){
    opt = opt || {};
    checkModel(model);
    const K0 = checkK(opt.K == null ? config.wire.K : opt.K);
    const E0 = opt.E == null ? config.wire.E : opt.E;
    if (!Number.isInteger(E0) || E0 < 0) throw bad('終わりの目印の長さがおかしい: ' + E0);
    const rubyMode = opt.ruby == null ? config.wire.ruby : opt.ruby;
    if (sids != null && !Array.isArray(sids)) throw bad('文の番号の並びがおかしい');
    const want = new Set(sids == null ? model.targets : sids.map(Number));
    const map = [], norms = [], nOf = new Map();
    let chars = 0, hasRuby = false;
    // 番号は、文書の順に付ける
    model.sents.forEach(s => {
      if (!s.target || !want.has(s.sid) || nOf.has(s.sid)) return;
      const nm = normOf(s);
      nOf.set(s.sid, map.length);
      map.push(s.sid);
      norms.push(nm);
      chars += nm.length;
    });
    const K = pickK(norms, model.sents.map(normOf).filter(nm => canon(nm) !== ''), K0);
    const anchors = norms.map(nm => cut(nm, K));
    const E = pickE(norms, E0);
    const ends = norms.map(nm => (E > 0 ? nm.slice(-E) : ''));
    // ページの文章そのものに 《 》 ｜ があるとき(《スキル名》など)は、ルビの印を付けない(読みと取り違えさせないため)
    const rubyOn = rubyMode === 'aozora' && !model.paras.some(p => MARKS.test(String(p.text)));
    const bySid = sentsBySid(model);
    const lines = [];
    model.paras.forEach(p => {
      const text = neutral(p.text);
      if (!text.trim()) return;                    // 空の段落は詰める(記号だけの段落は、文脈として残す)
      const ins = new Map();                       // 位置 → その前に差し込むもの [順, 文字]
      const add = (pos, rank, s) => { if (!ins.has(pos)) ins.set(pos, []); ins.get(pos).push([rank, s]); };
      (p.sents || []).forEach(sid => {
        const s = bySid.get(sid);
        if (!s || !nOf.has(sid)) return;
        add(s.b, 1, '</t>');
        add(s.a, 2, '<t id="' + nOf.get(sid) + '">');
      });
      if (rubyOn) (p.ruby || []).forEach(r => {
        if (!r || !Number.isInteger(r.a) || !Number.isInteger(r.b) || r.a < 0 || r.b <= r.a || r.b > text.length) return;
        const rt = neutral(r.rt == null ? '' : r.rt).replace(/[《》｜\s]/g, '');
        if (!READING.test(rt)) return;
        add(r.b, 0, '《' + rt + '》');
        // 語の始まりが、漢字の続きだけでは決まらないとき(かなが混ざる・前も漢字)は、語の前に ｜ を置く(青空文庫の書き方)
        const base = text.slice(r.a, r.b);
        const before = Array.from(text.slice(Math.max(0, r.a - 2), r.a)).pop() || '';   // すぐ前の1文字(サロゲートの組でも1文字)
        const plain = Array.from(base).every(ch => HAN.test(ch)) && !HAN.test(before);
        if (!plain) add(r.a, 3, '｜');
        hasRuby = true;
      });
      // 同じ位置では: ルビの読み → 文の終わり → 文の始まり → ルビの語の始まり、の順
      let out = '', at = 0;
      Array.from(ins.keys()).sort((a, b) => a - b).forEach(pos => {
        out += text.slice(at, pos) + ins.get(pos).sort((x, y) => x[0] - y[0]).map(x => x[1]).join('');
        at = pos;
      });
      lines.push(out + text.slice(at));
    });
    const body = lines.join('\n');
    // 文のデータが食いちがっていて、囲めなかった文がある(段落が、その文を持っていない など): 印の無い本文を送らない
    const inner = [];
    body.replace(/<t id="(\d+)">([\s\S]*?)<\/t>/g, (all, n, s) => { inner[Number(n)] = s; return all; });
    if (inner.length !== map.length || (body.match(/<\/t>/g) || []).length !== map.length) throw bad('文のデータが食いちがっている(囲めない文がある)');
    // 囲みの中身(ルビの印つき)。AI が、本文からルビの印ごと写して目印にしてきたときに合わせる。ルビを入れなかったページでは null
    const marked = hasRuby ? inner : null;
    return { body, M: map.length, map, anchors, ends, marked, K, E, ruby: hasRuby, chars };
  }

  // ---- 少しずつ届く JSON の配列(§6-3) ----
  //   配列の直下の { … } が閉じるたびに、onObject(中身) を呼ぶ。JSON として読めない1つは onObject(null)。
  //   読み飛ばすもの: 最初の [ より前の文字(```json など)・中身の無い配列(前置きの [0-1] など)・配列の直下の { } でないもの・余分な }。
  //   opt.resync: 壊れた1つのあとも、次の要素の頭から読み直す(英文の中の " が余っていても、残りを捨てない)。
  //     true = 目印は ,{"id": (翻訳)/ 'words' = 目印は ,{"id": 番号, "words": (熟語さがし。工程T-5b)
  //     熟語さがしは、要素の中に { … } の並びを持つので、"id" だけを目印にすると、AI が中の { … } に "id" を書いたときに取り違える。"words" まで見れば取り違えない
  //   opt.more: 中身のある配列が閉じたあとも、次の配列を読む(熟語さがし。配列が2つに分かれた返事。工程T-5b)。
  //     頼まなければ、中身のある配列が閉じたあとの文字は読まない(翻訳)
  //   end() → { n: 読んだ数, open: 閉じていない1つが残っていたか, closed: 中身のある配列が閉じたか }
  //   id のある1つが、1つも読めなかったときは、end() で、届いた全部を読み直す(配列でなく { … } が並んだ形)
  const RESYNC = { id: /,\s*\{\s*"id"\s*:$/, words: /,\s*\{\s*"id"\s*:\s*"?\d+"?\s*,\s*"words"\s*:$/ };
  function array(onObject, opt){
    const resync = !opt || !opt.resync ? null : opt.resync === 'words' ? RESYNC.words : RESYNC.id;
    const deep = resync === RESYNC.words;                 // 熟語さがしの目印: 1つの外でも探す(下の push)
    const tailMax = deep ? 120 : 40;   // 目印を探すために取っておく、うしろの文字数(熟語さがしの目印は長い。整えて書いた返事は、字下げの空白が入る)
    const more = !!(opt && opt.more);
    let started = false, seen = false, done = false, shut = false, ended = false, depth = 0, inStr = false, esc = false, cur = null, tail = '', n = 0, inThis = 0, ids = 0, all = '', over = false, result = null;
    const hasId = v => util.isPlain(v) && 'id' in v;
    const parse = t => { try { return JSON.parse(t); } catch (e){ return undefined; } };
    const give = v => { n++; inThis++; if (hasId(v)) ids++; onObject(util.isPlain(v) ? v : null); };
    // 配列の形で読めなかった返事を、まるごと読み直す
    function fallback(text){
      // 前後の ``` を除く(後ろは、正規表現を使わない: 長い空白の並びがあると、探すのに時間がかかるため)
      let s = text.trim().replace(/^```[a-zA-Z]*\s*/, '');
      if (s.endsWith('```')) s = s.slice(0, -3).trimEnd();
      const take = v => {
        if (Array.isArray(v)) v.forEach(x => { if (hasId(x)) give(x); });
        else if (util.isPlain(v)){
          if (hasId(v)) give(v);
          else { const k = Object.keys(v).find(key => Array.isArray(v[key])); if (k) take(v[k]); }
        }
      };
      const whole = parse(s);
      if (whole !== undefined){ take(whole); return; }
      // まるごとは読めない: いちばん外側の { … } を、1つずつ取り出して読む(1行に1つずつ・コンマでつないだ形・前置きのあと、でも読める)
      let d = 0, str = false, e = false, from = -1;
      for (let i = 0; i < s.length; i++){
        const ch = s[i];
        if (str){ if (e) e = false; else if (ch === '\\') e = true; else if (ch === '"') str = false; continue; }
        if (ch === '"') str = true;
        else if (ch === '{'){ if (d === 0) from = i; d++; }
        else if (ch === '}' && d > 0){
          d--;
          if (d === 0){ const v = parse(s.slice(from, i + 1)); if (hasId(v)) give(v); }
        }
      }
    }
    return {
      push(text){
        if (ended || typeof text !== 'string') return;
        // id のある1つが読めるまでは、届いた文字を取っておく(上限を超えたら、あきらめる)
        if (ids === 0 && !over){ if (all.length + text.length > config.wire.fallbackMax){ over = true; all = ''; } else all += text; }
        if (done) return;
        for (let i = 0; i < text.length; i++){
          const ch = text[i];
          // 読み直し: 閉じていない1つの中に、次の要素の頭(,{"id": など)が現れた = 壊れている。壊れた1つを捨てて、そこから読み直す。
          //   熟語さがしの目印('words')では、1つの外でも探す(工程T-5b): 欄の名前の " を書き落とすと、文字列の切れ目がずれたまま、
          //   1つが閉じた・配列が閉じたと読み違えて、次の要素の頭を見落とす。正しい返事では、要素の頭の { で1つが始まるので、ここには来ない
          if (resync && (cur !== null || (deep && seen))){
            tail = (tail + ch).slice(-tailMax);
            const m = ch === ':' ? resync.exec(tail) : null;
            if (m){
              if (cur !== null) give(null);
              started = true;
              cur = m[0].slice(m[0].indexOf('{')); tail = ''; depth = 2; inStr = false; esc = false;
              continue;
            }
          }
          if (!started){ if (ch === '['){ started = seen = true; depth = 1; inThis = 0; } continue; }
          if (cur !== null) cur += ch;
          if (inStr){
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"'){ inStr = true; continue; }
          if (ch === '{' || ch === '['){
            if (depth === 1 && ch === '{'){ cur = ch; tail = ch; }
            depth++;
            continue;
          }
          if (ch === '}' || ch === ']'){
            if (depth === 1){
              if (ch === '}') continue;                      // 配列の直下の、余分な } は読み飛ばす
              if (inThis > 0){                               // 中身のある配列が閉じた
                if (!more){ done = true; return; }
                shut = true;                                 // opt.more: 次の [ を探して、続きを読む
              }
              started = false;                               // (中身の無い配列だったときも)次の [ を探す
              continue;
            }
            depth--;
            if (depth === 1 && cur !== null){ const s = cur; cur = null; const v = parse(s); give(v === undefined ? null : v); }
          }
        }
      },
      end(){
        if (!ended){
          ended = true;
          const open = cur !== null;
          cur = null;
          if (ids === 0 && all) fallback(all);
          result = { n, open, closed: done || shut };
        }
        return result;
      }
    };
  }

  // ---- 返ってきた訳の確かめ(§6-4) ----
  // 記号も数えた長さ(全角と半角をそろえ、空白を除く)。目印が、文の終わりを越えていないかを見るのに使う。
  //   前の開きかっこと、後ろの「文を閉じる記号」(。！？…」など)は、数えない(AI が、目印に足してくることがあるため。読点などは数える)
  const OPENERS = /^[「『（(【\[“"‘'＜<《]+/, CLOSERS = /[。．.!！?？…‥」』）)】\]”"’'＞>》〜～♪―—]+$/;
  const rawLen = s => T.norm(String(s).normalize('NFKC')).replace(OPENERS, '').replace(CLOSERS, '').length;
  // 短すぎ・長すぎの物差しにする、文の長さ(§6-4 の順 6〜8): 記号のくり返しは、1 文字と数える(同じ記号が続く所「……」「――」と、！？ の仲間の並び「！？！？」)。
  //   Web 小説は、記号を長く重ねることがある。重ねた分は英語の語にならないので、数えると、自然な訳(「本当ですか！？！？」→ Really?!)が「短すぎ」に見える
  const BANG_RUN = new RegExp('[！？!?' + String.fromCharCode(0x203C, 0x2047, 0x2048, 0x2049, 0xFE0E, 0xFE0F) + ']{2,}', 'g');
  const SAME_RUN = /([^\p{L}\p{N}])\1+/gu;
  const sizeOf = nm => String(nm).replace(BANG_RUN, '！').replace(SAME_RUN, '$1').length;
  // 順 8 の疑いの印(§6-4)。w = 英文の語数・len = 日本語の長さ(sizeOf)→ 's'(短すぎの疑い)/ 'l'(長すぎの疑い)/ null
  //   返ってきた訳を、エンジンが機械で直したとき(core/fix.js)も、同じ決まりで付け直す(wire.flag)
  function flagFor(w, len){
    const C = config.check;
    if (w < len * C.shortFlag) return 's';
    if (w > len * C.longFlag[0] + C.longFlag[1]) return 'l';
    return null;
  }
  const flag = (s, en) => flagFor(T.words(String(en == null ? '' : en).trim()), sizeOf(normOf(s)));

  // ---- まとめ訳を分ける(§6-4 の「まとめ訳を分ける」。工程T-4b)----
  // 日本語の文の数: 。！？ の並び(と、すぐあとの閉じかっこ)で区切った、字のある切れの数。
  //   閉じかっこのすぐあとに と・っ が続く所(「本当！？」と聞いた)は、引用の中の終わりなので、区切らない
  const JP_STOP = /[。！？!?⁉‼]+([」』）)]*)/g;
  const HAS_WORD = /[\p{L}\p{N}]/u;
  function jpCount(t){
    const s = T.norm(neutral(t));
    let n = 0, at = 0;
    JP_STOP.lastIndex = 0;
    for (let m; (m = JP_STOP.exec(s));){
      if (m[1] && /^[とっ]/.test(s.slice(JP_STOP.lastIndex))) continue;
      if (HAS_WORD.test(s.slice(at, m.index))) n++;
      at = JP_STOP.lastIndex;
    }
    if (HAS_WORD.test(s.slice(at))) n++;
    return Math.max(1, n);
  }
  // 英文を文に分ける: . ! ? の並び(と、閉じた引用符・かっこ)のあとに、空白と、大文字・数・開いた引用符が続く所で区切る。
  //   … と ...(点 2 つ以上)では区切らない。Mr. などの略のあとでも区切らない(No. は、返事の「No.」が多いので区切る)。もとの英文の字のまま返す
  const EN_STOP = /([.!?]+|…)(["”’')\]]*)(\s+)(?=["“‘'(]?[A-Z0-9])/g;
  const ABBR = /(?:^|[\s"“‘'(])(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Mt|vs|etc|Mme|Mlle)\.$/;
  function enSentences(en){
    const s = String(en).trim(), out = [];
    let at = 0;
    EN_STOP.lastIndex = 0;
    for (let m; (m = EN_STOP.exec(s));){
      const p = m[1];
      if (p === '…' || /^\.{2,}$/.test(p)) continue;
      if (p === '.' && ABBR.test(s.slice(0, m.index + 1))) continue;
      const end = m.index + p.length + m[2].length;
      out.push(s.slice(at, end));
      at = end + m[3].length;
    }
    out.push(s.slice(at));
    return out.filter(x => x.trim() !== '');
  }
  // まとめ訳 en を、日本語の文の並び jps(本文の順)の 1 つずつに分ける → null(分けない)| [英文…]
  //   英文の文の数が、日本語の文の数の和とちょうど同じときだけ、前から順に、その文の日本語の文の数だけ配る。
  //   長さの釣り合い: 配った英文の字数 ÷ 日本語の長さが、範囲全体の比から config.wire.splitRatio 倍より離れた文があれば、分けない
  //   (日本語が config.wire.splitMin より短い文は、見ない)
  function split(jps, en){
    if (!Array.isArray(jps) || jps.length < 2 || typeof en !== 'string') return null;
    const cnt = jps.map(jpCount), parts = enSentences(en);
    if (parts.length !== cnt.reduce((a, b) => a + b, 0)) return null;
    let i = 0;
    const out = cnt.map(c => { const g = parts.slice(i, i + c).join(' '); i += c; return g; });
    const L = jps.map(t => sizeOf(T.norm(neutral(t)))), Ln = out.map(x => x.length);
    const sumL = L.reduce((a, b) => a + b, 0), sumE = Ln.reduce((a, b) => a + b, 0);
    if (!sumL || !sumE) return null;
    const r = sumE / sumL, Q = config.wire.splitRatio;
    for (let k = 0; k < jps.length; k++){
      if (L[k] < config.wire.splitMin) continue;
      const q = (Ln[k] / L[k]) / r;
      if (!(q <= Q && q >= 1 / Q)) return null;
    }
    return out;
  }
  // 返ってきた目印 → { c, cl, b, bl }。c = 囲みの印を除いて、比べるための形にしたもの / b = ルビの印(｜・《…》・閉じていない 《…)も除いたもの
  //   cl・bl = それぞれの、記号も数えた長さ。文字でなければ null。比べる文字が残らない(記号だけ・空)なら { sym: true }
  //   とても長い目印は、初めの KEY_MAX 文字だけを見る(文より長い目印は、どのみち合わない。長い記号の並びで、時間がかからないように)
  const KEY_MAX = 2000;
  function keyOf(k){
    if (typeof k !== 'string') return null;
    const base = k.slice(0, KEY_MAX).replace(/<\/?t\b[^>]*>/g, '');
    const c = canon(base);
    if (!c) return { sym: true, c: '', cl: 0, b: '', bl: 0 };
    const bare = base.replace(/《[^《》]*》/g, '').replace(/《[^《》]*$/, '').replace(/｜/g, '');
    return { sym: false, c, cl: rawLen(base), b: canon(bare), bl: rawLen(bare) };
  }
  // id は、0 以上の整数(数の形の文字も受ける)。ほかは null。とても大きな数は、番号として扱わない
  function idOf(v){
    if (typeof v === 'string' && /^\d{1,6}$/.test(v.trim())) v = Number(v.trim());
    return Number.isInteger(v) && v >= 0 && v < 1000000 ? v : null;
  }
  // 字の並びの、いちばん長い共通の部分の長さ(両方に、同じ順に入っている字の数。とびとびでよい)。ゆるめた照らし合わせ(工程8e-2a)で使う
  function lcs(a, b){
    const A = Array.from(a), B = Array.from(b), d = new Array(B.length + 1).fill(0);
    for (let i = 1; i <= A.length; i++){
      let prev = 0;
      for (let j = 1; j <= B.length; j++){ const t = d[j]; d[j] = A[i - 1] === B[j - 1] ? prev + 1 : Math.max(d[j], d[j - 1]); prev = t; }
    }
    return d[B.length];
  }
  // かな・漢字の割合(空白を除いた文字のうち)
  function jaShare(s){
    let ja = 0, all = 0;
    for (const ch of s){ if (ch.trim() === '') continue; all++; if (T.hasJa(ch)) ja++; }
    return ja / all;
  }

  //   o = { model, map, marked?, K, E?, onItem }(map・marked・K・E は build の戻り。E を省くと 0 = 終わりの目印を見ない)
  //   onItem({ sid, en, f?, nk? }): 確かめを通った文が来る(f = 疑いの印 's' | 'l')。ふつうは届いた順。決めるのを待たせた文は、決まったときに来る
  //   nk = 1: 目印を1つも返してこない返事で、番号だけで決めた文(返事の終わりに、まとめて来る。rep.suspect が付くのは、この文の返事だけ。v1.7)
  //   → { push(text), end(finish) → Report }
  //
  //   番号の決め方(順 1〜3。くわしくは §6-4):
  //   - 目印は、その文の全文の「先頭」と合うかで比べる(ページの全部の文と。送っていない文もふくめて)
  //   - 書き出しの合う文が、ページ全体でちょうど1つで、それが送った文 → その文に決める(これが「ずれ」の手がかりになる)
  //   - 2つ以上ある → その場では決めずに待たせ、次の手がかりが来たら、前のずれから次のずれへ順にたどって、
  //     どの筋でも同じ文に行き着く文だけを決める。手がかりの間に、捨てた文が1つでもあれば、待たせた文は、まとめて捨てる
  //   - 目印を返している返事の中の、目印の無い文 → 使わない。目印を1つも返してこない返事 → 終わってから、番号どおりに使う
  //   - 短い目印(工程T-4): 頼んだ長さの keyShare 倍に足りなくても、書き出しの合う文がページ全体でちょうど1つで、番号の並び(今のずれ)とも合えば、使う
  //   - 終わりの目印(工程T-4。E > 0 のとき): 文が決まったあとで、"e" が、その文の終わりと合わなければ、使わない(英文が、となりの文の訳になっている疑い)
  function reader(o){
    o = o || {};
    checkModel(o.model);
    if (!Array.isArray(o.map)) throw bad('番号の対応がおかしい');
    if (o.marked != null && (!Array.isArray(o.marked) || o.marked.length !== o.map.length)) throw bad('囲みの中身の数が合わない');
    const K = checkK(o.K);
    const E = o.E == null ? 0 : o.E;
    if (!Number.isInteger(E) || E < 0) throw bad('終わりの目印の長さがおかしい: ' + o.E);
    const onItem = typeof o.onItem === 'function' ? o.onItem : null;
    const map = o.map.slice(), M = map.length;
    const bySid = sentsBySid(o.model);
    const sents = map.map(sid => { const s = bySid.get(sid); if (!s) throw bad('文のデータに無い番号: ' + sid); return s; });
    const norms = sents.map(normOf);
    const lens = norms.map(sizeOf);
    const R = config.wire.realign, C = config.check, MANY = 60;
    // 比べるための形。plain = その文の全文 / mark = 囲みの中身(ルビの印つき。ルビを送らなかったページでは無い)
    const plain = norms.map(canon), mark = o.marked ? o.marked.map(canon) : null;
    // 頼んだ目印の、比べる文字の数。本文には空白も出ているので、空白を除いて切った形と、空白ごと切った形の、短い方で数える。
    //   a = 頼んだ長さで切ったとき / s = それより keySlack 文字短く切ったとき(その 1 文字が、比べる形では 2 文字以上になる字「㍍」もある)。
    //   全文の復唱(K=-1)でも、ふつうの長さ(config.wire.K)で見る(途中までしか返ってこなくても、先頭が合えば使う)
    const kk = K > 0 ? K : config.wire.K, SL = config.wire.keySlack;
    const lensOf = (stripped, shown) => {
      const len = (t, less) => canon(t.slice(0, Math.max(0, Math.min(kk, t.length) - less))).length;
      const x = String(stripped), y = String(shown);
      return { a: Math.min(len(x, 0), len(y, 0)), s: Math.min(len(x, SL), len(y, SL)) };
    };
    const lenP = sents.map((sn, n) => lensOf(norms[n], neutral(sn.text))), lenM = o.marked ? o.marked.map(mk => lensOf(T.norm(mk), mk)) : null;
    // asked = 頼んだ目印の長さ / need = 目印として、少なくとも要る長さ:
    //   - 1 文字(keySlack)短いだけの目印は、いつも足りる
    //   - 文が、頼んだ長さより長いとき(AI が、文字を数えて切る): 頼んだ長さの config.wire.keyShare 倍あれば足りる(6 文字なら 4 文字・13 文字なら 9 文字)。
    //     AI は、文字の数を数えまちがえることがあるので、少しの不足は受ける。半分ほどしか無い目印は、受けない
    //     (1つの文を2つに分けて返してきたときの、前半だけの訳かもしれない)
    //   - 文が、頼んだ長さ以下のとき(目印は、全文のはず)も、同じ割合で見る(全文の長さの keyShare 倍。6 文字の文なら 4 文字)。
    //     工程E1a: 本物の AI(3.5 Flash)が、頼んだ 10 文字ではなく、どの文も 8 文字に切って返し、9〜10 文字の文の、合っている訳が捨てられた
    //   - 最低 1 文字
    const needOf = (whole, len) => Math.max(Math.min(1, whole.length), Math.min(len.s, Math.max(2, Math.ceil(len.a * config.wire.keyShare))));
    const asked = lenP.map(len => len.a), need = lenP.map((len, n) => needOf(plain[n], len)), needM = lenM ? lenM.map((len, n) => needOf(mark[n], len)) : null;
    // 切れ目で、文字の形が変わる所(次の文字が、前の文字に付く濁点など)で切った形。全文の先頭とは合わなくなるので、別に持つ
    //   (半角カナ「ﾊﾞ」の濁点の手前・あとから付く濁点の手前で、目印が切れることがある)
    const oddOf = (text, whole) => {
      const out = [];
      for (let i = 1; i < text.length; i++){
        if (!JOINS.test(text[i])) continue;
        const c = canon(text.slice(0, i));
        if (c && !whole.startsWith(c) && !out.includes(c)) out.push(c);
      }
      return out;
    };
    const odd = norms.map((nm, n) => oddOf(nm, plain[n])), oddM = o.marked ? o.marked.map((mk, n) => oddOf(mk, mark[n])) : null;
    // 目印が、記号だけになりうる文か(頼んだ目印に、比べる文字が、ほとんど無い: 「………………そんな」)
    const symOk = asked.map(a => a <= config.wire.keySlack);
    // その文の目印として、返ってくるはずの長さ(全文の復唱なら、全文)。送っていない文の全文と同じ目印が、これより短ければ、送っていない文の訳
    const wholeKey = K < 0 ? plain.map(p => p.length) : asked;
    // 記号も数えた、全文の長さ。目印が、これより長ければ、その文の目印ではない(2つの文をまとめた訳・後ろの文の目印)
    const full = norms.map(rawLen), fullM = o.marked ? o.marked.map(rawLen) : null;
    // 同じ字ばかりの文(長い叫び声)か: 訳が1語でも、短すぎとは見ない
    const scream = plain.map(p => new Set(Array.from(p)).size <= C.sameMax);
    // ページの文の全文(送っていない文もふくめて)。目印が、その文に頼んだ長さより短く、しかも、ページのほかの文の全文と同じなら、
    //   その「ほかの文」の目印と見る(短い「わかりました」の目印を、長い「わかりました、でも…」の、短く返ってきた目印とは見ない)。
    //   ただし、記号も数えた長さが、その「ほかの文」を越えている目印(「わかりました、」)は、ほかの文の目印ではない
    const pageWhole = new Map();                   // 全文(比べるための形)→ 記号も数えた長さ(同じ形の文のうち、いちばん長いもの)
    o.model.sents.forEach(sn => { const nm = normOf(sn), c = canon(nm); if (c) pageWhole.set(c, Math.max(pageWhole.get(c) || 0, rawLen(nm))); });
    const notMine = (n, c, len) => c.length < wholeKey[n] && pageWhole.has(c) && len <= pageWhole.get(c);
    // 送っていない文(訳さない短いせりふ・もう訳のある文)の全文
    const inMap = new Set(map), whole = new Set(plain), unsent = [], others = new Set();
    o.model.sents.forEach(s => { if (!inMap.has(s.sid)){ const c = canon(normOf(s)); if (c){ unsent.push(c); if (!whole.has(c)) others.add(c); } } });

    const rep = { sent: M, got: 0, missing: [], realigned: 0, mismatch: 0, dup: 0, extra: 0, empty: 0, notEn: 0,
      tooShort: 0, tooLong: 0, flagShort: 0, flagLong: 0, noKey: 0, suspect: 0, shortKey: 0, endMiss: 0, endNear: 0, noEnd: 0, split: 0, splitCut: 0,
      headLoose: 0, endLoose: 0, jaNew: 0, tenths: [], finish: null };
    const filled = new Array(M).fill(false);       // その文に、もう訳が付いたか
    let off = 0;                                   // 番号のずれ(「文の番号 − 返ってきた id」。いちばん近くの手がかりから)
    let keyed = false;                             // この返事が、目印を返しているか
    let dirty = false;                             // 前の手がかりのあとで、捨てた文があるか(その間は、数え方が信じられない)
    let lastId = -1, gap = 0;                      // 前に届いた id(初めは −1 = 返事は id 0 から始まるはず)と、前の手がかりのあとの「id の飛び・戻り」の合計(続き番号なら 0)
    const pending = [];                            // 書き出しの合う文が2つ以上あって、まだ決められない文
    const held = [];                               // 目印の無い文(この返事が目印を返すかどうかが、まだ分からない間)
    const drop = name => { rep[name]++; dirty = true; };

    // ---- 終わりの目印(工程T-4)----
    //   "e" の終わりが、その文の、頼んだ長さの終わりと同じかで比べる(比べる形は頭の目印と同じ canon。AI が、句点やかっこを落とす・足す・頼んだより長く写す・短く写す、のどれでも合う。
    //   長く写したときの前の方の写しまちがいは見ない=sameTail)。ルビを送ったページでは、"e" からルビの印を除いた形でも比べる。
    //   AI が頼んだより短く書き、比べる文字が 2 文字以下の "e"(「た。」)は、手がかりにならないので、比べずに使う(noEnd)。
    //   合わなければ、その文には使わない(endMiss)。そのうち、近くの送った文(送る順で前後 realign 文まで)の終わりと合うもの = endNear(英文が、となりの文の訳になった見込み)。
    //   返事の初めの1件で、この返事が "e" を返すかを決める: 返す返事なら、"e" の無い文は使わない(endMiss)。返さない返事(AI が頼みを聞かなかった)なら、
    //   終わりの目印を見ずに使い、noEnd に数える("e" のある文だけは比べる)。
    //   "e" はあるが、比べる文字が無い(記号だけ・空。「本当ですか！？！？」に「！？」)ときも、比べずに使う(noEnd。何度訳し直しても使えない文を作らない)。記号だけの文も、比べずに使う
    let eMode = null;                              // null = まだ分からない / true = "e" を返す返事 / false = 返さない返事(初めの1件で決める。onObject)
    const endOf = e => {
      if (typeof e !== 'string') return null;
      const base = e.slice(-KEY_MAX).replace(/<\/?t\b[^>]*>/g, '');
      const c = canon(base);
      if (!c) return null;
      return { c, b: canon(base.replace(/《[^《》]*》/g, '').replace(/《[^《》]*$/, '').replace(/^[^《》]*》/, '').replace(/｜/g, '')) };
    };
    // 比べるのは、頼んだ長さの終わり(tailC)の分だけ: "e" と tailC の、短い方の長さで、終わりどうしが同じか。
    //   AI が頼んだより長く写したとき、前の方の写しまちがい(「書かれて」→「書されて」・同じ語を 2 回)では捨てない(工程T-4 の本物の返事)。
    //   ルビを送ったページでは、"e" からルビの印を除いた形(b)でも比べる。頼んだ終わりに、比べる文字が無い文は、比べない(合う)
    const tailC = norms.map(nm => (E ? canon(nm.slice(-E)) : ''));
    const sameTail = (s, n) => { const t = tailC[n]; if (!t) return true; const L = Math.min(s.length, t.length); return L > 0 && s.slice(-L) === t.slice(-L); };
    const endsAt = (n, x) => (plain[n] !== '' && (sameTail(x.c, n) || (mark !== null && x.b !== '' && sameTail(x.b, n))));
    // → 0(使う)/ 1(合わない)/ 2(合わない。近くの送った文の終わりと合う)。比べずに使うときは、ここで noEnd を数える
    function endState(n, it){
      if (!E || plain[n] === '') return 0;
      const x = endOf(it.e);
      if (x === null){
        if (eMode && typeof it.e !== 'string') return 1;   // "e" を返す返事の中の、"e" の無い文
        rep.noEnd++;
        return 0;
      }
      // AI が、頼んだ長さより短く書いた "e" で、比べる文字が 2 文字(config.wire.endMin − 1)以下のもの(「た。」「す」)は、
      //   となりの文と見分ける手がかりにならないので、比べずに使う(工程T-4 の本物の返事: Flash-Lite は、長い話で、終わりの目印を 1〜2 文字しか書かず、
      //   それも前の文の終わりのことが多かった=合っている訳を 25 文捨てた)。頼んだ長さで書いてあれば、記号が多くて比べる文字が少なくても(「すか！？！？」)、比べる
      const shortRaw = Array.from(String(it.e).replace(/\s/g, '')).length < E - config.wire.keySlack;
      if (shortRaw && Math.max(x.c.length, x.b.length) < config.wire.endMin){ rep.noEnd++; return 0; }
      if (endsAt(n, x)) return 0;
      for (let d = -R; d <= R; d++){
        const m = n + d;
        if (d && m >= 0 && m < M && plain[m] !== plain[n] && endsAt(m, x)) return 2;
      }
      return endLoose(n, x) ? 3 : 1;
    }
    // ゆるめた終わりの目印(工程8e-2a。設計メモ 2-2): AI が、終わりの目印を写すとき、言いかえる・1 字まちがえる(「待つ」→「待る」)ことがあり、
    //   英文は正しいのに捨てていた。次の全部がそろえば使う(3 を返す。上で、近くの送った文の終わりと合ったものは、ここに来ない=いつも捨てる):
    //   ① "e" に比べる字が 3 字以上 ② "e" の終わりの字が、その文の終わりの字と同じ
    //   ③ "e" の終わりの字の並び(頼んだ長さ + 2 字まで)のうち、config.wire.endLoose(6 割)以上が、その文の終わりのあたり(+ endPad 字)に順に入っている
    //   ④ 前後 realign 文(送る順)のどの文も、それより近くない(同じくらい近い文があれば、迷うので捨てる=「迷ったら未訳」)。
    //   手本は試作 tools/end_loose_proto.js(工程8e-1。本物の返事で、捨てていた文のうち戻ったものは、部屋が全部読んで、どれも正しい文の訳だった)
    const EL = config.wire.endLoose, EP = config.wire.endPad;
    function endLoose(n, x){
      if (!(EL > 0)) return false;
      const forms = [x.c].concat(mark !== null && x.b && x.b !== x.c ? [x.b] : []);
      return forms.some(c => {
        if (c.length < config.wire.endMin) return false;
        const L = Math.min(c.length, E + 2), t = c.slice(-L);
        const near = m => lcs(t, plain[m].slice(-(L + EP))) / L;
        if (t.slice(-1) !== plain[n].slice(-1)) return false;
        const me = near(n);
        if (me < EL) return false;
        for (let d = -R; d <= R; d++){
          const m = n + d;
          if (d && m >= 0 && m < M && near(m) >= me) return false;
        }
        return true;
      });
    }

    // ---- まとめ訳を分ける(§6-4。工程T-4b)----
    //   "e" が「何かの字 X」+「うしろの文(同じ段落の 1〜splitMax 文。送っていない文もふくむ)の全文」で、X の終わりが、その文の終わりと合う
    //   = AI が、その文から、うしろの文までを、まとめて 1 つの英文にした。英文を、文の数が合えば分けて配る(split)。
    //   X が空(うしろの文だけを写した)なら、分けない: 英文が 1 文先の訳にずれたときと、見分けられない
    const all = o.model.sents, posOf = new Map();
    all.forEach((s, i) => posOf.set(s.sid, i));
    const nOf = new Map(map.map((sid, n) => [sid, n]));
    const spare = new Map();                       // 送った文の番号 → { en: 分けた英文, whole: Set(まとめ訳), nk }(控え。AI が、その文より先へ進んだら使う)
    const lost = new Map();                        // 送った文の番号 → 終わりの目印が合わずに捨てた英文(同じ英文が、うしろの文にも返ってきたときに分ける)
    // → null(分けない)| { p: その文の、ページの文の中の位置, parts: [英文…](その文から、範囲の終わりまで)}
    function spread(n, it){
      const x = endOf(it.e);
      if (x === null || typeof it.en !== 'string') return null;
      const p = posOf.get(map[n]);
      if (p == null) return null;
      const forms = [x.c].concat(mark !== null && x.b && x.b !== x.c ? [x.b] : []);
      const ks = [];
      let tail = '';
      for (let k = 1; k <= config.wire.splitMax; k++){
        const q = all[p + k];
        if (!q || q.p !== all[p].p) break;
        tail += canon(normOf(q));
        if (forms.some(c => c.length > tail.length && c.endsWith(tail) && sameTail(c.slice(0, c.length - tail.length), n))) ks.push(k);
      }
      if (ks.length !== 1) return null;            // 範囲が無い・2 とおりに読める
      const parts = split(all.slice(p, p + ks[0] + 1).map(s => s.text), it.en.trim());
      return parts ? { p, parts } : null;
    }
    // 控えを使う: 送った文の番号が before より前の控えのうち、まだ英文の無い文に(AI が、その文より先へ進んだ・返事が終わった)
    function flush(before){
      Array.from(spare.keys()).sort((a, b) => a - b).forEach(m => {
        if (m >= before) return;
        const sp = spare.get(m);
        spare.delete(m);
        if (!filled[m] && accept(m, sp.en, sp.nk)){ rep.split++; if (sp.nk) rep.noKey++; }
      });
    }

    // n 番目の文として受け取る(順 2・順 4〜8)
    function place(n, it, moved, nk){
      if (filled[n]){ rep.dup++; return; }         // その文には、もう訳が付いている(先のものを使う)
      const whole = typeof it.en === 'string' ? it.en.trim() : '';
      // まとめ訳を分けた範囲の文に、AI が、まとめ訳とまったく同じ英文を返してきた(同じ英文を 2 つの文に付けた形): 控え(分けた英文)を使う
      const sp = spare.get(n);
      if (sp && sp.whole.has(whole)) return;
      const es0 = endState(n, it);                 // 3 のあと. 終わりの目印が、その文の終わりと合うか(工程T-4)
      const loose = es0 === 3, es = loose ? 0 : es0;   // 3 = ゆるめた照らし合わせで合った(工程8e-2a。使う)
      // 前の文(同じ段落の splitMax 文まで)に返して、終わりの目印が合わずに捨てた英文と、まったく同じ英文(同じ英文を 2 つの文に付けた形。
      //   前の文の終わりの目印には、範囲が写っていなかった): 2 つの文の間を範囲として分ける。分けられなければ、この文にも使わない(2 つとも未訳)
      if (!es && whole){
        const at = sameAs(n, whole);
        if (at){
          if (!at.parts){ rep.dup++; return; }
          at.parts.slice(0, -1).forEach((x, i) => {
            const m = nOf.get(all[at.p + i].sid);
            if (m == null || filled[m]){ rep.splitCut++; return; }
            if (accept(m, x, nk)) rep.split++;
          });
          if (moved) rep.realigned++;
          if (accept(n, at.parts[at.parts.length - 1], nk)) rep.split++;
          return;
        }
      }
      // "e" に、うしろの文までのまとめた範囲が写っていれば、分ける(終わりが、その文の終わりと合っても=同じ文が 2 つ並ぶとき)
      const sd = E ? spread(n, it) : null;
      if (es && !sd){
        rep.endMiss++;
        if (es === 2) rep.endNear++;
        if (whole) lost.set(n, whole);
        return;
      }
      let en = it.en;
      if (sd){
        en = sd.parts[0];
        sd.parts.slice(1).forEach((x, i) => {
          const m = nOf.get(all[sd.p + 1 + i].sid);
          if (m == null || filled[m]){ rep.splitCut++; return; }   // 送っていない文・もう英文のある文の分は、捨てる
          if (spare.has(m)){ spare.get(m).whole.add(whole); rep.splitCut++; return; }   // ほかのまとめ訳の控えがある(先のものを使う)
          spare.set(m, { en: x, whole: new Set([whole]), nk });
        });
      }
      if (moved) rep.realigned++;
      if (accept(n, en, nk)){
        if (sd) rep.split++;
        else if (loose) rep.endLoose++;
      }
    }
    // その文より前(同じ段落の、本文の順で splitMax 文まで)の送った文に返して捨てた英文と、同じ英文か → null | { p: 範囲の始まりの位置, parts: [英文…] | null }
    function sameAs(n, whole){
      const p = posOf.get(map[n]);
      if (p == null) return null;
      for (let k = 1; k <= config.wire.splitMax; k++){
        const q = all[p - k];
        if (!q || q.p !== all[p].p) return null;
        const m = nOf.get(q.sid);
        if (m != null && lost.get(m) === whole) return { p: p - k, parts: split(all.slice(p - k, p + 1).map(s => s.text), whole) };
      }
      return null;
    }
    // 順 4〜8 を通して、使う → true(使った)/ false(捨てた。数えた)
    function accept(n, raw, nk){
      // 4. 空でない文字か(語が1つも無いもの「...」も、空として扱う)
      const en = typeof raw === 'string' ? raw.trim() : '';
      const w = T.words(en);
      if (!w){ rep.empty++; return false; }
      // 5. 日本語のままでないか
      if (jaShare(en) > C.jaMax){ rep.notEn++; return false; }
      // 5 の足し. 英文の中に、その文の原文に無いかな・漢字が無いか(工程8e-2a。設計メモ 2-2): AI が作り出した字は、写しまちがいか作り話なので、その文には使わない
      //   (2026-10-17 実物のカクヨム: 「エリクは…」→ "E里克, you really …"。割合の確かめ jaMax では拾えない)。原文にある字をそのまま残した形(看板の字など)は、今までどおり使う
      if (jaNew(en, n)){ rep.jaNew++; return false; }
      // 6・7. 短すぎないか・長すぎないか(語数と、日本語の文字数の比。短すぎは、切り捨てた数と比べる。叫び声のような文は、見ない)
      const len = lens[n];
      if (len >= C.minLen && !scream[n] && w < Math.floor(len * C.shortDrop)){ rep.tooShort++; return false; }
      if (w > len * C.longDrop[0] + C.longDrop[1]){ rep.tooLong++; return false; }
      // 8. 疑いの印(捨てない)
      const item = { sid: map[n], en };
      if (nk) item.nk = 1;
      const fl = flagFor(w, len);
      if (fl === 's'){ item.f = 's'; rep.flagShort++; }
      else if (fl === 'l'){ item.f = 'l'; rep.flagLong++; }
      filled[n] = true;
      rep.got++;
      if (onItem) onItem(item);
      return true;
    }
    // 英文の中の、その文の原文に無いかな・漢字(5 の足し)。原文は、その文の字とルビの読み(全角と半角などをそろえて=NFKC)
    const srcJa = sents.map((sn, n) => new Set(Array.from((norms[n] + (o.marked ? o.marked[n] : '')).normalize('NFKC'))));
    const jaNew = (en, n) => Array.from(en.normalize('NFKC')).some(ch => T.hasJa(ch) && !srcJa[n].has(ch));
    // その文の書き出しか: 全文の先頭になっている、または、切れ目で文字の形が変わる所で切った形と同じ
    const own = (n, c) => plain[n].startsWith(c) || odd[n].includes(c);
    const ownM = (n, c) => mark[n].startsWith(c) || oddM[n].includes(c);
    // 書き出しが合うか(広い見方): 長さの条件は見ない。ルビの印を除いた形 b で比べるのは、ルビを送ったページだけ。
    //   記号だけの目印は、「目印が記号だけになりうる文」と合う
    const starts = (n, key) => (key.sym ? symOk[n] : own(n, key.c) || (mark !== null && (ownM(n, key.c) || (key.b !== '' && own(n, key.b)))));
    // 目印が合うか(きびしい見方): 書き出しが合い、要る長さ(lo・ルビの印つきの形は loM)以上あり、文の終わりを越えていない
    //   (全文より長い目印=2つの文をまとめた訳・後ろの文の目印、は合わない)
    const hitAt = (n, key, lo, loM) => (key.sym ? symOk[n] :
      (key.c.length >= lo && key.cl <= full[n] && own(n, key.c) && !notMine(n, key.c, key.cl)) ||
      (mark !== null && key.c.length >= loM && key.cl <= fullM[n] && ownM(n, key.c) && !notMine(n, key.c, key.cl)) ||
      (mark !== null && key.b !== '' && key.b.length >= lo && key.bl <= full[n] && own(n, key.b) && !notMine(n, key.b, key.bl)));
    const hit = (n, key) => hitAt(n, key, need[n], mark !== null ? needM[n] : 0);
    // 短い目印(工程T-4): 要る長さを config.wire.keyMin 文字まで下げて見る。文を閉じる記号(。！？ と、1つだけの .)で終わる目印は、受けない
    //   (1つの文を2つに分けて返してきたときの、前半「そうか。」の目印かもしれない。途中に 。 のある目印「うそつけ。靴ひ」は受ける)。
    //   終わりのかっこと空白は除いて見る。…… と ... は、文を閉じる記号に数えない。使うのは、書き出しの合う文がページ全体で1つで、番号の並びと合うときだけ(onObject)
    const KMIN = config.wire.keyMin;
    const endsStop = raw => { const t = String(raw).replace(/[\s」』）)】\]”’"'》〉]+$/u, ''); return /[。．｡！？!?]$/.test(t) || /(^|[^.])\.$/.test(t); };
    const hitShort = (n, key, raw) => !key.sym && !endsStop(raw) && hitAt(n, key, Math.min(KMIN, need[n]), mark !== null ? Math.min(KMIN, needM[n]) : 0);
    // 送っていない文の中に、書き出しの合うものがあるか
    const outside = key => key.sym || unsent.some(u => u.startsWith(key.c) || (mark !== null && key.b !== '' && u.startsWith(key.b)));
    // ゆるめた頭の目印(工程8e-2a。設計メモ 2-2): AI が、頭の目印を写すとき、1 字まちがえる・言いかえる(「待つことが」→「待ることが」)ことがあり、
    //   英文は正しいのに捨てていた(同じ文が、何度送っても同じまちがいで捨てられ、「続きを訳す」でも拾えなかった)。
    //   書き出しの合う文が、どこにも無い目印(送っていない文にも)で、番号の並び(id + 今のずれ)の指す文 j の書き出し(頼んだ長さ)と、
    //   字の並びの config.wire.headLoose(7 割)以上が合い、ページのほかのどの文(送っていない文もふくめて)より headGap(1.5 割)以上はっきり合うなら、j に決める。
    //   比べるのは、目印の初めの「頼んだ長さ + 2 字」まで(長く写した目印のうしろは見ない)。割合は、長い方の字の数で割る。
    //   手本は試作 tools/head_loose_proto.js(工程8e-1。本物の返事で、捨てていた文のうち戻ったものは、部屋が全部読んで、どれも正しい文の訳だった)
    const HL = config.wire.headLoose, HG = config.wire.headGap;
    const headOf = nm => (K > 0 ? canon(nm.slice(0, K)) : '');
    const headC = norms.map(headOf);
    const pageCanon = o.model.sents.map(s => ({ sid: s.sid, c: canon(normOf(s)) })).filter(x => x.c !== '');
    //   使わないもの: 記号も数えた長さが、その文の全文より 2 字以上長い目印(うしろの文まで写した目印「歌のうまかった子だよ。覚えてる」=2 つの文をまとめた訳。
    //   1 字だけ長いのは受ける=写しまちがいで字が 1 つ増えた「知っているんですか!?」→ 知ってるんですか!?)。
    //   頼んだより長く写して、頼んだ長さのうしろで写しまちがえた目印(「ミオはかばんを肩にかくだ」)も、ここで受ける(今までは、目印のまるごとが書き出しと合わないので捨てていた)
    function headLoose(j, key){
      if (!(HL > 0) || K <= 0 || !headC[j]) return false;
      const forms = [[key.c, key.cl]].concat(mark !== null && key.b && key.b !== key.c ? [[key.b, key.bl]] : []);
      return forms.some(([c0, len]) => {
        if (len > full[j] + config.wire.keySlack) return false;
        const c = c0.slice(0, K + 2), L = Math.max(c.length, headC[j].length);
        const like = w => { const h = w.slice(0, L); return lcs(c, h) / Math.max(c.length, h.length); };
        const me = like(plain[j]);
        if (me < HL) return false;
        return pageCanon.every(x => x.sid === map[j] || like(x.c) <= me - HG);
      });
    }

    // 待たせていた文を決める(次の手がかりが来たとき・返事が終わったとき)。
    //   off = 前の手がかりでのずれ / end = 次の手がかりでのずれ
    //   その間で、ずれが変わるわけは2つ: 文が飛ばされて番号が詰まった(ずれ +1)・よけいな文がはさまった(ずれ −1)。
    //   どこで変わったかの見立てを全部ためして、どの見立てでも同じ文に行き着く文だけを決める。見立てが1つも立たなければ、まとめて捨てることになる
    function settle(end){
      const list = pending.splice(0), spoiled = dirty, g = gap, N = list.length;
      dirty = false;
      gap = 0;
      const giveUp = () => { rep.mismatch += N; };
      // 決められないとき: 手がかりの間に、捨てた文がある・ずれの幅が大きすぎる(返事の最初の id が 0 でないときは、その分も「id の飛び」に数えている)
      const lo = Math.min(off, end) - g, hi = Math.max(off, end) + g;
      if (spoiled || hi - lo > R) return giveUp();
      // 送っていない文とも書き出しの合う文(= よけいな文かもしれない)が待っていて、しかも、数え方がずれている: 「飛ばされただけ」とは言えないので、あきらめる。
      //   数え方がずれていなければ、そのまま使う(正しい返事を捨てないため。送っていない文の訳が、同じ書き出しの文の代わりに、同じ番号で来たら、見分けられない)
      if ((end > off || g > 0) && list.some(p => p.out)) return giveUp();
      const at =(p, d) => { const j = p.id + d; return j >= 0 && j < M && hit(j, p.key) ? j : -1; };
      // id が、続き番号で届いていない(飛んだ・戻った): その間で、ずれが行って戻ったかもしれない。よけいな文がはさまっているなら、あきらめる。
      //   そうでなければ、飛びの分だけ幅を広げて見て、行き着く文がちょうど1つで、ほかの文とぶつからない文だけを決める(並びからの推しはかりは、しない)
      if (g > 0){
        if (end < off) return giveUp();
        const dests = list.map(p => {
          const dest = [];
          for (let d = lo; d <= hi; d++){ const j = at(p, d); if (j >= 0) dest.push(j); }
          return dest.length === 1 ? dest[0] : -1;
        });
        list.forEach((p, i) => {
          const j = dests[i];
          if (j < 0 || dests.indexOf(j) !== dests.lastIndexOf(j)){ rep.mismatch++; return; }
          place(j, p.it, j !== p.id);
        });
        return;
      }
      // よけいな文が e 件はさまっている(ずれが減った): どの e 件がよけいかは、目印からは分からないことがある。
      //   「どれがよけいか」の決め方を全部ためして、どの決め方でも「よけいでなく、同じ文に行き着く」文だけを決める
      if (end < off){
        const e = off - end;
        if (e > 2 || e > N || (e === 2 && N > MANY)) return giveUp();
        const seen = list.map(() => []);            // 文ごとの、行き着いた先(−1 = よけいな文とした)
        const tryIt = extras => {
          const dest = [];
          let before = 0;
          for (let i = 0; i < N; i++){
            if (extras.includes(i)){ dest.push(-1); before++; continue; }
            const j = at(list[i], off - before);
            if (j < 0) return;
            dest.push(j);
          }
          dest.forEach((j, i) => { if (!seen[i].includes(j)) seen[i].push(j); });
        };
        for (let a = 0; a < N; a++){
          if (e === 1) tryIt([a]); else for (let b = a + 1; b < N; b++) tryIt([a, b]);
        }
        list.forEach((p, i) => { if (seen[i].length === 1 && seen[i][0] >= 0) place(seen[i][0], p.it, seen[i][0] !== p.id); else rep.mismatch++; });
        return;
      }
      // 文が飛ばされて、番号が詰まった(ずれが増えた)か、変わっていない: 「届いた順に、ずれが off から end へ進む」並びを全部考える
      const D = [];
      for (let d = off; d <= end; d++) D.push(d);
      // H[i] = その文が取りうる「ずれ」(D の中の位置)
      const H = list.map(p => D.map((d, x) => x).filter(x => at(p, D[x]) >= 0));
      // F[i] = 前から見て取りうるもの・B[i] = 後ろから見て取りうるもの・両方にあるもの = 通しの並びが有るもの。
      //   通しの並びが1つも無ければ、全部空になる(どれか1文が行き着けないと、前も後ろも空になるため)
      const F = [], B = [];
      for (let i = 0; i < N; i++) F[i] = i === 0 ? H[i] : H[i].filter(x => x >= Math.min.apply(null, F[i - 1]));
      for (let i = N - 1; i >= 0; i--) B[i] = i === N - 1 ? H[i] : H[i].filter(x => x <= Math.max.apply(null, B[i + 1]));
      list.forEach((p, i) => {
        const P = F[i].filter(x => B[i].includes(x));
        if (P.length !== 1){ rep.mismatch++; return; }
        const j = p.id + D[P[0]];
        place(j, p.it, j !== p.id);
      });
    }

    function onObject(it){
      if (it && eMode === null) eMode = typeof it.e === 'string';   // この返事が、終わりの目印を返すか(初めの1件で決める)
      let key = it && K !== 0 ? keyOf(it.k) : null;
      // この返事は、目印を返している(id の読めない1件でも、目印があれば、そう見る)。それまでの、目印の無い文は使わない
      if (key !== null && !key.sym && !keyed){ keyed = true; if (held.length){ rep.mismatch += held.length; held.length = 0; dirty = true; } }
      // 1. id が数か(JSON として読めなかった1つも、ここ)
      const id = it ? idOf(it.id) : null;
      if (id === null) return drop('extra');
      gap += Math.abs(id - lastId - 1);
      lastId = id;
      // 記号だけの目印: 見込んだ位置の近くに「目印が記号だけになりうる文」が無ければ、目印の無い1件として扱う
      if (key !== null && key.sym && !symOk.some((ok, n) => ok && Math.abs(n - (id + off)) <= R)) key = null;
      if (key === null){
        if (K === 0){ if (id >= M) rep.extra++; else place(id, it, false); return; }      // 目印なしで送った: 確かめられるのは、番号だけ
        // 目印が返ってこなかった。目印を返している返事なら、確かめられないので使わない(番号がずれている最中かもしれない)
        if (keyed) drop('mismatch'); else held.push({ id, it });
        return;
      }
      // 3. 書き出しの合う文を、ページ全体から探す。S = 送った文のうち、目印がきちんと合うもの / wide = 送った文のうち、書き出しが合うものの数
      const S = [];
      let wide = 0, wideAt = -1;
      for (let n = 0; n < M; n++){ if (starts(n, key)){ wide++; wideAt = n; if (hit(n, key)) S.push(n); } }
      const out = outside(key);
      // 送っていない文の全文と同じ目印で、合う文が無い(合う文に頼んだ長さより短い): 送っていない文の訳を返してきた
      if (others.has(key.c) && !S.length) return drop('extra');
      // 短い目印(工程T-4): 書き出しの合う文が、ページ全体でちょうど1つで、それが送った文で、番号の並び(今のずれ)とも合う。
      //   AI が、頼んだ長さより短く書いてきた(工程T-3 の本物の返事で、277 文のうち 163 文)。手がかりにもする(ずれは変わらない)
      if (!S.length && wide === 1 && !out && wideAt === id + off && hitShort(wideAt, key, it.k)){
        rep.shortKey++;
        settle(off);
        flush(wideAt);                             // AI が、この文まで進んだ: それより前の控え(まとめ訳を分けた分)を使う
        place(wideAt, it, wideAt !== id);
        return;
      }
      // ゆるめた頭の目印(工程8e-2a): 書き出しの合う文がどこにも無い目印で、番号の並びの指す文と、はっきり似ている。手がかりにもする(ずれは変わらない=短い目印と同じ)
      if (!S.length && !wide && !out && !others.has(key.c) && id + off >= 0 && id + off < M && headLoose(id + off, key)){
        const j = id + off;
        settle(off);
        flush(j);
        const before = rep.got;
        place(j, it, j !== id);
        if (rep.got > before) rep.headLoose++;
        return;
      }
      if (!S.length) return drop(id >= M || (out && !wide) ? 'extra' : 'mismatch');
      if (S.length === 1 && wide === 1 && !out){
        // 書き出しの合う文が、ページ全体でちょうど1つ: その文に決まる(どれだけ離れていても)。ずれの手がかりになる。
        const next = S[0] - id;
        settle(next);
        off = next;
        flush(S[0]);                               // AI が、この文まで進んだ: それより前の控え(まとめ訳を分けた分)を使う
        place(S[0], it, S[0] !== id);
        return;
      }
      // 2つ以上(送っていない文もふくめて): ずれを見込んだ位置の近くに、合う文があれば、次の手がかりが来るまで待たせる
      const c = id + off;
      if (S.some(j => Math.abs(j - c) <= R)) pending.push({ id, key, it, out }); else drop('mismatch');
    }

    const arr = array(onObject, { resync: true });
    let ended = false;
    return {
      push(text){ if (!ended) arr.push(text); },
      // finish = 終わり方('stop'|'length'|'blocked'|'other'|'abort'|'drop'|'error')。閉じていない最後の1つは捨てる
      end(finish){
        if (!ended){
          ended = true;
          // 返事が、最後まで届いたか(ふつうに終わった・配列が閉じた)
          const complete = arr.end().closed || finish === 'stop';
          // 待たせたままの文: このあとに手がかりは来ない。最後まで届いた返事なら「最後の1件は、最後の文」が手がかりになる。
          //   途中で切れた返事では、決めつけずに捨てる(待たせた文のまとまりの中で飛ばされたかもしれない)
          if (pending.length){
            if (complete) settle((M - 1) - pending[pending.length - 1].id);
            else { rep.mismatch += pending.length; pending.length = 0; }
          }
          // 目印を1つも返してこない返事: 捨てずに、番号どおりに使う。番号のずれは確かめられない(K=0 と同じ)
          if (!keyed && held.length){
            const ids = held.map(h => h.id), noZero = !ids.includes(0);
            const d = noZero && ids.includes(M) ? -1 : 0;            // id が 1〜M なら、1 から数えたものと見る
            if (noZero && d === 0) rep.suspect = 1;                  // 0 が無い: 先頭を飛ばしたのか、1 から数えたのか、分からない
            held.splice(0).forEach(h => {
              const n = h.id + d;
              if (n >= M){ rep.extra++; return; }
              const before = rep.got;
              place(n, h.it, false, true);
              if (rep.got > before) rep.noKey++;
            });
          }
          flush(Infinity);                           // 残った控え(まとめ訳を分けた、うしろの文の分)を使う
          rep.missing = map.filter((sid, n) => !filled[n]);
          // 位置ごと(10等分。文が 10 より少なければ、文の数だけ)の、使えた割合
          const B = Math.min(10, M), tot = new Array(B).fill(0), ok = new Array(B).fill(0);
          for (let n = 0; n < M; n++){ const b = Math.floor(n * B / M); tot[b]++; if (filled[n]) ok[b]++; }
          rep.tenths = tot.map((t, b) => Math.round(ok[b] / t * 100) / 100);
          rep.finish = typeof finish === 'string' && finish ? finish : null;
          // 目印の無い返事が、最後まで届いたのに、終わりの方だけ抜けている = 途中で1文飛ばして、番号を詰めた疑い
          //   (目印が無いので、どこからずれたかは分からない。使うかどうかは、呼んだ側が決める)
          const tail = rep.missing.length > 0 && filled.indexOf(false) === M - rep.missing.length;
          if (rep.noKey > 0 && complete && tail) rep.suspect = 1;
        }
        return util.clone(rep);
      }
    };
  }

  Yomu.wire = { V: 2, build, array, reader, idOf, canon, flag, split };   // V 2 = 返事に終わりの目印 "e"(工程T-4)
})();

/* ---- core/fix.js ---- */
// core/fix.js — 返ってきた訳の、機械の直し(部品の約束 §6-4 の「機械の直し」。工程T-2c。設計メモ 2-3)
//   指示文で直そうとすると、別の所がくずれた取りこぼしを、エンジンの側で直す(2026-10-16 利用者と決めた 3 つ):
//   ① title: さん・君・ちゃん(のばした形も)の人に付いた Mr.・Mrs.・Ms.・Miss を外す。
//      その文の日本語に「様」など、英語の敬称に当たる語もあるときは、さん・君・ちゃんの付いた名前と音が合い、様などの付いた名前と音が合わない敬称だけを外す
//      (「お嬢様ー！　ハロルドさーん！」→ Young lady! Mr. Harold! の Mr. だけ。音が合うか分からない名前=漢字の名前などは、触らない)
//   ② quote: せりふだけの文(「」が文の外)の英文が、まるごと二重引用符で囲まれていたら、外側の引用符を外す(日本語の側に 『』 などがある文は、触らない)。
//      片側だけの引用符(頭だけ・終わりだけ。英文の中の二重引用符が 1 つだけで、端にある)も外す(工程T-6。日本語の中に 『』 などがあれば、触らない)
//   ③ pair: 同じ段落で、間に字の無いとなりの文どうし(どちらも、この通信で送った文)で、
//      後ろの英文が、前の英文の後ろにまるごと入っていたら、前の方から切る(文の切れ目で、3 語以上が、そっくり同じとき)。
//      2 つの英文が同じ(両方の訳が入った形。英文が 2 文以上)なら、文の数が合えば分ける(wire.split。工程T-4b。2026-10-16 利用者の OK)。
//      分けられなければ、2 つとも未訳に戻す(2026-10-16 利用者。「続きを訳す」で拾える)。
//      日本語でも重なっている(せりふのくり返し)ときは、触らない
//   迷ったら、直さない(正しい英文を壊さない)。直したら、疑いの印 f を、直したあとの英文で付け直す(wire.flag)
//   stream: 届いた順の訳に、上の 3 つを当てて、呼んだ側へ渡す。③のために、前の文は、となりの文が届くまで渡すのを待つ
//   (待つのは、となりの文も送っていて、まだ届いていないときだけ。返事が終わったら、待っていた文を全部渡す)
(function(){
  'use strict';
  const util = Yomu.util, T = Yomu.text, wire = Yomu.wire;
  const ch = String.fromCharCode;
  // 全角のかっこ・長音などは、番号で作る(書く道具が、半角に変えることがあるため。engine/README.md の「書くときの注意」)
  const QUOTE_JP = ch(0x300C, 0x300D, 0x300E, 0x300F, 0xFF08, 0xFF09);          // 「」『』（）
  const LONG = ch(0x30FC, 0x301C, 0xFF5E);                                       // ー 〜 ～
  const DQ_OPEN = '"' + ch(0x201C), DQ_CLOSE = '"' + ch(0x201D);                 // " “ / " ”
  const NAME_CH = '[\\p{sc=Katakana}\\p{sc=Han}' + ch(0x3005) + LONG + ']';     // 名前になる字(カタカナ・漢字・々・長音)
  // さん・くん・君・ちゃん(のばした形も: さーん・さぁん・ちゃーん)
  const HON = 'さ[ぁあ' + LONG + ']*ん|く[ぅう' + LONG + ']*ん|君|ち[ゃャ][ぁあ' + LONG + ']*ん';
  const HON_RE = new RegExp('(' + NAME_CH + '+?)(?:' + HON + ')', 'gu');
  // 名前ではない語の、さん・君(皆さん・お父さん・奥さん・パン屋さん・お客さん・主君 など)。その語の最後の字で見る
  const NOT_NAME = new Set(Array.from('皆父母兄姉奥爺婆坊嬢屋者員手長主方神客隣子諸'));
  // 英語の敬称に当たる語(この語の付いた人には、Mr. などが正しい=設計メモ 2-3 の「様」)
  const SAMA_RE = new RegExp('(' + NAME_CH + '+?)(?:様|さま|殿|氏|卿|先生|夫人|嬢)', 'gu');
  const SAMA_ANY = /様|殿|氏|卿|先生|夫人|閣下|陛下|殿下|ミスター|ミセス|ミズ|Mr|Mrs|Ms|Miss/;
  const TITLE_RE = /\b(?:Mr|Mrs|Ms|Miss|Mister)\.?\s+(?=([A-Z][A-Za-z'’-]*))/g;

  // ---- 名前の音を、子音の並びにして比べる(粗い。合わなければ、触らない)----
  const KANA_C = {};
  [['カキクケコ', 'k'], ['ガギグゲゴ', 'g'], ['サシスセソ', 's'], ['ザジズゼゾヂヅ', 'z'], ['タチツテト', 't'], ['ダデド', 'd'], ['ナニヌネノ', 'n'], ['ン', 'n'],
    ['ハヒフヘホ', 'h'], ['バビブベボヴ', 'b'], ['パピプペポ', 'p'], ['マミムメモ', 'm'], ['ラリルレロ', 'r'], ['ワヰヱヲ', 'b']].forEach(([ks, c]) => Array.from(ks).forEach(k => { KANA_C[k] = c; }));
  const dedupe = s => s.replace(/(.)\1+/g, '$1');
  const kanaSkel = name => dedupe(Array.from(name).map(k => KANA_C[k] || '').join(''));
  const enSkel = name => dedupe(String(name).toLowerCase().replace(/ph/g, 'h').replace(/ck/g, 'k').replace(/([^aeiouy])h/g, '$1')
    .replace(/[aeiouy'’-]/g, '').replace(/l/g, 'r').replace(/[vw]/g, 'b').replace(/f/g, 'h').replace(/[cq]/g, 'k').replace(/j/g, 'z').replace(/x/g, 'ks'));
  const isKana = name => /^[\p{sc=Katakana}ー]+$/u.test(name.replace(new RegExp('[' + LONG + ']', 'g'), 'ー'));
  function namesOf(jp, re, skip){
    const out = [];
    re.lastIndex = 0;
    for (let m; (m = re.exec(jp));){
      const name = m[1];
      if (skip && NOT_NAME.has(name[name.length - 1])) continue;
      out.push(name);
    }
    return out;
  }

  // ① さん・君・ちゃんの人に付いた敬称を外す → { en, n }(n = 外した数)
  function title(jp, en){
    jp = String(jp == null ? '' : jp); en = String(en == null ? '' : en);
    const hon = namesOf(jp, HON_RE, true);
    if (!hon.length || /\bMr\.?\s+and\s+Mrs\b/.test(en)) return { en, n: 0 };   // Mr. and Mrs. Smith の形は、触らない(片方だけ外すと、くずれる)
    const mixed = SAMA_ANY.test(jp) || /さま/.test(jp.replace(/さまざま|ありさま|すさま/g, ''));
    const honSk = hon.filter(isKana).map(kanaSkel).filter(Boolean);
    const samaSk = namesOf(jp, SAMA_RE, false).filter(isKana).map(kanaSkel).filter(Boolean);
    let n = 0;
    TITLE_RE.lastIndex = 0;
    const out = en.replace(TITLE_RE, (m, name) => {
      if (mixed){
        const sk = enSkel(name);
        if (!sk || !honSk.includes(sk) || samaSk.includes(sk)) return m;   // さんの人と音が合わない・様の人と音が合う: 触らない
      }
      n++;
      return '';
    });
    return { en: n ? out.replace(/ {2,}/g, ' ').trim() : en, n };
  }

  // ② せりふだけの文の、外側の引用符を外す → { en, n }(n = 1 外した / 0)
  function quote(sent, en){
    en = String(en == null ? '' : en);
    if (!sent || !sent.q) return { en, n: 0 };
    const jp = String(sent.text || '').trim();
    if (!jp || QUOTE_JP.includes(jp[0]) || QUOTE_JP.includes(jp[jp.length - 1])) return { en, n: 0 };   // 日本語の側の記号(『帳面の文』など)に当たる引用符かもしれない
    const e = en.trim();
    const one = oneSide(jp, e);
    if (one != null) return { en: one, n: 1 };
    if (e.length < 3 || !DQ_OPEN.includes(e[0])) return { en, n: 0 };
    let tail = '', body = e.slice(1);
    if (/[.!?]$/.test(body) && DQ_CLOSE.includes(body[body.length - 2])){ tail = body[body.length - 1]; body = body.slice(0, -1); }
    if (!DQ_CLOSE.includes(body[body.length - 1])) return { en, n: 0 };
    body = body.slice(0, -1);
    if (/["“”]/.test(body) || !/[\p{L}\p{N}]/u.test(body)) return { en, n: 0 };   // 中にも引用符がある("A," he said, "B.")・中身が無い
    body = body.trim();
    if (tail && !/[.!?…]$/.test(body)) body += tail;
    return { en: body, n: 1 };
  }
  // ② の続き(工程T-6): 片側だけの引用符(頭だけ・終わりだけ)を外す → 外した英文 / null(触らない)
  //   1 つの「」の中の 2 文を、AI が 1 つの引用のように書き、頭の文に開き、終わりの文に閉じだけが付いた形(準2級の t3-5 で 10 か所)。
  //   英文の中の二重引用符が、ちょうど 1 つで、端にあるときだけ。日本語の中に 『』（） があれば触らない(その記号に当たる引用符かもしれない)
  function oneSide(jp, e){
    if (Array.from(QUOTE_JP).some(c => jp.includes(c))) return null;
    if ((e.match(/["“”]/g) || []).length !== 1 || e.length < 3) return null;
    let body;
    if (DQ_OPEN.includes(e[0])) body = e.slice(1);
    else if (DQ_CLOSE.includes(e[e.length - 1])) body = e.slice(0, -1);
    else if (/[.!?]$/.test(e) && DQ_CLOSE.includes(e[e.length - 2])){
      body = e.slice(0, -2);
      if (!/[.!?…]$/.test(body.trim())) body = body.trimEnd() + e[e.length - 1];
    } else return null;
    body = body.trim();
    return /[\p{L}\p{N}]/u.test(body) ? body : null;
  }

  // ---- ③ となりの文どうし ----
  const plainJp = jp => String(jp || '').replace(/《[^》]*》/g, '').replace(/｜/g, '');
  // 含まれた方の日本語の漢字とカタカナ(無ければ、ひらがな)のうち、もう片方の日本語にもある字の割合(物差しの echo と同じ考え。tools/measure.js)
  function jpShare(x, y){
    const px = Array.from(plainJp(x)), py = new Set(Array.from(plainJp(y)));
    let cs = px.filter(c => /[\p{sc=Han}\p{sc=Katakana}]/u.test(c));
    if (!cs.length) cs = px.filter(c => /\p{sc=Hiragana}/u.test(c));
    cs = Array.from(new Set(cs));
    return cs.length ? cs.filter(c => py.has(c)).length / cs.length : 0;
  }
  const ECHO = 0.6;
  // 比べるための語の並び(曲がった引用符をまっすぐに・大文字と小文字を同じに)。位置も返す(切る所を、もとの英文で決めるため)
  const STRAIGHT = s => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
  function toks(s){
    const out = [];
    const re = /\S+/g;
    for (let m; (m = re.exec(s));) out.push({ t: STRAIGHT(m[0]), at: m.index });
    return out;
  }
  const sentences = en => (String(en).match(/[^.!?…]+[.!?…]+["'”’)]*/g) || []).filter(x => /[\p{L}\p{N}]/u.test(x)).length;
  // → null(触らない)/ { cut: 前の英文の、切ったあとの形 } / { split: [前の英文, 後ろの英文] }(同じ英文を分けた)/ { same: true }(2 つとも未訳に戻す)
  function pair(sa, sb, enA, enB){
    if (!sa || !sb) return null;
    const a = toks(String(enA || '').trim()), b = toks(String(enB || '').trim());
    if (b.length < 3 || a.length < b.length) return null;
    const k = a.length - b.length;
    for (let i = 0; i < b.length; i++) if (a[k + i].t !== b[i].t) return null;
    // 日本語でも重なっている(くり返し)なら、触らない。後ろの英文が前の英文に入っている形は、後ろの日本語が前の日本語に入っているか(物差しの echo と同じ向き)。
    //   同じ英文は、両方の向きで重なっているとき(「行こう。」「行こう。」)
    const inA = jpShare(sb.text, sa.text) >= ECHO;
    if (k === 0){
      if (inA && jpShare(sa.text, sb.text) >= ECHO) return null;
      if (sentences(enA) < 2) return null;                   // 同じ英文。1 文だけなら、ちがう日本語に同じ訳(Yes. と Yes.)かもしれないので、触らない
      const parts = wire.split([sa.text, sb.text], String(enA).trim());
      return parts ? { split: parts } : { same: true };
    }
    if (inA) return null;
    const head = String(enA).trim().slice(0, a[k].at).trimEnd();
    if (!/[.!?…]["'”’)]*$/.test(head) || !T.words(head)) return null;   // 文の切れ目でなければ、切らない
    return { cut: head };
  }

  // ---- 届いた順の訳に当てる ----
  //   o = { model, sids: 送った文(文書の順), onItem(item) }。item = reader の 1 件 { sid, en, f?, nk? }
  //   → { push(item), end(rep) → rep(直した数と、未訳に戻した文を足したもの)}
  function stream(o){
    const model = o.model, S = model.sents, map = Array.isArray(o.sids) ? o.sids.slice() : [], sent = new Set(map), onItem = o.onItem;
    const n = { title: 0, quote: 0, cut: 0, same: 0, split: 0 };
    const held = new Map(), state = new Map(), out = new Map();   // state: sid → 'out'(渡した)/ 'drop'(未訳に戻した)
    let ended = null;
    const gapOk = (a, b) => { const p = model.paras[a.p]; return !!p && typeof p.text === 'string' && p.text.slice(a.b, b.a).trim() === ''; };
    const nextOf = sid => { const a = S[sid], b = S[sid + 1]; return a && b && b.p === a.p && b.target && sent.has(b.sid) && sent.has(a.sid) && gapOk(a, b) ? b.sid : -1; };
    const prevOf = sid => (sid > 0 && nextOf(sid - 1) === sid ? sid - 1 : -1);
    const reflag = it => { const f = wire.flag(S[it.sid], it.en); if (f) it.f = f; else delete it.f; };
    const emit = it => { state.set(it.sid, 'out'); out.set(it.sid, it); onItem(it); };
    // a = 前(まだ渡していない)、b = 後ろ。→ 'drop'(2 つとも未訳に戻した)/ 'ok'(a を切ったかもしれない)
    function settle(a, b){
      const r = pair(S[a.sid], S[b.sid], a.en, b.en);
      if (r && r.same){ n.same += 2; state.set(a.sid, 'drop'); state.set(b.sid, 'drop'); held.delete(a.sid); held.delete(b.sid); return 'drop'; }
      if (r && r.cut != null){ n.cut++; a.en = r.cut; reflag(a); }
      if (r && r.split){ n.split += 2; a.en = r.split[0]; b.en = r.split[1]; reflag(a); reflag(b); }
      return 'ok';
    }
    return {
      push(item){
        if (ended || !item || !S[item.sid]) return;
        const it = Object.assign({}, item), s = S[it.sid];
        let en = it.en;
        const q = quote(s, en); if (q.n){ n.quote++; en = q.en; }
        const t = title(s.text, en); if (t.n){ n.title++; en = t.en; }
        if (en !== it.en){ it.en = en; reflag(it); }
        // 前の文が、この文を待っていたら、比べてから、前の文を渡す
        const p = prevOf(it.sid);
        if (p >= 0 && held.has(p)){
          const a = held.get(p);
          if (settle(a, it) === 'drop') return;
          held.delete(p); emit(a);
        }
        // 後ろの文が、まだ届いていなければ、待つ。先に届いていたら(順が入れかわった)、ここで比べる
        const nx = nextOf(it.sid);
        if (nx >= 0 && !state.has(nx) && !held.has(nx)){ held.set(it.sid, it); return; }
        if (nx >= 0 && held.has(nx)){ if (settle(it, held.get(nx)) === 'drop') return; }
        else if (nx >= 0 && state.get(nx) === 'out'){
          const r = pair(s, S[nx], it.en, out.get(nx).en);   // 後ろの文は、もう渡した: 切るだけ(未訳には戻さない)
          if (r && r.cut != null){ n.cut++; it.en = r.cut; reflag(it); }
          if (r && r.split){ n.split++; it.en = r.split[0]; reflag(it); }   // 後ろの文は、もう渡した: 前の文だけを、分けた 1 つ目に
        }
        emit(it);
      },
      end(rep){
        if (!ended){
          Array.from(held.values()).sort((x, y) => x.sid - y.sid).forEach(emit);
          held.clear();
          ended = { counts: Object.assign({}, n) };
        }
        if (!util.isPlain(rep)) return rep;
        const r = util.clone(rep), c = ended.counts;
        const M = map.length;
        r.got = out.size;
        r.missing = map.filter(sid => state.get(sid) !== 'out');
        if (M){
          const B = Math.min(10, M), tot = new Array(B).fill(0), ok = new Array(B).fill(0);
          map.forEach((sid, i) => { const b = Math.floor(i * B / M); tot[b]++; if (state.get(sid) === 'out') ok[b]++; });
          r.tenths = tot.map((x, b) => Math.round(ok[b] / x * 100) / 100);
        }
        const all = Array.from(out.values());
        r.flagShort = all.filter(x => x.f === 's').length;
        r.flagLong = all.filter(x => x.f === 'l').length;
        r.fixTitle = c.title; r.fixQuote = c.quote; r.fixCut = c.cut; r.fixSame = c.same; r.fixSplit = c.split;   // 直した文の数(§8-6 の通信の記録には、0 でないものだけ残る)
        return r;
      }
    };
  }

  Yomu.fix = { title, quote, pair, stream, jpShare };
})();

/* ---- core/tokens.js ---- */
// core/tokens.js — 英文を単語と熟語に分ける(部品の約束 §7-1)。現行 buildInteractiveEnglishHtml の当て方を、データを返す形にしたもの
//   split(en, words, o?) → [ { t:'w'|'i'|'x', s, i?, p?, g? } ]   w = 単語 / i = 熟語(words の i 番目)/ x = 空白と記号。s をつなぐと、もとの英文になる
//   現行のまま: 熟語を長い順に先に取る(見つかった所は全部)/2語以上の熟語は、先頭の語の活用のゆれを吸収する(現行の表と規則)/残りを単語に分ける
//   現行と変えた所: HTML ではなくデータを返す/曲がったアポストロフィも ' と同じ/英字は ASCII に限らない/実体参照(&quot; など)は読みかえない
//   工程T-5c: 現行の当て方で当たらなかった熟語だけを、離れた形(handed ... back)・見出しの形(stand up → stood up)でも当てる(下の「離れた熟語」)。
//     離れた熟語の語は t:'i' に p(何切れ目か。0 から)、間の語(と、間の語どうしの間の空白)は g(熟語の番号)。o.far === false なら、現行の当て方だけ
(function(){
  'use strict';
  // 番号で作る字(書く道具が、番号の書き方を文字に置きかえることがある。engine/README.md の「書くときの注意」)
  const RSQ = String.fromCharCode(0x2019);                       // 曲がったアポストロフィ
  const P0 = String.fromCharCode(0xE000), P1 = String.fromCharCode(0xE001), PBASE = 0xE100, PMAX = 0xF8FF - PBASE;   // 仮の印(私用の字)
  const PRIVATE = new RegExp('[' + P0 + '-' + String.fromCharCode(0xF8FF) + ']');
  const PH = new RegExp(P0 + '([^' + P0 + P1 + '])' + P1, 'g');
  const WORD = new RegExp("\\p{L}+(?:['" + RSQ + "]\\p{L}+)?", 'gu');
  const WCH = /[\p{L}\p{N}_]/u;                                  // 語の字(この字と隣り合う所は、語の切れ目ではない)
  const APOS = new RegExp("['" + RSQ + "]");

  const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 熟語の字 → 正規表現。' は、まっすぐでも曲がっていても当たる
  const esc = s => escapeRegExp(s.split(RSQ).join("'")).split("'").join("['" + RSQ + "]");

  // 先頭の語の活用のゆれ(現行の表と規則のまま)
  function flexFirst(word){
    const first = word.toLowerCase();
    if (first === 'catch' || first === 'caught') return '(?:catch|caught|catches|catching)';
    if (first === 'have' || first === 'had' || first === 'has') return '(?:have|had|has|having)';
    if (first === 'hold' || first === 'held') return '(?:hold|held|holds|holding)';
    if (first === 'reach' || first === 'reached') return '(?:reach|reached|reaches|reaching)';
    if (first === 'give' || first === 'gave' || first === 'given') return '(?:give|gave|given|gives|giving)';
    if (first === 'take' || first === 'took' || first === 'taken') return '(?:take|took|taken|takes|taking)';
    if (first === 'be' || first === 'is' || first === 'are' || first === 'was' || first === 'were') return '(?:be|is|are|was|were|been|being)';
    if (first === 'strike' || first === 'struck') return '(?:strike|struck|strikes|striking)';
    if (first.endsWith('e')) return '(?:' + esc(first) + '|' + esc(first) + 'd|' + esc(first.slice(0, -1)) + 'ing)';
    return '(?:' + esc(first) + '|' + esc(first) + 'ed|' + esc(first) + 'ing)';
  }
  function regOf(phrase){
    const parts = phrase.split(/\s+/);
    if (parts.length > 1) return new RegExp('\\b' + flexFirst(parts[0]) + '\\s+' + parts.slice(1).map(esc).join('\\s+') + '\\b', 'gi');
    return new RegExp('\\b' + esc(phrase) + '\\b', 'gi');
  }

  // 熟語でない所を、単語と、空白・記号に分ける。数字や _ と隣り合う英字は、語にしない(現行の \b と同じ)
  function plain(s, out){
    let last = 0, m;
    const push = (a, b) => {
      if (a > last) out.push({ t: 'x', s: s.slice(last, a) });
      out.push({ t: 'w', s: s.slice(a, b) });
      last = b;
    };
    WORD.lastIndex = 0;
    while ((m = WORD.exec(s))){
      const a = m.index;
      let b = a + m[0].length;
      const q = m[0].search(APOS);
      if (a > 0 && WCH.test(s[a - 1])){             // 5don't → ' の後ろの t から探し直す
        if (q >= 0) WORD.lastIndex = a + q;
        continue;
      }
      if (b < s.length && WCH.test(s[b])){          // don't5 → don まで戻る
        if (q < 0) continue;
        b = a + q;
        WORD.lastIndex = b;
      }
      push(a, b);
    }
    if (last < s.length) out.push({ t: 'x', s: s.slice(last) });
  }

  // ---- 離れた熟語・見出しの形の熟語(工程T-5c。部品の約束 §7-1。試作 tools/idiom_match_proto.js をエンジンへ移したもの)----
  //   ① ...・…・~ と、置き字(someone・something・sb・sth・大文字の A・B)は「間に 0〜gapMax 語」
  //   ② 語は、lemma(§7-2)の候補が重なれば同じ(stood と stand・went と go)
  //   ③ one's・someone's は my・your・his・her・its・our・their・one's と 's で終わる語に、oneself は -self・-selves に当たる
  //   ④ ... の無い熟語(見出しの形のまま "hold up")は、2語目からの小さな語(up・back・to など)の前に、間を許して、もう一度当てる
  //   ⑤ 間に句読点をまたがない ⑥ いくつもの当て方があれば、間の合計がいちばん小さいもの(同じなら、前の方)
  //   当てるのは、決まった語が2つ以上のときだけ(1語だと、ふつうの語が熟語の印になる=2026-10-17 利用者)。w で当たらなければ、見出しの形 b でも。
  //   1つの熟語は1か所だけ。ほかの熟語と重なる所(間の語もふくむ)には当てない。間の語の無い当て方になったら、ふつうの熟語と同じ1かたまり
  const ELL = String.fromCharCode(0x2026);
  const GAPMARK = new RegExp('[.]{2,}|' + ELL + '|~', 'g');
  const HARD = new RegExp('[,.;:!?"()\\[\\]' + String.fromCharCode(0x201C, 0x201D, 0x2014, 0x2013, 0x2026) + ']');   // 間にまたがない記号
  const PIECE = new RegExp(WORD.source, 'gu');
  const SLOT = new Set(['someone', 'somebody', 'something', 'sb', 'sth']);
  const POSS = new Set(['my', 'your', 'his', 'her', 'its', 'our', 'their', "one's"]);
  const PART = new Set(['up', 'down', 'out', 'off', 'on', 'in', 'into', 'over', 'back', 'away', 'around', 'round', 'about', 'through', 'along', 'across', 'aside', 'apart',
    'together', 'forward', 'toward', 'towards', 'to', 'of', 'for', 'with', 'from', 'at', 'by', 'as', 'close', 'open', 'behind']);
  const low = s => String(s).split(RSQ).join("'").toLowerCase();
  const gapMax = () => { const c = Yomu.config && Yomu.config.idioms; return c && Number.isInteger(c.gapMax) && c.gapMax >= 0 ? c.gapMax : 6; };

  // 熟語の字 → 切れの並び [[項…]…]。項 = { k:'w', v } | { k:'poss' } | { k:'self' }。決まった語が2つより少なければ null
  function piecesOf(w){
    const segs = [[]];
    const cut = () => segs.push([]);
    String(w).split(RSQ).join("'").replace(GAPMARK, ' ... ').split(/\s+/).forEach(tok => {
      if (tok === '...'){ cut(); return; }
      (tok.match(PIECE) || []).forEach(x0 => {
        const x = x0.toLowerCase(), seg = segs[segs.length - 1];
        if (x0 === 'A' || x0 === 'B' || SLOT.has(x)) cut();            // 大文字の A・B も置き字(compare A to B)
        else if (x === "one's" || x === "someone's") seg.push({ k: 'poss' });
        else if (x === 'oneself') seg.push({ k: 'self' });
        else seg.push({ k: 'w', v: x });
      });
    });
    const ps = segs.filter(x => x.length);
    const n = ps.reduce((a, x) => a + x.length, 0);
    return n >= 2 && ps.some(x => x.some(it => it.k === 'w')) ? ps : null;
  }

  // 英文の語の並び(現行の当て方の結果 out から。熟語のかたまりは1つの、使えない語)
  function wordsOf(out){
    const W = [];
    let between = '';
    out.forEach((t, k) => {
      if (t.t === 'x'){ between += t.s; return; }
      W.push({ k, lo: low(t.s), hard: HARD.test(between), free: t.t === 'w' });
      between = '';
    });
    return W;
  }
  function lemmaSet(cache, w){
    let s = cache.get(w);
    if (s) return s;
    s = new Set([w]);
    const L = Yomu.lemma;
    if (L && typeof L.candidates === 'function'){ try { L.candidates(w).forEach(c => s.add(c.lemma)); } catch (e){} }
    cache.set(w, s);
    return s;
  }
  function fits(it, e, cache){
    if (it.k === 'poss') return POSS.has(e.lo) || /'s$/.test(e.lo);
    if (it.k === 'self') return /(?:self|selves)$/.test(e.lo);
    if (e.lo === it.v) return true;
    const a = lemmaSet(cache, it.v), b = lemmaSet(cache, e.lo);
    for (const l of a) if (b.has(l)) return true;
    return false;
  }
  // 切れの並びを、本文の順に、間 0〜G 語(句読点をまたがない・使える語だけ)で当てる → { gap, first, parts:[[始め, 終わり]…] }(W の番号)| null
  function place(W, segs, G, cache){
    const n = W.length;
    const okAt = (sg, a) => {
      if (a + sg.length > n) return false;
      for (let k = 0; k < sg.length; k++){ const e = W[a + k]; if (!e.free || (k > 0 && e.hard) || !fits(sg[k], e, cache)) return false; }
      return true;
    };
    const tables = [];
    let prev = null;
    for (let j = 0; j < segs.length; j++){
      const cur = new Map(), sg = segs[j];
      for (let a = 0; a < n; a++){
        if (!okAt(sg, a)) continue;
        if (j === 0){ cur.set(a, { gap: 0, first: a, back: -1 }); continue; }
        const L = segs[j - 1].length;
        let best = null;
        for (let b = Math.max(0, a - L - G); b <= a - L; b++){
          const v = prev.get(b);
          if (!v) continue;
          const end = b + L - 1;
          let bad = false;
          for (let k = end + 1; k <= a; k++) if (W[k].hard || !W[k].free){ bad = true; break; }
          if (bad) continue;
          const gap = v.gap + a - end - 1;
          if (!best || gap < best.gap || (gap === best.gap && v.first < best.first)) best = { gap, first: v.first, back: b };
        }
        if (best) cur.set(a, best);
      }
      if (!cur.size) return null;
      tables.push(cur);
      prev = cur;
    }
    let endAt = -1, top = null;
    prev.forEach((v, a) => { if (!top || v.gap < top.gap || (v.gap === top.gap && v.first < top.first)){ top = v; endAt = a; } });
    const parts = [];
    for (let j = segs.length - 1, a = endAt; j >= 0; j--){
      parts.unshift([a, a + segs[j].length - 1]);
      a = tables[j].get(a).back;
    }
    return { gap: top.gap, first: top.first, parts };
  }
  // 1つの熟語を当てる。w → b → w(小さな語の前に間)→ b(同じ)の順
  function locate(x, W, G, cache){
    const tryOf = (segs, implicit) => {
      if (!segs) return null;
      if (!implicit) return place(W, segs, G, cache);
      if (segs.length !== 1 || segs[0].length < 2) return null;
      let best = null;
      for (let c = 1; c < segs[0].length; c++){
        const it = segs[0][c];
        if (it.k !== 'w' || !PART.has(it.v)) continue;
        const r = place(W, [segs[0].slice(0, c), segs[0].slice(c)], G, cache);
        if (r && (!best || r.gap < best.gap)) best = r;
      }
      return best;
    };
    const pw = piecesOf(x.w), pb = typeof x.b === 'string' ? piecesOf(x.b) : null;
    return tryOf(pw, false) || tryOf(pb, false) || tryOf(pw, true) || tryOf(pb, true);
  }
  // 現行の当て方の結果 out に、当たらなかった熟語(rest)を足す
  function far(out, list, rest){
    const W = wordsOf(out);
    if (W.length < 2) return out;
    const G = gapMax(), cache = new Map(), found = [];
    rest.forEach(item => {
      const r = locate(list[item.i], W, G, cache);
      if (!r) return;
      // 間の語の無い切れどうしは、つなぐ
      const parts = [];
      r.parts.forEach(pt => { const last = parts[parts.length - 1]; if (last && pt[0] === last[1] + 1) last[1] = pt[1]; else parts.push(pt.slice()); });
      for (let k = parts[0][0]; k <= parts[parts.length - 1][1]; k++) W[k].free = false;   // 間の語もふくめて、ほかの熟語に使わせない
      found.push({ i: item.i, parts });
    });
    if (!found.length) return out;
    // out の番号で、切れと間を印す
    const head = new Map(), skip = new Set(), gapOf = new Map();
    found.forEach(f => {
      f.parts.forEach((pt, p) => {
        const ka = W[pt[0]].k, kb = W[pt[1]].k;
        head.set(ka, { kb, i: f.i, p: f.parts.length > 1 ? p : null });
        for (let k = ka + 1; k <= kb; k++) skip.add(k);
        if (p + 1 < f.parts.length){
          const ga = W[pt[1] + 1].k, gb = W[f.parts[p + 1][0] - 1].k;      // 間の、最初の語と最後の語
          for (let k = ga; k <= gb; k++) gapOf.set(k, f.i);
        }
      });
    });
    const res = [];
    out.forEach((t, k) => {
      if (skip.has(k)) return;
      const h = head.get(k);
      if (h){
        let s = '';
        for (let q = k; q <= h.kb; q++) s += out[q].s;
        res.push(h.p == null ? { t: 'i', s, i: h.i } : { t: 'i', s, i: h.i, p: h.p });
        return;
      }
      res.push(gapOf.has(k) ? Object.assign({}, t, { g: gapOf.get(k) }) : t);
    });
    return res;
  }

  function split(en, words, o){
    en = en == null ? '' : String(en);
    const list = Array.isArray(words) ? words : [];
    const out = [];
    if (PRIVATE.test(en)){ plain(en, out); return out; }       // 仮の印と同じ字が英文にあれば、熟語は当てない
    // 長い順(同じ長さは、もとの順)
    const sorted = list.map((x, i) => ({ w: x && typeof x.w === 'string' ? x.w : '', i }))
      .filter(x => x.w.trim() && !PRIVATE.test(x.w))
      .sort((a, b) => b.w.length - a.w.length);
    const taken = [];   // [{ i, s }]
    const hit = new Set();
    let processed = en;
    sorted.forEach(item => {
      if (taken.length >= PMAX) return;
      processed = processed.replace(regOf(item.w.trim()), matched => {
        if (taken.length >= PMAX) return matched;
        taken.push({ i: item.i, s: matched });
        hit.add(item.i);
        return P0 + String.fromCharCode(PBASE + taken.length - 1) + P1;
      });
    });
    let at = 0, m;
    PH.lastIndex = 0;
    while ((m = PH.exec(processed))){
      plain(processed.slice(at, m.index), out);
      const tk = taken[m[1].charCodeAt(0) - PBASE];
      out.push({ t: 'i', s: tk.s, i: tk.i });
      at = m.index + m[0].length;
    }
    plain(processed.slice(at), out);
    if (o && o.far === false) return out;
    const rest = sorted.filter(item => !hit.has(item.i));
    return rest.length ? far(out, list, rest) : out;
  }

  // 「ひろげる」で選んだ範囲(from 番目 〜 to 番目の、両端をふくむ)の文字。端の空白は除き、間の空白は1つに
  function phrase(tokens, from, to){
    if (!Array.isArray(tokens)) return '';
    const a = Math.max(0, Math.min(from, to) | 0), b = Math.min(tokens.length - 1, Math.max(from, to) | 0);
    let s = '';
    for (let k = a; k <= b; k++) s += String((tokens[k] && tokens[k].s) || '');
    return s.replace(/\s+/g, ' ').trim();
  }

  Yomu.tokens = { split, phrase };
})();

/* ---- core/lemma.js ---- */
// core/lemma.js — 活用形を原形に直す(部品の約束 §7-2)。辞書を持たない。「かもしれない原形」を、可能性の高い順に並べるだけ
//   candidates(word) → [ { lemma, kind, irr? } ]   候補は、辞書で確かめてから使う(core/dict.js の lookup)
//   kind: 's'(複数形か三単現)'pl' '3sg' 'pres'(am・are)'ed'(過去形か過去分詞)'past' 'pp' 'ing' 'comp' 'sup' 'adv'(-ly)'poss'('s)'contr'(短縮形)
//   irr = 不規則の表から出た候補(規則から出た候補より先に並ぶ。辞書は、これを「もとの語」として添える)
(function(){
  'use strict';
  const RSQ = String.fromCharCode(0x2019);   // 曲がったアポストロフィ(番号で作る。engine/README.md の「書くときの注意」)

  // ---- 不規則の表 ----
  // 動詞: 原形 過去 過去分詞(/ で別の形)。過去と過去分詞が同じ形なら 'ed'
  const VERBS = [
    'arise arose arisen', 'awake awoke awoken', 'bear bore borne/born', 'beat beat beaten', 'become became become', 'begin began begun', 'behold beheld beheld',
    'bend bent bent', 'bet bet bet', 'bid bid bid', 'bind bound bound', 'bite bit bitten', 'bleed bled bled', 'blow blew blown', 'break broke broken', 'breed bred bred',
    'bring brought brought', 'build built built', 'burn burnt burnt', 'burst burst burst', 'buy bought bought', 'cast cast cast', 'catch caught caught',
    'choose chose chosen', 'cling clung clung', 'come came come', 'cost cost cost', 'creep crept crept', 'cut cut cut', 'deal dealt dealt', 'dig dug dug',
    'do did done', 'draw drew drawn', 'dream dreamt dreamt', 'drink drank drunk', 'drive drove driven', 'dwell dwelt dwelt', 'eat ate eaten', 'fall fell fallen',
    'feed fed fed', 'feel felt felt', 'fight fought fought', 'find found found', 'flee fled fled', 'fling flung flung', 'fly flew flown', 'forbid forbade forbidden',
    'foresee foresaw foreseen', 'forget forgot forgotten', 'forgive forgave forgiven', 'freeze froze frozen', 'get got got/gotten', 'give gave given', 'go went gone',
    'grind ground ground', 'grow grew grown', 'hang hung hung', 'have had had', 'hear heard heard', 'hide hid hidden', 'hit hit hit', 'hold held held',
    'hurt hurt hurt', 'keep kept kept', 'kneel knelt knelt', 'know knew known', 'lay laid laid', 'lead led led', 'lean leant leant', 'leap leapt leapt',
    'learn learnt learnt', 'leave left left', 'lend lent lent', 'let let let', 'lie lay lain', 'light lit lit', 'lose lost lost', 'make made made', 'mean meant meant',
    'meet met met', 'mistake mistook mistaken', 'overcome overcame overcome', 'overhear overheard overheard', 'overtake overtook overtaken', 'pay paid paid',
    'put put put', 'quit quit quit', 'read read read', 'ride rode ridden', 'ring rang rung', 'rise rose risen', 'run ran run', 'say said said', 'see saw seen',
    'seek sought sought', 'sell sold sold', 'send sent sent', 'set set set', 'sew sewed sewn', 'shake shook shaken', 'shed shed shed', 'shine shone shone',
    'shoot shot shot', 'show showed shown', 'shrink shrank shrunk', 'shut shut shut', 'sing sang sung', 'sink sank sunk', 'sit sat sat', 'slay slew slain',
    'sleep slept slept', 'slide slid slid', 'smell smelt smelt', 'sow sowed sown', 'speak spoke spoken', 'speed sped sped', 'spell spelt spelt', 'spend spent spent',
    'spill spilt spilt', 'spin spun spun', 'spit spat spat', 'split split split', 'spoil spoilt spoilt', 'spread spread spread', 'spring sprang sprung',
    'stand stood stood', 'steal stole stolen', 'stick stuck stuck', 'sting stung stung', 'stink stank stunk', 'strike struck struck/stricken', 'string strung strung',
    'strive strove striven', 'swear swore sworn', 'sweep swept swept', 'swell swelled swollen', 'swim swam swum', 'swing swung swung', 'take took taken',
    'teach taught taught', 'tear tore torn', 'tell told told', 'think thought thought', 'throw threw thrown', 'thrust thrust thrust', 'tread trod trodden',
    'undergo underwent undergone', 'understand understood understood', 'undo undid undone', 'uphold upheld upheld', 'wake woke woken', 'wear wore worn',
    'weave wove woven', 'weep wept wept', 'win won won', 'wind wound wound', 'withdraw withdrew withdrawn', 'withstand withstood withstood', 'write wrote written'
  ];
  // そのほか: 形 原形 kind
  const OTHERS = [
    'am be pres', 'are be pres', 'is be 3sg', 'was be past', 'were be past', 'been be pp', 'being be ing',
    'has have 3sg', 'does do 3sg', 'could can past', 'would will past', 'should shall past', 'might may past',
    'men man pl', 'women woman pl', 'children child pl', 'feet foot pl', 'teeth tooth pl', 'mice mouse pl', 'geese goose pl', 'oxen ox pl',
    'leaves leaf pl', 'lives life pl', 'knives knife pl', 'wives wife pl', 'wolves wolf pl', 'shelves shelf pl', 'halves half pl', 'selves self pl',
    'thieves thief pl', 'loaves loaf pl', 'calves calf pl', 'scarves scarf pl', 'elves elf pl', 'hooves hoof pl',
    'leaves leave s', 'lives live s',
    'better good comp', 'better well comp', 'best good sup', 'best well sup', 'worse bad comp', 'worst bad sup', 'more many comp', 'more much comp',
    'most many sup', 'most much sup', 'less little comp', 'least little sup', 'further far comp', 'farther far comp', 'furthest far sup', 'farthest far sup',
    'elder old comp', 'eldest old sup',
    "don't do contr", "doesn't do contr", "didn't do contr", "can't can contr", 'cannot can contr', "couldn't could contr", "won't will contr", "wouldn't would contr",
    "shan't shall contr", "shouldn't should contr", "isn't be contr", "aren't be contr", "wasn't be contr", "weren't be contr", "ain't be contr",
    "haven't have contr", "hasn't have contr", "hadn't have contr", "mustn't must contr", "needn't need contr", "mightn't might contr", "let's let contr",
    // 規則どおりに直すと、別の語になるもの
    'owed owe ed', 'owing owe ing', 'pasted paste ed', 'pasting paste ing', 'skied ski ed', 'adding add ing', 'added add ed'
  ];
  const IRR = new Map();
  const put = (form, lemma, kind) => {
    if (form === lemma) return;
    const list = IRR.get(form) || [];
    if (!list.some(x => x.lemma === lemma && x.kind === kind)) list.push({ lemma, kind, irr: true });
    IRR.set(form, list);
  };
  VERBS.forEach(row => {
    const [base, past, pp] = row.split(' ').map(x => x.split('/'));
    past.forEach(f => put(f, base[0], pp.includes(f) ? 'ed' : 'past'));
    pp.forEach(f => { if (!past.includes(f)) put(f, base[0], 'pp'); });
  });
  OTHERS.forEach(row => { const [form, lemma, kind] = row.split(' '); put(form, lemma, kind); });

  // ---- 規則 ----
  const VOWEL = /[aeiou]/;
  const isCons = ch => !!ch && /[a-z]/.test(ch) && !VOWEL.test(ch);
  // 語尾(-ed・-ing・-er・-est)を取った残りから、原形の候補を、ありそうな順に
  function stems(base, ing){
    const n = base.length, a = base[n - 1], b = base[n - 2], c = base[n - 3];
    if (n >= 3 && a === b && isCons(a)){                       // stopped → stop / falling → fall
      const un = base.slice(0, -1);
      return 'lszf'.includes(a) ? [base, un] : [un, base];
    }
    if (!ing && a === 'i' && n === 2) return [base + 'e', base.slice(0, -1) + 'y'];         // died → die / tied → tie
    if (!ing && a === 'i' && n > 2) return [base.slice(0, -1) + 'y', base + 'e', base];    // studied → study
    if (ing && a === 'y') return n === 2 ? [base.slice(0, -1) + 'ie', base] : [base, base.slice(0, -1) + 'ie'];   // lying → lie / trying → try
    if (isCons(a) && !'wxy'.includes(a) && VOWEL.test(b || '') && !VOWEL.test(c || '')) return [base + 'e', base];   // hoped → hope / visited → visit
    if (a === 'h' && b === 't') return [base + 'e', base];                                 // breathed → breathe
    return [base, base + 'e'];                                                             // walked → walk / changed → change
  }
  function plural(w){
    const n = w.length;
    if (w.endsWith('ies')) return n > 4 ? [w.slice(0, -3) + 'y', w.slice(0, -1)] : [w.slice(0, -1), w.slice(0, -3) + 'y'];   // studies → study / ties → tie
    if (w.endsWith('oes')) return [w.slice(0, -1), w.slice(0, -2)];                         // toes → toe / goes → go
    if (w.endsWith('zzes')) return [w.slice(0, -2), w.slice(0, -3)];                        // buzzes → buzz / quizzes → quiz
    if (/(ss|x|ch|sh)es$/.test(w)) return [w.slice(0, -2), w.slice(0, -1)];                 // boxes → box / watches → watch
    if (/[sz]es$/.test(w)) return [w.slice(0, -1), w.slice(0, -2)];                         // uses → use / buses → bus
    if (w.endsWith('ves')) return [w.slice(0, -1), w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe'];   // loves → love / wolves → wolf / knives → knife
    if (w.endsWith('s') && !w.endsWith('ss')) return [w.slice(0, -1)];
    return [];
  }

  function candidates(word){
    const w = String(word == null ? '' : word).split(RSQ).join("'").trim().toLowerCase();
    const out = [], seen = new Set();
    const add = (lemma, kind, irr) => {
      if (!lemma || (lemma.length < 2 && kind !== 'contr') || lemma === w || seen.has(lemma + '/' + kind)) return;
      seen.add(lemma + '/' + kind);
      out.push(irr ? { lemma, kind, irr: true } : { lemma, kind });
    };
    if (!/^[a-z][a-z'-]*$/.test(w)) return out;
    (IRR.get(w) || []).forEach(x => add(x.lemma, x.kind, true));
    const ap = w.lastIndexOf("'");
    if (ap > 0){
      const head = w.slice(0, ap), tail = w.slice(ap + 1);
      if (tail === 's') add(head, 'poss');
      else if (['m', 're', 've', 'll', 'd'].includes(tail)) add(head, 'contr');
      else if (tail === 't' && head.endsWith('n')) add(head.slice(0, -1), 'contr');
      else if (tail === '' ) add(head, 'poss');
      return out;
    }
    plural(w).forEach(x => add(x, 's'));
    if (w.endsWith('ing') && w.length >= 5) stems(w.slice(0, -3), true).forEach(x => add(x, 'ing'));
    if (w.endsWith('ed') && w.length >= 4) stems(w.slice(0, -2), false).forEach(x => add(x, 'ed'));
    if (w.endsWith('est') && w.length >= 5) stems(w.slice(0, -3), false).forEach(x => add(x, 'sup'));
    if (w.endsWith('er') && w.length >= 4) stems(w.slice(0, -2), false).forEach(x => add(x, 'comp'));
    if (w.endsWith('ly') && w.length >= 5){                    // 見出しに無い副詞(-ly)は、もとの語
      const base = w.slice(0, -2);
      if (base.endsWith('i')) add(base.slice(0, -1) + 'y', 'adv');                           // happily → happy
      add(w.slice(0, -1) + 'e', 'adv'); add(base, 'adv'); add(base + 'e', 'adv'); add(w.slice(0, -1), 'adv');   // gently → gentle / dimly → dim / truly → true / fully → full
      if (base.endsWith('ed') && base.length >= 4) stems(base.slice(0, -2), false).forEach(x => add(x, 'adv'));     // hurriedly → hurry
      if (base.endsWith('ing') && base.length >= 5) stems(base.slice(0, -3), true).forEach(x => add(x, 'adv'));     // smilingly → smile
    }
    return out;
  }

  Yomu.lemma = { candidates, KINDS: ['s', 'pl', '3sg', 'pres', 'ed', 'past', 'pp', 'ing', 'comp', 'sup', 'adv', 'poss', 'contr'] };
})();

/* ---- core/dict.js ---- */
// core/dict.js — 内蔵辞書(部品の約束 §7-3)。通信なしで単語の意味を出す。元は EJDict(CC0。tools/make_dict.js が作る)
//   load()   初めて引くときに1回。サイトの保存に写しがあれば読み、無ければ入れ物(Yomu.env.dict.load)から取ってきて、保存に置く
//   lookup() 大きな1本の文字のまま、二分探索で引く(4.7 万語をオブジェクトにしない)。そのまま → 大文字と小文字のちがい → 原形の候補、の順
//   辞書の形: 1行1語「見出し\t意味」・改行は LF・並びは「小文字にした見出し → もとの見出し」の、字の番号の順(make_dict.js と同じ比べ方)
(function(){
  'use strict';
  const { config, util, store, lemma } = Yomu;
  const Y = Yomu;   // Yomu.env は、使うときに読む
  const C = config.dict;
  const RSQ = String.fromCharCode(0x2019);   // 曲がったアポストロフィ(番号で作る。engine/README.md の「書くときの注意」)
  const fold = s => s.toLowerCase();

  let text = null, count = 0, from = null, kept = false;   // 読み込んだ辞書・語の数・どこから('site'|'net')・保存に置いてあるか
  let loading = null;

  // ---- 辞書の形の確かめ(取ってきたものが、辞書でない何かだったときに、保存に置かない) ----
  function inspect(t){
    if (typeof t !== 'string' || !t.length || t[t.length - 1] !== '\n' || t.includes('\r')) return 0;
    let n = 0, prev = null, step = 0;
    for (let at = 0; at < t.length; ){
      const end = t.indexOf('\n', at);
      // 全部の行を数え、とびとびの行で、形(見出し\t意味)と並びを見る
      if (n === step){
        const tab = t.indexOf('\t', at);
        if (tab <= at || tab + 1 >= end) return 0;
        const key = fold(t.slice(at, tab));
        if (prev !== null && prev > key) return 0;
        prev = key;
        step += C.checkEvery;
      }
      n++;
      at = end + 1;
    }
    return n;
  }

  // ---- 引く ----
  // at をふくむ行 → { start, tab, end }
  function lineAt(at){
    const start = text.lastIndexOf('\n', at - 1) + 1;
    const end = text.indexOf('\n', start);
    return { start, tab: text.indexOf('\t', start), end };
  }
  const headOf = ln => text.slice(ln.start, ln.tab);
  // 冠詞(a・an・the)の意味が、うしろにある見出しは、それを先に出す(元の辞書の a・an は、answer・ampere・アルファベットの第1字 が先で、
  //   「不定冠詞」が終わり=工程5b-2 利用者: いちばんよく出る語で、おかしい。辞書データは変えない=端末に、取り直させない)
  const ARTICLE = String.fromCharCode(0x51A0, 0x8A5E);   // 冠詞
  function articleFirst(mean){
    const parts = mean.split(' / ');
    const i = parts.findIndex(p => p.slice(0, 12).indexOf(ARTICLE) >= 0);
    return i > 0 ? [parts[i]].concat(parts.slice(0, i), parts.slice(i + 1)).join(' / ') : mean;
  }
  const entryOf = ln => ({ head: headOf(ln), mean: articleFirst(text.slice(ln.tab + 1, ln.end)) });
  // 小文字にすると key になる見出しの全部(並んでいる)→ [{ head, mean }]
  function run(key){
    let lo = 0, hi = text.length - 1, hit = null;   // 行の頭の位置で、はさむ
    while (lo < hi){
      const ln = lineAt((lo + hi) >>> 1);
      const k = fold(headOf(ln));
      if (k === key){ hit = ln; break; }
      if (k < key) lo = ln.end + 1; else hi = ln.start;
    }
    if (!hit) return [];
    while (hit.start > 0){ const p = lineAt(hit.start - 1); if (fold(headOf(p)) !== key) break; hit = p; }
    const out = [];
    for (let ln = hit; ; ln = lineAt(ln.end + 1)){
      if (fold(headOf(ln)) !== key) break;
      out.push(entryOf(ln));
      if (ln.end + 1 >= text.length) break;
    }
    return out;
  }
  // q そのもの → 全部が小文字の見出し → 最初の1つ、の順で選ぶ。残りは others
  //   low(文の頭の語)なら、全部が小文字の見出しを先に(In = indium より in)。無ければ、いつもの順
  function find(q, low){
    const list = run(fold(q));
    if (!list.length) return null;
    const exact = list.find(e => e.head === q), lower = list.find(e => e.head === fold(e.head));
    const best = (low ? lower || exact : exact || lower) || list[0];
    return { best, others: list.filter(e => e !== best) };
  }
  // 「goの過去」「leafの複数形」のように、ほかの語を指しているだけの意味 → 指している語
  const POINTER = /^=?\s*([A-Za-z][A-Za-z' .-]*?)\s*の(?:過去|複数|三人称|3人称|比較級|最上級|現在分詞|短縮形)/;

  const tidy = q => String(q == null ? '' : q).split(RSQ).join("'").replace(/\s+/g, ' ').trim();
  const clean = q => q.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}.]+$/u, '');   // 前後の記号を除く(「ひろげる」で付いた , や " など)

  // 頭の1字だけが大文字の語(In・May・A)。I は、いつも大文字なので外す
  const CAPPED = /^\p{Lu}[^\p{Lu}]*$/u;
  // opt.first = 文の頭の語(大文字は、文の頭だからかもしれない)
  function lookup(query, opt){
    if (text === null) return null;
    const raw = tidy(query);
    if (!raw || raw.length > C.qMax) return null;
    const q = find(raw) ? raw : clean(raw);                                 // 記号で始まる見出し('em・$ など)は、そのまま引く
    if (!q) return null;
    // 原形に直して探す形 → [{ q, c }]。1語なら、その語。語句(「ひろげる」で作ったもの)なら、最後の語(pen pals → pen pal)、次に先頭の語
    const a = q.indexOf(' '), b = q.lastIndexOf(' ');
    const cands = a < 0 ? lemma.candidates(q) : [];
    const tries = a < 0 ? cands.map(c => ({ q: c.lemma, c }))
      : lemma.candidates(q.slice(b + 1)).map(c => ({ q: q.slice(0, b + 1) + c.lemma, c }))
        .concat(lemma.candidates(q.slice(0, a)).map(c => ({ q: c.lemma + q.slice(a), c })));
    let hit = find(q, !!(opt && opt.first) && a < 0 && q !== 'I' && CAPPED.test(q)), via = null;
    if (!hit && !q.endsWith('.')) hit = find(q + '.');                      // approx → approx.
    if (!hit){
      for (const t of tries){                                               // went → go
        hit = find(t.q);
        if (hit){ via = { lemma: t.c.lemma, kind: t.c.kind }; break; }
      }
    }
    if (!hit) return null;
    const out = { head: hit.best.head, mean: hit.best.mean, via };
    // もとの語など、いっしょに見せるとよい見出し(同じ見出しは入れない)
    const also = [], seen = new Set([out.head]);
    const add = (e, v) => { if (e && !seen.has(e.head) && also.length < C.alsoMax){ seen.add(e.head); also.push({ head: e.head, mean: e.mean, via: v }); } };
    const p = POINTER.exec(out.mean);
    if (p){ const t = find(p[1]); if (t) add(t.best, null); }
    cands.forEach(c => { if (c.irr){ const t = find(c.lemma); if (t) add(t.best, { lemma: c.lemma, kind: c.kind }); } });
    hit.others.forEach(e => add(e, null));
    if (also.length) out.also = also;
    return out;
  }

  // 記号の整理(表示用)。意味の区切り「 / 」で行に分け、強調の『』を外す
  function format(mean){
    const lines = String(mean == null ? '' : mean).split(' / ').map(s => s.replace(/[『』]/g, '').trim()).filter(Boolean);
    return { lines };
  }

  // ---- 読み込み ----
  function use(t, n, where, saved){ text = t; count = n; from = where; kept = saved; }
  // かかった時間の控え(調べるための記録に出す。§9-8。工程5c-1: 本物の辞書を、iPhone で取る時間・読む時間・引く時間を測るため。動きは変えない)
  const tick = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const since = a => Math.round((tick() - a) * 10) / 10;
  let stat = null;                 // { from, n, readMs, netMs?, saveMs?, saved, looks, lookMs }
  async function doLoad(opt){
    // 1. サイトの保存に写しがあれば、それを使う
    let rec;
    const t0 = tick();
    try { rec = await store.site.get(C.key); } catch (e){ rec = undefined; }
    const readMs = since(t0);
    if (util.isPlain(rec) && rec.ver === C.ver && typeof rec.text === 'string'){
      const n = inspect(rec.text);
      if (n){ use(rec.text, n, 'site', true); stat = { from: 'site', n, readMs: since(t0), saved: true, looks: 0, lookMs: null }; return { n, from: 'site', saved: true }; }
    }
    // 2. 入れ物から取ってくる(配る場所から。§2-2)
    const env = Y.env && Y.env.dict;
    if (!env || typeof env.load !== 'function') throw util.error('bad', '内蔵辞書を取ってくる口が無い');
    let got;
    const t1 = tick();
    try { got = await env.load({ signal: opt.signal, onProgress: typeof opt.onProgress === 'function' ? opt.onProgress : undefined }); }
    catch (e){
      if (e && e.kind) throw e;
      const stop = (opt.signal && opt.signal.aborted) || (e && e.name === 'AbortError');
      throw util.error(stop ? 'abort' : 'network', stop ? '中止した' : '内蔵辞書を取ってこられなかった: ' + String((e && e.message) || e));
    }
    const netMs = since(t1);
    const n = inspect(got);
    if (!n) throw util.error('parse', '取ってきたものが、辞書の形でない');
    use(got, n, 'net', false);
    const t2 = tick();
    // 3. 保存に置く(訳したページを巻き添えで捨てない。置けなくても、このページの間は引ける)
    let saved = true;
    if (env.cache === false) saved = false;
    else {
      try { await store.site.set(C.key, { ver: C.ver, n, at: util.nowISO(), text: got }, { evict: false }); }
      catch (e){ saved = false; }
    }
    kept = saved;
    stat = { from: 'net', n, readMs, netMs, saveMs: since(t2), saved, looks: 0, lookMs: null };
    return { n, from: 'net', saved };
  }

  const dict = {
    // → Promise<{ n, from, saved }>。同時に呼ばれても、取ってくるのは1回。失敗したら、次に呼ばれたときにやり直す
    load(opt){
      if (text !== null) return Promise.resolve({ n: count, from, saved: kept });
      if (!loading) loading = doLoad(opt || {}).finally(() => { loading = null; });
      return loading;
    },
    ready: () => text !== null,
    lookup(query, opt){
      const a = tick(), r = lookup(query, opt);
      if (stat){ stat.looks++; stat.lookMs = since(a); }   // いちばん新しい1回の、引く時間
      return r;
    },
    timing: () => (stat ? Object.assign({}, stat) : null),
    format,
    // 保存に置いた写しを消す(メモリの分も)。次に引くとき、取り直す
    async clear(){ text = null; count = 0; from = null; kept = false; await store.site.del(C.key); }
  };

  Yomu.dict = dict;
})();

/* ---- core/aidict.js ---- */
// core/aidict.js — AI辞書(部品の約束 §7-4・§8-7)。「AIに聞く」を押したときだけ1回通信し、結果を端末に残す
//   site の ai/{頭文字}(a〜z、それ以外は '_')= { v, items: { [語|文のハッシュ]: { q, ctx, text, at, model } }, x }
//   同じ語を同じ文で聞いたら、2回目は通信しない。別の文で聞いたときは、前の答えを先に見せられる(peek)
//   回数には数える(llm が数える)。通信の記録には残さない(§8-6)
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, schema = Yomu.schema, store = Yomu.store, settings = Yomu.settings;
  const quota = Yomu.quota, llm = Yomu.llm, prompts = Yomu.prompts;
  const isPlain = util.isPlain;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const PRE = 'ai/';
  const INITIAL = /^[a-z_]$/;
  const NO_EVICT = { evict: false };       // 訳したページを巻き添えで捨てない書き方(§8-1)

  const bad = msg => util.error('bad', msg);
  const attempt = fn => Promise.resolve().then(fn);
  // 語の前後の空白を除き、間の空白を1つにそろえる(’ は ' に。単語帳の見出しと同じそろえ方)
  const tidy = q => (typeof q === 'string' ? q.replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ') : '');
  const idOf = q => tidy(q).toLowerCase();
  const initialOf = id => (/^[a-z]/.test(id) ? id[0] : '_');
  const ctxOf = en => util.hash53(en);
  const makeChunk = () => ({ v: schema.V.ai, items: {}, x: {} });
  const usable = rec => isPlain(rec) && typeof rec.text === 'string' && !!rec.text;

  // 渡されたものを確かめて、鍵を作る
  function args(q, en, needEn){
    const word = tidy(q), id = word.toLowerCase();
    if (!id) throw bad('aidict: 聞く語が無い');
    if (word.length > config.aidict.qMax) throw bad('aidict: 聞く語句が長すぎる: ' + word.length + ' 文字');
    const sent = typeof en === 'string' ? en.trim() : '';
    if (!sent && needEn) throw bad('aidict: 英文が無い');
    const ctx = sent ? ctxOf(sent) : null;
    return { q: word, id, en: sent, ctx, key: ctx ? id + '|' + ctx : null, path: PRE + initialOf(id) };
  }
  // かたまりの中の結果(無ければ空)。読むだけなので、形の版が新しくても、読めるものは読む
  async function itemsOf(path){
    await store.init();
    const chunk = await store.site.get(path);
    return isPlain(chunk) && isPlain(chunk.items) ? chunk.items : {};
  }
  // 保存にあるもの → { same: 同じ文での答え, other: 別の文での、いちばん新しい答え }
  async function find(a){
    const items = await itemsOf(a.path);
    const same = a.key && has(items, a.key) && usable(items[a.key]) ? items[a.key] : null;
    let other = null;
    Object.keys(items).forEach(k => {
      const rec = items[k];
      if (k === a.key || !usable(rec) || idOf(rec.q) !== a.id) return;
      if (!other || String(rec.at || '') > String(other.at || '')) other = rec;
    });
    return { same, other };
  }

  // ---- 送る前の関所(送ってよいか)----
  //   今は「今日、このモデルで1日の上限に当たった印」だけ(印があれば送らない。2026-10-04 利用者)
  //   端末の側の縛り(1日に聞ける回数 など)や、利用者ごとの回数の管理を足すときは、ここに足す(§7-4)
  async function gate(model){
    const hit = await quota.hit(model).catch(() => false);      // 数えの失敗で、聞くのを止めない
    if (hit) throw util.error('limit-day', '今日は、このモデルの1日の上限に当たっている(送らない)', { sent: false, model });
  }

  // ---- 保存 ----
  // 残っている結果の全部 → [{ path, key, at }]
  async function all(){
    const out = [];
    for (const k of await store.site.keys(PRE)){
      if (!INITIAL.test(k.slice(PRE.length))) continue;
      const items = await itemsOf(k);
      Object.keys(items).forEach(key => out.push({ path: k, key, at: String((isPlain(items[key]) && items[key].at) || '') }));
    }
    return out;
  }
  // 古い順に n 件捨てる
  async function dropOldest(list, n){
    const drop = list.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, Math.max(0, n));
    const byPath = new Map();
    drop.forEach(d => { if (!byPath.has(d.path)) byPath.set(d.path, []); byPath.get(d.path).push(d.key); });
    for (const [path, keys] of byPath){
      await store.site.update(path, cur => {
        if (!isPlain(cur) || !isPlain(cur.items) || schema.newer('ai', cur)) return undefined;
        keys.forEach(k => { delete cur.items[k]; });
        return cur;
      }, NO_EVICT);
    }
  }
  // 1件残す → 残せたか。入らなければ、AI辞書の古い結果を捨ててやり直す(訳したページは捨てない)
  async function save(a, text, model){
    const rec = { q: a.q, ctx: a.ctx, text, at: util.nowISO(), model };
    try {
      for (let n = 0; ; n++){
        try {
          await store.site.update(a.path, cur => { const chunk = schema.open('ai', cur, makeChunk); chunk.items[a.key] = rec; return chunk; }, NO_EVICT);
          break;
        } catch (e){
          if (!e || e.kind !== 'full' || n >= config.aidict.dropTries) return false;
          const list = await all();
          if (!list.length) return false;
          await dropOldest(list, Math.max(1, Math.ceil(list.length * config.aidict.dropShare)));
        }
      }
    } catch (e){ return false; }
    // aidict.keep 件を超えた分を、古い順に捨てる(失敗しても、答えは残っている)
    try { const list = await all(); if (list.length > config.aidict.keep) await dropOldest(list, list.length - config.aidict.keep); } catch (e){}
    return true;
  }

  // ---- 聞く ----
  // 答えの終わりに AI が付ける、文字数の添え書き「(115文字)」を除く(指示文が長さを頼んでいるので、数えて書いてくることがある。工程5a・実機。全角のかっこと数字は、番号で書く=書く道具が半角に変えるため)
  const TAIL = /[\s\u3000]*[(\uFF08][\s\u3000]*(?:約|計|全|合計)?[\s\u3000]*[0-9\uFF10-\uFF19]+[\s\u3000]*(?:文字|字)[\s\u3000]*[)\uFF09][\s\u3000]*$/;
  const clean = text => { let t = String(text || '').trim(); while (TAIL.test(t)) t = t.replace(TAIL, '').trim(); return t; };
  const flying = new Map();     // いま聞いている最中のもの(同じ語・同じ文を続けて押しても、通信は1回)
  async function send(a, o){
    await settings.load();                                     // 別のタブで変えた設定を取り直す
    const model = settings.get().aux.dict;
    const prompt = prompts.dict({ q: a.q, en: a.en, jp: o.jp, scene: o.scene });
    await gate(model);
    const r = await llm.call({ role: 'dict', model, think: 'none', prompt, json: false, signal: o.signal, onText: typeof o.onText === 'function' ? o.onText : undefined });
    const text = clean(r.text);
    if (r.finish === 'blocked') throw util.error('blocked', '内容で断られた', { sent: true, model: r.model, block: r.block });
    if (!text) throw util.error('parse', '返事が空だった', { sent: true, model: r.model });
    // 途中で切れた答えは、見せるが、残さない(次に押したら、聞き直す)
    if (r.finish !== 'stop') return { text, cached: false, saved: false, partial: true };
    return { text, cached: false, saved: await save(a, text, r.model || model), partial: false };
  }

  const aidict = {
    // 聞く。保存にあれば、通信しない
    //   { q, en, jp?, scene?, signal?, onText? } → { text, cached, saved, partial }
    //   失敗は reject: bad(渡すものがおかしい)・limit-day(今日の上限の印がある。送っていない)・blocked・parse・llm の失敗(§5-5)
    ask: o => attempt(async () => {
      if (!isPlain(o)) throw bad('aidict.ask: 渡すものがおかしい');
      const a = args(o.q, o.en, true);
      const hit = await find(a);
      if (hit.same) return { text: clean(hit.same.text), cached: true, saved: true, partial: false };   // 前の版が残した答えにも、添え書きがある
      if (flying.has(a.key)) return flying.get(a.key);
      const p = send(a, o);
      flying.set(a.key, p);
      const done = () => { if (flying.get(a.key) === p) flying.delete(a.key); };
      p.then(done, done);
      return p;
    }),
    // 保存にあれば返す(通信なし)→ { text, same, at } | null。same = 同じ文での答えか(false なら「前に聞いた意味」)
    peek: (q, en) => attempt(async () => {
      const hit = await find(args(q, en, false));
      const rec = hit.same || hit.other;
      return rec ? { text: clean(rec.text), same: !!hit.same, at: rec.at || null } : null;
    }),
    // 残っている結果の件数(設定の画面や検査で使う)
    count: () => attempt(all).then(list => list.length)
  };

  aidict.clean = clean;
  Yomu.aidict = aidict;
})();

/* ---- core/vocab.js ---- */
// core/vocab.js — 単語帳(部品の約束 §8-7)。フェーズ1 は保存だけ(復習はフェーズ2 が x に足す)
//   shared の p/{pid}/vocab/{頭文字}(a〜z、それ以外は '_')。入るのは、利用者が「単語帳に追加」を押したときだけ
//   外した語は、意味・出会った形・例文を消して、外した印(del)だけを残す(別の端末から読み込んだときに、戻ってこないように)
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, schema = Yomu.schema, store = Yomu.store;
  const isPlain = util.isPlain;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const KINDS = ['word', 'idiom'];
  const SRCS = ['idiom', 'dict', 'ai'];
  const PRE = 'vocab/';
  const INITIAL = /^[a-z_]$/;

  const bad = msg => util.error('bad', msg);
  const attempt = fn => Promise.resolve().then(fn);
  const str = v => (typeof v === 'string' ? v : '');
  // 見出しの前後の空白を除き、間の空白を1つにそろえる(’ は ' に)
  const tidy = head => (typeof head === 'string' ? head.replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ') : '');
  const idOf = head => tidy(head).toLowerCase();
  const initialOf = id => (/^[a-z]/.test(id) ? id[0] : '_');
  // items の中の鍵。入れ物の名前とぶつかる語(constructor・prototype など)は、前に ~ を付ける
  const keyOf = id => (util.safeKey(id) ? id : '~' + id);
  const checkId = id => {
    if (!id) throw bad('見出しが空');
    if (id.length > config.vocab.headMax) throw bad('見出しが長すぎる: ' + id.length + ' 文字');
    return id;
  };
  const tooNew = what => util.error('newer', '新しい版のデータなので、書き換えない: ' + what);
  // かたまりの中の語(無ければ空)。形の版が新しければ失敗
  async function itemsOf(initial){
    await store.init();
    const chunk = await store.shared.get(PRE + initial);
    if (schema.newer('vocab', chunk)) throw tooNew(PRE + initial);
    return isPlain(chunk) && isPlain(chunk.items) ? chunk.items : {};
  }
  const live = it => isPlain(it) && it.del == null;
  const find = async id => { const items = await itemsOf(initialOf(id)); const k = keyOf(id); return has(items, k) && isPlain(items[k]) ? items[k] : undefined; };
  // 例文1つ(§8-7)。at は、入れた時刻
  function example(ex, now){
    if (!isPlain(ex) || typeof ex.en !== 'string' || !ex.en) throw bad('例文がおかしい');
    const title = typeof ex.title === 'string' ? ex.title : isPlain(ex.title) ? util.clone(ex.title) : '';
    return { en: ex.en, jp: str(ex.jp), page: ex.page == null ? null : String(ex.page), work: ex.work == null ? null : String(ex.work), title, at: now };
  }

  const vocab = {
    id: idOf,
    // 入れる。もう入っている語なら、出会った形と例文を足し、意味を新しいものにする。外した語なら、入れ直す
    add: item => attempt(async () => {
      if (!isPlain(item)) throw bad('単語帳に入れるものがおかしい');
      const head = tidy(item.head), id = checkId(idOf(item.head));
      const kind = item.kind === undefined ? 'word' : item.kind;
      if (!KINDS.includes(kind)) throw bad('語の種類がおかしい: ' + item.kind);
      if (item.mean != null && typeof item.mean !== 'string') throw bad('意味がおかしい');
      const src = item.meanSrc == null ? null : item.meanSrc;
      if (src !== null && !SRCS.includes(src)) throw bad('意味の出どころがおかしい: ' + item.meanSrc);
      if (item.form != null && typeof item.form !== 'string') throw bad('出会った形がおかしい');
      const now = util.nowISO();
      const ex = item.ex == null ? null : example(item.ex, now);
      const form = tidy(item.form);
      await store.init();
      let out;
      await store.shared.update(PRE + initialOf(id), cur => {
        const chunk = schema.open('vocab', cur, schema.make.vocabChunk);
        const key = keyOf(id);
        let it = has(chunk.items, key) && isPlain(chunk.items[key]) ? chunk.items[key] : null;
        if (it && schema.newer('vitem', it)) throw tooNew(id);
        const fresh = !live(it);                                    // 新しく入れる・入れ直す
        it = chunk.items[key] = schema.fill(it || {}, schema.make.vocabItem());
        if (!Array.isArray(it.forms)) it.forms = [];
        if (!Array.isArray(it.ex)) it.ex = [];
        if (fresh) Object.assign(it, { head, kind, mean: '', meanSrc: null, forms: [], ex: [], at: now, del: null });
        it.id = id;
        if (!it.head) it.head = head;
        if (item.mean){ it.mean = item.mean; it.meanSrc = src; }
        if (form && form !== it.head && !it.forms.includes(form)) it.forms.push(form);
        if (ex && !it.ex.some(e => isPlain(e) && e.en === ex.en)) it.ex.push(ex);
        while (it.ex.length > config.vocab.exMax) it.ex.shift();    // 古いものから外す
        it.upd = now;
        out = util.clone(it);
        return chunk;
      });
      return out;
    }),
    // 外す: 意味・出会った形・例文を消して、外した印だけを残す → 入っていたものを外したら true
    remove: head => attempt(async () => {
      const id = checkId(idOf(head));
      await store.init();
      let removed = false;
      await store.shared.update(PRE + initialOf(id), cur => {
        const chunk = schema.open('vocab', cur, schema.make.vocabChunk);
        const key = keyOf(id);
        const it = has(chunk.items, key) ? chunk.items[key] : null;
        if (!live(it)) return undefined;
        if (schema.newer('vitem', it)) throw tooNew(id);
        const now = util.nowISO();
        Object.assign(it, { mean: '', meanSrc: null, forms: [], ex: [], upd: now, del: now });
        removed = true;
        return chunk;
      });
      return removed;
    }),
    has: head => attempt(() => find(checkId(idOf(head)))).then(live),
    // 外した語も返す(del に、外した時刻が入っている)
    get: head => attempt(() => find(checkId(idOf(head)))).then(it => util.clone(it)),
    // 入っている語の全部(外したものを除く)。入れた時刻の新しい順
    all: () => attempt(async () => {
      await store.init();
      const out = [];
      for (const k of await store.shared.keys(PRE)){
        const initial = k.slice(PRE.length);
        if (!INITIAL.test(initial)) continue;
        const items = await itemsOf(initial);
        Object.keys(items).forEach(key => { if (live(items[key])) out.push(items[key]); });
      }
      const at = it => String(it.at || ''), id = it => String(it.id || '');
      return out.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
    }),
    count: () => vocab.all().then(list => list.length)
  };

  Yomu.vocab = vocab;
})();

/* ---- core/log.js ---- */
// core/log.js — 読んだ記録(部品の約束 §8-8)。事実をそのまま残す(判定はしない)
//   まとめ: shared の p/{pid}/log/{学習日}(ひと続きごとの数字。長く残す)/詳しい分: site の logx/{学習日}(段落ごとの時間と操作の明細。消えることがある)
//   画面を見張って1秒ごとに数えるのは page/watch.js。ここは、渡された数字を、ひと続きに区切って保存するだけ(DOM もタイマーも使わない)
(function(){
  'use strict';
  const util = Yomu.util, config = Yomu.config, schema = Yomu.schema, store = Yomu.store, settings = Yomu.settings;
  const isPlain = util.isPlain;
  const LOG = 'log/', LOGX = 'logx/';
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const ROW = ['jc', 'sn', 'tg', 'se', 'ew', 'je'];   // 段落ごとの数(§8-8 の Row。p のほか)

  const bad = msg => util.error('bad', msg);
  const attempt = fn => Promise.resolve().then(fn);
  const num = v => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  const str = v => (typeof v === 'string' && v ? v : null);
  const cut = v => (typeof v === 'string' ? v.slice(0, config.log.titleMax) : '');
  const nowMs = () => Date.parse(util.nowISO());
  const isoOf = ms => new Date(ms).toISOString();
  const tooNew = what => util.error('newer', '新しい版のデータなので、読まない: ' + what);
  const byT0 = (a, b) => { const x = String((a && a.t0) || ''), y = String((b && b.t0) || ''); return x < y ? -1 : x > y ? 1 : 0; };

  // ---- 設定(読んだ記録を残すか・詳しい分を残すか)。open のときと、書くたびに見直す。変えた合図でも直す ----
  let conf = null, onAt = 0;   // onAt = 「残さない」から「残す」に変わった時刻
  const confOf = s => ({ on: !(isPlain(s.log) && s.log.on === false), detail: isPlain(s.log) && s.log.detail === 'lite' ? 'lite' : 'full' });
  const setConf = next => { if (conf && !conf.on && next.on) onAt = nowMs(); return (conf = next); };
  const readConf = () => setConf(confOf(settings.get()));
  settings.on(s => { setConf(confOf(s)); });

  // ---- 表示の状態(ひと続きを区切るもの) ----
  // 段落ごとの数をそろえる(同じ番号の段落が2度来たら、あとのものは捨てる)
  function rowsOf(paras){
    const seen = new Set(), rows = [];
    (Array.isArray(paras) ? paras : []).forEach((r, i) => {
      if (!isPlain(r)) return;
      const row = { p: typeof r.p === 'number' && isFinite(r.p) ? r.p : i };
      if (seen.has(row.p)) return;
      seen.add(row.p);
      ROW.forEach(k => { row[k] = num(r[k]); });
      rows.push(row);
    });
    return rows;
  }
  // 前の状態に、変わった欄を重ねる。sig が同じなら、同じ表示(区切らない)
  function stateOf(prev, patch){
    const pick = (k, fn) => (patch[k] !== undefined ? fn(patch[k]) : prev ? prev[k] : fn(undefined));
    const s = {
      ratio: pick('ratio', num), level: pick('level', str), style: pick('style', str), orig: pick('orig', v => (v ? 1 : 0)), tr: pick('tr', str),
      model: pick('model', str), promptV: pick('promptV', v => (typeof v === 'string' || typeof v === 'number' ? v : null))
    };
    if (patch.paras !== undefined || !prev){
      s.rows = rowsOf(patch.paras);
      s.rowsSig = JSON.stringify(s.rows.map(r => [r.p].concat(ROW.map(k => r[k]))));
    } else { s.rows = prev.rows; s.rowsSig = prev.rowsSig; }
    s.sig = JSON.stringify([s.ratio, s.level, s.style, s.orig, s.tr]) + s.rowsSig;
    return s;
  }

  // ---- ひと続き(数えている途中の形) ----
  function newStretch(state, t0){
    const n = {};
    schema.acts.forEach(k => { n[k] = 0; });
    return { id: util.uid('st'), state, t0, t1: t0, day: util.dayOf(isoOf(t0), config.dayBoundaryHour), vis: 0, act: 0, ds: new Map(), n, ev: [], dirty: false, finished: false };
  }
  // 出来事を1つ、ひと続きに足す
  function apply(st, e){
    if (e.type === 'dwell'){
      st.vis += e.sec;
      if (e.act){
        st.act += e.sec;
        e.list.forEach(([p, share]) => { st.ds.set(p, (st.ds.get(p) || 0) + share * e.sec * 10); });   // このページに無い段落の分は、保存する形にするときに落ちる
      }
    } else {
      st.n[e.kind]++;
      if (st.ev.length < config.log.evMax) st.ev.push(e);
    }
    if (e.t > st.t1) st.t1 = e.t;
    st.dirty = true;
  }
  const keepable = st => st.vis >= config.log.minSec;
  // 保存する形: まとめ(Stretch)と、詳しい分(Detail)
  function shapeOf(st, base, visit){
    const s = st.state;
    const rec = schema.make.stretch(), detail = schema.make.detail();
    Object.assign(rec, base, { id: st.id, visit, t0: isoOf(st.t0), t1: isoOf(st.t1), level: s.level, tr: s.tr, ratio: s.ratio, orig: s.orig, style: s.style,
      vis: Math.round(st.vis), act: Math.round(st.act), n: Object.assign({}, st.n) });
    let last = -1;
    s.rows.forEach((r, i) => {
      const ds = Math.round(st.ds.get(r.p) || 0);
      rec.all.paras++; rec.all.sents += r.sn; rec.all.targets += r.tg; rec.all.jpChars += r.jc; rec.all.enSents += r.se; rec.all.enWords += r.ew; rec.all.enJpChars += r.je;
      if (ds >= 1) detail.paras.push([r.p, ds, r.jc, r.sn, r.se, r.ew, r.je]);
      if (ds < config.log.seenMinDs) return;          // 「画面に出た段落」= 出ていた時間が seenMinDs 以上
      rec.seen.paras++; rec.seen.sents += r.sn; rec.seen.jpChars += r.jc; rec.seen.enSents += r.se; rec.seen.enWords += r.ew; rec.seen.enJpChars += r.je;
      last = i;
    });
    rec.reach = last < 0 ? 0 : Math.round((last + 1) / s.rows.length * 1000) / 1000;
    Object.assign(detail, { t1: rec.t1, model: s.model, promptV: s.promptV });
    detail.ev = st.ev.map(e => { const row = [Math.max(0, Math.round((e.t - st.t0) / 100)), e.kind, e.sid]; if (e.extra !== undefined) row.push(e.extra); return row; });
    return { rec, detail };
  }

  // ---- 保存に書く ----
  // 知らない欄と x は残して、上書きする
  const overlay = (old, fresh) => (isPlain(old) ? Object.assign(old, fresh, { x: isPlain(old.x) ? old.x : fresh.x }) : fresh);
  function putSummary(day, recs){
    return store.shared.update(LOG + day, cur => {
      const chunk = schema.open('log', cur, () => schema.make.logDay(day));
      if (!Array.isArray(chunk.items)) chunk.items = [];
      recs.forEach(rec => {
        const i = chunk.items.findIndex(e => isPlain(e) && e.id === rec.id);
        if (i < 0) chunk.items.push(rec); else chunk.items[i] = overlay(chunk.items[i], rec);
      });
      chunk.items.sort(byT0);
      return chunk;
    });
  }
  // 詳しい分は、何も捨てない書き方で書く(訳したページを巻き添えにしない)。いっぱいなら、詳しい分の古い日を半分捨てて、1回だけやり直す
  async function putDetail(day, pairs){
    const path = LOGX + day;
    const put = () => store.site.update(path, cur => {
      const chunk = schema.open('logx', cur, () => schema.make.logxDay(day));
      pairs.forEach(([id, detail]) => { chunk.items[id] = overlay(chunk.items[id], detail); });
      return chunk;
    }, { evict: false });
    try { await put(); }
    catch (e){
      if (!e || e.kind !== 'full') throw e;
      const keys = (await store.site.keys(LOGX)).filter(k => k !== path).sort();
      const drop = keys.slice(0, Math.ceil(keys.length / 2));
      if (!drop.length) throw e;
      for (const k of drop) await store.site.del(k);
      await put();
    }
  }
  let pruned = false;   // 古い日を捨てるのは、ページを開いてから最初に書いたあとの1回
  // jobs = [{ st, day, rec, detail, full }] → 全部書けたら true
  async function persist(jobs, done){
    if (!jobs.length) return true;
    try {
      await store.init();
      const days = Array.from(new Set(jobs.map(j => j.day))).sort();
      for (const day of days){
        const mine = jobs.filter(j => j.day === day);
        mine.forEach(j => { j.rec.dev = store.deviceId; });
        await putSummary(day, mine.map(j => j.rec));
        const pairs = mine.filter(j => j.full).map(j => [j.rec.id, j.detail]);
        if (pairs.length) await putDetail(day, pairs).catch(() => {});   // 詳しい分は、書けなければあきらめる(まとめは残る)
      }
    } catch (e){
      // 書けなかった分は、次に書くときにやり直す
      jobs.forEach(j => { j.st.dirty = true; if (j.st.finished && !done.includes(j.st)) done.push(j.st); });
      return false;
    }
    if (!pruned){ pruned = true; await log.prune().catch(() => null); }
    return true;
  }

  const log = { kinds: schema.acts.slice() };

  // ページを英語まじりで出したとき(page/watch.js が呼ぶ)→ handle
  log.open = function(ctx){
    if (!isPlain(ctx) || typeof ctx.page !== 'string' || !ctx.page) throw bad('読んだ記録を始められない(page が無い)');
    const title = isPlain(ctx.title) ? ctx.title : {};
    const base = { page: ctx.page, work: str(ctx.work), site: str(ctx.site), title: { work: cut(title.work), ep: cut(title.ep) } };
    const visit = util.uid('v');
    readConf();
    let want = stateOf(null, ctx);           // いまの表示
    let cur = newStretch(want, nowMs());     // いまのひと続き
    let changedAt = null;                    // 表示が変わって、落ち着くのを待っているとき: 最後に変わった時刻
    let buf = [];                            // 待つ間の出来事(落ち着いた先のひと続きに入れる)
    const done = [];                         // 区切りがついて、まだ書いていないひと続き
    let closed = false, paused = false, lastFlush = nowMs(), chain = Promise.resolve(true);

    const drain = () => { buf.forEach(e => apply(cur, e)); buf = []; };
    // 落ち着いたかを確かめる。落ち着いていたら、最後に変わった時刻で区切る
    function settle(now){
      if (changedAt === null) return;
      if (now < changedAt) changedAt = now;                       // 端末の時計が戻された: 待ちつづけないように、そこから数え直す
      if (want.sig !== cur.state.sig && now - changedAt < config.log.settleMs) return;
      if (want.sig !== cur.state.sig){
        if (changedAt >= cur.t0) cur.t1 = changedAt;
        cur.finished = true;
        if (keepable(cur)){ cur.dirty = true; done.push(cur); }   // minSec に満たないものは捨てる
        cur = newStretch(want, changedAt);
      }
      drain();
      changedAt = null;
    }
    // 残さない設定のあいだは、数えない。また残すようになったら、そこから新しく始める
    function live(now){
      if (closed) return false;
      if (!conf.on){ paused = true; return false; }
      if (paused){ paused = false; done.length = 0; buf = []; changedAt = null; cur = newStretch(want, onAt && onAt <= now ? onAt : now); }
      return true;
    }
    function push(e){ if (changedAt === null) apply(cur, e); else buf.push(e); }
    // いま書くものを取り出す(ここまでは、待たずに済ませる)
    function snapshot(final){
      const now = nowMs();
      lastFlush = now;
      readConf();
      if (!conf.on){ paused = true; return []; }
      if (paused) return [];
      settle(now);
      if (final) drain();                    // 落ち着く前にページを離れた: 待っていた分は、前のひと続きに入れる
      const list = done.splice(0);
      if (keepable(cur) && cur.dirty) list.push(cur);
      return list.map(st => { st.dirty = false; return Object.assign({ st, day: st.day, full: conf.detail === 'full' }, shapeOf(st, base, visit)); });
    }
    function flush(final){
      const jobs = snapshot(final);
      chain = chain.then(() => persist(jobs, done)).then(ok => ok, () => false);
      return chain;
    }

    return {
      visit,
      // 表示が変わった(変わった欄だけを渡す)
      state(patch){
        if (closed || !isPlain(patch)) return;
        const now = nowMs();
        settle(now);
        const next = stateOf(want, patch);
        if (next.sig === want.sig){                              // 表示は同じ(モデルの名前などだけが変わった)
          if (changedAt === null) cur.state = next;
          want = next;
          return;
        }
        drain();                                                 // ここまでに待っていた分は、変えている途中の時間=前のひと続きに入れる
        want = next;
        changedAt = want.sig === cur.state.sig ? null : now;     // もとに戻ったら、分けない
      },
      // 操作(Stretch.n の名前)。extra は数だけ(文字は残さない)
      act(kind, sid, extra){
        const now = nowMs();
        if (!live(now) || !schema.acts.includes(kind)) return false;
        settle(now);
        const e = { type: 'act', t: now, kind, sid: typeof sid === 'number' && isFinite(sid) ? sid : null };
        if (typeof extra === 'number' && isFinite(extra)) e.extra = extra;
        push(e);
        return true;
      },
      // 画面が見えていた sec 秒。list = [[段落の番号, 配る割合]…]。opt.act が false なら、操作が途切れている(段落には配らない)
      dwell(list, opt){
        const now = nowMs();
        if (now < lastFlush) lastFlush = now;                    // 端末の時計が戻された
        if (!closed && now - lastFlush >= config.log.flushSec * 1000) flush(false);
        if (!live(now)) return;
        const sec = opt && opt.sec !== undefined ? opt.sec : 1;
        if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return;
        settle(now);
        const pairs = (Array.isArray(list) ? list : []).filter(r => Array.isArray(r) && typeof r[0] === 'number' && num(r[1]) > 0);
        const total = pairs.reduce((s, r) => s + r[1], 0);
        push({ type: 'dwell', t: now, sec, act: !(opt && opt.act === false), list: pairs.map(r => [r[0], r[1] / total]) });
      },
      flush(){ return closed ? chain : flush(false); },
      close(){
        if (closed) return chain;
        const out = flush(true);
        closed = true;
        return out;
      }
    };
  };

  // 日ごとのまとめ(日の古い順)。from・to は学習日(両端をふくむ)
  log.days = opt => attempt(async () => {
    opt = opt || {};
    ['from', 'to'].forEach(k => { if (opt[k] != null && (typeof opt[k] !== 'string' || !DAY.test(opt[k]))) throw bad(k + ' の日がおかしい: ' + opt[k]); });
    await store.init();
    const out = [];
    for (const k of (await store.shared.keys(LOG)).sort()){
      const day = k.slice(LOG.length);
      if (!DAY.test(day) || (opt.from && day < opt.from) || (opt.to && day > opt.to)) continue;
      const chunk = await store.shared.get(k);
      if (schema.newer('log', chunk)) throw tooNew(k);
      const items = isPlain(chunk) && Array.isArray(chunk.items) ? chunk.items.filter(isPlain) : [];
      if (items.length) out.push({ day, items });
    }
    return out;
  });
  // その日の詳しい分(無ければ null)
  log.detail = day => attempt(async () => {
    if (typeof day !== 'string' || !DAY.test(day)) throw bad('日がおかしい: ' + day);
    await store.init();
    const chunk = await store.site.get(LOGX + day);
    if (schema.newer('logx', chunk)) throw tooNew(LOGX + day);
    return isPlain(chunk) && isPlain(chunk.items) ? chunk.items : null;
  });
  // 古い日を捨てる → 捨てた日の数。詳しい分を残す日数は、保存先で変わる(IndexedDB でなければ、短くする)
  log.prune = async function(now){
    await store.init();
    const today = util.today(now == null ? util.nowISO() : now, config.dayBoundaryHour);
    const sweep = async (area, pre, keep) => {
      let n = 0;
      for (const k of await area.keys(pre)){
        const day = k.slice(pre.length);
        if (!DAY.test(day) || util.diffDays(day, today) <= keep) continue;
        await area.del(k);
        n++;
      }
      return n;
    };
    const xKeep = config.log.xKeepDays;
    return { log: await sweep(store.shared, LOG, config.log.keepDays), logx: await sweep(store.site, LOGX, store.site.backend === 'idb' ? xKeep.idb : xKeep.ls) };
  };

  Yomu.log = log;
})();

/* ---- core/translate.js ---- */
// core/translate.js — 翻訳と熟語さがしの呼び出し(部品の約束 §6-5)。どちらも、1回の呼び出し = 1回の通信(送り直さない)
//   指示文は core/prompts.js、送る本文と返事の確かめは core/wire.js、通信は core/llm.js(回数も llm が数える)。
//   ここが持つのは: どの文を送るかを決める・届いた順に呼んだ側へ渡す・通信の記録(§8-6)を残す。
//   訳したページ(PageRec。§8-4)は、ここでは書かない(届いた文を保存するのは、進行役 page/controller.js)。
//   今日の上限の印(quota.hit)も、ここでは見ない(見るのは進行役。§6-7)
(function(){
  'use strict';
  const Y = Yomu;   // あとから読み込まれる Yomu.tokens(工程3d)は、Y.tokens と読む
  const util = Y.util, config = Y.config, levels = Y.levels, text = Y.text, settings = Y.settings, runs = Y.runs, llm = Y.llm, prompts = Y.prompts, wire = Y.wire;
  const isPlain = util.isPlain;
  const bad = msg => util.error('bad', msg);
  const attempt = fn => Promise.resolve().then(fn);
  const str = v => (typeof v === 'string' ? v.trim() : '');

  function checkModel(model){
    if (!model || !Array.isArray(model.paras) || !Array.isArray(model.sents) || !Array.isArray(model.targets)) throw bad('文のデータがおかしい');
  }
  // 保存した訳(PageRec.s)を、今のページの文に突き合わせる(h と o。§8-4)→ Map<sid, 保存の1件>
  function match(model, rec){
    checkModel(model);
    const keyOf = x => x.h + '|' + (x.o || 0);       // 同じ文が何番目か(o)の欄が無ければ、0 番目
    const by = new Map();
    (isPlain(rec) && Array.isArray(rec.s) ? rec.s : []).forEach(e => {
      if (isPlain(e) && typeof e.en === 'string' && e.en.trim() && !by.has(keyOf(e))) by.set(keyOf(e), e);   // 同じ文の保存が2つあれば、先のもの
    });
    const out = new Map();
    model.sents.forEach(s => { const e = by.get(keyOf(s)); if (e) out.set(s.sid, e); });
    return out;
  }
  // まだ訳の無い、対象の文 → [sid…]
  function missing(model, rec){
    const have = match(model, rec);
    return model.targets.filter(sid => !have.has(sid));
  }
  // 翻訳のモデルと思考。use = 設定と違うモデルで訳すとき(モデルの名前か、{ m, think }。名前だけなら、思考なし)
  function aiFor(level, use){
    if (use == null) return settings.modelFor(level);
    if (typeof use === 'string' && use.trim()) return { m: use.trim(), think: 'none' };
    if (isPlain(use) && typeof use.m === 'string' && use.m.trim()) return { m: use.m.trim(), think: use.think == null ? 'none' : use.think };
    throw bad('モデルの指定がおかしい');
  }
  const pageOf = o => (typeof o.page === 'string' ? o.page : o.model.info && typeof o.model.info.pageKey === 'string' ? o.model.info.pageKey : undefined);
  // 呼んだ側の関数(on.item など)の中の失敗で、通信と記録を止めない。最初の失敗を覚えておき、終わってから投げる
  function teller(){
    const note = e => { if (!t.err) t.err = e || new Error('on の中の失敗'); };
    const t = { err: null, call(fn, args){
      if (typeof fn !== 'function' || t.err) return;
      try { const r = fn.apply(null, args); if (r && typeof r.then === 'function') r.then(null, note); }      // async の関数が、あとから失敗しても、取りこぼさない
      catch (e){ note(e); }
    } };
    return t;
  }

  // 相手が返したエラーの中身(通信の記録の err.raw)に、ページの文章がまぎれないようにする:
  //   文字が届いたあとのエラーは、控えない(届いた訳といっしょに返ってきた1件かもしれない)。かな・漢字は、伏せる(相手のエラーの文は英語)
  const JA_RUN = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]+/gu;
  const rawOf = err => (err.partial || typeof err.raw !== 'string' ? undefined : err.raw.replace(JA_RUN, '…'));

  // 1回の通信と、その記録。x = { role, ai:{ m, think }, prompt, signal, push(text), end(finish) → rep, meta:{ page, level, tr, sent }, x? }(x.x = 通信の記録の x の欄)
  //   記録に残すのは、送ったものだけ(戻りは全部。失敗は e.sent が true のものだけ)。記録の失敗では、訳を捨てない
  async function exchange(x){
    let r = null, err = null;
    try {
      r = await llm.call({ role: x.role, model: x.ai.m, think: x.ai.think, prompt: x.prompt, json: true, signal: x.signal, onText: x.push });
    } catch (e){ err = e || new Error('通信の失敗'); }
    const rep = x.end(r ? r.finish : err.kind === 'abort' ? 'abort' : 'error');
    const src = r || err;
    let run = null;
    if (r || err.sent === true){
      try {
        run = await runs.add({
          role: x.role, model: src.model || x.ai.m, think: x.ai.think, provider: src.provider, promptV: prompts.V, wireV: wire.V,
          page: x.meta.page, level: x.meta.level, tr: x.meta.tr, sent: x.meta.sent, rep, finish: rep.finish,
          ms: src.ms, firstMs: src.firstMs, usage: src.usage, qday: src.qday,
          err: err ? { kind: err.kind, status: err.status, quotaId: err.quotaId, raw: rawOf(err) } : null,
          x: x.x                                     // 熟語さがしは { iv: 熟語さがしの指示文の版 }(工程T-5b)。翻訳は無し
        });
      } catch (e){ run = null; }
    }
    return { r, err, rep, run, info: { model: src.model || x.ai.m, think: x.ai.think, provider: src.provider || null, promptV: prompts.V, wireV: wire.V } };
  }
  // 終わり方をまとめる: 失敗なら、確かめの数字などを付けて投げ直す(届いた分は、もう on.item で渡してある)
  function settle(res, tell, more){
    const out = Object.assign({ rep: res.rep, run: res.run }, res.info, more);
    if (res.r && res.r.block) out.block = res.r.block;
    if (tell.err) out.cbErr = tell.err;                       // 呼んだ側の関数(on.item など)の中の失敗。そこから先の文は、渡していない
    if (res.err){ try { Object.assign(res.err, out); } catch (e){} throw res.err; }
    if (tell.err) throw util.error('callback', 'on の中で失敗した: ' + String((tell.err && tell.err.message) || tell.err), out);
    return out;
  }

  // 送る前の失敗(渡すものがおかしい・保存を読めない)にも、戻りと同じ欄を付ける(中身は null。呼んだ側が e.rep を読んで転ばないように)
  const fields = (p, more) => p.catch(e => {
    if (e && typeof e === 'object' && !('rep' in e)){ try { Object.assign(e, { rep: null, run: null }, more); } catch (x){} }
    throw e;
  });

  const translate = { match, missing };

  // ---- 翻訳 ----
  //   o = { model: 文のデータ, level, scene?, sids?, rec?, use?, page?, tr?, signal?, fix?, on?: { item(sid, en, f, nk), progress(got, total) } }
  //   scene = 場面(prompts.SCENES。省くと novel。工程8e-2a)。どの場面で送るかを決めるのは、呼ぶ側
  //   fix = false なら、機械の直し(core/fix.js)を当てない(比べる台本だけが使う。エンジンは渡さない)
  //   sids を省くと: rec(保存した訳)があれば、まだ訳の無い対象の文。無ければ、対象の文の全部
  //   → { rep, run, model, think, provider, promptV, wireV, block? }(run = 通信の記録の id。残せなかったら null)
  //   失敗(reject)にも、同じ欄が付く(e.rep・e.run など)
  translate.page = o => fields(attempt(async () => {
    o = o || {};
    if (!levels.has(o.level)) throw bad('レベルがおかしい: ' + o.level);
    if (o.scene != null && !prompts.SCENES.includes(o.scene)) throw bad('場面がおかしい: ' + o.scene);
    const on = isPlain(o.on) ? o.on : {};
    await settings.load();                       // 別のタブで変えた設定を取り直す
    const ai = aiFor(o.level, o.use);
    const opt = { K: config.wire.K, E: config.wire.E, ruby: config.wire.ruby };
    let built = wire.build(o.model, o.sids == null ? (o.rec ? missing(o.model, o.rec) : null) : o.sids, opt);
    const max = config.wire.maxTargets;
    if (max > 0 && built.M > max) built = wire.build(o.model, built.map.slice(0, max), opt);   // 残りは未訳のまま(「続きを訳す」で拾う)
    const tell = teller();
    let got = 0;
    const give = it => {
      got++;
      tell.call(on.item, [it.sid, it.en, it.f, it.nk]);      // nk = 1: 番号だけで決めた文(目印を1つも返してこない返事。rep.suspect を見てから使う=進行役)
      tell.call(on.progress, [got, built.M]);
    };
    // 確かめ(§6-4)を通った文に、機械の直し(core/fix.js。工程T-2c)を当ててから渡す。o.fix が false なら、直さない(比べる台本が、AI の返事そのものを測るため)
    const fixer = o.fix === false ? null : Y.fix.stream({ model: o.model, sids: built.map, onItem: give });
    const reader = wire.reader({ model: o.model, map: built.map, marked: built.marked, K: built.K, E: built.E, onItem: fixer ? it => fixer.push(it) : give });
    const finish = f => (fixer ? fixer.end(reader.end(f)) : reader.end(f));
    // 送る文が無ければ、通信しない
    if (!built.M) return { rep: finish('stop'), run: null, model: ai.m, think: ai.think, provider: null, promptV: prompts.V, wireV: wire.V };
    const prompt = prompts.translate({ level: o.level, scene: o.scene, body: built.body, M: built.M, K: built.K, E: built.E, ruby: built.ruby });
    const res = await exchange({ role: 'translate', ai, prompt, signal: o.signal, push: t => reader.push(t), end: finish,
      meta: { page: pageOf(o), level: o.level, tr: o.tr, sent: { targets: built.M, chars: built.chars } } });
    return settle(res, tell);
  }));

  // ---- 熟語さがし ----
  // 熟語が、英文の中にあるか(現行のルール1 を機械でも確かめる)。語の途中に当たったもの(was の中の as)は、あることにしない
  const CURLY = new RegExp('[' + String.fromCharCode(0x2018, 0x2019) + ']', 'g');   // 曲がったアポストロフィ(番号で書く。engine/README.md の「書くときの注意」)
  const flat = s => String(s).replace(CURLY, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const WORDCH = /[\p{L}\p{N}]/u;
  function inText(hay, needle){
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)){
      const a = i > 0 ? hay[i - 1] : '', b = i + needle.length < hay.length ? hay[i + needle.length] : '';
      if (!(a && WORDCH.test(a) && WORDCH.test(needle[0])) && !(b && WORDCH.test(b) && WORDCH.test(needle[needle.length - 1]))) return true;
    }
    return false;
  }
  // 英文の中にある熟語の番号。単語の部品(core/tokens.js。工程3d)があれば、活用のゆれを吸収した当て方でも探す(現行と同じ拾い方)
  function grounded(en, words){
    const out = new Set(), hay = flat(en);
    words.forEach((x, i) => { if (inText(hay, flat(x.w))) out.add(i); });
    if (Y.tokens && typeof Y.tokens.split === 'function'){
      try { Y.tokens.split(en, words).forEach(t => { if (t && t.t === 'i' && Number.isInteger(t.i)) out.add(t.i); }); } catch (e){}
    }
    return out;
  }
  const GRAMMAR_ID = /^[A-Za-z0-9_.:-]+$/;
  // 熟語さがしの返事の読み方(§6-3。工程T-5b): 書きまちがえた1つのあとも、次の {"id": 番号, "words": から読み直す・配列が2つに分かれても、続きを読む
  //   (比べる台本 tools/exp_idioms.js も、これで読む)
  const IDIOM_READ = translate.IDIOM_READ = Object.freeze({ resync: 'words', more: true });
  // 熟語さがしの返事を読む。list = 送った [{ id, en, target_jp }]、sids = その通し番号 → sid
  function idiomReader(list, sids, onItem){
    const N = list.length, C = config.idioms;
    const rep = { sent: N, got: 0, missing: [], dup: 0, extra: 0, empty: 0, ungrounded: 0, over: 0, words: 0, finish: null };
    const seen = new Set();
    const arr = wire.array(it => {
      const id = it ? wire.idOf(it.id) : null;
      if (id === null || id >= N || !Array.isArray(it.words)){ rep.extra++; return; }
      if (seen.has(id)){ rep.dup++; return; }
      seen.add(id);
      // 形の合うものだけを取り出す(w と m は必ず要る)。同じ熟語の2つ目は、だまって除く
      const cand = [], had = new Set();
      it.words.forEach(x => {
        const w = isPlain(x) ? str(x.w) : '', m = isPlain(x) ? str(x.m) : '';
        if (!w || !m || m.length > C.mMax){ rep.empty++; return; }      // 長すぎる意味は、熟語の意味ではない(ページの文章を返してきた など)
        if (had.has(flat(w))) return;
        had.add(flat(w));
        const b = str(x.b);
        cand.push(b && b.length <= config.vocab.headMax && !text.hasJa(b) ? { w, b, m } : { w, m });
      });
      const ok = grounded(list[id].en, cand), words = [];
      cand.forEach((x, i) => {
        if (!ok.has(i)){ rep.ungrounded++; return; }
        if (words.length >= C.max){ rep.over++; return; }
        words.push(x);
      });
      rep.got++;
      rep.words += words.length;
      // 文法の印(工程G1 のあと)。単元の ID の形(英数字と . _ : -)だけを受け取る(相手が返した、そのほかの欄は残さない=ページの文章を、まぎれて保存しないため)
      const g = Array.isArray(it.g) ? it.g.filter(v => typeof v === 'string' && v.length <= C.gLen && GRAMMAR_ID.test(v)).slice(0, C.gMax) : [];
      onItem(sids[id], words, g.length ? g : undefined);
    }, IDIOM_READ);
    return {
      push(text){ arr.push(text); },
      // 1回だけ呼ぶ(通信が終わったとき)
      end(finish){
        arr.end();                                   // 配列の形でなかった返事は、ここで読み直される(wire.array)
        rep.missing = sids.filter((sid, n) => !seen.has(n));
        rep.finish = finish;
        return util.clone(rep);
      }
    };
  }

  //   o = { model: 文のデータ, rec: 保存した訳(PageRec), level, scene?, sids?, page?, tr?, signal?, on?: { item(sid, words, g) } }(scene は翻訳と同じ)
  //   送るのは、訳のある文。sids を省くと、そのうち、まだ熟語さがしをしていない文(保存の1件に w の欄が無いもの)
  //   → { rep, run, state, model, think, provider, promptV, wireV, iv }(iv = 熟語さがしの指示文の版 prompts.IV。通信の記録には x.iv で残す)
  //   state = 'done'(送った文が全部届いた)| 'partial'(届かなかった文がある)| 'failed'(1文も届かなかった)。失敗(reject)にも付く
  //   工程T-5b: 返事が最後まで来ても(finish が stop)、届かなかった文があれば partial(AI が途中で「…((TRUNCATED))」と書いて終える・書きまちがえた1つを捨てた、など)。
  //     届かなかった文は rep.missing。進行役は、そこに w を入れない(「熟語さがしをやり直す」で、その文だけを送り直せるように)
  translate.idioms = o => fields(attempt(async () => {
    o = o || {};
    if (!levels.has(o.level)) throw bad('レベルがおかしい: ' + o.level);
    if (o.scene != null && !prompts.SCENES.includes(o.scene)) throw bad('場面がおかしい: ' + o.scene);
    if (!isPlain(o.rec)) throw bad('保存した訳が無い');
    if (o.sids != null && !Array.isArray(o.sids)) throw bad('文の番号の並びがおかしい');
    const on = isPlain(o.on) ? o.on : {};
    await settings.load();
    const have = match(o.model, o.rec);
    const want = o.sids == null ? null : new Set(o.sids);
    const sids = o.model.sents.filter(s => have.has(s.sid) && (want ? want.has(s.sid) : have.get(s.sid).w === undefined)).map(s => s.sid);
    const bySid = new Map();
    o.model.sents.forEach(s => bySid.set(s.sid, s));
    const list = sids.map((sid, n) => ({ id: n, en: have.get(sid).en, target_jp: bySid.get(sid).text }));
    const ai = { m: settings.get().aux.idiom, think: 'none' };
    const tell = teller();
    const reader = idiomReader(list, sids, (sid, words, g) => tell.call(on.item, [sid, words, g]));
    const stateOf = rep => (!rep.got ? 'failed' : rep.finish === 'stop' && !rep.missing.length ? 'done' : 'partial');     // 1文も届かなければ、ふつうに終わっていても failed
    if (!list.length) return { rep: reader.end('stop'), run: null, state: 'done', model: ai.m, think: ai.think, provider: null, promptV: prompts.V, wireV: wire.V, iv: prompts.IV };
    const prompt = prompts.idioms({ level: o.level, scene: o.scene, list });
    const res = await exchange({ role: 'idiom', ai, prompt, signal: o.signal, push: t => reader.push(t), end: f => reader.end(f), x: { iv: prompts.IV },
      meta: { page: pageOf(o), level: o.level, tr: o.tr, sent: { targets: list.length, chars: list.reduce((n, x) => n + x.en.length, 0) } } });
    return settle(res, tell, { state: stateOf(res.rep), iv: prompts.IV });
  }), { state: 'failed', iv: prompts.IV });

  Yomu.translate = translate;
})();

/* ---- page/extract.js ---- */
// page/extract.js — 段落を文のデータに直す(部品の約束 §4-2)
//   段落の文字は、Text ノードを文書の順につないだもの。ルビの読み(rt・rp)と、エンジンが足した要素(.yomu-en・.yomu-chip)は除き、<br> は改行にする。
//   innerText は使わない(ルビの読みが混ざるため)。英文を描き込んだあとでも、同じ文字が得られる(包みの .yomu-s・.yomu-jp は素通りする)。
(function(){
  'use strict';
  const T = Yomu.text, config = Yomu.config, util = Yomu.util;
  const ENGINE = '.yomu-en,.yomu-chip';                 // エンジンが足した要素(文字として数えない)
  const ALWAYS = 'script,style,template,noscript';      // 段落の中にあっても、文字ではないもの
  const selOf = skip => [skip, ENGINE, ALWAYS].filter(Boolean).join(',');

  // 段落の文字 → { text, segs:[{ node, a, b }], ruby:[{ a, b, rt }] }
  //   Text ノードの中の改行(HTML の書き方のための改行)は、空白として数える(画面でも空白に見えるため。文字の数は変えない)。改行は <br> だけ
  function textOf(el, skip){
    const sel = selOf(skip);
    let text = '';
    const segs = [], ruby = [];
    const visit = node => {
      if (node.nodeType === 3){
        const s = node.nodeValue.replace(/[\r\n]/g, ' ');
        if (s.length){ segs.push({ node, a: text.length, b: text.length + s.length }); text += s; }
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.localName;
      if (tag === 'br'){ text += '\n'; return; }
      if (tag === 'ruby'){ visitRuby(node); return; }
      if (node.matches(sel)) return;
      node.childNodes.forEach(visit);
    };
    // ルビ: 読み(rt)の前までの文字が、その読みの付く語。読みの無い ruby は、ただの文字
    const visitRuby = r => {
      let from = text.length;
      r.childNodes.forEach(c => {
        if (c.nodeType === 1 && c.localName === 'rt'){
          const rt = String(c.textContent || '').trim();
          if (rt && text.length > from) ruby.push({ a: from, b: text.length, rt });
          from = text.length;
          return;
        }
        if (c.nodeType === 1 && c.localName === 'rp') return;
        visit(c);
      });
    };
    el.childNodes.forEach(visit);
    return { text, segs, ruby };
  }

  // 本文の段落 → PageModel(§4-2)。DOM を使わない部分は tests/helpers/model.js の plainModel と同じ決まり
  function page(info, cfg){
    if (!info || !Array.isArray(info.paras)) throw util.error('bad', '当てはめの結果がおかしい');
    const c = cfg || config.text;
    const model = { info, paras: [], sents: [], targets: [], n: { paras: 0, sents: 0, targets: 0, jpChars: 0, jpCharsTarget: 0 } };
    const seen = {};   // h → 何回出たか(o)
    info.paras.forEach((el, i) => {
      const t = textOf(el, info.skip);
      const para = { i, el, text: t.text, scene: T.isSceneBreak(t.text), ruby: t.ruby, sents: [], jpChars: T.norm(t.text).length };
      model.paras.push(para);
      if (para.scene) return;
      T.split(t.text).forEach(r => {
        const s = t.text.slice(r.a, r.b);
        const h = T.hash(s);
        const o = seen[h] || 0; seen[h] = o + 1;
        const k = T.classify(s, r.q, c);
        const sent = { sid: model.sents.length, p: i, a: r.a, b: r.b, text: s, len: s.length, q: r.q, h, o, target: k.target, why: k.why, long: k.long, short: k.short };
        model.sents.push(sent);
        para.sents.push(sent.sid);
        if (sent.target){ model.targets.push(sent.sid); model.n.jpCharsTarget += T.norm(s).length; }
      });
    });
    model.n.paras = model.paras.length;
    model.n.sents = model.sents.length;
    model.n.targets = model.targets.length;
    model.n.jpChars = model.paras.reduce((sum, p) => sum + p.jpChars, 0);
    return model;
  }

  // その文の、今の DOM での範囲(Range)。段落の文字が、文のデータを作ったときと変わっていれば null(作者が直した・サイトが描き直した)
  //   始まりと終わりは、いつも Text ノードの中の位置(文の前後の空白は文に入らないので、<br> の位置には来ない)
  function range(model, sid){
    const s = model && model.sents && model.sents[sid];
    if (!s || s.sid !== sid) return null;
    const p = model.paras[s.p];
    if (!p || !p.el) return null;
    const t = textOf(p.el, model.info && model.info.skip);
    if (t.text !== p.text) return null;
    const st = t.segs.find(g => g.a <= s.a && s.a < g.b);
    const en = t.segs.find(g => g.a < s.b && s.b <= g.b);
    if (!st || !en) return null;
    const r = p.el.ownerDocument.createRange();
    r.setStart(st.node, s.a - st.a);
    r.setEnd(en.node, s.b - en.a);
    return r;
  }

  Yomu.extract = { page, textOf, range };
})();

/* ---- page/render.js ---- */
// page/render.js — 英文の描き込み(部品の約束 §9-1)
//   対象の文を「文の入れ物」(span.yomu-s)で包み、英文を入れ、状態(jp・wait・en・back)を属性で切り替える。detach で、もとの DOM に戻す。
//   文の範囲が、ページの要素(傍点の em など)の途中で切れるときは、要素を割らずに、入れ物を何切れかに分ける(英文は、いちばん外側の1切れに置く)。
//   外から来た文字(英文・熟語)は textContent と createElement だけで出す(§1-2)。受け口(タップ)は付けない(ui が document に1つ付ける)。
(function(){
  'use strict';
  const Y = Yomu;
  const extract = Yomu.extract, util = Yomu.util, theme = Yomu.theme;

  const ATTR_ORIG = 'data-yomu-orig', ATTR_STYLE = 'data-yomu-style', ATTR_THEME = 'data-yomu-theme', ATTR_FONT = 'data-yomu-font', ATTR_SIZE = 'data-yomu-size';
  const CSS_ID = 'yomu-page-css';
  const STYLES = ['marker', 'quiet'];
  const PRE = '--yomu-';                                   // ページの側に置く CSS の変数の頭(サイトの変数とぶつからないように)
  const c = key => 'var(' + theme.varName(key, PRE) + ')';
  const CHIP = { en: ['あ', 'この文を日本語に戻す'], back: ['A', 'この文を英語に戻す'] };

  // ページに足す CSS。サイトの CSS に負けないよう、:root から書いて詳しさを上げる。大きさはキャンバスの2ページ目(design/round2/gen.js)
  //   色は、色の組(core/theme.js)の名前を CSS の変数で読む(色の値を、ここに直接書かない)。組は <html> の印 data-yomu-theme で切り替える(印が無ければ、初めの組)
  //   書体は端末に入っているものだけ(Web フォントは読み込まない。§9-2)。書体と文字の大きさは、<html> の印 data-yomu-font・data-yomu-size で切り替える
  const FE = '"Plus Jakarta Sans","Avenir Next","Segoe UI",system-ui,sans-serif';
  const FS = 'ui-serif,"Iowan Old Style","Charter",Georgia,serif';
  const FJ = '"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic UI","Meiryo",sans-serif';
  const R = ':root .yomu-s', ON = ':root:not([' + ATTR_ORIG + '])', Q = '[' + ATTR_STYLE + '="quiet"]';
  // 文字の大きさ = 書体ごとの「サイトの文字と同じに見える大きさ」× 小さめ・大きめの倍率
  const BASE = { sans: 0.92, serif: 1.03, site: 1 }, MUL = { s: 0.9, m: 1, l: 1.12 };
  // 「あ/A」の字の大きさと、押せる範囲(画面の物差し=§9-9。行の中に入るので、44px にはできない)。丸は 23px ほど。見えない所を上下左右に足して、押せる範囲を 30px 四方ほどに広げる
  const CHIP_RULE = Y.config.ui.chip, CHIP_PAD = CHIP_RULE.pad;
  // 離れた熟語の間の語の破線の刻み [線, すき間](px。工程T-5a の写真で利用者が見た形に合わせた。線の太さは熟語の実線と同じ 2px)
  const GAP_DASH = [4, 3];
  const CSS = [
    ':root { ' + theme.vars(theme.initial, PRE, theme.pageKeys()) + ' }'
  ].concat(theme.names().filter(n => n !== theme.initial).map(n => ':root[' + ATTR_THEME + '="' + n + '"] { ' + theme.vars(n, PRE, theme.pageKeys()) + ' }'), [
    ':root[' + ATTR_FONT + '="serif"] { --yomu-en-base: ' + BASE.serif + '; }',
    ':root[' + ATTR_FONT + '="site"] { --yomu-en-base: ' + BASE.site + '; }',
    ':root[' + ATTR_SIZE + '="s"] { --yomu-en-mul: ' + MUL.s + '; }',
    ':root[' + ATTR_SIZE + '="l"] { --yomu-en-mul: ' + MUL.l + '; }',
    R + ' > .yomu-en, ' + R + ' > .yomu-chip { display: none; }',
    ON + ' .yomu-s[data-yomu-st="en"] > .yomu-jp { display: none; }',
    ON + ' .yomu-s[data-yomu-st="en"] > .yomu-en { display: inline; }',
    ON + ' .yomu-s[data-yomu-st="en"] > .yomu-chip, ' + ON + ' .yomu-s[data-yomu-st="back"] > .yomu-chip { display: inline; }',
    // 「あ/A」を、前の語から離して次の行の頭に置かない: 前の文字の後ろに、改行させない印(語をつなぐ見えない文字 U+2060)を置く。
    //   「あ/A」を箱(inline-flex)にすると、その前はいつでも改行できてしまうので、ふつうの文字の並び(inline)にして丸く見せる(工程4a-1 が Chromium で確かめた)
    R + ' > .yomu-en::after, ' + R + '[data-yomu-st="back"] > .yomu-jp::after { content: "\\2060"; }',
    // これから英語になる文(点線)
    ON + ' .yomu-s[data-yomu-st="wait"] > .yomu-jp { border-bottom: 1.5px dashed ' + c('wait') + '; padding-bottom: 1px; }',
    // 英文: マーカー(初期値)
    R + ' > .yomu-en { font-family: ' + FE + '; font-size: calc(var(--yomu-en-base, ' + BASE.sans + ') * var(--yomu-en-mul, ' + MUL.m + ') * 1em); font-weight: 500; font-style: normal; color: ' + c('enInk') + '; background: ' + c('enBg') + '; border-radius: 6px;'
      + ' padding: 0.15em 0.3em; margin: 0 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone; letter-spacing: normal; text-indent: 0; line-height: 1;'
      + ' -webkit-text-emphasis: none; text-emphasis: none; word-break: normal; overflow-wrap: break-word; -webkit-hyphens: manual; hyphens: manual; }',
    R + ' .yomu-w { cursor: pointer; padding: 0.25em 0; }',
    R + ' .yomu-i { font-weight: 700; border-bottom: 2px solid ' + c('idiom') + '; padding-bottom: 0; }',
    // 離れた熟語の間の語(handed the envelope back の the envelope。工程T-5c=案 C): 熟語と同じ色の破線・ふつうの太さ。まとまり全体に1本(語ごとに切ると、つなぎ目に継ぎ目が出る)。
    //   熟語の実線と同じ高さ(字の下 2px)。刻みは、どのブラウザでも同じになるよう、境目の線(dashed)でなく、背景の縞で描く
    R + ' .yomu-g { padding-bottom: 2px; background-image: repeating-linear-gradient(90deg, ' + c('idiom') + ' 0 ' + GAP_DASH[0] + 'px, transparent ' + GAP_DASH[0] + 'px ' + (GAP_DASH[0] + GAP_DASH[1]) + 'px);'
      + ' background-size: 100% 2px; background-position: 0 100%; background-repeat: no-repeat; }',
    // 利用者が「あ」で戻した日本語
    ON + ' .yomu-s[data-yomu-st="back"] > .yomu-jp { background: ' + c('backBg') + '; border-radius: 6px; padding: 0.15em 0.3em; margin: 0 2px;'
      + ' -webkit-box-decoration-break: clone; box-decoration-break: clone; }',
    // 「あ/A」
    R + ' > .yomu-chip { position: relative; top: -2px; margin: 0 3px 0 1px; padding: 0.2em 0.45em; border: 1px solid ' + c('chipBd') + '; border-radius: 50%; background: ' + c('chipBg') + '; color: ' + c('chipInk') + ';'
      + ' font-family: ' + FJ + '; font-size: ' + CHIP_RULE.font + 'px; font-weight: 700; font-style: normal; line-height: 1; text-indent: 0; letter-spacing: normal;'
      + ' cursor: pointer; white-space: nowrap; -webkit-user-select: none; user-select: none; -webkit-text-emphasis: none; text-emphasis: none; }',
    R + ' > .yomu-chip::after { content: ""; position: absolute; left: -' + CHIP_PAD + 'px; right: -' + CHIP_PAD + 'px; top: -' + CHIP_PAD + 'px; bottom: -' + CHIP_PAD + 'px; }',
    R + '[data-yomu-st="back"] > .yomu-chip { border-color: ' + c('backBd') + '; color: ' + c('backInk') + '; font-family: ' + FE + '; font-weight: 800; }',
    // 書体だけ
    ':root' + Q + ' .yomu-s > .yomu-en { font-weight: 400; color: ' + c('quietInk') + '; background: transparent; border-radius: 0; padding: 0; }',
    ':root' + Q + ' .yomu-s .yomu-i { font-weight: inherit; border-bottom: 1px dotted ' + c('quietIdiom') + '; padding-bottom: 1px; }',
    ':root' + Q + ' .yomu-s .yomu-g { background-image: none; padding-bottom: 0; }',      // 書体だけ: 間の語に線を付けない(熟語の印が、もともと細い点線のため)
    ':root' + Q + ':not([' + ATTR_ORIG + ']) .yomu-s[data-yomu-st="back"] > .yomu-jp { background: transparent; border-radius: 0; padding: 0 0 1px; border-bottom: 1px dotted ' + c('quietBack') + '; }',
    ':root' + Q + ' .yomu-s > .yomu-chip { margin: 0 3px 0 2px; border-color: ' + c('quietChipBd') + '; background: transparent; color: ' + c('quietChipInk') + '; }',
    ':root' + Q + ' .yomu-s[data-yomu-st="back"] > .yomu-chip { border-color: ' + c('quietChipBd') + '; color: ' + c('quietBack') + '; }',
    // 英文の書体(初めは、ゴシック体=上の FE)。「サイトと同じ」は、太さもサイトのまま
    ':root[' + ATTR_FONT + '="serif"] .yomu-s > .yomu-en { font-family: ' + FS + '; }',
    ':root[' + ATTR_FONT + '="site"] .yomu-s > .yomu-en { font-family: inherit; font-weight: inherit; }'
  ]).join('\n');

  // ---- 状態 ----
  let doc = null, model = null;
  let entries = new Map();      // sid → { sid, pieces:[span…], main: span, en: string|null, words, el: span.yomu-en|null, chip: span|null, st }
  let splits = [];              // 割った Text ノードの組 [前, 後](detach で、逆の順につなぎ直す)
  let backups = [];             // [{ el, html, text }] 段落ごとの控え(最後の守り)
  let shown = new Set(), waiting = false;
  const flipped = new Set();    // 利用者が「あ」で日本語に戻した文(覚えるのは、このページを開いている間だけ。§8-4)

  // ページの document の道具は、包むときに1回だけ受けておく(jsdom では、document の欄を読むたびに、ページ全体を数え直すため。ブラウザでは変わらない)
  let D = null;                 // { view, el(tag), text(s) }
  const mk = (tag, cls) => { const e = D.el(tag); if (cls) e.className = cls; return e; };

  // ---- 文の範囲を包む ----
  // 文書の順の比べ: a が b より前なら負
  const order = (a, b) => (a === b ? 0 : (a.compareDocumentPosition(b) & 4 /* FOLLOWING */) ? -1 : 1);
  const firstLeaf = n => { while (n.firstChild) n = n.firstChild; return n; };
  const lastLeaf = n => { while (n.lastChild) n = n.lastChild; return n; };

  // 範囲の両端を Text ノードの切れ目に合わせる(割ったものは splits に残す)→ [最初の葉, 最後の葉]
  function cutEnds(r){
    let sN = r.startContainer, eN = r.endContainer;
    const sO = r.startOffset, eO = r.endOffset;
    if (sN.nodeType !== 3 || eN.nodeType !== 3) return null;
    // 終わりを先に割る(始まりの位置が変わらないように)
    if (eO < eN.length){ const rest = eN.splitText(eO); splits.push([eN, rest]); }
    if (sO > 0){
      const rest = sN.splitText(sO); splits.push([sN, rest]);
      if (eN === sN) eN = rest;    // 同じ Text ノードの中の文: 終わりも、割った後ろの方
      sN = rest;
    }
    return [sN, eN];
  }

  // 範囲の中に、まるごと入る、いちばん外側のノードを、文書の順に → 隣り合う兄弟ごとにまとめる
  function groupsOf(first, last, para){
    // 文がルビの語で終わるときは、そのルビの読み(rt・rp)までを範囲に入れる(ルビを割らない)
    const rb = last.parentNode && last.parentNode.closest ? last.parentNode.closest('ruby') : null;
    if (rb && para.contains(rb)) last = lastLeaf(rb);
    const covered = n => order(firstLeaf(n), first) >= 0 && order(lastLeaf(n), last) <= 0;
    const atoms = [];
    const tw = doc.createTreeWalker(para, 0xFFFFFFFF);
    tw.currentNode = first;
    for (let n = first; n; n = tw.nextNode()){
      if (!n.firstChild){
        let top = n;
        while (top.parentNode && top.parentNode !== para && covered(top.parentNode)) top = top.parentNode;
        if (atoms[atoms.length - 1] !== top) atoms.push(top);
      }
      if (n === last) break;
    }
    const groups = [];
    atoms.forEach(a => {
      const g = groups[groups.length - 1];
      if (g && g[g.length - 1].nextSibling === a) g.push(a); else groups.push([a]);
    });
    return groups;
  }

  const depthIn = (n, para) => { let d = 0; while (n && n !== para){ d++; n = n.parentNode; } return d; };

  function wrap(sid, para){
    const r = extract.range(model, sid);
    if (!r) return false;
    const ends = cutEnds(r);
    if (!ends) return false;
    const groups = groupsOf(ends[0], ends[1], para);
    if (!groups.length) return false;
    const pieces = groups.map(g => {
      const piece = mk('span', 'yomu-s');
      piece.setAttribute('data-yomu-sid', String(sid));
      piece.setAttribute('data-yomu-st', 'jp');
      const jp = mk('span', 'yomu-jp');
      piece.appendChild(jp);
      g[0].parentNode.insertBefore(piece, g[0]);
      g.forEach(n => jp.appendChild(n));
      return piece;
    });
    // 英文と「あ/A」を置く切れ: いちばん外側(同じなら先のもの)
    let main = pieces[0];
    pieces.forEach(p => { if (depthIn(p, para) < depthIn(main, para)) main = p; });
    pieces.forEach(p => { if (p !== main) p.classList.add('yomu-part'); });
    entries.set(sid, { sid, pieces, main, en: null, words: null, el: null, chip: null, st: 'jp' });
    return true;
  }

  // ---- 読んでいる場所を動かさない(§9-1)----
  //   変える前に、画面のいちばん上に見えている段落(段落の頭が画面より上なら、その中の、頭が見えている文の入れ物)の位置を測り、
  //   変えたあとで、ずれた分だけスクロールする(Safari は自動では合わせない。自動で合わせるブラウザでは、ずれが 0 になる)
  function anchor(){
    const view = D && D.view;
    if (!view || !model) return null;
    const h = view.innerHeight || 0;
    for (let i = 0; i < model.paras.length; i++){
      const el = model.paras[i].el;
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!(r.bottom > 0) || !(r.height > 0)) continue;
      if (r.top >= 0) return { el, top: r.top };
      const inner = Array.from(el.querySelectorAll('.yomu-s')).map(s => [s, s.getBoundingClientRect()]).find(x => x[1].top >= 0 && x[1].top < h && x[1].height > 0);
      if (inner) return { el: inner[0], top: inner[1].top };
      const nx = model.paras[i + 1] && model.paras[i + 1].el;
      if (nx && nx.isConnected){ const rn = nx.getBoundingClientRect(); if (rn.top >= 0 && rn.top < h) return { el: nx, top: rn.top }; }
      return { el, top: r.top };
    }
    return null;
  }
  //   batch(fn) の中では、まとめて1回だけ測る(開き直したときに 250 文を入れる、のように続けて変えるとき、測るたびに配置の計算が走らないように)
  let depth = 0;
  function keep(fn){
    if (depth) return fn();
    const a = anchor();
    let out;
    depth++;
    try { out = fn(); } finally { depth--; }
    if (a && a.el.isConnected){
      const d = a.el.getBoundingClientRect().top - a.top;
      if (Math.abs(d) >= 0.5) D.view.scrollBy(0, d);
    }
    return out;
  }

  // ---- 状態 ----
  function stateOf(e){
    if (!shown.has(e.sid)) return 'jp';
    if (e.en != null) return flipped.has(e.sid) ? 'back' : 'en';
    return waiting ? 'wait' : 'jp';
  }
  function paint(e){
    const st = stateOf(e);
    if (st === e.st) return;
    e.st = st;
    e.pieces.forEach(p => p.setAttribute('data-yomu-st', st));
    if (e.chip && CHIP[st]){
      e.chip.textContent = CHIP[st][0];
      e.chip.setAttribute('aria-label', CHIP[st][1]);
    }
  }

  // ---- 英文の中身 ----
  //   分けるのは、単語の部品(core/tokens.js。§7-1)。離れた熟語の間の語(g の付いた、ひと続きの語と空白)は、1つの span.yomu-g に入れる(破線を1本で引くため)
  function fillEn(e){
    const box = e.el;
    while (box.firstChild) box.removeChild(box.firstChild);
    let group = null;
    Y.tokens.split(e.en, e.words || []).forEach((tk, ti) => {
      let into = box;
      if (Number.isInteger(tk.g)){
        if (!group || group.getAttribute('data-yomu-g') !== String(tk.g)){
          group = mk('span', 'yomu-g');
          group.setAttribute('data-yomu-g', String(tk.g));
          box.appendChild(group);
        }
        into = group;
      } else group = null;
      if (tk.t === 'w' || tk.t === 'i'){
        const w = mk('span', tk.t === 'i' ? 'yomu-w yomu-i' : 'yomu-w');
        w.setAttribute('data-yomu-t', String(ti));
        if (tk.t === 'i' && Number.isInteger(tk.i)) w.setAttribute('data-yomu-i', String(tk.i));
        w.textContent = tk.s;
        into.appendChild(w);
      } else into.appendChild(D.text(String(tk.s)));
    });
  }

  // ---- 口 ----
  const asSet = v => (v instanceof Set ? new Set(v) : new Set(Array.isArray(v) ? v.map(Number) : []));

  function detach(){
    if (!doc) return;
    // 包みをはずす(英文と「あ/A」は捨て、もとのノードを入れ物のあった場所へ戻す)
    entries.forEach(e => e.pieces.forEach(p => {
      const jp = p.firstChild, parent = p.parentNode;
      if (parent){
        if (jp && jp.classList && jp.classList.contains('yomu-jp')) while (jp.firstChild) parent.insertBefore(jp.firstChild, p);
        parent.removeChild(p);
      }
    }));
    // 割った Text ノードを、逆の順につなぎ直す(隣り合っていなければ、つながない=サイトが描き直した)
    for (let i = splits.length - 1; i >= 0; i--){
      const [a, b] = splits[i];
      if (a.parentNode && a.nextSibling === b){ a.appendData(b.data); b.parentNode.removeChild(b); }
    }
    // 最後の守り: 戻したあとの文字が元と違えば、控えから戻す(控えはサイト自身の HTML。外から来た文字ではない)
    backups.forEach(bk => {
      if (bk.el.isConnected && extract.textOf(bk.el, model && model.info && model.info.skip).text !== bk.text) bk.el.innerHTML = bk.html;
    });
    const css = doc.getElementById(CSS_ID);
    if (css) css.parentNode.removeChild(css);
    [ATTR_ORIG, ATTR_STYLE, ATTR_THEME, ATTR_FONT, ATTR_SIZE].forEach(a => doc.documentElement.removeAttribute(a));
    doc = null; D = null; model = null; entries = new Map(); splits = []; backups = []; shown = new Set(); waiting = false; flipped.clear();
  }

  // 対象の文を全部包む(見た目はまだ変わらない)→ { wrapped, missed }(missed = 包めなかった文の数。段落の文字が変わっていた など)
  function attach(m){
    if (!m || !Array.isArray(m.paras) || !Array.isArray(m.targets)) throw util.error('bad', '文のデータがおかしい');
    detach();
    const first = m.paras.find(p => p.el);
    if (!first) return { wrapped: 0, missed: m.targets.length };
    doc = first.el.ownerDocument;
    D = { view: doc.defaultView, el: doc.createElement.bind(doc), text: doc.createTextNode.bind(doc) };
    model = m;
    m.paras.forEach(p => { if (p.el) backups.push({ el: p.el, html: p.el.innerHTML, text: p.text }); });
    if (!doc.getElementById(CSS_ID)){
      const st = doc.createElement('style');
      st.id = CSS_ID;
      st.textContent = CSS;
      (doc.head || doc.documentElement).appendChild(st);
    }
    let wrapped = 0;
    m.targets.forEach(sid => {
      const s = m.sents[sid], p = s && m.paras[s.p];
      if (p && p.el && wrap(sid, p.el)) wrapped++;
    });
    return { wrapped, missed: m.targets.length - wrapped };
  }

  // その文に英文を入れる(words = 熟語 [{ w, b?, m }])。包んでいない文なら false
  function setEn(sid, en, words){
    const e = entries.get(Number(sid));
    if (!e || typeof en !== 'string') return false;
    return keep(() => {
      e.en = en;
      if (words !== undefined) e.words = Array.isArray(words) ? words : null;
      if (!e.el){
        e.el = mk('span', 'yomu-en');
        e.el.setAttribute('lang', 'en');
        e.chip = mk('span', 'yomu-chip');
        e.chip.setAttribute('role', 'button');
        e.chip.setAttribute('tabindex', '0');
        e.main.appendChild(e.el);
        e.main.appendChild(e.chip);   // 「あ/A」の文字は、状態が en・back に変わるときに入る(paint)
      }
      fillEn(e);
      paint(e);
      return true;
    });
  }

  Yomu.render = {
    attach, detach, setEn,
    css: CSS,
    // fn の中の変更(setEn・setWords・apply・flip・orig・style)を、まとめて1回の「読んでいる場所を保つ」で行う → fn の戻り
    batch: fn => keep(fn),
    // 熟語さがしの結果を足す(下線)
    setWords(sid, words){
      const e = entries.get(Number(sid));
      if (!e || e.en == null) return false;
      return keep(() => { e.words = Array.isArray(words) ? words : null; fillEn(e); return true; });
    },
    // shown = 英語にする文(Set か配列)/ wait = 訳している間か(英文がまだ無い文に点線)
    apply(o){
      o = o || {};
      if (!doc) return;
      keep(() => { shown = asSet(o.shown); waiting = !!o.wait; entries.forEach(paint); });
    },
    // 「あ/A」。to = 'jp'(英語の文を、その場で日本語に)/ 'en'(戻した文を英語に)。変わったら true
    flip(sid, to){
      const e = entries.get(Number(sid));
      if (!e || e.en == null || (to !== 'jp' && to !== 'en')) return false;
      // 英語で出ている文だけを日本語に、戻した文だけを英語に(出ていない文の「戻した」を覚えておかない)
      if ((to === 'jp' && e.st !== 'en') || (to === 'en' && e.st !== 'back')) return false;
      keep(() => { if (to === 'jp') flipped.add(e.sid); else flipped.delete(e.sid); paint(e); });
      return true;
    },
    // 「原文」(全部を一時的に日本語に)
    orig(on){
      if (!doc) return;
      keep(() => { if (on) doc.documentElement.setAttribute(ATTR_ORIG, '1'); else doc.documentElement.removeAttribute(ATTR_ORIG); });
    },
    style(name){
      if (!doc || STYLES.indexOf(name) < 0) return;
      keep(() => { if (name === 'marker') doc.documentElement.removeAttribute(ATTR_STYLE); else doc.documentElement.setAttribute(ATTR_STYLE, name); });
    },
    // 色の組(core/theme.js の名前。初めの組は、印なし)。文の長さは変わらない
    theme(name){
      if (!doc || !theme.has(name)) return;
      if (name === theme.initial) doc.documentElement.removeAttribute(ATTR_THEME); else doc.documentElement.setAttribute(ATTR_THEME, name);
    },
    // 英文の書体('sans'|'serif'|'site')と、文字の大きさ('s'|'m'|'l')。初めの値(sans・m)は、印なし
    font(name){
      if (!doc || theme.fonts().indexOf(name) < 0) return;
      keep(() => { if (name === 'sans') doc.documentElement.removeAttribute(ATTR_FONT); else doc.documentElement.setAttribute(ATTR_FONT, name); });
    },
    size(name){
      if (!doc || theme.sizes().indexOf(name) < 0) return;
      keep(() => { if (name === 'm') doc.documentElement.removeAttribute(ATTR_SIZE); else doc.documentElement.setAttribute(ATTR_SIZE, name); });
    },
    // タップされた要素が、どの文のどの語か → { sid, ti } / 「あ/A」なら { sid, chip: true } / どれでもなければ null
    hit(node){
      let el = node && node.nodeType === 3 ? node.parentNode : node;
      if (!el || !el.closest) return null;
      const s = el.closest('.yomu-s');
      if (!s || !entries.has(Number(s.getAttribute('data-yomu-sid')))) return null;
      const sid = Number(s.getAttribute('data-yomu-sid'));
      if (el.closest('.yomu-chip')) return { sid, chip: true };
      const w = el.closest('.yomu-w');
      return w ? { sid, ti: Number(w.getAttribute('data-yomu-t')) } : null;
    },
    // 今、その文に描いてある英文と熟語(板が、タップされた語の番号 ti を、同じ並びで読むため)。英文が無ければ null
    drawn(sid){
      const e = entries.get(Number(sid));
      return e && e.en != null ? { en: e.en, words: Array.isArray(e.words) ? e.words.slice() : [] } : null;
    },
    // 今の状態(進行役と検査が使う)
    attached: () => !!doc,
    // 包んだ文が、ページから外れたか(ページの側が本文を作り直した=React などで作ったページ。工程8d)。包んでいなければ false
    lost(){
      if (!doc) return false;
      for (const e of entries.values()) if (!e.main.isConnected) return true;
      return false;
    },
    state: sid => { const e = entries.get(Number(sid)); return e ? e.st : null; },
    has: sid => entries.has(Number(sid))
  };
})();

/* ---- page/watch.js ---- */
// page/watch.js — 読んだ時間の見張り(部品の約束 §8-8)。進行役の合図 'log' を受けて、読んだ記録(Yomu.log)を呼ぶ
//   英語まじりで出ている間だけ、1秒ごとに、画面に出ている段落と、操作が途切れていないかを見る。通信はしない。ページの文章は渡さない(数字だけ)。
//   区切って保存するのは core/log.js。段落ごとの数は進行役(Yomu.page.reading)が数える。進行役より先に読み込まれるので、つなぐのは start(起動が呼ぶ)
(function(){
  'use strict';
  const Y = Yomu;
  const util = Y.util, config = Y.config;
  // 操作と見るもの(スクロール・タッチ・キー。PC はホイールと押す操作も)
  const ACTS = ['scroll', 'touchstart', 'touchmove', 'pointerdown', 'wheel', 'keydown'];
  const nowMs = () => Date.parse(util.nowISO());

  let doc = null, win = null;
  let subs = [];            // 進行役の合図を外す関数(start から stop まで)
  let every = 0;            // 見る間隔(ms)。0 なら、自分では見ない(検査が tick を呼ぶ)
  let want = false;         // 英語まじりで出ている(記録を始めたい)
  let h = null;             // 読んだ記録の口(Yomu.log.open の戻り)
  let els = [];             // [[段落の番号, 要素]…](文のある段落)
  let lastAct = 0;          // 最後の操作の時刻
  let timer = null, unhook = [];
  let cover = false;        // 画面いっぱいの板(設定)が、本文を隠している(その間は、読んだ時間に数えない=2026-10-12 利用者と決めた)
  let pending = false;      // 合図 close を受けた直後(同じ流れの中で open が続いたら=出し直し、閉じずに続ける)

  const hidden = () => !!doc && doc.visibilityState === 'hidden';
  const touch = () => { lastAct = nowMs(); };

  // 画面に出ている段落 → [[段落の番号, 見えている高さ]…](割合に直すのは、記録の部品)
  function visible(){
    const vh = (win && win.innerHeight) || (doc.documentElement && doc.documentElement.clientHeight) || 0;
    const list = [];
    if (!(vh > 0)) return list;
    for (let i = 0; i < els.length; i++){
      const r = els[i][1].getBoundingClientRect();
      if (r.top >= vh && list.length) break;               // 段落は上から並んでいる: 画面の下に出たら、あとは見ない
      const px = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (px > 0) list.push([els[i][0], px]);
    }
    return list;
  }
  // 1回見る: 画面が見えていれば、その分を記録に渡す。操作が idleSec より長く途切れていれば、段落には配らない
  function tick(){
    if (!h || pending || hidden() || cover) return;
    const now = nowMs();
    if (now < lastAct) lastAct = now;                        // 端末の時計が戻された
    h.dwell(visible(), { sec: config.log.tickMs / 1000, act: now - lastAct <= config.log.idleSec * 1000 });
  }
  function onVis(){
    if (!h) return;
    if (hidden()) h.flush(); else touch();                   // 裏に回ったら書く。戻ってきたのは、操作のうち
  }
  function onHide(){ if (h) h.flush(); }

  // 記録を始める。訳している最中(busy)は始めない(訳が出そろってから=利用者と決めた。2026-10-04)
  function begin(){
    if (h || !want || !Y.page || Y.page.status().state !== 'on') return;
    const r = Y.page.reading();
    if (!r) return;
    try { h = Y.log.open(r.ctx); } catch (e){ h = null; return; }   // 記録の失敗で、読むのを止めない
    els = r.els;
    touch();
    const on = (target, name, fn, opt) => { target.addEventListener(name, fn, opt); unhook.push(() => target.removeEventListener(name, fn, opt)); };
    ACTS.forEach(n => on(doc, n, touch, { capture: true, passive: true }));
    on(doc, 'visibilitychange', onVis);
    if (win) on(win, 'pagehide', onHide);
    if (every > 0){
      // ページのタイマー(ページが閉じれば、一緒に止まる)
      if (win && win.setInterval){ const id = win.setInterval(tick, every); timer = () => win.clearInterval(id); }
      else { const id = setInterval(tick, every); timer = () => clearInterval(id); }
    }
  }
  function end(){
    want = false; pending = false;
    if (timer){ timer(); timer = null; }
    unhook.splice(0).forEach(fn => { try { fn(); } catch (e){} });
    els = [];
    const old = h;
    h = null;
    return old ? old.close() : Promise.resolve(true);
  }
  // 今の表示を、記録に知らせる。変わった欄だけでなく、まるごと渡す(同じなら、記録の部品が区切らない)
  function sync(){
    if (!h) return;
    const r = Y.page.reading();
    if (!r) return;
    const c = r.ctx;
    els = r.els;
    h.state({ ratio: c.ratio, orig: c.orig, style: c.style, level: c.level, tr: c.tr, model: c.model, promptV: c.promptV, paras: c.paras });
  }
  // 進行役の合図 'log'(§6-7)
  function onLog(e){
    if (!e) return;
    if (e.type === 'open'){
      // close のすぐあとの open(出し直し: レベルを変えた など)で、訳している最中でなければ、同じ記録のまま続ける(同じ visit の、次のひと続き)
      const keep = pending && !!h && Y.page.status().state === 'on';
      if (pending && !keep) end();
      pending = false; want = true;
      if (keep) sync(); else begin();
    }
    else if (e.type === 'close'){
      want = false;
      if (!h || pending) return;
      pending = true;                                      // 閉じるのは、この流れが済んでから(出し直しかどうかを見るため)
      Promise.resolve().then(() => { if (pending) end(); });
    }
    else if (e.type === 'change') sync();
    else if (e.type === 'act' && h && !pending) h.act(e.kind, e.sid);
  }

  Yomu.watch = {
    // 進行役につなぐ(起動が1回呼ぶ)。o = { doc?, every? }(every = 見る間隔 ms。0 なら自分では見ない)→ 止める関数
    start(o){
      o = o || {};
      if (subs.length) return Yomu.watch.stop;
      doc = o.doc || (typeof document !== 'undefined' ? document : null);
      if (!doc || !Y.page) return Yomu.watch.stop;
      win = doc.defaultView || null;
      every = o.every === undefined ? config.log.tickMs : o.every;
      subs = [Y.page.on('log', onLog), Y.page.on('state', begin)];   // 'state': 訳し終わった(busy → on)ときに、始める
      return Yomu.watch.stop;
    },
    stop(){
      subs.splice(0).forEach(fn => fn());
      return end();
    },
    // 操作(単語のタップ・辞書 など。§8-8 の Stretch.n の名前)。画面の部品(ui)が呼ぶ。記録していなければ false
    act(kind, sid, extra){ return h && !pending ? h.act(kind, sid, extra) : false; },
    // 画面いっぱいの板が出た・消えた(ui/root.js の sheet・unsheet が呼ぶ)。消えたのは、操作のうち
    cover(on){ cover = !!on; if (!cover) touch(); },
    tick,
    get on(){ return !!h && !pending; }
  };
})();

/* ---- page/controller.js ---- */
// page/controller.js — 進行役(部品の約束 §6-7)。1ページに1つ(Yomu.page)
//   ブレンドの流れを受け持つ: 保存から出す・訳す(1回)・届いた順に描く・途中で切れる・続きを訳す・上限・レベルの切り替え・
//   開き直したら自動で戻す・縦組みの知らせ・番号がずれた疑い。表示の切り替え(割合・見せ方・「原文」・「あ/A」)は、通信しない。
//   描き込みは page/render.js、訳すのは core/translate.js、保存は Yomu.store.pages。訳したページ(PageRec)を書くのは、ここだけ(§8-4)。
//   通信は、押した回数だけ(ブレンド・続きを訳す・訳し直す = 翻訳1回 + 熟語さがし1回。自動では送り直さない。§1-2)
(function(){
  'use strict';
  const Y = Yomu;
  const util = Y.util, config = Y.config, levels = Y.levels, order = Y.order, store = Y.store, settings = Y.settings, quota = Y.quota;
  const prompts = Y.prompts, wire = Y.wire, translate = Y.translate, sites = Y.sites, extract = Y.extract, render = Y.render, text = Y.text, theme = Y.theme;
  const isPlain = util.isPlain;
  const diag = Y.diag || { mark(){}, stage: () => '' };   // 調べるための記録(控えるだけ。§9-8)
  const STYLES = ['marker', 'quiet'];
  const EVENTS = ['state', 'progress', 'sentence', 'notice', 'log'];

  // ---- 状態(1ページ分。leave で初めに戻す) ----
  let doc = null, win = null, loc = null, info = null, model = null, ranks = null;
  let level = levels.initial, ratio = config.ratio.initial, style = 'marker', orig = false;
  let themeSet = theme.AUTO, themeNow = theme.initial;   // 見た目: 設定の値('auto' か、色の組の名前)と、今使っている色の組
  let font = theme.fonts()[0], size = 'm';               // 英文の書体と文字の大きさ
  let rec = null;               // 今のレベルの保存(PageRec)。訳している間は、書いている最中のもの
  let have = new Map();         // sid → rec.s の1件(今のページの文に付く訳)
  let view = false;             // 英語まじりで出したいか(ブレンド・自動で戻す のあと true)。縦組みの間は、出したくても描かない
  let lapsed = false;           // 英語まじりで出していたのに、訳の無いレベルへ変えたので、日本語に戻してある(need-translate)。訳のあるレベルへ戻したら、押さなくても、英語まじりに戻す(工程5b-2b)
  let vertical = false;
  let state = 'none';           // 'none'(本文ページでない・止めた)/ 'off'(日本語のまま)/ 'busy'(訳している)/ 'on'(英語まじり)
  let notice = null;            // 今の知らせ { kind, …中身 }(1つだけ。新しいものが前のものを置きかえる。失敗の種類は cause)
  let saved = {};               // { [level]: true }(このページの、どのレベルの保存があるか)
  let job = null;               // 今の翻訳 { kind, ctrl, rec, got:[sid…], held:[…] }
  let ijob = null;              // 今の熟語さがし { ctrl, rec }
  let arming = false;           // 訳す前の確かめ(キー・今日の上限)の最中(続けて押されても、2回送らない)
  let switching = false;        // レベルを切り替えている最中(保存を読んでいる間に、ほかの操作を受けない)
  let cancels = 0;              // 中止を押した回数(訳す前の確かめの最中に押された中止も、効かせる)
  let lvTicket = 0;             // レベルを変える呼び出しの番号(起動を待っている間に、もう一度変えられたら、最後のものだけを効かせる)
  let epoch = 0;                // start・leave ごとに進める(古い非同期の結果を捨てる)
  let starting = null;
  let unhook = [];
  const subs = {};
  EVENTS.forEach(n => { subs[n] = new Set(); });

  const emit = (name, data) => subs[name].forEach(fn => { try { fn(data); } catch (e){} });
  const quiet = p => Promise.resolve(p).catch(() => null);
  const hit = m => quota.hit(m).catch(() => false);          // 数えの失敗で、訳すのを止めない
  // 英語にする文: 固定の順番の上から N%(order.shown)。訳していない間は、その中の未訳の文を、すぐ後ろの訳のある文で埋めて、N% を保つ(order.fill。工程T-2c 利用者)。
  //   訳している間(続きを訳す・訳し直す)は、その前に埋めていた文を、そのまま英語にしておく(訳し始めたときに、出ていた英文を消さない。終わったら決め直す=
  //   続きを訳すで未訳が埋まれば、代わりに英語にしていた文は日本語に戻る)。割合・レベル(順番)が変わったら、前に埋めた文は使わない
  let fillFor = null;
  const shownSet = () => {
    if (!ranks) return new Set();
    const base = order.shown(ranks, ratio);
    if (!model) return base;
    if (job){
      if (fillFor && fillFor.ratio === ratio && fillFor.ranks === ranks && fillFor.model === model) fillFor.set.forEach(sid => { if (have.has(sid)) base.add(sid); });
      return base;
    }
    const out = order.fill(base, model.targets, sid => have.has(sid));
    fillFor = { ratio, ranks, model, set: new Set(Array.from(out).filter(sid => !base.has(sid))) };
    return out;
  };
  const missingOf = () => (model ? model.targets.filter(sid => !have.has(sid)) : []);
  const ready = () => !!model && state !== 'none';
  // 使用中: 訳している・訳す前の確かめ・熟語さがし・レベルの切り替え。この間は、ブレンド(保存から出すのは除く)・続き・訳し直す・熟語さがし・レベルを受けない
  //   (熟語さがしの最中に訳し直すと、古い熟語さがしの保存が、あとから新しい訳を上書きしてしまうため)
  const working = () => !!job || arming || !!ijob || switching;

  function setState(s){
    if (state === s) return;
    state = s;
    emit('state', status());
  }
  function tell(kind, data){
    notice = Object.assign({ kind }, data || {});
    emit('notice', util.clone(notice));
  }
  function clearNotice(kinds){
    if (!notice || (kinds && kinds.indexOf(notice.kind) < 0)) return;
    notice = null;
    emit('notice', null);
  }
  // 読んだ記録(Yomu.log。§8-8)へのつなぎの口。合図を受けて Yomu.log を呼ぶのは、時間の見張り(page/watch.js)。
  //   type = 'open'(英語まじりで出した)/ 'change'(割合・レベル・見せ方・「原文」・訳が変わった)/ 'act'(「あ/A」)/ 'close'(英語まじりをやめた・離れた)
  function logHook(type, data){ emit('log', Object.assign({ type }, data || {})); }

  // ---- 描く(届いた文は、画面の1コマごとにまとめて描く。1文ごとに「読んでいる場所を保つ」で配置を計算し直さないように) ----
  const drawQ = [];
  let drawT = null;
  function drawSoon(fn){
    drawQ.push(fn);
    if (drawT) return;
    // 画面の1コマの合図(requestAnimationFrame)だけに頼らない: ページが裏に回っている間は、合図が来ない(戻っても来ないことがある=工程5b-2
    //   iPhone で、訳している間にほかのアプリへ行って戻ると、その間に届いた文が日本語のままだった、という利用者の報告)。時間でも描く。表に戻ったときにも描く(下の onShow)
    drawT = { t: setTimeout(drawNow, win && win.requestAnimationFrame ? config.pages.drawLateMs : 16) };
    if (win && win.requestAnimationFrame) drawT.raf = win.requestAnimationFrame(drawNow);
  }
  function drawNow(){
    if (drawT){
      if (drawT.raf != null && win && win.cancelAnimationFrame) win.cancelAnimationFrame(drawT.raf);
      if (drawT.t != null) clearTimeout(drawT.t);
      drawT = null;
    }
    if (!drawQ.length) return;
    const list = drawQ.splice(0);
    if (render.attached()) render.batch(() => list.forEach(fn => fn()));
  }

  // ---- 表示(通信しない) ----
  //   出したいとき(view)で、縦組みでなければ、包んで英文を入れて、割合の分を英語にする。そうでなければ、もとの DOM に戻す
  // 包みを外す。keep なら、先に全部を日本語に戻して、読んでいる場所を保ってから(外すだけでは、Safari は位置を合わせない)
  function unwrap(keep){
    drawQ.length = 0;
    if (!render.attached()) return;
    if (keep) render.batch(() => render.apply({ shown: new Set(), wait: false }));
    render.detach();
    logHook('close');
  }
  function paint(){
    if (!model || !view || vertical){
      unwrap(!!model && !vertical);            // 縦組みに変わったときは、もう横の配置ではないので測らない
      return;
    }
    const fresh = !render.attached();
    if (fresh){
      drawQ.length = 0;                        // 待っていた分は、下で have から全部描く(訳と熟語は、描く前に have に入れてある)
      render.attach(model);                    // 包むだけでは見た目は変わらない。読んでいる場所は、包んだあとで測る(render.batch)
    } else drawNow();
    render.batch(() => {
      if (fresh){
        have.forEach((e, sid) => render.setEn(sid, e.en, e.w));
        render.style(style);
        render.theme(themeNow); render.font(font); render.size(size);
        render.orig(orig);
      }
      render.apply({ shown: shownSet(), wait: state === 'busy' || !!job });
    });
    if (fresh) logHook('open');
  }
  // 出し直す(訳が入れかわった: レベルを変えた・訳し直しが1文も届かなかった)
  function repaint(){
    unwrap(!vertical);
    paint();
  }
  // 未訳が少ない(知らせを出すほどでない)か。少ないときは、操作部のつまみの下の小さな字と、メニューの「続きを訳す」だけ(設計メモ 2-5。工程5c-1)
  function fewMissing(n){
    const q = config.pages.quietMiss;
    return n <= Math.max(q.min, Math.floor((model ? model.targets.length : 0) * q.rate));
  }
  function partialNotice(r){
    const n = missingOf().length;
    if (n && have.size && !fewMissing(n)) tell('partial', { missing: n, why: whyOf(null, r && r.rep) });
  }
  // 未訳が残った理由
  function whyOf(err, rep){
    if (err) return err.kind === 'abort' ? 'abort' : 'drop';
    const f = rep && rep.finish;
    return f === 'length' || f === 'drop' || f === 'abort' ? f : 'check';
  }

  // ---- 保存(Yomu.store.pages を通す。§8-4) ----
  const pend = new Map();       // 書くのを待っている PageRec → そのページの文のデータ(離れたあとに書いても、数えられるように)
  let timer = null, chain = Promise.resolve();
  const counts = (r, m) => ({ paras: m.n.paras, sents: m.n.sents, targets: m.n.targets, translated: translate.match(m, r).size });
  // 訳している間は、pages.saveEveryMs ごとに書く(途中でページを離れても、届いた分は残る)
  function later(r, m){
    if (m || model) pend.set(r, m || model);
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, config.pages.saveEveryMs);
  }
  function flush(){
    if (timer){ clearTimeout(timer); timer = null; }
    const list = Array.from(pend);
    pend.clear();
    list.forEach(([r, m]) => { chain = chain.then(() => put(r, m)); });
    return chain;
  }
  async function put(r, m){
    if (!r.s.length) return;                 // 訳が1つも無いものは、保存しない
    r.n = counts(r, m);
    try {
      const out = await store.pages.put(r);
      r.at = out.at; r.upd = out.upd; r.used = out.used;     // put が付けた時刻を、手元にも写す(作った時刻を、書くたびに進めない)
      if (info && info.pageKey === r.page && !saved[r.level]){ saved[r.level] = true; emit('state', status()); }   // 「どのレベルの保存があるか」が変わった
    } catch (e){
      if ((!e || e.kind !== 'full') && info && info.pageKey === r.page) tell('error', { cause: (e && e.kind) || 'store', message: String((e && e.message) || e) });   // いっぱいは、保存の合図(full)で知らせる
    }
  }

  // ---- 起動(§6-7・§9-8): 当てはめ → 保存の起動 → 文のデータ → 保存を探す → 条件が合えば表示(通信なし) ----
  //   o = { doc?, loc?, info? }(省くとページの document と location。info = どのページでもの見分けが見つけた PageInfo=当てはめの代わり)。本文ページでなければ、保存にもさわらない
  function start(o){
    if (state !== 'none' || starting) return starting || Promise.resolve(status());
    const my = ++epoch;
    const p = boot(o || {}, my).catch(e => {
      if (my === epoch) halt('error', { cause: (e && e.kind) || 'error', message: String((e && e.message) || e) });
      return status();
    });
    starting = p;
    p.then(() => { if (starting === p) starting = null; });
    return p;
  }
  async function boot(o, my){
    doc = o.doc || (typeof document !== 'undefined' ? document : null);
    win = doc ? doc.defaultView : null;     // 先に受けておく(jsdom では、document の欄を読むたびに、ページ全体を数え直すため)
    loc = o.loc || (win ? win.location : null);
    diag.mark('wait');
    const found = o.info || (doc && loc ? await sites.wait(loc, doc) : null);   // o.info = どのページでもの見分けが見つけた本文(§9-8。v1.51)
    if (my !== epoch || !found){ diag.mark(found ? 'left' : 'nopage'); return status(); }
    diag.mark('found', found.site);
    // 本文ページなのに、ここから先(保存を読む)が、いつまでも返ってこないことがある(工程5b-2b: iPhone のなろうで、「次へ」のあと、台が出ない)。
    //   何も出ないままにしない: page.stuckMs たっても終わらなければ、知らせる(stuck。直し方を示す)。「ブレンド」は出さない(訳してあるページを、訳していないと見せて、回数を使わせない)。
    //   読むのは、止めない・やり直さない。あとから返ってきたら、知らせを消して、いつもどおりに出す
    const wd = setTimeout(() => {
      if (my !== epoch || state !== 'none' || notice) return;
      diag.mark('stuck');
      tell('stuck', { ios: !!(Y.env && Y.env.info && Y.env.info.ios) });
    }, config.page.stuckMs);
    try { return await bootPage(found, my); }
    finally { clearTimeout(wd); if (my === epoch) clearNotice(['stuck']); }
  }
  async function bootPage(found, my){
    diag.mark('init');
    try { await store.init(); }
    catch (e){
      if (my === epoch) halt(e && e.kind === 'newer' ? 'newer' : 'error', e && e.kind === 'newer' ? { found: e.found, current: e.current } : { cause: (e && e.kind) || 'store', message: String((e && e.message) || e) });
      return status();
    }
    diag.mark('settings');
    await quiet(settings.load());
    if (my !== epoch) return status();
    const s = settings.get();
    const m = extract.page(found);
    diag.mark('extract', m.targets.length);
    if (!m.targets.length) return status();  // 対象の文が無い: 操作部を出さない
    info = found; model = m;
    level = s.level; ratio = s.ratio; style = s.style; orig = false;
    themeSet = s.theme; font = s.enFont; size = s.enSize;
    themeNow = themeOf();
    ranks = order.rank(model, { shortFirst: levels.shortFirst(level) });
    vertical = sites.vertical(info, doc);
    hook();
    diag.mark('load');
    if (!(await load(level, my))) return status();
    diag.mark('ready', have.size);
    // 開き直したら、自動で前と同じ表示に戻す(設計メモ 2-1。通信なし)
    if (have.size && s.restore && rec.on !== false){
      view = true;
      state = 'on';
      paint();
      quiet(store.pages.touch(info.pageKey, level));
      if (vertical) tell('vertical'); else partialNotice(rec);
      emit('state', status());
    } else setState('off');
    return status();
  }
  // そのレベルの保存を読む
  //   → 入れたら true。読んでいる間に離れた(epoch が変わった)なら、何も入れずに false
  async function load(lv, my){
    const page = info.pageKey;
    let r, sv;
    try { r = await store.pages.get(page, lv); } catch (e){ r = undefined; diag.mark('load.nopage', e && e.kind); }   // 新しい版の保存は使わない(書き換えもしない)
    try { sv = await store.pages.saved(page); } catch (e){ sv = {}; }
    if (my !== epoch) return false;
    rec = isPlain(r) ? r : null;
    if (rec && !Array.isArray(rec.s)) rec.s = [];
    have = rec ? translate.match(model, rec) : new Map();
    saved = sv;
    return true;
  }
  // 今使う色の組: 手で選ぶ所を出していない(config.ui.themePick が false)か、設定が「サイトの色に合わせる」なら、本文の背景の色に近い組(読めなければ、初めの組)
  function themeOf(){
    if (config.ui.themePick && themeSet !== theme.AUTO) return theme.has(themeSet) ? themeSet : theme.initial;
    return info ? theme.pick(sites.background(info, doc)) : theme.initial;
  }
  // 色の組を決め直す(設定を変えた・サイトの側で背景の色を変えた)。変わったら、描いて知らせる
  function retheme(){
    const next = themeOf();
    if (next === themeNow) return false;
    themeNow = next;
    if (render.attached()) render.theme(themeNow);
    emit('state', status());
    return true;
  }
  // 縦組みと背景の色の見張り・裏に回ったときの保存・保存の合図
  function hook(){
    const MO = win && win.MutationObserver;
    if (MO && doc.body){
      const mo = new MO(() => { onVertical(); if (info) retheme(); });
      mo.observe(doc.body, { attributes: true, attributeFilter: ['class', 'style'] });   // カクヨムもなろうも、body のクラスで、読み込み直さずに切り替える(縦組み・背景の色)
      mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
      unhook.push(() => mo.disconnect());
    }
    const onHide = () => { if (doc.visibilityState === 'hidden') flush(); else drawNow(); };   // 表に戻った: 裏にいる間に届いた文を、描く
    doc.addEventListener('visibilitychange', onHide);
    unhook.push(() => doc.removeEventListener('visibilitychange', onHide));
    if (win){
      win.addEventListener('pagehide', flush);
      unhook.push(() => win.removeEventListener('pagehide', flush));
    }
    unhook.push(store.on('full', () => tell('full')));
    unhook.push(store.on('evict', e => { if (!notice) tell('evicted', { pages: e.pages }); }));
  }
  // 縦組み ⇄ 横組み(カクヨム): 縦組みでは描かずに知らせる。横組みに戻ったら、通信せずに前の表示に戻す(利用者と決めた。2026-10-03)
  function onVertical(){
    if (!info) return;
    const v = sites.vertical(info, doc);
    if (v === vertical) return;
    vertical = v;
    if (v){ paint(); if (view) tell('vertical'); }
    else {
      clearNotice(['vertical']);
      paint();
      if (!notice && view && !job) partialNotice(rec);    // 未訳が残っていれば、ここで知らせる(訳している最中なら、終わったときに)
    }
    emit('state', status());
  }

  // ---- 訳す(1回)と、熟語さがし(1回) ----
  const aiOf = use => (typeof use === 'string' ? { m: use, think: 'none' } : isPlain(use) && use.m ? { m: use.m, think: use.think || 'none' } : null);
  // kind = 'blend'(保存が無い・使える訳が無い)/ 'more'(続きを訳す)/ 'redo'(訳し直す)
  async function run(kind, use){
    if (working()) return status();
    arming = true;
    emit('state', status());                 // 使用中になった(画面が、回数を使う所を押せなくする)
    const c0 = cancels, my = epoch;
    let go = null;
    try { go = await precheck(kind, use); } finally { if (my === epoch){ arming = false; emit('state', status()); } }   // 確かめが済んだ(送らずに終わっても、使用中でなくなったことを知らせる)
    if (go && cancels !== c0) go = null;     // 確かめている間に中止が押された: 送らない
    return go ? body(kind, go) : status();
  }
  // 訳す前に見るもの(§6-7): キーがあるか・今日そのモデルで1日の上限に当たっていないか。送れるなら { ai, use, switched, s }
  async function precheck(kind, use){
    const my = epoch;
    let key = false;
    try { key = await settings.secrets.has(); } catch (e){}
    if (my !== epoch) return null;
    if (!key){ tell('no-key'); return null; }
    await quiet(settings.load());
    const s = settings.get(), lite = s.aux.lite;
    let ai = aiOf(use) || settings.modelFor(level), switched = null;
    // 今日そのモデルで1日の上限に当たっていれば、送らない(設定が lite なら、Flash-Lite で訳す)
    if (await hit(ai.m)){
      const liteOk = ai.m !== lite && !(await hit(lite));
      if (my !== epoch) return null;
      if (!use && s.onLimit === 'lite' && liteOk){ switched = { from: ai.m, to: lite }; ai = { m: lite, think: 'none' }; use = lite; }
      else { tell('limit-day', { model: ai.m, canLite: liteOk, act: kind }); return null; }
    }
    return my === epoch && !job && !switching ? { ai, use, switched, s, lite, my } : null;
  }
  async function body(kind, go){
    const { ai, use, switched, s, lite, my } = go;
    // 訳を入れる PageRec。続きは今の保存に足す。ブレンドと訳し直しは、新しい訳の番号で作る(知らない欄・keep の印は、前の保存から引き継ぐ)
    const prev = { rec, have };
    let work = rec;
    if (kind !== 'more'){
      work = Object.assign({}, rec || {}, {
        page: info.pageKey, work: info.workKey, site: info.site, level, title: { work: info.title.work, ep: info.title.ep }, path: loc ? String(loc.pathname) : '',
        tr: util.uid('tr'), on: true, model: ai.m, think: ai.think, provider: s.provider, promptV: prompts.V, wireV: wire.V,
        state: 'partial', idioms: 'none', s: [], rep: null, runs: [], keep: (rec && rec.keep) || 0, x: (rec && isPlain(rec.x)) ? rec.x : {}
      });
      delete work.at;
      rec = work; have = new Map();
      if (kind === 'redo') unwrap(true);       // 前の英文を外す(新しい訳で描き直す。読んでいる場所は保つ)
    }
    const j = job = { kind, ctrl: new AbortController(), rec: work, got: [], held: [], model };
    const view0 = view;
    view = true; lapsed = false;
    setState('busy');
    if (switched) tell('switched-lite', switched);
    paint();
    let out = null, err = null;
    try {
      out = await translate.page({ model, level, rec: kind === 'more' ? work : null, use, page: info.pageKey, tr: work.tr, signal: j.ctrl.signal, on: {
        item(sid, en, f, nk){
          if (job !== j) return;
          if (nk){ j.held.push({ sid, en, f }); return; }   // 番号だけで決めた文: rep.suspect を見てから使う(返事の終わりにまとめて来るので、待たせても遅れない)
          accept(j, sid, en, f);
        },
        progress(got, total){ if (job === j) emit('progress', { got, total }); }
      } });
    } catch (e){ err = e || util.error('error', '失敗'); out = err; }
    if (job !== j){                          // 離れた(leave): 届いた文は leave が書いた。通信の記録の id だけ足して書く
      if (out && out.run && j.got.length && !(info && info.pageKey === j.rec.page)){ j.rec.runs = (Array.isArray(j.rec.runs) ? j.rec.runs : []).concat([out.run]); later(j.rec, j.model); flush(); }
      return status();
    }
    const rep = out && isPlain(out.rep) ? out.rep : null;
    // 番号がずれた疑い(§6-4 の suspect): 番号だけで決めた文を、出さずに、保存せずに捨てて知らせる(利用者と決めた。2026-10-03)
    const suspect = !!(rep && rep.suspect === 1);
    if (!suspect) j.held.forEach(x => accept(j, x.sid, x.en, x.f));
    drawNow();
    job = null;
    const gotNow = j.got.length;
    if (gotNow){
      if (out && out.model) work.model = out.model;
      ['think', 'provider', 'promptV', 'wireV'].forEach(k => { if (out && out[k] != null) work[k] = out[k]; });
      if (rep) work.rep = rep;
    }
    if (out && out.run) work.runs = (Array.isArray(work.runs) ? work.runs : []).concat([out.run]);
    work.state = translate.missing(model, work).length ? 'partial' : 'done';
    if (kind === 'more' && gotNow && work.idioms === 'done') work.idioms = 'partial';   // 足した文には、まだ熟語が無い(熟語さがしが送れなかったら、やり直せるように)
    if (gotNow || kind === 'more') later(work);
    else { rec = prev.rec; have = prev.have; view = view && view0; }   // 1文も届かなかった: 前の保存と表示のまま(訳し直しでも、前の訳を捨てない。日本語で出していたなら日本語のまま。訳している間に日本語に戻したなら、戻したまま)
    if (!have.size) view = false;
    setState(view ? 'on' : 'off');
    if (kind === 'redo' && !gotNow) repaint(); else paint();
    flush();
    // 知らせ(1つ)。訳している間に出した古い知らせ(残り・縦組み)は、いったん消す
    const missing = missingOf().length;
    clearNotice(gotNow ? ['partial', 'vertical'] : ['partial', 'vertical', 'switched-lite']);
    if (suspect && j.held.length) tell('suspect', { dropped: j.held.length, act: kind });
    else if (err && err.kind !== 'abort' && !gotNow) await errorNotice(err, ai, lite, kind, my);
    else if (rep && rep.finish === 'blocked') tell('blocked', { got: gotNow });
    else if (!err && !gotNow) tell('error', { cause: 'empty', message: '' });   // 通信はしたが、使える訳が1つも返ってこなかった(どれも確かめを通らなかった など)
    else if (missing && have.size && view && (err || (gotNow && !fewMissing(missing)))) tell('partial', { missing, why: whyOf(err, rep), cause: err ? err.kind : null });   // 途中で切れたときは、少なくても知らせる(熟語さがしも、まだ)
    if (my !== epoch) return status();
    if (vertical && view && (!notice || notice.kind === 'partial')) tell('vertical');   // 縦組みの間は、縦組みの知らせ(残りの知らせは、横組みに戻ったときに出す)
    if (gotNow) logHook('change', { tr: work.tr });
    // 熟語さがし(1回)。翻訳が失敗で終わったとき(つながらない・中止 など)は送らない(メニューの「熟語さがしをやり直す」で送れる)
    if (gotNow && !err && my === epoch) await idiomsFor(work);
    return status();
  }
  // 届いた1文を、保存の記録と画面に入れる
  function accept(j, sid, en, f){
    const s = model.sents[sid];
    if (!s || typeof en !== 'string') return;
    const e = { h: s.h, o: s.o, i: sid, en };
    if (f) e.f = f;
    const old = have.get(sid);
    if (old){ const k = j.rec.s.indexOf(old); if (k >= 0) j.rec.s.splice(k, 1); }
    j.rec.s.push(e);
    have.set(sid, e);
    j.got.push(sid);
    drawSoon(() => render.setEn(sid, en));
    later(j.rec);
    emit('sentence', { sid, en });
  }
  async function errorNotice(err, ai, lite, kind, my){
    const k = err.kind;
    if (k === 'limit-day'){
      const m = err.model || ai.m, canLite = m !== lite && !(await hit(lite));
      if (my === epoch) tell('limit-day', { model: m, canLite, act: kind });     // 調べている間に離れたら、次のページに知らせない
    }
    else if (k === 'limit-min') tell('limit-min', { model: err.model || ai.m, retrySec: err.retrySec == null ? null : err.retrySec });
    else if (k === 'no-key') tell('no-key');
    else tell('error', { cause: k || 'error', message: String(err.message || k || '') });
  }
  // 熟語さがしで、送った文の半分以上(config.idioms.noteShare)が届かなかったか
  const lostMany = rep => !!(rep && rep.sent > 0 && Array.isArray(rep.missing) && rep.missing.length / rep.sent >= config.idioms.noteShare);
  // 熟語さがし。sids を省くと、訳のある文のうち、まだ熟語さがしをしていない文(§6-5)
  async function idiomsFor(r){
    if (ijob) return;
    const my = epoch;
    const j = ijob = { ctrl: new AbortController(), rec: r };   // 待つ前に「使用中」にする(二度押し・訳し直しを受けない)
    emit('state', status());
    await quiet(settings.load());
    const m = settings.get().aux.idiom;
    const limited = await hit(m);
    if (ijob !== j) return;                                     // 離れた・止めた
    if (limited || j.ctrl.signal.aborted){
      ijob = null;
      if (limited){
        r.idioms = 'failed';
        later(r); flush();
        if (!notice) tell('idioms-failed', { cause: 'limit-day' });
      }
      emit('state', status());
      return;
    }
    const map = translate.match(model, r);
    j.model = model; j.n = 0;
    let out = null, err = null;
    try {
      out = await translate.idioms({ model, rec: r, level: r.level, page: info.pageKey, tr: r.tr, signal: j.ctrl.signal, on: {
        item(sid, words, g){
          if (ijob !== j) return;
          const e = map.get(sid);
          if (!e) return;
          e.w = words;
          if (g) e.g = g;
          j.n++;
          if (r === rec) drawSoon(() => { if (r === rec) render.setWords(sid, words); });
          later(r);
        }
      } });
    } catch (e){ err = e || util.error('error', '失敗'); out = err; }
    if (ijob !== j){                         // 離れた(leave): 届いた熟語と通信の記録だけ書く
      if (j.n && !(info && info.pageKey === r.page)){ if (r.idioms !== 'done') r.idioms = 'partial'; if (out && out.run) r.runs = (Array.isArray(r.runs) ? r.runs : []).concat([out.run]); later(r, j.model); flush(); }
      return;
    }
    drawNow();
    ijob = null;
    const st = out && typeof out.state === 'string' ? out.state : 'failed';
    // 届かなかった文(out.rep.missing)には、w を入れない: state は partial になり、メニューの「熟語さがしをやり直す」で、その文だけを送り直せる(工程T-5b。
    //   それまでは、返事が最後まで来れば、届かなかった文にも w: [] を入れていた=AI が途中で終えた・書きまちがえた返事で、やり直せなかった)
    if (!(err && err.kind === 'abort' && st === 'failed')) r.idioms = st;   // 中止で1文も届かなければ、前のまま
    if (out && out.run) r.runs = (Array.isArray(r.runs) ? r.runs : []).concat([out.run]);
    later(r); flush();
    if (st === 'failed' && !(err && err.kind === 'abort') && !notice) tell('idioms-failed', { cause: err ? err.kind || 'error' : (out && out.rep && out.rep.finish === 'blocked' ? 'blocked' : 'empty') });
    // 途中までしか届かなかった: 送った文の半分以上(config.idioms.noteShare)が届かなかったときだけ知らせる。少しなら知らせず、メニューの「熟語さがしをやり直す」だけ(2026-10-17 利用者。工程T-5b)
    else if (st === 'partial' && !(err && err.kind === 'abort') && !notice && lostMany(out && out.rep)) tell('idioms-partial', { missing: out.rep.missing.length, sent: out.rep.sent });
    emit('state', status());
  }

  // ---- 止める・離れる ----
  function cancel(){
    cancels++;
    if (job) job.ctrl.abort();
    if (ijob) ijob.ctrl.abort();
  }
  // 片づける(URL が変わった・止めた)。訳している途中なら中止し、届いた分を書いてから
  function leave(){
    epoch++;
    const jobs = [job, ijob].filter(Boolean);
    if (job){ later(job.rec); job.held.length = 0; }
    job = null; ijob = null; arming = false; switching = false; starting = null;
    jobs.forEach(x => x.ctrl.abort());
    const done = flush();
    drawNow();
    drawQ.length = 0;
    if (render.attached()){ render.detach(); logHook('close'); }
    unhook.splice(0).forEach(fn => { try { fn(); } catch (e){} });
    info = null; model = null; ranks = null; rec = null; have = new Map(); view = false; lapsed = false; vertical = false; orig = false; saved = {};
    clearNotice();                           // 知らせが出ていたら、消したことを知らせる(状態が none のままでも、画面が古い知らせを残さないように)
    setState('none');
    return done.then(() => status());
  }
  // 動かずに知らせる(新しい版のデータ・今の版と同時に動いている など)
  function halt(kind, data){
    const p = leave();
    tell(kind, data);
    return p;
  }

  // ---- 状態 ----
  function status(){
    const shown = shownSet();
    let n = 0;
    shown.forEach(sid => { if (have.has(sid)) n++; });
    return {
      state, level, ratio, style, orig, vertical, page: info ? info.pageKey : null,
      theme: themeSet, themeNow, font, size,       // 見た目(theme = 設定の値。themeNow = 今使っている色の組)
      n: { targets: model ? model.n.targets : 0, translated: have.size, missing: missingOf().length, shown: n },
      saved: Object.assign({}, saved),
      idioms: ijob ? 'busy' : rec ? rec.idioms || 'none' : 'none',
      busy: working(),                         // 使用中(訳している・確かめている・熟語さがし・レベルの切り替え)。画面の側で、続き・訳し直す・レベルを押せなくする
      notice: notice ? util.clone(notice) : null
    };
  }

  // 読んだ記録に渡すもの(§8-8 の ctx と、時間を配る段落の要素)。英語まじりで描いていなければ null。数字だけ(ページの文章は入れない)
  //   段落ごとの数(Row)は、割合・レベル・「原文」で決まる表示で数える(「あ/A」で戻した分は引かない)。文の無い段落(空行・記号だけの行)は入れない
  function reading(){
    if (!model || !info || !rec || !render.attached()) return null;
    const shown = shownSet(), paras = [], els = [];
    model.paras.forEach(p => {
      if (!p.sents.length) return;
      const row = { p: p.i, jc: p.jpChars, sn: p.sents.length, tg: 0, se: 0, ew: 0, je: 0 };
      p.sents.forEach(sid => {
        const s = model.sents[sid], e = have.get(sid);
        if (s.target) row.tg++;
        if (orig || !e || !shown.has(sid)) return;
        row.se++; row.ew += text.words(e.en); row.je += text.norm(s.text).length;
      });
      paras.push(row);
      els.push([p.i, p.el]);
    });
    return {
      ctx: { page: info.pageKey, work: info.workKey, site: info.site, level, tr: rec.tr || null, title: { work: info.title.work, ep: info.title.ep },
        ratio, orig, style, model: rec.model || null, promptV: rec.promptV == null ? null : rec.promptV, paras },
      els
    };
  }

  Yomu.page = {
    start,
    get state(){ return state; },
    // 「ブレンド」: 保存があれば出す(通信なし)。無ければ訳す。o = { use? }(「Flash-Lite で訳す」= use にモデルの名前)
    async blend(o){
      o = o || {};
      if (!ready() || switching) return status();
      if (vertical){ clearNotice(); tell('vertical'); return status(); }      // 縦組み: 描かずに知らせる(通信しない)
      // 訳があれば出す(通信なし)。熟語さがしの最中・訳している最中でも出せる
      if (have.size){
        if (!view){
          clearNotice();
          view = true; lapsed = false; setState(job ? 'busy' : 'on'); paint();
          quiet(store.pages.touch(info.pageKey, level));
          if (!job) partialNotice(rec);
        }
        return status();
      }
      if (working()) return status();
      clearNotice();
      return run('blend', o.use);
    },
    // 「続きを訳す」(未訳の対象だけ・1回分)
    async more(o){
      if (!ready() || working() || !rec || !have.size) return status();
      if (vertical){ tell('vertical'); return status(); }
      if (!missingOf().length) return status();
      clearNotice();
      return run('more', o && o.use);
    },
    // 「訳し直す」(今のレベルの保存を、新しい訳で置きかえる。1文も届かなければ、前の訳のまま)
    async redo(o){
      if (!ready() || working()) return status();
      if (vertical){ tell('vertical'); return status(); }
      clearNotice();
      return run('redo', o && o.use);
    },
    // 熟語さがしのやり直し(1回分)
    async idioms(){
      if (!ready() || working() || ijob || !rec || !have.size) return status();
      clearNotice(['idioms-failed', 'idioms-partial']);
      await idiomsFor(rec);
      return status();
    },
    cancel,
    // 日本語に戻す(表示だけ。保存は残る)
    off(){
      if (!ready()) return;
      if (arming) cancels++;                     // 確かめの最中: 送らない(送ってから英語に戻るのを防ぐ)
      if (job) job.ctrl.abort();
      view = false; lapsed = false;
      paint();
      clearNotice(['vertical', 'partial']);
      setState(job ? 'busy' : 'off');
    },
    leave,
    halt,
    flush,
    // 割合(0〜100・ratio.step 刻み)。o.save が false なら、設定に残さない(つまみを動かしている間)
    setRatio(r, o){
      if (typeof r !== 'number' || !isFinite(r)) return;
      const v = Math.min(100, Math.max(0, Math.round(r / config.ratio.step) * config.ratio.step));
      const changed = v !== ratio;
      ratio = v;
      if (render.attached()) render.apply({ shown: shownSet(), wait: state === 'busy' });
      if (changed){ emit('state', status()); logHook('change', { ratio: v }); }
      if (!o || o.save !== false) quiet(settings.set({ ratio: v }));
    },
    // 学習レベル: そのレベルの保存があれば切り替える(通信なし)。無ければ日本語に戻して need-translate
    async setLevel(id){
      if (!levels.has(id)) throw util.error('bad', 'レベルがおかしい: ' + id);
      const tk = ++lvTicket;
      // 起動の最中: 起動を待ってから(起動が読んでいるレベルの保存と食い違わないように)。待っている間に、もう一度変えられたら、最後のものだけ
      while (!ready() && starting){ await starting; if (tk !== lvTicket) return status(); }
      if (working()) return status();                     // 使用中は変えない(設定も変えない。画面の側でも押せなくする)
      if (!ready()){
        await quiet(settings.set({ level: id }));
        if (tk !== lvTicket) return status();
        if (starting || ready()) return Yomu.page.setLevel(id);   // 書いている間に起動が始まった: 起動を待って、切り替え直す
        level = id;
        return status();
      }
      if (id === level) return status();
      const my = epoch;
      switching = true;
      let ok = false;
      try {
        await quiet(settings.set({ level: id }));
        if (my !== epoch) return status();
        level = id;
        ranks = order.rank(model, { shortFirst: levels.shortFirst(level) });
        ok = await load(id, my);
      } finally { if (my === epoch) switching = false; }
      if (!ok) return status();
      clearNotice();
      if (view || lapsed){
        if (have.size){ view = true; lapsed = false; repaint(); setState('on'); quiet(store.pages.touch(info.pageKey, level)); if (vertical) tell('vertical'); else partialNotice(rec); }
        else { lapsed = true; view = false; paint(); setState('off'); tell('need-translate', { level: id }); }
      }
      logHook('change', { level: id });
      emit('state', status());
      return status();
    },
    setStyle(name){
      if (STYLES.indexOf(name) < 0) throw util.error('bad', '見せ方がおかしい: ' + name);
      // 見せ方を切り替えたら、書体も一緒に変える(マーカー → ゴシック体/書体だけ → セリフ体。そのあとで、選び直せる。2026-10-09 利用者に示した形)
      const changed = name !== style;
      style = name;
      if (changed) font = theme.fontFor(name);
      if (render.attached()) render.batch(() => { render.style(name); render.font(font); });
      quiet(settings.set(changed ? { style: name, enFont: font } : { style: name }));
      emit('state', status());
      logHook('change', { style: name });
    },
    // 見た目(通信しない)。色の組: 'auto'(サイトの色に合わせる)か、色の組の名前
    setTheme(name){
      if (!theme.choice(name)) throw util.error('bad', '色の組がおかしい: ' + name);
      themeSet = name;
      quiet(settings.set({ theme: name }));
      if (!retheme()) emit('state', status());
    },
    // 英文の書体('sans'|'serif'|'site')
    setFont(name){
      if (theme.fonts().indexOf(name) < 0) throw util.error('bad', '書体がおかしい: ' + name);
      font = name;
      if (render.attached()) render.font(name);
      quiet(settings.set({ enFont: name }));
      emit('state', status());
    },
    // 英文の文字の大きさ('s'|'m'|'l')
    setSize(name){
      if (theme.sizes().indexOf(name) < 0) throw util.error('bad', '文字の大きさがおかしい: ' + name);
      size = name;
      if (render.attached()) render.size(name);
      quiet(settings.set({ enSize: name }));
      emit('state', status());
    },
    // 「原文」(全部を一時的に日本語に。設定には残さない)
    setOrig(on){
      orig = !!on;
      if (render.attached()) render.orig(orig);
      emit('state', status());
      logHook('change', { orig: orig ? 1 : 0 });
    },
    // 「あ/A」: 英語で出ている文を日本語に、戻した文を英語に
    toggle(sid){
      const st = render.state(sid);
      const to = st === 'en' ? 'jp' : st === 'back' ? 'en' : null;
      if (!to || !render.flip(sid, to)) return false;
      logHook('act', { kind: to === 'jp' ? 'toJp' : 'toEn', sid: Number(sid) });
      return true;
    },
    // 知らせを閉じる(画面の「×」・「あとにする」)。表示も保存も変えない。未訳や、熟語さがしの失敗は、status() の n.missing・idioms に残っている
    dismiss(){ clearNotice(); },
    status,
    reading,
    // 単語の板(ui/word.js)に渡すもの: 今、その文に描いてある英文と熟語・日本語の原文・例文に付けるページの情報。描いていなければ null(通信しない)
    sentence(sid){
      const s = model && model.sents[Number(sid)], d = render.drawn(sid);
      if (!s || !d || !info) return null;
      return { sid: s.sid, en: d.en, jp: s.text, words: util.clone(d.words), page: info.pageKey, work: info.workKey, title: { work: info.title.work, ep: info.title.ep } };
    },
    on(name, fn){
      if (!subs[name] || typeof fn !== 'function') throw util.error('bad', '合図の名前がおかしい: ' + name);
      subs[name].add(fn);
      return () => subs[name].delete(fn);
    }
  };
})();

/* ---- ui/style.js ---- */
// ui/style.js — 操作部の CSS(部品の約束 §9-2)。Shadow DOM の中だけに効く。並びは、キャンバスの2ページ目・3ページ目(design/round2・round3 の gen.js)
//   色は、名前を付けた値(core/theme.js)を CSS の変数で読む(色の値を、ここに直接書かない)。書体は、端末に入っているものだけ(Web フォントを読み込まない)
//   大きさは、画面の物差し(部品の約束 §9-9。値は core/config.js の ui.type・leading・tap・grid)だけを使う:
//     字の大きさは5段階(14・16・18・20・28)・行間は3つ(1.3・1.5・1.7)・押せる所は 44px 以上・余白は 4 の倍数(細かい合わせに限り 2)。外すと check_ui_dock が止める
//     字の大きさは px で書く(rem にすると、サイトの <html> の字の大きさに引きずられる)
(function(){
  'use strict';
  const theme = Yomu.theme, cfg = Yomu.config;

  const FJ = '"Zen Kaku Gothic New","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Meiryo",sans-serif';
  const FE = '"Plus Jakarta Sans","Avenir Next","Segoe UI",system-ui,sans-serif';
  const FS = 'ui-serif,"Newsreader","Iowan Old Style","Charter",Georgia,serif';
  const v = key => 'var(' + theme.varName(key) + ')';
  const KNOB = 28;                  // 割合のつまみの丸の幅(px。ui/dock.js が、指の位置から割合を出すのにも使う)

  function css(){
    const u = cfg.ui;
    const CAP = u.type[0], BODY = u.type[1], LEAD = u.type[2], TITLE = u.type[3], HEAD = u.type[4];   // 字の大きさの段階(px)
    const TIGHT = u.leading[0], BASE = u.leading[1], LOOSE = u.leading[2];                             // 行間
    const TAP = u.tap.min, BTN = u.tap.std, BIG = u.tap.big, GAP = u.tap.gap;                          // 押せる所の高さと、となりとの間(px)
    const MO = u.motion, ms = n => (n / 1000) + 's';                                                   // 動きの長さ(§9-9)
    const PILL = '999px';                                                                              // 両はしが丸い形
    // 字: 大きさ・太さ・行間を、ひとまとめに書く
    const t = (size, weight, lh) => 'font-size: ' + size + 'px; font-weight: ' + weight + '; line-height: ' + lh + ';';
    // 行の頭の絵(18px)を、1行目の字の高さの真ん中に置く
    const iconTop = lh => 'margin-top: calc((' + lh + 'em - 18px) / 2);';
    return [
      // 土台: サイトの CSS を入れない・縦組みのページでも横書き(§9-2)。サイトの側の決まりに負けないよう !important
      ':host { all: initial !important; display: block !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important;'
        + ' z-index: 2147483647 !important; writing-mode: horizontal-tb !important; direction: ltr !important; }',
      // 色の組(core/theme.js)。土台の印 data-theme で切り替える(印が無い・知らない名前なら、初めの組)
      ':host { ' + theme.vars(theme.initial) + ' }'
    ].concat(theme.names().filter(n => n !== theme.initial).map(n => ':host([data-theme="' + n + '"]) { ' + theme.vars(n) + ' }'), [
      '.yomu { font-family: ' + FJ + '; ' + t(BODY, 500, BASE) + ' color: ' + v('panelInk') + '; text-align: left; letter-spacing: normal;'
        + ' -webkit-text-size-adjust: 100%; text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }',
      '.yomu *, .yomu *::before, .yomu *::after { box-sizing: border-box; }',
      '.yomu [hidden] { display: none !important; }',
      // 押せる所は、どれも 44px 以上(§9-9。ここで下限を決める。部品の決まりで、これより小さい min-width・min-height を書かない)
      'button { font: inherit; color: inherit; letter-spacing: inherit; border: none; background: none; margin: 0; padding: 0; cursor: pointer; min-width: ' + TAP + 'px; min-height: ' + TAP + 'px;'
        + ' -webkit-appearance: none; appearance: none; touch-action: manipulation; -webkit-user-select: none; user-select: none; }',
      'button:focus-visible { outline: 2px solid ' + v('key') + '; outline-offset: 2px; }',
      'button[disabled] { opacity: 0.45; cursor: default; }',
      'svg { display: block; flex: none; }',
      // 読み上げ用の知らせの置き場(画面には出さない)
      '.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }',
      '.en { font-family: ' + FE + '; }',
      '.serif { font-family: ' + FS + '; }',

      // 画面の下の置き場(知らせ・入口のボタン・操作部を、下から積む)。下へ読み進めている間は、下へ引っこめる(data-away)
      '.bay { position: fixed; left: calc(16px + env(safe-area-inset-left, 0px)); right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(' + u.bottom + 'px + var(--lift, 0px) + env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column;'
        + ' align-items: stretch; gap: ' + GAP + 'px; pointer-events: none; transition: transform ' + ms(MO.bay) + ' ease-out, opacity ' + ms(MO.bay) + ' ease-out, visibility 0s linear 0s; }',
      // 段(上から 知らせ・操作部)。空いている所のタップは、下のページに通す(押せるのは、部品そのものだけ)
      '.slot { display: flex; flex-direction: column; align-items: stretch; gap: ' + GAP + 'px; pointer-events: none; }',
      '.slot > * { pointer-events: auto; }',
      '.bay[data-away] { transform: translateY(calc(100% + var(--lift, 0px) + ' + (u.bottom + 28) + 'px)); opacity: 0; visibility: hidden; transition-delay: 0s, 0s, ' + ms(MO.bay) + '; }',   // 隠れたあとは、キーボードでも入れない
      '.bay[data-away] .slot > * { pointer-events: none; }',
      // ロゴ(重なる2枚の栞)
      '.mark .a { fill: ' + v('logoA') + '; }',
      '.mark .b { fill: ' + v('logoB') + '; fill-opacity: 0.88; }',
      '@media (min-width: ' + u.wideMin + 'px) { .bay { left: auto; right: 16px; width: ' + u.wideWidth + 'px; } }',
      '@media (prefers-reduced-motion: reduce) { .bay, .ratio .tip, .prog .fill { transition: none !important; } .sheet { animation: none !important; } }',

      // 短い知らせ(いちばん手前。操作部の少し上)
      '.toast { position: fixed; left: 50%; bottom: calc(' + (u.bottom + 80) + 'px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); width: max-content; max-width: calc(100% - 32px); padding: 8px 16px; border-radius: 20px; background: ' + v('tip') + '; color: ' + v('tipInk') + ';'
        + ' ' + t(CAP, 700, BASE) + ' box-shadow: ' + v('shadow') + '; }',

      // 下から出る板(キャンバスの sheetShell)。まわりを暗くする。広い画面では、右下に寄せる
      '.layer { position: fixed; left: 0; top: 0; right: 0; bottom: 0; }',
      '.scrim { position: absolute; left: 0; top: 0; right: 0; bottom: 0; background: ' + v('scrim') + '; touch-action: none; }',
      '.sheet { position: absolute; left: 0; right: 0; bottom: 0; max-height: 86%; overflow-y: auto; overscroll-behavior: contain; background: ' + v('panel') + '; border-radius: 28px 28px 0 0;'
        + ' box-shadow: ' + v('sheetShadow') + '; padding: 12px 20px calc(20px + env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column; outline: none; animation: y-up ' + ms(MO.sheet) + ' ease-out; }',
      '.sheet .grip { flex: none; align-self: center; width: 40px; height: 4px; border-radius: 2px; background: ' + v('grip') + '; margin-bottom: 12px; }',
      '.sheet .body { display: flex; flex-direction: column; }',
      '@keyframes y-up { from { transform: translateY(100%); } to { transform: none; } }',
      '@media (min-width: ' + u.wideMin + 'px) { .sheet { left: auto; right: 16px; bottom: 16px; width: ' + u.wideSheet + 'px; max-width: calc(100% - 32px); border-radius: 28px; padding-bottom: 20px; } }',
      '@media (min-width: ' + u.wideMin + 'px) { .toast { left: auto; right: ' + (16 + u.wideSheet / 2) + 'px; transform: translateX(50%); max-width: ' + u.wideSheet + 'px; } }',
      // 板の中の、よく使う形
      '.top { display: flex; align-items: center; justify-content: space-between; gap: 4px; }',
      '.brand { display: flex; align-items: center; gap: 8px; font-family: ' + FS + '; ' + t(TITLE, 500, TIGHT) + ' }',
      '.heading { flex: 1 1 auto; ' + t(LEAD, 700, TIGHT) + ' }',
      // 絵だけのボタン(とじる・もどる)。絵のはしを、板の中身のはしにそろえる(箱 44px・絵 20px なので、12px 外へ)
      '.iconbtn { width: ' + TAP + 'px; height: ' + TAP + 'px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: ' + v('panelMuted') + '; }',
      '.iconbtn.end { margin-right: -12px; }',
      '.iconbtn.start { margin-left: -12px; color: ' + v('panelInk') + '; }',
      // 区分の見出し。上の仲間からは離し、自分の仲間には寄せる(上の間 > 下の間)
      '.label { ' + t(CAP, 700, BASE) + ' color: ' + v('panelMuted') + '; margin: 12px 0 8px; }',
      '.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: ' + GAP + 'px; }',
      // メニュー(キャンバス3ページ目)
      '.tile { min-height: ' + BTN + 'px; border-radius: ' + PILL + '; background: ' + v('well') + '; color: ' + v('panelInk') + '; ' + t(BODY, 700, TIGHT)
        + ' display: flex; align-items: center; justify-content: center; gap: 8px; padding: 4px 12px; }',
      '.tile.wide { grid-column: 1 / -1; }',
      '.tile .two { display: flex; flex-direction: column; align-items: flex-start; text-align: left; }',
      '.tile .cost { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.tile[data-armed] { background: ' + v('key') + '; color: ' + v('keyInk') + '; }',
      '.tile[data-armed] .cost { color: inherit; opacity: 0.85; }',
      '.rows { margin-top: 16px; border: 1px solid ' + v('grip') + '; border-radius: 20px; display: flex; flex-direction: column; overflow: hidden; }',
      '.rowbtn { min-height: ' + BIG + 'px; padding: 4px 12px 4px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; ' + t(BODY, 700, TIGHT) + ' }',
      '.rowbtn + .rowbtn { border-top: 1px solid ' + v('grip') + '; }',
      '.rowbtn[data-armed] { background: ' + v('key') + '; color: ' + v('keyInk') + '; }',   // 2回タップの 1 回目(メニューの「このサイトでは、右下のボタンを出さない」。工程8c-2)
      '.rowbtn[data-armed] .val { color: inherit; }',
      // 行の名前(左)は、縮めない=右の値が長くても、名前が1字ずつ縦に折れない(工程5b-3: PC の Edge の声の名前)。長い値は、右の側で折り返す
      '.rowbtn > span:first-child { flex: none; max-width: calc(100% - 34px); }',
      '.rowbtn .val { display: flex; align-items: center; gap: 4px; ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      // 見た目(英文の見せ方の札。キャンバス2ページ目のメニューの形)
      '.pick { min-height: 96px; border-radius: 16px; background: ' + v('well') + '; color: ' + v('panelInk') + '; padding: 12px; display: flex; flex-direction: column; justify-content: space-between; gap: 4px; text-align: left; }',
      '.pick[aria-pressed="true"] { background: ' + v('panel') + '; box-shadow: 0 0 0 2px ' + v('key') + '; }',
      '.pick .name { display: flex; align-items: center; justify-content: space-between; min-height: 24px; ' + t(BODY, 700, TIGHT) + ' }',
      // 選んだ印は、色のほかに、形(チェック)でも出す(色の見分けにくい人にも分かるように=§9-9)
      '.pick .tick { width: 24px; height: 24px; border-radius: 50%; background: ' + v('key') + '; color: ' + v('keyInk') + '; display: flex; align-items: center; justify-content: center; }',
      '.pick .sample { ' + t(BODY, 400, BASE) + ' }',
      '.pick .s-marker { font-family: ' + FE + '; ' + t(CAP, 500, BASE) + ' color: ' + v('enInk') + '; background: ' + v('enBg') + '; border-radius: 4px; padding: 2px 4px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }',
      '.pick .s-quiet { font-family: ' + FS + '; ' + t(BODY, 400, BASE) + ' color: ' + v('quietInk') + '; }',
      // 見た目: テーマ(サイトの色に合わせる・色の組の札)と、横に並ぶ選ぶボタン(書体・文字の大きさ)。キャンバス3ページ目の「メニュー › 見た目」
      '.look .label { margin-top: 20px; }',
      '.look .top + .label { margin-top: 8px; }',
      '.look .auto { width: 100%; min-height: ' + BIG + 'px; border-radius: 16px; background: ' + v('well') + '; color: ' + v('panelInk') + '; padding: 8px 16px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; ' + t(BODY, 700, TIGHT) + ' }',
      '.look .auto[aria-pressed="true"] { background: ' + v('panel') + '; box-shadow: 0 0 0 2px ' + v('key') + '; }',
      '.look .auto .two { display: flex; flex-direction: column; }',
      '.look .auto .now { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.look .auto .tick { width: 24px; height: 24px; flex: none; border-radius: 50%; background: ' + v('key') + '; color: ' + v('keyInk') + '; display: flex; align-items: center; justify-content: center; }',
      '.grid4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: ' + GAP + 'px; }'
    ], theme.names().map(n => '.sw[data-set="' + n + '"] { ' + theme.vars(n) + ' }'), [   // 札の中だけ、色の名前を、その組の値にする
      '.sw, .seg button { position: relative; }',
      '.sw .tick, .seg .tick { position: absolute; top: -4px; right: -4px; width: 20px; height: 20px; border-radius: 50%; background: ' + v('key') + '; color: ' + v('keyInk') + '; box-shadow: 0 0 0 2px ' + v('panel') + '; display: flex; align-items: center; justify-content: center; }',
      '.sw { height: 72px; border-radius: 16px; background: ' + v('panel') + '; color: ' + v('panelInk') + '; box-shadow: 0 0 0 1px ' + v('grip') + '; padding: 8px 8px 8px 12px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; text-align: left; }',
      '.sw[aria-pressed="true"] { box-shadow: 0 0 0 2.5px ' + v('key') + '; }',
      '.sw .abc { font-family: ' + FE + '; ' + t(CAP, 500, BASE) + ' background: ' + v('enBg') + '; color: ' + v('enInk') + '; border-radius: 4px; padding: 0 4px; }',
      '.sw .nm { ' + t(CAP, 700, BASE) + ' white-space: nowrap; }',
      '.seg { display: flex; gap: ' + GAP + 'px; }',
      // 横に3つ並ぶので、16px では幅 320 に収まらない(「サイトと同じ」)。14px にする
      '.seg button { flex: 1 1 0; min-height: ' + BTN + 'px; border-radius: ' + PILL + '; background: ' + v('well') + '; color: ' + v('panelInk') + '; ' + t(CAP, 700, TIGHT) + ' padding: 4px 8px; white-space: normal; overflow-wrap: anywhere; }',
      '.seg button[aria-pressed="true"] { background: ' + v('key') + '; color: ' + v('keyInk') + '; }',
      '.seg .f-sans { font-family: ' + FE + '; }',
      '.seg .f-serif { font-family: ' + FS + '; font-size: ' + BODY + 'px; }',

      // 単語の板(キャンバス 4・4b・3ページ目の「単語の板 — もとの語」)
      '.word .tags { display: flex; align-items: center; gap: 8px; min-height: ' + TAP + 'px; }',
      '.word .tags .iconbtn { margin-left: auto; }',
      '.word .tags .src + .iconbtn { margin-left: 0; }',
      '.word .tag { min-height: 28px; border-radius: ' + PILL + '; background: ' + v('soft') + '; color: ' + v('softInk') + '; ' + t(CAP, 700, TIGHT) + ' display: flex; align-items: center; padding: 0 12px; }',
      '.word .src { margin-left: auto; ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.word .headrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: ' + BTN + 'px; }',
      '.word .head { font-family: ' + FE + '; ' + t(HEAD, 800, TIGHT) + ' letter-spacing: -0.01em; overflow-wrap: anywhere; }',
      '.word .head.long { font-size: ' + TITLE + 'px; }',
      '.word .sayword { width: ' + BTN + 'px; height: ' + BTN + 'px; flex: none; border-radius: 50%; background: ' + v('well') + '; color: ' + v('panelInk') + '; display: flex; align-items: center; justify-content: center; }',
      '.word .sayword[aria-pressed="true"], .word .saysent[aria-pressed="true"] { background: ' + v('key') + '; color: ' + v('keyInk') + '; }',
      '.word .via { ' + t(CAP, 500, BASE) + ' color: ' + v('panelMuted') + '; margin-top: 4px; }',
      '.word .via .en { font-weight: 700; color: ' + v('panelInk') + '; }',
      '.word .mean { margin-top: 4px; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }',
      '.word .mean .line { ' + t(BODY, 400, BASE) + ' }',
      '.word .mean .line:first-child { ' + t(LEAD, 700, BASE) + ' }',
      '.word .mean .state { ' + t(BODY, 500, BASE) + ' color: ' + v('panelMuted') + '; }',
      '.word .link { align-self: flex-start; min-height: ' + TAP + 'px; padding: 0 12px; margin: 0 0 0 -12px; border-radius: ' + PILL + '; ' + t(CAP, 700, TIGHT) + ' color: ' + v('softInk') + '; }',
      '.word .also { margin-top: 12px; border: 1px solid ' + v('grip') + '; border-radius: 16px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }',
      '.word .also .cap { ' + t(CAP, 700, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.word .also .pair { display: flex; align-items: baseline; gap: 8px; }',
      '.word .also .pair .en { flex: none; ' + t(TITLE, 800, TIGHT) + ' }',
      '.word .also .pair .m { ' + t(BODY, 400, BASE) + ' overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }',
      // 14px なら、2つ並べて幅 320 に収まる。収まらない幅では、折り返す
      '.word .grow { display: flex; flex-wrap: wrap; gap: ' + GAP + 'px; margin-top: 12px; }',
      '.word .grow button { min-height: ' + TAP + 'px; border-radius: ' + PILL + '; background: ' + v('well') + '; color: ' + v('panelInk') + '; ' + t(CAP, 700, TIGHT) + ' display: flex; align-items: center; gap: 4px; white-space: nowrap; }',
      '.word .grow .prev { padding: 0 16px 0 8px; }',
      '.word .grow .next { padding: 0 8px 0 16px; }',
      '.word .grow .reset { padding: 0 16px 0 12px; }',
      '.word .sent { margin-top: 12px; background: ' + v('well') + '; border-radius: 16px; padding: 12px 4px 12px 16px; display: flex; align-items: flex-start; gap: 4px; }',
      '.word .sent .txt { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }',
      '.word .sent .e { font-family: ' + FE + '; ' + t(BODY, 400, BASE) + ' }',
      '.word .sent .e .sel { font-weight: 800; color: ' + v('accent') + '; }',
      // 離れた熟語の間の語(工程T-5c=案 C): 強調の色の破線・ふつうの太さ。刻みと高さは、本文の印(page/render.js の .yomu-g)と同じ
      '.word .sent .e .gap { padding-bottom: 2px; background-image: repeating-linear-gradient(90deg, ' + v('accent') + ' 0 4px, transparent 4px 7px); background-size: 100% 2px; background-position: 0 100%; background-repeat: no-repeat; }',
      '.word .sent .j { ' + t(CAP, 400, LOOSE) + ' color: ' + v('panelMuted') + '; }',
      '.word .sent .saysent { width: ' + TAP + 'px; height: ' + TAP + 'px; flex: none; border-radius: 50%; color: ' + v('panelInk') + '; display: flex; align-items: center; justify-content: center; }',

      '.word .ai { margin-top: 12px; border-radius: 16px; background: ' + v('soft') + '; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }',
      '.word .ai .cap { ' + t(CAP, 700, TIGHT) + ' color: ' + v('softInk') + '; }',
      '.word .ai .ans { ' + t(BODY, 400, LOOSE) + ' white-space: pre-wrap; min-height: ' + LOOSE + 'em; }',
      // うまくいかなかったことの知らせ(AIに聞けなかった・辞書を取れなかった)。答えや意味と見分けがつくように、色と印を変える(2026-10-09 利用者)
      '.word .alert { margin-top: 12px; border-radius: 16px; background: ' + v('warnBg') + '; color: ' + v('warnInk') + '; padding: 12px 16px; display: flex; align-items: flex-start; gap: 8px; overflow-wrap: anywhere; }',
      '.word .alert svg { ' + iconTop(BASE) + ' }',
      '.word .alert .msg { flex: 1 1 auto; min-width: 0; ' + t(BODY, 700, BASE) + ' }',
      '.word .alert .link { align-self: center; flex: none; margin: 0 -8px 0 0; color: inherit; text-decoration: underline; }',
      // 「この文での意味をAIに聞く」は、意味のすぐ下(答えが出る所)に置く。通信の数は、メニューの札と同じく、下に小さく
      '.word .ask { align-self: flex-start; margin-top: 12px; min-height: ' + BTN + 'px; border-radius: ' + PILL + '; background: ' + v('soft') + '; color: ' + v('softInk') + '; ' + t(BODY, 700, TIGHT) + ' display: flex; align-items: center; gap: 8px; padding: 4px 20px 4px 16px; text-align: left; }',
      '.word .ask .two { display: flex; flex-direction: column; }',
      '.word .ask .cost { ' + t(CAP, 500, TIGHT) + ' }',
      // 下の行(単語帳)は、中身が長くて板の中を送るときも、板の下に残す
      //   (板の下の余白は、この行が持つ。貼りつく部品は、自分の入れ物の外へ出られないので、板の余白を 0 にしておく)
      //   キーボードで回るとき、下の行のうしろに隠れないように、送る位置に余白を取る
      '.sheet[data-sheet="word"] { padding-bottom: 0; scroll-padding-bottom: 96px; }',
      '.word .acts { display: flex; align-items: stretch; gap: ' + GAP + 'px; position: sticky; bottom: 0; margin: 4px -20px 0; padding: 12px 20px calc(20px + env(safe-area-inset-bottom, 0px)); background: ' + v('panel') + '; }',
      '@media (max-height: ' + u.shortMax + 'px) { .sheet { max-height: 100%; } .word .acts { position: static; } }',
      '.word .acts button { flex: 1 1 0; min-height: ' + BIG + 'px; border-radius: 28px; font-weight: 700; line-height: ' + TIGHT + '; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; text-align: left; }',
      '.word .acts .star { background: ' + v('go') + '; color: ' + v('goInk') + '; font-size: ' + BODY + 'px; }',
      '.word .acts .star.in { background: ' + v('well') + '; color: ' + v('accent') + '; }',
      '.word .acts .star .two { display: flex; flex-direction: column; }',
      '.word .acts .star .sub { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.word .acts .star[data-armed] { background: ' + v('key') + '; color: ' + v('keyInk') + '; }',

      // 画面いっぱいに出す板(設定・最初の設定。§9-2・§9-6)。上の行(もどる・題・とじる)は上に、下の行(主なボタン)は下に残し、間を送る。広い画面では、右に寄せた細い板
      '.sheet[data-full] { top: 0; max-height: none; border-radius: 0; padding: 0; }',
      '.sheet[data-full] .grip { display: none; }',
      '.sheet[data-full] .body { flex: 1 0 auto; }',
      '@media (min-width: ' + u.wideMin + 'px) { .sheet[data-full] { top: 16px; border-radius: 28px; padding: 0; } }',
      '.full { flex: 1 0 auto; display: flex; flex-direction: column; padding: 0 20px; }',
      '.full .bar { position: sticky; top: 0; z-index: 1; min-height: ' + BIG + 'px; margin: 0 -20px; padding: env(safe-area-inset-top, 0px) 20px 0; background: ' + v('panel') + '; display: flex; align-items: center; gap: 4px; }',
      '.full .main { flex: 1 0 auto; display: flex; flex-direction: column; padding-bottom: 24px; }',
      '.full .foot { position: sticky; bottom: 0; margin: 0 -20px; padding: 12px 20px calc(20px + env(safe-area-inset-bottom, 0px)); background: ' + v('panel') + '; display: flex; flex-direction: column; gap: ' + GAP + 'px; }',
      // 読む文は 16px・行間 1.5(§9-9)。補足は 14px
      '.full .h1 { margin: 8px 0 0; ' + t(TITLE, 700, TIGHT) + ' }',
      '.full .lead { margin: 8px 0 0; ' + t(BODY, 400, BASE) + ' color: ' + v('panelMuted') + '; }',
      '.full .hint { margin: 8px 0 0; ' + t(CAP, 400, LOOSE) + ' color: ' + v('panelMuted') + '; }',
      '.full .label { margin: 20px 0 8px; }',
      '.full .opts + .label.sub { margin-top: 16px; }',
      '.full .rows { margin-top: 0; }',
      '.full .lead + .rows { margin-top: 16px; }',
      // 押せない行(今は選べるものが1つだけの「つなぎ方」)。行の形は .rowbtn と同じ
      '.full .rowstat { padding: 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; ' + t(BODY, 700, TIGHT) + ' }',
      '.full .rowstat .host { min-width: 0; overflow-wrap: anywhere; }',
      '.full .rowstat + .rowstat { border-top: 1px solid ' + v('grip') + '; }',
      '.full .rowstat .val { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; text-align: right; }',
      '.full .steps { border-top: 1px solid ' + v('grip') + '; padding: 12px 16px 4px; display: flex; flex-direction: column; gap: 8px; }',
      '.full .step { display: flex; align-items: flex-start; gap: 8px; ' + t(BODY, 400, BASE) + ' }',
      '.full .step .num { width: 24px; height: 24px; flex: none; border-radius: 50%; background: ' + v('soft') + '; color: ' + v('softInk') + '; font-family: ' + FE + '; ' + t(CAP, 800, TIGHT) + ' display: flex; align-items: center; justify-content: center; }',
      '.full a.link { align-self: flex-start; min-height: ' + TAP + 'px; display: flex; align-items: center; gap: 4px; ' + t(CAP, 700, TIGHT) + ' color: ' + v('softInk') + '; text-decoration: underline; }',
      '.full a.link:focus-visible { outline: 2px solid ' + v('key') + '; outline-offset: 2px; border-radius: 4px; }',
      // 入力欄(§9-9): 字は 16px(iPhone の Safari は、16px より小さい字の入力欄に触れると、画面を拡大する)・高さ 48px・枠の線と地の明るさの比は 3 以上(panelMuted)
      '.full .field { display: flex; flex-direction: column; }',
      '.full .field label { margin: 20px 0 8px; ' + t(CAP, 700, BASE) + ' color: ' + v('panelMuted') + '; }',
      '.full .keyrow { display: flex; gap: ' + GAP + 'px; }',
      '.full input.text { flex: 1 1 0; width: 100%; min-height: ' + BTN + 'px; margin: 0; border: 1px solid ' + v('panelMuted') + '; border-radius: 16px; background: ' + v('panel') + '; color: ' + v('panelInk') + '; padding: 0 16px;'
        + ' font-family: inherit; ' + t(BODY, 500, BASE) + ' -webkit-appearance: none; appearance: none; }',
      '.full input.text:focus-visible { outline: 2px solid ' + v('key') + '; outline-offset: 2px; }',
      '.full .side { flex: none; min-height: ' + BTN + 'px; border-radius: 16px; background: ' + v('well') + '; color: ' + v('panelInk') + '; padding: 0 16px; ' + t(CAP, 700, TIGHT) + ' white-space: nowrap; }',
      '.full .has { margin: 8px 0 0; display: flex; align-items: flex-start; gap: 8px; ' + t(CAP, 400, LOOSE) + ' color: ' + v('panelMuted') + '; }',
      '.full .has svg { color: ' + v('accent') + '; ' + iconTop(LOOSE) + ' }',
      // 主なボタン(色の面。1つの画面に1つ)と、その下の小さいボタン
      '.full .primary { width: 100%; min-height: ' + BIG + 'px; border-radius: 28px; background: ' + v('key') + '; color: ' + v('keyInk') + '; ' + t(BODY, 700, TIGHT) + ' display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 20px; }',
      '.full .main .primary { margin-top: 16px; }',
      '.full .textbtn { align-self: center; min-height: ' + TAP + 'px; border-radius: ' + PILL + '; padding: 0 16px; ' + t(CAP, 700, TIGHT) + ' color: ' + v('panelMuted') + '; border: 1px solid ' + v('panelMuted') + '; }',
      '.full .bar .textbtn { border: 0; }',
      '.full .hint + .textbtn { margin-top: 12px; }',
      '.full .foot .side.wide { margin-top: 0; }',
      '.full .textbtn[data-armed] { background: ' + v('key') + '; color: ' + v('keyInk') + '; border-color: ' + v('key') + '; }',
      // 押した結果は、ボタンのすぐ下に(§9-9)。うまくいった=印と字・確かめている=字だけ・うまくいかなかった=色と印を変えた枠(単語の板の .alert と同じ色)
      '.full .result { margin-top: 12px; display: flex; flex-direction: column; }',
      '.full .okline { display: flex; align-items: flex-start; gap: 8px; ' + t(BODY, 700, BASE) + ' color: ' + v('accent') + '; }',
      '.full .okline svg { ' + iconTop(BASE) + ' }',
      '.full .state { ' + t(BODY, 500, BASE) + ' color: ' + v('panelMuted') + '; }',
      '.full .alert { border-radius: 16px; background: ' + v('warnBg') + '; color: ' + v('warnInk') + '; padding: 12px 16px; display: flex; align-items: flex-start; gap: 8px; overflow-wrap: anywhere; ' + t(BODY, 700, BASE) + ' }',
      '.full .alert svg { ' + iconTop(BASE) + ' }',

      // 目標: 選ぶ札(丸い印つき。選んだ印は、色のほかに、チェックでも)と、「この目標で用意するもの」
      '.full .opts { display: flex; flex-direction: column; gap: ' + GAP + 'px; }',
      '.full .lead + .opts { margin-top: 20px; }',
      '.full .opt { min-height: 64px; border-radius: 20px; background: ' + v('well') + '; color: ' + v('panelInk') + '; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }',
      '.full .opt[aria-pressed="true"] { background: ' + v('panel') + '; box-shadow: 0 0 0 2px ' + v('key') + '; }',
      '.full .opt .two { display: flex; flex-direction: column; gap: 4px; }',
      '.full .opt .ttl { ' + t(BODY, 700, TIGHT) + ' }',
      '.full .opt .head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }',
      '.full .opt .tag { ' + t(CAP, 700, TIGHT) + ' padding: 2px 8px; border-radius: ' + PILL + '; border: 1px solid ' + v('panelMuted') + '; color: ' + v('panelMuted') + '; white-space: nowrap; }',
      '.full .opt .tag.now { border-color: ' + v('accent') + '; color: ' + v('accent') + '; }',
      '.full .opt .sub { ' + t(CAP, 400, BASE) + ' color: ' + v('panelMuted') + '; }',
      '.full .opt .radio { width: 24px; height: 24px; flex: none; border-radius: 50%; border: 2px solid ' + v('panelMuted') + '; display: flex; align-items: center; justify-content: center; color: transparent; }',
      '.full .opt[aria-pressed="true"] .radio { border-color: ' + v('key') + '; background: ' + v('key') + '; color: ' + v('keyInk') + '; }',
      '.full .opt .soon { flex: none; ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.full .opt[data-soon] .ttl { color: ' + v('panelMuted') + '; }',
      // 翻訳の設定・通信の記録・音声(ui/settings_more.js)
      '.full .quota { padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }',
      '.full .quota + .quota { border-top: 1px solid ' + v('grip') + '; }',
      '.full .quota .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; ' + t(BODY, 700, TIGHT) + ' }',
      '.full .quota .mid { ' + t(CAP, 400, BASE) + ' color: ' + v('panelMuted') + '; overflow-wrap: anywhere; }',
      '.full .quota .hit { border-radius: 12px; background: ' + v('warnBg') + '; color: ' + v('warnInk') + '; padding: 8px 12px; display: flex; align-items: flex-start; gap: 8px; ' + t(CAP, 700, BASE) + ' }',
      '.full .quota .lim { margin-top: 4px; display: flex; align-items: center; gap: 8px; }',
      '.full .quota .lim label { flex: 1 1 auto; ' + t(CAP, 700, BASE) + ' color: ' + v('panelMuted') + '; }',
      '.full .quota input.num { flex: none; width: 96px; text-align: right; }',
      '.full .quota .unit { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.full .side.wide { width: 100%; margin-top: 12px; padding: 4px 16px; display: flex; align-items: center; justify-content: center; gap: 8px; white-space: normal; }',
      '.full .side .two { display: flex; flex-direction: column; align-items: center; }',
      '.full .side .cost { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.full .opts + .textbtn { margin-top: 8px; }',
      '.full [data-box="voices"] { display: flex; flex-direction: column; }',
      '.full .trio { display: flex; gap: ' + GAP + 'px; }',
      '.full .trio button { flex: 1 1 0; min-height: ' + BTN + 'px; border-radius: ' + PILL + '; background: ' + v('well') + '; color: ' + v('panelInk') + '; ' + t(CAP, 700, TIGHT) + ' display: flex; align-items: center; justify-content: center; gap: 4px; padding: 4px 8px; white-space: normal; overflow-wrap: anywhere; }',
      '.full .trio button[aria-pressed="true"] { background: ' + v('key') + '; color: ' + v('keyInk') + '; }',
      '.full .trio button[aria-pressed="false"] svg { display: none; }',
      '.full .run .n { ' + t(BODY, 400, BASE) + ' }',
      '.full .run .end { ' + t(CAP, 700, BASE) + ' }',
      '.full .textbtn.gap { margin-top: 8px; }',
      '.full .hint.first { margin: 0; }',
      '.full .pickfile { position: relative; cursor: pointer; }',
      '.full .pickfile:focus-within { outline: 2px solid ' + v('key') + '; outline-offset: 2px; }',
      '.full [data-box="picked"] { margin-top: 12px; display: flex; flex-direction: column; }',
      '.full .result .link { margin-top: 4px; }',
      '.full .result .hint { margin: 4px 0 0; }',
      // 調べるための記録を、自動で写せなかったとき: 字をそのまま出す(長押しして、選べる。ui/settings_diag.js)
      '.full .dump { margin-top: 8px; border-radius: 16px; background: ' + v('well') + '; padding: 12px 16px; max-height: 160px; overflow: auto; overflow-wrap: anywhere; -webkit-user-select: all; user-select: all; ' + t(CAP, 400, BASE) + ' }',
      '.full .steps.flat { border-top: 0; padding-bottom: 12px; }',
      '.full .hint.plain { ' + t(BODY, 400, BASE) + ' }',
      '.full .info { padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }',
      '.full .info + .info { border-top: 1px solid ' + v('grip') + '; }',
      '.full .info .cap { ' + t(CAP, 700, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.full .info .v { ' + t(BODY, 700, BASE) + ' }',
      // 最初の設定(3枚。キャンバス3ページ目の1段目)。上の行は、もどる・進み具合の点・「とばす」
      '.full.setup .bar .gap { width: ' + TAP + 'px; flex: none; }',
      '.full.setup .bar .mid { flex: 1 1 auto; display: flex; justify-content: center; }',
      '.full.setup .bar .textbtn { margin-right: -16px; }',
      '.full .dots { display: flex; align-items: center; gap: 8px; }',
      '.full .dots span { width: 8px; height: 8px; border-radius: 4px; background: ' + v('grip') + '; }',
      '.full .dots .past { background: ' + v('key') + '; }',
      '.full .dots .now { width: 24px; background: ' + v('key') + '; }',
      '.full .center { text-align: center; text-wrap: balance; }',
      '.full .hero { margin-top: 24px; display: flex; flex-direction: column; align-items: center; gap: 4px; }',
      '.full .hero .app { font-family: ' + FS + '; ' + t(HEAD, 500, TIGHT) + ' }',
      '.full .h1.center { margin-top: 24px; }',
      '.full .h1.center span { display: block; }',
      // 見本(ページの中の英文と同じ色=マーカー)
      '.full .demo { margin-top: 24px; border-radius: 20px; background: ' + v('well') + '; padding: 16px; ' + t(BODY, 400, LOOSE) + ' }',
      '.full .demo .en { font-family: ' + FE + '; color: ' + v('enInk') + '; background: ' + v('enBg') + '; border-radius: 4px; padding: 2px 4px; margin: 0 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }',
      '.full .lead.center { margin-top: 20px; }',
      '.full .hows { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; }',
      '.full .how { border-radius: 20px; background: ' + v('well') + '; padding: 12px 16px 12px 12px; display: flex; align-items: center; gap: 12px; }',
      '.full .how .pic { width: 72px; height: 56px; flex: none; border-radius: 16px; background: ' + v('panel') + '; display: flex; align-items: center; justify-content: center; }',
      '.full .how .txt { display: flex; flex-direction: column; gap: 4px; }',
      '.full .how .ttl { ' + t(BODY, 700, TIGHT) + ' }',
      '.full .how .sub { ' + t(CAP, 400, BASE) + ' color: ' + v('panelMuted') + '; }',
      '.full .how .name { ' + t(CAP, 700, TIGHT) + ' white-space: nowrap; }',
      '.full .how .num { ' + t(TITLE, 700, TIGHT) + ' }',                      // 「直し方」の手順の番号(ui/settings_diag.js)
      '.full .how .logo { width: 40px; height: 40px; border-radius: 50%; background: ' + v('well') + '; display: flex; align-items: center; justify-content: center; }',
      '.full .how .track { position: relative; width: 40px; height: 8px; border-radius: 4px; background: ' + v('grad') + '; }',
      '.full .how .dot { position: absolute; left: 12px; top: -4px; width: 16px; height: 16px; border-radius: 50%; background: ' + v('knob') + '; box-shadow: ' + v('knobShadow') + '; }',
      '.full .how .chip { width: 28px; height: 28px; border-radius: 50%; border: 1px solid ' + v('chipBd') + '; background: ' + v('chipBg') + '; color: ' + v('chipInk') + '; ' + t(CAP, 700, TIGHT) + ' display: flex; align-items: center; justify-content: center; }',

      // 知らせの行(操作部のすぐ上。文言・「×」・押せる所)
      '.note { border-radius: 20px; background: ' + v('panel') + '; box-shadow: ' + v('shadow') + '; padding: 8px 8px 8px 16px; display: grid;'
        + ' grid-template-columns: minmax(0, 1fr) auto; column-gap: 4px; row-gap: 4px; align-items: center; }',
      '.note .line { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }',
      '.note .line svg { ' + iconTop(BASE) + ' }',
      '.note .text { flex: 1 1 auto; min-width: 0; ' + t(BODY, 700, BASE) + ' overflow-wrap: anywhere; }',
      // うまくいかなかったことの知らせ(失敗)は、案内と見分けがつくように、色と印を変える(設計メモ 2-5。単語の板の .alert と同じ色)
      '.note[data-tone="warn"] { background: ' + v('warnBg') + '; color: ' + v('warnInk') + '; }',
      '.note[data-tone="warn"] .x { color: inherit; }',
      '.note .x { width: ' + TAP + 'px; height: ' + TAP + 'px; border-radius: 50%; display: flex; align-items: center; justify-content: center; align-self: start; color: ' + v('panelMuted') + '; }',
      '.note .acts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: ' + GAP + 'px; padding: 0 8px 4px 0; }',
      '.note .act { min-height: ' + TAP + 'px; padding: 0 16px; border-radius: ' + PILL + '; background: ' + v('soft') + '; color: ' + v('softInk') + '; ' + t(CAP, 700, TIGHT) + ' white-space: nowrap; }',
      // 1日の上限のカード(キャンバス「無料枠を使い切ったとき」)
      '.card { border-radius: 24px; background: ' + v('panel') + '; box-shadow: ' + v('shadow') + '; padding: 16px; display: flex; flex-direction: column; gap: 8px; }',
      '.card .head { display: flex; align-items: center; gap: 8px; }',
      '.card .title { ' + t(BODY, 700, TIGHT) + ' }',
      '.card .desc { ' + t(CAP, 400, LOOSE) + ' color: ' + v('panelMuted') + '; }',
      '.card .acts { display: flex; gap: ' + GAP + 'px; margin-top: 8px; }',
      '.card .acts button { min-height: ' + BIG + 'px; border-radius: 28px; padding: 4px 12px; ' + t(BODY, 700, TIGHT) + ' display: flex; flex-direction: column; align-items: center; justify-content: center; }',
      '.card .later { flex: 1 1 0; background: ' + v('well') + '; color: ' + v('panelInk') + '; }',
      '.card .go { flex: 1.4 1 0; background: ' + v('key') + '; color: ' + v('keyInk') + '; }',
      '.card .go .cost { ' + t(CAP, 500, TIGHT) + ' opacity: 0.85; }',

      // 入口のボタン(キャンバス 1)
      // 1本の台(.dock と同じ形)の中に、左 = ロゴ(メニュー)・右 = 「ブレンド」。浮いているものは1つ。色は付けない(本文を読むじゃまをしない=設計メモ 2-5)
      //   白い台は、ロゴの側を除いて、全部「ブレンド」(押せる範囲を、台のふちまで広げる。見た目は変えない。台の外=角の丸みの外は、切り落とす)。
      //   ロゴのまわりのふちは、ロゴの持ち分。間の 8px は、どちらも受けない(メニューをねらって「ブレンド」に当たると、回数を使うので)=§9-3
      '.entry { align-self: flex-end; overflow: hidden; }',
      '.entry .round, .launch { position: relative; }',
      '.entry .round::after { content: ""; position: absolute; left: -8px; top: -8px; bottom: -8px; right: 0; }',
      '.launch::after { content: ""; position: absolute; left: 0; top: -8px; bottom: -8px; right: -8px; }',
      '.launch { min-height: ' + BTN + 'px; border-radius: ' + PILL + '; padding: 0 12px 0 4px;'
        + ' display: flex; align-items: center; gap: 8px; ' + t(BODY, 700, TIGHT) + ' color: ' + v('panelInk') + '; white-space: nowrap; }',
      '.launch .cost { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',

      // 操作部(キャンバス 2・3)。高さ 64px の中に、48px の押せる所を、まわり 8px で置く
      '.dock { height: 64px; border-radius: ' + PILL + '; background: ' + v('panel') + '; box-shadow: ' + v('shadow') + '; display: flex; align-items: center; gap: ' + GAP + 'px; padding: 0 8px; }',
      '.round { width: ' + BTN + 'px; height: ' + BTN + 'px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: ' + v('well') + '; color: ' + v('panelInk') + '; }',
      '.pill { height: ' + BTN + 'px; flex: none; padding: 0 16px 0 12px; border-radius: ' + PILL + '; background: ' + v('well') + '; color: ' + v('panelInk') + ';'
        + ' ' + t(BODY, 700, TIGHT) + ' display: flex; align-items: center; gap: 4px; white-space: nowrap; }',
      '.pill[aria-pressed="true"] { background: ' + v('key') + '; color: ' + v('keyInk') + '; }',
      // ロゴの丸には、細い輪(丸の地は、台の地と明るさがほとんど同じ=比 1.1〜1.2。輪は 3 以上。工程5b-2: 暗いテーマで、丸が見分けにくかった)
      '.round[data-act="menu"] { box-shadow: inset 0 0 0 1px ' + v('ring') + '; }',
      // たたんだ形(ロゴと、今の割合)。ひらくと、つまみと「原文」(今の割合のボタンは、消える)
      '.dock[data-fold] { align-self: flex-end; }',
      // サイトが右下に固定している大きなもの(広告)に重なるときは、左へよける(ui/root.js の lift。出ている間だけ)
      '.bay[data-side="left"] .entry, .bay[data-side="left"] .dock[data-fold] { align-self: flex-start; }',
      '.dock[data-fold] .ratio, .dock[data-fold] .pill[data-act="orig"], .dock:not([data-fold]) .pct { display: none; }',
      '.pct { padding: 0 16px; gap: 8px; }',
      '.pct .mini { position: relative; width: 24px; height: 4px; border-radius: 2px; background: ' + v('grad') + '; }',
      '.pct .mini i { position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; transform: translate(-50%, -50%); border-radius: 50%; background: ' + v('knob') + '; box-shadow: ' + v('knobShadow') + '; }',
      // 割合のつまみ(見た目は .track と .knob。input は、キーボードと読み上げのために置く=見えない)
      '.ratio { flex: 1 1 auto; min-width: 0; position: relative; height: ' + BTN + 'px; cursor: pointer; touch-action: none; -webkit-user-select: none; user-select: none; }',
      '.ratio .track { position: absolute; left: 0; right: 0; top: ' + ((BTN - 8) / 2) + 'px; height: 8px; border-radius: 4px; background: ' + v('grad') + '; }',
      '.ratio input { position: absolute; left: 0; top: 0; width: 100%; height: ' + BTN + 'px; margin: 0; opacity: 0; pointer-events: none; }',
      '.ratio .knob, .ratio .tip { left: calc(' + (KNOB / 2) + 'px + (100% - ' + KNOB + 'px) * var(--p, 0)); }',
      '.ratio .knob { position: absolute; top: ' + ((BTN - KNOB) / 2) + 'px; width: ' + KNOB + 'px; height: ' + KNOB + 'px; transform: translateX(-50%); border-radius: 50%; background: ' + v('knob') + '; box-shadow: ' + v('knobShadow') + '; pointer-events: none; }',
      '.ratio input:focus-visible ~ .knob { outline: 2px solid ' + v('key') + '; outline-offset: 2px; }',
      '.ratio .tip { position: absolute; top: -36px; width: 56px; height: 28px; transform: translateX(-50%); border-radius: ' + PILL + '; background: ' + v('tip') + '; color: ' + v('tipInk') + ';'
        + ' font-family: ' + FE + '; ' + t(CAP, 800, TIGHT) + ' display: flex; align-items: center; justify-content: center; pointer-events: none; opacity: 0; transition: opacity ' + ms(MO.tip) + ' ease-out; }',
      '.ratio[data-live] .tip { opacity: 1; }',
      // 未訳の数(つまみの下の小さな字。押せない)。出ている間は、線と丸を 6px 上げて、字と重ならないようにする(丸 4〜32px・字 32〜50px。台の高さは変えない)
      '.ratio .miss { position: absolute; left: 0; bottom: -2px; ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }',
      '.ratio[data-miss] .track { top: ' + ((BTN - 8) / 2 - 6) + 'px; }',
      '.ratio[data-miss] .knob { top: ' + ((BTN - KNOB) / 2 - 6) + 'px; }',
      // 進み具合
      '.dock[data-dock="progress"] { height: auto; min-height: 64px; padding: 8px; }',
      '.prog { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }',
      '.prog .stay { ' + t(CAP, 500, TIGHT) + ' color: ' + v('panelMuted') + '; }',
      '.prog .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }',
      '.prog .label { margin: 0; color: ' + v('panelInk') + '; ' + t(CAP, 700, TIGHT) + ' white-space: nowrap; }',
      '.prog .count { font-family: ' + FE + '; ' + t(CAP, 700, TIGHT) + ' color: ' + v('panelMuted') + '; white-space: nowrap; }',
      '.prog .bar { height: 8px; border-radius: 4px; background: ' + v('line') + '; overflow: hidden; }',
      '.prog .fill { height: 8px; width: 0; border-radius: 4px; background: ' + v('grad') + '; transition: width ' + ms(MO.fill) + ' ease-out; }'
    ]).join('\n');
  }

  Yomu.uiStyle = { css, KNOB, fonts: { jp: FJ, en: FE, serif: FS } };
})();

/* ---- ui/root.js ---- */
// ui/root.js — 操作部の土台(部品の約束 §9-2)。<html> の直下に入れ物を1つ置き、その中の Shadow DOM に、全部の部品を作る
//   サイトの CSS は入ってこず、こちらの CSS も外に出ない。部品(ui/dock.js など)は Yomu.ui.part で名前を登録し、土台が mount・draw を呼ぶ。
//   状態は Yomu.page.status() から取り、Yomu.page.on の合図で描き直す。外から来た文字は textContent と createElement だけで出す(§1-2)。
//   ページの上のタップ(「あ/A」・英文の語)の受け口は、ここが document に1つだけ付ける(§9-1)
(function(){
  'use strict';
  const Y = Yomu;
  const msg = Yomu.msg, style = Yomu.uiStyle, cfg = Yomu.config, theme = Yomu.theme;
  const HOST_ID = 'yomu-root';
  const QUIET_EVENTS = ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'];
  const SVG = 'http://www.w3.org/2000/svg';

  // アイコン(線の絵。design/round2/gen.js の P)。[要素, 属性] の並び
  const ICONS = {
    swap: [['path', { d: 'M7 8h11l-3-3' }], ['path', { d: 'M17 16H6l3 3' }]],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    chevR: [['path', { d: 'M9 6l6 6-6 6' }]],
    chevL: [['path', { d: 'M15 6l-6 6 6 6' }]],
    arrowR: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
    out: [['path', { d: 'M14 5h5v5M19 5l-8 8' }], ['path', { d: 'M18 14v5H5V6h5' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
    download: [['path', { d: 'M12 4v11M7.5 10.5L12 15l4.5-4.5' }], ['path', { d: 'M5 19h14' }]],
    refresh: [['path', { d: 'M19 12a7 7 0 1 1-2.2-5.1' }], ['path', { d: 'M19 4v4h-4' }]],
    speaker: [['path', { d: 'M4 10v4h3l4 3V7l-4 3H4z' }], ['path', { d: 'M15 9.5a3.5 3.5 0 0 1 0 5' }], ['path', { d: 'M17.5 7a7 7 0 0 1 0 10' }]],
    stop: [['path', { d: 'M7 7h10v10H7z' }]],
    alert: [['path', { d: 'M12 4.5l8.5 15h-17z' }], ['path', { d: 'M12 10.5v4M12 17.2v.3' }]],
    dict: [['path', { d: 'M6 4h12v16H6z' }], ['path', { d: 'M9 8h6M9 12h6' }]],
    bookmarkPlus: [['path', { d: 'M7 4h10v16l-5-3.5L7 20V4z' }], ['path', { d: 'M12 8v5M9.5 10.5h5' }]],
    bookmarkCheck: [['path', { d: 'M7 4h10v16l-5-3.5L7 20V4z' }], ['path', { d: 'M9.5 10.5l2 2 3.5-3.5' }]]
  };

  let doc = null, win = null, host = null, shadow = null, box = null, bay = null, toastEl = null, toastT = null;
  let liveSoft = null, liveLoud = null;   // 読み上げ用の知らせの置き場(見えない。いつも DOM にある)
  let layer = null, sheetEl = null, sheetBody = null, sheetNow = null;   // 下から出る板(1枚だけ)。sheetNow = { name, onClose, back(開く前に、フォーカスがあった所) }
  const slots = {};                 // 画面の下の置き場の段(上から notice・main)
  const parts = [];                 // [{ name, def }] 登録の順
  let cur = null;                   // 最後に見た Yomu.page.status()
  const holds = new Set();          // 操作部を隠さない理由(つまみを動かしている・下から出る板 など)
  let away = false, lastY = 0, down = 0, up = 0, quietUntil = 0, backAt = 0;
  let shownSig = null;              // 最後に描いたときの、ページの見え方(変わったら、そのあとのスクロールを、利用者の送りと数えない)

  const warn = e => { try { console.warn('[yomu]', e); } catch (x){} };
  const find = name => parts.find(p => p.name === name) || null;

  // ---- 小道具 ----
  function el(tag, props, kids){
    const e = doc.createElement(tag);
    const p = props || {};
    if (tag === 'button' && p.type == null) e.setAttribute('type', 'button');
    Object.keys(p).forEach(k => {
      const val = p[k];
      if (val == null || val === false) return;
      if (k === 'text') e.textContent = String(val);
      else if (k === 'class') e.className = String(val);
      else if (k.slice(0, 2) === 'on' && typeof val === 'function') e.addEventListener(k.slice(2), val);
      else e.setAttribute(k, val === true ? '' : String(val));
    });
    (kids || []).forEach(c => { if (c != null) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return e;
  }
  function svgEl(tag, attrs){
    const e = doc.createElementNS(SVG, tag);
    Object.keys(attrs).forEach(k => e.setAttribute(k, String(attrs[k])));
    return e;
  }
  function icon(name, size, sw){
    const s = svgEl('svg', { viewBox: '0 0 24 24', width: size || 22, height: size || 22, fill: 'none', stroke: 'currentColor',
      'stroke-width': sw || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    (ICONS[name] || []).forEach(([tag, a]) => s.appendChild(svgEl(tag, a)));
    return s;
  }
  // ロゴ(重なる2枚の栞。色は CSS の .mark から)
  function mark(size){
    const s = svgEl('svg', { viewBox: '0 0 26 26', width: size || 24, height: size || 24, class: 'mark', 'aria-hidden': 'true' });
    s.appendChild(svgEl('path', { class: 'a', d: 'M5 3h9v17l-4.5-3.4L5 20V3z' }));
    s.appendChild(svgEl('path', { class: 'b', d: 'M12 6h9v17l-4.5-3.4L12 23V6z' }));
    return s;
  }

  // ---- CSS を入れる(<style> を差し込まない形が先。サイトの制限に当たらない=§9-2。使えない所では <style>) ----
  function addCss(text){
    try {
      if ('adoptedStyleSheets' in shadow && typeof win.CSSStyleSheet === 'function'){
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(text);
        shadow.adoptedStyleSheets = [sheet];
        return 'adopted';
      }
    } catch (e){}
    const st = doc.createElement('style');
    st.textContent = text;
    shadow.appendChild(st);
    return 'style';
  }

  // ---- 下へ読み進めている間は、操作部を隠す(設計メモ 2-5) ----
  //   隠さないとき: 訳している・使用中・知らせが出ている・つまみやメニューを使っている(hold)・本文ページでない
  // ページの送り(上と下のはしで、引っぱって伸びた分は、数えない=iPhone)
  function scrollTop(){
    const y = win.pageYOffset != null ? win.pageYOffset : (doc.documentElement.scrollTop || 0);
    const max = (doc.documentElement.scrollHeight || 0) - (win.innerHeight || 0);
    return Math.max(0, max > 0 ? Math.min(y, max) : y);
  }
  function canHide(){
    return !!cfg.ui.hideOnScroll && !!cur && (cur.state === 'on' || cur.state === 'off') && !cur.busy && !cur.notice && !holds.size;
  }
  function setAway(v){
    if (away === v || !bay) return;
    away = v;
    if (!v) backAt = Date.now();                         // 出てきた時刻(fresh が使う)
    if (v) bay.setAttribute('data-away', ''); else bay.removeAttribute('data-away');
  }
  // サイトが、画面に固定しているもの(なろうの、ついてくる広告 など)を、よける(広告と、その「×」を隠さない。工程5b-2)
  //   ①画面の下のふちに付いた、低い帯(高さ ui.lift.max まで): その上へ、置き場を上げる(--lift)
  //   ②もっと大きいもの(右下の四角い広告): 上げずに、左へよける(data-side="left"。重なりが、右に置くときの sideGain 倍より小さくなるときだけ)
  //   見るのは、画面の中の点に、いちばん手前で当たるもの(こちらの入れ物は除く)から、親へたどって見つかる、固定(fixed・sticky)されたもの
  let lifted = 0, side = '';
  const t0 = Date.now(), placeHist = [];
  let tickAt = 0, tickInfo = null;
  function fixedAt(x, y, into){
    // こちらの物は、数えない: 入れ物(host)と、その中(Shadow DOM)の部品。iPhone の Safari は、中の部品を、そのまま返すことがある
    //   (工程5b-2b 利用者の iPhone の記録: 置き場 .bay が「固定されたもの」に数えられて、右も左も同じだけ重なる、と出ていた=入口の台が、左へよけなかった)
    const top = (doc.elementsFromPoint(x, y) || []).find(e => e !== host && !(e.getRootNode && e.getRootNode() === shadow));
    for (let n = top; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement){
      const pos = win.getComputedStyle(n).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (into.indexOf(n) < 0) into.push(n);
      return;
    }
  }
  function overlap(box, els){
    let sum = 0;
    els.forEach(n => {
      const r = n.getBoundingClientRect();
      const w = Math.min(box.right, r.right) - Math.max(box.left, r.left), h = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
      if (w > 0 && h > 0) sum += w * h;
    });
    return sum;
  }
  // 調べるための記録に出す、固定されたものの名前と場所(タグ・id・クラスの頭と、左・上・幅・高さ。中の文字は入れない)
  const tagOf = n => String(n.tagName || '').toLowerCase() + (n.id ? '#' + String(n.id).slice(0, 24) : '')
    + (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.').slice(0, 40) : '');
  const rectOf = r => [r.left, r.top, r.width, r.height].map(Math.round);
  const noteOf = n => [tagOf(n), rectOf(n.getBoundingClientRect()), win.getComputedStyle(n).position];
  // detail = true なら、決めた理由の数字も返す(out.info。「記録を写す」に出る)
  function placeNow(detail){
    const L = cfg.ui.lift, out = { lift: 0, side: '' };
    const W = win.innerWidth || 0, H = win.innerHeight || 0;
    const info = detail ? (out.info = { W, H }) : null;
    if (!L || !L.on || typeof doc.elementsFromPoint !== 'function' || !win.getComputedStyle) return out;
    // ① 下のふちの帯
    const low = [];
    [0.25, 0.5, 0.75].forEach(k => fixedAt(W * k, H - 4, low));
    low.forEach(n => {
      const r = n.getBoundingClientRect(), up = H - r.top;
      if (r.bottom >= H - 2 && r.height > 0 && up <= L.max) out.lift = Math.max(out.lift, Math.ceil(up / cfg.ui.grid) * cfg.ui.grid);
    });
    // ② 台の置き場所(右下)に、固定されたものが重なるか。重なるなら、左下と比べる
    const dock = Array.prototype.find.call(slots.main ? slots.main.children : [], e => !e.hidden);
    const dw = dock ? dock.getBoundingClientRect().width : 0;
    if (info) Object.assign(info, { low: low.slice(0, 4).map(noteOf), lift: out.lift, dock: dock ? dock.getAttribute('data-dock') : null, dw: Math.round(dw) });
    if (!(dw > 0) || dw > W * 0.7 || W >= cfg.ui.wideMin) return out;      // 横いっぱいの形(ひらいたつまみ・進み具合)と、広い画面では、よけない
    const bottom = H - cfg.ui.bottom - out.lift, top = bottom - 64;
    const boxAt = left => ({ left, right: left + dw, top, bottom });
    const right = boxAt(W - 16 - dw), left = boxAt(16);
    const seen = [];
    [right, left].forEach(b => [b.left + 4, (b.left + b.right) / 2, b.right - 4].forEach(x => [b.top + 4, (b.top + b.bottom) / 2, b.bottom - 4].forEach(y => fixedAt(x, y, seen))));
    const or = overlap(right, seen), ol = overlap(left, seen);
    if (or > 0 && ol < or * L.sideGain) out.side = 'left';
    if (info) Object.assign(info, { right: [right.left, right.top].map(Math.round), left: [left.left, left.top].map(Math.round), seen: seen.slice(0, 6).map(noteOf), or: Math.round(or), ol: Math.round(ol), gain: L.sideGain, side: out.side });
    return out;
  }
  function lift(){
    if (!bay || sheetNow) return;                          // 板が出ている間は、板(こちらの物)が下のふちを覆っている
    let p;
    try { p = placeNow(true); } catch (e){ p = { lift: lifted, side, info: { err: String((e && e.message) || e).slice(0, 80) } }; }
    // 調べるための控え(§9-8): いちばん新しい見回りの数字と、置き場が変わった時刻(起動からの ms。新しい6つ)
    tickAt = Date.now(); tickInfo = p.info || null;
    if (p.lift !== lifted || p.side !== side){ placeHist.push([tickAt - t0, p.lift, p.side]); if (placeHist.length > 6) placeHist.shift(); }
    if (p.lift !== lifted){
      lifted = p.lift;
      if (lifted) bay.style.setProperty('--lift', lifted + 'px'); else bay.style.removeProperty('--lift');
    }
    if (p.side !== side){
      side = p.side;
      if (side) bay.setAttribute('data-side', side); else bay.removeAttribute('data-side');
    }
  }
  function onScroll(){
    const y = scrollTop(), dy = y - lastY;
    lastY = y;
    if (!canHide()){ down = up = 0; setAway(false); return; }
    if (Date.now() < quietUntil){ down = up = 0; return; }   // 表示を切り替えたすぐあとは、読んでいる場所を合わせ直すスクロールが来る(利用者の送りではない)
    if (dy > 0){ down += dy; up = 0; if (down >= cfg.ui.hideDy) setAway(true); }
    else if (dy < 0){ up -= dy; down = 0; if (up >= cfg.ui.showDy) setAway(false); }
    if (y <= 0) setAway(false);
  }
  function quiet(){ quietUntil = Date.now() + cfg.ui.quietMs; down = up = 0; }
  function hold(key, on){
    if (on){ holds.add(key); setAway(false); } else holds.delete(key);
  }

  // ---- 描き直す ----
  function draw(){
    if (!host) return;
    cur = Y.page.status();
    // 色の組(操作部・板・メニュー。CSS が、土台の印で切り替える)。本文ページでないとき・知らない名前は、初めの組
    const th = theme.has(cur.themeNow) ? cur.themeNow : theme.initial;
    if (host.getAttribute('data-theme') !== th) host.setAttribute('data-theme', th);
    // ページの見え方が変わった(英語にした・戻した・割合・見せ方・書体・文字の大きさ・レベル・届いた文): 読んでいる場所を合わせ直すスクロールが来るので、数えない
    const sig = [cur.state, cur.level, cur.ratio, cur.style, cur.font, cur.size, cur.orig, cur.n.shown, cur.n.translated].join('|');
    if (sig !== shownSig){ shownSig = sig; quiet(); }
    parts.forEach(p => { if (p.def.draw){ try { p.def.draw(cur); } catch (e){ warn(e); } } });
    if (!canHide()) setAway(false);
  }
  // 進行役を呼ぶ(部品のボタンから)。失敗は、進行役が知らせで出すので、ここでは受けて捨てる。終わったら、今の状態で描き直す
  //   (進行役が合図を出さずに終わっても、押せない・古い表示のままにしない)
  function run(fn){
    let p = null;
    try { p = fn(); } catch (e){}
    Promise.resolve(p).catch(() => {}).then(draw);
  }
  function each(fn, arg){ parts.forEach(p => { if (p.def[fn]){ try { p.def[fn](arg); } catch (e){ warn(e); } } }); }

  // ---- ページの上のタップ(「あ/A」・英文の語)----
  function onDocClick(e){
    const h = Y.render.hit(e.target);
    if (!h) return;
    // リンクの中の英語の語・「あ/A」は、リンクへ移らない(どのページでも=記事の本文の中のリンク。§3。v1.51)
    if (e.target && e.target.closest && e.target.closest('a[href]') && e.preventDefault) e.preventDefault();
    if (h.chip){ quiet(); Y.page.toggle(h.sid); return; }
    const w = find('word');                       // 単語の板(工程4b-1b)
    if (w && w.def.open) w.def.open(h);
  }
  function onDocKey(e){
    // 下から出る板が出ている間に、キーボードがページの側にいたら: Esc でしまう・Tab は板の中へ戻す(§9-2)
    if (sheetNow && e.key === 'Escape'){ unsheet(); return; }
    if (sheetNow && e.key === 'Tab'){ e.preventDefault(); const list = tabbables(); (list[e.shiftKey ? list.length - 1 : 0] || sheetEl).focus(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const h = Y.render.hit(e.target);
    if (!h || !h.chip) return;
    e.preventDefault();
    quiet();
    Y.page.toggle(h.sid);
  }

  // ---- 下から出る板(メニュー・見た目・単語の板が使う。出せるのは1枚。キャンバスの sheetShell)----
  //   sheet(name, 中身, { label, onClose }): 出す(前の板があれば、しまってから)。unsheet(name?): しまう(name を渡したら、その板が出ているときだけ)
  //   まわりの暗い所をタップ・Esc でも、しまう。出ている間は、操作部を隠さない
  //   full = 画面いっぱいに出す(設定・最初の設定。字と入力欄の多い画面)。暗い所のタップでは、しまわない(入れかけの字を、うっかり消さない)。
  //   同じ名前の、画面いっぱいの板を出し直したら、しまわずに、中身だけ入れかえる(画面の中の行き来。開く前のフォーカスの戻り先は、そのまま)
  function sheet(name, content, opts){
    if (!host) return false;
    opts = opts || {};
    const swap = !!(sheetNow && opts.full && sheetNow.full && sheetNow.name === name);
    if (sheetNow && !swap) unsheet();
    sheetNow = { name, full: !!opts.full, onClose: opts.onClose || null, back: swap ? sheetNow.back : shadow.activeElement || null };
    if (opts.full) sheetEl.setAttribute('data-full', ''); else sheetEl.removeAttribute('data-full');
    while (sheetBody.firstChild) sheetBody.removeChild(sheetBody.firstChild);
    sheetBody.appendChild(content);
    sheetEl.setAttribute('aria-label', opts.label || '');
    sheetEl.setAttribute('data-sheet', name);
    sheetEl.scrollTop = 0;
    layer.hidden = false;
    bay.setAttribute('inert', '');               // 板が出ている間は、うしろの操作部に、キーボードでも入れない
    hold('sheet', true);
    if (Yomu.watch && Yomu.watch.cover) Yomu.watch.cover(sheetNow.full);   // 画面いっぱいの板(設定)が出ている間は、読んだ時間に数えない(§8-8)
    const first = content.querySelector('[data-focus]') || content.querySelector('button') || sheetEl;   // 押せる所が無い板は、板そのものへ
    if (first && first.focus){ try { first.focus({ preventScroll: true }); } catch (e){} }
    return true;
  }
  // 板の中の、Tab で回れる所(押せない・隠れている所は除く)
  function tabbables(){
    return Array.from(sheetEl.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'))
      .filter(e => !e.disabled && e.getAttribute('tabindex') !== '-1' && !e.closest('[hidden]'));
  }
  // Tab を、板の中にとどめる(最後の次は最初・最初の前は最後。板の外にいたら、中へ)
  function trapTab(e){
    const list = tabbables(), a = shadow.activeElement;
    if (!list.length){ e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1], inside = !!a && sheetEl.contains(a) && a !== sheetEl;
    if (e.shiftKey ? (!inside || a === first) : (!inside || a === last)){ e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  }
  // 読み上げ用の知らせ(画面には出ない)。loud = うまくいかなかったこと(すぐ読む)。同じ文でも、もう一度読むように、いったん空にする
  function announce(text, loud){
    const box = loud ? liveLoud : liveSoft;
    if (!box) return;
    box.textContent = '';
    box.textContent = String(text == null ? '' : text);
  }
  function unsheet(name){
    if (!sheetNow || (name && sheetNow.name !== name)) return;
    const was = sheetNow;
    sheetNow = null;
    layer.hidden = true;
    sheetEl.removeAttribute('data-full');
    bay.removeAttribute('inert');
    while (sheetBody.firstChild) sheetBody.removeChild(sheetBody.firstChild);
    hold('sheet', false);
    if (Yomu.watch && Yomu.watch.cover) Yomu.watch.cover(false);
    if (was.back && was.back.focus && was.back.isConnected){ try { was.back.focus({ preventScroll: true }); } catch (e){} }
    if (was.onClose){ try { was.onClose(); } catch (e){ warn(e); } }
  }

  // 取り消せない操作・回数を使う操作を、2回タップで確かめる(CMA と同じ)。1回目で文言が変わり、ui.twoTapMs の間にもう一度押すと fn
  //   o = { label: 文言を出している要素, armed: 1回目のあとの文言, fn }。戻り = 待っているのをやめる関数
  function twoTap(btn, o){
    let timer = null, was = null, at = 0;
    const disarm = () => {
      if (timer == null) return;
      clearTimeout(timer); timer = null;
      btn.removeAttribute('data-armed');
      o.label.textContent = was;
    };
    btn.addEventListener('keydown', e => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); });   // 押しっぱなしで、2回目まで通さない
    btn.addEventListener('click', () => {
      if (timer != null){
        if (Date.now() - at < cfg.ui.twoTapMinMs) return;      // 指が弾んだ二度押しは、2回目と数えない
        disarm(); o.fn(); return;
      }
      at = Date.now();
      was = o.label.textContent;
      o.label.textContent = o.armed;
      btn.setAttribute('data-armed', '');
      announce(o.armed);
      timer = setTimeout(disarm, cfg.ui.twoTapMs);
    });
    return disarm;
  }

  // ---- 土台を作る(1回) ----
  function mount(opts){
    if (host) return;
    opts = opts || {};
    doc = opts.doc || document;
    win = doc.defaultView;
    host = doc.createElement('div');
    host.id = HOST_ID;
    // closed: ページの側から中をさわれない。見本ページ用の束(dev)だけ open(検査と、目での確かめのため)
    shadow = host.attachShadow({ mode: (Y.build && Y.build.dev) || opts.open ? 'open' : 'closed' });
    host.setAttribute('data-yomu-css', addCss(style.css()));
    box = el('div', { class: 'yomu', lang: 'ja' });
    bay = el('div', { class: 'bay' });
    ['notice', 'main'].forEach(n => { slots[n] = el('div', { class: 'slot', 'data-slot': n }); bay.appendChild(slots[n]); });
    // 下から出る板(まわりを暗くする)と、短い知らせ(いちばん手前)
    sheetBody = el('div', { class: 'body' });
    sheetEl = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }, [el('div', { class: 'grip' }), sheetBody]);
    layer = el('div', { class: 'layer', hidden: true }, [el('div', { class: 'scrim', 'data-act': 'scrim', onclick: () => { if (sheetNow && !sheetNow.full) unsheet(); } }), sheetEl]);
    // 暗い所・板(中身が短くて、中を送れないとき)をなぞっても、うしろのページを送らない。板の中を送れるときは、止めない
    layer.addEventListener('touchmove', e => {
      if (!sheetEl.contains(e.target) || sheetEl.scrollHeight <= sheetEl.clientHeight) e.preventDefault();
    }, { passive: false });
    toastEl = el('div', { class: 'toast', hidden: true });
    liveSoft = el('div', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    liveLoud = el('div', { class: 'sr', role: 'alert', 'aria-live': 'assertive' });
    box.appendChild(bay);
    box.appendChild(layer);
    box.appendChild(toastEl);
    box.appendChild(liveSoft);
    box.appendChild(liveLoud);
    box.addEventListener('keydown', e => {
      if (!sheetNow) return;
      if (e.key === 'Escape') unsheet();
      else if (e.key === 'Tab') trapTab(e);
    });
    // 操作部の中のタップ・キーを、サイトの側(document の受け口。キーで次の話へ・タップで帯を出す など)に伝えない
    QUIET_EVENTS.forEach(type => box.addEventListener(type, e => e.stopPropagation()));
    shadow.appendChild(box);
    parts.forEach(p => { if (p.def.mount){ try { p.def.mount(); } catch (e){ warn(e); } } });   // 1つの部品が作れなくても、ほかは動かす
    doc.documentElement.appendChild(host);
    Y.page.on('state', draw);
    Y.page.on('notice', draw);
    Y.settings.on(() => draw());                     // 設定が変わった(右下のボタンを出さないサイト など。工程8c-2)
    Y.page.on('progress', p => each('progress', p));
    doc.addEventListener('click', onDocClick);
    doc.addEventListener('keydown', onDocKey);
    win.addEventListener('scroll', onScroll, { passive: true });
    win.addEventListener('resize', lift);
    if (cfg.ui.lift && cfg.ui.lift.on){ const t = setInterval(lift, cfg.ui.lift.everyMs); if (t && t.unref) t.unref(); }   // 広告は、あとから出る・閉じられる(unref = 検査の node を、待たせない)
    lift();
    lastY = scrollTop();
    draw();
  }

  // 回数を使う押せる所に書く、通信の数(設計メモ 2-2)。つなぎ方によっては、見せない(core/plan.js)。見せないときは、空の文字
  const cost = n => (Y.plan.shows('cost') ? msg.t('cost.' + n) : '');
  const withCost = (label, n) => { const c = cost(n); return c ? msg.t('cost.wrap', { label, cost: c }) : label; };

  // 短い知らせ(ポップアップは使わない)
  function toast(text, ms){
    if (!host) return;
    toastEl.textContent = String(text);
    toastEl.hidden = false;
    announce(text);
    clearTimeout(toastT);
    toastT = setTimeout(() => { toastEl.hidden = true; }, ms || cfg.ui.toastMs);
  }

  Yomu.ui = {
    mount,
    // 部品の登録(mount の前に)。同じ名前で登録し直したら、置きかえる(順は、もとのまま)
    part(name, def){ const p = find(name); if (p) p.def = def; else parts.push({ name, def }); },
    show(name, params){ const p = find(name); if (p && p.def.open){ p.def.open(params); return true; } return false; },
    hide(name){ const p = find(name); if (p && p.def.close) p.def.close(); },
    // 「ブレンド」を、入口のボタンと同じ道で押す(初めてなら、最初の設定を出す。工程5c-3: メニューからも訳せるように)
    blend(){ const p = find('dock'); if (p && p.def.blend){ p.def.blend(); return true; } return false; },
    has: name => !!find(name),
    toast, announce,
    // どのページでも(既知でないサイト)の、このページのホスト名。なろう・カクヨム・本文ページでないときは null(右下のボタンを出さないサイト=工程8c-2)
    webHost(){ const s = Y.page.status(); return s && s.page && s.page.indexOf('web:') === 0 && win ? String(win.location.hostname).toLowerCase() : null; },
    t: msg.t,
    cost, withCost,
    sheet, unsheet, twoTap,
    sheetName: () => (sheetNow ? sheetNow.name : null),
    el, icon, mark,
    hold, quiet, draw, run,
    away: () => away,
    lift, lifted: () => lifted, side: () => side,
    // 置き場のよけ方を、今の画面で計算し直した数字(調べるための記録。置き場は動かさない)。now = 今、実際に使っている値
    placeInfo(){
      let p = null;
      try { p = placeNow(true).info || null; } catch (e){ p = { err: String((e && e.message) || e).slice(0, 80) }; }
      const vv = win && win.visualViewport;
      // tick = 板が出ていないときの、いちばん新しい見回り(ago = 何 ms 前か)。hist = 置き場が変わった時刻と、そのときの上げ幅・よけた側
      return Object.assign(p || {}, { now: { lift: lifted, side }, tick: tickInfo ? Object.assign({ ago: Date.now() - tickAt }, tickInfo) : null, hist: placeHist.slice(), ms: Date.now() - t0, away, dpr: (win && win.devicePixelRatio) || 1, vv: vv ? [vv.width, vv.height, vv.scale].map(n => Math.round(n * 100) / 100) : null });
    },
    fresh: () => Date.now() - backAt < cfg.ui.guardMs,   // 隠れていた置き場が、出てきたすぐあとか(回数を使うボタンが、押しまちがいを受けないために聞く)
    status: () => cur,
    mounted: () => !!host,
    root: () => shadow,                                                  // Shadow DOM の根(部品と検査が使う。ページの側には出ない)
    box: () => box,
    slot: name => slots[name] || null
  };
})();

/* ---- ui/dock.js ---- */
// ui/dock.js — 入口のボタン・進み具合・操作部(部品の約束 §9-3。キャンバス 1・2・3)
//   状態 off = 1本の台に、ロゴ(メニュー)と「ブレンド」 / busy = 進み具合と中止 / on = ロゴ(メニュー)と、今の割合(たたんだ形)。none(本文ページでない)では何も出さない。
//   on の台は、ふだんは、たたんでおく(ロゴと「60%」だけ。本文と、サイトの下の広告を、隠しすぎない=設計メモ 2-5)。「60%」を押すと、つまみと「原文」がひらく。
//   ひらいたあと、さわらずに ui.foldMs たつ・台の外を押す・下へ読み進めて台が隠れる、で、たたむ。「原文」を押している間は、たたまない(押している印が見えるように)。
//   つまみは、動かしている間 setRatio(v, { save:false })、指を離したら setRatio(v)。どれも通信しない(通信するのは「ブレンド」だけ)
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, cfg = Yomu.config;
  const KNOB = Yomu.uiStyle.KNOB;   // つまみの丸の幅(px)

  let entry = null, launch = null, cost = null, main = null, prog = null;
  let ratioBox = null, input = null, knob = null, tip = null, origBtn = null, origOff = null, origOn = null;
  let fill = null, countEl = null;
  let pctBtn = null, pctTxt = null, miss = null;
  let value = 0, dragging = false, tipT = null, entryAt = 0, was = '';
  let open = false, openAt = 0, foldT = null;

  const openMenu = () => { if (!ui.show('menu')) ui.toast(ui.t('soon')); };
  const logoBtn = () => ui.el('button', { class: 'round', 'data-act': 'menu', 'aria-label': ui.t('dock.menu'), onclick: openMenu }, [ui.mark(24)]);

  // ---- 割合のつまみ ----
  const clamp = v => { const st = cfg.ratio.step; return Math.max(0, Math.min(100, Math.round(v / st) * st)); };
  function place(v){
    value = v;
    ratioBox.style.setProperty('--p', String(v / 100));          // つまみと数字の位置(CSS の .ratio .knob・.tip が読む)
    tip.textContent = ui.t('dock.ratioValue', { v });
    if (input.value !== String(v)) input.value = String(v);
    input.setAttribute('aria-valuetext', ui.t('dock.ratioValue', { v }));
    pctTxt.textContent = ui.t('dock.ratioValue', { v });
    pctBtn.setAttribute('aria-label', ui.t('dock.fold', { v }));
  }
  // ---- たたむ・ひらく ----
  function touch(){                                // さわった(たたむまでの時間を、数え直す)
    clearTimeout(foldT);
    if (open) foldT = setTimeout(() => { const s = ui.status(); if (dragging || (s && s.orig)) touch(); else setOpen(false); }, cfg.ui.foldMs);
  }
  function setOpen(v, byKey){
    v = !!v;
    if (v === open){ if (v) touch(); return; }
    open = v;
    if (v) openAt = Date.now();
    if (v) main.removeAttribute('data-fold'); else main.setAttribute('data-fold', '');
    pctBtn.setAttribute('aria-expanded', v ? 'true' : 'false');
    touch();
    if (v && byKey) input.focus();                 // キーボードでひらいたら、つまみへ(見えなくなったボタンに、フォーカスを残さない)
  }
  // 台の外を押した(合図は、Shadow DOM の外では、入れ物=host に当たったように見える)・下へ読み進めて、台が隠れた
  function onOutside(e){ if (open && !dragging && !(ui.status() && ui.status().orig) && !ui.root().host.contains(e.target)) setOpen(false); }
  function onScrollFold(){ if (open && !dragging && ui.away()) setOpen(false); }
  function valueAt(x){
    const r = ratioBox.getBoundingClientRect();
    const w = r.width - KNOB;
    if (!(w > 0)) return null;
    return clamp((x - r.left - KNOB / 2) / w * 100);
  }
  function live(on){
    clearTimeout(tipT);
    if (on) ratioBox.setAttribute('data-live', '');
    else tipT = setTimeout(() => ratioBox.removeAttribute('data-live'), cfg.ui.tipMs);
  }
  function slide(v){                               // 動かしている間(保存しない)
    touch();
    ui.quiet();
    place(v);
    Y.page.setRatio(v, { save: false });
  }
  function settle(){                               // 指を離した(保存する)
    touch();
    ui.quiet();
    Y.page.setRatio(value);
    live(false);
  }
  // 指・マウス。どちらも、押した所へすぐ動かす(つまみは、「60%」を押してひらいたときだけ出ている=読み進める指が、たまたま乗ることは無い。
  //   工程5b-2: iPhone で、動かし始めが重かった=横に動いたと分かるまで待つ作りをやめた。CSS は touch-action: none)。
  //   ひらいたすぐあと(ui.guardMs)は、受けない(「60%」を押した指の、弾んだ二度押しで、割合が変わらないように)
  let before = 0;                               // 動かし始める前の割合
  function begin(e){
    dragging = true;
    before = value;
    ui.hold('ratio', true);
    live(true);
    try { ratioBox.setPointerCapture(e.pointerId); } catch (x){}
  }
  function finish(save){
    if (!dragging) return;
    dragging = false;
    ui.hold('ratio', false);
    if (save){ settle(); return; }
    // 途中で取り上げられた(pointercancel など): 動かす前の割合に戻す(保存しない)
    ui.quiet();
    place(before);
    Y.page.setRatio(before, { save: false });
    live(false);
  }
  function onDown(e){
    if (e.button) return;
    const v = valueAt(e.clientX);
    if (v == null) return;
    if (Date.now() - openAt < cfg.ui.guardMs) return;
    e.preventDefault();
    begin(e);
    slide(v);
  }
  function onMove(e){
    if (!dragging) return;
    const v = valueAt(e.clientX);
    if (v != null && v !== value) slide(v);
  }
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  // 「ブレンド」: 押したら、進行役が動き出すまで押せなくする(訳す前の確かめの間。終わったら、今の状態で描き直す)
  //   初めて(最初の設定が済んだ印が無く、API キーも無い)なら、訳さずに、最初の設定(3枚。ui/settings.js の setup)を出す。通信しない
  //   入口の台が出てきたすぐあと(隠れていたのが出た・進み具合や操作部から戻った)は、受けつけない: 本文や「中止」をねらった指が当たって、回数を使わないように(§9-3)
  //   menu = メニューから押した(メニューの側で、出てすぐの押しまちがいを止めている。入口の台の出入りの時刻は、見ない)
  function onBlend(menu){
    if (menu !== true && (ui.fresh() || Date.now() - entryAt < cfg.ui.guardMs)) return;
    launch.disabled = true;
    const first = Y.settings.get().profile.setupDone ? Promise.resolve(false) : Y.settings.secrets.has().then(has => !has, () => false);
    first.then(yes => {
      if (yes && ui.has('setup')){
        launch.disabled = false;
        try { launch.focus({ preventScroll: true }); } catch (e){}   // 閉じたあと、フォーカスが「ブレンド」へ戻るように(押せない間に、外れている)
        ui.show('setup');
        return;
      }
      ui.run(() => Y.page.blend());
    });
  }

  function mount(){
    const slot = ui.slot('main');
    // 入口のボタン(キャンバス 1)。訳して保存してあるページでは、通信の数を書かない(保存から出すので、通信しない)
    cost = ui.el('span', { class: 'cost' });
    launch = ui.el('button', { class: 'launch', 'data-act': 'blend', hidden: true, onclick: onBlend },
      [ui.el('span', { text: ui.t('dock.blend') }), cost]);
    // 日本語のままの画面にも、メニューの入口(ロゴ)を置く(設計メモ 2-5)。操作部と同じ1本の台の、左はしがロゴ(メニュー)・残りが「ブレンド」(浮いているものは1つ。間は 8px)
    entry = ui.el('div', { class: 'dock entry', 'data-dock': 'entry', hidden: true }, [logoBtn(), launch]);

    // 操作部(キャンバス 3)
    input = ui.el('input', { type: 'range', min: '0', max: '100', step: String(cfg.ratio.step), 'aria-label': ui.t('dock.ratio'), 'data-act': 'ratio',
      oninput: () => { live(true); slide(clamp(Number(input.value))); },
      onchange: () => { place(clamp(Number(input.value))); settle(); } });
    knob = ui.el('span', { class: 'knob' });
    tip = ui.el('span', { class: 'tip', 'aria-hidden': 'true' });
    // たたんだ形: 今の割合(小さなつまみの絵と、数字)。押すと、つまみと「原文」がひらく
    pctTxt = ui.el('span');
    pctBtn = ui.el('button', { class: 'pill pct', 'data-act': 'unfold', 'aria-expanded': 'false', onclick: e => setOpen(true, e && e.detail === 0) },
      [ui.el('span', { class: 'mini', 'aria-hidden': 'true' }, [ui.el('i')]), pctTxt]);
    ratioBox = ui.el('div', { class: 'ratio', onpointerdown: onDown, onpointermove: onMove, onpointerup: onUp, onpointercancel: onCancel, onlostpointercapture: onCancel },
      [ui.el('span', { class: 'track' }), input, knob, tip, miss = ui.el('span', { class: 'miss', hidden: true })]);   // miss = つまみの下の小さな字(未訳の数。押せない)
    place(cfg.ratio.initial);
    origBtn = ui.el('button', { class: 'pill', 'data-act': 'orig', 'aria-pressed': 'false',
      onclick: () => { touch(); ui.quiet(); Y.page.setOrig(!(ui.status() && ui.status().orig)); } }, [origOff = ui.icon('swap', 18, 2), origOn = ui.icon('check', 18, 2.6), ui.el('span', { text: ui.t('dock.orig') })]);
    main = ui.el('div', { class: 'dock', 'data-dock': 'main', 'data-fold': '', hidden: true }, [logoBtn(), pctBtn, ratioBox, origBtn]);
    const doc = slot.ownerDocument, win = doc.defaultView;
    doc.addEventListener('pointerdown', onOutside, true);
    if (win) win.addEventListener('scroll', onScrollFold, { passive: true });

    // 進み具合(キャンバス 2)
    fill = ui.el('div', { class: 'fill' });
    countEl = ui.el('span', { class: 'count' });
    prog = ui.el('div', { class: 'dock', 'data-dock': 'progress', hidden: true }, [
      logoBtn(),
      ui.el('div', { class: 'prog' }, [
        ui.el('div', { class: 'row' }, [ui.el('span', { class: 'label', text: ui.t('dock.progress') }), countEl]),
        ui.el('div', { class: 'bar' }, [fill]),
        // 訳している間に、ほかのアプリへ行くと、iPhone は、すぐ通信を止める(工程5b-2 利用者の実測)。回数をむだにしないように、先に知らせる
        ui.el('div', { class: 'stay', text: ui.t('dock.stay') })
      ]),
      ui.el('button', { class: 'round', 'data-act': 'cancel', 'aria-label': ui.t('dock.cancel'), onclick: () => ui.run(() => Y.page.cancel()) }, [ui.icon('close', 20, 2)])
    ]);

    slot.appendChild(entry);
    slot.appendChild(main);
    slot.appendChild(prog);
  }

  function setProgress(p){
    countEl.textContent = p ? ui.t('dock.count', p) : '';
    fill.style.width = (p && p.total > 0 ? Math.max(0, Math.min(100, p.got / p.total * 100)) : 0) + '%';
  }

  function draw(s){
    if (s.state === 'off' && (was === 'busy' || was === 'on')) entryAt = Date.now();   // ほかの形(進み具合・操作部)から、入口の台に戻った時刻
    was = s.state;
    const host = ui.webHost();
    entry.hidden = s.state !== 'off' || (!!host && Y.settings.hidden(host));   // 右下のボタンを出さないサイト(工程8c-2): 日本語のままの台だけを出さない(Tampermonkey のメニューから訳したあとの操作部は出す)              // ロゴ(メニュー)は、1日の上限のカードが出ている間も残す(設定へ行ける)
    launch.hidden = s.state !== 'off' || !!(s.notice && s.notice.kind === 'limit-day');   // 1日の上限のカードが出ている間は、カードの2つのボタンだけ(キャンバス)
    main.hidden = s.state !== 'on';
    if (s.state !== 'on') setOpen(false);
    prog.hidden = s.state !== 'busy';
    if (s.state === 'off'){
      const saved = !!s.saved[s.level];
      const c = ui.cost(2);
      cost.textContent = c;
      cost.hidden = saved || !c;
      // 読み上げの名前: 通信の数が出ているときだけ、区切って足す(つなぎ方によっては、通信の数は出ない=名前は「ブレンド」だけ)
      if (cost.hidden) launch.removeAttribute('aria-label'); else launch.setAttribute('aria-label', ui.t('dock.blendName', { label: ui.t('dock.blend'), cost: c }));
      launch.disabled = s.busy && !saved;          // 訳す前の確かめの最中(二度押しを見せない。進行役も受けない)
    }
    if (s.state !== 'busy') setProgress(null);
    if (!dragging) place(s.ratio);
    // 未訳が残っていれば、つまみの下に、小さく数を出す(少ない未訳は、知らせを出さない=設計メモ 2-5。訳すのは、メニューの「続きを訳す」)
    const left = (s.state === 'on' && s.n && s.n.missing) || 0;
    miss.hidden = !left;
    miss.textContent = left ? ui.t('dock.missing', { n: left, all: s.n.targets }) : '';
    if (left) ratioBox.setAttribute('data-miss', ''); else ratioBox.removeAttribute('data-miss');
    origBtn.setAttribute('aria-pressed', s.orig ? 'true' : 'false');
    // 押している印は、色のほかに、絵でも出す(入れかえの絵 → チェック。§9-9)
    [[origOff, !!s.orig], [origOn, !s.orig]].forEach(([e, hide]) => { if (hide) e.setAttribute('hidden', ''); else e.removeAttribute('hidden'); });
  }

  ui.part('dock', { mount, draw, progress: setProgress, blend: () => onBlend(true) });
})();

/* ---- ui/notice.js ---- */
// ui/notice.js — 知らせの行と、上限の知らせ(部品の約束 §9-3・§9-5。知らせの種類は §6-7)
//   操作部のすぐ上に、文言と、押せる所を1つ(回数を使う所には、通信の数を書く。つなぎ方によっては書かない=Yomu.ui.withCost)。右はしの「×」で閉じる(Yomu.page.dismiss)。
//   1日の上限(limit-day)だけは、キャンバスの「無料枠を使い切ったとき」のカード(あとにする/Flash-Lite で訳す)。
//   外から来た文字(相手の返した文・モデルの名前)は textContent だけで出す
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, cfg = Yomu.config;

  let note = null, noteText = null, noteIcon = null, noteActs = null, card = null, cardTitle = null, cardDesc = null, cardActs = null;
  let shownKey = null;             // 今出している知らせ(同じ知らせなら、作り直さない)

  // モデルの呼び名(gemini-3.5-flash-lite → Flash-Lite)。知らない名前は、そのまま
  const short = m => { const s = String(m || ''); return /flash-lite/i.test(s) ? 'Flash-Lite' : /flash/i.test(s) ? 'Flash' : /pro/i.test(s) ? 'Pro' : s; };
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? ui.t('clip', { text: s.slice(0, n) }) : s; };
  // 押し直すもの(blend・more・redo)。知らない名前なら blend
  const again = (act, arg) => () => Y.page[act === 'more' || act === 'redo' ? act : 'blend'](arg);
  const openSettings = () => { if (!ui.show('settings', { page: 'connect' })) ui.toast(ui.t('soon')); };   // キーを入れる画面へ、まっすぐ

  // 失敗の種類ごとの文(§5-5)
  function errorText(n){
    const c = n.cause;
    if (c === 'overload' || c === 'server') return ui.t('err.busy');
    if (c === 'bad') return n.message ? ui.t('err.detail', { text: ui.t('err.bad'), detail: clip(n.message, cfg.ui.noteMax) }) : ui.t('err.bad');
    return ui.t(Y.msg.has('err.' + c) ? 'err.' + c : 'err.other');
  }

  // うまくいかなかったことの知らせ(失敗)。案内(残りは未訳・縦組み・キーがまだ など)と、見て区別がつく形にする(色と印。設計メモ 2-5)
  const INFO = ['no-key', 'switched-lite', 'partial', 'need-translate', 'vertical', 'evicted'];   // 案内(失敗ではないもの)。ここに無い知らせは、失敗として出す
  // 途中で切れた(混雑・通信がとぎれた)ために残った未訳は、失敗の形で出して、わけを添える(工程5c-1)
  const cutOf = n => (n.kind !== 'partial' ? '' : n.cause === 'overload' || n.cause === 'server' ? 'note.cutBusy' : n.cause === 'network' ? 'note.cutNet' : '');
  const toneOf = n => (INFO.indexOf(n.kind) >= 0 && !cutOf(n) ? '' : 'warn');
  // 知らせ → { text, acts:[{ label, fn, busyOff }] }。busyOff = 使用中は押せない(進行役も受けない)
  function view(n){
    switch (n.kind){
      case 'no-key': return { text: ui.t('note.noKey'), acts: [{ label: ui.t('act.settings'), fn: openSettings }] };
      case 'limit-min': return { text: n.retrySec != null ? ui.t('note.limitMin', { sec: n.retrySec }) : ui.t('note.limitMinSoon'), acts: [] };
      case 'switched-lite': return { text: ui.t('note.switched', { from: short(n.from), to: short(n.to) }), acts: [] };
      case 'partial': return { text: ui.t(cutOf(n) || 'note.partial', { n: n.missing }), acts: [{ label: ui.withCost(ui.t('act.more'), 2), fn: () => Y.page.more(), busyOff: true }] };
      case 'need-translate': return { text: ui.t('note.needTranslate'), acts: [{ label: ui.withCost(ui.t('act.translate'), 2), fn: () => Y.page.blend(), busyOff: true },
        { label: ui.t('act.goal'), fn: () => { ui.show('settings', { page: 'goal' }); } }] };   // 日本語のままの画面には、メニューが無い。訳さずに、目標を戻せるように
      case 'blocked': return { text: ui.t('note.blocked'), acts: [] };
      case 'idioms-failed': return n.cause === 'limit-day'
        ? { text: ui.t('note.idiomsLimit'), acts: [] }
        : { text: ui.t('note.idioms'), acts: [{ label: ui.withCost(ui.t('act.idioms'), 1), fn: () => Y.page.idioms(), busyOff: true }] };
      // 熟語さがしが、途中までしか届かなかった(半分以上の文が届かない。工程T-5b)。やり直すと、届かなかった文だけを送る
      case 'idioms-partial': return { text: ui.t('note.idiomsPart'), acts: [{ label: ui.withCost(ui.t('act.idioms'), 1), fn: () => Y.page.idioms(), busyOff: true }] };
      case 'suspect': return { text: ui.t('note.suspect', { n: n.dropped }), acts: [{ label: ui.withCost(ui.t('act.redo'), 2), fn: again(n.act), busyOff: true }] };
      case 'vertical': return { text: ui.t('note.vertical'), acts: [] };
      case 'full': return { text: ui.t('note.full'), acts: [] };
      case 'evicted': return { text: ui.t('note.evicted', { n: n.pages }), acts: [] };
      case 'newer': return { text: ui.t('note.newer'), acts: [] };
      case 'conflict': return { text: ui.t('note.conflict'), acts: [] };
      // 起動の途中で、保存を読むのが終わらない: 直し方を、すぐ示す(行き止まりにしない=2026-10-11 利用者)
      // Tampermonkey のメニューから押したのに、日本語の文が見つからなかった(工程8c-2)。失敗の形で、どうすればよいかを添える
      case 'nojp': return { text: ui.t('note.nojp'), acts: [] };
      case 'stuck': return { text: ui.t(n.ios ? 'note.stuckIos' : 'note.stuck'), acts: [{ label: ui.t('act.fix'), fn: () => { ui.show('fix'); } }] };
      case 'error': return { text: errorText(n), acts: [] };
      default: return { text: ui.t('err.other'), acts: [] };
    }
  }

  // a = { label, cost(下に小さく書く、通信の数), fn, busyOff }
  function button(cls, a, busy){
    return ui.el('button', { class: cls, disabled: !!(a.busyOff && busy), 'data-busy-off': a.busyOff ? '1' : null, onclick: () => ui.run(a.fn) },
      [ui.el('span', { text: a.label }), a.cost ? ui.el('span', { class: 'cost', text: a.cost }) : null]);
  }
  function fill(box, kids){
    while (box.firstChild) box.removeChild(box.firstChild);
    kids.forEach(k => box.appendChild(k));
  }

  function mount(){
    const slot = ui.slot('notice');
    noteText = ui.el('span', { class: 'text' });
    noteIcon = ui.icon('alert', 18, 2);
    noteActs = ui.el('div', { class: 'acts' });
    note = ui.el('div', { class: 'note', hidden: true }, [
      ui.el('div', { class: 'line' }, [noteIcon, noteText]),
      ui.el('button', { class: 'x', 'data-act': 'dismiss', 'aria-label': ui.t('note.close'), onclick: () => ui.run(() => Y.page.dismiss()) }, [ui.icon('close', 18, 2)]),
      noteActs
    ]);
    cardTitle = ui.el('span', { class: 'title' });
    cardDesc = ui.el('div', { class: 'desc' });
    cardActs = ui.el('div', { class: 'acts' });
    card = ui.el('div', { class: 'card', hidden: true }, [ui.el('div', { class: 'head' }, [ui.mark(22), cardTitle]), cardDesc, cardActs]);
    slot.appendChild(note);
    slot.appendChild(card);
  }

  function draw(s){
    const n = s.notice;
    const key = n ? Y.plan.kind() + JSON.stringify(n) : null;
    const isCard = !!n && n.kind === 'limit-day';
    note.hidden = !n || isCard;
    card.hidden = !isCard;
    if (key !== shownKey){
      shownKey = key;
      if (isCard){
        cardTitle.textContent = ui.t('limit.title', { model: short(n.model) });
        const lite = Y.settings.get().aux.lite;
        cardDesc.textContent = ui.t(n.canLite ? 'limit.descLite' : 'limit.desc', { lite: short(lite) });
        fill(cardActs, n.canLite
          ? [button('later', { label: ui.t('limit.later'), fn: () => Y.page.dismiss() }, false),
            button('go', { label: ui.t('limit.lite', { lite: short(lite) }), cost: ui.cost(2), fn: again(n.act, { use: lite }), busyOff: true }, s.busy)]
          : [button('later', { label: ui.t('note.close'), fn: () => Y.page.dismiss() }, false)]);
      } else if (n){
        const v = view(n);
        noteText.textContent = v.text;
        const tone = toneOf(n);
        if (tone) note.setAttribute('data-tone', tone); else note.removeAttribute('data-tone');
        noteIcon.style.display = tone ? '' : 'none';
        fill(noteActs, v.acts.map(a => button('act', a, s.busy)));
        noteActs.hidden = !v.acts.length;
      }
      (isCard ? card : note).setAttribute('data-kind', n ? n.kind : '');
      // 読み上げ: 知らせが変わったときに1回だけ(描き直しでは、読み直さない)。失敗は、すぐ読む
      if (isCard) ui.announce(cardTitle.textContent + ' ' + cardDesc.textContent);
      else if (n) ui.announce(noteText.textContent, !!toneOf(n));
    }
    // 使用中は、回数を使う所を押せなくする(同じ知らせが出たまま、使用中だけが変わることがある)
    [noteActs, cardActs].forEach(box => Array.from(box.querySelectorAll('[data-busy-off]')).forEach(b => { b.disabled = !!s.busy; }));
  }

  ui.part('notice', { mount, draw });
})();

/* ---- ui/menu.js ---- */
// ui/menu.js — メニュー(部品の約束 §9-3。キャンバス3ページ目の「メニュー(学習レベルは出さない)」)
//   ロゴを押すと、下から出る。このページ(オフライン保存=準備中。config.ui.offlineEntry のときだけ・まだ訳していなければ「ブレンド」/訳してあれば「訳し直す」・(残っていれば)続きを訳す・(失敗していれば)熟語さがしをやり直す)/見た目/設定/学ぶ画面をひらく。
//   学習レベルは出さない(設定の「目標」に寄せる=設計メモ 2-5)。回数を使う所には、通信の数を書く(つなぎ方によっては書かない=Yomu.ui.cost)。
//   使用中(status().busy)は、回数を使う所を押せなくする
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui;
  const NAME = 'menu';

  let hideBtn = null, hideOff = null, redoBtn = null, moreBtn = null, moreLabel = null, idiomsBtn = null, lookVal = null, disarm = null, blendBtn = null, blendCost = null, openAt = 0;

  const soon = () => ui.toast(ui.t('soon'));
  const close = () => ui.unsheet(NAME);
  // 回数を使う押せる所: 文言の下に、通信の数を小さく書く
  function tile(o){
    const label = ui.el('span', { text: o.label });
    const c = o.cost ? ui.cost(o.cost) : '';
    const b = ui.el('button', { class: 'tile' + (o.wide ? ' wide' : ''), 'data-item': o.item, onclick: o.fn || null },
      [o.icon ? ui.icon(o.icon, 18, 2) : null, ui.el('span', { class: 'two' }, [label, c ? ui.el('span', { class: 'cost', text: c }) : null])]);
    return { b, label };
  }
  function row(item, text, fn){
    const val = ui.el('span');
    const b = ui.el('button', { class: 'rowbtn', 'data-item': item, onclick: fn }, [ui.el('span', { text }), ui.el('span', { class: 'val' }, [val, ui.icon('chevR', 18, 2)])]);
    return { b, val };
  }

  function build(){
    const offline = Y.config.ui.offlineEntry;                 // 「オフライン保存」の入口(はじめは出さない。出さないときは、「訳し直す」を横いっぱいに)
    const redo = tile({ item: 'redo', icon: 'refresh', wide: !offline, label: ui.t('menu.redo'), cost: 2 });
    // まだ訳していないページでは、「訳し直す」の代わりに「ブレンド」(1回押し。右下の「ブレンド」と同じ道=初めてなら、最初の設定。出てすぐ ui.guardMs は受けない)
    const blend = tile({ item: 'blend', wide: !offline, label: ui.t('menu.blend'), cost: 2, fn: () => {
      if (Date.now() - openAt < Y.config.ui.guardMs) return;
      close(); ui.blend();
    } });
    blendBtn = blend.b; blendCost = blend.b.querySelector('.cost');
    redoBtn = redo.b;
    disarm = ui.twoTap(redoBtn, { label: redo.label, armed: ui.t('menu.redoArmed'), fn: () => { close(); ui.run(() => Y.page.redo()); } });
    const more = tile({ item: 'more', wide: true, label: '', cost: 2, fn: () => { close(); ui.run(() => Y.page.more()); } });
    moreBtn = more.b; moreLabel = more.label;
    idiomsBtn = tile({ item: 'idioms', wide: true, label: ui.t('menu.idioms'), cost: 1, fn: () => { close(); ui.run(() => Y.page.idioms()); } }).b;
    // 右下のボタンを出さないサイト(どのページでもだけ。なろう・カクヨムには出さない=工程8c-2)。取り消せるが、ボタンが消えるので、2回タップで確かめる
    const host = ui.webHost();
    const hide = host ? row('hide', ui.t('menu.hide'), null) : null;
    hideBtn = hide ? hide.b : null;
    hideOff = hide ? ui.twoTap(hide.b, { label: hide.b.firstChild, armed: ui.t('menu.hideArmed'), fn: () => {
      close();
      Y.settings.hide(host).then(() => ui.toast(ui.t('menu.hidden', { site: host }), Y.config.ui.toastLongMs), () => ui.toast(ui.t('set.saveFail')));
    } }) : null;
    const look = row('look', ui.t('menu.look'), () => { if (!ui.show('look')) soon(); });
    lookVal = look.val;
    return ui.el('div', { class: 'menu' }, [
      ui.el('div', { class: 'top' }, [
        ui.el('div', { class: 'brand' }, [ui.mark(24), ui.el('span', { text: Y.msg.app() })]),
        ui.el('button', { class: 'iconbtn end', 'data-act': 'close', 'data-focus': '', 'aria-label': ui.t('note.close'), onclick: close }, [ui.icon('close', 20, 2)])
      ]),
      ui.el('div', { class: 'label', text: ui.t('menu.page') }),
      ui.el('div', { class: 'grid2' }, [
        offline ? tile({ item: 'offline', icon: 'download', label: ui.t('menu.offline'), fn: soon }).b : null,
        blendBtn, redoBtn, moreBtn, idiomsBtn
      ]),
      ui.el('div', { class: 'rows' }, [
        hideBtn,
        look.b,
        row('settings', ui.t('menu.settings'), () => { if (!ui.show('settings')) soon(); }).b,
        row('learn', ui.t('menu.learn'), soon).b
      ])
    ]);
  }

  // 今の状態に合わせる(開いている間に、状態が変わることがある: 熟語さがしが終わった など)
  function sync(s){
    const has = s.n.translated > 0;                              // このレベルの訳が、今ある
    blendBtn.hidden = has || s.busy;                             // 訳が無いうちは、「訳し直す」の代わりに「ブレンド」(訳している最中は、押せない「訳し直す」)
    redoBtn.hidden = !blendBtn.hidden;
    redoBtn.disabled = s.busy || !has;
    if (blendCost) blendCost.hidden = !!(s.saved && s.saved[s.level]);   // 訳して保存してあるページは、保存から出す(通信しない。入口のボタンと同じ)
    moreBtn.hidden = !(has && s.n.missing > 0);                  // 未訳が残っているときだけ(知らせを閉じたあとの入口)
    moreBtn.disabled = s.busy;
    moreLabel.textContent = ui.t('menu.more', { n: s.n.missing });
    idiomsBtn.hidden = !(has && (s.idioms === 'failed' || s.idioms === 'partial'));   // 熟語さがしが失敗・途中のときだけ(§9-3)
    idiomsBtn.disabled = s.busy;
    lookVal.hidden = !Y.config.ui.themePick;                  // テーマを手で選ぶ所を出さない間は、行の右に何も書かない(選べないものを、選んだ値のように見せない)
    lookVal.textContent = lookVal.hidden ? '' : s.theme === Y.theme.AUTO || !Y.theme.has(s.theme) ? ui.t('look.autoShort') : ui.t('theme.' + s.theme);   // 行の右に、今のテーマ(キャンバス3ページ目)
  }

  ui.part(NAME, {
    open(){
      const s = ui.status();
      if (!s || s.state === 'none') return;
      const body = build();
      openAt = Date.now();
      sync(s);
      const stopRedo = disarm, stopHide = hideOff;    // この板の「訳し直す」「出さない」の確かめ(閉じたら、やめる)
      const stop = () => { if (stopRedo) stopRedo(); if (stopHide) stopHide(); };
      ui.sheet(NAME, body, { label: ui.t('dock.menu'), onClose: stop });
    },
    close,
    draw(s){ if (ui.sheetName() === NAME) sync(s); }   // 出ているかは、土台に聞く(同じ板を出し直しても、ずれない)
  });
})();

/* ---- ui/look.js ---- */
// ui/look.js — メニューの「見た目」(部品の約束 §9-3。キャンバス3ページ目の「メニュー › 見た目」)
//   上から、テーマ(サイトの色に合わせる/色の組)・英文の見せ方(マーカー/書体だけ)・英文の書体・英文の文字の大きさ。
//   どれも、すぐ切り替わる(通信しない)。選んだものは、進行役が設定に残す。色の組・書体・大きさの名前は core/theme.js(足したら、ここにも並ぶ)
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, theme = Yomu.theme;
  const NAME = 'look';
  const STYLES = [['marker', 'look.marker', 's-marker'], ['quiet', 'look.quiet', 's-quiet']];

  let picks = [], autoBtn = null, autoNow = null, autoTick = null, sets = [], fonts = [], sizes = [];

  const tickOf = () => ui.el('span', { class: 'tick', hidden: true }, [ui.icon('check', 14, 2.6)]);
  const mini = () => ui.el('span', { class: 'tick', hidden: true }, [ui.icon('check', 12, 3)]);   // 角に付ける小さい印(色の組の札・横に並ぶ選ぶボタン)
  const press = (b, on) => { b.setAttribute('aria-pressed', on ? 'true' : 'false'); const k = b.querySelector('.tick'); if (k) k.hidden = !on; };

  function card(name, key, cls){
    const tick = tickOf();
    const b = ui.el('button', { class: 'pick', 'data-style': name, 'aria-pressed': 'false', onclick: () => { ui.quiet(); Y.page.setStyle(name); } }, [
      ui.el('span', { class: 'name' }, [ui.el('span', { text: ui.t(key) }), tick]),
      ui.el('span', { class: 'sample' }, [ui.t('look.sampleJp'), ui.el('span', { class: cls, lang: 'en', text: ui.t('look.sampleEn') })])
    ]);
    return { name, b, tick };
  }
  // 色の組の札(その組の色で描く。CSS が、札の中だけ、色の名前をその組の値にする)
  function swatch(name){
    const b = ui.el('button', { class: 'sw', 'data-set': name, 'aria-pressed': 'false', onclick: () => Y.page.setTheme(name) }, [
      ui.el('span', { class: 'abc', lang: 'en', text: ui.t('look.abc') }),
      ui.el('span', { class: 'nm', text: ui.t('theme.' + name) }), mini()
    ]);
    return { name, b };
  }
  // 横に並ぶ、選ぶボタン(書体・文字の大きさ)
  function seg(kind, names, fn){
    const items = names.map(name => ({ name, b: ui.el('button', { class: 'f-' + name, ['data-' + kind]: name, 'aria-pressed': 'false', onclick: () => { ui.quiet(); fn(name); } }, [ui.t('look.' + kind + '.' + name), mini()]) }));
    return { items, box: ui.el('div', { class: 'seg' }, items.map(x => x.b)) };
  }

  function build(){
    const pick = !!Y.config.ui.themePick;
    picks = STYLES.map(([name, key, cls]) => card(name, key, cls));
    autoTick = tickOf();
    autoNow = ui.el('span', { class: 'now' });
    autoBtn = ui.el('button', { class: 'auto', 'data-set': theme.AUTO, 'aria-pressed': 'false', onclick: () => Y.page.setTheme(theme.AUTO) }, [
      ui.el('span', { class: 'two' }, [ui.el('span', { text: ui.t('look.auto') }), autoNow]), autoTick
    ]);
    sets = theme.names().map(swatch);
    const f = seg('font', theme.fonts(), name => Y.page.setFont(name));
    const z = seg('size', theme.sizes(), name => Y.page.setSize(name));
    fonts = f.items; sizes = z.items;
    return ui.el('div', { class: 'look' }, [
      ui.el('div', { class: 'top' }, [
        ui.el('button', { class: 'iconbtn start', 'data-act': 'back', 'aria-label': ui.t('look.back'), onclick: () => { if (!ui.show('menu')) ui.unsheet(NAME); } }, [ui.icon('chevL', 20, 2)]),
        ui.el('div', { class: 'heading', text: ui.t('menu.look') }),
        ui.el('button', { class: 'iconbtn end', 'data-act': 'close', 'data-focus': '', 'aria-label': ui.t('note.close'), onclick: () => ui.unsheet(NAME) }, [ui.icon('close', 20, 2)])
      ]),
    ].concat(pick ? [                                        // テーマを手で選ぶ所(config.ui.themePick。出さないときは、いつもサイトの色に合わせる)
      ui.el('div', { class: 'label', text: ui.t('look.theme') }),
      autoBtn,
      ui.el('div', { class: 'grid4' }, sets.map(x => x.b))
    ] : [], [
      ui.el('div', { class: 'label', text: ui.t('look.style') }),
      ui.el('div', { class: 'grid2' }, picks.map(p => p.b)),
      ui.el('div', { class: 'label', text: ui.t('look.font') }),
      f.box,
      ui.el('div', { class: 'label', text: ui.t('look.size') }),
      z.box
    ]));
  }
  function sync(s){
    picks.forEach(p => {
      press(p.b, s.style === p.name);
    });
    const auto = s.theme === theme.AUTO;
    press(autoBtn, auto);
    autoNow.textContent = auto ? ui.t('look.autoNow', { name: ui.t('theme.' + s.themeNow) }) : '';   // 自動のときは、今どの組になっているかを添える
    autoNow.hidden = !auto;
    sets.forEach(x => press(x.b, !auto && s.theme === x.name));
    fonts.forEach(x => press(x.b, s.font === x.name));
    sizes.forEach(x => press(x.b, s.size === x.name));
  }

  ui.part(NAME, {
    open(){
      const s = ui.status();
      if (!s || s.state === 'none') return;
      const body = build();
      sync(s);
      ui.sheet(NAME, body, { label: ui.t('menu.look') });
    },
    close(){ ui.unsheet(NAME); },
    draw(s){ if (ui.sheetName() === NAME) sync(s); }
  });
})();

/* ---- ui/speech.js ---- */
// ui/speech.js — 音声(部品の約束 §9-7)。現行の iPhone 版と PC 版の speak を1つにしたもの(端末で出し分ける)
//   共通: 始める前に止める(cancel。止まったままなら resume してから)/発話を変数に持ち続ける(消されると無音になる)/lang は en-US・速さは設定
//   iPhone・iPad(env.info.ios): 声を指定しない(端末の設定の声になる。設定で選んだときだけ指定)・タップの流れの中で、待たずに鳴らす
//   それ以外: 声を自動で選ぶ(現行 PC 版 getBestEnglishVoice の順)・止める処理とぶつからないよう、少し遅らせて鳴らす
(function(){
  'use strict';
  const Y = Yomu;
  const cfg = Yomu.config, settings = Yomu.settings;

  let scope = null;                 // 鳴らす窓(ui/word.js が、土台の窓を渡す。検査は、にせの窓を渡す)
  let now = null;                   // 今の発話 { ut, onEnd, t }(持ち続ける)
  let list = null, hooked = null;   // 声の一覧(voiceschanged のたびに取り直す)

  const win = () => scope || (typeof window !== 'undefined' ? window : null);
  const synth = () => { const w = win(); return (w && w.speechSynthesis) || null; };
  const can = () => { const w = win(); return !!(w && w.speechSynthesis && typeof w.SpeechSynthesisUtterance === 'function'); };
  const isIos = () => !!(Y.env && Y.env.info && Y.env.info.ios);
  function pref(){
    let v = null;
    try { v = settings.get().voice; } catch (e){}
    return { name: v && typeof v.name === 'string' ? v.name : '', rate: v && v.rate > 0 ? v.rate : cfg.voice.rate };
  }

  function raw(){
    const s = synth();
    if (!s) return [];
    if (hooked !== s){
      hooked = s; list = null;
      try { s.addEventListener('voiceschanged', () => { list = null; }); } catch (e){}
    }
    if (!list || !list.length){ try { list = Array.from(s.getVoices() || []); } catch (e){ list = []; } }
    return list;
  }
  const lang = v => String((v && v.lang) || '');
  const en = v => /^en/i.test(lang(v));
  const enUS = v => /^en[-_]US$/i.test(lang(v));
  // 名前で探す(同じ名前 → 名前の一部)
  function byName(vs, name){
    if (!name) return null;
    const low = name.toLowerCase();
    return vs.find(v => v.name === name) || vs.find(v => String(v.name).toLowerCase().indexOf(low) >= 0) || null;
  }
  // 声を自動で選ぶ(現行 PC 版の順): 設定の声 → 名前に Natural → Google US English → Premium/Enhanced → よく知られた声 → en-US → 英語
  function best(vs, name){
    const has = (v, w) => String(v.name).indexOf(w) >= 0;
    return byName(vs, name)
      || vs.find(v => en(v) && has(v, 'Natural'))
      || vs.find(v => has(v, 'Google US English') || (enUS(v) && has(v, 'Google')))
      || vs.find(v => en(v) && (has(v, 'Premium') || has(v, 'Enhanced')))
      || vs.find(v => en(v) && /(Jenny|Guy|Aria|Ava|Zoe|Samantha|Alex|Siri)/i.test(v.name))
      || vs.find(enUS)
      || vs.find(en)
      || null;
  }

  // 終わった(その発話が、今のものであるときだけ)
  function finish(u){
    if (now !== u) return;
    now = null;
    if (u.t != null) clearTimeout(u.t);
    if (u.onEnd){ try { u.onEnd(); } catch (e){} }
  }
  function stop(){
    const u = now;
    now = null;
    if (u && u.t != null) clearTimeout(u.t);
    const s = synth();
    if (s){ try { if (s.paused) s.resume(); s.cancel(); } catch (e){} }
    if (u && u.onEnd){ try { u.onEnd(); } catch (e){} }
  }
  // 鳴らす → 鳴らし始めたら true。o.onEnd = 終わった・止めた・失敗した、のどれでも1回
  function say(text, o){
    const t = String(text == null ? '' : text).trim();
    if (!t || !can()) return false;
    stop();                                                   // 前の発話を止める(その onEnd も呼ぶ)
    const w = win(), s = synth(), p = pref(), ios = isIos();
    let ut;
    try { ut = new w.SpeechSynthesisUtterance(t); } catch (e){ return false; }
    ut.lang = 'en-US';
    ut.rate = p.rate;
    const voice = ios ? byName(raw(), p.name) : best(raw(), p.name);   // iPhone: 設定で選んだときだけ指定する
    if (voice) ut.voice = voice;
    const u = now = { ut, onEnd: o && typeof o.onEnd === 'function' ? o.onEnd : null, t: null };
    ut.onend = () => finish(u);
    ut.onerror = () => finish(u);
    const go = () => { u.t = null; if (now !== u) return; try { s.speak(ut); } catch (e){ finish(u); } };
    if (ios) go(); else u.t = setTimeout(go, cfg.voice.delayMs);
    return true;
  }

  Yomu.speech = {
    attach(w){ scope = w || null; },
    can, say, stop,
    speaking: () => !!now,
    voices: () => raw().map(v => ({ name: String(v.name), lang: lang(v) }))
  };
})();

/* ---- ui/word.js ---- */
// ui/word.js — 単語の板(部品の約束 §9-4。キャンバス 4・4b・3ページ目の「単語の板 — もとの語」)
//   英文の語をタップすると、下から出る。持つのは「どの文(sid)の、何番目から何番目の語か」。「前へ/後ろへひろげる」は、この範囲を1語ずつ広げる(通信なし)。
//   意味を出す順(設計メモ 2-4): 範囲が熟語と同じ → 熟語さがしの意味/内蔵辞書(活用形は原形に直して引く。初めての1回だけ、辞書を取ってくる)/無ければ「内蔵辞書にありません」。
//   「この文での意味をAIに聞く」は、押したときだけ1回通信する(保存にあれば、通信なしで出す。板を閉じたら・範囲を変えたら、中止)。「単語帳に追加」は、保存だけ(復習はフェーズ2)。
//   音声(ui/speech.js): 「発音を聞く」(選んだ語句)・「この文を聞く」。同じボタンをもう一度押したら止める。板を閉じたら・範囲を変えたら、止める。
//   品詞の札は出さない(内蔵辞書に品詞の欄が無い=2026-10-09 利用者)。試験の級・「この作品で○回目」の場所は、空けてある。
//   外から来た文字(辞書・訳)は textContent だけで出す。板が持つ文の英文が変わったら(訳し直し)、閉じる
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, cfg = Yomu.config, speech = Yomu.speech;
  const NAME = 'word';

  let cur = null;                   // 出している板 { sid, en, jp, words, tokens, spans, from, to, all, counted, … }(Yomu.page.sentence の戻りに足したもの)
                                    //   tokens = 英文を単語に分けたもの(熟語も1語ずつ=1語ずつ広げられるように)。spans = 熟語の範囲 [{ from, to, i }]
  let body = null;                  // 板の中身の入れ物(範囲が変わるたびに、この中を作り直す)
  let stateEl = null;               // 「辞書を用意しています…」の行(進み具合を書きかえる)
  let liveEl = null;                // AI の答えの行(届いた順に書きかえる)
  // 内蔵辞書の取り寄せ(板を閉じても、止めない=取りかけを捨てない。板をまたいで1つ)
  let loading = false, dictErr = null, pct = null;

  const isWord = tk => !!tk && tk.t === 'w';
  const RSQ = String.fromCharCode(0x2019);                    // 曲がったアポストロフィ(番号で作る。engine/README.md の「書くときの注意」)
  const same = (a, b) => String(a).split(RSQ).join("'").toLowerCase() === String(b).split(RSQ).join("'").toLowerCase();
  // ページに描いてある並び(熟語は1かたまり)→ 1語ずつの並びと、熟語の範囲。s をつなぐと、どちらも同じ英文(§7-1)なので、文字の位置で突き合わせる
  //   離れた熟語(工程T-5c。t:'i' に p)は、1つの範囲(初めの語から終わりの語まで)にまとめ、切れ parts と間の語 gaps を持つ。熟語の語のどれを押しても、熟語の板
  function layout(en, words, ti){
    const drawn = Y.tokens.split(en, words), tokens = Y.tokens.split(en, []);
    const at = [];                                            // tokens[k] の、始まりの位置
    let pos = 0;
    tokens.forEach(t => { at.push(pos); pos += String(t.s).length; });
    const range = (a, b) => {                                 // 位置 a〜b に重なる語の、最初と最後(熟語が、語の途中で終わることがある: each other's の each other)
      let from = -1, to = -1;
      tokens.forEach((t, k) => { if (isWord(t) && at[k] < b && at[k] + String(t.s).length > a){ if (from < 0) from = k; to = k; } });
      return from < 0 ? null : { from, to };
    };
    const spans = [], far = new Map();                        // far: 熟語の番号 → 離れた熟語の範囲
    let hit = null;
    pos = 0;
    drawn.forEach((t, k) => {
      const a = pos, b = pos += String(t.s).length;
      if (t.t !== 'w' && t.t !== 'i') return;
      const r = range(a, b);
      if (!r) return;
      if (t.t === 'i' && t.p != null){
        let sp = far.get(t.i);
        if (!sp){ sp = { from: r.from, to: r.to, i: t.i, parts: [], gaps: [] }; far.set(t.i, sp); spans.push(sp); }
        sp.parts.push(r);
        sp.to = r.to;
      } else if (t.t === 'i') spans.push({ from: r.from, to: r.to, i: t.i });
      else if (Number.isInteger(t.g) && far.has(t.g)) far.get(t.g).gaps.push(r);
      if (k === ti) hit = t.t === 'i' && t.p != null ? { far: t.i } : { from: r.from, to: r.to, idiom: t.t === 'i' };
    });
    if (hit && hit.far != null){ const sp = far.get(hit.far); hit = { from: sp.from, to: sp.to, idiom: true }; }
    return hit ? { tokens, spans, from: hit.from, to: hit.to, idiom: hit.idiom } : null;
  }
  // 熟語の字の「...」「…」を、見出しの形「 … 」にそろえる(AI が b を返さなかったときの見出し・本文の形との比べ)
  const DOTS = new RegExp('\\s*(?:[.]{2,}|' + String.fromCharCode(0x2026) + ')\\s*', 'g');
  const dots = s => String(s).replace(DOTS, ' ' + String.fromCharCode(0x2026) + ' ').trim();
  const isOpen = () => !!cur && ui.sheetName() === NAME;
  const act = (kind, sid) => { try { if (Y.watch) Y.watch.act(kind, sid); } catch (e){} };   // 読んだ記録(数だけ。§8-8)
  // その向きの、次の語(空白と記号は飛ばす)。無ければ -1
  function step(i, d){
    for (let k = i + d; k >= 0 && k < cur.tokens.length; k += d) if (isWord(cur.tokens[k])) return k;
    return -1;
  }
  // ---- 範囲ごとに持つもの(cur.r): AI の答え・聞いている最中・単語帳に入っているか。範囲が変わったら、作り直す ----
  function stopAsk(c){
    const r = c && c.r;
    if (r && r.asking){ const a = r.asking; r.asking = null; clearTimeout(a.timer); try { a.ctrl.abort(); } catch (e){} }
  }
  function setRange(text){
    stopAsk(cur);
    hush(cur);
    const mine = cur, r = cur.r = { text, ai: null, aiErr: null, asking: null, head: null, inVocab: null, starring: false, armedAt: 0 };
    // 保存にある答え(通信なし)。同じ文での答えか、別の文で前に聞いた意味
    Promise.resolve().then(() => Y.aidict.peek(text, mine.en)).then(a => {
      if (cur !== mine || mine.r !== r || !a || r.asking || r.ai) return;
      r.ai = { text: String(a.text), same: !!a.same };
      if (isOpen()) paint();
    }, () => {});
  }
  function ask(){
    const mine = cur, r = cur.r;
    if (r.asking) return;
    const a = r.asking = { ctrl: new AbortController(), live: '', timer: 0 };
    // 何も届かないまま、待ちつづけない(cfg.ui.aiWaitMs。届くたびに、数え直す)。答えを待たずに、ここで知らせる(保存や通信が、返ってこないままでも、行き止まりにしない)
    const arm = () => {
      clearTimeout(a.timer);
      a.timer = setTimeout(() => {
        if (r.asking !== a) return;
        r.asking = null; r.aiErr = 'slow';
        try { a.ctrl.abort(); } catch (e){}
        if (cur === mine && mine.r === r && isOpen()){ ui.announce(aiErrText('slow'), true); paint(); }
      }, cfg.ui.aiWaitMs);
    };
    arm();
    r.aiErr = null;
    act('ai', mine.sid);
    ui.announce(ui.t('word.asking'));
    mine.all = false;                                            // 意味を全部ひらいていたら、たたむ(答えが、下へ押し出されて見えなくならないように)
    paint();
    if (liveEl && typeof liveEl.scrollIntoView === 'function'){ try { liveEl.parentNode.scrollIntoView({ block: 'nearest' }); } catch (e){} }
    Promise.resolve().then(() => Y.aidict.ask({ q: r.text, en: mine.en, jp: mine.jp, signal: a.ctrl.signal, onText(t){
      if (r.asking !== a) return;
      a.live += String(t == null ? '' : t);
      arm();
      if (liveEl && liveEl.isConnected) liveEl.textContent = a.live;
    } })).then(out => { if (r.asking === a){ clearTimeout(a.timer); r.asking = null; r.ai = { text: String(out.text), same: true, partial: !!out.partial }; if (cur === mine && isOpen()) ui.announce(r.ai.text); } },   // 途中で切れた答えは、残っていない(聞き直せる)
      e => { if (r.asking === a){ clearTimeout(a.timer); r.asking = null; if (!e || e.kind !== 'abort'){ r.aiErr = (e && e.kind) || 'error'; if (cur === mine && isOpen()) ui.announce(aiErrText(r.aiErr), true); } } })
      .then(() => { if (cur === mine && mine.r === r && isOpen()) paint(); });
  }
  function aiErrText(kind){
    if (kind === 'no-key') return ui.t('note.noKey');
    if (kind === 'limit-day') return ui.t('word.aiLimit');
    if (kind === 'limit-min') return ui.t('note.limitMinSoon');
    if (kind === 'blocked') return ui.t('word.aiBlocked');
    if (kind === 'parse') return ui.t('word.aiEmpty');
    if (kind === 'slow') return ui.t('word.aiSlow', { sec: Math.round(cfg.ui.aiWaitMs / 1000) });
    if (kind === 'overload' || kind === 'server') return ui.t('err.busy');
    return ui.t(Y.msg.has('err.' + kind) ? 'err.' + kind : 'err.other');
  }
  // AI の答えの枠(保存にあった答え・届いている最中・失敗)。何も無ければ null
  function aiPart(){
    const r = cur.r;
    liveEl = null;
    if (r.asking){
      liveEl = ui.el('div', { class: 'ans', text: r.asking.live });
      return ui.el('div', { class: 'ai', 'data-ai': 'asking' }, [ui.el('div', { class: 'cap', text: ui.t('word.asking') }), liveEl]);
    }
    if (!r.ai) return null;
    return ui.el('div', { class: 'ai', 'data-ai': r.ai.same ? 'same' : 'other' }, [
      ui.el('div', { class: 'cap', text: ui.t(r.ai.same ? 'word.aiSame' : 'word.aiOther') }), ui.el('div', { class: 'ans', text: r.ai.text })]);
  }
  // うまくいかなかったことの知らせ(答えや意味と、見分けがつく形: 色と印を変える)
  function alertPart(text, attrs, extra){
    return ui.el('div', Object.assign({ class: 'alert' }, attrs), [ui.icon('alert', 18, 2), ui.el('div', { class: 'msg', text }), extra || null]);
  }
  const aiFailPart = () => (cur.r.aiErr && !cur.r.asking ? alertPart(aiErrText(cur.r.aiErr), { 'data-ai': 'fail' }) : null);

  // ---- 音声(§9-7)。cur.saying = 'word'(発音を聞く)/ 'sent'(この文を聞く)/ null ----
  function hush(c){
    if (c && c.saying){ c.saying = null; speech.stop(); }
  }
  function sayBtn(which, cls, size, text){
    if (!speech.can()) return null;
    const on = cur.saying === which;
    return ui.el('button', { class: cls, 'data-act': 'say-' + which, 'aria-pressed': on ? 'true' : 'false', 'aria-label': ui.t(which === 'word' ? 'word.say' : 'word.saySent'),
      onclick: () => {                                           // タップの流れの中で、待たずに鳴らす(iPhone)
        const mine = cur;
        if (mine.saying === which){ hush(mine); paint(); return; }
        mine.saying = which;                                     // 先に印を付ける(前の発話の「終わった」は、印が違うので何もしない。鳴らすのが、その場で失敗したら、onEnd が印を外す)
        const ok = speech.say(text, { onEnd(){ if (mine.saying === which){ mine.saying = null; if (cur === mine && isOpen()) paint(); } } });
        if (ok) act('say', mine.sid); else if (mine.saying === which) mine.saying = null;
        paint();
      } }, [ui.icon(on ? 'stop' : 'speaker', size, 1.9)]);
  }

  // ---- 単語帳(保存だけ。§8-7)----
  // 単語帳に入れる形。見出しは、熟語なら見出しの形・辞書にあれば辞書の見出し(原形)・無ければ、選んだ文字のまま
  function entry(p){
    const r = cur.r;
    if (p.idiom) return { head: p.idiom.head, kind: 'idiom', mean: p.idiom.mean, meanSrc: p.idiom.mean ? 'idiom' : undefined };
    if (p.hit) return { head: p.hit.head, kind: 'word', mean: Y.dict.format(p.hit.mean).lines.slice(0, cfg.ui.meanLines).join(' / '), meanSrc: 'dict' };
    return { head: p.text, kind: 'word', mean: r.ai ? r.ai.text : '', meanSrc: r.ai ? 'ai' : undefined };
  }
  function checkVocab(head){
    const mine = cur, r = cur.r;
    r.head = head; r.inVocab = null;
    Promise.resolve().then(() => Y.vocab.has(head)).then(v => { if (cur === mine && mine.r === r && r.head === head){ r.inVocab = !!v; if (isOpen()) paint(); } }, () => {});
  }
  function star(p, on){
    const mine = cur, r = cur.r, v = entry(p);
    if (r.starring) return;
    r.starring = true; r.armedAt = 0;
    if (on) act('star', mine.sid);
    Promise.resolve().then(() => (on
      ? Y.vocab.add({ head: v.head, kind: v.kind, mean: v.mean, meanSrc: v.meanSrc, form: p.text, ex: { en: mine.en, jp: mine.jp, page: mine.page, work: mine.work, title: mine.title } })
      : Y.vocab.remove(v.head)))
      .then(() => { if (mine.r === r && r.head === v.head) r.inVocab = on; if (!on) ui.toast(ui.t('word.removed')); },
        () => { ui.toast(ui.t(on ? 'word.addFail' : 'word.removeFail')); })
      .then(() => { r.starring = false; if (cur === mine && mine.r === r && isOpen()) paint(); });
    paint();
  }
  // 「単語帳に入っています」を押した: 1回目は確かめ(ui.twoTapMs の間)、2回目で外す。確かめは cur.r に持つ(描き直しても、消えない)
  const armed = r => !!r.armedAt && Date.now() - r.armedAt < cfg.ui.twoTapMs;
  function unstar(p){
    const mine = cur, r = cur.r;
    if (armed(r)){
      if (Date.now() - r.armedAt < cfg.ui.twoTapMinMs) return;   // 指が弾んだ二度押しは、2回目と数えない
      star(p, false);
      return;
    }
    const at = r.armedAt = Date.now();
    setTimeout(() => { if (r.armedAt === at){ r.armedAt = 0; if (cur === mine && mine.r === r && isOpen()) paint(); } }, cfg.ui.twoTapMs);
    paint();
  }
  // 「この文での意味をAIに聞く」: 意味のすぐ下(答えが出る所)。通信の数は、下に小さく。聞いている間・この文での答えが出ているときは、出さない
  function askPart(){
    const r = cur.r;
    const done = !!(r.ai && r.ai.same && !r.ai.partial);         // この文での答えが、もう出ている(聞き直す口は、無い)。途中で切れた答えは、聞き直せる
    if (done || r.asking) return null;
    const c = ui.cost(1);
    return ui.el('button', { class: 'ask', 'data-act': 'ask', disabled: r.text.length > cfg.aidict.qMax, onclick: ask },
      [ui.icon('dict', 18, 2), ui.el('span', { class: 'two' }, [ui.el('span', { text: ui.t('word.ask') }), c ? ui.el('span', { class: 'cost', text: c }) : null])]);
  }
  // 下の行: 「単語帳に追加」/「単語帳に入っています」(2回タップで外す)。今どちらかは、文言が伝える(押した印は付けない)
  function actsPart(p){
    const r = cur.r, v = entry(p);
    const tooLong = v.head.length > cfg.vocab.headMax;
    let starBtn;
    if (r.inVocab){
      const on = armed(r);
      starBtn = ui.el('button', { class: 'star in', 'data-act': 'star', 'data-armed': on, disabled: !!r.starring, onclick: () => unstar(p) },
        [ui.icon('bookmarkCheck', 20, 2), on ? ui.el('span', { text: ui.t('word.removeArmed') })
          // 入っている間は、押すと外せることを、下に小さく書く(工程5b-2 利用者: 知らなければ、もう一度押そうと思わない)
          : ui.el('span', { class: 'two' }, [ui.el('span', { text: ui.t('word.added') }), ui.el('span', { class: 'sub', text: ui.t('word.addedHint') })])]);
    } else {
      starBtn = ui.el('button', { class: 'star', 'data-act': 'star', disabled: r.inVocab === null || tooLong || !!r.starring, onclick: () => star(p, true) },
        [ui.icon('bookmarkPlus', 20, 2), ui.el('span', { text: ui.t('word.add') })]);
    }
    return ui.el('div', { class: 'acts' }, [starBtn]);
  }

  const loadingText = () => (pct == null ? ui.t('word.loading') : ui.t('word.loadingPct', { pct }));

  function fetchDict(){
    if (Y.dict.ready() || loading) return;
    loading = true; dictErr = null; pct = null;
    ui.announce(ui.t('word.loading'));
    Y.dict.load({ onProgress(got, total){
      pct = total > 0 ? Math.max(0, Math.min(99, Math.floor(got / total * 100))) : null;
      if (stateEl && stateEl.isConnected) stateEl.textContent = loadingText();
    } }).then(() => { loading = false; }, e => { loading = false; dictErr = (e && e.kind) || 'network'; if (isOpen()) ui.announce(dictErrText(), true); })
      .then(() => { if (isOpen()) paint(); });
  }

  // その語が、文の頭か(前に語が無い・前が . ! ? で終わっている)。文の頭の大文字は、小文字の見出しを先に引く(dict.lookup の first)
  const ENDED = /[.!?][^\p{L}\p{N}]*\s[^\p{L}\p{N}]*$/u;
  function atHead(i){
    let gap = '';
    for (let k = i - 1; k >= 0; k--){
      if (cur.tokens[k].t !== 'x') return ENDED.test(gap);
      gap = String(cur.tokens[k].s) + gap;
    }
    return true;
  }
  // 今の範囲 → { text, say, span?, idiom? | hit? }。say = 「発音を聞く」で読む文字(本文の形のまま)
  //   離れた熟語の text は、熟語の語を「 … 」でつないだもの(handed … back)。単語帳の出会った形・AIに聞く語句も、これ。読むのは、間の語もふくめた本文の形(2026-10-17 利用者)
  function pick(){
    const say = Y.tokens.phrase(cur.tokens, cur.from, cur.to);
    const span = cur.spans.find(x => x.from === cur.from && x.to === cur.to);
    if (span){
      const w = cur.words[span.i] || {};
      const text = span.parts ? span.parts.map(pt => Y.tokens.phrase(cur.tokens, pt.from, pt.to)).join(' ' + String.fromCharCode(0x2026) + ' ') : say;
      return { text, say, span, idiom: { head: dots(w.b || w.w || text), mean: String(w.m || '') } };
    }
    return { text: say, say, hit: Y.dict.ready() ? Y.dict.lookup(say, { first: cur.from === cur.to && atHead(cur.from) }) : null };
  }

  const dictErrText = () => ui.t(dictErr === 'network' ? 'word.dictNet' : 'word.dictBad');
  // 辞書の長い1行を、はじめは ui.meanChars 文字までにする(区切り=中黒・コンマ・セミコロンが後ろ半分にあれば、そこで切る)
  const SEPS = [String.fromCharCode(0x30FB), ',', ';'];
  function clip(s, max){
    s = String(s);
    if (s.length <= max) return s;
    let cut = s.slice(0, max);
    const k = Math.max.apply(null, SEPS.map(c => cut.lastIndexOf(c)));
    if (k >= max / 2) cut = cut.slice(0, k);
    return ui.t('clip', { text: cut });
  }
  function meanPart(p){
    stateEl = null;
    if (p.idiom) return ui.el('div', { class: 'mean' }, p.idiom.mean ? [ui.el('div', { class: 'line', text: p.idiom.mean })] : []);
    if (p.hit){
      const lines = Y.dict.format(p.hit.mean).lines, n = cur.all ? lines.length : Math.min(lines.length, cfg.ui.meanLines);
      const shown = lines.slice(0, n).map(s => (cur.all ? s : clip(s, cfg.ui.meanChars)));
      const kids = shown.map(s => ui.el('div', { class: 'line', text: s }));
      const cut = shown.some((s, i) => s !== lines[i]);            // 切った行がある
      if (n < lines.length || cut) kids.push(ui.el('button', { class: 'link', 'data-act': 'more', text: n < lines.length ? ui.t('word.more', { n: lines.length - n }) : ui.t('word.moreCut'), onclick: () => { cur.all = true; paint(); } }));
      return ui.el('div', { class: 'mean' }, kids);
    }
    if (!Y.dict.ready() && loading){
      stateEl = ui.el('div', { class: 'state', 'data-state': 'loading', text: loadingText() });
      return ui.el('div', { class: 'mean' }, [stateEl]);
    }
    if (!Y.dict.ready() && dictErr){
      return alertPart(dictErrText(), { 'data-state': 'fail' },
        ui.el('button', { class: 'link', 'data-act': 'retry', text: ui.t('word.retry'), onclick: () => { fetchDict(); paint(); } }));
    }
    if (cur.r.ai || cur.r.asking) return null;                   // 辞書に無いが、AI の答えがある(§9-4 の順 ③)
    return ui.el('div', { class: 'mean' }, [ui.el('div', { class: 'state', 'data-state': 'none', text: ui.t('word.none') })]);
  }
  // 「easy の最上級」(原形に直して引いたとき)・「もとの形 take a deep breath」(熟語の見出しの形が、本文と違うとき)
  function viaPart(p){
    if (p.idiom){
      if (same(p.idiom.head, dots(p.text))) return null;
      return ui.el('div', { class: 'via' }, [ui.t('word.base') + ' ', ui.el('span', { class: 'en', lang: 'en', text: p.idiom.head })]);
    }
    const via = p.hit && p.hit.via;
    if (!via) return null;
    const key = 'word.kind.' + via.kind;
    return ui.el('div', { class: 'via' }, [ui.el('span', { class: 'en', lang: 'en', text: via.lemma }), ui.t('word.viaTail', { kind: ui.t(Y.msg.has(key) ? key : 'word.kind.other') })]);
  }
  // もとの語(went → go)・同じつづりの語(May と may)
  function alsoParts(p){
    return ((p.hit && p.hit.also) || []).map(a => ui.el('div', { class: 'also' }, [
      ui.el('div', { class: 'cap', text: ui.t(a.head.toLowerCase() === p.hit.head.toLowerCase() ? 'word.alsoCase' : 'word.also') }),
      ui.el('div', { class: 'pair' }, [ui.el('span', { class: 'en', lang: 'en', text: a.head }), ui.el('span', { class: 'm', text: Y.dict.format(a.mean).lines[0] || '' })])
    ]));
  }
  // ひろげたのを、もとの語(はじめに押した所)に戻す(工程5b-2 利用者: ひろげる一方で、戻せなかった)
  function reset(){
    cur.from = cur.from0; cur.to = cur.to0;
    cur.all = false;
    paint();
  }
  function grow(to){
    if (to < 0) return;
    if (to < cur.from) cur.from = to; else cur.to = to;
    cur.all = false;
    act('expand', cur.sid);
    paint();
  }
  function sentPart(p){
    const join = (a, b) => cur.tokens.slice(a, b).map(t => String(t.s)).join('');
    const sp = p.span;
    let mid = [ui.el('span', { class: 'sel', text: join(cur.from, cur.to + 1) })];
    if (sp && sp.parts && cur.from === sp.from && cur.to === sp.to){
      // 離れた熟語: 熟語の語を強調し、間の語(ひと続き)に破線(本文の印と同じ形=案 C)
      mid = [];
      let k = cur.from;
      sp.parts.forEach((pt, n) => {
        const g = n ? sp.gaps.filter(r => r.from > sp.parts[n - 1].to && r.to < pt.from) : [];
        if (g.length){
          mid.push(join(k, g[0].from), ui.el('span', { class: 'gap', text: join(g[0].from, g[g.length - 1].to + 1) }));
          k = g[g.length - 1].to + 1;
        }
        mid.push(join(k, pt.from), ui.el('span', { class: 'sel', text: join(pt.from, pt.to + 1) }));
        k = pt.to + 1;
      });
    }
    return ui.el('div', { class: 'sent' }, [
      ui.el('div', { class: 'txt' }, [
        ui.el('div', { class: 'e', lang: 'en' }, [join(0, cur.from)].concat(mid, [join(cur.to + 1)])),
        ui.el('div', { class: 'j', text: cur.jp })
      ]),
      sayBtn('sent', 'saysent', 20, cur.en)
    ]);
  }

  // 中身を作り直す(範囲が変わった・辞書が届いた)。フォーカスは、同じ役目のボタンへ戻す
  function paint(){
    if (!cur || !body) return;
    const p = pick();
    if (!cur.r || cur.r.text !== p.text) setRange(p.text);
    // 単語帳の見出しは、辞書が届く(か、取れないと分かる)まで決まらない(went → go)。それまでは、調べない・押せない
    const head = !p.idiom && !Y.dict.ready() && !dictErr ? null : entry(p).head;
    if (cur.r.head !== head){ if (head == null){ cur.r.head = null; cur.r.inVocab = null; } else checkVocab(head); }
    if (!p.idiom && !Y.dict.ready() && !loading && !dictErr) fetchDict();
    if (p.hit && cur.counted !== p.text){ cur.counted = p.text; act('dict', cur.sid); }
    const root = ui.root(), had = root && root.activeElement && body.contains(root.activeElement) ? root.activeElement.getAttribute('data-act') : null;
    const prev = step(cur.from, -1), next = step(cur.to, 1);
    const parts = [
      ui.el('div', { class: 'tags' }, [
        p.idiom ? ui.el('span', { class: 'tag', text: ui.t('word.idiom') }) : null,
        p.hit ? ui.el('span', { class: 'src', text: ui.t('word.srcDict') }) : null,
        ui.el('button', { class: 'iconbtn end', 'data-act': 'close', 'data-focus': '', 'aria-label': ui.t('note.close'), onclick: close }, [ui.icon('close', 20, 2)])
      ]),
      ui.el('div', { class: 'headrow' }, [ui.el('div', { class: 'head' + (p.text.length > cfg.ui.headLong ? ' long' : ''), lang: 'en', text: p.text }), sayBtn('word', 'sayword', 22, p.say)]),
      viaPart(p),
      meanPart(p),
      aiPart(),
      aiFailPart(),
      askPart()
    ].concat(alsoParts(p), [
      ui.el('div', { class: 'grow' }, [
        ui.el('button', { class: 'prev', 'data-act': 'prev', disabled: prev < 0, onclick: () => grow(prev) }, [ui.icon('chevL', 18, 2), ui.t('word.prev')]),
        ui.el('button', { class: 'next', 'data-act': 'next', disabled: next < 0, onclick: () => grow(next) }, [ui.t('word.next'), ui.icon('chevR', 18, 2)]),
        cur.from !== cur.from0 || cur.to !== cur.to0 ? ui.el('button', { class: 'reset', 'data-act': 'reset', onclick: reset }, [ui.icon('refresh', 18, 2), ui.t('word.reset')]) : null
      ]),
      sentPart(p),
      actsPart(p)
    ]);
    while (body.firstChild) body.removeChild(body.firstChild);
    parts.forEach(e => { if (e) body.appendChild(e); });
    if (had){
      const b = body.querySelector('[data-act="' + had + '"]:not([disabled])') || body.querySelector('button:not([disabled])');
      if (b){ try { b.focus({ preventScroll: true }); } catch (e){} }
    }
  }

  function close(){ ui.unsheet(NAME); }

  ui.part(NAME, {
    mount(){
      const root = ui.root();
      if (root && root.ownerDocument) speech.attach(root.ownerDocument.defaultView);   // 鳴らすのは、土台のある窓
      // 訳し直しで、板が持つ文の英文が入れかわったら、閉じる(古い英文の語を出したままにしない)
      Y.page.on('sentence', e => { if (isOpen() && e && e.sid === cur.sid && e.en !== cur.en) close(); });
    },
    // h = { sid, ti }(render.hit の戻り。土台が、ページの上のタップから呼ぶ)
    open(h){
      const s = ui.status();
      if (!s || s.state === 'none' || !h) return;
      const d = Y.page.sentence(h.sid);
      if (!d) return;
      const lay = layout(d.en, d.words, h.ti);
      if (!lay) return;
      const mine = cur = Object.assign(d, { tokens: lay.tokens, spans: lay.spans, from: lay.from, to: lay.to, from0: lay.from, to0: lay.to, all: false, counted: null, r: null, saying: null });
      body = ui.el('div', { class: 'word' });
      act(lay.idiom ? 'idiom' : 'tap', d.sid);
      paint();
      ui.sheet(NAME, body, { label: ui.t('word.label'), onClose: () => { stopAsk(mine); hush(mine); if (cur === mine){ cur = null; body = null; stateEl = null; liveEl = null; } } });
    },
    close,
    draw(s){
      if (!isOpen()) return;
      const d = s && s.state !== 'none' ? Y.page.sentence(cur.sid) : null;
      if (!d || d.en !== cur.en) close();
    }
  });
})();

/* ---- ui/settings.js ---- */
// ui/settings.js — 設定の画面(部品の約束 §9-6。キャンバス3ページ目の1段目と、2ページ目の「設定」)
//   画面いっぱいに出す板(Yomu.ui.sheet の full)の中で、行き来する: トップ(行き先の一覧)→ AI につなぐ。
//   目標(§9-3。ある人だけ): 「目標は決めない」(はじめの値)/英検・学校 → 級。学習レベルを変える入口は、ここだけ(Yomu.page.setLevel)。TOEIC・TOEFL は準備中。
//   最初の設定(部品の名前は setup。§9-3): ようこそ → AI につなぐ → 使い方、の3枚。初めて「ブレンド」を押したときに、入口のボタン(ui/dock.js)が出す。
//     どこで閉じても(とばす・Esc・読みはじめる)、済んだ印(settings.profile.setupDone)を付ける。閉じたあと、勝手には訳し始めない(押すまで通信しない)
//   メニューの「設定」と、知らせ「API キーがまだ入っていません」の「設定をひらく」から開く(Yomu.ui.show('settings', { page? }))。
//   API キー: 入れた文字は伏せる(type=password)。保存したキーは、画面に出し直さない(入っているかだけを出す)。文言・記録・読み上げにも出さない。
//   「つながるかを確かめる」は、モデルの一覧を取る通信(回数に数えない=Yomu.llm.models)。結果は、ボタンのすぐ下に出す
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, cfg = Yomu.config, levels = Yomu.levels;
  const NAME = 'settings', SETUP = 'setup';
  const WAY = 'own';               // つなぎ方(今は、自分の API キーだけ。足すときは、ここを一覧にして、Yomu.plan.kind が設定を読む形に=§9-2)

  let page = null;                 // 今出している画面の名前(出していなければ null)
  let gen = 0;                     // 画面を入れかえるたびに進む(前の画面の、待っていた処理の結果を捨てる)

  const close = () => ui.unsheet(NAME);
  const soon = () => ui.toast(ui.t('soon'));
  const provider = () => Y.settings.get().provider;
  const clip = () => ui.root().ownerDocument.defaultView.navigator.clipboard;   // 端末の、写しの置き場(無い端末もある)
  const hasKey = () => Y.settings.secrets.has().catch(() => false);
  function fill(box, kids){
    while (box.firstChild) box.removeChild(box.firstChild);
    kids.forEach(k => { if (k != null) box.appendChild(k); });
  }

  // ---- 画面の型: 上の行(もどる・題・とじる)/中身/下の行(主なボタン。省ける) ----
  //   o = { name, title, back(もどる先の画面の名前。省くと、もどるを出さない), body:[…], foot:[…], step(最初の設定の、何枚目か。0 = ようこそ) }
  //   最初の設定(step がある)では、題の代わりに、進み具合の点。右はしは「とばす」(字のボタン。同じ場所に「とじる」の役)
  function shell(o){
    const setup = o.step != null;
    const back = o.back ? ui.el('button', { class: 'iconbtn start', 'data-act': 'back', 'aria-label': ui.t(setup || o.back !== 'top' ? 'setup.back' : 'set.back'), onclick: () => go(o.back) }, [ui.icon('chevL', 20, 2)]) : null;
    const dots = o.step ? ui.el('div', { class: 'dots', role: 'img', 'aria-label': ui.t('setup.step', { n: o.step }) }, [1, 2].map(i => ui.el('span', { class: i === o.step ? 'now' : i < o.step ? 'past' : '' }))) : null;
    return ui.el('div', { class: 'full' + (setup ? ' setup' : ''), 'data-page': o.name, 'data-title': o.title }, [
      ui.el('div', { class: 'bar' }, setup ? [
        back || ui.el('span', { class: 'gap' }), ui.el('div', { class: 'mid' }, [dots]),
        ui.el('button', { class: 'textbtn', 'data-act': 'close', 'data-focus': '', onclick: () => ui.unsheet(SETUP) }, [ui.t('setup.skip')])
      ] : [
        back,
        ui.el('div', { class: 'heading', text: o.title }),
        ui.el('button', { class: 'iconbtn end', 'data-act': 'close', 'data-focus': '', 'aria-label': ui.t('note.close'), onclick: close }, [ui.icon('close', 20, 2)])
      ]),
      ui.el('div', { class: 'main' }, o.body),
      o.foot ? ui.el('div', { class: 'foot' }, o.foot) : null
    ]);
  }
  // 行き先の行(右に、今の値か「準備中」)。fn を省くと、まだ無い行き先
  function row(item, label, fn){
    const val = ui.el('span', { text: fn ? '' : ui.t('set.soon') });
    const b = ui.el('button', { class: 'rowbtn', 'data-item': item, onclick: fn || soon }, [ui.el('span', { text: label }), ui.el('span', { class: 'val' }, [val, ui.icon('chevR', 18, 2)])]);
    return { b, val };
  }
  const group = (label, rows) => [ui.el('div', { class: 'label', text: label }), ui.el('div', { class: 'rows' }, rows)];

  // ---- トップ(行き先の一覧。まだ無い行き先は、右に「準備中」。翻訳の設定・通信の記録・音声は ui/settings_more.js、記録・書き出しと読み込みは ui/settings_data.js が足す)----
  const to = name => (has(name) ? () => go(name) : undefined);
  function top(){
    const my = gen;
    const connect = row('connect', ui.t('set.connect'), () => go('connect'));
    hasKey().then(has => { if (my === gen) connect.val.textContent = ui.t(has ? 'set.keyIn' : 'set.keyNone'); });
    const goalRow = row('goal', ui.t('set.goal'), () => go('goal'));
    goalRow.val.textContent = goalName(ui.status().level);
    // 右下のボタンを出さないサイト(工程8c-2)。どのサイトでも出す(戻すのは、ここだけ)
    const hideRow = row('hide', ui.t('set.hide'), to('hide'));
    const nHide = Y.settings.get().hide.length;
    if (has('hide')) hideRow.val.textContent = nHide ? ui.t('set.hideN', { n: nHide }) : ui.t('set.hideNone');
    const more = [];
    const voiceRow = row('voice', ui.t('set.voice'), to('voice'));
    if (has('voice')) voiceRow.val.textContent = Y.settings.get().voice.name || ui.t(Y.env && Y.env.info && Y.env.info.ios ? 'set.voiceAuto' : 'set.voiceAuto.pick');   // iPhone は、端末の設定の声。ほかは、こちらが選ぶ(端末に、決める所が無い)
    more.push(voiceRow.b, row('data', ui.t('set.data'), to('data')).b);
    if (Y.plan.shows('runs')) more.push(row('runs', ui.t('set.runs'), to('runs')).b);   // 通信の記録は、いちばん下(ふだんは見ない。調べるときのもの=工程5b-2c)
    const modelsRow = row('models', ui.t('set.models'), to('models'));
    if (has('models') && Y.plan.shows('model')) modelsRow.val.textContent = short(Y.settings.modelFor(ui.status().level).m);
    return shell({ name: 'top', title: ui.t('set.title'), body: [].concat(
      group(ui.t('set.groupAi'), [connect.b, Y.plan.shows('modelChoice') || Y.plan.shows('quota') ? modelsRow.b : null]),
      group(ui.t('set.groupRead'), [goalRow.b, hideRow.b]),
      group(ui.t('set.groupMore'), more)
    ) });
  }

  // ---- AI につなぐ ----
  // 失敗の種類 → 文(§5-5。キーが違うときだけ、この画面の言い方にする)
  function why(e){
    const k = e && e.kind;
    if (k === 'auth') return ui.t('con.bad');
    if (k === 'overload' || k === 'server') return ui.t('err.busy');
    return ui.t(Y.msg.has('err.' + k) ? 'err.' + k : 'err.other');
  }
  // o = { after(つながったあとに呼ぶ。省ける), checkLabel(主なボタンの文言。省くと「つながるかを確かめる」) }
  function connectBody(o){
    o = o || {};
    const my = gen;
    let busy = false, disarm = null;
    const input = ui.el('input', { class: 'text', id: 'y-key', type: 'password', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'data-act': 'key',
      onkeydown: e => { if (e.key === 'Enter') check(); } });
    const has = ui.el('div', { class: 'has', hidden: true }, [ui.icon('check', 18, 2.6), ui.el('span', { text: ui.t('con.has') })]);
    const result = ui.el('div', { class: 'result', 'data-result': '', hidden: true });
    const checkBtn = ui.el('button', { class: 'primary', 'data-act': 'check', onclick: () => check() }, [ui.el('span', { text: o.checkLabel || ui.t('con.check') }), o.after ? ui.icon('arrowR', 18, 2) : null]);
    const dropLabel = ui.el('span', { text: ui.t('con.drop') });
    const dropBtn = ui.el('button', { class: 'textbtn', 'data-act': 'drop', hidden: true }, [dropLabel]);
    disarm = ui.twoTap(dropBtn, { label: dropLabel, armed: ui.t('con.dropArmed'), fn: () => drop() });
    const canPaste = !!(clip() && clip().readText);
    const paste = canPaste ? ui.el('button', { class: 'side', 'data-act': 'paste', onclick: () => {
      clip().readText().then(t => { if (my === gen && t) input.value = String(t).trim(); }, () => ui.toast(ui.t('con.pasteFail')));
    } }, [ui.t('con.paste')]) : null;

    // 結果を出す(ボタンのすぐ下)。kind = 'ok'|'wait'|'fail'。読み上げにも、1回伝える
    function show(kind, text){
      result.hidden = false;
      result.setAttribute('data-result', kind);
      fill(result, [kind === 'ok' ? ui.el('div', { class: 'okline' }, [ui.icon('check', 18, 2.6), ui.el('span', { text })])
        : kind === 'wait' ? ui.el('div', { class: 'state', text })
        : ui.el('div', { class: 'alert' }, [ui.icon('alert', 18, 2), ui.el('span', { text })])]);
      ui.announce(text, kind === 'fail');
    }
    function sync(){
      return hasKey().then(k => { if (my !== gen) return k; has.hidden = !k; dropBtn.hidden = !k; return k; });
    }
    function lock(on){ busy = on; checkBtn.disabled = on; dropBtn.disabled = on; }

    // つながるかを確かめる: 貼ったキーがあれば、先に保存する。キーが違う(auth)と分かったら、前のキーに戻す(貼った字は、欄に残す)
    async function check(){
      if (busy) return;
      const typed = input.value.trim();
      const secrets = Y.settings.secrets, id = provider();
      lock(true);
      let before = '';
      try {
        before = await secrets.key(id).catch(() => null);
        if (my !== gen) return;
        if (before == null){ show('fail', ui.t('err.other')); return; }   // 今のキーを読めなかった: 何も書かない(使えていたキーを、空で消さない)
        if (!typed && !before){ show('fail', ui.t('con.empty')); return; }
        show('wait', ui.t('con.checking'));
        if (typed) await secrets.set({ providers: { [id]: { apiKey: typed } } });
        try {
          await Y.llm.models({ provider: id });
        } catch (e){
          // 前のキーに戻すのは、保存が、まだ今貼ったキーのままのときだけ(待っている間に、入れ直した・消したキーを、書き戻さない)
          if (e && e.kind === 'auth' && typed && (await secrets.key(id).catch(() => null)) === typed) await secrets.set({ providers: { [id]: { apiKey: before } } }).catch(() => {});
          if (my !== gen) return;
          const saved = typed && !(e && e.kind === 'auth');             // つながらない・混み合っている など: キーは保存してある
          if (saved) input.value = '';
          show('fail', saved ? ui.t('con.unchecked', { why: why(e) }) : why(e));
          return;
        }
        if (my !== gen) return;
        input.value = '';
        show('ok', ui.t('con.ok'));
        const s = Y.page.status();
        if (s.notice && s.notice.kind === 'no-key') Y.page.dismiss();   // 「API キーがまだ入っていません」の知らせは、もう要らない
        if (o.after) o.after();
      } catch (e){
        if (my === gen) show('fail', ui.t('err.other'));
      } finally {
        if (my === gen){ lock(false); await sync(); }
      }
    }
    // キーを消す(2回タップ。空の値で上書きする=§11-3)
    async function drop(){
      if (busy) return;
      lock(true);
      try {
        await Y.settings.secrets.set({ providers: { [provider()]: { apiKey: '' } } });
        if (my !== gen) return;
        input.value = '';
        result.hidden = true;
        ui.toast(ui.t('con.dropped'));
      } catch (e){
        if (my === gen) show('fail', ui.t('err.other'));
      } finally {
        if (my === gen){ lock(false); await sync(); }
      }
    }
    sync();

    return { stop: () => { if (disarm) disarm(); }, kids: [
      ui.el('p', { class: 'lead', text: ui.t('con.lead') }),
      ui.el('div', { class: 'rows', 'data-box': 'way' }, [
        ui.el('div', { class: 'rowstat' }, [ui.el('span', { text: ui.t('con.way') }), ui.el('span', { class: 'val', 'data-way': WAY, text: ui.t('con.way.' + WAY) })]),
        ui.el('div', { class: 'steps' }, [1, 2, 3].map(n => ui.el('div', { class: 'step' }, [ui.el('span', { class: 'num', 'aria-hidden': 'true', text: String(n) }), ui.el('span', { text: ui.t('con.step' + n) })]))
          .concat([ui.el('a', { class: 'link', href: cfg.links.geminiKey, target: '_blank', rel: 'noopener noreferrer', 'data-act': 'open' }, [ui.el('span', { text: ui.t('con.open') }), ui.icon('out', 18, 2)])]))
      ]),
      ui.el('div', { class: 'field' }, [
        ui.el('label', { for: 'y-key', text: ui.t('con.key') }),
        ui.el('div', { class: 'keyrow' }, [input, paste]),
        has
      ]),
      checkBtn,
      result,
      ui.el('p', { class: 'hint', text: ui.t('con.checkNote') + (Y.plan.shows('quota') ? ui.t('con.checkFree') : '') + ui.t('con.local') }),
      dropBtn
    ] };
  }
  // ---- 目標(キャンバス3ページ目の「設定 › 目標」)----
  const GRADES = levels.ids.filter(id => id !== levels.initial);       // 英検の級(a1〜b2)。通常(std)= 目標は決めない
  const goalName = id => (id === levels.initial || !levels.has(id) ? ui.t('set.goalNone') : levels.name(id));
  // モデルの呼び名(設定の中では、版の数字を先に添える=「3.5 Flash-Lite」。Google の呼び名と同じ並び。知らせの行 ui/notice.js は、短い名前のまま)
  const short = m => {
    const x = String(m || '');
    const k = /flash-lite/i.test(x) ? 'Flash-Lite' : /flash/i.test(x) ? 'Flash' : /pro/i.test(x) ? 'Pro' : '';
    if (!k) return x;
    const v = /(?:^|-)(\d+(?:\.\d+)?)-/.exec(x);
    return v ? v[1] + ' ' + k : k;
  };
  // 選ぶ札(丸い印つき。選んだ印は、色のほかに、チェックでも)。o = { id, title, sub, soon(まだ選べない), tags([{ text, now }]。名前の横の小さな札=「はじめの設定」「今の設定」) }
  function opt(o, onPick){
    const ttl = ui.el('span', { class: 'ttl', text: o.title }), tags = (o.tags || []).filter(Boolean);
    const b = ui.el('button', { class: 'opt', 'data-opt': o.id, 'aria-pressed': o.soon ? null : 'false', 'data-soon': o.soon ? '' : null, onclick: () => (o.soon ? soon() : onPick(o.id)) }, [
      ui.el('span', { class: 'two' }, [tags.length ? ui.el('span', { class: 'head' }, [ttl].concat(tags.map(g => ui.el('span', { class: 'tag' + (g.now ? ' now' : ''), text: g.text })))) : ttl, o.sub ? ui.el('span', { class: 'sub', text: o.sub }) : null]),
      o.soon ? ui.el('span', { class: 'soon', text: ui.t('set.soon') }) : ui.el('span', { class: 'radio', 'aria-hidden': 'true' }, [ui.icon('check', 14, 2.6)])
    ]);
    return b;
  }
  const press = (list, id) => list.forEach(b => { if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', b.getAttribute('data-opt') === id ? 'true' : 'false'); });
  // 学習レベルを変える(進行役に頼む。訳している間は、変えられない)→ 変わったら、目的と目標を設定に残して、トップへ
  async function applyLevel(id, result, btn){
    const my = gen;
    btn.disabled = true;
    try {
      const s = await Y.page.setLevel(id).catch(() => null);
      if (my !== gen) return;
      if (!s || s.level !== id){ fill(result, [ui.el('div', { class: 'alert' }, [ui.icon('alert', 18, 2), ui.el('span', { text: ui.t('goal.busy') })])]); result.hidden = false; ui.announce(ui.t('goal.busy'), true); return; }
      const none = id === levels.initial;
      await Y.settings.set({ profile: { purpose: none ? 'none' : 'eiken', goal: none ? null : { kind: 'eiken', value: id } } }).catch(() => {});
      if (my !== gen) return;
      ui.toast(none ? ui.t('goal.setNone') : ui.t('goal.set', { name: levels.name(id) }));
      go('top');
    } finally { if (my === gen) btn.disabled = false; }
  }
  function goal(){
    const now = ui.status().level;
    let pick = now === levels.initial || !levels.has(now) ? 'none' : 'eiken';
    const label = ui.el('span'), arrow = ui.icon('arrowR', 18, 2);
    const result = ui.el('div', { class: 'result', hidden: true });
    const apply = ui.el('button', { class: 'primary', 'data-act': 'apply', onclick: () => (pick === 'eiken' ? go('grade') : applyLevel(levels.initial, result, apply)) }, [label, arrow]);
    const list = [];
    const sync = () => { press(list, pick); label.textContent = ui.t(pick === 'eiken' ? 'goal.toGrade' : 'goal.pick'); if (pick === 'eiken') arrow.removeAttribute('hidden'); else arrow.setAttribute('hidden', ''); };
    const on = id => { pick = id; sync(); };
    list.push(opt({ id: 'none', title: ui.t('goal.none'), sub: ui.t('goal.noneSub') }, on),
      opt({ id: 'eiken', title: ui.t('goal.eiken'), sub: pick === 'eiken' ? ui.t('goal.now', { name: levels.name(now) }) : ui.t('goal.eikenSub') }, on),
      opt({ id: 'toeic', title: ui.t('goal.toeic'), sub: ui.t('goal.toeicSub'), soon: true }),
      opt({ id: 'toefl', title: ui.t('goal.toefl'), sub: ui.t('goal.toeflSub'), soon: true }));
    sync();
    return shell({ name: 'goal', title: ui.t('set.goal'), back: 'top', body: [
      ui.el('h1', { class: 'h1', text: ui.t('goal.h1') }),
      ui.el('p', { class: 'lead', text: ui.t('goal.lead') }),
      ui.el('div', { class: 'opts' }, [list[0]]),
      ui.el('div', { class: 'label', text: ui.t('goal.some') }),
      ui.el('div', { class: 'opts' }, list.slice(1)),
      result
    ], foot: [apply] });
  }
  function grade(){
    const now = ui.status().level;
    let pick = GRADES.indexOf(now) >= 0 ? now : null;
    const result = ui.el('div', { class: 'result', hidden: true });
    const info = ui.el('div', { class: 'rows', 'data-box': 'gives' });
    const infoLabel = ui.el('div', { class: 'label', text: ui.t('goal.gives') });
    const apply = ui.el('button', { class: 'primary', 'data-act': 'apply', onclick: () => { if (pick) applyLevel(pick, result, apply); } }, [ui.el('span', { text: ui.t('goal.pick') })]);
    const line = (cap, val) => ui.el('div', { class: 'info' }, [ui.el('span', { class: 'cap', text: cap }), ui.el('span', { class: 'v', text: val })]);
    const list = [];
    // この目標で用意するもの(英文のむずかしさ。訳す AI と、1日の目安は、自分のキーで使うときだけ=Yomu.plan)
    function sync(){
      press(list, pick);
      apply.disabled = !pick;
      infoLabel.hidden = info.hidden = !pick;
      if (!pick) return;
      const m = Y.settings.modelFor(pick).m, lim = Y.settings.get().limits[m];
      fill(info, [line(ui.t('goal.diff'), ui.t('goal.diffVal', { name: levels.name(pick) })),
        Y.plan.shows('model') ? line(ui.t('goal.ai'), Y.plan.shows('quota') && lim != null ? ui.t('goal.aiLimit', { model: short(m), n: lim }) : short(m)) : null]);
    }
    GRADES.forEach(id => list.push(opt({ id, title: levels.name(id), sub: ui.t('goal.grade.' + id) }, x => { pick = x; sync(); })));
    sync();
    return shell({ name: 'grade', title: ui.t('set.goal'), back: 'goal', body: [
      ui.el('h1', { class: 'h1', text: ui.t('goal.h2') }),
      ui.el('p', { class: 'lead', text: ui.t('goal.lead2') }),
      ui.el('div', { class: 'opts' }, list),
      infoLabel, info, result
    ], foot: [apply] });
  }

  let stopPage = null;             // 今の画面の、待っている確かめ(2回タップ)をやめる関数
  function connect(){
    const c = connectBody();
    stopPage = c.stop;
    return shell({ name: 'connect', title: ui.t('set.connect'), back: 'top', body: c.kids });
  }

  // ---- 最初の設定(3枚。キャンバス3ページ目の1段目)----
  const next = (label, fn, act) => ui.el('button', { class: 'primary', 'data-act': act, onclick: fn }, [ui.el('span', { text: label }), ui.icon('arrowR', 18, 2)]);
  function welcome(){
    return shell({ name: 'welcome', title: ui.t('setup.label'), step: 0, body: [
      ui.el('div', { class: 'hero' }, [ui.mark(64), ui.el('div', { class: 'app', text: Y.msg.app() })]),
      ui.el('h1', { class: 'h1 center' }, [ui.el('span', { text: ui.t('setup.hero1') }), ui.el('span', { text: ui.t('setup.hero2') })]),
      ui.el('div', { class: 'demo', 'aria-hidden': 'true' }, [ui.t('setup.demoA'), ui.el('span', { class: 'en', lang: 'en', text: ui.t('setup.demoEn') }), ui.t('setup.demoB')]),
      ui.el('p', { class: 'lead center', text: ui.t('setup.welcomeNote') })
    ], foot: [next(ui.t('setup.start'), () => go('link'), 'next')] });
  }
  function link(){
    const c = connectBody({ checkLabel: ui.t('setup.checkNext'), after: () => { ui.toast(ui.t('con.ok')); go('howto'); } });
    stopPage = c.stop;
    return shell({ name: 'link', title: ui.t('set.connect'), step: 1, back: 'welcome', body: [ui.el('h1', { class: 'h1', text: ui.t('set.connect') })].concat(c.kids,
      [ui.el('button', { class: 'textbtn', 'data-act': 'later', onclick: () => go('howto') }, [ui.t('setup.later')])]) });
  }
  function howto(){
    const pics = [
      [ui.el('span', { class: 'name', text: ui.t('dock.blend') })],          // 入口の台の「ブレンド」(字だけ。ロゴは、メニュー=4つ目)
      [ui.el('span', { class: 'track' }, [ui.el('span', { class: 'dot' })])],
      [ui.el('span', { class: 'chip', text: ui.t('setup.chip') })],
      [ui.el('span', { class: 'logo' }, [ui.mark(24)])]
    ];
    return shell({ name: 'howto', title: ui.t('setup.howTitle'), step: 2, back: 'link', body: [
      ui.el('h1', { class: 'h1', text: ui.t('setup.howTitle') }),
      ui.el('div', { class: 'hows' }, pics.map((pic, i) => ui.el('div', { class: 'how' }, [
        ui.el('div', { class: 'pic', 'aria-hidden': 'true' }, pic),
        ui.el('div', { class: 'txt' }, [ui.el('div', { class: 'ttl', text: ui.t('setup.how' + (i + 1)) }), ui.el('div', { class: 'sub', text: ui.t('setup.how' + (i + 1) + 'd') })])
      ]))),
      ui.el('p', { class: 'hint', text: ui.t('setup.howNote') })
    ], foot: [next(ui.t('setup.go'), () => ui.unsheet(SETUP), 'done')] });
  }
  const SETUP_PAGES = ['welcome', 'link', 'howto'];
  // 最初の設定が済んだ印(どこで閉じても付ける。次に「ブレンド」を押したときは、出さない)
  const markDone = () => { Y.settings.set({ profile: { setupDone: true } }).catch(() => {}); };

  const PAGES = { top, connect, goal, grade, welcome, link, howto };
  const has = name => Object.prototype.hasOwnProperty.call(PAGES, name);
  // 画面を出す・入れかえる(同じ板の中で。土台が、フォーカスを「とじる」へ移し、いちばん上へ送る)
  function go(name, arg){
    if (!has(name)) name = 'top';
    if (stopPage){ stopPage(); stopPage = null; }
    gen++;
    page = name;
    const body = PAGES[name](arg);
    const setup = SETUP_PAGES.indexOf(name) >= 0;
    ui.sheet(setup ? SETUP : NAME, body, { label: body.getAttribute('data-title'), full: true, onClose: () => { gen++; page = null; if (stopPage){ stopPage(); stopPage = null; } if (setup) markDone(); } });
  }

  // ほかのファイル(ui/settings_more.js)が、画面を足すための口(§9-6)。add(名前, 画面を作る関数)。alive() = 今の画面が、まだ出ているかを見る関数を返す(待つ処理のあとで聞く)
  Yomu.uiSettings = {
    add(name, fn){ PAGES[name] = fn; }, go, shell, row, group, opt, press, fill, short, goalName, why,
    alive(){ const my = gen; return () => my === gen; },
    onLeave(fn){ stopPage = fn; }
  };

  ui.part(NAME, {
    open(params){
      const s = ui.status();
      if (!s || s.state === 'none') return;
      go((params && params.page) || 'top');
    },
    close,
    page: () => page
  });
  // 最初の設定(初めて「ブレンド」を押したとき。ui/dock.js が呼ぶ)
  ui.part(SETUP, {
    open(){
      const s = ui.status();
      if (!s || s.state === 'none') return;
      go('welcome');
    },
    close: () => ui.unsheet(SETUP)
  });
})();

/* ---- ui/settings_more.js ---- */
// ui/settings_more.js — 設定の画面の続き(部品の約束 §9-6。工程4c-2a): 翻訳の設定・訳す AI(目標ごと)・通信の記録・音声
//   画面の型と部品は ui/settings.js のもの(Yomu.uiSettings)を使う。ここは、画面を足すだけ(add)。
//   翻訳の設定: 今日つかった回数(AI ごと。1日の目安は、利用者が直す数=達しても止めない)・訳す AI と考える深さ(目標ごと)・上限に達したとき。
//     考える深さは、config.ui.thinkPick が true のときだけ出す(今は出さない=訳はいつも思考なし。工程T-2c)
//     訳す AI・考える深さ・上限に達したとき、は、選んで「これにする」(回数と訳に効くので、押して決める。工程5b-2c)。声・速さは、選ぶと、すぐ保存して、短い知らせ「保存しました」
//     出す前に、つなぎ方に聞く(Yomu.plan.shows('quota'|'modelChoice'|'model'|'runs')。自分の API キーで使うときだけ見せる=設計メモ 2-2)
//   「AI の一覧を取る」は、回数に数えない通信(Yomu.llm.models)。結果は、ボタンのすぐ下
//   通信の記録: 新しい順。数字をそのまま出すだけで、評価の言葉は付けない。AI辞書の通信は、もともと残っていない(§8-6)
//   音声: 声(はじめは、端末に合わせる)・速さ・試しに聞く・より自然な声の入れ方(端末ごとに差しかえる。確かめていない端末には、出さない)
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, cfg = Yomu.config, levels = Yomu.levels, S = Yomu.uiSettings;
  const win = () => ui.root().ownerDocument.defaultView;

  const alertBox = text => ui.el('div', { class: 'alert' }, [ui.icon('alert', 18, 2), ui.el('span', { text })]);
  const okLine = text => ui.el('div', { class: 'okline' }, [ui.icon('check', 18, 2.6), ui.el('span', { text })]);
  const levelName = id => (id === levels.initial ? ui.t('mod.std') : levels.name(id));
  const thinkName = k => ui.t('mod.think.' + k);
  const thinkPick = () => !!cfg.ui.thinkPick;
  // 訳す AI の呼び名(考える深さを選ぶ所を出しているときだけ、深さも添える)
  const aiName = ai => (thinkPick() ? ui.t('mod.pair', { model: S.short(ai.m), think: thinkName(ai.think) }) : S.short(ai.m));
  // 選ぶ札を並べて、押したら fn(id)。戻りは { box, set(id) }
  function choice(list, now, fn){
    const btns = list.map(o => S.opt(o, id => { S.press(btns, id); fn(id); }));
    S.press(btns, now);
    return { box: ui.el('div', { class: 'opts' }, btns), set: id => S.press(btns, id) };
  }
  const save = patch => Y.settings.set(patch).then(() => true, () => { ui.toast(ui.t('set.saveFail')); return false; });
  const saved = ok => { if (ok) ui.toast(ui.t('set.saved')); return ok; };   // 選ぶと、すぐ保存する所: 保存できたら、短い知らせ

  // ---- 翻訳の設定 ----
  function models(){
    const alive = S.alive();
    const body = [ui.el('p', { class: 'lead', text: ui.t('mod.lead') })];

    if (Y.plan.shows('quota')){
      const box = ui.el('div', { class: 'rows', 'data-box': 'quota' }, [ui.el('div', { class: 'info' }, [ui.el('span', { class: 'cap', text: ui.t('mod.loading') })])]);
      const note = ui.el('div', { class: 'result', hidden: true });
      body.push(ui.el('div', { class: 'label', text: ui.t('mod.today') }), box, note, ui.el('p', { class: 'hint', text: ui.t('mod.todayNote') }));
      Y.quota.today().then(day => {
        if (!alive()) return;
        const ids = Object.keys(day).sort();
        S.fill(box, ids.length ? ids.map((m, i) => {
          const d = day[m], id = 'y-lim-' + i;
          const input = ui.el('input', { class: 'text num', id, type: 'text', inputmode: 'numeric', autocomplete: 'off', 'data-limit': m, value: d.limit == null ? '' : String(d.limit) });
          let last = input.value;
          const commit = () => {
            const raw = input.value.trim();
            if (raw === last) return;
            if (raw !== '' && !/^\d{1,5}$/.test(raw)){ S.fill(note, [alertBox(ui.t('mod.limitBad'))]); note.hidden = false; ui.announce(ui.t('mod.limitBad'), true); return; }
            note.hidden = true;
            save({ limits: { [m]: raw === '' ? undefined : Number(raw) } }).then(ok => (ok ? Y.settings.load().then(now => {
              const v = now.limits[m];
              last = v == null ? '' : String(v);
              if (alive()) input.value = last;
              ui.toast(raw === '' && v != null ? ui.t('mod.limitReset', { n: v }) : ui.t('mod.limitSaved'));
            }, () => {}) : null));
          };
          input.addEventListener('change', commit);
          input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
          return ui.el('div', { class: 'quota', 'data-model': m }, [
            ui.el('div', { class: 'head' }, [ui.el('span', { class: 'name', text: S.short(m) }), ui.el('span', { class: 'used', text: ui.t('mod.used', { n: d.used }) })]),
            ui.el('div', { class: 'mid', text: m }),
            d.hitDay ? ui.el('div', { class: 'hit' }, [ui.icon('alert', 18, 2), ui.el('span', { text: ui.t('mod.hit') })]) : null,
            ui.el('div', { class: 'lim' }, [ui.el('label', { for: id, text: ui.t('mod.limit') }), input, ui.el('span', { class: 'unit', text: ui.t('mod.times') })])
          ]);
        }) : [ui.el('div', { class: 'info' }, [ui.el('span', { class: 'cap', text: ui.t('mod.none') })])]);
      }, () => { if (alive()) S.fill(box, [alertBox(ui.t('err.other'))]); });
    }

    if (Y.plan.shows('modelChoice')){
      const now = ui.status().level, st = Y.settings.get();
      body.push(ui.el('div', { class: 'label', text: ui.t('mod.perLevel') }),
        ui.el('div', { class: 'rows', 'data-box': 'levels' }, levels.ids.map(id => {
          const r = S.row('level-' + id, levelName(id) + (id === now ? ui.t('mod.nowMark') : ''), () => S.go('model', id));
          const ai = Y.settings.modelFor(id);
          r.val.textContent = aiName(ai);
          return r.b;
        })),
        ui.el('p', { class: 'hint', text: ui.t('mod.perLevelNote') }),
        ui.el('div', { class: 'label', text: ui.t('mod.onLimit') }),
        ui.el('div', { class: 'rows', 'data-box': 'onlimit' }, [S.row('onlimit', ui.t('mod.onLimit.' + st.onLimit), () => S.go('onlimit')).b]));
    }
    return S.shell({ name: 'models', title: ui.t('set.models'), back: 'top', body });
  }

  // ---- 1日の上限に達したとき(選んで「これにする」。回数に効くので、押して決める=§9-6)----
  function onLimit(){
    const alive = S.alive();
    let pick = Y.settings.get().onLimit;
    const c = choice([{ id: 'ask', title: ui.t('mod.onLimit.ask'), sub: ui.t('mod.onLimit.askSub') }, { id: 'lite', title: ui.t('mod.onLimit.lite'), sub: ui.t('mod.onLimit.liteSub') }], pick, id => { pick = id; });
    const apply = ui.el('button', { class: 'primary', 'data-act': 'apply', onclick: () => {
      apply.disabled = true;
      save({ onLimit: pick }).then(ok => {
        if (!alive()) return;
        apply.disabled = false;
        if (ok){ ui.toast(ui.t('mod.onLimit.set', { name: ui.t('mod.onLimit.' + pick) })); S.go('models'); }
      });
    } }, [ui.el('span', { text: ui.t('mod.pick') })]);
    return S.shell({ name: 'onlimit', title: ui.t('mod.onLimit'), back: 'models', body: [ui.el('p', { class: 'lead', text: ui.t('mod.onLimit.lead') }), c.box], foot: [apply] });
  }

  // ---- 訳す AI(目標ごと)。選んで「これにする」(押すまで、変えない。「目標」と同じ決め方=§9-6)----
  function model(level){
    if (!levels.has(level)) level = levels.initial;
    const alive = S.alive();
    const st = Y.settings.get(), cur = Y.settings.modelFor(level), def = levels.defaults.models[level];
    let fetched = null;            // 取ってきた AI の一覧(この画面が出ている間だけ持つ。保存しない。開き直したら、たたまれる)
    let pickM = cur.m, pickT = cur.think, savedM = cur.m, savedT = cur.think;
    // 名前の横の小さな札: はじめの設定・今の設定(保存してあるもの。選んだ印=これから決めるもの、とは別)
    const tagsOf = (isDef, isNow) => [isDef ? { text: ui.t('mod.first') } : null, isNow ? { text: ui.t('mod.now'), now: true } : null];
    const hide = new RegExp(cfg.ui.modelHide, 'i');
    const old = id => { const v = /(?:^|-)(\d+(?:\.\d+)?)-/.exec(id); return !!v && Number(v[1]) < cfg.ui.modelMinVer; };   // 古い世代(版の数字が小さいもの)
    // いつも並べる AI: はじめの設定・今つかっているもの(ほかの目標・熟語さがし など)
    const base = [];
    const add = m => { if (m && base.indexOf(m) < 0) base.push(m); };
    add(def.m); add(cur.m);
    levels.ids.forEach(id => add(Y.settings.modelFor(id).m));
    Object.keys(st.aux || {}).forEach(k => add(st.aux[k]));
    Object.keys(st.limits || {}).forEach(add);
    const aiBox = ui.el('div', { 'data-box': 'ai' });
    let aiBtns = [];
    function drawAi(){
      const mk = (m, title) => S.opt({ id: m, title, sub: m, tags: tagsOf(m === def.m, m === savedM) }, id => { pickM = id; S.press(aiBtns, id); });
      const top = base.map(m => mk(m, S.short(m)));
      const more = (fetched || []).filter(x => base.indexOf(x.id) < 0).map(x => mk(x.id, x.name && x.name !== x.id ? String(x.name).replace(/^Gemini\s+/i, '') : S.short(x.id)));   // Google の呼び名から、頭の「Gemini」を外す(上の札の「3.5 Flash」と、そろえる)
      aiBtns = top.concat(more);
      S.press(aiBtns, pickM);
      S.fill(aiBox, [ui.el('div', { class: 'opts' }, top),
        more.length ? ui.el('div', { class: 'label sub', text: ui.t('mod.fetched') }) : null,
        more.length ? ui.el('div', { class: 'opts', 'data-box': 'fetched' }, more) : null]);
    }
    drawAi();
    const result = ui.el('div', { class: 'result', hidden: true });
    const listBtn = ui.el('button', { class: 'side wide', 'data-act': 'list', onclick: () => {
      listBtn.disabled = true;
      S.fill(result, [ui.el('div', { class: 'state', text: ui.t('mod.listing') })]); result.hidden = false;
      Y.llm.models({ provider: st.provider }).then(list => {
        if (!alive()) return;
        fetched = (Array.isArray(list) ? list : []).filter(x => x && x.id && x.canGenerate !== false && /^gemini/i.test(x.id) && !hide.test(x.id) && !old(x.id) && levels.current(x.id) === x.id);   // Google が、ほかの名前へ回している AI(levels.moved)は、並べない
        drawAi();
        const text = ui.t('mod.listed', { n: fetched.length });
        S.fill(result, [okLine(text)]); ui.announce(text);
      }, e => {
        if (!alive()) return;
        const text = e && e.kind === 'no-key' ? ui.t('mod.listNoKey') : S.why(e);
        S.fill(result, [alertBox(text)]); ui.announce(text, true);
      }).then(() => { if (alive()) listBtn.disabled = false; });
    } }, [ui.el('span', { class: 'two' }, [ui.el('span', { text: ui.t('mod.list') }), ui.el('span', { class: 'cost', text: ui.t('mod.listFree') })])]);
    const thinkBox = ui.el('div', { 'data-box': 'think' });
    const drawThink = () => thinkPick() && S.fill(thinkBox, [choice(levels.thinkPicks.map(k => ({ id: k, title: thinkName(k), sub: ui.t('mod.thinkSub.' + k), tags: tagsOf(k === def.think, k === savedT) })), pickT, k => { pickT = k; }).box]);
    drawThink();
    // はじめの設定に戻す: 押したら、すぐ保存する(押して決めるボタン。選ぶ札とは違う)
    const reset = ui.el('button', { class: 'textbtn', 'data-act': 'reset', onclick: () => {
      save({ models: { [level]: { m: def.m, think: def.think } } }).then(ok => { if (ok && alive()){ pickM = savedM = def.m; pickT = savedT = def.think; drawAi(); drawThink(); ui.toast(ui.t('mod.resetDone')); } });
    } }, [thinkPick() ? ui.t('mod.reset', { model: S.short(def.m), think: thinkName(def.think) }) : ui.t('mod.resetM', { model: S.short(def.m) })]);
    const apply = ui.el('button', { class: 'primary', 'data-act': 'apply', onclick: () => {
      apply.disabled = true;
      save({ models: { [level]: { m: pickM, think: pickT } } }).then(ok => {
        if (!alive()) return;
        apply.disabled = false;
        if (ok){ ui.toast(thinkPick() ? ui.t('mod.set', { level: levelName(level), model: S.short(pickM), think: thinkName(pickT) }) : ui.t('mod.setM', { level: levelName(level), model: S.short(pickM) })); S.go('models'); }
      });
    } }, [ui.el('span', { text: ui.t('mod.pick') })]);
    return S.shell({ name: 'model', title: ui.t('mod.title'), back: 'models', body: [
      ui.el('h1', { class: 'h1', text: levelName(level) }),
      ui.el('div', { class: 'label', text: ui.t('mod.ai') }), aiBox, listBtn, result,
      thinkPick() ? ui.el('div', { class: 'label', text: ui.t('mod.think') }) : null, thinkPick() ? thinkBox : null,
      reset
    ], foot: [apply] });
  }

  // ---- 通信の記録 ----
  const p2 = n => (n < 10 ? '0' : '') + n;
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  const sentOf = r => (r.rep && r.rep.sent) || (r.sent && r.sent.targets) || 0;
  const gotOf = r => (r.rep && r.rep.got) || 0;
  function sum(list, from){
    const xs = list.filter(r => r.role === 'translate' && new Date(r.at).getTime() >= from);
    const sent = xs.reduce((a, r) => a + sentOf(r), 0), got = xs.reduce((a, r) => a + gotOf(r), 0);
    return { n: xs.length, sent, got, pct: sent > 0 ? Math.round(got / sent * 1000) / 10 : null };
  }
  function runs(){
    const alive = S.alive();
    const step = cfg.ui.runsPage || 20;
    const sumBox = ui.el('div', { class: 'rows', 'data-box': 'sum' });
    const listBox = ui.el('div', { class: 'rows', 'data-box': 'runs' }, [ui.el('div', { class: 'info' }, [ui.el('span', { class: 'cap', text: ui.t('mod.loading') })])]);
    const moreBtn = ui.el('button', { class: 'side wide', 'data-act': 'more', hidden: true }, [ui.t('runs.more')]);
    let all = [], shown = 0;
    const sumLine = (cap, s) => ui.el('div', { class: 'info' }, [ui.el('span', { class: 'cap', text: cap }),
      ui.el('span', { class: 'v', text: s.n ? ui.t('runs.sum', { got: s.got, sent: s.sent, pct: s.pct == null ? '—' : s.pct, n: s.n }) : ui.t('runs.sumNone') })]);
    function item(r){
      const secs = Math.round((r.ms || 0) / 100) / 10;
      const tr = r.role === 'translate';
      const sent = sentOf(r), got = gotOf(r);
      const nums = tr ? ui.t('runs.tr', { sent, got, miss: Math.max(0, sent - got), s: secs }) : ui.t('runs.idiom', { sent: (r.sent && r.sent.targets) || 0, s: secs });
      const end = r.err ? ui.t('runs.err', { kind: r.err.kind || '' }) : r.finish === 'abort' ? ui.t('runs.abort') : r.finish === 'drop' ? ui.t('runs.drop') : r.finish === 'length' ? ui.t('runs.length') : '';
      return ui.el('div', { class: 'info run', 'data-role': r.role }, [
        ui.el('span', { class: 'cap', text: when(r.at) + ' ' + ui.t(tr ? 'runs.role.tr' : 'runs.role.idiom') + ' ' + S.short(r.model) }),
        ui.el('span', { class: 'n', text: nums }),
        end ? ui.el('span', { class: 'end', text: end }) : null
      ]);
    }
    function more(){
      const next = all.slice(shown, shown + step);
      if (!shown) S.fill(listBox, []);
      next.forEach(r => listBox.appendChild(item(r)));
      shown += next.length;
      moreBtn.hidden = shown >= all.length;
    }
    moreBtn.onclick = more;
    Y.runs.list({}).then(list => {
      if (!alive()) return;
      all = Array.isArray(list) ? list : [];
      const now = new Date(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      S.fill(sumBox, [sumLine(ui.t('runs.today'), sum(all, d0)), sumLine(ui.t('runs.week'), sum(all, d0 - 6 * 86400000))]);
      if (!all.length){ S.fill(listBox, [ui.el('div', { class: 'info' }, [ui.el('span', { class: 'cap', text: ui.t('runs.none') })])]); return; }
      more();
    }, () => { if (alive()) S.fill(listBox, [alertBox(ui.t('err.other'))]); });
    return S.shell({ name: 'runs', title: ui.t('set.runs'), back: 'top', body: [
      ui.el('p', { class: 'lead', text: ui.t('runs.lead', { days: cfg.runs.keepDays }) }),
      ui.el('div', { class: 'label', text: ui.t('runs.rate') }), sumBox,
      ui.el('div', { class: 'label', text: ui.t('runs.list') }), listBox, moreBtn
    ] });
  }

  // ---- 音声 ----
  // 先に並べる声(よく使われる、ふつうの声)。名前に「拡張」「プレミアム」などが付く声(あとから入れた、質の高い声)は、いつも先に
  const good = name => new RegExp(ui.t('voice.good'), 'i').test(name);
  const COMMON = /^(samantha|daniel|karen|moira|rishi|tessa|ava|allison|evan|nathan|zoe|susan|tom|alex|google us english|google uk english (female|male)|microsoft (aria|jenny|guy|ava|andrew|emma|brian|zira|david|mark))\b/i;
  const RATES = [['slow', 0.8], ['mid', 0.95], ['fast', 1.1]];
  function device(){
    const n = win().navigator, ua = String((n && n.userAgent) || '');
    if (Y.env && Y.env.info && Y.env.info.ios) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua) && /Edg\//.test(ua)) return 'edge';
    return 'other';
  }
  function voice(){
    const sp = Y.speech, dev = device();
    let st = Y.settings.get().voice, wide = false, saying = false;
    const box = ui.el('div', { 'data-box': 'voices' });
    const tryLabel = ui.el('span', { text: ui.t('voice.try') });
    const tryBtn = ui.el('button', { class: 'side wide', 'data-act': 'try', onclick: () => {
      if (saying){ sp.stop(); return; }
      saying = sp.say(ui.t('voice.sample'), { onEnd(){ saying = false; tryLabel.textContent = ui.t('voice.try'); } });
      if (saying) tryLabel.textContent = ui.t('voice.stop'); else ui.toast(ui.t('voice.cannot'));
    } }, [ui.icon('speaker', 18, 2), tryLabel]);
    function draw(){
      const en = sp.voices().map(v => ({ name: v.name, lang: String(v.lang).replace('_', '-') })).filter(v => /^en/i.test(v.lang));
      const us = v => (/^en-US$/i.test(v.lang) ? 1 : 0);
      const rank = v => (good(v.name) ? 0 : COMMON.test(v.name) ? 1 : 2);
      // 質の高い声 → よく使われる声。同じなら、アメリカの英語を先に。先に並べるのは cfg.ui.voiceFirst 個まで(PC の Edge は、自然な声が十いくつもある)。選んである声は、いつも出す
      const top = en.filter(v => rank(v) < 2).sort((a, b) => rank(a) - rank(b) || us(b) - us(a)).slice(0, cfg.ui.voiceFirst || 6);
      const first = top.concat(en.filter(v => v.name === st.name && top.indexOf(v) < 0));
      const rest = en.filter(v => first.indexOf(v) < 0);
      const list = [{ id: '', title: ui.t(dev === 'ios' ? 'voice.auto' : 'voice.auto.pick'), sub: ui.t(dev === 'ios' ? 'voice.autoSub.ios' : 'voice.autoSub') }]
        .concat((wide ? first.concat(rest) : first).map(v => ({ id: v.name, title: v.name, sub: ui.t(Y.msg.has('voice.lang.' + v.lang) ? 'voice.lang.' + v.lang : 'voice.lang.other', { lang: v.lang }) })));
      const kids = [choice(list, st.name || '', name => { sp.stop(); save({ voice: { name } }).then(ok => { st = Y.settings.get().voice; saved(ok); }); }).box];
      if (!wide && rest.length) kids.push(ui.el('button', { class: 'textbtn', 'data-act': 'wide', onclick: () => { wide = true; draw(); } }, [ui.t('voice.wide', { n: rest.length })]));
      S.fill(box, kids);
    }
    draw();
    // 声の一覧は、あとから届くことがある(はじめは空)。届いたら、描き直す(この画面が出ている間だけ)
    const alive = S.alive();
    const syn = win().speechSynthesis;
    const onVoices = () => { if (alive()) draw(); };
    try { if (syn && syn.addEventListener) syn.addEventListener('voiceschanged', onVoices); } catch (e){}
    S.onLeave(() => { sp.stop(); try { if (syn && syn.removeEventListener) syn.removeEventListener('voiceschanged', onVoices); } catch (e){} });
    const near = RATES.reduce((a, r) => (Math.abs(r[1] - st.rate) < Math.abs(a[1] - st.rate) ? r : a), RATES[1]);
    const rateBtns = RATES.map(r => ui.el('button', { 'data-opt': r[0], 'aria-pressed': 'false', onclick: () => { S.press(rateBtns, r[0]); sp.stop(); save({ voice: { rate: r[1] } }).then(saved); } }, [ui.icon('check', 14, 2.6), ui.el('span', { text: ui.t('voice.rate.' + r[0]) })]));
    S.press(rateBtns, near[0]);
    const tip = [1, 2, 3, 4].filter(i => Y.msg.has('voice.tip.' + dev + '.' + i)).map(i => ui.t('voice.tip.' + dev + '.' + i));
    const tipNote = Y.msg.has('voice.tipNote.' + dev) ? ui.t('voice.tipNote.' + dev) : '';
    return S.shell({ name: 'voice', title: ui.t('set.voice'), back: 'top', body: [
      ui.el('p', { class: 'lead', text: ui.t('voice.lead') }),
      sp.can() ? null : alertBox(ui.t('voice.cannot')),
      ui.el('div', { class: 'label', text: ui.t('voice.voice') }), box,
      ui.el('div', { class: 'label', text: ui.t('voice.rate') }), ui.el('div', { class: 'trio' }, rateBtns),
      tip.length || tipNote ? ui.el('div', { class: 'label', 'data-tip': dev, text: ui.t('voice.tip') }) : null,
      tip.length ? ui.el('div', { class: 'rows', 'data-box': 'tip', 'data-dev': dev }, [ui.el('div', { class: 'steps flat' },
        tip.map((text, i) => ui.el('div', { class: 'step' }, [ui.el('span', { class: 'num', 'aria-hidden': 'true', text: String(i + 1) }), ui.el('span', { text })])))]) : null,
      tipNote ? ui.el('p', { class: 'hint' + (tip.length ? '' : ' plain'), text: tipNote }) : null
    ], foot: [tryBtn] });   // 「試しに聞く」は、下の行(声の一覧が長くても、いつも見える)
  }

  // ---- 右下のボタンを出さないサイト(工程8c-2。設計メモ 2-6)。戻すのは 1 回押し(ボタンが出るようになるだけ。取り返しがつく) ----
  function hide(){
    const alive = S.alive();
    const list = ui.el('div', { class: 'rows', 'data-box': 'hide' });
    const draw = () => {
      const items = Y.settings.get().hide.slice().reverse();     // 新しい順
      S.fill(list, items.length ? items.map(e => {
        const b = ui.el('button', { class: 'textbtn', 'data-act': 'unhide', 'data-host': e.h, 'aria-label': ui.t('hide.backName', { site: e.h }), onclick: () => {
          b.disabled = true;
          Y.settings.unhide(e.h).then(() => { ui.toast(ui.t('hide.backDone', { site: e.h })); if (alive()) draw(); }, () => { b.disabled = false; ui.toast(ui.t('set.saveFail')); });
        } }, [ui.t('hide.back')]);
        return ui.el('div', { class: 'rowstat' }, [ui.el('span', { class: 'host', text: e.h }), b]);
      }) : [ui.el('div', { class: 'info' }, [ui.el('span', { class: 'cap', text: ui.t('hide.none') })])]);
    };
    draw();
    return S.shell({ name: 'hide', title: ui.t('hide.title'), back: 'top', body: [ui.el('p', { class: 'lead', text: ui.t('hide.lead', { tm: ui.t('tm.toggle') }) }), list] });
  }

  S.add('hide', hide);
  S.add('models', models);
  S.add('model', model);
  S.add('onlimit', onLimit);
  S.add('runs', runs);
  S.add('voice', voice);
})();

/* ---- ui/settings_data.js ---- */
// ui/settings_data.js — 設定の画面の続き(部品の約束 §9-6。工程4c-2b): 記録・書き出しと読み込み・このサイトの保存を消す・この版(1枚)
//   画面の型と部品は ui/settings.js のもの(Yomu.uiSettings)を使う。ここは、画面を足すだけ(add)。
//   読んだ記録を残す・開き直したら自動で戻す: 押すと、すぐ保存(主なボタンは置かない)。「残さない」にしても、今までの記録は消さない
//   書き出す: Yomu.store.export() を JSON にして、リンク(<a download>+Blob の URL)を押す。同じリンクを、結果の所に残す(保存が始まらない端末のため)
//     API キーと、訳したページは入らない(core/schema.js の parts に無い)
//   読み込む: 選んだだけでは、何も書かない。先に中身(書き出した日時・入っているもの)を見せてから、足す(merge)か、置きかえる(replace。2回タップ)
//   このサイトの保存を消す: 訳したページだけ(Yomu.store.pages.clear。2回タップ)。AI辞書の答え・内蔵辞書・記録は、消さない(2026-10-10 利用者)
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, cfg = Yomu.config, S = Yomu.uiSettings;
  const win = () => ui.root().ownerDocument.defaultView;
  const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);

  const alertBox = text => ui.el('div', { class: 'alert' }, [ui.icon('alert', 18, 2), ui.el('span', { text })]);
  const okLine = text => ui.el('div', { class: 'okline' }, [ui.icon('check', 18, 2.6), ui.el('span', { text })]);
  const stateLine = text => ui.el('div', { class: 'state', text });
  const line = (cap, val, name) => ui.el('div', { class: 'info', 'data-line': name }, [ui.el('span', { class: 'cap', text: cap }), ui.el('span', { class: 'v', text: val })]);
  const p2 = n => (n < 10 ? '0' : '') + n;
  const stamp = d => String(d.getFullYear()) + p2(d.getMonth() + 1) + p2(d.getDate());
  const when = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  // 名前の表にあれば呼び名、無ければ、そのままの字(知らない入れ物・保存先を、にせの名前で呼ばない)
  const named = (pre, id) => (Y.msg.has(pre + id) ? ui.t(pre + id) : String(id == null ? '' : id));

  // 横に2つの選ぶボタン(する/しない)。押すと、すぐ保存。戻りは { box, set(on) }
  function onOff(name, label, on, yes, no, fn){
    const btns = [['on', yes], ['off', no]].map(o => ui.el('button', { 'data-opt': o[0], 'aria-pressed': 'false', onclick: () => { const was = btns.find(b => b.getAttribute('aria-pressed') === 'true'); S.press(btns, o[0]); Promise.resolve(fn(o[0] === 'on')).then(ok => { if (ok === false && was) S.press(btns, was.getAttribute('data-opt')); }); } }, [ui.icon('check', 14, 2.6), ui.el('span', { text: o[1] })]));
    S.press(btns, on ? 'on' : 'off');
    return { box: ui.el('div', { class: 'trio', role: 'group', 'aria-label': label, 'data-box': name }, btns), set: v => S.press(btns, v ? 'on' : 'off') };
  }

  // 書き出しファイルの中の単語帳の語の数(外した印の付いた語は数えない)と、読んだ記録の日数
  const okName = (part, k) => { const p = Y.schema.parts[part]; return !(p && p.name) || p.name.test(k); };
  function vocabIn(part){
    let n = 0;
    Object.keys(part).forEach(k => { const items = okName('vocab', k) && isPlain(part[k]) && part[k].items; if (isPlain(items)) Object.keys(items).forEach(w => { if (isPlain(items[w]) && items[w].del == null) n++; }); });
    return n;
  }
  const PARTS = ['settings', 'vocab', 'log', 'runs', 'quota'];      // 見せる順(logx=読んだ記録の詳しい分は、log と一緒に数える)
  function contents(parts){
    const out = [];
    PARTS.forEach(name => {
      if (!isPlain(parts[name])) return;
      if (name === 'vocab') out.push(ui.t('data.part.vocab', { n: vocabIn(parts.vocab) }));
      else if (name === 'log') out.push(ui.t('data.part.log', { n: Object.keys(parts.log).filter(k => okName('log', k)).length }));
      else out.push(ui.t('data.part.' + name));
    });
    if (!isPlain(parts.log) && isPlain(parts.logx)) out.push(ui.t('data.part.logx'));
    return out;
  }
  // 選んだファイルの中身を、文字で読む(File.text が無い端末は、FileReader)
  function readText(file){
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((res, rej) => {
      const R = win().FileReader;
      if (!R) return rej(new Error('no FileReader'));
      const r = new R();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error || new Error('read'));
      r.readAsText(file);
    });
  }

  let working = false;             // 読み込み・消す操作の途中(画面を出て戻っても、終わるまで、もう1つ始めない)
  function data(){
    const alive = S.alive();
    const info0 = Y.env && Y.env.info;
    const st = Y.settings.get();
    const stops = [], urls = [];
    const save = patch => Y.settings.set(patch).then(() => true, () => { ui.toast(ui.t('set.saveFail')); return false; });
    const show = (box, kids, text, fail) => { S.fill(box, kids); box.hidden = false; if (text) ui.announce(text, !!fail); };
    const fail = (box, text) => show(box, [alertBox(text)], text, true);

    // ---- 記録 ----
    const saved = ok => { if (ok) ui.toast(ui.t('set.saved')); return ok; };
    const log = onOff('log', ui.t('data.log'), !(st.log && st.log.on === false), ui.t('data.log.on'), ui.t('data.log.off'), on => save({ log: { on } }).then(saved));
    const restore = onOff('restore', ui.t('data.restore'), st.restore !== false, ui.t('data.restore.on'), ui.t('data.restore.off'), on => save({ restore: on }).then(saved));

    // ---- 書き出す ----
    const outResult = ui.el('div', { class: 'result', 'data-result': 'out', hidden: true });
    const vocabSub = ui.el('span', { class: 'cost', text: '' });
    const countVocab = () => Y.vocab.count().then(n => { if (alive()) vocabSub.textContent = ui.t('data.words', { n }); }, () => {});
    countVocab();
    let outBusy = false;
    async function out(kind, btn){
      if (outBusy) return;
      outBusy = true; btn.disabled = true;
      show(outResult, [stateLine(ui.t('data.outing'))]);
      try {
        const obj = await Y.store.export(kind === 'vocab' ? { parts: ['vocab'] } : undefined);
        if (!alive()) return;
        if (!Object.keys(obj.parts).length){ fail(outResult, ui.t('data.outNone')); return; }
        const w = win();
        if (!(w.Blob && w.URL && w.URL.createObjectURL)){ fail(outResult, ui.t('data.outFail')); return; }
        const name = cfg.ui.fileName + '-' + kind + '-' + stamp(new Date()) + '.json';
        const url = w.URL.createObjectURL(new w.Blob([JSON.stringify(obj)], { type: 'application/json' }));
        urls.push(url);
        const a = ui.el('a', { class: 'link', href: url, download: name, 'data-act': 'save' }, [ui.el('span', { text: ui.t('data.outLink') }), ui.icon('out', 18, 2)]);
        const text = ui.t('data.outDone', { name });
        show(outResult, [okLine(text), a], text);
        try { a.click(); } catch (e){}      // 待ったあとの「押す」を受けない端末では、何も起きない(上のリンクを、自分で押してもらう)
      } catch (e){
        if (alive()) fail(outResult, ui.t('data.outFail'));
      } finally {
        outBusy = false;
        if (alive()) btn.disabled = false;
      }
    }
    const outVocab = ui.el('button', { class: 'side wide', 'data-act': 'out-vocab', onclick: () => out('vocab', outVocab) }, [ui.el('span', { class: 'two' }, [ui.el('span', { text: ui.t('data.outVocab') }), vocabSub])]);
    const outAll = ui.el('button', { class: 'side wide', 'data-act': 'out-all', onclick: () => out('all', outAll) }, [ui.el('span', { class: 'two' }, [ui.el('span', { text: ui.t('data.outAll') }), ui.el('span', { class: 'cost', text: ui.t('data.outAllSub') })])]);

    // ---- 読み込む ----
    const inResult = ui.el('div', { class: 'result', 'data-result': 'in', hidden: true });
    const picked = ui.el('div', { 'data-box': 'picked', hidden: true });
    const input = ui.el('input', { class: 'sr', id: 'y-file', type: 'file', accept: '.json,application/json', 'data-act': 'file' });
    const pick = ui.el('label', { class: 'side wide pickfile', for: 'y-file', 'data-act': 'pick' }, [ui.el('span', { text: ui.t('data.inPick') }), input]);
    let seq = 0, inBusy = false, disarm = null;
    const unpick = () => { if (disarm){ disarm(); disarm = null; } picked.hidden = true; S.fill(picked, []); };
    async function load(obj, mode, btns){
      if (inBusy) return;
      if (working){ fail(inResult, ui.t('data.busy')); return; }
      inBusy = working = true; btns.forEach(b => { b.disabled = true; });
      show(inResult, [stateLine(ui.t('data.inDoing'))]);
      try {
        const r = await Y.store.import(obj, { mode });
        await Y.settings.load().catch(() => {});
        if (!alive()) return;
        const texts = [ui.t(mode === 'replace' ? 'data.inDoneReplace' : 'data.inDone')];
        if (r.parts.vocab) texts.push(ui.t('data.inVocab', { n: await Y.vocab.count().catch(() => 0) }));
        if (r.parts.settings) texts.push(ui.t('data.inReload'));
        if (r.skipped.length) texts.push(ui.t('data.inSkipped', { n: r.skipped.length }));
        if (!(await Y.settings.secrets.has().catch(() => true))) texts.push(ui.t('data.inKey'));
        if (!alive()) return;
        unpick();
        show(inResult, [okLine(texts[0])].concat(texts.slice(1).map(t => ui.el('p', { class: 'hint', text: t }))), texts.join(' '));
        const now = Y.settings.get();
        log.set(!(now.log && now.log.on === false)); restore.set(now.restore !== false);
        countVocab(); countPages();
      } catch (e){
        if (!alive()) return;
        const k = e && e.kind;
        fail(inResult, ui.t(k === 'format' || k === 'newer' || k === 'full' ? 'data.inBad.' + k : 'err.other'));
        if (k === 'format' || k === 'newer') unpick();
      } finally {
        inBusy = working = false;
        if (alive()) btns.forEach(b => { b.disabled = false; });
      }
    }
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (inBusy){ try { input.value = ''; } catch (e){} return; }
      const my = ++seq;
      unpick();
      show(inResult, [stateLine(ui.t('mod.loading'))]);
      let obj = null, bad = '';
      try {
        const text = await readText(file);
        try { obj = JSON.parse(text); } catch (e){ bad = 'data.inBad.format'; }
      } catch (e){ bad = 'data.inBad.read'; }
      try { input.value = ''; } catch (e){}     // 同じファイルを、もう一度選べるように
      if (!alive() || my !== seq) return;
      if (!bad && !(isPlain(obj) && obj.format === 'yomu-export' && isPlain(obj.parts))) bad = 'data.inBad.format';
      if (bad){ fail(inResult, ui.t(bad)); return; }
      const has = contents(obj.parts);
      if (!has.length){ fail(inResult, ui.t('data.inBad.empty')); return; }
      inResult.hidden = true;
      const merge = ui.el('button', { class: 'primary', 'data-act': 'merge' }, [ui.el('span', { text: ui.t('data.inMerge') })]);
      const repLabel = ui.el('span', { text: ui.t('data.inReplace') });
      const replace = ui.el('button', { class: 'textbtn gap', 'data-act': 'replace' }, [repLabel]);
      const btns = [merge, replace];
      merge.onclick = () => load(obj, 'merge', btns);
      disarm = ui.twoTap(replace, { label: repLabel, armed: ui.t('data.inReplaceArmed'), fn: () => load(obj, 'replace', btns) });
      S.fill(picked, [
        ui.el('div', { class: 'rows' }, [line(ui.t('data.inFile'), String(file.name || ''), 'file'), line(ui.t('data.inAt'), when(obj.exportedAt) || ui.t('data.inAtNone'), 'at'), line(ui.t('data.inHas'), has.join('・'), 'has')]),
        ui.el('p', { class: 'hint', text: ui.t('data.inMergeNote') }),
        merge,
        ui.el('p', { class: 'hint', text: ui.t('data.inReplaceNote') }),
        replace
      ]);
      picked.hidden = false;
      ui.announce(ui.t('data.inPicked', { has: has.join('・') }));
    });

    // ---- このサイトの保存 ----
    const pagesVal = ui.el('span', { class: 'val', 'data-pages': '', text: '' });
    const clearLabel = ui.el('span', { text: ui.t('data.clear') });
    const clearBtn = ui.el('button', { class: 'textbtn gap', 'data-act': 'clear', disabled: true }, [clearLabel]);
    const clearResult = ui.el('div', { class: 'result', 'data-result': 'clear', hidden: true });
    function countPages(){
      return Y.store.pages.count().then(n => { if (!alive()) return; pagesVal.textContent = ui.t('data.pagesN', { n }); pagesVal.setAttribute('data-pages', String(n)); clearBtn.disabled = !n; }, () => { if (alive()) clearBtn.disabled = false; });
    }
    countPages();
    let clearing = false;
    stops.push(ui.twoTap(clearBtn, { label: clearLabel, armed: ui.t('data.clearArmed'), fn: async () => {
      if (clearing) return;
      const s = ui.status();
      if (s.state === 'busy' || s.busy){ fail(clearResult, ui.t('data.clearBusy')); return; }
      if (working){ fail(clearResult, ui.t('data.busy')); return; }
      clearing = working = true; clearBtn.disabled = true;
      try {
        const n = await Y.store.pages.clear();
        if (!alive()) return;
        const text = ui.t('data.cleared', { n });
        show(clearResult, [okLine(text)], text);
      } catch (e){
        if (alive()) fail(clearResult, ui.t('err.other'));
      } finally {
        clearing = working = false;
        if (alive()) await countPages();
      }
    } }));

    S.onLeave(() => {
      seq++;
      stops.forEach(f => f());
      if (disarm) disarm();
      const U = win().URL;
      urls.forEach(u => { try { U.revokeObjectURL(u); } catch (e){} });
    });

    // iPhone の、ファイルを選ぶ画面は、前に開いた場所から始まり、書き出したファイルが見当たらないことがある(工程5b-3 利用者の iPhone)。探し方を、3つの手順で
    const inTip = info0 && info0.ios ? [1, 2, 3].map(i => ui.t('data.inTip.ios.' + i, { name: cfg.ui.fileName })) : [];
    const c2 = ui.cost(2);
    const info = Y.env && Y.env.info;
    return S.shell({ name: 'data', title: ui.t('set.data'), back: 'top', body: [
      ui.el('div', { class: 'label', text: ui.t('data.log') }), log.box,
      ui.el('p', { class: 'hint', text: ui.t('data.logNote') }),
      ui.el('div', { class: 'label', text: ui.t('data.restore') }), restore.box,
      ui.el('p', { class: 'hint', text: ui.t('data.restoreNote') }),
      ui.el('div', { class: 'label', text: ui.t('data.out') }),
      ui.el('p', { class: 'hint first', text: ui.t('data.outNote') }),
      outVocab, outAll, outResult,
      ui.el('div', { class: 'label', text: ui.t('data.in') }),
      ui.el('p', { class: 'hint first', text: ui.t('data.inNote') }),
      pick, picked, inResult,
      inTip.length ? ui.el('div', { class: 'label', 'data-tip': 'in', text: ui.t('data.inTip') }) : null,
      inTip.length ? ui.el('div', { class: 'rows', 'data-box': 'intip' }, [ui.el('div', { class: 'steps flat' },
        inTip.map((text, i) => ui.el('div', { class: 'step' }, [ui.el('span', { class: 'num', 'aria-hidden': 'true', text: String(i + 1) }), ui.el('span', { text })])))]) : null,
      ui.el('div', { class: 'label', text: ui.t('data.site') }),
      ui.el('div', { class: 'rows' }, [ui.el('div', { class: 'rowstat' }, [ui.el('span', { text: ui.t('data.pages') }), pagesVal])]),
      ui.el('p', { class: 'hint', text: ui.t('data.clearNote', { cost: c2 ? ui.t('data.clearCost', { cost: c2 }) : '' }) }),
      clearBtn, clearResult,
      ui.el('div', { class: 'label', text: ui.t('data.about') }),
      Y.store.shared.backend === 'mem' || Y.store.site.backend === 'mem' ? alertBox(ui.t('data.memWarn')) : null,
      ui.el('div', { class: 'rows', 'data-box': 'about' }, [
        line(ui.t('data.ver'), String(cfg.version), 'ver'),
        line(ui.t('data.env'), named('data.env.', info && info.handler), 'env'),
        line(ui.t('data.storeShared'), named('data.store.', Y.store.shared.backend), 'shared'),
        line(ui.t('data.storeSite'), named('data.store.', Y.store.site.backend), 'site')
      ]),
      // 調べるための記録(うまく動かないときに、写して送ってもらう。ui/settings_diag.js)
      ui.el('p', { class: 'hint', text: ui.t('diag.note') })
    ].concat(Y.uiDiag ? Y.uiDiag.copyBox() : []) });
  }

  S.add('data', data);
})();

/* ---- ui/settings_diag.js ---- */
// ui/settings_diag.js — うまく動かないときの画面(部品の約束 §9-6・§9-8。工程5b-2b)
//   「直し方」(部品の名前は fix): 知らせ stuck(起動の途中で、保存を読むのが終わらない)の「直し方を見る」から出す、画面いっぱいの1枚。
//     ブラウザを閉じて開き直す手順と、「記録を写す」。本文ページの状態が none のままでも出せる(設定のトップへは、行かない)。
//   「記録を写す」: 設定の「この版」にも置く(Yomu.uiDiag.copyBox)。写すのは、調べるための記録(core/diag.js)・置き場のよけ方の数字(Yomu.ui.placeInfo)・
//     前のページを離れたときの控え(shell/boot.js が書く)。ページの文章・題名・作品の番号・API キーは入れない。
//   写すのは、押したその場で(待たずに)行う: 待ってから写すと、iPhone の Safari が、写しの置き場への書き込みを受けない。だから、控えは、画面を作るときに読んでおく
(function(){
  'use strict';
  const Y = Yomu;
  const ui = Yomu.ui, cfg = Yomu.config, S = Yomu.uiSettings;
  const HEAD = 'yomu-diag ';        // 貼ってもらった字の、頭の目印
  const win = () => ui.root().ownerDocument.defaultView;
  const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => undefined), new Promise(r => setTimeout(() => r(undefined), ms))]);
  const backend = area => { try { return Y.store[area].backend; } catch (e){ return null; } };

  // 記録(その場で作る)。leave = 前のページを離れたときの控え(読めていなければ null)・det = どのページでもの見分けにかかった時間(確かめ用の版だけ。config.page.detect.log)
  function report(leave, det){
    const info = (Y.env && Y.env.info) || {}, s = Y.page.status(), w = win();
    return {
      v: cfg.version, env: info.handler || null, ios: !!info.ios, host: String(w.location.hostname), now: Date.now(),
      state: s.state, notice: s.notice ? s.notice.kind : null, busy: !!s.busy, n: s.n, saved: Object.keys(s.saved || {}).length,
      store: { shared: backend('shared'), site: backend('site'), hold: Y.store.kv.state() },
      boot: Y.diag.snapshot(),
      leave: leave || null,
      detect: det || undefined,
      place: ui.placeInfo(),
      dict: Y.dict && Y.dict.timing ? Y.dict.timing() : null   // 内蔵辞書を、取る・読む・引くのに、かかった時間(まだ引いていなければ null)
    };
  }
  const text = (leave, det) => HEAD + JSON.stringify(report(leave, det));

  // 「記録を写す」のボタンと、その結果 → [ボタン, 結果の置き場]
  function copyBox(){
    let leave = null, det = null;
    const D = cfg.diag, P = cfg.page.detect;
    if (D && D.leave) within(Promise.resolve().then(() => Y.env.shared.get(D.leaveKey)), D.readMs).then(v => { if (v && typeof v === 'object') leave = v; });
    if (P && P.log) within(Promise.resolve().then(() => Y.env.shared.get(P.logKey)), D.readMs).then(v => { if (Array.isArray(v)) det = v; });
    const result = ui.el('div', { class: 'result', 'data-result': 'diag', hidden: true });
    const show = (kids, say, fail) => { S.fill(result, kids); result.hidden = false; ui.announce(say, !!fail); };
    const dump = t => show([ui.el('p', { class: 'hint first', text: ui.t('diag.copyFail') }), ui.el('div', { class: 'dump', 'data-dump': '', text: t })], ui.t('diag.copyFail'), true);
    const btn = ui.el('button', { class: 'textbtn gap', 'data-act': 'diag-copy', onclick: () => {
      let t = '';
      try { t = text(leave, det); } catch (e){ t = HEAD + JSON.stringify({ v: cfg.version, err: String((e && e.message) || e).slice(0, 120) }); }
      let p = null;
      try { const c = win().navigator.clipboard; p = c && c.writeText ? c.writeText(t) : null; } catch (e){ p = null; }
      if (!p){ dump(t); return; }
      Promise.resolve(p).then(() => show([ui.el('div', { class: 'okline' }, [ui.icon('check', 18, 2.6), ui.el('span', { text: ui.t('diag.copied') })])], ui.t('diag.copied')), () => dump(t));
    } }, [ui.el('span', { text: ui.t('diag.copy') })]);
    return [btn, result];
  }

  // 「直し方」の1枚。手順は、絵の代わりに番号(最初の設定の「使い方」と同じ並べ方)
  function fix(){
    const ios = !!(Y.env && Y.env.info && Y.env.info.ios);
    const steps = ios ? ['ios1', 'ios2', 'ios3'] : ['pc1', 'pc2'];
    return S.shell({ name: 'fix', title: ui.t('fix.title'), body: [
      ui.el('h1', { class: 'h1', text: ui.t('fix.head') }),
      ui.el('p', { class: 'lead', text: ui.t('fix.lead') }),
      ui.el('div', { class: 'hows', role: 'list', 'data-box': 'steps' }, steps.map((k, i) => ui.el('div', { class: 'how', role: 'listitem' }, [
        ui.el('div', { class: 'pic', 'aria-hidden': 'true' }, [ui.el('span', { class: 'num', text: String(i + 1) })]),
        ui.el('div', { class: 'txt' }, [ui.el('div', { class: 'ttl', text: ui.t('fix.' + k) }), ui.el('div', { class: 'sub', text: ui.t('fix.' + k + 'd') })])
      ]))),
      ui.el('div', { class: 'label', text: ui.t('diag.label') }),
      ui.el('p', { class: 'hint first', text: ui.t('diag.note') })
    ].concat(copyBox()) });
  }

  S.add('fix', fix);
  Yomu.uiDiag = { copyBox, report, HEAD };
  // 知らせ stuck の「直し方を見る」から(Yomu.ui.show('fix'))。状態が none でも出す
  ui.part('fix', { open(){ S.go('fix'); }, close: () => ui.unsheet('settings') });
})();

};   /* ---- Yomu.rest のおわり ---- */

/* ---- shell/boot.js ---- */
// shell/boot.js — 起動(部品の約束 §9-8)。束のいちばん最後で1回だけ呼ばれる(Yomu.boot)
//   起動では、通信も、辞書の読み込みも、重い処理もしない(ページを開いただけでは何もしない=設計メモ 2-1)。
//   既知のサイト(なろう・カクヨム・見本ページ)は、今までどおり: 印・土台・見張り → 本文ページなら保存の起動 → 表示。本文ページでなければ、URL の見張りだけ。
//   どのページでも(既知でないページ。v1.51 工程8c-1。2026-10-17 利用者=設計メモ 2-6): 記事と分かるまで、印を付けない・土台を作らない・
//     見張りを始めない・離れるときの控えを書かない・保存にさわらない。記事と分かったら、残りの部品を動かして(Yomu.rest=§2-3)、今までの起動。
//     見るのは、起動のとき・load のあと・2 秒と 6 秒あと・最初のタップかキーの 1 秒あと(§3 の「いつ見るか」)
(function(){
  'use strict';
  const Y = Yomu;
  const MARK = 'data-yomu';
  const LEGACY = 'mazelingo-fab';   // 今の版(小説まぜりんご)のボタン
  const LEGACY_KEYS = 'mazelingo_';   // 今の版が、サイトの保存(localStorage)に残したもの(API キーの控え・訳した話の控え・設定)の、鍵の頭
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const T0 = typeof Y.t0 === 'number' ? Y.t0 : now();   // 束が動き始めた時(ビルドが束の頭で入れる)

  // 残りの部品を動かす(1 回だけ。§2-3 の「束を分ける」)
  function rest(){
    if (typeof Y.rest !== 'function') return;
    const f = Y.rest;
    Y.rest = null;
    f();
  }
  // Tampermonkey のメニューの 1 行から、ブレンドする(入口の「ブレンド」と同じ道=初めてなら、最初の設定を出す)
  const blendUi = () => { if (!(Y.ui && typeof Y.ui.blend === 'function' && Y.ui.blend())) Y.page.blend(); };
  const label = () => (Y.msg ? Y.msg.t('tm.toggle') : '');
  const href = () => String(location.href).split('#')[0];   // ページの中の印(#…)だけの変化は数えない

  // 印・土台・見張り・離れるときの控え(既知のサイトは、すぐ。どのページでもは、記事と分かってから)
  function arm(doc, win){
    const html = doc.documentElement;
    if (html.hasAttribute(MARK)){ try { console.warn('[yomu] もう動いているので、2つ目は動かない'); } catch (e){} return false; }   // 二重に動かさない(§2-3)
    html.setAttribute(MARK, Y.config.version);
    rest();
    const diag = Y.diag;
    diag.mark('boot', Y.config.version);
    // 操作部の土台(ui)。見本ページ用の束だけ、見本ページ用の状態の行も
    if (Y.ui && typeof Y.ui.mount === 'function') Y.ui.mount({ doc });
    if (Y.devPanel) Y.devPanel.mount();
    if (Y.watch) Y.watch.start({ doc });     // 読んだ時間の見張り(英語まじりで出ている間だけ動く。§8-8)
    diag.mark('ui');
    if (win) leaving(doc, win);   // win を渡さない = 離れるときの控えを付けない(どのページでもの、知らせのためだけの土台)
    return true;
  }

  // 調べるための控え(§9-8。工程5b-2b): ページを離れたときの様子を、全サイト共通の保存に1つ置く(次のページの「記録を写す」に出る)。動きは変えない。
  //   persisted = ブラウザが、このページを「戻る」用に凍らせて取っておいた / wait = そのとき、返事を待っていた保存の読み書き(離れたあとに始まった・終わった分も、書き直す)。
  //   進行役や見張りより先に付ける(それらが、離れるときに始めた書き込みも、入るように)
  // 離れるとき(§8-1。工程5b-2b): 凍らせて取っておかれるとき(persisted)と、iPhone・iPad では、ここから先、IndexedDB の取引を新しく始めない・つながりを閉じる(Yomu.store.kv.hold)。
  //   離れるときに始めた取引が、凍ったページの中で終わらないまま残り、次のページの読み書きを、いつまでも待たせるため(なろうで「次へ」のあと、アプリの準備が止まる)。
  //   iPhone では、離れるときに始めた IndexedDB への書き込みは、もともと残らない(工程P)=失うものは無い。PC で、凍らせないときは、今までどおり書く。
  //   戻ってきたら(pageshow・表に出た)、取っておいた分を始める。離れた合図のあとも、ページが生きていて見えていたら(合図の順が、思ったとおりでない端末への備え)、同じく始める
  function leaving(doc, win){
    const diag = Y.diag, L = Y.config.diag || {}, C = Y.config.store;
    const ios = !!(Y.env.info && Y.env.info.ios);
    let left = null, holdT = null;
    const free = () => {
      if (holdT){ clearInterval(holdT); holdT = null; }
      Y.store.kv.release();
    };
    const write = () => {
      if (!L.leave || !left || left.n >= L.leaveMax) return;
      if (left.n && Y.store.shared.backend === 'idb') return;   // 控えの置き場も IndexedDB の入れ物(見本ページ など): 控えを書くこと自体が「取っておいた読み書き」になるので、書き直さない
      left.n++;
      left.wait = diag.waiting().slice(0, 8).map(w => w[0]);
      left.held = Y.store.kv.state().n;
      try { Promise.resolve(Y.env.shared.set(L.leaveKey, left)).catch(() => {}); } catch (e){}
    };
    win.addEventListener('pagehide', e => {
      const persisted = !!(e && e.persisted), held = !!C.holdOnHide && (persisted || ios);
      if (held){
        Y.store.kv.hold();
        if (!holdT) holdT = setInterval(() => { if (doc.visibilityState === 'visible') free(); }, C.holdCheckMs);
      }
      left = { at: Date.now(), host: String(location.hostname), state: Y.page.state, persisted, hold: held, held: 0, wait: [], n: 0 };
      write();
    });
    win.addEventListener('pageshow', e => {
      free();
      if (e && e.persisted){ left = null; diag.mark('pageshow', 'persisted'); }
    });
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') free(); });
    diag.onWait(write);
  }

  // 既知のサイト(なろう・カクヨム・見本ページ): 今までどおり
  function known(doc, win){
    if (!arm(doc, win)) return;
    const diag = Y.diag;
    // 今の版と同時に動かさない(今の版のボタンがあれば、動かずに知らせる)。今の版が、あとから動くこともあるので、少し待ってもう一度見る
    const legacy = () => !!doc.getElementById(LEGACY);
    const conflict = () => Y.page.halt('conflict', { with: 'legacy' });
    const go = () => (legacy() ? conflict() : Y.page.start());
    // 今の版が残したものを、片づける(工程5c-2。利用者: 前の版の訳は要らない。安全に消えてくれればよい)。今の版が動いていないと分かってから(少し待ったあと)、
    //   このサイトの localStorage の、今の版の鍵だけを消す(API キーの控えが、サイトの側から読める所に残るため)。こちらの保存(IndexedDB・Tampermonkey の保存)には、さわらない
    const sweep = () => {
      if (!Y.config.page.sweepLegacy) return;
      try {
        const ls = win && win.localStorage;
        if (!ls) return;
        const keys = [];
        for (let i = 0; i < ls.length; i++){ const k = ls.key(i); if (k && k.indexOf(LEGACY_KEYS) === 0) keys.push(k); }
        keys.forEach(k => ls.removeItem(k));
        if (keys.length) diag.mark('legacy.swept', keys.length);
      } catch (e){}
    };
    go();
    setTimeout(() => {
      if (legacy()){ if (Y.page.status().notice?.kind !== 'conflict') conflict(); return; }
      sweep();
    }, Y.config.page.waitMs);
    // 入れ物からの「ブレンド/戻す」の合図(拡張のツールバー・Tampermonkey のメニュー。無い入れ物では何もしない)
    Y.env.onToggle(() => {
      const st = Y.page.state;
      if (st === 'on' || st === 'busy') Y.page.off(); else blendUi();
    }, { label: label() });
    // URL が変わったら(ページを読み込み直さずに移るサイト)、片づけて、もう一度
    Y.sites.watch(() => { Y.page.leave().then(() => { diag.restart(); diag.mark('url'); go(); }); }, { get: href });   // go が、今の版のボタンを見て知らせる
  }

  // どのページでも(既知でないページ): 記事と分かるまで、何も足さない・保存にさわらない
  function web(doc, win){
    try { if (win && win.top && win.top !== win) return; } catch (e){ return; }   // いちばん外のページだけ(Tampermonkey は @noframes。ブックマークレットの束のため)
    const D = Y.config.page.detect, diag = Y.diag;
    let armed = false, left = false, found = null, lastWhy = null, lastSig = '', moved = false, timers = [], offTap = null, offLoad = null, redrawT = null, redraws = 0;
    const clear = () => {
      timers.forEach(t => clearTimeout(t)); timers = [];
      if (offTap){ offTap(); offTap = null; }
      if (offLoad){ offLoad(); offLoad = null; }
    };
    // 確かめ用の版だけ(config.page.detect.log): 見分けにかかった時間を、全サイト共通の保存に新しい logMax 件だけ(工程8d が iPhone で測る。ページの名前・文章は入れない)
    const note = (r, ms, why) => {
      if (!D.log) return;
      const rec = { at: Date.now(), why, ms: Math.round(ms * 10) / 10, since: Math.round(now() - T0), t0: Math.round(T0), res: r.info ? 'ok' : r.why };
      try {
        Promise.resolve(Y.env.shared.get(D.logKey)).then(list => {
          const a = Array.isArray(list) ? list.slice(-(D.logMax - 1)) : [];
          a.push(rec);
          return Y.env.shared.set(D.logKey, a);
        }).catch(() => {});
      } catch (e){}
    };
    // 見分けて、記事なら PageInfo。URL が変わったのに、本文が前のページと同じなら、まだ入れかわっていない(null)
    const look = (why, loose) => {
      const t0 = now();
      let r;
      try { r = Y.detect.page(location, doc, { loose: !!loose }); } catch (e){ r = { info: null, why: 'error' }; }
      const ms = now() - t0;
      lastWhy = r.why;
      diag.mark('detect', why + ' ' + (r.info ? 'ok' : r.why) + ' ' + Math.round(ms));
      note(r, ms, why);
      if (r.info && moved && lastSig && Y.detect.sig(r.info) === lastSig){ diag.mark('detect.stale'); tap(); return null; }   // 次のタップで、もう一度見る
      return r.info;
    };
    // 最初のタップかキーの tapMs あとに、1 回見る(本文が、まだ前のままだったときは、次のタップでも)
    const tap = () => {
      if (!win || offTap) return;
      const onTap = () => {
        if (offTap){ offTap(); offTap = null; }
        timers.push(setTimeout(() => attempt('tap'), D.tapMs));
      };
      win.addEventListener('pointerdown', onTap, { capture: true, passive: true });
      win.addEventListener('keydown', onTap, { capture: true, passive: true });
      offTap = () => { win.removeEventListener('pointerdown', onTap, true); win.removeEventListener('keydown', onTap, true); };
    };
    // 記事と分かった: 残りの部品を動かし、印・土台・見張り(1 回だけ)→ 進行役の起動(当てはめの代わりに、見つけた本文を渡す)
    const begin = info => {
      found = info; lastSig = Y.detect.sig(info); moved = false;
      clear();
      if (!armed){
        if (!arm(doc, win)) return Promise.resolve(null);
        armed = true; left = true;
      } else if (!left && win){ left = true; leaving(doc, win); }   // 知らせのためだけに土台を作っていた(下の nojp): 離れるときの控えは、記事と分かってから
      Y.page.dismiss();                         // 「日本語の文が見つかりませんでした」が出ていたら、消す
      watchRedraw();
      return Y.page.start({ info });
    };
    // ページの側が本文を作り直した(React などで作ったページ。工程8d: Yahoo!ニュースは、開いてすぐ覚えた段落を、あとで作り直していた=英文を、外れた古い段落に描いていた):
    //   覚えた段落か、描いた英文が、ページから外れたら、片づけて探し直す(保存した訳は、通信なしで戻る=開き直したときと同じ)。
    //   訳している・熟語をさがしている最中は待つ(止めると、通信を無駄にする)。1 ページで redrawMax 回まで
    const stopRedraw = () => { if (redrawT){ clearInterval(redrawT); redrawT = null; } };
    const watchRedraw = () => {
      stopRedraw();
      if (!win || !D.redrawMs) return;
      redrawT = setInterval(() => {
        if (!found){ stopRedraw(); return; }
        if (Y.page.status().busy) return;
        const gone = found.paras.some(el => !el.isConnected) || !!(Y.render && Y.render.lost && Y.render.lost());
        if (!gone) return;
        stopRedraw();
        if (++redraws > D.redrawMax){ diag.mark('redraw.max'); return; }
        found = null;
        clear();
        const again = () => { diag.mark('redraw', redraws); attempt('redraw'); if (!found) schedule(false); };
        Y.page.leave().then(again, again);
      }, D.redrawMs);
    };
    const attempt = why => {
      if (found) return;
      const info = look(why);
      if (info) begin(info);
    };
    // いつ見るか(§3)。first = 開いたとき(すぐ見る・load を待つ)。URL が変わったあとは、すぐには見ない(本文が、まだ前のままのことがある)
    const schedule = first => {
      clear();
      if (first){
        attempt('boot');
        if (found) return;
        if (win && doc.readyState !== 'complete'){
          const f = () => { offLoad = null; attempt('load'); };
          win.addEventListener('load', f, { once: true });
          offLoad = () => win.removeEventListener('load', f);
        }
      }
      (D.at || []).forEach(ms => timers.push(setTimeout(() => attempt('t' + ms), ms)));
      tap();
    };
    // Tampermonkey のメニューの 1 行(どのページでも): 英語まじりなら日本語に戻す・記事なら、ブレンド・記事と見なかったページは、線をゆるめて見分けてから、ブレンド
    //   日本語の文が無かったら、知らせる(工程8c-2。押したのに何も起きない、にしない)。知らせのためだけに、土台を作る(印・残りの部品・土台・見張り。
    //   離れるときの控えは書かない=保存にさわらない)。知らせは、進行役の「動かずに知らせる」(状態は none のまま)
    const nojp = () => {
      diag.mark('menu', 'none');
      if (!armed){
        if (!arm(doc, null)) return;
        armed = true;
      }
      Y.page.halt('nojp');
    };
    const toggle = () => {
      const st = armed ? Y.page.state : 'none';
      if (st === 'on' || st === 'busy'){ Y.page.off(); return; }
      if (armed && found){ if (st === 'off') blendUi(); else diag.mark('menu', st); return; }
      const info = look('menu', true);
      if (!info){ if (lastWhy === 'stop') diag.mark('menu', 'stop'); else nojp(); return; }   // パスワードの欄があるページでは、知らせも出さない(何もしない=設計メモ 2-6)
      begin(info).then(() => { if (armed && Y.page.state === 'off') blendUi(); });
    };
    Y.env.onToggle(toggle, { label: label() });
    // URL が変わったら(ページを読み込み直さずに移るサイト): 片づけて、見分けを、はじめから
    Y.sites.watch(() => {
      found = null; moved = true; redraws = 0;
      stopRedraw();
      clear();
      const again = () => { diag.restart(); diag.mark('url'); schedule(false); };
      if (armed) Y.page.leave().then(again, again); else again();
    }, { get: href });
    schedule(true);
  }

  Yomu.boot = function(){
    if (typeof document === 'undefined' || !document.documentElement) return;
    const doc = document, win = doc.defaultView;
    if (doc.documentElement.hasAttribute(MARK)){ try { console.warn('[yomu] もう動いているので、2つ目は動かない'); } catch (e){} return; }
    if (Y.sites.known(location)) return known(doc, win);
    if (Y.detect && Y.detect.web(location)) return web(doc, win);
  };
})();

if (typeof Yomu.boot === 'function') Yomu.boot();
})();
