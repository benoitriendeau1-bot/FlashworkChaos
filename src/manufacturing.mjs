/** Plausible manufacturing families. Choices inside a role stay coherent; the compiler only picks among these lists. */

export const PART_ROLES = {
  housing: { name: 'Boîtier usiné', modes: ['Serial', 'SerialLot'], quantities: [1], kind: 'critical' },
  shaft: { name: 'Arbre de transmission', modes: ['Serial', 'SerialLot'], quantities: [1], kind: 'critical' },
  fastener: { name: 'Vis à tête cylindrique M6', modes: ['Lot', 'None'], quantities: [4, 6, 8], kind: 'bulk' },
  washer: { name: 'Rondelle plate M6', modes: ['None', 'Lot'], quantities: [4, 8], kind: 'bulk' },
  bearing: { name: 'Roulement rigide à billes', modes: ['Lot', 'SerialLot'], quantities: [1, 2], kind: 'lot' },
  seal: { name: 'Joint torique', modes: ['Lot', 'SerialLot'], quantities: [1, 2], kind: 'lot' },
  adhesive: { name: 'Frein-filet anaérobie', modes: ['Lot', 'LotHeat'], quantities: [1], kind: 'consumable' },
  coating: { name: 'Primaire époxy', modes: ['Lot', 'Heat', 'LotHeat'], quantities: [1], kind: 'consumable' },
  lubricant: { name: 'Graisse pour roulement', modes: ['Lot', 'Heat'], quantities: [1], kind: 'consumable' },
  wire: { name: 'Fil de câblage 0,5 mm²', modes: ['Lot'], quantities: [1, 2], kind: 'lot' },
  connector: { name: 'Connecteur étanche', modes: ['Serial', 'SerialLot'], quantities: [1], kind: 'critical' },
  terminal: { name: 'Cosse sertie', modes: ['Lot', 'None'], quantities: [2, 4], kind: 'bulk' },
  sensor: { name: 'Capteur de position', modes: ['Serial', 'SerialHeat'], quantities: [1], kind: 'critical' },
  label: { name: 'Étiquette d\'identification', modes: ['None', 'Lot'], quantities: [1], kind: 'bulk' },
  wipe: { name: 'Lingette solvant', modes: ['Lot', 'Heat'], quantities: [1, 2], kind: 'consumable' },
  shim: { name: 'Cale d\'épaisseur', modes: ['Lot'], quantities: [1, 2], kind: 'lot' },
  specimen: { name: 'Pièce à contrôler', modes: ['Serial', 'SerialLot'], quantities: [1], kind: 'critical' },
};

export const TOOL_ROLES = {
  'torque-wrench': { name: 'Clé dynamométrique 5-25 N·m', policies: ['required'], calibration: 'calendar', days: 365 },
  micrometer: { name: 'Micromètre d\'extérieur', policies: ['required'], calibration: 'calendar', days: 180 },
  caliper: { name: 'Pied à coulisse', policies: ['required'], calibration: 'calendar', days: 365 },
  'thickness-gauge': { name: 'Jauge d\'épaisseur', policies: ['required'], calibration: 'calendar', days: 180 },
  multimeter: { name: 'Multimètre numérique', policies: ['required'], calibration: 'calendar', days: 365 },
  'insulation-tester': { name: 'Contrôleur d\'isolement', policies: ['required'], calibration: 'usage', uses: 100 },
  scale: { name: 'Balance de précision', policies: ['required'], calibration: 'calendar', days: 365 },
  press: { name: 'Presse d\'atelier', policies: ['required', 'optional'], calibration: 'none' },
  'hex-key': { name: 'Clé six pans 5 mm', policies: ['optional', 'info_only'], calibration: 'none' },
  applicator: { name: 'Applicateur de produit', policies: ['info_only', 'optional'], calibration: 'none' },
  lamp: { name: 'Lampe d\'inspection', policies: ['info_only', 'optional'], calibration: 'none' },
  timer: { name: 'Chronomètre d\'atelier', policies: ['optional', 'required'], calibration: 'none' },
  scanner: { name: 'Lecteur de code', policies: ['optional', 'required'], calibration: 'none' },
};

export const DATA_ROLES = {
  torque: { dataType: 'measurement', unit: 'N·m', places: 1, label: 'Couple de serrage', nominals: [8, 12, 15, 22], tolerances: [1, 1.5, 2], toolRoles: ['torque-wrench'] },
  gap: { dataType: 'measurement', unit: 'mm', places: 3, label: 'Jeu résiduel', nominals: [0.1, 0.15, 0.25], tolerances: [0.02, 0.05], toolRoles: ['micrometer', 'caliper'], allowMinZero: true },
  diameter: { dataType: 'measurement', unit: 'mm', places: 3, label: 'Diamètre mesuré', nominals: [12, 20, 25], tolerances: [0.01, 0.02], toolRoles: ['micrometer', 'caliper'] },
  thickness: { dataType: 'measurement', unit: 'µm', places: 0, label: 'Épaisseur de feuil sec', nominals: [40, 80, 120], tolerances: [10, 15], toolRoles: ['thickness-gauge'], allowMinZero: true },
  voltage: { dataType: 'measurement', unit: 'V', places: 1, label: 'Tension d\'alimentation', nominals: [5, 12, 24], tolerances: [0.2, 0.5], toolRoles: ['multimeter'] },
  resistance: { dataType: 'measurement', unit: 'Ohm', places: 0, label: 'Résistance de continuité', nominals: [50, 120, 240], tolerances: [2, 5], toolRoles: ['multimeter'] },
  insulation: { dataType: 'measurement', unit: 'MOhm', places: 0, label: 'Résistance d\'isolement', nominals: [100, 200], tolerances: [10, 20], toolRoles: ['insulation-tester'] },
  temperature: { dataType: 'measurement', unit: '°C', places: 1, label: 'Température de procédé', nominals: [22, 60, 80], tolerances: [3, 5], toolRoles: [] },
  mass: { dataType: 'measurement', unit: 'g', places: 2, label: 'Masse déposée', nominals: [2, 5, 10], tolerances: [0.2, 0.5], toolRoles: ['scale'] },
  count: { dataType: 'number', places: 0, label: 'Nombre de pièces posées', nominals: [4, 6, 8], tolerances: [1, 2], toolRoles: [] },
  passes: { dataType: 'number', places: 0, label: 'Nombre de passes', nominals: [2, 3, 4], tolerances: [1], toolRoles: [] },
  note: { dataType: 'text', label: 'Note de contrôle', toolRoles: [] },
  confirm: { dataType: 'boolean', label: 'Contrôle visuel accepté', toolRoles: [] },
  when: { dataType: 'date', label: 'Date de réalisation', toolRoles: [] },
  disposition: { dataType: 'enum', label: 'Décision', toolRoles: [] },
};

const operator = { role: 'operator', level: 1 };
const inspector = { role: 'inspector', level: 1 };

function op(id, phase, required, title, description, steps) {
  return { id, phase, required, title, description, steps };
}
function st(title, instruction, parts, tools, data, signoff = operator) {
  return { title, instruction, parts, tools, data, signoff };
}

const kit = (part) => op('kit', 10, true, 'Identifier et kitter', 'Rattacher la pièce critique au dossier et confirmer le kit avant tout travail.', [
  st(
    'Identifier la pièce critique',
    'Lire l\'identité de {product}, comparer le numéro au dossier, et confirmer que le kit ne contient pas de pièce d\'un autre ordre. Noter toute différence de révision avant de commencer.',
    [part, 'label'],
    ['scanner'],
    ['note', 'confirm', 'when'],
  ),
]);

const finalInspect = () => op('final', 90, true, 'Inspection finale', 'Mesurer le jeu résiduel, trancher la décision et signer l\'inspection.', [
  st(
    'Contrôler et décider',
    'Sous la lampe, inspecter {product}. Mesurer le jeu résiduel au micromètre, puis choisir la décision. Un jeu nul est acceptable; un dépassement du maximum ne l\'est pas.',
    ['label'],
    ['micrometer', 'lamp'],
    ['gap', 'confirm', 'disposition'],
    inspector,
  ),
]);

export const FAMILIES = [
  {
    id: 'mechanical-assembly',
    label: 'Assemblage mécanique',
    products: [
      { name: 'Réducteur servo SG-200', summary: 'Assemblage d\'un réducteur servo.' },
      { name: 'Chariot de glissière linéaire', summary: 'Assemblage d\'un chariot de guidage.' },
      { name: 'Support de charnière', summary: 'Assemblage d\'un support de charnière.' },
    ],
    operations: [
      kit('housing'),
      op('shaft', 20, true, 'Monter l\'arbre', 'Introduire l\'arbre et contrôler son diamètre avant le serrage.', [
        st('Mettre l\'arbre en place', 'Positionner l\'arbre de {product} dans le boîtier avec la cale de lot. Mesurer le diamètre au micromètre et confirmer qu\'il reste dans les limites avant de poursuivre.', ['shaft', 'shim'], ['micrometer', 'press'], ['diameter', 'confirm']),
      ]),
      op('torque', 30, true, 'Serrer les fixations', 'Serrer les vis au couple prescrit et compter les fixations.', [
        st('Serrer au couple', 'Poser les vis de {product} à la clé six pans, puis serrer avec la clé dynamométrique. Enregistrer le couple en N·m et le nombre de vis réellement posées.', ['fastener', 'washer'], ['torque-wrench', 'hex-key'], ['torque', 'count']),
      ]),
      op('threadlocker', 40, false, 'Déposer le frein-filet', 'Déposer le frein-filet par lot sur le filetage avant le serrage final.', [
        st('Appliquer le frein-filet', 'Agiter le flacon, déposer le frein-filet sur le filetage de {product} et noter le lot. Ne pas utiliser un outil de mesure pour cette dépose.', ['adhesive'], ['applicator'], ['note', 'confirm']),
      ]),
      op('visual', 40, false, 'Contrôle visuel intermédiaire', 'Vérifier l\'alignement avant l\'inspection finale.', [
        st('Vérifier l\'alignement', 'Regarder l\'alignement des faces de {product} sous la lampe et noter toute marque d\'outil.', ['washer'], ['lamp'], ['confirm', 'note']),
      ]),
      finalInspect(),
    ],
  },
  {
    id: 'dimensional-inspection',
    label: 'Inspection dimensionnelle',
    products: [
      { name: 'Bride usinée BR-40', summary: 'Contrôle dimensionnel d\'une bride.' },
      { name: 'Entretoise calibrée ET-12', summary: 'Contrôle dimensionnel d\'une entretoise.' },
      { name: 'Plaque de référence PL-7', summary: 'Contrôle dimensionnel d\'une plaque.' },
    ],
    operations: [
      kit('specimen'),
      op('setup', 20, true, 'Préparer les instruments', 'Vérifier l\'identité des instruments avant de mesurer.', [
        st('Préparer le micromètre', 'Nettoyer les touches, contrôler l\'identité du micromètre et confirmer qu\'il est celui prévu pour {product}.', ['label'], ['micrometer', 'scanner'], ['confirm', 'when']),
      ]),
      op('features', 30, true, 'Mesurer les cotes', 'Relever le diamètre et le jeu avec des limites décimales.', [
        st('Relever diamètre et jeu', 'Mesurer le diamètre et le jeu de {product}. Le jeu peut être nul. Enregistrer aussi le nombre de points relevés. La lingette de lot sert seulement à nettoyer les touches.', ['specimen', 'wipe'], ['micrometer', 'caliper'], ['diameter', 'gap', 'count']),
      ]),
      op('temperature', 40, false, 'Relever la température', 'Noter la température de la pièce avant de comparer les cotes.', [
        st('Noter la température', 'Laisser {product} se stabiliser et enregistrer la température ambiante de mesure en °C.', ['specimen'], ['timer'], ['temperature', 'note']),
      ]),
      op('surface', 40, false, 'Inspecter la surface', 'Chercher les coups et les bavures avant la décision.', [
        st('Inspecter la surface', 'Sous la lampe, parcourir les portées de {product} et consigner une note si une marque est visible.', ['wipe'], ['lamp'], ['confirm', 'note']),
      ]),
      finalInspect(),
    ],
  },
  {
    id: 'electrical-assembly',
    label: 'Assemblage électrique',
    products: [
      { name: 'Harnais de capteur H-24', summary: 'Assemblage d\'un harnais de capteur.' },
      { name: 'Carte de jonction CJ-12', summary: 'Assemblage d\'une carte de jonction.' },
      { name: 'Boîtier de connexion BX-5', summary: 'Assemblage d\'un boîtier de connexion.' },
    ],
    operations: [
      kit('connector'),
      op('route', 20, true, 'Cheminer le fil', 'Couper et poser le fil au lot prévu.', [
        st('Poser le fil', 'Cheminer le fil de {product} sans le pincer. Compter les fils posés et noter le lot sur la fiche.', ['wire', 'terminal'], ['scanner'], ['count', 'note']),
      ]),
      op('continuity', 30, true, 'Contrôler la continuité', 'Mesurer la résistance avec le multimètre, pas avec une clé dynamométrique.', [
        st('Mesurer la continuité', 'Connecter le multimètre aux bornes de {product} et enregistrer la résistance en ohms. Confirmer que la lecture est stable.', ['connector'], ['multimeter'], ['resistance', 'confirm']),
      ]),
      op('insulation', 40, false, 'Contrôler l\'isolement', 'Mesurer l\'isolement avec le contrôleur dédié.', [
        st('Mesurer l\'isolement', 'Appliquer le contrôleur d\'isolement sur {product} et enregistrer la valeur en MOhm.', ['wire'], ['insulation-tester'], ['insulation']),
      ]),
      op('voltage', 50, true, 'Vérifier la tension', 'Alimenter et lire la tension au multimètre.', [
        st('Lire la tension', 'Alimenter {product} à la tension prévue et enregistrer la lecture en volts. Couper l\'alimentation avant de ranger le harnais.', ['connector'], ['multimeter'], ['voltage', 'confirm']),
      ]),
      finalInspect(),
    ],
  },
  {
    id: 'product-application',
    label: 'Préparation et application de produit',
    products: [
      { name: 'Capot protégé CP-3', summary: 'Préparation et application d\'un primaire.' },
      { name: 'Semelle collée SM-8', summary: 'Préparation et application d\'un adhésif.' },
      { name: 'Flasque revêtu FL-2', summary: 'Préparation et application d\'un revêtement.' },
    ],
    operations: [
      kit('housing'),
      op('clean', 20, true, 'Préparer la surface', 'Nettoyer la surface avant toute dépose de produit.', [
        st('Nettoyer la portée', 'Dégraisser la portée de {product} avec la lingette. Confirmer visuellement que le film d\'huile a disparu et noter l\'état.', ['wipe'], ['lamp'], ['confirm', 'note']),
      ]),
      op('apply', 30, true, 'Déposer le produit', 'Peser le produit tracé par lot et l\'appliquer.', [
        st('Peser et appliquer', 'Peser la masse de produit pour {product} sur la balance, puis l\'appliquer en comptant les passes. Le produit reste tracé par son lot, pas par un numéro de série de pièce.', ['coating'], ['scale', 'applicator'], ['mass', 'passes', 'note']),
      ]),
      op('cure', 40, true, 'Contrôler la polymérisation', 'Relever la température et la date de fin de cure.', [
        st('Suivre la cure', 'Laisser polymériser {product}. Enregistrer la température de procédé et la date de fin de cure.', ['coating'], ['timer'], ['temperature', 'when']),
      ]),
      op('film', 50, false, 'Mesurer le feuil', 'Mesurer l\'épaisseur sèche avec la jauge, pas avec la clé dynamométrique.', [
        st('Mesurer l\'épaisseur', 'Mesurer l\'épaisseur sèche de {product} à la jauge. Une épaisseur nulle signifie que le feuil est absent.', ['coating'], ['thickness-gauge'], ['thickness']),
      ]),
      finalInspect(),
    ],
  },
  {
    id: 'bearing-seal-fastener',
    label: 'Installation de roulements, joints ou fixations',
    products: [
      { name: 'Palier cartouche PC-16', summary: 'Montage d\'un palier à roulement.' },
      { name: 'Nez de broche NB-9', summary: 'Montage d\'un joint et d\'un roulement.' },
      { name: 'Moyeu étanche MY-4', summary: 'Montage d\'un moyeu avec joint.' },
    ],
    operations: [
      kit('housing'),
      op('press', 20, true, 'Emmancher le roulement', 'Emmancher le roulement graissé et vérifier qu\'il est en butée.', [
        st('Emmancher et graisser', 'Déposer la graisse de lot sur la portée de {product}, puis emmancher le roulement à la presse jusqu\'en butée. Confirmer l\'assise.', ['bearing', 'lubricant'], ['press'], ['confirm', 'note']),
      ]),
      op('seal', 30, true, 'Poser le joint', 'Poser le joint sans le vriller.', [
        st('Poser le joint', 'Huiler légèrement le joint de {product} et le poser à la presse, face ouverte du bon côté. Confirmer qu\'il n\'est pas vrillé.', ['seal'], ['press', 'lamp'], ['confirm']),
      ]),
      op('torque', 40, true, 'Serrer le flasque', 'Serrer les vis de retenue au couple.', [
        st('Serrer le flasque', 'Serrer les vis du flasque de {product} au couple prescrit avec la clé dynamométrique et compter les vis.', ['fastener'], ['torque-wrench', 'hex-key'], ['torque', 'count']),
      ]),
      op('spin', 50, false, 'Contrôler la rotation', 'Vérifier que le palier tourne librement.', [
        st('Tourner à la main', 'Faire tourner {product} à la main. Noter un point dur ou un bruit et confirmer que la rotation est libre.', ['bearing'], ['lamp'], ['confirm', 'note']),
      ]),
      finalInspect(),
    ],
  },
  {
    id: 'functional-test',
    label: 'Essais fonctionnels',
    products: [
      { name: 'Actionneur linéaire AL-30', summary: 'Essai fonctionnel d\'un actionneur.' },
      { name: 'Module capteur MC-6', summary: 'Essai fonctionnel d\'un module capteur.' },
      { name: 'Vérin de test VT-2', summary: 'Essai fonctionnel d\'un vérin.' },
    ],
    operations: [
      kit('sensor'),
      op('connect', 20, true, 'Raccorder l\'essai', 'Raccorder le connecteur et confirmer l\'identité.', [
        st('Raccorder le connecteur', 'Raccorder le connecteur de {product} avec le fil de lot. Confirmer l\'identité lue et la date de l\'essai avant la mise sous tension.', ['connector', 'wire'], ['scanner'], ['confirm', 'when']),
      ]),
      op('power', 30, true, 'Relever la tension', 'Lire la tension d\'alimentation au multimètre.', [
        st('Mesurer la tension', 'Mettre {product} sous tension et enregistrer la tension en volts au multimètre.', ['sensor'], ['multimeter'], ['voltage']),
      ]),
      op('cycles', 40, true, 'Exécuter les cycles', 'Compter les cycles et chronométrer la course.', [
        st('Compter les cycles', 'Faire exécuter les cycles à {product}. Enregistrer le nombre de cycles réalisés et confirmer que la course est complète.', ['sensor'], ['timer'], ['count', 'confirm']),
      ]),
      op('insulation', 50, false, 'Contrôler l\'isolement', 'Mesurer l\'isolement après l\'essai en charge.', [
        st('Mesurer l\'isolement', 'Couper l\'alimentation de {product}, puis mesurer l\'isolement en MOhm.', ['wire'], ['insulation-tester'], ['insulation', 'note']),
      ]),
      finalInspect(),
    ],
  },
  {
    id: 'clean-final-inspection',
    label: 'Nettoyage et inspection finale',
    products: [
      { name: 'Corps de vanne CV-11', summary: 'Nettoyage et inspection finale d\'un corps de vanne.' },
      { name: 'Couvercle de boîte CB-3', summary: 'Nettoyage et inspection finale d\'un couvercle.' },
      { name: 'Collecteur rincé CL-8', summary: 'Nettoyage et inspection finale d\'un collecteur.' },
    ],
    operations: [
      kit('specimen'),
      op('wash', 20, true, 'Nettoyer', 'Nettoyer avec le consommable de lot et inspecter sous la lampe.', [
        st('Nettoyer la pièce', 'Nettoyer {product} avec la lingette de lot. Sous la lampe, confirmer l\'absence de copeaux et écrire une note de contrôle.', ['wipe'], ['lamp'], ['confirm', 'note']),
      ]),
      op('dry', 30, true, 'Sécher et dater', 'Laisser sécher, puis enregistrer la date.', [
        st('Sécher', 'Laisser sécher {product} et enregistrer la date à laquelle la surface est sèche.', ['specimen'], ['timer'], ['when', 'confirm']),
      ]),
      op('measure', 40, true, 'Mesurer le résidu', 'Mesurer un jeu ou une épaisseur résiduelle, qui peut être nulle.', [
        st('Mesurer le résidu', 'Mesurer le jeu résiduel de {product} au micromètre. Zéro est une valeur valide si aucune surépaisseur n\'est présente.', ['specimen'], ['micrometer'], ['gap', 'count']),
      ]),
      op('marks', 50, false, 'Relever les marques', 'Noter les marques d\'outillage restantes.', [
        st('Noter les marques', 'Repérer les marques sur {product} et les décrire dans la note. Ne pas les confondre avec un défaut de matière.', ['label'], ['lamp'], ['note', 'confirm']),
      ]),
      finalInspect(),
    ],
  },
];

export const ENUM_SETS = [
  ['Accept', 'Rework', 'Reject'],
  ['Bon', 'À reprendre', 'Rebut'],
  ['Pass', 'Fail'],
];

export const SERIAL_MODES = new Set(['Serial', 'SerialLot', 'SerialHeat', 'SerialLotHeat']);
export const LOT_MODES = new Set(['Lot', 'Heat', 'LotHeat', 'SerialLot', 'SerialLotHeat']);
export const CONSUMABLE_MODES = new Set(['Lot', 'Heat', 'LotHeat']);
