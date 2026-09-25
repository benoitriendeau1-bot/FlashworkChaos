# Dashboard de couverture

Ce document fixe le contrat de couverture et le serveur de consultation. Il ne décrit pas l’interface web : elle viendra ensuite.

## Pipeline actuel

`npm start` compile un plan déterministe à partir du seed, puis exécute les tranches dans l’ordre. Le plan est haché avant tout appel HTTP. Le seed choisit les actions. Le `run-id` ne sert qu’à nommer les objets.

Chaque tranche a son générateur, son runner et son juge. Ils ne partagent pas les mêmes noms de champs.

| Tranche | Plan | Identifiant | Verdicts du juge | Preuve d’état |
|---|---|---|---|---|
| DATA | `dataCapturePlan` | `action.id` (`numeric-nominal`, `enum-unknown`, …) | `accepted`, `edge-accepted`, `correctly-rejected`, `invariant`, `unexpected-acceptance`, `unexpected-rejection`, `blocked`, `unhandled` | empreinte DATA avant/après, et parfois l’historique d’un point |
| Parts / tools | `partsCapturePlan`, `toolsCapturePlan` | `action.id` | `accepted`, `correctly-rejected`, `invariant`, `blocked` | relecture du work order, pas le même objet que DATA |
| Signatures | `signaturesCapturePlan` | `action.id` | ajoute `contract-decision` | historique de signature |
| Lifecycle | `lifecyclePlan` | actions du plan de cycle | `accepted` / finding | événements de work order |
| Andon / NCR | plans dédiés | `action.id` | `contract-decision`, `harness`, `not-applicable` | statut Andon ou NCR relu |
| Variance / Run / Service Visit | plans dédiés | `action.id` | `contract-decision`, `not-applicable`, `harness`, `failures[]` | le juge lit `outcome` et un tableau `failures`, pas `finding` |

`summary.json` agrège les drapeaux `*Pass`, les hashes, les compteurs et les findings. Il ne dit pas, action par action, si l’état a été relu.

`events.jsonl` est le journal brut. Une ligne est un événement `{ seed, seq, label, method, route, body, status, response, phase }`. Le label DATA est l’`action.id`. Les courses utilisent `id-1` et `id-2`. L’historique utilise `id-history-before` et `id-history-after`. Les relectures de work order sont le label `reread WO`. Ce fichier peut dépasser 250 Mo. Le navigateur ne doit jamais le recevoir en entier.

Les compteurs DATA (`validCapturesAccepted`, `invalidActionsCorrectlyRejected`, `concurrencyChecks`, …) mesurent des familles, pas des scénarios. Un HTTP 4xx y compte comme un rejet correct seulement après que le juge a comparé l’oracle, l’empreinte et, pour certains enums, l’historique.

## Pipeline cible

Après le run, sans nouvel appel métier et sans modifier le plan :

1. `summary.json` reste le verdict produit.
2. `events.jsonl` reste la preuve brute.
3. `coverage.json` est le document compact du dashboard.
4. `coverage.md` est le même contenu, lisible.

`npm run coverage -- --run-id=<id>` reconstruit ces deux fichiers depuis le disque. La commande ne fait aucun appel HTTP et ne réécrit pas le plan. Elle est idempotente, à `meta.generatedAt` près.

`npm run dashboard:server` sert les rapports déjà écrits. Il ne reconstruit rien. L’interface web n’existe pas encore.

## Schéma `coverage.json`

`coverageSchemaVersion` vaut `1`.

```text
run              seed, runId, finishedAt, options, commits, pass, fatal, flags
hashes           hashes de plans copiés du résumé, plus le hash DATA recalculé
journal          lines, missing, truncated, unknownEvents
aggregates       planned, executed, proved, byVerdict pour DATA
slices.data      status reported, mêmes compteurs, actions[]
slices.<autre>   status not_migrated
meta.generatedAt horodatage non déterministe
```

Chaque action DATA contient au minimum `slice`, `scenarioId`, `actionId`, `label`, `category`, `planned`, `executed`, `proved`, `applicability`, `request`, `expected`, `observed`, `verdict`.

Les champs suivants ne sont présents que lorsqu’ils existent : `stateBefore`, `stateAfter`, `stateAfterDetail`, `auditBefore`, `auditAfter`, `findingSeverity`, `message`, `sourceEventSeqs`, `raceGroup`, `reproduction`.

`category` pour les cinq types est `number`, `text`, `boolean`, `date` ou `enum`. Le plan appelle encore le numérique `numeric` ; le rapport le range sous `number`. Le `dataType` réel (par exemple `measurement`) reste dans le plan, pas dans une liste écrite à la main.

Verdicts :

| Verdict | Sens |
|---|---|
| `pass` | envoyé, relu, conforme à l’oracle |
| `finding` | écart produit prouvé |
| `harness_error` | le harnais n’a pas pu juger |
| `blocked` | prérequis manquant |
| `unhandled` | HTTP 500 ou statut réseau 0 |
| `contract_decision` | le produit répond, le contrat n’est pas tranché |
| `not_applicable` | le plan marque l’action non applicable |
| `not_executed` | planifiée, jamais envoyée |
| `not_proved` | envoyée, ou oracle sans relecture suffisante |

Un HTTP 4xx dont l’empreinte a changé est un `finding`, pas un `pass`. Un 4xx sans empreinte avant/après est `not_proved`.

Les secrets (`password`, `identifier`, `email`, `token`, `secret`) sont remplacés par `[REDACTED]`. Une chaîne de plus de 120 caractères devient `{ truncated, length, sha256, preview }`. Unicode court est conservé.

## Génération

La génération est une fonction pure `buildCoverage`, plus l’écriture atomique.

1. Relire le plan avec `dataCapturePlan(scenario)`. Cela ne modifie pas le scénario ni les hashes.
2. Lire les preuves compactes posées par le runner DATA pendant le run : une ligne par action, avec la ligne cible, le booléen « empreinte changée », le booléen « les autres points sont stables » et le booléen d’historique. Le runner ne change ni l’ordre des appels, ni les oracles, ni le corps envoyé.
3. Sinon, indexer `events.jsonl` en streaming. Les gros `reread WO` de la phase `capture` sont parsés ligne par ligne, réduits à l’empreinte DATA, puis oubliés.
4. Classer chaque action du plan. Le rapport ne contient pas une liste de scénarios codée à part.
5. Écrire `coverage.json.tmp`, valider le schéma, puis renommer. Écrire ensuite `coverage.md` de la même façon.
6. Si cette écriture échoue, le verdict produit du `summary.json` n’est pas modifié. Le message `Chaos coverage harness_error` est écrit sur la sortie d’erreur.

`npm start` lance cette écriture après `summary.json`, y compris sur un run fatal.

## Lecture des gros journaux

L’index ne conserve que les labels du plan DATA, leurs suffixes d’historique et de course, et au plus 50 labels `capture` inconnus. Une ligne JSON incomplète marque `journal.truncated` et ne fait pas échouer la reconstruction. Un label inconnu est signalé, pas interprété comme une action.

Le dashboard futur lira `summary.json` et `coverage.json`. Une preuve brute ponctuelle pourra être relue côté serveur par `seq`, jamais en chargeant le fichier entier dans le navigateur.

## Déterminisme

Le seed et le plan ne dépendent pas de l’horloge. `buildCoverage` ne lit pas `Date.now` ni `Math.random`. Deux constructions avec les mêmes entrées et le même `meta.generatedAt` produisent le même JSON. `meta.generatedAt` est la seule métadonnée volontairement non déterministe. `run.finishedAt` est la date de modification de `summary.json`, donc stable pour un fichier donné.

Les hashes de plan sont recalculés ou copiés. Les comparer au résumé détecte une divergence ; le reporting ne les réécrit pas.

## Adaptateurs (phase 2A)

`src/coverage.mjs` reste l’orchestrateur. DATA y est encore classée par `classifyDataAction`, parce que son empreinte et ses preuves compactes existaient déjà. Les autres tranches sont des modules dans `src/coverage/adapters/`. Le déplacement de DATA vers `adapters/data.mjs` peut se faire sans changer le schéma.

| Tranche | Module | Phase du journal | Statut |
|---|---|---|---|
| Préflight | `adapters/preflight.mjs` | `bootstrap`, lectures de catalogue | `reported` |
| Manufacturing / setup | `adapters/setup.mjs` | événements sans phase | `reported` |
| DATA | `coverage.mjs` | `capture` | `reported` |
| Parts | `adapters/parts.mjs` | `parts` | `reported` |
| Tools | `adapters/tools.mjs` | `tools` | `reported` |
| Signatures | `adapters/signatures.mjs` | `signatures` | `reported` |
| Courses contre annulation | `adapters/cancellation.mjs` | `signatures` et `lifecycle` | `reported` |
| Lifecycle | `adapters/lifecycle.mjs` | `lifecycle` | `reported` |
| Andon | `adapters/andon.mjs` | `andon` | `reported` |
| NCR | `adapters/ncr.mjs` | `ncr` | `reported` |
| Variance | `adapters/variance.mjs` | `variance` | `reported` |
| Run 2+ | `adapters/run.mjs` | `run` | `reported` |
| Service Visit | `adapters/service-visit.mjs` | `service-visit` | `reported` |
| Master BOM | — | — | `not_implemented` |

`not_migrated` n’est plus émis. Une tranche sans plan fourni à `buildCoverage` reste `unavailable`. Master BOM n’a aucune action.

Chaque adaptateur reçoit `{ summary, plans, journal, scenario }` et retourne `{ status, planHash, planned, executed, proved, byVerdict, actions }`.

### Preuve par tranche

Une action est `proved: true` seulement si les champs exigés par son oracle ont été relus.

- DATA : empreinte du point, stabilité des autres points, historique lorsque l’oracle le demande.
- Parts : le juge parts est rejoué quand la ligne, les autres lignes et l’historique sont complets. Sinon `not_proved`.
- Tools, signatures, lifecycle, Andon, NCR, variance, Run, Service Visit : HTTP, code, texte d’erreur, statut relu (`woStatus`, `ncrStatus`, `andonStatus`, `varianceStatus`, `runNo`, visite) et delta d’audit. Un champ attendu absent reste `not_proved`. Variance reprend la correction d’oracle déjà faite par le juge hors hash (`release-insert`, `order-negative-release`, `duplicate-release`) : un HTTP 400 prévu par cette correction n’est pas un finding.
- Course : une branche est prouvée s’il y a exactement un succès HTTP, le reste en 4xx, et une relecture d’état. Deux succès constituent un hybride, donc un finding. Sans relecture, `not_proved`. Le juge de course complet n’est pas rejoué.
- Export : les deux GET doivent être 200 et leur corps ne doit pas être vide.
- Setup : un 2xx dont le corps a été retenu. Le contrôle négatif sans relecture du master reste `not_proved`.
- Préflight : le catalogue vide ou l’absence de raisons Skip/Reopen alors que le setup a échoué est une erreur de harnais, pas un HTTP 500. Un run vert antérieur au bootstrap reste `not_executed` sur cette action.

Les métadonnées d’action portent les champs propres à la tranche : mode de traçabilité, politique de capture, acteur, effet Andon, `runNo`, source de visite.

### Index du journal

`indexCoverageJournal` lit `events.jsonl` ligne par ligne. Il conserve :

- `journal.index` : `seq`, offset, phase, label, statut, `actionId`, PO, WO, `raceGroup` ;
- l’état compact qui précède et suit chaque action (statuts, empreintes, comptes d’événements) ;
- au plus 50 labels inconnus.

Les payloads complets ne sont pas gardés. Une ligne JSON coupée met `journal.truncated` et ne fait pas échouer la reconstruction. Un résumé sans journal laisse les actions `not_executed` ou `not_proved`. Un run fatal est couvert si `summary.json` existe.

`coverage.md` liste le résumé, les tranches, les findings, les erreurs de harnais, les décisions de contrat et les actions bloquées. Les actions `pass` sont regroupées. `--markdown-detail=all` les écrit toutes. `coverage.json` les contient toujours.

## Serveur et interface

`npm run dashboard` construit l’application Vue, puis écoute sur `http://127.0.0.1:4173`.

Une première fois, dans ce dépôt :

```powershell
npm --prefix dashboard/web install
npm run dashboard
```

| Commande | Effet |
|---|---|
| `npm run dashboard:build` | construit `dashboard/web/dist` |
| `npm run dashboard:server` | sert l’API et le build déjà présent |
| `npm run dashboard:dev` | API sur `127.0.0.1:4174`, Vite sur `127.0.0.1:4173`, proxy `/api` |
| `npm run dashboard` | construit, puis démarre le serveur complet |

Le processus ne lit que `runs/`. Il n’appelle pas FlashWork, n’ouvre pas la base, n’écrit rien et ne reconstruit pas la couverture. FlashWork BE n’a pas besoin d’être démarré pour consulter les runs. Une couverture absente reste absente. Un `not_proved` reste `not_proved`. Un état inconnu n’est jamais peint en vert.

Si le build est absent, `/api/*` répond quand même. `GET /` indique alors de lancer `npm run dashboard:build`.

`/api/*` a priorité sur les fichiers. `index.html` n’est pas mis en cache long. Les fichiers de `/assets/` le sont. Un fichier absent sous `/assets/` répond 404, pas la page de l’application. Il n’y a pas de liste de répertoire.

### Écrans

`/` est la liste des runs. Les filtres, la page et le tri sont dans l’URL et sont envoyés à `GET /api/runs`. Le navigateur ne charge pas tous les runs pour les filtrer.

`/runs/:runId` montre le résumé, les cartes de tranches, les accès rapides et le tableau d’actions. Les filtres du tableau sont aussi dans l’URL, par exemple `/runs/essai047?verdict=not_proved`.

`/runs/:runId/actions/:actionId` ouvre une action. Les événements source ne sont lus qu’au clic, un `seq` à la fois.

La commande de reproduction affiche toujours `--run-id=<nouvel-id>`. L’identifiant déjà consommé n’y est pas recopié.

```text
Liste
  run-id, seed, date, statut, verdict, planned, executed, proved, not proved, findings, harness, blocked, unhandled, contrats, commit BE
Détail
  bannière finding ou harness
  compteurs, dont not proved au même niveau que proved
  cartes preflight, setup, DATA, parts, tools, signatures, cancellation, lifecycle, Andon, NCR, Variance, Run, Service Visit, Master BOM
  tableau paginé
Action
  requête, expected, observed, états, audits, invariants, bouton par sourceEventSeq
```

Master BOM affiche `Not implemented`. Ce n’est ni un échec ni une tranche couverte.

`executed` signifie que l’action a atteint le runner ou l’API. `proved` signifie que l’oracle a été vérifié. `not_proved` n’est ni un succès ni nécessairement un bug. Sur `essai047`, les 644 `not_proved` restent un compteur principal et un filtre du tableau.

Un run `incomplete` peut être relu toutes les 5 secondes. Le polling s’arrête quand le statut n’est plus `incomplete`. Les runs terminés ne sont pas relus en boucle. Le bouton Rafraîchir reste disponible.

Les statuts visuels sont PASS, FAILED, FATAL, INCOMPLETE, COVERAGE MISSING et COVERAGE INVALID. Le vert n’est utilisé que si le statut est `complete`, le verdict est vrai, `notProved` vaut 0, et qu’il n’y a ni finding, ni erreur de harnais, ni unhandled. Un run produit réussi qui a encore des `not_proved` garde le mot PASS, sur fond ambre, avec le compteur visible. Un finding produit ouvre une alerte. Une erreur de harnais sans finding n’est pas présentée comme un succès complet.

### Configuration

| Réglage | Défaut | Variable | Option |
|---|---|---|---|
| hôte | `127.0.0.1` | `CHAOS_DASHBOARD_HOST` | `--host=` |
| port | `4173` | `CHAOS_DASHBOARD_PORT` | `--port=` |
| dossier des runs | `<dépôt>/runs` | `CHAOS_DASHBOARD_RUNS` | `--runs=` |
| journal | `info` | `CHAOS_DASHBOARD_LOG` | `--log=` |

L’hôte par défaut est la boucle locale. Écouter sur toutes les interfaces exige `--host=` ou `CHAOS_DASHBOARD_HOST` explicite. Les variables `FLASHWORK_BASE_URL`, `CLIENT_ID` et `USER_ID` ne sont pas lues.

`/api/health` indique le dossier logique `runs`, ou `custom` si le dossier n’est pas celui du dépôt. Le chemin Windows complet n’est pas renvoyé.

### Routes API

| Route | Rôle |
|---|---|
| `GET /api/health` | état, version, dossier logique, nombre de runs, heure de lecture |
| `GET /api/runs` | liste compacte. Filtres `verdict`, `seed`, `q`, `status`, `hasFindings`, `hasHarnessErrors`, pagination |
| `GET /api/runs/:runId` | métadonnées, hashes, agrégats, tranches, fichiers, avertissements, version de schéma |
| `GET /api/runs/:runId/slices` | compteurs par tranche |
| `GET /api/runs/:runId/actions` | actions compactes filtrées |
| `GET /api/runs/:runId/actions/:actionId` | détail d’une action, ou liste des correspondances si l’identifiant est ambigu |
| `GET /api/runs/:runId/events/:seq` | une ligne du journal, par offset d’index ou parcours borné |
| `GET /api/runs/:runId/files` | présence, taille, date, état parseable, avertissements |

La page vaut 25 par défaut et 100 au maximum. Au-delà, la réponse est 413. Les tris acceptés sont `runId`, `seed`, `finishedAt`, `status` pour les runs, et `actionId`, `slice`, `verdict`, `label` pour les actions.

`verdict=pass` ne retient que `summary.pass === true` sans fatal. `verdict=fail` ne retient que `summary.pass === false` sans fatal. `verdict=fatal` suit `summary.fatal`. `verdict=unknown` retient l’absence de booléen. `status` filtre le statut de lecture (`complete`, `failed`, `fatal`, `incomplete`, `coverage_missing`, `coverage_invalid`).

La liste expose aussi `notProved`. Ce compteur vient des agrégats déjà lus, pas d’un second chargement des actions.

Les statuts HTTP sont 200, 400, 404, 409, 413, 422 et 500. Le corps d’erreur est `{ error, code, message, details }`. Un 500 ne contient ni pile ni chemin.

### Lecture et cache

La liste ne renvoie pas les actions. Une fiche compacte par run est gardée à part, au plus 256 fiches, et elle est invalidée dès que la taille ou la date d’un fichier du run change. Le document indexé complet reste dans un autre cache, borné à 8 runs. Le premier accès à un `coverage.json` de 7 Mo le parse une fois et occupe en général 15 à 30 Mo de tas tant qu’il reste dans ce second cache. Les snapshots volumineux ne sont pas dupliqués : la liste n’en expose qu’un statut court, le détail relit l’objet déjà parsé.

`events.jsonl` n’est jamais chargé en entier. Si `journal.index` contient `seq` et `offset`, une seule ligne est lue et son `seq` est vérifié. Sans index, un parcours s’arrête à 8 Mo et la réponse porte `slow: true`. Une dernière ligne incomplète est ignorée. `detail=full` garde des chaînes jusqu’à 4 000 caractères, toujours sans secret, et refuse au-delà de 64 Ko.

### Sécurité

L’identifiant de run doit matcher `^[A-Za-z0-9-]{1,40}$`. `../`, un chemin absolu, un encodage de traversal et un identifiant Unicode sont rejetés. Le chemin réel doit rester sous `runs`. Un lien qui sort de ce dossier n’est pas suivi. Il n’y a pas de route générique de lecture de fichier. `coverage.json.tmp` n’est pas servi comme une couverture.

### Run actif

La liste reste disponible pendant qu’un seed écrit. Sans `summary.json`, le statut est `incomplete`. Un fichier temporaire de couverture n’est pas exposé : les routes qui exigent la couverture répondent 409 `coverage_writing`. Le journal peut être lu jusqu’à la dernière ligne complète. La ligne partielle finale ne fait pas tomber le serveur.

### `coverage_missing` et run échoué

`failed` signifie que `summary.json` existe et que `pass` vaut `false`. `fatal` suit `summary.fatal`. `coverage_missing` signifie que le résumé existe, que le run n’est pas fatal, que `pass` n’est pas `false`, et que `coverage.json` est absent. Ce n’est pas un échec produit et ce n’est pas un PASS de couverture. `coverage_invalid` signifie que le fichier est présent mais illisible, ou que sa version de schéma n’est pas 1. `complete` exige `pass === true` et une couverture de version 1 valide.

### Limites

Le serveur affiche la couverture déjà écrite. Il ne reclasse pas les actions. Le parcours sans index est borné à 8 Mo. Le cache des documents complets ne couvre que 8 runs à la fois ; les fiches de liste en couvrent 256. L’interface web, la comparaison de runs et le service des fichiers statiques ne sont pas implémentés.

### Dépannage

- Rien n’écoute : vérifier que le port 4173 est libre, ou choisir `--port=`.
- La liste est vide : les dossiers de `runs` doivent porter un identifiant `[A-Za-z0-9-]{1,40}`.
- Un run terminé reste `coverage_missing` : lancer `npm run coverage -- --run-id=<id>` séparément. Le serveur ne le fait pas.
- Un run vert historique montre beaucoup de `not_proved` : le journal ne contient pas la preuve isolée. Ce n’est pas un succès à convertir.
- Une action répond 409 `ambiguous_action` : ajouter `?slice=` ou `?ordinal=`.
- Un événement sans index répond 404 `event_not_scanned` : le parcours borné ne l’a pas atteint. Reconstruire la couverture crée l’index, hors du serveur.
