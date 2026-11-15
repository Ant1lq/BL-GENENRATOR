# MicroPort Cardioflow — version locale

Application de bons de livraison et de dépôts qui fonctionne **entièrement sur l'iPhone**, sans compte ni connexion.

## Ce que contient ce dépôt
Uniquement le code de l'application. **Aucune donnée** (centres, médecins, BL, tampons, signatures) : tout est enregistré sur l'appareil.

## Installation sur l'iPhone
1. Ouvrir l'adresse du site dans **Safari**, avec du réseau.
2. Bouton Partager → **Sur l'écran d'accueil**.
3. Lancer l'appli depuis l'icône et la laisser ouverte une minute : elle se copie sur l'iPhone (y compris le lecteur de codes-barres).
4. Réglages → *Récupérer les données de l'ancienne version* (une seule fois), ou créer son profil.

Ensuite l'appli s'utilise sans réseau. Seuls le fond de carte et les suggestions d'adresse ont besoin d'internet.

## Sauvegarde
Réglages → Sauvegarde : crée un fichier `.json` à ranger dans Fichiers / iCloud Drive. Le même écran permet de le restaurer.

## Mise à jour de l'appli
Après modification des fichiers, changer `VERSION` dans `sw.js` : les iPhone récupèrent la nouvelle version au lancement suivant avec du réseau.

## Organisation
- `index.html` accueil · `bl.html` bons de livraison, centres, médecins, tampons, historique · `depot.html` dépôts · `carte.html` carte · `admin.html` réglages
- `assets/local-db.js` base de données locale (IndexedDB), sauvegarde/restauration
- `sw.js` fonctionnement hors ligne · `assets/vendor/` bibliothèques embarquées
