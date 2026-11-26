/* MicroPort Cardioflow — partage de l'appli et synchronisation entre deux téléphones.
   Sans serveur : un téléphone prépare un fichier, l'autre le reçoit et le FUSIONNE avec ses données
   (rien n'est supprimé ni écrasé à l'aveugle : centres reconnus par code client ou nom, tampon le plus
   récent conservé, médecins, inventaires et BL ajoutés s'ils manquent). */
(function () {
  'use strict';
  const LP = 'local://';
  const R = () => window.LocalDB.raw;
  function normText(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function nName(s) { return normText(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function refKey(u) { return (typeof u === 'string' && u.indexOf(LP) === 0) ? u.slice(LP.length) : null; }
  function blank(v) { return v == null || v === ''; }
  // Adresse « provisoire » d'un centre importé de l'Excel (ville + département) : une vraie adresse la remplace
  function provisional(a) { return blank(a) || /\(\d{2,3}\)\s*$/.test(String(a)) || /adresse à compléter/i.test(String(a)); }

  /* ---------------- Préparation du fichier ---------------- */
  // kind : 'share' (pour un collègue : centres, médecins, tampons, destinataires, inventaires, Excel)
  //        'sync'  (mon autre téléphone : tout, y compris BL, secteur, profils et signatures)
  async function buildPackage(kind, opts) {
    opts = opts || {};
    const L = window.LocalDB, t = {};
    t.centres = await L.rows('centres');
    t.medecins = await L.rows('medecins');
    t.centre_mails_compte = await L.rows('centre_mails_compte');
    t.inventaires = await L.rows('inventaires');
    if (kind === 'sync') {
      t.engineer_centers = await L.rows('engineer_centers');
      t.bons_livraison = await L.rows('bons_livraison');
      t.profils = await L.rows('profils');
    }
    const keys = new Set(), add = u => { const k = refKey(u); if (k) keys.add(k); };
    t.centres.forEach(c => { add(c.tampon_url); add(c.tampon_src); });
    t.medecins.forEach(m => { add(m.tampon_url); add(m.tampon_src); });
    t.inventaires.forEach(r => add(r.pdf_ref));
    if (kind === 'sync') {
      (t.profils || []).forEach(p => { if (p.signature_path) { add(p.signature_path); keys.add('signatures/' + String(p.signature_path).replace(/^local:\/\/signatures\//, '')); } });
      if (opts.photos) (t.bons_livraison || []).forEach(b => (b.items || []).forEach(it => add(it && it.img)));
    }
    const files = [];
    for (const k of keys) {
      const rec = await R().fileRec(k); if (!rec) continue;
      files.push({ key: k, type: rec.type, date: rec.date || 0, b64: R().bufToB64(rec.data) });
    }
    let from = '';
    try { const me = await L.me(), p = (await L.rows('profils')).find(x => x.email === me); from = (p && p.nom) || (me && !/@local$/.test(me) ? me : ''); } catch (e) {}
    const prog = await R().invGet('prog');
    const pkg = { app: 'mp-cardioflow', kind, format: 1, date: new Date().toISOString(), device: R().deviceId(), from, tables: t, inventaire: prog ? { prog } : {}, files };
    const blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const name = (kind === 'share' ? 'cardioflow-centres-' : 'cardioflow-synchro-') + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
    return { file: new File([blob], name, { type: 'application/json' }), counts: { centres: t.centres.length, tampons: t.centres.filter(c => c.tampon_url).length + t.medecins.filter(m => m.tampon_url).length, medecins: t.medecins.length, inventaires: t.inventaires.length, bl: (t.bons_livraison || []).length } };
  }

  /* ---------------- Fusion d'un fichier reçu ---------------- */
  async function mergePackage(data) {
    if (!data || data.app !== 'mp-cardioflow' || !data.tables) throw new Error("ce fichier ne vient pas de l'application");
    if (data.device && data.device === R().deviceId()) throw new Error('ce fichier a été préparé sur ce téléphone : ouvrez-le sur l\'autre');
    const T = data.tables, files = new Map((data.files || []).map(f => [f.key, f]));
    const sum = { centresNew: 0, centresUpd: 0, tampons: 0, medecins: 0, mails: 0, inventaires: 0, bl: 0, secteur: 0, profils: 0, excel: false };
    const copied = new Map();
    async function copyRef(u) {
      if (blank(u)) return null;
      const k = refKey(u); if (!k) return u;                 // ancienne adresse web : gardée telle quelle
      if (copied.has(u)) return copied.get(u);
      const f = files.get(k); let out = null;
      if (f) { if (!(await R().fileRec(k))) await R().fileRecPut(k, { type: f.type, data: R().b64ToBuf(f.b64), date: f.date || Date.now() }); out = u; }
      else if (await R().fileRec(k)) out = u;
      copied.set(u, out); return out;
    }
    // le tampon reçu remplace le mien s'il manque, si mon fichier a disparu, ou s'il est plus récent
    async function remoteWins(localU, remoteU) {
      if (blank(remoteU) || localU === remoteU) return false;
      const rk = refKey(remoteU); if (rk && !files.has(rk)) return false;
      if (blank(localU)) return true;
      const lk = refKey(localU), lr = lk ? await R().fileRec(lk) : null;
      if (lk && !lr) return true;
      const rd = rk ? (files.get(rk).date || 0) : 0, ld = lr ? (lr.date || 0) : 0;
      return rd > ld;
    }

    // Centres
    const L = await window.LocalDB.rows('centres');
    const byCC = new Map(), byName = new Map();
    const index = c => { if (c.code_client && c.code_client !== '-') byCC.set(c.code_client, c); byName.set(nName(c.nom), c); };
    L.forEach(index);
    const idMap = new Map(), nameMap = new Map();
    for (const r of (T.centres || [])) {
      const m = (r.code_client && r.code_client !== '-' && byCC.get(r.code_client)) || byName.get(nName(r.nom));
      if (m) {
        const upd = Object.assign({}, m); let ch = false;
        ['mail_bl', 'mail_pharmacie', 'code_client', 'vendeur', 'lat', 'lng', 'geo_src'].forEach(f => { if (blank(m[f]) && !blank(r[f])) { upd[f] = r[f]; ch = true; } });
        if (provisional(m.adresse) && !provisional(r.adresse)) { upd.adresse = r.adresse; ['lat', 'lng', 'geo_src'].forEach(f => { if (!blank(r[f])) upd[f] = r[f]; }); ch = true; }
        if (await remoteWins(m.tampon_url, r.tampon_url)) {
          const u = await copyRef(r.tampon_url);
          if (u) { upd.tampon_url = u; upd.tampon_src = await copyRef(r.tampon_src); upd.tampon_edit = r.tampon_edit || null; ch = true; sum.tampons++; }
        }
        if (ch) { await R().rowPut('centres', upd); index(upd); sum.centresUpd++; }
        idMap.set(r.id, m.id); nameMap.set(r.nom, m.nom);
      } else {
        const o = Object.assign({}, r);
        o.tampon_url = await copyRef(r.tampon_url); o.tampon_src = o.tampon_url ? await copyRef(r.tampon_src) : null;
        if (!o.tampon_url) o.tampon_edit = null;
        const n = await R().rowAdd('centres', o); index(n);
        idMap.set(r.id, n.id); nameMap.set(r.nom, n.nom); sum.centresNew++; if (n.tampon_url) sum.tampons++;
      }
    }
    const mapNom = n => nameMap.get(n) || n;

    // Médecins (par centre + nom)
    const meds = await window.LocalDB.rows('medecins'), mk = (c, n) => nName(c) + '|' + nName(n);
    const medBy = new Map(meds.map(m => [mk(m.centre_nom, m.nom), m]));
    for (const r of (T.medecins || [])) {
      const cn = mapNom(r.centre_nom), m = medBy.get(mk(cn, r.nom));
      if (m) {
        if (await remoteWins(m.tampon_url, r.tampon_url)) {
          const u = await copyRef(r.tampon_url);
          if (u) { await R().rowPut('medecins', Object.assign({}, m, { tampon_url: u, tampon_src: await copyRef(r.tampon_src), tampon_edit: r.tampon_edit || null })); sum.tampons++; }
        }
      } else {
        const o = Object.assign({}, r, { centre_nom: cn });
        o.tampon_url = await copyRef(r.tampon_url); o.tampon_src = o.tampon_url ? await copyRef(r.tampon_src) : null;
        const n = await R().rowAdd('medecins', o); medBy.set(mk(cn, n.nom), n); sum.medecins++; if (n.tampon_url) sum.tampons++;
      }
    }

    // Destinataires des BL (une liste par centre)
    const me = await window.LocalDB.me();
    const mails = await window.LocalDB.rows('centre_mails_compte'), mailBy = new Map(mails.map(x => [x.centre_id, x]));
    for (const r of (T.centre_mails_compte || [])) {
      const cid = idMap.get(r.centre_id); if (cid == null) continue;
      const m = mailBy.get(cid);
      if (!m) { const n = await R().rowAdd('centre_mails_compte', Object.assign({}, r, { centre_id: cid, centre_nom: mapNom(r.centre_nom), user_email: me || r.user_email })); mailBy.set(cid, n); sum.mails++; }
      else {
        const upd = Object.assign({}, m); let ch = false;
        ['mail_bl', 'mail_pharmacie'].forEach(f => { if (blank(m[f]) && !blank(r[f])) { upd[f] = r[f]; ch = true; } });
        if (ch) { await R().rowPut('centre_mails_compte', upd); sum.mails++; }
      }
    }

    // Inventaires (avec leurs PDF)
    const invs = await window.LocalDB.rows('inventaires');
    const ik = (type, cid, cnom, date) => type + '|' + (cid != null ? 'id' + cid : nName(cnom)) + '|' + date;
    const invSet = new Set(invs.map(x => ik(x.type, x.centre_id, x.centre_nom, x.date)));
    for (const r of (T.inventaires || [])) {
      const cid = r.centre_id != null ? (idMap.has(r.centre_id) ? idMap.get(r.centre_id) : null) : null;
      const cnom = mapNom(r.centre_nom), key = ik(r.type, cid, cnom, r.date);
      if (invSet.has(key)) continue;
      const o = Object.assign({}, r, { centre_id: cid, centre_nom: cnom, pdf_ref: await copyRef(r.pdf_ref) });
      await R().rowAdd('inventaires', o); invSet.add(key); sum.inventaires++;
    }

    if (data.kind === 'sync') {
      // Secteur
      const ec = await window.LocalDB.rows('engineer_centers'), ecSet = new Set(ec.map(x => x.engineer_name + '|' + x.center_name));
      for (const r of (T.engineer_centers || [])) {
        const cn = mapNom(r.center_name), k = r.engineer_name + '|' + cn; if (ecSet.has(k)) continue;
        await R().rowAdd('engineer_centers', Object.assign({}, r, { center_name: cn })); ecSet.add(k); sum.secteur++;
      }
      // BL (identifiant unique : le plus récent est gardé)
      const bls = await window.LocalDB.rows('bons_livraison'), blBy = new Map(bls.map(b => [b.id, b]));
      for (const r of (T.bons_livraison || [])) {
        const m = blBy.get(r.id);
        if (m && String(m.updated_at || '') >= String(r.updated_at || '')) continue;
        const o = Object.assign({}, r);
        if (o.centre) o.centre = mapNom(o.centre);
        o.items = await Promise.all((r.items || []).map(async it => { if (!it || !refKey(it.img)) return it; const u = await copyRef(it.img); return Object.assign({}, it, { img: u }); }));
        await R().rowPut('bons_livraison', o); sum.bl++;
      }
      // Profils (comptes et signatures)
      const pr = await window.LocalDB.rows('profils'), prBy = new Map(pr.map(p => [p.email, p]));
      for (const r of (T.profils || [])) {
        if (prBy.has(r.email)) continue;
        if (r.signature_path) { const k = 'signatures/' + String(r.signature_path).replace(/^local:\/\/signatures\//, ''), f = files.get(k); if (f && !(await R().fileRec(k))) await R().fileRecPut(k, { type: f.type, data: R().b64ToBuf(f.b64), date: f.date || Date.now() }); if (refKey(r.signature_path)) await copyRef(r.signature_path); }
        await R().rowPut('profils', r); sum.profils++;
      }
    }

    // Fichier Excel des dépôts : le plus récent des deux
    const rp = data.inventaire && data.inventaire.prog;
    if (rp && rp.items) {
      const lp = await R().invGet('prog');
      if (!lp || String(rp.importedAt || '') > String(lp.importedAt || '')) { await R().invPut('prog', rp); sum.excel = true; }
    }
    return sum;
  }

  function summary(s) {
    const p = (n, a, b) => n + ' ' + (n > 1 ? b : a);
    const parts = [];
    if (s.centresNew) parts.push(p(s.centresNew, 'centre ajouté', 'centres ajoutés'));
    if (s.centresUpd) parts.push(p(s.centresUpd, 'centre complété', 'centres complétés'));
    if (s.tampons) parts.push(p(s.tampons, 'tampon récupéré', 'tampons récupérés'));
    if (s.medecins) parts.push(p(s.medecins, 'médecin ajouté', 'médecins ajoutés'));
    if (s.mails) parts.push(p(s.mails, 'liste de destinataires', 'listes de destinataires'));
    if (s.inventaires) parts.push(p(s.inventaires, 'inventaire', 'inventaires'));
    if (s.bl) parts.push(p(s.bl, 'BL', 'BL'));
    if (s.secteur) parts.push(p(s.secteur, 'centre de secteur', 'centres de secteur'));
    if (s.profils) parts.push(p(s.profils, 'profil', 'profils'));
    if (s.excel) parts.push('Excel des dépôts mis à jour');
    return parts.length ? parts.join(', ') : 'tout était déjà à jour';
  }

  window.AppSync = { buildPackage, mergePackage, summary, APP_URL: 'https://ant1lq.github.io/BL-GENENRATOR/' };
})();
