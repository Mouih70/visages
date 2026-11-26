// Appli Visages (téléphone seul) : lit les e-mails de l'XVR dans Gmail, reconnaît les visages DANS le téléphone,
// garde l'historique DANS le téléphone. Aucun serveur à nous : seulement Gmail (lecture seule) et le CDN des modèles.
import * as N from './noyau.js';

const $ = s => document.querySelector(s), E = N.echapper, C = N.CATEGORIES;
let db, R, human, jeton = null;
const dernierVu = {};  // (personne, caméra) -> heure, pour ne pas compter 2 fois la même présence
const statut = t => ($('#statut').textContent = t || '');
const heure = ts => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function init() {
  db = await N.ouvrirBase();
  R = { ...N.REGLAGES, ...((await N.lire(db, 'meta', 'reglages')) || {}) };
  await menage();
  addEventListener('hashchange', afficher);
  document.addEventListener('submit', surFormulaire);
  document.addEventListener('click', surClic);
  $('#photos').addEventListener('change', ajouterPhotos);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (new URLSearchParams(location.search).has('test')) window.visages = { traiterPhoto, analyserEmails, db: () => db, poserJeton: j => (jeton = j) };
  afficher();
}

// ---------------------------------------------------------------- visages (dans le téléphone)
async function moteur() {
  if (!human) {
    statut('Chargement des modèles de visage (≈10 Mo, seulement la première fois)…');
    const { default: Human } = await import(N.HUMAN_URL);
    human = new Human(N.CONFIG_HUMAN);
    await human.load();  // pas de warmup() : il restait bloqué en test
  }
  return human;
}

function vignette(source, [x, y, w, h]) {
  const m = 0.4 * Math.max(w, h), c = document.createElement('canvas');
  c.width = c.height = 160;
  c.getContext('2d').drawImage(source, Math.max(0, x - m), Math.max(0, y - m), w + 2 * m, h + 2 * m, 0, 0, 160, 160);
  return c.toDataURL('image/jpeg', 0.8);
}

/** Une photo (e-mail de l'XVR ou photo ajoutée) → personnes reconnues ou nouveaux inconnus + passages. */
async function traiterPhoto(source, ts, camera, message) {
  const h = await moteur();
  const visages = (await N.trouverVisages(async c => (await h.detect(c)).face, source)).filter(v => v.box[2] >= 40);
  const identites = await N.tout(db, 'identites');
  for (const v of visages) {
    const m = N.meilleureIdentite(v.embedding, identites, R.seuil), photo = vignette(source, v.box);
    let p = identites.find(x => x.id === m.id);
    if (!p) {
      p = { nom: null, appartement: '', categorie: null, embs: [], premier: ts, dernier: ts, nb: 0, photo, taille: 0 };
      p.id = await N.ecrire(db, 'identites', p);
      identites.push(p);
    }
    if (p.embs.length < 20 && m.sim < 0.85) p.embs.push(v.embedding);  // garder des vues variées
    p.premier = Math.min(p.premier, ts); p.dernier = Math.max(p.dernier, ts);
    if (v.box[2] > (p.taille || 0)) { p.photo = photo; p.taille = v.box[2]; }  // meilleure photo = plus grand visage
    if (N.nouveauPassage(dernierVu, p.id, camera, ts, R.secondes)) {
      p.nb++;
      await N.ecrire(db, 'passages', { ts, camera, identite: p.id, vignette: photo, message });
    }
    await N.ecrire(db, 'identites', p);
  }
  return visages.length;
}

async function ajouterPhotos(e) {
  try {
    let n = 0;
    for (const f of e.target.files) n += await traiterPhoto(await createImageBitmap(f), f.lastModified || Date.now(), 'Photo ajoutée', null);
    statut(`${e.target.files.length} photo(s) analysée(s), ${n} visage(s).`);
  } catch (err) { statut('Erreur : ' + err.message); }
  e.target.value = '';
  afficher();
}

// ---------------------------------------------------------------- Gmail (lecture seule)
function connecterGmail() {
  return new Promise((ok, ko) => {
    if (!R.clientId) return ko(new Error("réglez d'abord l'identifiant Google dans Réglages."));
    const lancer = () => google.accounts.oauth2.initTokenClient({
      client_id: R.clientId, scope: 'https://www.googleapis.com/auth/gmail.readonly',
      callback: r => { if (r.error) return ko(new Error(r.error)); jeton = r.access_token; setTimeout(() => (jeton = null), (r.expires_in - 60) * 1000); ok(); },
    }).requestAccessToken();
    if (window.google && google.accounts) return lancer();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.onload = lancer; s.onerror = () => ko(new Error('Google ne répond pas.'));
    document.head.append(s);
  });
}

async function gmail(chemin) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + chemin, { headers: { Authorization: 'Bearer ' + jeton } });
  if (r.status === 401) { jeton = null; throw new Error('connexion Gmail expirée : relancez.'); }
  if (!r.ok) throw new Error('Gmail ' + r.status);
  return r.json();
}

async function analyserEmails() {
  if (!jeton) await connecterGmail();
  const meta = (await N.lire(db, 'meta', 'gmail')) || { vus: [], depuis: Date.now() - 7 * 86400000 };
  const q = encodeURIComponent(`subject:"${R.sujet}" has:attachment after:${Math.floor(meta.depuis / 1000) - 3600}`);
  const ids = [];
  let page = '';
  do {
    const r = await gmail(`messages?q=${q}&maxResults=100${page ? '&pageToken=' + page : ''}`);
    ids.push(...(r.messages || []).map(m => m.id));
    page = r.nextPageToken;
  } while (page && ids.length < 1000);
  const vus = new Set(meta.vus), nouveaux = ids.filter(id => !vus.has(id)), msgs = [];
  for (const [k, id] of nouveaux.entries()) { statut(`Lecture des e-mails ${k + 1}/${nouveaux.length}…`); msgs.push(N.analyserMessage(await gmail(`messages/${id}?format=full`))); }
  msgs.sort((a, b) => a.ts - b.ts);  // dans l'ordre, pour bien grouper les présences
  let n = 0;
  for (const [k, m] of msgs.entries()) {
    statut(`Analyse des photos ${k + 1}/${msgs.length}…`);
    for (const im of m.images) {
      const data = im.data || (await gmail(`messages/${m.id}/attachments/${im.attachmentId}`)).data;
      n += await traiterPhoto(await createImageBitmap(new Blob([N.decoderBase64Url(data)], { type: 'image/jpeg' })), m.ts, m.camera, m.id);
    }
    vus.add(m.id);
    meta.depuis = Math.max(meta.depuis, m.ts);
    await N.ecrire(db, 'meta', { vus: [...vus].slice(-3000), depuis: meta.depuis }, 'gmail');  // reprise possible si coupure
  }
  statut(msgs.length ? `${msgs.length} nouvel(s) e-mail(s), ${n} visage(s).` : 'Aucun nouvel e-mail de l\'XVR.');
}

// ---------------------------------------------------------------- pages
async function afficher() {
  const page = (location.hash || '#passages').slice(1);
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('actif', a.hash === '#' + page));
  const [ids, ps] = await Promise.all([N.tout(db, 'identites'), N.tout(db, 'passages')]);
  $('#page').innerHTML = page === 'identifier' ? cartes(ids.filter(p => !p.nom), ps, true)
    : page === 'personnes' ? cartes(ids.filter(p => p.nom), ps, false)
    : page === 'reglages' ? reglages() : passages(ids, ps);
}

const nomHtml = p => !p ? '<span class="petit">supprimé</span>' : p.nom
  ? E(p.nom) + (p.categorie && p.categorie !== 'resident' ? ` <span class="badge ${p.categorie}">${C[p.categorie]}</span>` : '')
  : `<span class="badge">Inconnu #${p.id}</span> <a href="#identifier">identifier</a>`;

function passages(ids, ps) {
  const parId = Object.fromEntries(ids.map(p => [p.id, p])), minuit = new Date().setHours(0, 0, 0, 0);
  const auj = ps.filter(x => x.ts >= minuit).map(x => parId[x.identite]).filter(Boolean);
  const lignes = [...ps].sort((a, b) => b.ts - a.ts).slice(0, 300).map(x => {
    const p = parId[x.identite], cls = !p || !p.nom ? 'inconnu' : p.categorie && p.categorie !== 'resident' ? 'visiteur' : '';
    return `<tr class="${cls}"><td><img class="v" src="${x.vignette}"></td><td>${nomHtml(p)}</td><td>${E(p && p.appartement)}</td>
      <td>${E(x.camera)}</td><td>${heure(x.ts)}${x.message ? `<br><a class="petit" href="https://mail.google.com/mail/u/0/#all/${E(x.message)}" target="_blank" rel="noopener">e-mail</a>` : ''}</td></tr>`;
  }).join('');
  return `<h1>Passages</h1><div class="actions"><button data-action="emails">📥 Analyser les e-mails de l'XVR</button>
    <button data-action="photos" class="sup">📷 Ajouter des photos</button></div>
    <div class="kpi"><div><b>${auj.length}</b>passages aujourd'hui</div><div><b class="rouge">${auj.filter(p => !p.nom).length}</b>d'inconnus</div>
    <div><b>${auj.filter(p => ['visiteur', 'livreur', 'autre'].includes(p.categorie)).length}</b>de visiteurs</div></div>
    <div class="tableau"><table><tr><th></th><th>Personne</th><th>Appart.</th><th>Caméra</th><th>Heure</th></tr>
    ${lignes || '<tr><td colspan="5">Aucun passage. Touchez « Analyser les e-mails de l\'XVR ».</td></tr>'}</table></div>`;
}

function cartes(liste, ps, inconnus) {
  const titre = inconnus ? `<h1>À identifier</h1><p class="petit">Résident : nom + appartement. Visiteur, livreur… : nom facultatif
    (appartement = chez qui). Les inconnus non classés sont effacés après ${R.joursInconnus} jours, les visiteurs après ${R.joursPassages} jours sans passage.</p>`
    : '<h1>Personnes connues</h1>';
  const html = liste.sort((a, b) => inconnus ? b.dernier - a.dernier : (a.categorie || '').localeCompare(b.categorie || '') || (a.appartement || '').localeCompare(b.appartement || ''))
    .map(p => {
      const cat = p.categorie || 'resident', mini = ps.filter(x => x.identite === p.id).sort((a, b) => b.ts - a.ts).slice(0, 4);
      return `<div class="carte"><img class="g" src="${p.photo}"><div><b>${E(p.nom || 'Inconnu #' + p.id)}</b>
        ${p.appartement ? '— ' + E(p.appartement) : ''} ${p.nom ? `<span class="badge ${cat}">${C[cat]}</span>` : ''}</div>
        <div class="petit">${p.nb} passage(s) · du ${heure(p.premier)} au ${heure(p.dernier)}</div>
        <div>${mini.map(x => `<img class="v" src="${x.vignette}">`).join(' ')}</div>
        <form data-id="${p.id}"><select name="categorie">${Object.entries(C).map(([k, v]) => `<option value="${k}" ${k === cat ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input name="nom" placeholder="Nom (facultatif sauf pour un résident)" value="${E(p.nom || '')}">
        <input name="appartement" placeholder="Appartement (visiteur : chez qui)" value="${E(p.appartement || '')}">
        <div class="actions" style="margin-top:8px"><button>Enregistrer</button><button type="button" class="sup" data-action="supprimer" data-id="${p.id}">Supprimer</button></div></form></div>`;
    }).join('');
  return titre + `<div class="grille">${html || '<p>Rien ici pour l\'instant.</p>'}</div>`;
}

function reglages() {
  return `<h1>Réglages</h1><form id="reglages">
    <label>Identifiant client Google (pour lire la Gmail de l'XVR)<input name="clientId" value="${E(R.clientId)}" placeholder="xxxx.apps.googleusercontent.com"></label>
    <label>Sujet des e-mails de l'XVR<input name="sujet" value="${E(R.sujet)}"></label>
    <label>Seuil de reconnaissance (0.6 conseillé ; plus haut = moins de confusions, plus de doublons)<input name="seuil" type="number" step="0.01" min="0.3" max="0.95" value="${R.seuil}"></label>
    <label>Secondes avant de compter un nouveau passage<input name="secondes" type="number" min="0" value="${R.secondes}"></label>
    <div class="actions" style="margin-top:14px"><button>Enregistrer les réglages</button></div></form>
    <h1 style="margin-top:22px">Sauvegarde</h1><p class="petit">Tout est stocké dans ce téléphone. Faites une sauvegarde de temps en temps
    (le fichier contient les visages : gardez-le pour vous).</p>
    <div class="actions"><button data-action="exporter">💾 Sauvegarder</button><button data-action="importer" class="sup">📂 Restaurer</button>
    <button data-action="tout-effacer" class="danger">Tout effacer</button></div>`;
}

// ---------------------------------------------------------------- actions
async function surClic(e) {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  try {
    if (a === 'emails') { b.disabled = true; await analyserEmails(); }
    if (a === 'photos') return $('#photos').click();
    if (a === 'supprimer' && confirm('Supprimer cette personne et ses photos ?')) await supprimerPersonne(Number(b.dataset.id));
    if (a === 'exporter') exporter();
    if (a === 'importer') return importer();
    if (a === 'tout-effacer' && confirm('Effacer toutes les personnes et tous les passages de ce téléphone ?')) {
      for (const s of ['identites', 'passages']) await N.req(db, s, 'readwrite', o => o.clear());
      await N.effacer(db, 'meta', 'gmail');
      statut('Tout est effacé.');
    }
  } catch (err) { statut('Erreur : ' + err.message); }
  afficher();
}

async function surFormulaire(e) {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f));
  if (f.id === 'reglages') {
    R = { ...R, clientId: d.clientId.trim(), sujet: d.sujet.trim() || N.REGLAGES.sujet, seuil: Number(d.seuil) || N.REGLAGES.seuil, secondes: Number(d.secondes) };
    await N.ecrire(db, 'meta', R, 'reglages');
    return statut('Réglages enregistrés.');
  }
  const id = Number(f.dataset.id), cat = C[d.categorie] ? d.categorie : 'resident';
  const nom = d.nom.trim(), appart = d.appartement.trim();
  if (cat === 'resident' && !(nom && appart)) return statut('Pour un résident, il faut le nom et l\'appartement.');
  const ids = await N.tout(db, 'identites'), p = ids.find(x => x.id === id);
  const cible = ids.find(x => x.id !== id && nom && x.nom && x.nom.toLowerCase() === nom.toLowerCase() && (x.appartement || '').toLowerCase() === appart.toLowerCase());
  if (cible) {  // même nom + même appartement qu'une personne connue : on regroupe (empreintes et passages)
    cible.embs = [...cible.embs, ...p.embs].slice(0, 30);
    cible.nb += p.nb; cible.premier = Math.min(cible.premier, p.premier); cible.dernier = Math.max(cible.dernier, p.dernier);
    if ((p.taille || 0) > (cible.taille || 0)) { cible.photo = p.photo; cible.taille = p.taille; }
    for (const x of (await N.tout(db, 'passages')).filter(x => x.identite === id)) await N.ecrire(db, 'passages', { ...x, identite: cible.id });
    await N.ecrire(db, 'identites', cible);
    await N.effacer(db, 'identites', id);
    statut(`Regroupé avec ${cible.nom}.`);
  } else {
    await N.ecrire(db, 'identites', { ...p, nom: nom || `${C[cat]} #${id}`, appartement: appart, categorie: cat });
    statut('Enregistré.');
  }
  afficher();
}

async function supprimerPersonne(id) {
  for (const x of (await N.tout(db, 'passages')).filter(x => x.identite === id)) await N.effacer(db, 'passages', x.id);
  await N.effacer(db, 'identites', id);
}

async function menage() {
  const [ids, ps] = await Promise.all([N.tout(db, 'identites'), N.tout(db, 'passages')]);
  const e = N.aEffacer(ids, ps, Date.now(), R);
  for (const id of e.passages) await N.effacer(db, 'passages', id);
  for (const id of e.identites) await N.effacer(db, 'identites', id);
}

async function exporter() {
  const donnees = { version: 1, date: Date.now(), identites: await N.tout(db, 'identites'), passages: await N.tout(db, 'passages') };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(donnees)], { type: 'application/json' }));
  a.download = `visages-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

function importer() {
  const i = document.createElement('input');
  i.type = 'file'; i.accept = 'application/json';
  i.onchange = async () => {
    try {
      const d = JSON.parse(await i.files[0].text());
      if (!Array.isArray(d.identites) || !Array.isArray(d.passages)) throw new Error('fichier non reconnu');
      for (const s of ['identites', 'passages']) await N.req(db, s, 'readwrite', o => o.clear());
      for (const p of d.identites) await N.ecrire(db, 'identites', p);
      for (const x of d.passages) await N.ecrire(db, 'passages', x);
      statut(`Restauré : ${d.identites.length} personne(s), ${d.passages.length} passage(s).`);
    } catch (err) { statut('Erreur : ' + err.message); }
    afficher();
  };
  i.click();
}

init().catch(err => statut('Erreur au démarrage : ' + err.message));
