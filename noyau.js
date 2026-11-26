// Noyau de l'appli Visages (téléphone seul) : logique pure + stockage dans le téléphone (IndexedDB).
// Rien ne part sur un serveur : les photos viennent de Gmail (e-mails de l'XVR) et restent dans le téléphone.

export const CATEGORIES = { resident: 'Résident', visiteur: 'Visiteur', personnel: 'Gardien / personnel', livreur: 'Livreur', autre: 'Autre' };
export const REGLAGES = { clientId: '', sujet: 'XVR ALERT', seuil: 0.6, secondes: 30, joursInconnus: 7, joursPassages: 30 };
const JOUR = 86400000;
export const HUMAN_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/dist/human.esm.js';
export const CONFIG_HUMAN = {  // visages seulement ; cacheSensitivity 0 = pas de cache entre photos différentes
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models/', backend: 'webgl', debug: false, cacheSensitivity: 0,
  face: { enabled: true, detector: { rotation: true, maxDetected: 20, minConfidence: 0.5, return: false }, mesh: { enabled: true },
    iris: { enabled: false }, description: { enabled: true }, emotion: { enabled: false }, antispoof: { enabled: false },
    liveness: { enabled: false }, attention: { enabled: false } },
  body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false },
};

export function cosinus(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na * nb) || 1);
}

/** Identité la plus proche (plus proche voisin sur toutes les empreintes) : {id, sim} ; id = null si sous le seuil. */
export function meilleureIdentite(emb, identites, seuil) {
  let best = { id: null, sim: 0 };
  for (const p of identites) for (const e of p.embs || []) {
    const sim = cosinus(emb, e);
    if (sim > best.sim) best = { id: p.id, sim };
  }
  return best.sim >= seuil ? best : { id: null, sim: best.sim };
}

/** Nouveau passage si cette personne n'a pas été vue sur cette caméra depuis `secondes`. Met à jour `dernierVu`. */
export function nouveauPassage(dernierVu, identId, camera, ts, secondes) {
  const cle = identId + '|' + camera, avant = dernierVu[cle];
  dernierVu[cle] = ts;
  return avant === undefined || ts - avant > secondes * 1000;
}

/** Morceaux [x, y, w, h] qui couvrent l'image : le détecteur ne voit pas un visage de 100 px dans une photo de 1920 px (vu en test),
 *  mais le voit dans un morceau de 720 px. Chevauchement > taille d'un visage, pour ne jamais le couper en deux. */
export function decoupage(W, H, t = 720, chev = 160) {
  const pos = (L) => { if (L <= t) return [0]; const p = []; for (let x = 0; x + t < L; x += t - chev) p.push(x); p.push(L - t); return p; };
  const m = [];
  for (const y of pos(H)) for (const x of pos(W)) m.push([x, y, Math.min(t, W), Math.min(t, H)]);
  return m;
}

/** Part de la plus petite boîte couverte par l'autre. Pas l'IoU : un demi-visage coupé par un morceau est DANS la grande boîte,
 *  mais l'IoU ne valait que 0.26 (visage de 767 px, vu en test) et le comptait comme une 2e personne. */
export function recouvrement(a, b) {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (x * y) / (Math.min(a[2] * a[3], b[2] * b[3]) || 1);
}

/** Même visage trouvé dans deux morceaux : on garde la plus grande boîte (le visage entier, pas un morceau coupé). */
export function garderUniques(visages, seuil = 0.5) {
  const garde = [];
  for (const v of [...visages].sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]))
    if (!garde.some(g => recouvrement(g.box, v.box) > seuil)) garde.push(v);
  return garde;
}

/** Visages d'une photo : image entière (grands visages) + morceaux (petits visages). `detecter(canvas)` → [{box, score, embedding}]. */
export async function trouverVisages(detecter, source) {
  const W = source.width, H = source.height, tous = [];
  for (const [x, y, w, h] of [[0, 0, W, H], ...(W > 720 || H > 720 ? decoupage(W, H) : [])]) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h);
    for (const f of await detecter(c)) if (f.embedding && f.embedding.length)
      tous.push({ box: [f.box[0] + x, f.box[1] + y, f.box[2], f.box[3]], score: f.score, embedding: Array.from(f.embedding) });
  }
  return garderUniques(tous);
}

export function decoderBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/** E-mail Gmail (format=full) de l'XVR → {id, ts, camera, images:[{attachmentId, data, filename}]} */
export function analyserMessage(msg) {
  const parts = [], textes = [];
  (function parcourir(p) { if (!p) return; parts.push(p); (p.parts || []).forEach(parcourir); })(msg.payload);
  for (const p of parts) if (p.mimeType === 'text/plain' && p.body && p.body.data) textes.push(new TextDecoder().decode(decoderBase64Url(p.body.data)));
  const images = parts.filter(p => /^image\//.test(p.mimeType || '') || /\.(jpe?g|png)$/i.test(p.filename || ''))
    .map(p => ({ attachmentId: p.body && p.body.attachmentId, data: p.body && p.body.data, filename: p.filename || '' }));
  const sources = textes.join('\n') + '\n' + images.map(i => i.filename).join('\n');
  const m = sources.match(/(?:channel|canal|ch)\D{0,20}?(\d{1,2})(?!\d)/i);  // « Alarm Input Channel: 3 », « Ch3_... » (\b raterait « 12_ »)
  return { id: msg.id, ts: Number(msg.internalDate), camera: m ? 'Caméra ' + Number(m[1]) : 'Caméra ?', images };
}

/** Ce que le ménage doit effacer (mêmes règles que l'agent du PC). */
export function aEffacer(identites, passages, maintenant, r) {
  const limI = maintenant - r.joursInconnus * JOUR, limP = maintenant - r.joursPassages * JOUR;
  const idents = new Set(identites.filter(p => (!p.nom && p.dernier < limI) ||
    (['visiteur', 'livreur', 'autre'].includes(p.categorie) && p.dernier < limP)).map(p => p.id));
  return { identites: [...idents], passages: passages.filter(x => x.ts < limP || idents.has(x.identite)).map(x => x.id) };
}

export function echapper(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- stockage dans le téléphone
export function ouvrirBase(nom = 'visages') {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(nom, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('identites', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('passages', { keyPath: 'id', autoIncrement: true }).createIndex('ts', 'ts');
      db.createObjectStore('meta');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

export function req(db, store, mode, fn) {
  return new Promise((ok, ko) => {
    const t = db.transaction(store, mode), r = fn(t.objectStore(store));
    t.oncomplete = () => ok(r && r.result);
    t.onerror = () => ko(t.error);
  });
}
export const tout = (db, s) => req(db, s, 'readonly', o => o.getAll());
export const lire = (db, s, k) => req(db, s, 'readonly', o => o.get(k));
export const ecrire = (db, s, v, k) => req(db, s, 'readwrite', o => (k === undefined ? o.put(v) : o.put(v, k)));
export const effacer = (db, s, k) => req(db, s, 'readwrite', o => o.delete(k));
