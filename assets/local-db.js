/* =====================================================================================
   MicroPort CardioFlow — base de données locale (100 % sur l'appareil)
   -------------------------------------------------------------------------------------
   Toutes les données (centres, médecins, secteurs, BL, profils, tampons, signatures,
   photos) sont enregistrées dans IndexedDB, sur l'iPhone. Aucun serveur, aucun compte.

   Ce fichier expose :
     • window.supabase.createClient()  → client local, même syntaxe que l'ancien client
       distant (from().select().eq()…, storage.from().upload()…), pour que les pages
       fonctionnent à l'identique sans réseau ;
     • window.LocalDB → outils : sauvegarde / restauration, profil actif, images.
   ===================================================================================== */
(function () {
  'use strict';

  var DB_NAME = 'mp-cardioflow-local', DB_VERSION = 1;
  var LOCAL_PREFIX = 'local://';
  var ME_KEY = 'mp_local_me';

  // Tables : clé primaire + valeurs par défaut (reprend la structure de l'ancienne base)
  var TABLES = {
    centres:             { key: 'id', auto: true, defaults: function () { return { implanteur: true }; } },
    medecins:            { key: 'id', auto: true },
    engineer_centers:    { key: 'id', auto: true },
    centre_mails_compte: { key: 'id', auto: true },
    bons_livraison:      { key: 'id', uuid: true, defaults: function () { return { items: [], updated_at: new Date().toISOString() }; } },
    profils:             { key: 'email', defaults: function () { return { role: 'ingenieur', afficher_nom: false }; } }
  };
  // Filtres ignorés : l'appli n'a plus qu'un seul utilisateur, ses listes d'envoi s'appliquent toujours.
  var IGNORED_FILTERS = { centre_mails_compte: { user_email: true } };

  /* ------------------------------ IndexedDB ------------------------------ */
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        Object.keys(TABLES).forEach(function (t) {
          if (!db.objectStoreNames.contains(t)) db.createObjectStore(t, { keyPath: TABLES[t].key, autoIncrement: !!TABLES[t].auto });
        });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files'); // clé : "bucket/chemin"
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error || new Error('Stockage local indisponible')); };
      req.onblocked = function () { reject(new Error('Stockage local occupé par un autre onglet')); };
    });
    return dbPromise;
  }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function txDone(tx) { return new Promise(function (res, rej) { tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; tx.onabort = function () { rej(tx.error || new Error('Opération annulée')); }; }); }

  async function allRows(table) {
    var db = await openDb();
    return reqP(db.transaction(table).objectStore(table).getAll());
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ------------------------------ Requêtes ------------------------------ */
  function Query(table) {
    this.table = table; this.op = 'select'; this.cols = '*'; this.filters = []; this.orders = [];
    this.max = null; this.one = null; this.payload = null; this.returning = false;
  }
  Query.prototype.select = function (cols) { if (this.op === 'select') this.cols = cols || '*'; else { this.returning = true; this.cols = cols || '*'; } return this; };
  Query.prototype.insert = function (rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; };
  Query.prototype.upsert = function (rows) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; };
  Query.prototype.update = function (values) { this.op = 'update'; this.payload = values || {}; return this; };
  Query.prototype.delete = function () { this.op = 'delete'; return this; };
  Query.prototype._f = function (fn, col) {
    var ign = IGNORED_FILTERS[this.table];
    if (!(ign && ign[col])) this.filters.push(fn);
    return this;
  };
  Query.prototype.eq = function (col, val) { return this._f(function (r) { return r[col] === val || (r[col] != null && val != null && String(r[col]) === String(val)); }, col); };
  Query.prototype.neq = function (col, val) { return this._f(function (r) { return !(r[col] === val || (r[col] != null && val != null && String(r[col]) === String(val))); }, col); };
  Query.prototype.in = function (col, vals) { var s = (vals || []).map(String); return this._f(function (r) { return r[col] != null && s.indexOf(String(r[col])) !== -1; }, col); };
  Query.prototype.is = function (col, val) { return this._f(function (r) { return val === null ? r[col] == null : r[col] === val; }, col); };
  Query.prototype.ilike = function (col, pattern) {
    var re = new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
    return this._f(function (r) { return re.test(String(r[col] == null ? '' : r[col])); }, col);
  };
  Query.prototype.order = function (col, opts) { this.orders.push({ col: col, asc: !(opts && opts.ascending === false) }); return this; };
  Query.prototype.limit = function (n) { this.max = n; return this; };
  Query.prototype.single = function () { this.one = 'single'; return this; };
  Query.prototype.maybeSingle = function () { this.one = 'maybe'; return this; };
  Query.prototype.then = function (ok, ko) { return this._run().then(ok, ko); };
  Query.prototype.catch = function (ko) { return this._run().catch(ko); };

  Query.prototype._match = function (r) { for (var i = 0; i < this.filters.length; i++) if (!this.filters[i](r)) return false; return true; };
  Query.prototype._project = function (rows) {
    var cols = this.cols;
    if (!cols || cols.trim() === '*') return rows.map(clone);
    var list = cols.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    return rows.map(function (r) { var o = {}; list.forEach(function (c) { o[c] = r[c] === undefined ? null : clone(r[c]); }); return o; });
  };
  Query.prototype._finish = function (rows) {
    var out = this._project(rows);
    if (this.one) {
      if (out.length === 1) return { data: out[0], error: null };
      if (out.length === 0 && this.one === 'maybe') return { data: null, error: null };
      return { data: null, error: { message: out.length ? 'Plusieurs lignes trouvées' : 'Aucune ligne trouvée', code: 'PGRST116' } };
    }
    return { data: out, error: null };
  };
  Query.prototype._run = async function () {
    var self = this, def = TABLES[this.table];
    try {
      if (!def) throw new Error('Table inconnue : ' + this.table);
      var db = await openDb();

      if (this.op === 'select') {
        var rows = (await allRows(this.table)).filter(function (r) { return self._match(r); });
        this.orders.slice().reverse().forEach(function (o) {
          rows.sort(function (a, b) {
            var x = a[o.col], y = b[o.col], c;
            if (x == null && y == null) c = 0; else if (x == null) c = 1; else if (y == null) c = -1;
            else if (typeof x === 'number' && typeof y === 'number') c = x - y;
            else c = String(x).localeCompare(String(y), 'fr', { sensitivity: 'base', numeric: true });
            return o.asc ? c : -c;
          });
        });
        if (this.max != null) rows = rows.slice(0, this.max);
        return this._finish(rows);
      }

      if (this.op === 'insert' || this.op === 'upsert') {
        var tx = db.transaction(this.table, 'readwrite'), store = tx.objectStore(this.table), done = txDone(tx), inserted = [];
        var now = new Date().toISOString();
        for (var i = 0; i < this.payload.length; i++) {
          var row = Object.assign({}, def.defaults ? def.defaults() : {}, { created_at: now }, clone(this.payload[i]));
          if (def.uuid && !row[def.key]) row[def.key] = uuid();
          if (def.auto && row[def.key] == null) delete row[def.key];
          if (!def.auto && !def.uuid && (row[def.key] == null || row[def.key] === '')) throw new Error('Identifiant manquant');
          if (def.key === 'email') row.email = String(row.email).toLowerCase();
          var key = await reqP(this.op === 'upsert' ? store.put(row) : store.add(row));
          row[def.key] = key; inserted.push(row);
        }
        await done;
        return this.returning ? this._finish(inserted) : { data: null, error: null };
      }

      if (this.op === 'update' || this.op === 'delete') {
        var tx2 = db.transaction(this.table, 'readwrite'), st = tx2.objectStore(this.table), done2 = txDone(tx2);
        var all = await reqP(st.getAll()), touched = [];
        for (var j = 0; j < all.length; j++) {
          var r = all[j];
          if (!this._match(r)) continue;
          if (this.op === 'delete') { st.delete(r[def.key]); touched.push(r); }
          else {
            var oldKey = r[def.key], next = Object.assign({}, r, clone(this.payload));
            if (next[def.key] !== oldKey) st.delete(oldKey);
            st.put(next); touched.push(next);
          }
        }
        await done2;
        return this.returning ? this._finish(touched) : { data: null, error: null };
      }
      throw new Error('Opération inconnue');
    } catch (e) {
      console.error('[LocalDB]', this.table, this.op, e);
      var msg = (e && e.name === 'ConstraintError') ? 'Cet élément existe déjà' : ((e && e.message) || String(e));
      return { data: null, error: { message: msg } };
    }
  };

  /* ------------------------------ Fichiers (images) ------------------------------ */
  var urlCache = {}; // "bucket/chemin" -> blob: URL
  function fkey(bucket, path) { return bucket + '/' + String(path).replace(/^\/+/, ''); }
  function forgetUrl(k) { if (urlCache[k]) { try { URL.revokeObjectURL(urlCache[k]); } catch (e) {} delete urlCache[k]; } }

  async function filePut(bucket, path, blob, type) {
    var buf = (blob instanceof ArrayBuffer) ? blob : await new Response(blob).arrayBuffer();
    var db = await openDb(), tx = db.transaction('files', 'readwrite'), k = fkey(bucket, path);
    tx.objectStore('files').put({ type: type || (blob && blob.type) || 'application/octet-stream', data: buf, date: Date.now() }, k);
    await txDone(tx); forgetUrl(k);
    return k;
  }
  async function fileGet(bucket, path) {
    var db = await openDb();
    var rec = await reqP(db.transaction('files').objectStore('files').get(fkey(bucket, path)));
    return rec ? new Blob([rec.data], { type: rec.type }) : null;
  }
  async function fileUrl(bucket, path) {
    var k = fkey(bucket, path);
    if (urlCache[k]) return urlCache[k];
    var b = await fileGet(bucket, path);
    if (!b) return null;
    return (urlCache[k] = URL.createObjectURL(b));
  }
  async function fileRemove(bucket, paths) {
    var db = await openDb(), tx = db.transaction('files', 'readwrite'), st = tx.objectStore('files');
    (paths || []).forEach(function (p) { var k = fkey(bucket, p); st.delete(k); forgetUrl(k); });
    await txDone(tx);
  }
  function blobToDataUrl(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; r.readAsDataURL(blob); }); }

  // Référence locale d'une image : "local://bucket/chemin"
  function isLocalRef(u) { return typeof u === 'string' && u.indexOf(LOCAL_PREFIX) === 0; }
  function parseRef(u) { var s = String(u).slice(LOCAL_PREFIX.length), i = s.indexOf('/'); return { bucket: s.slice(0, i), path: s.slice(i + 1) }; }
  async function resolveUrl(u) { if (!isLocalRef(u)) return u || null; var p = parseRef(u); return fileUrl(p.bucket, p.path); }
  async function refToDataUrl(u) { if (!isLocalRef(u)) return u || null; var p = parseRef(u), b = await fileGet(p.bucket, p.path); return b ? blobToDataUrl(b) : null; }

  function Bucket(name) { this.name = name; }
  Bucket.prototype.upload = async function (path, blob, opts) {
    try { await filePut(this.name, path, blob, (opts && opts.contentType) || (blob && blob.type)); return { data: { path: path }, error: null }; }
    catch (e) { console.error('[LocalDB] fichier', e); return { data: null, error: { message: quotaMsg(e) } }; }
  };
  Bucket.prototype.download = async function (path) {
    try { var b = await fileGet(this.name, path); return b ? { data: b, error: null } : { data: null, error: { message: 'Fichier introuvable' } }; }
    catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
  };
  Bucket.prototype.createSignedUrl = async function (path) {
    try { var u = await fileUrl(this.name, path); return u ? { data: { signedUrl: u }, error: null } : { data: null, error: { message: 'Fichier introuvable' } }; }
    catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
  };
  Bucket.prototype.getPublicUrl = function (path) { return { data: { publicUrl: LOCAL_PREFIX + this.name + '/' + path } }; };
  Bucket.prototype.remove = async function (paths) {
    try { await fileRemove(this.name, paths); return { data: paths, error: null }; }
    catch (e) { return { data: null, error: { message: e.message || String(e) } }; }
  };
  function quotaMsg(e) { return (e && e.name === 'QuotaExceededError') ? "Espace de stockage de l'iPhone insuffisant" : ((e && e.message) || String(e)); }

  /* ------------------------------ Profil actif (remplace la connexion) ------------------------------ */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  async function me() {
    var saved = (lsGet(ME_KEY) || '').toLowerCase(), profils = [];
    try { profils = await allRows('profils'); } catch (e) {}
    if (saved && profils.some(function (p) { return p.email === saved; })) return saved;
    if (profils.length) { profils.sort(function (a, b) { return String(a.created_at || '').localeCompare(String(b.created_at || '')); }); lsSet(ME_KEY, profils[0].email); return profils[0].email; }
    return saved || 'moi@local';
  }
  function setMe(email) { lsSet(ME_KEY, String(email || '').toLowerCase()); }
  async function session() { var email = await me(); return { data: { session: { user: { email: email }, access_token: 'local' } }, error: null }; }

  var client = {
    from: function (table) { return new Query(table); },
    storage: { from: function (bucket) { return new Bucket(bucket); } },
    auth: {
      getSession: session,
      signInWithPassword: async function () { var s = await session(); return { data: { user: s.data.session.user, session: s.data.session }, error: null }; },
      signOut: async function () { return { error: null }; }
    }
  };

  /* ------------------------------ Sauvegarde / restauration ------------------------------ */
  var LS_KEYS = ['gtinModels', 'bl_autosave_enabled', 'stampMode', 'stampImg', 'stampTxt', 'stampScale', 'sbStampId', ME_KEY];

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), out = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(out);
  }
  function b64ToBuf(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  // Inventaire Excel mémorisé par les pages Dépôts / Carte (base « inventaire »)
  function openInv() { return new Promise(function (res, rej) { var r = indexedDB.open('inventaire', 1); r.onupgradeneeded = function () { r.result.createObjectStore('kv'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  async function invDump() {
    var out = {};
    try {
      var db = await openInv(), st = db.transaction('kv').objectStore('kv');
      var keys = await reqP(st.getAllKeys()), vals = await reqP(st.getAll());
      keys.forEach(function (k, i) { try { JSON.stringify(vals[i]); out[k] = vals[i]; } catch (e) {} });
      db.close();
    } catch (e) {}
    return out;
  }
  async function invRestore(obj) {
    if (!obj) return;
    try {
      var db = await openInv(), tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv');
      Object.keys(obj).forEach(function (k) { st.put(obj[k], k); });
      await txDone(tx); db.close();
    } catch (e) { console.error('[LocalDB] inventaire', e); }
  }

  /** Renvoie un Blob JSON contenant toutes les données de l'appli. opts.photos === false : sans les photos des BL. */
  async function exportBackup(opts) {
    opts = opts || {};
    var db = await openDb(), parts = [], tables = {};
    for (var t in TABLES) tables[t] = await allRows(t);
    var ls = {}; LS_KEYS.forEach(function (k) { var v = lsGet(k); if (v != null) ls[k] = v; });
    var head = { app: 'mp-cardioflow', format: 1, date: new Date().toISOString(), tables: tables, localStorage: ls, inventaire: await invDump() };
    parts.push(JSON.stringify(head).slice(0, -1), ',"files":[');
    var st = db.transaction('files').objectStore('files');
    var keys = await reqP(st.getAllKeys()), first = true;
    for (var i = 0; i < keys.length; i++) {
      if (opts.photos === false && String(keys[i]).indexOf('bl-items/') === 0) continue;
      var rec = await reqP(db.transaction('files').objectStore('files').get(keys[i]));
      if (!rec) continue;
      parts.push((first ? '' : ',') + JSON.stringify({ key: keys[i], type: rec.type, b64: bufToB64(rec.data) }));
      first = false;
    }
    parts.push(']}');
    return new Blob(parts, { type: 'application/json' });
  }

  /** Restaure une sauvegarde. mode 'replace' (défaut) : remplace tout ; 'merge' : ajoute / met à jour sans rien supprimer. */
  async function importBackup(source, opts) {
    opts = opts || {};
    var data = typeof source === 'string' ? JSON.parse(source) : (source instanceof Blob ? JSON.parse(await new Response(source).text()) : source);
    if (!data || data.app !== 'mp-cardioflow' || !data.tables) throw new Error("Ce fichier n'est pas une sauvegarde de l'application.");
    var replace = opts.mode !== 'merge', db = await openDb();
    var names = Object.keys(TABLES).concat(['files']);
    var tx = db.transaction(names, 'readwrite'), done = txDone(tx), counts = {};
    if (replace) names.forEach(function (n) { tx.objectStore(n).clear(); });
    Object.keys(TABLES).forEach(function (t) {
      var rows = data.tables[t] || []; counts[t] = rows.length;
      rows.forEach(function (r) { if (r && r[TABLES[t].key] != null) tx.objectStore(t).put(r); });
    });
    var files = data.files || []; counts.files = files.length;
    files.forEach(function (f) { tx.objectStore('files').put({ type: f.type, data: f.data || b64ToBuf(f.b64), date: Date.now() }, f.key); });
    await done;
    Object.keys(urlCache).forEach(forgetUrl);
    if (data.localStorage) Object.keys(data.localStorage).forEach(function (k) { if (LS_KEYS.indexOf(k) !== -1) lsSet(k, data.localStorage[k]); });
    await invRestore(data.inventaire);
    return counts;
  }

  async function stats() {
    var db = await openDb(), out = { tables: {}, files: 0, bytes: 0 };
    for (var t in TABLES) out.tables[t] = await reqP(db.transaction(t).objectStore(t).count());
    await new Promise(function (res, rej) {
      var c = db.transaction('files').objectStore('files').openCursor();
      c.onsuccess = function () { var cur = c.result; if (!cur) return res(); out.files++; out.bytes += (cur.value.data && cur.value.data.byteLength) || 0; cur.continue(); };
      c.onerror = function () { rej(c.error); };
    });
    return out;
  }
  async function wipe() {
    var db = await openDb(), names = Object.keys(TABLES).concat(['files']), tx = db.transaction(names, 'readwrite');
    names.forEach(function (n) { tx.objectStore(n).clear(); });
    await txDone(tx); Object.keys(urlCache).forEach(forgetUrl);
  }
  // Supprime les photos de BL qui ne sont plus rattachées à aucun BL (après suppression / modification)
  async function cleanOrphanPhotos() {
    var used = {}, bls = await allRows('bons_livraison');
    bls.forEach(function (b) { (b.items || []).forEach(function (it) { if (isLocalRef(it && it.img)) used[it.img.slice(LOCAL_PREFIX.length)] = 1; }); });
    var db = await openDb(), keys = await reqP(db.transaction('files').objectStore('files').getAllKeys());
    var dead = keys.filter(function (k) { return String(k).indexOf('bl-items/') === 0 && !used[k]; });
    if (dead.length) { var tx = db.transaction('files', 'readwrite'); dead.forEach(function (k) { tx.objectStore('files').delete(k); forgetUrl(k); }); await txDone(tx); }
    return dead.length;
  }
  // Demande à iOS de ne pas effacer les données de l'appli quand l'espace manque
  function persist() { try { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist(); } catch (e) {} return Promise.resolve(false); }

  window.supabase = { createClient: function () { return client; } };
  window.LocalDB = {
    client: client, tables: Object.keys(TABLES), rows: allRows,
    filePut: filePut, fileGet: fileGet, fileUrl: fileUrl, fileRemove: fileRemove,
    isLocalRef: isLocalRef, resolveUrl: resolveUrl, refToDataUrl: refToDataUrl, blobToDataUrl: blobToDataUrl,
    me: me, setMe: setMe, exportBackup: exportBackup, importBackup: importBackup,
    stats: stats, wipe: wipe, cleanOrphanPhotos: cleanOrphanPhotos, persist: persist
  };

  /* ------------------------------ Mode hors ligne (service worker) ------------------------------ */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('Service worker indisponible :', e); }); });
    // Première ouverture : dès que le mode hors ligne est actif, on recharge une fois la page si elle
    // utilise des bibliothèques (elles sont alors servies depuis l'appareil).
    if (!navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        try {
          if (!document.querySelector('script[src^="assets/vendor"]') || sessionStorage.getItem('mp_sw_reload')) return;
          sessionStorage.setItem('mp_sw_reload', '1'); location.reload();
        } catch (e) {}
      });
    }
  }
  persist();
})();

/* Lecteur de codes-barres (zxing-wasm) : seul composant téléchargé, une fois, lors d'un lancement
   avec du réseau ; le service worker le conserve ensuite sur l'appareil pour le hors-ligne. */
(function () {
  var URL_ZX = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/iife/reader/index.js', loading = null;
  window.LocalDB.barcodeReady = function () { try { return localStorage.getItem('mp_zxing_ready') === '1'; } catch (e) { return false; } };
  window.LocalDB.warmBarcode = function () {
    if (loading) return loading;
    loading = new Promise(function (resolve) {
      function warm() {
        var Z = window.ZXingWASM;
        if (!(Z && Z.readBarcodes)) { loading = null; return resolve(false); }
        try {
          Promise.resolve(Z.readBarcodes(new ImageData(8, 8), { formats: ['DataMatrix'] }))
            .then(function () { try { localStorage.setItem('mp_zxing_ready', '1'); } catch (e) {} resolve(true); })
            .catch(function () { loading = null; resolve(false); });
        } catch (e) { loading = null; resolve(false); }
      }
      if (window.ZXingWASM && window.ZXingWASM.readBarcodes) return warm();
      var s = document.createElement('script');
      s.src = URL_ZX; s.crossOrigin = 'anonymous'; s.onload = warm;
      s.onerror = function () { loading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return loading;
  };
})();
