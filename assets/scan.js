/* =====================================================================================
   MicroPort Cardioflow — lecture des étiquettes et des boîtes par code-barres
   -------------------------------------------------------------------------------------
   Commun aux pages BL et Dépôts. À partir d'une photo, retrouve tous les matériels visibles :
     • étiquettes et boîtes portant un code UDI / GS1 (Data Matrix des sondes, Code 128 des
       boîtiers et des boîtes) : référence produit (01), fabrication (11), péremption (17), n° de série (21) ;
     • boîtes à codes-barres séparés (REF, SN, péremption, fabrication) : regroupés par boîte.
   Sait aussi redessiner une étiquette propre à partir de ces informations (pour le BL).
   ===================================================================================== */
(function () {
  'use strict';

  var ZXING_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/iife/reader/index.js';
  var MICROPORT_GTIN = '08031527';                 // préfixe des références MicroPort CRM : les autres marques sont ignorées
  var RE_REF = /^T[A-Z]{2}\d{3}[A-Z0-9]$/;          // TLD041C, TDF068C, TPM020C, TLT0200…
  var RE_SN = [/^\d{3}[A-Z]{2}\d{3}$/, /^\d{2}[A-Z]{2}\d{6}$/, /^[A-Z]{3}\d{6}$/]; // 549JH012 · 68TR103045 · DRG120758
  var RE_DATE = /^(20\d{2})[-\/.]?(\d{2})[-\/.]?(\d{2})$/;

  var loading = null;
  function loadZXing() {
    if (window.ZXingWASM && window.ZXingWASM.readBarcodes) return Promise.resolve(window.ZXingWASM);
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      var done = function () { resolve((window.ZXingWASM && window.ZXingWASM.readBarcodes) ? window.ZXingWASM : null); };
      var s = document.createElement('script');
      s.src = ZXING_URL; s.crossOrigin = 'anonymous'; s.onload = done;
      s.onerror = function () { loading = null; resolve(null); };
      document.head.appendChild(s);
      setTimeout(done, 20000);
    });
    return loading;
  }

  function isoFromYYMMDD(e) {
    if (!e || !/^\d{6}$/.test(e)) return '';
    var yy = e.substr(0, 2), mm = parseInt(e.substr(2, 2), 10), dd = parseInt(e.substr(4, 2), 10);
    if (mm < 1 || mm > 12) return '';
    if (dd === 0) dd = new Date(2000 + parseInt(yy, 10), mm, 0).getDate(); // jour « 00 » = fin de mois (norme GS1)
    if (dd < 1 || dd > 31) return '';
    return '20' + yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }
  // Décode un texte GS1 : avec parenthèses « (01)…(21)… » ou brut avec séparateurs
  function parseGS1(text) {
    if (!text) return null;
    var t = String(text).replace(/^\][A-Za-z]\d/, ''), out = {};
    if (t.indexOf('(') >= 0) {
      var re = /\((\d{2,4})\)([^()\x1d]+)/g, m;
      while ((m = re.exec(t))) out[m[1]] = m[2];
    } else {
      var FIX = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 }, i = 0;
      while (i < t.length) {
        if (t[i] === '\x1d') { i++; continue; }
        var ai = t.substr(i, 2); i += 2;
        if (FIX[ai]) { out[ai] = t.substr(i, FIX[ai]); i += FIX[ai]; }
        else { var j = t.indexOf('\x1d', i); if (j < 0) j = t.length; out[ai] = t.substring(i, j); i = j + 1; }
      }
    }
    if (!out['01'] || !/^\d{14}$/.test(out['01'])) return null;
    return { gtin: out['01'], sn: out['21'] ? String(out['21']).toUpperCase().trim() : '', exp: isoFromYYMMDD(out['17']), mfg: isoFromYYMMDD(out['11']), raw: t };
  }
  function gs1Text(r) {
    if (!r.gtin) return '';
    var y = function (iso) { return iso ? iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10) : ''; };
    return '(01)' + r.gtin + (r.mfg ? '(11)' + y(r.mfg) : '') + (r.exp ? '(17)' + y(r.exp) : '') + (r.sn ? '(21)' + r.sn : '');
  }

  function center(P) { return { x: (P[0].x + P[1].x + P[2].x + P[3].x) / 4, y: (P[0].y + P[1].y + P[2].y + P[3].y) / 4 }; }
  function unionQuad(list) {
    var xs = [], ys = []; list.forEach(function (P) { P.forEach(function (p) { xs.push(p.x); ys.push(p.y); }); });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  }

  // Boîtes à codes séparés : chaque n° de série forme un matériel ; la référence et les dates les plus proches lui sont rattachées
  function groupPlain(plain) {
    var sns = plain.filter(function (p) { return p.kind === 'sn'; }), items = [];
    if (!sns.length) return items;
    var groups = sns.map(function (s) { return { sn: s, refs: [], dates: [] }; });
    plain.forEach(function (p) {
      if (p.kind === 'sn') return;
      var best = null, bd = Infinity;
      groups.forEach(function (g) { var d = Math.hypot(g.sn.c.x - p.c.x, g.sn.c.y - p.c.y); if (d < bd) { bd = d; best = g; } });
      if (best) (p.kind === 'ref' ? best.refs : best.dates).push({ p: p, d: bd });
    });
    groups.forEach(function (g) {
      g.refs.sort(function (a, b) { return a.d - b.d; });
      var dates = g.dates.map(function (x) { return x.p.value; }).sort(), today = new Date().toISOString().slice(0, 10);
      var exp = '', mfg = '';
      if (dates.length >= 2) { exp = dates[dates.length - 1]; mfg = dates[0]; }
      else if (dates.length === 1) { if (dates[0] >= today) exp = dates[0]; else mfg = dates[0]; }
      var parts = [g.sn.position].concat(g.refs.slice(0, 1).map(function (x) { return x.p.position; }), g.dates.map(function (x) { return x.p.position; }));
      items.push({ plain: true, gtin: '', sn: g.sn.value, exp: exp, mfg: mfg, ref: g.refs.length ? g.refs[0].p.value : '', format: 'linear', position: unionQuad(parts), raw: '' });
    });
    return items;
  }

  /** Tous les matériels MicroPort lisibles sur l'image, sans doublon, dans l'ordre de lecture. */
  async function decodeCanvas(srcCanvas) {
    var Z = await loadZXing();
    if (!Z) return [];
    var maxSide = Math.max(srcCanvas.width, srcCanvas.height), scales = [];
    [2600, 1500, 900].forEach(function (target) { var sc = Math.min(1, target / maxSide); if (!scales.some(function (x) { return Math.abs(x - sc) < 0.05; })) scales.push(sc); });
    var gs1 = new Map(), plain = new Map();
    for (var si = 0; si < scales.length; si++) {
      var sc = scales[si];
      try {
        var w = Math.max(1, Math.round(srcCanvas.width * sc)), h = Math.max(1, Math.round(srcCanvas.height * sc));
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(srcCanvas, 0, 0, w, h);
        var res = await Z.readBarcodes(ctx.getImageData(0, 0, w, h), {
          formats: ['DataMatrix', 'Code128', 'Code39'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 40
        });
        (res || []).forEach(function (r) {
          if (r.isValid === false || !r.text || !r.position) return;
          var p = r.position, pos = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map(function (pt) { return { x: pt.x / sc, y: pt.y / sc }; });
          var g = parseGS1(r.text);
          if (g) {
            if (g.gtin.indexOf(MICROPORT_GTIN) !== 0) return;          // autre fabricant
            var key = g.gtin + '|' + (g.sn || g.raw);
            if (!gs1.has(key)) { g.format = /matrix/i.test(r.format || '') ? 'dm' : 'linear'; g.position = pos; g.ref = ''; g.plain = false; gs1.set(key, g); }
            return;
          }
          var t = String(r.text).toUpperCase().trim(), kind = null, value = t, m;
          if (RE_REF.test(t)) kind = 'ref';
          else if ((m = RE_DATE.exec(t))) { kind = 'date'; value = m[1] + '-' + m[2] + '-' + m[3]; }
          else if (RE_SN.some(function (re) { return re.test(t); })) kind = 'sn';
          if (!kind) return;
          var c0 = center(pos), pk = kind + '|' + value + '|' + Math.round(c0.x / (maxSide * 0.04)) + '|' + Math.round(c0.y / (maxSide * 0.04));
          var dupe = false; plain.forEach(function (q) { if (q.kind === kind && q.value === value && Math.hypot(q.c.x - c0.x, q.c.y - c0.y) < maxSide * 0.05) dupe = true; });
          if (!dupe) plain.set(pk, { kind: kind, value: value, position: pos, c: c0 });
        });
      } catch (e) { console.error('Lecture codes-barres :', e); }
    }
    var known = new Set(); gs1.forEach(function (g) { if (g.sn) known.add(g.sn); });
    var all = Array.from(gs1.values()).concat(groupPlain(Array.from(plain.values())).filter(function (it) { return !known.has(it.sn); }));
    var band = maxSide * 0.06;
    all.sort(function (a, b) { var ca = center(a.position), cb = center(b.position); return Math.abs(ca.y - cb.y) > band ? ca.y - cb.y : ca.x - cb.x; });
    return all;
  }

  /** Photo (fichier) → canvas plafonné (mémoire du téléphone) */
  function fileToCanvas(file, max) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        var k = Math.min(1, (max || 3000) / Math.max(im.naturalWidth, im.naturalHeight));
        var c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c);
      };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
      im.src = url;
    });
  }

  /* ------------------------------ Étiquette recréée ------------------------------ */
  function frDate(iso) { return iso ? iso.split('-').reverse().join('/') : ''; }
  function fit(ctx, text, maxW, size, weight, family) {
    var s = size; do { ctx.font = weight + ' ' + s + 'px ' + family; s -= 2; } while (ctx.measureText(text).width > maxW && s > 14);
  }
  /** Dessine une étiquette nette à partir des informations lues. info : { model, ref, sn, exp, mfg, gtin } */
  function drawLabel(info) {
    var W = 1200, H = 430, F = '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.strokeStyle = '#000'; x.lineWidth = 4;
    (function (r) { x.beginPath(); x.moveTo(14 + r, 14); x.arcTo(W - 14, 14, W - 14, H - 14, r); x.arcTo(W - 14, H - 14, 14, H - 14, r); x.arcTo(14, H - 14, 14, 14, r); x.arcTo(14, 14, W - 14, 14, r); x.closePath(); x.stroke(); })(34);
    x.fillStyle = '#000'; x.textBaseline = 'alphabetic';
    x.font = '800 40px ' + F; x.fillText('MicroPort', 52, 84);
    fit(x, info.model || 'Modèle à préciser', 520, 76, '700', F); x.fillText(info.model || 'Modèle à préciser', 52, 190);
    var field = function (label, value, bx, by) {
      x.font = '800 30px ' + F; var lw = x.measureText(label).width + 26;
      x.lineWidth = 3; x.strokeRect(bx, by - 38, lw, 50); x.fillText(label, bx + 13, by);
      fit(x, value || '—', W - 60 - (bx + lw + 18), 42, '600', F); x.fillText(value || '—', bx + lw + 18, by + 2);
    };
    field('REF', info.ref, 52, 290);
    field('SN', info.sn, 610, 110);
    field('EXP', frDate(info.exp), 610, 200);
    if (info.mfg) field('FAB', frDate(info.mfg), 610, 290);
    var udi = gs1Text(info);
    x.font = '500 24px ' + F; if (udi) x.fillText(udi, 52, 356);
    x.font = 'italic 500 22px ' + F; x.fillStyle = '#444'; x.fillText('Étiquette recréée d’après les codes-barres de la boîte', 52, 394);
    return c;
  }

  window.LabelScan = { loadZXing: loadZXing, parseGS1: parseGS1, gs1Text: gs1Text, decodeCanvas: decodeCanvas, fileToCanvas: fileToCanvas, drawLabel: drawLabel };
})();
