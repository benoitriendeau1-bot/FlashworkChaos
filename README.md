# FlashWorkChaos

Harnais déterministe pour un tenant de développement FlashWork isolé. Node 20+, aucun `npm install`.

Le seed `847291` est le seed de régression canonique. Un même seed et les mêmes options de plan produisent les mêmes hashs. Le réseau ne participe pas à la construction du plan. Un futur mode multi-seeds pourra explorer d’autres combinaisons ; il n’est pas implémenté.

## Commandes PowerShell

```powershell
npm test
npm run plan -- --seed=847291 --po=1 --run-id=final-verification
```

Le dry-run affiche les hashs et quitte avant toute construction de client HTTP. Il n’écrit ni dans l’API ni dans la base. Le `run-id` du dry-run ne fait pas partie du hash.

Run complet, uniquement contre le backend local déjà démarré :

```powershell
$env:FLASHWORK_BASE_URL = 'http://localhost:3001'
$env:FLASHWORK_CLIENT_ID = 'SharkInc'
$env:FLASHWORK_USER_ID = 'admin@local.dev'
npm start -- --seed=847291 --po=1 --run-id=<nouvel-identifiant>
```

Commande de référence : `npm start -- --seed=847291 --po=1 --run-id=<nouvel-identifiant>`.

Pour reproduire un finding, garder le même seed et choisir un **nouveau** run-id. Ne jamais rejouer un identifiant déjà consommé, même si `summary.json` est absent : les objets de catalogue et les PO suffisent à le consommer.

Un hôte distant exige `$env:FLASHWORK_ALLOW_REMOTE = 'yes'`. Ne jamais viser un tenant de production.

Avant un run live, vérifier trois choses :

1. le commit BE réellement chargé ;
2. l’arbre BE propre ;
3. le processus du port 3001 qui charge ce dépôt BE et qui a démarré **après** ce commit, avec `GET /health` à 200.

## Seed, run-id et planHash

- Le **seed** choisit les actions et les valeurs. `847291` reconstruit les hashs canoniques ci-dessous.
- Le **run-id** nomme les objets créés (`MI-CH…`, `POCH…`, pièces, outils). Il reste hors du hash. Un run-id consommé ne doit jamais être réutilisé.
- Le **planHash** est le SHA-256 du plan sérialisé avec les clés triées, calculé avant le premier appel HTTP. La date d’effectivité et le run-id n’y entrent pas.

## Rapports

Chaque requête est ajoutée à `runs/<run-id>/events.jsonl`. Le verdict est `runs/<run-id>/summary.json`.

`events.jsonl` peut atteindre plusieurs centaines de Mo. Ces journaux contiennent des données de tenant. Ils ne sont pas versionnés. Le seul emplacement commitable, pour un petit exemple choisi explicitement, est `runs/examples/`.

Si le processus s’arrête avant le résumé normal, un `summary.json` avec `fatal: true` est écrit dès qu’une erreur non gérée survient après l’ouverture du journal. Il contient le seed, le run-id, le préfixe, le hash de manufacturing et la pile. L’identifiant reste consommé si des objets ont été créés. Lire la fin de `events.jsonl` et ce résumé, puis reprendre avec un nouvel identifiant.

La couverture action par action est décrite dans `docs/coverage-dashboard.md`. `npm run coverage -- --run-id=<id>` reconstruit `coverage.json` et `coverage.md` sans appel HTTP.

Le dashboard local se consulte sans démarrer FlashWork :

```powershell
npm --prefix dashboard/web install
npm run dashboard
```

L’installation des paquets Vue et Vite se fait une fois, dans `dashboard/web`. Ensuite `npm run dashboard` construit l’interface et ouvre `http://127.0.0.1:4173`. Le serveur ne démarre pas de seed, n’écrit pas dans `runs/` et n’appelle pas le backend.

`npm run dashboard:dev` lance l’API sur le port 4174 et Vite sur `http://127.0.0.1:4173`, avec le proxy `/api`. `npm run dashboard:server` sert l’API et le build déjà produit. `npm run dashboard:build` ne fait que la construction. Le détail des écrans, des filtres et de `not_proved` est dans `docs/coverage-dashboard.md`.

## Drapeaux

`pass` est la conjonction de toutes les tranches. Une tranche a en général `capturePass` et `chaosPass`.

- **valid action** : action prévue en succès, acceptée, état relu conforme.
- **invalid action correctement refusée** : le statut et le code prévus, sans mutation ni événement nouveau.
- **finding produit** : acceptation d’une action invalide, rejet d’une action valide, ou écriture partielle. Un HTTP 4xx n’est jamais un succès à lui seul.
- **erreur de harnais** : cible absente, sonde impossible, ou réponse sans HTTP. Elle compte comme action bloquée et fait échouer la tranche. Ce n’est pas une couverture.
- **décision de contrat** : comportement observé et documenté, ni finding ni attaque réussie.
- **not applicable** : hors du contrat testable dans cette session.
- **blocked** : prérequis manquant. Une action bloquée n’est pas une rejection réussie.
- **unhandled** : HTTP 500 ou réponse inutilisable. Le chaos échoue.

Les courses jugent l’état relu et l’audit, pas seulement l’ordre des réponses HTTP.

## Couverture permanente

Le run `essai047`, seed `847291`, sur le BE `d9906dd92a459588977506108592df0d6a59e44a` et le FE `fd43454733b8edd31f1f397b9e89d55e61744819`, a terminé avec toutes les tranches vertes, 0 finding, 0 erreur de harnais, 0 action bloquée, 0 action unhandled et 0 HTTP 500. `npm test` était à 173/173 avant ce gel.

| Tranche | Hash canonique |
| --- | --- |
| manufacturing | `a3c00d17d5e9f38bcd930fca577b5f2fe37394d5c0c6608e654cb47788544490` |
| DATA (number, text, boolean, date, enum) | `957f44c3b454efe52f6097fc833653762fd0b80206c4e58079461e14b194ba27` |
| parts, huit modes de traçabilité | `f2b1ee5d7dffc5dee3f77307e7f3c9274009ecb95b88801e3e3727dfff3c055b` |
| tools required, optional, info_only | `666f68646113ac61871c857504f3b90cf137c4464806aef8663b8f4bc7905488` |
| signatures Pass, Skip, Reopen | `d56350b0cce98b4ff9f4c22063d42d68b03e8ec42a4a7972938799aae61f0fff` |
| lifecycle, complétion, as-built | `55e6efefa3f6d58a58e32babd3a47f122e7d53e491a8aaabbafee98a88019317` |
| ANDON | `bb3e0bb11f980bcb34b6e1da566ae24219bd7d4517521382288e57d36b397f39` |
| NCR | `f20963d682c7becc0a4e6976bdb813703ca2ed12a41c36006f49a166564e5580` |
| VARIANCE | `448c3a2d3570058ebd3069d47daa4595c46f86923655f591530b3e1701941dce` |
| RUN 2+ | `55dc191bcb28c63cc64ebdf643de836af0fd3a9b56f404a9f9d4449da145d5dd` |
| SV2+ | `e623bfbc72341ffcaab101dcc18a85c12c21339b69225352ce66c3434ad67a12` |

Le même run couvre les courses contre annulation, le traveler, le full export, la concurrence, l’atomicité, l’audit et l’absence d’écriture partielle. Les délais de course sont des `delayMs` du plan, donc dans le hash. Il n’y a pas d’attente supplémentaire non documentée.

## Limites résiduelles

Ces points restent des décisions de contrat ou des non-couvertures. Ils ne sont pas des échecs.

- Un NCR ouvert ne bloque pas le run suivant : `createNextRun` ne lit pas les NCR.
- Le mode debug accorde les privilèges de création. Les HTTP 403 ne sont pas couverts.
- Aucun second tenant n’est créé dans la session.
- Le client ne désigne pas le Work Order de la visite précédente : le serveur le choisit.
- Le production order n’a pas de statut `Closed`.
- Les horodatages d’audit sont ceux du serveur. L’horloge système n’est pas modifiée.
- Aucune route ne rouvre une visite annulée.
- Selon la route, un PO `OnHold` ne bloque pas la création Andon, NCR ou Variance. Le work order n’a pas de statut `OnHold`. La capture pendant un PO `OnHold` isolé, et la signature pendant ce hold isolée du gate d’opération, restent hors couverture.
- La formule est not-applicable. `OPERATION_MANDATORY_FORWARD_BLOCK` peut quand même démarrer le work order et le PO. Un noop d’identité d’unité peut démarrer un work order `Ready`.
- `useQty` d’un outil ne pilote pas la capture.
- Un skip de captures obligatoires vides peut répondre 200 lorsque le skip, une raison active et un commentaire sont présents.
