# Visages — mise en route

Appli : **https://mouih70.github.io/visages/**. Elle lit les e-mails de l'enregistreur (XVR) dans une Gmail dédiée,
reconnaît les visages **dans le téléphone**, et garde l'historique **dans le téléphone**. Aucun serveur.

## 1. Une Gmail dédiée (jamais votre Gmail personnelle)
1. Créez une nouvelle adresse Gmail, utilisée seulement par l'XVR.
2. Compte Google → Sécurité → activez la **validation en deux étapes**.
3. Compte Google → Sécurité → **Mots de passe des applications** → créez-en un nommé « XVR ». Notez les 16 lettres.
   (L'XVR peut être lu par un pirate : c'est pour ça que cette boîte ne doit servir qu'à lui.)

## 2. L'XVR envoie une photo à chaque mouvement
Menu principal → Réseau → **Courriel** :
| Champ | Valeur |
|---|---|
| Activer | coché |
| Serveur SMTP | `smtp.gmail.com` |
| Port | `465` avec Type de codage **SSL** (sinon `587` avec **TLS**) |
| Utilisateur / Expéditeur / Destinataire | la Gmail dédiée |
| Mot de passe | les 16 lettres du mot de passe d'application |
| Sujet | `XVR ALERT` (laisser tel quel) |
| Pièce jointe | coché |
| Intervalle | 30 s (120 s rate des passages ; Gmail limite à environ 500 envois par jour) |

Puis bouton **Test** : un e-mail doit arriver dans la Gmail dédiée.
Ensuite : Évènement → Détection vidéo → **Détection de mouvement**, caméra 3 (porte) : activer, cocher **Envoyer un e-mail** et **Capture**.

## 3. L'identifiant Google de l'appli (une seule fois)
Connecté avec la **Gmail dédiée**, sur https://console.cloud.google.com :
1. Créer un projet « Visages ».
2. API et services → Bibliothèque → **Gmail API** → Activer.
3. Google Auth Platform → **Écran de consentement** : type **Externe**, nom « Visages », votre e-mail de contact.
   Audience : laisser en **Test**, et ajouter la Gmail dédiée dans **Utilisateurs test**.
4. Clients → **Créer un client** → type **Application Web** →
   Origines JavaScript autorisées : `https://mouih70.github.io` (sans rien après). Pas d'URI de redirection.
5. Copiez l'**ID client** (`….apps.googleusercontent.com`).

## 4. Sur le téléphone
1. Ouvrez l'appli dans Chrome → menu ⋮ → **Ajouter à l'écran d'accueil**.
2. Réglages → collez l'ID client → Enregistrer.
3. Passages → **Analyser les e-mails de l'XVR** → choisissez la Gmail dédiée (lecture seule).
4. À identifier : donnez une catégorie à chaque visage (résident : nom + appartement).
5. Réglages → **Sauvegarder** de temps en temps (le fichier contient les visages : gardez-le pour vous).

Vérification du téléphone (facultatif) : https://mouih70.github.io/visages/tests.html doit finir par « OK ».

## Cadre légal
La reconnaissance faciale demande une autorisation préalable de la CNDP et l'information des résidents (affichage à l'entrée).
Les photos passent par Google (Gmail).
