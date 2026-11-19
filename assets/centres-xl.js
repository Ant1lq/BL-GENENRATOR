/* MicroPort Cardioflow — centres & fichier Excel des dépôts : couche commune aux pages
   BL (gestion des centres), Dépôts et Carte. Lecture de l'Excel mémorisé, rapprochement
   avec la liste des centres, statut d'inventaire / mise à jour des programmateurs,
   historique des inventaires générés (PDF conservés sur l'appareil). */
(function () {
  'use strict';
  function normText(s){ return String(s==null?"":s).normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase(); }
  function normKey(s){ return normText(s).replace(/[^a-z0-9]/g,""); }
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }

  /* ---------- Excel mémorisé (base « inventaire », clé « prog ») ---------- */
  function idb(){ return new Promise((res,rej)=>{ const r=indexedDB.open("inventaire",1); r.onupgradeneeded=()=>r.result.createObjectStore("kv"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
  async function kvGet(k){ try{ const db=await idb(); return await new Promise((res,rej)=>{ const q=db.transaction("kv").objectStore("kv").get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); }); }catch(e){ return undefined; } }
  async function kvSet(k,v){ try{ const db=await idb(); return await new Promise((res,rej)=>{ const tx=db.transaction("kv","readwrite"); tx.objectStore("kv").put(v,k); tx.oncomplete=()=>res(true); tx.onerror=()=>rej(tx.error); }); }catch(e){ return false; } }

  const HEAD = {st:"etatdesinventaires",cc:"codeclients",et:"etablissement",dp:"dept",lo:"localite",ve:"vendeur",zo:"zone",ca:"codearticle",de:"designation",lot:"ndelot",vs:"versionsmartview",k1:"ncpr4kit",k2:"nsmartecgkit",q:"quantitetheorique"};
  const ORDER=["st","cc","et","dp","lo","ve","zo","ca","de","lot","vs","k1","k2","q"];
  function cell(v,blankZero){ if(v==null) return ""; if(typeof v==="number"){ if(blankZero&&v===0) return ""; return String(v); } const s=String(v).trim(); if(blankZero&&s==="0") return ""; return s; }
  function parseAoa(aoa){
    let hr=-1, idx={};
    for(let i=0;i<Math.min(aoa.length,15);i++){ const keys=(aoa[i]||[]).map(normKey); if(keys.includes(HEAD.cc)){ hr=i; ORDER.forEach(k=>{ idx[k]=keys.indexOf(HEAD[k]); }); break; } }
    if(hr<0) throw new Error("ligne d'en-têtes introuvable (colonne « Code Clients »)");
    const need=["cc","et","de","lot"].filter(k=>idx[k]<0);
    if(need.length) throw new Error("colonnes manquantes : "+need.map(k=>HEAD[k]).join(", "));
    const items=[];
    for(let i=hr+1;i<aoa.length;i++){
      const r=aoa[i]; if(!r) continue;
      const g=k=>idx[k]>=0 ? r[idx[k]] : "";
      const cc=cell(g("cc")), lot=cell(g("lot")), de=cell(g("de"));
      if(!cc || (!lot && !de)) continue;
      const q=parseInt(cell(g("q")),10);
      items.push([cell(g("st")),cc,cell(g("et")),cell(g("dp")),cell(g("lo")),cell(g("ve")),cell(g("zo")),cell(g("ca")),de,lot,cell(g("vs"),true),cell(g("k1"),true),cell(g("k2"),true),(q>0?q:1)]);
    }
    return items;
  }
  function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=()=>rej(new Error("lecteur Excel indisponible")); document.head.appendChild(s); }); }
  // Lit un nouveau fichier Excel et le mémorise (remplace le précédent, comme dans Dépôts / Carte)
  async function importExcelFile(file){
    if(!window.XLSX) await loadScript("assets/vendor/xlsx.full.min.js");
    const wb=XLSX.read(await file.arrayBuffer(),{type:"array"}), sheet=wb.SheetNames[0];
    const items=parseAoa(XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,raw:true,defval:""}));
    if(!items.length) throw new Error("aucune ligne exploitable");
    const data={sheet,fileName:file.name,importedAt:new Date().toISOString(),items};
    if(!(await kvSet("prog",data))) throw new Error("mémorisation impossible sur cet appareil");
    return data;
  }

  /* ---------- Noms : normalisation et rapprochement ---------- */
  const GENERIC=new Set("CH CHU CHR CHRU CHI CHIC CHG CHS CENTRE HOSPITALIER HOSPITALIERS REGIONAL UNIVERSITAIRE HOPITAL HOPITAUX GCS GHT CLINIQUE POLYCLINIQUE DE DU DES LA LE LES ET D L SAS SA SARL SELARL SCM SELAS MR MME MRS LES DR DRS DOCTEUR SANTE POLE GROUPE HOSPITALISATION PRIVE PRIVEE AU EN SUR SOUS ST SAINT SAINTE STE".split(" "));
  function nName(s){ return normText(s).toUpperCase().replace(/[^A-Z0-9 ]+/g," ").replace(/\s+/g," ").trim(); }
  function kindOf(name){
    const n=nName(name);
    if(/^(MR|MME|MRS|MLLE|DR|DRS|SELARL|SCM|SELAS|CABINET)\b|\bLE DR\b|\bLES DRS?\b/.test(n)) return "D";
    if(/\b(POLYCLINIQUE|CLINIQUE|HOPITAL PRIVE|CLIN)\b/.test(n)) return "C";
    if(/^(CH|CHU|CHR|CHRU|CHI|CHIC|CHG|CHS|GH|GHT|HIA|HOPITAL|HOPITAUX|CENTRE HOSPITALIER|CHRU)\b|CENTRE HOSPITALIER/.test(n)) return "H";
    return "O";
  }
  function tokensOf(s){ return nName(s).split(" ").filter(t=>t.length>2&&!GENERIC.has(t)); }
  function communeOf(s){ return nName(String(s||"").replace(/\bCEDEX\b.*$/i,"").replace(/\(.*?\)/g,"")).replace(/\b(SAINT|STE?)\b/g,"ST").replace(/\s+/g," ").trim(); }
  function deptOfAddress(adr){ const m=String(adr||"").match(/\b(\d{5})\s+[^,\d]+$/)||String(adr||"").match(/\b(\d{5})\b/)||String(adr||"").match(/\((\d{2,3})\)\s*$/); if(!m) return ""; const p=m[1]; if(p.length<5) return p; return p.startsWith("20")?"20":(p.startsWith("97")?p.slice(0,3):p.slice(0,2)); }
  function communeOfAddress(adr){ const m=String(adr||"").match(/\b\d{5}\s+([^,(]+)/)||String(adr||"").match(/^([^,(]+)\s*\(\d{2,3}\)/); return m?communeOf(m[1]):""; }
  function similarity(a,b){
    if(a.dp && b.dp && a.dp!==b.dp) return 0;
    if(nName(a.nom)===nName(b.nom)) return 9;
    const ka=kindOf(a.nom), kb=kindOf(b.nom);
    const com = a.commune && b.commune && (a.commune===b.commune || a.commune.includes(b.commune) || b.commune.includes(a.commune));
    const ta=new Set(tokensOf(a.nom)); const tok=tokensOf(b.nom).some(t=>ta.has(t));
    const kind = ka===kb && ka!=="O";
    if(ka!==kb && ka!=="O" && kb!=="O") return 0;
    return (com?2:0)+(tok?2:0)+(kind?2:0);
  }
  function bestMatch(a, pool){ let best=null,bs=0; for(const b of pool){ const s=similarity(a,b); if(s>bs){ bs=s; best=b; } } return bs>=4?{item:best,score:bs}:null; }
  function verCmp(a,b){ const x=String(a).split(/[.\-]/).map(n=>parseInt(n,10)||0), y=String(b).split(/[.\-]/).map(n=>parseInt(n,10)||0); for(let i=0;i<Math.max(x.length,y.length);i++){ const d=(x[i]||0)-(y[i]||0); if(d) return d; } return 0; }
  function versTxt(x){ if(!x||!x.vers||!x.vers.size) return ''; return [...x.vers.entries()].sort((a,b)=>verCmp(b[0],a[0])).map(([v,n])=>`v${v}${n>1?' ×'+n:''}`).join(' · '); }

  /* ---------- Excel → centres de l'Excel ---------- */
  async function loadXl(){
    const d=await kvGet("prog"), xl={data:null,centres:new Map(),list:[],maxVer:null};
    if(!d||!d.items) return xl;
    xl.data=d;
    d.items.forEach(a=>{
      let c=xl.centres.get(a[1]);
      if(!c){ c={cc:a[1],nom:a[2],dp:a[3],lo:a[4],ve:a[5],commune:communeOf(a[4]),st:"",n:0}; xl.centres.set(a[1],c); }
      c.n++;
      const ver=String(a[10]||"").trim(); if(ver){ c.vers=c.vers||new Map(); c.vers.set(ver,(c.vers.get(ver)||0)+(a[13]||1)); }
      const s=String(a[0]||"").trim().toUpperCase();
      if(s==="A FAIRE") c.st="A FAIRE"; else if(s==="FAIT" && c.st!=="A FAIRE") c.st="FAIT";
    });
    xl.list=[...xl.centres.values()];
    let best=null; xl.list.forEach(c=>{ if(c.vers) c.vers.forEach((n,v)=>{ if(!best||verCmp(v,best)>0) best=v; }); });
    xl.maxVer=best;
    xl.list.forEach(c=>{ c.old=0; if(c.vers&&best) c.vers.forEach((n,v)=>{ if(verCmp(v,best)<0) c.old+=n; }); });
    return xl;
  }
  // Entrée Excel d'un centre : code client associé, sinon rapprochement par le nom (auto = à confirmer)
  function xlOf(c, xl){
    if(!c || !xl || !xl.list.length) return null;
    if(c.code_client==='-') return null;
    if(c.code_client){ const x=xl.centres.get(c.code_client); return x?{x,auto:false}:{missing:true,cc:c.code_client}; }
    const m=bestMatch({nom:c.nom,dp:deptOfAddress(c.adresse),commune:communeOfAddress(c.adresse)},xl.list);
    return m?{x:m.item,auto:true}:null;
  }
  // Statut d'inventaire prog : « fait » (Excel ou PDF généré depuis l'import de l'Excel), « todo », « unk »
  function progStatus(x, xl, lastProg){
    if(!x) return "unk";
    const since=xl&&xl.data&&xl.data.importedAt;
    if(lastProg && (!since || lastProg.date>=since)) return "fait";
    if(lsGet("done:"+(xl&&xl.data&&xl.data.sheet)+":"+x.cc)) return "fait";
    if(x.st==="FAIT") return "fait";
    if(x.st==="A FAIRE") return "todo";
    return "unk";
  }

  /* ---------- Historique des inventaires (table « inventaires ») ---------- */
  const KEEP=5;   // inventaires conservés par centre et par type
  function db(){ return window.supabase.createClient(); }
  async function listInv(){ try{ const {data}=await db().from("inventaires").select("*"); return (data||[]).sort((a,b)=>String(b.date).localeCompare(String(a.date))); }catch(e){ return []; } }
  function invFor(c, all, type){
    const k=nName(c.nom);
    return all.filter(r=>r.type===type && (r.centre_id===c.id || (!r.centre_id && ((c.code_client && r.code_client===c.code_client) || nName(r.centre_nom)===k))));
  }
  async function addInv(rec, pdfBytes){
    const name=(rec.type||"inv")+"_"+Date.now()+"_"+String(rec.file_name||"inventaire.pdf").replace(/[^A-Za-z0-9._-]+/g,"_");
    let ref=null;
    try{ await window.LocalDB.filePut("inventaires",name,new Blob([pdfBytes],{type:"application/pdf"}),"application/pdf"); ref="local://inventaires/"+name; }catch(e){ console.warn("PDF non conservé",e); }
    const row=Object.assign({},rec,{pdf_ref:ref,date:rec.date||new Date().toISOString()});
    const {data,error}=await db().from("inventaires").insert(row).select(); if(error) throw error;
    // on ne garde que les derniers inventaires de ce centre pour ce type
    try{
      const all=await listInv();
      const same=all.filter(r=>r.type===row.type && ((row.centre_id && r.centre_id===row.centre_id) || (!row.centre_id && nName(r.centre_nom)===nName(row.centre_nom))));
      for(const old of same.slice(KEEP)){ await removeInv(old); }
    }catch(e){}
    return data&&data[0];
  }
  async function removeInv(r){
    if(r.pdf_ref && String(r.pdf_ref).indexOf("local://inventaires/")===0){ try{ await window.LocalDB.fileRemove("inventaires",[r.pdf_ref.slice("local://inventaires/".length)]); }catch(e){} }
    await db().from("inventaires").delete().eq("id",r.id);
  }
  async function invBlob(r){ if(!r||!r.pdf_ref) return null; return window.LocalDB.fileGet("inventaires",r.pdf_ref.slice("local://inventaires/".length)); }

  /* ---------- Géocodage (réseau en bonus, comme sur la carte) ---------- */
async function jget(url,ms){ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms||7000); try{ const r=await fetch(url,{signal:c.signal}); if(!r.ok) throw new Error(r.status); return await r.json(); } finally{ clearTimeout(t); } }
async function banAddress(adr){
  const j=await jget('https://api-adresse.data.gouv.fr/search/?limit=1&q='+encodeURIComponent(adr));
  const f=(j.features||[])[0]; if(!f||(f.properties.score!=null&&f.properties.score<.4)) return null;
  return {lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0],label:f.properties.label};
}
async function banCommune(lo,dp){
  const q=String(lo||"").replace(/\bCEDEX\b.*$/i,"").trim(); if(!q) return null;
  const j=await jget('https://api-adresse.data.gouv.fr/search/?limit=8&type=municipality&q='+encodeURIComponent(q));
  const fs=j.features||[]; const f=fs.find(x=>!dp||String(x.properties.context||"").split(",")[0].trim()===dp)||(dp?null:fs[0]);
  if(!f) return null; return {lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0],label:f.properties.postcode+" "+f.properties.city};
}
function photonQueries(nom,lo){
  const commune=String(lo||"").replace(/\bCEDEX\b.*$/i,"").trim();
  let n=String(nom||"").replace(/\//g," ").replace(/\bCHRU\b/i,"CHRU").replace(/^CH\b/i,"Centre Hospitalier").replace(/\s+/g," ").trim();
  const k=kindOf(nom), qs=[n+" "+commune];
  if(k==="H") qs.push("Centre hospitalier "+commune);
  if(k==="C") qs.push("Clinique "+commune);
  return {qs,k,commune};
}
async function photonEtab(nom,lo,dp){
  const {qs,k,commune}=photonQueries(nom,lo); if(k==="D") return null;
  const want=new Set([...tokensOf(nom),...tokensOf(commune)]);
  for(const q of qs){
    try{
      const tag=(k==="H")?'&osm_tag=amenity:hospital':(k==="C")?'&osm_tag=amenity:clinic':'';
      const j=await jget('https://photon.komoot.io/api/?limit=8&lang=fr&bbox=-5.5,41.2,9.8,51.2&q='+encodeURIComponent(q)+tag,8000);
      for(const f of (j.features||[])){
        const p=f.properties||{}; const pc=String(p.postcode||"");
        if(/^\d\d$/.test(dp) && pc && !pc.startsWith(dp)) continue;
        if(!pc && /^\d\d$/.test(dp)) continue;
        const ok=tokensOf((p.name||"")+" "+(p.city||"")).some(t=>want.has(t));
        if(!ok) continue;
        const street=[p.housenumber,p.street].filter(Boolean).join(' ');
        const adr=[street,[p.postcode,p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        return {lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0],label:adr,exact:!!street};
      }
    }catch(e){}
  }
  return null;
}
// Pour un centre importé : établissement (Photon) → sinon centre de la commune (BAN)
async function geocodeImport(nom,lo,dp){
  const e=await photonEtab(nom,lo,dp);
  if(e){
    if(e.exact){ try{ const b=await banAddress(e.label); if(b) return {lat:b.lat,lng:b.lng,adresse:b.label,src:"etab"}; }catch(_){} }
    return {lat:e.lat,lng:e.lng,adresse:e.label||String(lo)+" ("+dp+")",src:"etab"};
  }
  try{ const c=await banCommune(lo,dp); if(c) return {lat:c.lat,lng:c.lng,adresse:c.label+" (adresse à compléter)",src:"commune"}; }catch(_){}
  return {lat:null,lng:null,adresse:String(lo||"").replace(/\bCEDEX\b.*$/i,"").trim()+" ("+dp+")",src:null};
}
// Centres déjà en base sans coordonnées : localisation automatique puis enregistrement

  window.CXL = { normText, nName, kindOf, communeOf, deptOfAddress, communeOfAddress, similarity, bestMatch, verCmp, versTxt,
    kvGet, kvSet, parseAoa, importExcelFile, loadXl, xlOf, progStatus,
    listInv, invFor, addInv, removeInv, invBlob, geocodeImport, banAddress };
})();
