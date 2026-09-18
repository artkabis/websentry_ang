/**
 * ANALYZERS REGISTRY — Source de vérité unique pour tous les critères d'analyse.
 *
 * Partagé entre le backend (orchestrateur) et le frontend (settings, dashboard).
 *
 * Pour ajouter un nouveau critère d'analyse :
 *   1. Ajouter une entrée dans ANALYZERS_REGISTRY ici
 *   2. Créer apps/api/src/analyzers/mon-critere.analyzer.ts
 *   3. L'enregistrer dans ALL_ANALYZERS (apps/api/src/analyzers/orchestrator.ts)
 *   4. Ajouter ses sous-critères dans SUB_CHECKS_REGISTRY ci-dessous
 *   → L'UI (settings, dashboard) s'adapte automatiquement
 */

export type CheckGroup = 'Design' | 'Technique' | 'SEO';

export interface CheckMeta {
  id: string;
  title: string;
  /**
   * Titre court pour les vues compactes (matrices, colonnes).
   * Si absent, la vue utilisera les premiers mots du title.
   */
  shortTitle?: string;
  /** Groupe d'affichage dans le dashboard et les settings */
  group: CheckGroup;
  /**
   * Si true, ce critère n'est pas affiché directement dans l'UI principale.
   * Ses résultats sont fusionnés dans le check parent via CHECK_CHILDREN.
   */
  internal?: boolean;
  /** ID du check parent dans lequel les résultats sont fusionnés (si internal: true) */
  mergedInto?: string;
}

export interface SubCheckMeta {
  key: string;
  label: string;
  checkId: string;
  /**
   * Label affiché sur la page de résultats quand la polarité du sous-critère est 'absent'.
   * Décrit le contexte de l'inversion : pourquoi l'état détecté est (dés)ormais valide.
   * Si absent, l'orchestrateur applique un suffixe générique.
   */
  absentLabel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registre complet des analyzers — backend ET frontend lisent ceci
// ─────────────────────────────────────────────────────────────────────────────
export const ANALYZERS_REGISTRY: CheckMeta[] = [
  // ── Design ─────────────────────────────────────────────────────────────────
  { id: 'LOGO', title: "Logo dans l'en-tête", group: 'Design' },
  { id: 'IMAGES', title: 'Images (alt, poids, format)', group: 'Design' },
  {
    id: 'DUPLICATE_IMAGES',
    title: 'Images en doublon',
    group: 'Design',
    internal: true,
    mergedInto: 'IMAGES',
  },
  { id: 'PICTOGRAM', title: 'Pictogrammes & icônes', group: 'Design' },
  { id: 'DATA_BINDING', title: 'Données connectées (Duda)', group: 'Design' },
  { id: 'MENTIONS_LEGALES_DATA', title: 'Mentions légales — Données connectées', group: 'Design' },
  { id: 'FAVICON', title: 'Favicon', group: 'Design' },
  { id: 'NAV_STRUCTURE', title: 'Structure de la navigation principale', group: 'Design' },
  {
    id: 'CONTRAST_V2',
    title: 'Contraste couleurs V2 (WCAG)',
    group: 'Design',
    shortTitle: 'Contraste V2',
  },

  // ── Technique ───────────────────────────────────────────────────────────────
  { id: 'CANONICAL', title: 'Balise canonical', group: 'Technique' },
  { id: 'OPEN_GRAPH', title: 'Open Graph & Twitter Card', group: 'Technique' },
  { id: 'ROBOTS_META', title: 'Robots meta & robots.txt', group: 'Technique' },
  { id: 'LANG', title: 'Langue de la page', group: 'Technique' },
  { id: 'REDIRECTS', title: 'Redirections HTTP', group: 'Technique' },
  { id: 'TRACKING', title: 'Scripts de tracking & analytics', group: 'Technique' },
  { id: 'BROKEN_LINKS', title: 'Liens cassés (404, erreurs HTTP)', group: 'Technique' },
  { id: 'SPLIT_LINKS', title: 'Liens coupés & doublons consécutifs', group: 'Technique' },
  {
    id: 'DUDA_PARAMS',
    title: 'Informations Duda (window.Parameters)',
    group: 'Technique',
    internal: true,
  },

  // ── SEO ────────────────────────────────────────────────────────────────────
  { id: 'HN_STRUCTURE', title: 'Hiérarchie des titres', group: 'SEO' },
  { id: 'HN_LENGTH', title: 'Longueur des titres (H1 et H2)', group: 'SEO' },
  { id: 'METAS', title: 'Balises méta (title & description)', group: 'SEO' },
  { id: 'BOLD', title: 'Mise en gras (b/strong)', group: 'SEO' },
  { id: 'LINKS', title: 'Liens (CTC, CTM, nofollow)', group: 'SEO' },
  { id: 'CONTENT_LENGTH', title: 'Longueur du contenu texte', group: 'SEO' },
  { id: 'CTA', title: "Appels à l'action (CTA)", group: 'SEO' },
  { id: 'MENTIONS_LEGALES', title: 'Mentions légales & RGPD', group: 'SEO' },
  { id: 'ACCESSIBILITY', title: 'Accessibilité (WCAG, ARIA)', group: 'SEO' },
  { id: 'ANCHOR_TEXT', title: 'Concordance ancres & URLs', group: 'SEO' },
  // ── Internes (résultats fusionnés dans un parent, non affichés en carte UI) ─
  {
    id: 'STRUCTURED_DATA',
    title: 'Données structurées (JSON-LD)',
    group: 'SEO',
    internal: true,
    mergedInto: 'MENTIONS_LEGALES_DATA',
  },
];

/**
 * Critères visibles dans l'UI (non-internes).
 * Remplace ALL_CHECKS côté frontend — lisez ceci, pas une copie locale.
 */
export const ALL_CHECKS: CheckMeta[] = ANALYZERS_REGISTRY.filter(a => !a.internal);

/**
 * Map parent → enfants fusionnés.
 * Remplace CHECK_CHILDREN côté frontend — dérivé automatiquement du registre.
 */
export const CHECK_CHILDREN: Record<string, string[]> = ANALYZERS_REGISTRY.filter(
  (a): a is CheckMeta & { mergedInto: string } => !!a.internal && !!a.mergedInto,
).reduce<Record<string, string[]>>((acc, a) => {
  // `noUncheckedIndexedAccess` : un accès indexé peut rendre `undefined`, même
  // juste après l'avoir initialisé. On passe par une variable locale plutôt que
  // par une assertion, qui masquerait un vrai trou si la forme changeait.
  const siblings = acc[a.mergedInto] ?? [];
  siblings.push(a.id);
  acc[a.mergedInto] = siblings;
  return acc;
}, {});

// ─────────────────────────────────────────────────────────────────────────────
// Registre des sous-critères
// Clé : identifiant stable (PREFIX.snake_case)
// checkId : correspond à un id dans ANALYZERS_REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
export const SUB_CHECKS_REGISTRY: SubCheckMeta[] = [
  // ── LOGO ──────────────────────────────────────────────────────────────────
  {
    key: 'LOGO.not_found',
    label: 'Logo non trouvé',
    checkId: 'LOGO',
    absentLabel: 'Logo non trouvé — absence conforme',
  },
  {
    key: 'LOGO.alt_missing',
    label: 'Alt logo manquant',
    checkId: 'LOGO',
    absentLabel: 'Alt logo manquant — absence conforme',
  },
  {
    key: 'LOGO.alt_empty',
    label: 'Alt logo vide (obligatoire)',
    checkId: 'LOGO',
    absentLabel: 'Alt logo vide — absence conforme',
  },
  {
    key: 'LOGO.alt_ok',
    label: 'Alt logo présent',
    checkId: 'LOGO',
    absentLabel: 'Alt logo présent — doit être absent',
  },
  {
    key: 'LOGO.not_clickable',
    label: 'Logo non cliquable',
    checkId: 'LOGO',
    absentLabel: 'Logo non cliquable — absence conforme',
  },
  {
    key: 'LOGO.link_no_href',
    label: 'Lien logo sans href',
    checkId: 'LOGO',
    absentLabel: 'Lien logo sans href — absence conforme',
  },
  {
    key: 'LOGO.link_homepage',
    label: 'Logo lié à la homepage',
    checkId: 'LOGO',
    absentLabel: 'Logo lié à la homepage — doit être absent',
  },
  {
    key: 'LOGO.link_other_page',
    label: 'Logo lié à une autre page',
    checkId: 'LOGO',
    absentLabel: 'Logo lié à une autre page — doit être absent',
  },
  {
    key: 'LOGO.link_external',
    label: 'Logo lié à un site externe',
    checkId: 'LOGO',
    absentLabel: 'Logo lié à un site externe — doit être absent',
  },
  {
    key: 'LOGO.src_missing',
    label: 'Src logo manquante',
    checkId: 'LOGO',
    absentLabel: 'Src logo manquante — absence conforme',
  },
  {
    key: 'LOGO.src_ok',
    label: 'Src logo présente',
    checkId: 'LOGO',
    absentLabel: 'Src logo présente — doit être absent',
  },
  {
    key: 'LOGO.link_title_ok',
    label: 'Title image logo valide',
    checkId: 'LOGO',
    absentLabel: 'Title image logo valide — doit être absent',
  },
  {
    key: 'LOGO.link_title_missing',
    label: 'Title image logo absent',
    checkId: 'LOGO',
    absentLabel: 'Title image logo absent — absence conforme',
  },

  // ── IMAGES ────────────────────────────────────────────────────────────────
  {
    key: 'IMAGES.alt_missing',
    label: 'Image(s) sans alt',
    checkId: 'IMAGES',
    absentLabel: 'Image(s) sans alt — absence conforme',
  },
  {
    key: 'IMAGES.alt_present',
    label: 'Alt présent sur images',
    checkId: 'IMAGES',
    absentLabel: 'Alt présent sur images — doit être absent',
  },
  {
    key: 'IMAGES.decorative',
    label: 'Images décoratives',
    checkId: 'IMAGES',
    absentLabel: 'Images décoratives — doit être absent',
  },
  {
    key: 'IMAGES.format_modern',
    label: 'Format moderne (WebP/AVIF)',
    checkId: 'IMAGES',
    absentLabel: 'Format moderne (WebP/AVIF) — doit être absent',
  },
  {
    key: 'IMAGES.weight_fail',
    label: 'Images trop lourdes',
    checkId: 'IMAGES',
    absentLabel: 'Images trop lourdes — absence conforme',
  },
  {
    key: 'IMAGES.weight_warn',
    label: 'Images poids limite',
    checkId: 'IMAGES',
    absentLabel: 'Images poids limite — absence conforme',
  },
  {
    key: 'IMAGES.weight_ok',
    label: 'Poids images OK',
    checkId: 'IMAGES',
    absentLabel: 'Poids images OK — doit être absent',
  },

  {
    key: 'NAV_STRUCTURE.nav_role_found',
    label: 'nav role="navigation" trouvé',
    checkId: 'NAV_STRUCTURE',
    absentLabel: 'nav role="navigation" trouvé — doit être absent',
  },
  {
    key: 'NAV_STRUCTURE.no_links',
    label: 'Aucun lien dans la navigation',
    checkId: 'NAV_STRUCTURE',
    absentLabel: 'Aucun lien dans la navigation — absence conforme',
  },
  {
    key: 'NAV_STRUCTURE.links_count',
    label: 'Nombre de liens dans la navigation',
    checkId: 'NAV_STRUCTURE',
    absentLabel: 'Nombre de liens dans la navigation — absence conforme',
  },

  // ── DUPLICATE_IMAGES — fusionné dans IMAGES ────────────────────────────────
  {
    key: 'DUP.unique_count',
    label: 'Images uniques',
    checkId: 'IMAGES',
    absentLabel: 'Images uniques — doit être absent',
  },
  {
    key: 'DUP.logos',
    label: 'Logos (répétition normale)',
    checkId: 'IMAGES',
    absentLabel: 'Logos (répétition normale) — doit être absent',
  },
  {
    key: 'DUP.no_duplicates',
    label: "Aucun doublon d'image",
    checkId: 'IMAGES',
    absentLabel: "Aucun doublon d'image — absence conforme",
  },
  {
    key: 'DUP.duplicates',
    label: "Doublons d'images détectés",
    checkId: 'IMAGES',
    absentLabel: "Doublons d'images détectés — doit être absent",
  },

  // ── PICTOGRAM ─────────────────────────────────────────────────────────────
  {
    key: 'PICTO.fa_count',
    label: 'Icônes Font Awesome',
    checkId: 'PICTOGRAM',
    absentLabel: 'Icônes Font Awesome — doit être absent',
  },
  {
    key: 'PICTO.fa_accessibility',
    label: 'FA sans aria-label',
    checkId: 'PICTOGRAM',
    absentLabel: 'FA sans aria-label — absence conforme',
  },
  {
    key: 'PICTO.mi_count',
    label: 'Icônes Material',
    checkId: 'PICTOGRAM',
    absentLabel: 'Icônes Material — doit être absent',
  },
  {
    key: 'PICTO.bi_count',
    label: 'Icônes Bootstrap',
    checkId: 'PICTOGRAM',
    absentLabel: 'Icônes Bootstrap — doit être absent',
  },
  {
    key: 'PICTO.svg_count',
    label: 'SVG inline',
    checkId: 'PICTOGRAM',
    absentLabel: 'SVG inline — doit être absent',
  },
  {
    key: 'PICTO.svg_accessibility',
    label: 'SVG sans titre/aria',
    checkId: 'PICTOGRAM',
    absentLabel: 'SVG sans titre/aria — absence conforme',
  },
  {
    key: 'PICTO.fa_not_loaded',
    label: 'Bibliothèque FA absente',
    checkId: 'PICTOGRAM',
    absentLabel: 'Bibliothèque FA absente — absence conforme',
  },
  {
    key: 'PICTO.no_icons',
    label: 'Aucune icône détectée',
    checkId: 'PICTOGRAM',
    absentLabel: 'Aucune icône détectée — absence conforme',
  },
  {
    key: 'PICTO.total',
    label: 'Total icônes',
    checkId: 'PICTOGRAM',
    absentLabel: 'Total icônes — doit être absent',
  },

  // ── DATA_BINDING ──────────────────────────────────────────────────────────
  {
    key: 'DATA_BINDING.no_data_field',
    label: 'Aucun champ connecté déclaré',
    checkId: 'DATA_BINDING',
    absentLabel: 'Aucun champ connecté déclaré — absence conforme',
  },
  {
    key: 'DATA_BINDING.data_field_count',
    label: 'Champs connectés déclarés',
    checkId: 'DATA_BINDING',
    absentLabel: 'Champs connectés déclarés — doit être absent',
  },
  {
    key: 'DATA_BINDING.empty_data_field',
    label: 'Champs connectés vides',
    checkId: 'DATA_BINDING',
    absentLabel: 'Champs connectés vides — doit être absent',
  },
  {
    key: 'DATA_BINDING.no_data_binding',
    label: 'Aucun champ connecté actif',
    checkId: 'DATA_BINDING',
    absentLabel: 'Aucun champ connecté actif — absence conforme',
  },
  {
    key: 'DATA_BINDING.data_binding_count',
    label: 'Champs connectés actifs',
    checkId: 'DATA_BINDING',
    absentLabel: 'Champs connectés actifs — doit être absent',
  },
  {
    key: 'DATA_BINDING.data_binding_empty',
    label: 'Champs connectés sans valeur',
    checkId: 'DATA_BINDING',
    absentLabel: 'Champs connectés sans valeur — doit être absent',
  },
  {
    key: 'DATA_BINDING.ctc_count',
    label: 'Liens click-to-call',
    checkId: 'DATA_BINDING',
    absentLabel: 'Liens click-to-call — doit être absent',
  },
  {
    key: 'DATA_BINDING.ctm_count',
    label: 'Liens click-to-mail',
    checkId: 'DATA_BINDING',
    absentLabel: 'Liens click-to-mail — doit être absent',
  },
  {
    key: 'DATA_BINDING.duda_config',
    label: 'Config Duda détectée',
    checkId: 'DATA_BINDING',
    absentLabel: 'Config Duda détectée — doit être absent',
  },
  {
    key: 'DATA_BINDING.logo_connected',
    label: 'Logo connecté (data-binding)',
    checkId: 'DATA_BINDING',
    absentLabel: 'Logo connecté (data-binding) — doit être absent',
  },
  {
    key: 'DATA_BINDING.ctc_connected',
    label: 'CTC connecté au téléphone',
    checkId: 'DATA_BINDING',
    absentLabel: 'CTC connecté au téléphone — doit être absent',
  },
  {
    key: 'DATA_BINDING.map_connected',
    label: "Carte connectée à l'adresse",
    checkId: 'DATA_BINDING',
    absentLabel: "Carte connectée à l'adresse — doit être absent",
  },
  {
    key: 'DATA_BINDING.hours_connected',
    label: 'Horaires connectés au Content Manager',
    checkId: 'DATA_BINDING',
    absentLabel: 'Horaires connectés au Content Manager — doit être absent',
  },
  {
    key: 'DATA_BINDING.social_connected',
    label: 'Réseaux sociaux connectés',
    checkId: 'DATA_BINDING',
    absentLabel: 'Réseaux sociaux connectés — doit être absent',
  },
  {
    key: 'DATA_BINDING.form_connected',
    label: "Formulaire connecté à l'email",
    checkId: 'DATA_BINDING',
    absentLabel: "Formulaire connecté à l'email — doit être absent",
  },
  {
    key: 'DATA_BINDING.footer_address',
    label: 'Adresse connectée dans le footer',
    checkId: 'DATA_BINDING',
    absentLabel: 'Adresse connectée dans le footer — doit être absent',
  },

  // ── MENTIONS_LEGALES_DATA ─────────────────────────────────────────────────
  {
    key: 'ML_DATA.widget_missing',
    label: 'Widget données connectées absent',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Widget données connectées absent — absence conforme',
  },
  {
    key: 'ML_DATA.widget_found',
    label: 'Widget données connectées présent',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Widget données connectées présent — doit être absent',
  },
  {
    key: 'ML_DATA.binding_raisonsociale',
    label: 'Raison sociale',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Raison sociale — doit être absent',
  },
  {
    key: 'ML_DATA.binding_juridique',
    label: 'Forme juridique',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Forme juridique — doit être absent',
  },
  {
    key: 'ML_DATA.binding_capitalsocial',
    label: 'Capital social',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Capital social — doit être absent',
  },
  {
    key: 'ML_DATA.binding_adresse',
    label: 'Adresse',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Adresse — doit être absent',
  },
  {
    key: 'ML_DATA.binding_email',
    label: 'E-mail',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'E-mail — doit être absent',
  },
  {
    key: 'ML_DATA.binding_telephone',
    label: 'Téléphone',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Téléphone — doit être absent',
  },
  {
    key: 'ML_DATA.binding_rcs',
    label: 'N° RCS / Répertoire des métiers',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'N° RCS / Répertoire des métiers — doit être absent',
  },
  {
    key: 'ML_DATA.binding_siret',
    label: 'N° SIRET',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'N° SIRET — doit être absent',
  },
  {
    key: 'ML_DATA.binding_tva',
    label: 'N° TVA intracommunautaire',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'N° TVA intracommunautaire — doit être absent',
  },
  {
    key: 'ML_DATA.binding_directeur',
    label: 'Directeur de la publication',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Directeur de la publication — doit être absent',
  },
  {
    key: 'ML_DATA.binding_reglespro',
    label: 'Règles professionnelles',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Règles professionnelles — doit être absent',
  },
  {
    key: 'ML_DATA.binding_titrepro',
    label: 'Titre professionnel',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Titre professionnel — doit être absent',
  },
  {
    key: 'ML_DATA.binding_etat',
    label: 'État UE — titre pro',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'État UE — titre pro — doit être absent',
  },
  {
    key: 'ML_DATA.binding_ordre',
    label: 'Ordre / organisme',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Ordre / organisme — doit être absent',
  },
  {
    key: 'ML_DATA.binding_specifique',
    label: 'Mentions légales spécifiques',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Mentions légales spécifiques — doit être absent',
  },
  {
    key: 'ML_DATA.binding_champlibre',
    label: 'Champ libre — mention obligatoire',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Champ libre — mention obligatoire — doit être absent',
  },
  {
    key: 'ML_DATA.binding_mediateur',
    label: 'Médiateur de la consommation',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Médiateur de la consommation — doit être absent',
  },
  {
    key: 'ML_DATA.binding_mentionsobligatoires',
    label: 'Mentions obligatoires',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Mentions obligatoires — doit être absent',
  },

  // ── FAVICON ───────────────────────────────────────────────────────────────
  {
    key: 'FAVICON.missing',
    label: 'Favicon absente',
    checkId: 'FAVICON',
    absentLabel: 'Favicon absente — absence conforme',
  },
  {
    key: 'FAVICON.present',
    label: 'Favicon présente',
    checkId: 'FAVICON',
    absentLabel: 'Favicon présente — doit être absent',
  },
  {
    key: 'FAVICON.duda_default',
    label: 'Favicon par défaut Duda',
    checkId: 'FAVICON',
    absentLabel: 'Favicon par défaut Duda — doit être absent',
  },
  {
    key: 'FAVICON.apple_touch',
    label: 'Apple Touch Icon présent',
    checkId: 'FAVICON',
    absentLabel: 'Apple Touch Icon présent — doit être absent',
  },
  {
    key: 'FAVICON.apple_touch_missing',
    label: 'Apple Touch Icon absent',
    checkId: 'FAVICON',
    absentLabel: 'Apple Touch Icon absent — absence conforme',
  },
  {
    key: 'FAVICON.sizes',
    label: 'Tailles favicon déclarées',
    checkId: 'FAVICON',
    absentLabel: 'Tailles favicon déclarées — doit être absent',
  },

  // ── CANONICAL ─────────────────────────────────────────────────────────────
  {
    key: 'CANONICAL.missing',
    label: 'Canonical absent',
    checkId: 'CANONICAL',
    absentLabel: 'Canonical absent — absence conforme',
  },
  {
    key: 'CANONICAL.multiple',
    label: 'Plusieurs canonicals',
    checkId: 'CANONICAL',
    absentLabel: 'Plusieurs canonicals — doit être absent',
  },
  {
    key: 'CANONICAL.no_href',
    label: 'Canonical sans href',
    checkId: 'CANONICAL',
    absentLabel: 'Canonical sans href — absence conforme',
  },
  {
    key: 'CANONICAL.url_ok',
    label: 'URL canonical valide',
    checkId: 'CANONICAL',
    absentLabel: 'URL canonical valide — doit être absent',
  },
  {
    key: 'CANONICAL.cross_domain',
    label: 'Canonical domaine croisé',
    checkId: 'CANONICAL',
    absentLabel: 'Canonical domaine croisé — doit être absent',
  },
  {
    key: 'CANONICAL.query_fragment',
    label: 'Canonical avec query/hash',
    checkId: 'CANONICAL',
    absentLabel: 'Canonical avec query/hash — doit être absent',
  },
  {
    key: 'CANONICAL.http',
    label: 'Canonical en HTTP',
    checkId: 'CANONICAL',
    absentLabel: 'Canonical en HTTP — doit être absent',
  },
  {
    key: 'CANONICAL.invalid_url',
    label: 'URL canonical invalide',
    checkId: 'CANONICAL',
    absentLabel: 'URL canonical invalide — doit être absent',
  },

  // ── OPEN_GRAPH ────────────────────────────────────────────────────────────
  {
    key: 'OG.og_title_missing',
    label: 'og:title manquant',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:title manquant — absence conforme',
  },
  {
    key: 'OG.og_title_ok',
    label: 'og:title présent',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:title présent — doit être absent',
  },
  {
    key: 'OG.og_description_missing',
    label: 'og:description manquante',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:description manquante — absence conforme',
  },
  {
    key: 'OG.og_description_ok',
    label: 'og:description présente',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:description présente — doit être absent',
  },
  {
    key: 'OG.og_image_missing',
    label: 'og:image manquante',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:image manquante — absence conforme',
  },
  {
    key: 'OG.og_image_ok',
    label: 'og:image présente',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:image présente — doit être absent',
  },
  {
    key: 'OG.og_image_present',
    label: 'og:image accessible',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:image accessible — doit être absent',
  },
  {
    key: 'OG.og_image_http',
    label: 'og:image en HTTP',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:image en HTTP — doit être absent',
  },
  {
    key: 'OG.og_url_missing',
    label: 'og:url manquante',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:url manquante — absence conforme',
  },
  {
    key: 'OG.og_url_ok',
    label: 'og:url présente',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:url présente — doit être absent',
  },
  {
    key: 'OG.og_type_missing',
    label: 'og:type manquant',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:type manquant — absence conforme',
  },
  {
    key: 'OG.og_type_ok',
    label: 'og:type présent',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'og:type présent — doit être absent',
  },
  {
    key: 'OG.twitter_none',
    label: 'Twitter Card absente',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'Twitter Card absente — absence conforme',
  },
  {
    key: 'OG.twitter_card_missing',
    label: 'twitter:card manquant',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:card manquant — absence conforme',
  },
  {
    key: 'OG.twitter_card_ok',
    label: 'twitter:card présent',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:card présent — doit être absent',
  },
  {
    key: 'OG.twitter_title_missing',
    label: 'twitter:title manquant',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:title manquant — absence conforme',
  },
  {
    key: 'OG.twitter_title_ok',
    label: 'twitter:title présent',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:title présent — doit être absent',
  },
  {
    key: 'OG.twitter_description_missing',
    label: 'twitter:description manquante',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:description manquante — absence conforme',
  },
  {
    key: 'OG.twitter_description_ok',
    label: 'twitter:description présente',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:description présente — doit être absent',
  },
  {
    key: 'OG.twitter_image_missing',
    label: 'twitter:image manquante',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:image manquante — absence conforme',
  },
  {
    key: 'OG.twitter_image_ok',
    label: 'twitter:image présente',
    checkId: 'OPEN_GRAPH',
    absentLabel: 'twitter:image présente — doit être absent',
  },

  // ── STRUCTURED_DATA — fusionné dans MENTIONS_LEGALES_DATA ─────────────────
  {
    key: 'SD.json_invalid',
    label: 'JSON-LD invalide',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'JSON-LD invalide — absence conforme',
  },
  {
    key: 'SD.no_json_ld',
    label: 'Aucun JSON-LD',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Aucun JSON-LD — absence conforme',
  },
  {
    key: 'SD.json_ld_count',
    label: 'Nombre de blocs JSON-LD',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Nombre de blocs JSON-LD — doit être absent',
  },
  {
    key: 'SD.type_block',
    label: 'Type de bloc détecté',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Type de bloc détecté — doit être absent',
  },
  {
    key: 'SD.lb_name_missing',
    label: 'LocalBusiness : nom absent',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'LocalBusiness : nom absent — absence conforme',
  },
  {
    key: 'SD.lb_contact_missing',
    label: 'LocalBusiness : contact absent',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'LocalBusiness : contact absent — absence conforme',
  },
  {
    key: 'SD.lb_address_missing',
    label: 'LocalBusiness : adresse absente',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'LocalBusiness : adresse absente — absence conforme',
  },
  {
    key: 'SD.breadcrumb_empty',
    label: 'Breadcrumb vide',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Breadcrumb vide — absence conforme',
  },
  {
    key: 'SD.microdata',
    label: 'Microdonnées détectées',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'Microdonnées détectées — doit être absent',
  },
  {
    key: 'SD.lb_five_images',
    label: 'LocalBusiness/Organization : au moins 5 images',
    checkId: 'MENTIONS_LEGALES_DATA',
    absentLabel: 'LocalBusiness/Organization : au moins 5 images — doit être absent',
  },

  // ── ANCHOR_TEXT ──────────────────────────────────────────────────────────
  {
    key: 'ANCHOR_TEXT.summary',
    label: 'Résumé concordance ancres',
    checkId: 'ANCHOR_TEXT',
    absentLabel: 'Résumé concordance ancres — doit être absent',
  },
  {
    key: 'ANCHOR_TEXT.discordant',
    label: 'Lien discordant (ancre ≠ URL)',
    checkId: 'ANCHOR_TEXT',
    absentLabel: 'Lien discordant (ancre ≠ URL) — doit être absent',
  },
  {
    key: 'ANCHOR_TEXT.ambiguous',
    label: 'Lien ambigu (URL non analysable)',
    checkId: 'ANCHOR_TEXT',
    absentLabel: 'Lien ambigu (URL non analysable) — doit être absent',
  },
  {
    key: 'ANCHOR_TEXT.concordant',
    label: 'Lien concordant (ancre ≈ URL)',
    checkId: 'ANCHOR_TEXT',
    absentLabel: 'Lien concordant (ancre ≈ URL) — doit être absent',
  },
  {
    key: 'ANCHOR_TEXT.probable',
    label: 'Lien probable (ancre ~ URL)',
    checkId: 'ANCHOR_TEXT',
    absentLabel: 'Lien probable (ancre ~ URL) — doit être absent',
  },
  {
    key: 'ANCHOR_TEXT.generic',
    label: 'Ancre(s) générique(s)',
    checkId: 'ANCHOR_TEXT',
    absentLabel: 'Ancre(s) générique(s) — doit être absent',
  },
  {
    key: 'ANCHOR_TEXT.no_links',
    label: 'Aucun lien interne analysable',
    checkId: 'ANCHOR_TEXT',
    absentLabel: 'Aucun lien interne analysable — absence conforme',
  },

  // ── ROBOTS_META ───────────────────────────────────────────────────────────
  {
    key: 'ROBOTS.no_directive',
    label: 'Aucune directive robots',
    checkId: 'ROBOTS_META',
    absentLabel: 'Aucune directive robots — absence conforme',
  },
  {
    key: 'ROBOTS.directive_ok',
    label: 'Directive robots OK',
    checkId: 'ROBOTS_META',
    absentLabel: 'Directive robots OK — doit être absent',
  },
  {
    key: 'ROBOTS.noindex',
    label: 'Page noindex',
    checkId: 'ROBOTS_META',
    absentLabel: 'Page noindex — doit être absent',
  },
  {
    key: 'ROBOTS.nofollow',
    label: 'Page nofollow',
    checkId: 'ROBOTS_META',
    absentLabel: 'Page nofollow — doit être absent',
  },
  {
    key: 'ROBOTS.noarchive',
    label: 'Page noarchive',
    checkId: 'ROBOTS_META',
    absentLabel: 'Page noarchive — doit être absent',
  },
  {
    key: 'ROBOTS.robots_txt_missing',
    label: 'robots.txt absent',
    checkId: 'ROBOTS_META',
    absentLabel: 'robots.txt absent — absence conforme',
  },
  {
    key: 'ROBOTS.robots_txt_ok',
    label: 'robots.txt présent',
    checkId: 'ROBOTS_META',
    absentLabel: 'robots.txt présent — doit être absent',
  },
  {
    key: 'ROBOTS.robots_txt_status',
    label: 'Statut robots.txt',
    checkId: 'ROBOTS_META',
    absentLabel: 'Statut robots.txt — doit être absent',
  },
  {
    key: 'ROBOTS.robots_txt_error',
    label: 'Erreur robots.txt',
    checkId: 'ROBOTS_META',
    absentLabel: 'Erreur robots.txt — doit être absent',
  },
  {
    key: 'ROBOTS.x_robots_tag',
    label: 'X-Robots-Tag détecté',
    checkId: 'ROBOTS_META',
    absentLabel: 'X-Robots-Tag détecté — doit être absent',
  },

  // ── LANG ──────────────────────────────────────────────────────────────────
  {
    key: 'LANG.missing',
    label: 'Attribut lang absent',
    checkId: 'LANG',
    absentLabel: 'Attribut lang absent — absence conforme',
  },
  {
    key: 'LANG.unusual',
    label: 'Langue inhabituelle',
    checkId: 'LANG',
    absentLabel: 'Langue inhabituelle — doit être absent',
  },
  {
    key: 'LANG.ok',
    label: 'Langue détectée',
    checkId: 'LANG',
    absentLabel: 'Langue détectée — doit être absent',
  },
  {
    key: 'LANG.content_language',
    label: 'Content-Language header',
    checkId: 'LANG',
    absentLabel: 'Content-Language header — doit être absent',
  },
  {
    key: 'LANG.lang_mismatch',
    label: 'Incohérence de langue',
    checkId: 'LANG',
    absentLabel: 'Incohérence de langue — doit être absent',
  },
  {
    key: 'LANG.hreflang_count',
    label: 'Balises hreflang',
    checkId: 'LANG',
    absentLabel: 'Balises hreflang — doit être absent',
  },
  {
    key: 'LANG.hreflang_no_default',
    label: 'Hreflang x-default absent',
    checkId: 'LANG',
    absentLabel: 'Hreflang x-default absent — absence conforme',
  },
  {
    key: 'LANG.rtl',
    label: 'Langue RTL détectée',
    checkId: 'LANG',
    absentLabel: 'Langue RTL détectée — doit être absent',
  },

  // ── REDIRECTS ─────────────────────────────────────────────────────────────
  {
    key: 'REDIRECTS.hop_count',
    label: 'Nombre de redirections',
    checkId: 'REDIRECTS',
    absentLabel: 'Nombre de redirections — doit être absent',
  },
  {
    key: 'REDIRECTS.http_to_https',
    label: 'Redirection HTTP→HTTPS',
    checkId: 'REDIRECTS',
    absentLabel: 'Redirection HTTP→HTTPS — doit être absent',
  },
  {
    key: 'REDIRECTS.final_http',
    label: 'URL finale en HTTP',
    checkId: 'REDIRECTS',
    absentLabel: 'URL finale en HTTP — doit être absent',
  },
  {
    key: 'REDIRECTS.https',
    label: 'HTTPS actif',
    checkId: 'REDIRECTS',
    absentLabel: 'HTTPS actif — doit être absent',
  },
  {
    key: 'REDIRECTS.www_mismatch',
    label: 'Incohérence www',
    checkId: 'REDIRECTS',
    absentLabel: 'Incohérence www — doit être absent',
  },
  {
    key: 'REDIRECTS.status_redirect',
    label: 'Statut redirection',
    checkId: 'REDIRECTS',
    absentLabel: 'Statut redirection — doit être absent',
  },
  {
    key: 'REDIRECTS.status_ok',
    label: 'Statut HTTP OK',
    checkId: 'REDIRECTS',
    absentLabel: 'Statut HTTP OK — doit être absent',
  },
  {
    key: 'REDIRECTS.status_error',
    label: 'Erreur HTTP',
    checkId: 'REDIRECTS',
    absentLabel: 'Erreur HTTP — doit être absent',
  },
  {
    key: 'REDIRECTS.internal_link_redirected',
    label: 'Liens internes vers une URL redirigée',
    checkId: 'REDIRECTS',
    absentLabel: 'Liens internes vers une URL redirigée — doit être absent',
  },

  // ── TRACKING ──────────────────────────────────────────────────────────────
  {
    key: 'TRACKING.tool_detected',
    label: 'Outil de tracking détecté',
    checkId: 'TRACKING',
    absentLabel: 'Outil de tracking détecté — doit être absent',
  },
  {
    key: 'TRACKING.none',
    label: 'Aucun tracking détecté',
    checkId: 'TRACKING',
    absentLabel: 'Aucun tracking détecté — absence conforme',
  },
  {
    key: 'TRACKING.count',
    label: "Nombre d'outils tracking",
    checkId: 'TRACKING',
    absentLabel: "Nombre d'outils tracking — doit être absent",
  },
  {
    key: 'TRACKING.no_cmp',
    label: 'CMP absente',
    checkId: 'TRACKING',
    absentLabel: 'CMP absente — absence conforme',
  },
  {
    key: 'TRACKING.cmp_ok',
    label: 'CMP présente',
    checkId: 'TRACKING',
    absentLabel: 'CMP présente — doit être absent',
  },

  // ── BROKEN_LINKS ──────────────────────────────────────────────────────────
  {
    key: 'BROKEN.checked',
    label: 'Liens vérifiés',
    checkId: 'BROKEN_LINKS',
    absentLabel: 'Liens vérifiés — doit être absent',
  },
  {
    key: 'BROKEN.broken',
    label: 'Liens brisés',
    checkId: 'BROKEN_LINKS',
    absentLabel: 'Liens brisés — doit être absent',
  },
  {
    key: 'BROKEN.no_broken',
    label: 'Aucun lien brisé',
    checkId: 'BROKEN_LINKS',
    absentLabel: 'Aucun lien brisé — absence conforme',
  },
  {
    key: 'BROKEN.timeout',
    label: 'Liens en timeout',
    checkId: 'BROKEN_LINKS',
    absentLabel: 'Liens en timeout — doit être absent',
  },
  {
    key: 'BROKEN.redirected',
    label: 'Liens redirigés',
    checkId: 'BROKEN_LINKS',
    absentLabel: 'Liens redirigés — doit être absent',
  },
  {
    key: 'BROKEN.rate_limited',
    label: 'Liens limités (429)',
    checkId: 'BROKEN_LINKS',
    absentLabel: 'Liens limités (429) — doit être absent',
  },
  {
    key: 'BROKEN.link_valid',
    label: 'Détail des liens valides (type + statut)',
    checkId: 'BROKEN_LINKS',
  },

  // ── SPLIT_LINKS ───────────────────────────────────────────────────────────
  {
    key: 'SPLIT.no_split',
    label: 'Aucun lien coupé',
    checkId: 'SPLIT_LINKS',
    absentLabel: 'Aucun lien coupé — absence conforme',
  },
  {
    key: 'SPLIT.split_found',
    label: 'Liens coupés détectés',
    checkId: 'SPLIT_LINKS',
    absentLabel: 'Liens coupés détectés — doit être absent',
  },
  {
    key: 'SPLIT.no_duplicate',
    label: 'Aucun doublon consécutif',
    checkId: 'SPLIT_LINKS',
    absentLabel: 'Aucun doublon consécutif — absence conforme',
  },
  {
    key: 'SPLIT.duplicate_found',
    label: 'Doublons consécutifs',
    checkId: 'SPLIT_LINKS',
    absentLabel: 'Doublons consécutifs — doit être absent',
  },

  // ── HN_STRUCTURE ──────────────────────────────────────────────────────────
  {
    key: 'HN.h1_missing',
    label: 'H1 manquant',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'H1 manquant — absence conforme',
  },
  {
    key: 'HN.h1_duplicate',
    label: 'Plusieurs H1',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'Plusieurs H1 — doit être absent',
  },
  {
    key: 'HN.h1_unique',
    label: 'H1 unique',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'H1 unique — doit être absent',
  },
  {
    key: 'HN.first_not_h1',
    label: 'Premier heading ≠ H1',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'Premier heading ≠ H1 — absence conforme',
  },
  {
    key: 'HN.h2_insufficient',
    label: 'Trop peu de H2',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'Trop peu de H2 — absence conforme',
  },
  {
    key: 'HN.h2_count',
    label: 'Nombre de H2',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'Nombre de H2 — doit être absent',
  },
  {
    key: 'HN.hierarchy_break',
    label: 'Rupture hiérarchie Hn',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'Rupture hiérarchie Hn — doit être absent',
  },
  {
    key: 'HN.hierarchy_ok',
    label: 'Hiérarchie Hn correcte',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'Hiérarchie Hn correcte — doit être absent',
  },
  {
    key: 'HN.common_words',
    label: 'Mots génériques dans Hn',
    checkId: 'HN_STRUCTURE',
    absentLabel: 'Mots génériques dans Hn — doit être absent',
  },

  // ── HN_LENGTH ─────────────────────────────────────────────────────────────
  {
    key: 'HN_LENGTH.too_short',
    label: 'Titre H1/H2 trop court',
    checkId: 'HN_LENGTH',
    absentLabel: 'Titre H1/H2 trop court — absence conforme',
  },
  {
    key: 'HN_LENGTH.too_long',
    label: 'Titre H1/H2 trop long',
    checkId: 'HN_LENGTH',
    absentLabel: 'Titre H1/H2 trop long — absence conforme',
  },
  {
    key: 'HN_LENGTH.ok',
    label: 'Longueur H1/H2 correcte',
    checkId: 'HN_LENGTH',
    absentLabel: 'Longueur H1/H2 correcte — doit être absent',
  },
  {
    key: 'HN_LENGTH.no_h1_h2',
    label: 'Aucun H1/H2 à vérifier',
    checkId: 'HN_LENGTH',
    absentLabel: 'Aucun H1/H2 à vérifier — absence conforme',
  },

  // ── METAS ─────────────────────────────────────────────────────────────────
  {
    key: 'METAS.title_missing',
    label: 'Titre manquant',
    checkId: 'METAS',
    absentLabel: 'Titre manquant — absence conforme',
  },
  {
    key: 'METAS.title_short',
    label: 'Titre trop court',
    checkId: 'METAS',
    absentLabel: 'Titre trop court — absence conforme',
  },
  {
    key: 'METAS.title_long',
    label: 'Titre trop long',
    checkId: 'METAS',
    absentLabel: 'Titre trop long — absence conforme',
  },
  {
    key: 'METAS.title_ok',
    label: 'Titre OK',
    checkId: 'METAS',
    absentLabel: 'Titre OK — doit être absent',
  },
  {
    key: 'METAS.desc_missing',
    label: 'Description manquante',
    checkId: 'METAS',
    absentLabel: 'Description manquante — absence conforme',
  },
  {
    key: 'METAS.desc_short',
    label: 'Description trop courte',
    checkId: 'METAS',
    absentLabel: 'Description trop courte — absence conforme',
  },
  {
    key: 'METAS.desc_long',
    label: 'Description trop longue',
    checkId: 'METAS',
    absentLabel: 'Description trop longue — absence conforme',
  },
  {
    key: 'METAS.desc_ok',
    label: 'Description OK',
    checkId: 'METAS',
    absentLabel: 'Description OK — doit être absent',
  },
  {
    key: 'METAS.title_desc_identical',
    label: 'Titre = Description',
    checkId: 'METAS',
    absentLabel: 'Titre = Description — doit être absent',
  },
  {
    key: 'METAS.noindex',
    label: 'Balise noindex',
    checkId: 'METAS',
    absentLabel: 'Balise noindex — doit être absent',
  },
  {
    key: 'METAS.robots_ok',
    label: 'Robots meta OK',
    checkId: 'METAS',
    absentLabel: 'Robots meta OK — doit être absent',
  },
  {
    key: 'METAS.viewport_missing',
    label: 'Viewport manquant',
    checkId: 'METAS',
    absentLabel: 'Viewport manquant — absence conforme',
  },
  {
    key: 'METAS.viewport_ok',
    label: 'Viewport présent',
    checkId: 'METAS',
    absentLabel: 'Viewport présent — doit être absent',
  },
  {
    key: 'METAS.charset_missing',
    label: 'Charset manquant',
    checkId: 'METAS',
    absentLabel: 'Charset manquant — absence conforme',
  },
  {
    key: 'METAS.charset_ok',
    label: 'Charset présent',
    checkId: 'METAS',
    absentLabel: 'Charset présent — doit être absent',
  },
  {
    key: 'METAS.og_title_missing',
    label: 'og:title manquant (metas)',
    checkId: 'METAS',
    absentLabel: 'og:title manquant (metas) — absence conforme',
  },
  {
    key: 'METAS.og_title_ok',
    label: 'og:title présent (metas)',
    checkId: 'METAS',
    absentLabel: 'og:title présent (metas) — doit être absent',
  },
  {
    key: 'METAS.title_unique',
    label: 'Title unique inter-pages',
    checkId: 'METAS',
    absentLabel: 'Title unique inter-pages — doit être absent',
  },
  {
    key: 'METAS.desc_unique',
    label: 'Description unique inter-pages',
    checkId: 'METAS',
    absentLabel: 'Description unique inter-pages — doit être absent',
  },
  {
    key: 'METAS.title_duplicate',
    label: 'Title dupliqué inter-pages',
    checkId: 'METAS',
    absentLabel: 'Title dupliqué inter-pages — doit être absent',
  },
  {
    key: 'METAS.desc_duplicate',
    label: 'Description dupliquée inter-pages',
    checkId: 'METAS',
    absentLabel: 'Description dupliquée inter-pages — doit être absent',
  },

  // ── BOLD ──────────────────────────────────────────────────────────────────
  {
    key: 'BOLD.none',
    label: 'Aucun gras',
    checkId: 'BOLD',
    absentLabel: 'Aucun gras — absence conforme',
  },
  {
    key: 'BOLD.too_few',
    label: 'Trop peu de gras',
    checkId: 'BOLD',
    absentLabel: 'Trop peu de gras — absence conforme',
  },
  {
    key: 'BOLD.too_many',
    label: 'Trop de gras',
    checkId: 'BOLD',
    absentLabel: 'Trop de gras — doit être absent',
  },
  {
    key: 'BOLD.count_ok',
    label: 'Nombre de gras OK',
    checkId: 'BOLD',
    absentLabel: 'Nombre de gras OK — doit être absent',
  },
  {
    key: 'BOLD.context_poor',
    label: 'Contexte gras pauvre',
    checkId: 'BOLD',
    absentLabel: 'Contexte gras pauvre — absence conforme',
  },
  {
    key: 'BOLD.context_ok',
    label: 'Contexte gras OK',
    checkId: 'BOLD',
    absentLabel: 'Contexte gras OK — doit être absent',
  },
  {
    key: 'BOLD.empty',
    label: 'Balises gras vides',
    checkId: 'BOLD',
    absentLabel: 'Balises gras vides — doit être absent',
  },

  // ── LINKS ─────────────────────────────────────────────────────────────────
  {
    key: 'LINKS.total',
    label: 'Total liens',
    checkId: 'LINKS',
    absentLabel: 'Total liens — doit être absent',
  },
  {
    key: 'LINKS.internal',
    label: 'Liens internes',
    checkId: 'LINKS',
    absentLabel: 'Liens internes — doit être absent',
  },
  {
    key: 'LINKS.external',
    label: 'Liens externes',
    checkId: 'LINKS',
    absentLabel: 'Liens externes — doit être absent',
  },
  {
    key: 'LINKS.ctc_invalid',
    label: 'Liens click-to-call invalides',
    checkId: 'LINKS',
    absentLabel: 'Liens click-to-call invalides — doit être absent',
  },
  {
    key: 'LINKS.ctm_invalid',
    label: 'Liens click-to-mail invalides',
    checkId: 'LINKS',
    absentLabel: 'Liens click-to-mail invalides — doit être absent',
  },
  {
    key: 'LINKS.external_nofollow',
    label: 'Liens ext. sans nofollow',
    checkId: 'LINKS',
    absentLabel: 'Liens ext. sans nofollow — doit être absent',
  },
  {
    key: 'LINKS.empty_anchors',
    label: 'Ancres vides',
    checkId: 'LINKS',
    absentLabel: 'Ancres vides — doit être absent',
  },
  {
    key: 'LINKS.no_http',
    label: 'Liens HTTP non sécurisés',
    checkId: 'LINKS',
    absentLabel: 'Liens HTTP non sécurisés — doit être absent',
  },
  {
    key: 'LINKS.self_reference',
    label: 'Liens auto-référentiels (page courante)',
    checkId: 'LINKS',
    absentLabel: 'Liens auto-référentiels (page courante) — doit être absent',
  },

  // ── CONTENT_LENGTH ────────────────────────────────────────────────────────
  {
    key: 'CONTENT.word_count_fail',
    label: 'Contenu insuffisant',
    checkId: 'CONTENT_LENGTH',
    absentLabel: 'Contenu insuffisant — absence conforme',
  },
  {
    key: 'CONTENT.word_count_warn',
    label: 'Contenu limite',
    checkId: 'CONTENT_LENGTH',
    absentLabel: 'Contenu limite — absence conforme',
  },
  {
    key: 'CONTENT.word_count_ok',
    label: 'Contenu suffisant',
    checkId: 'CONTENT_LENGTH',
    absentLabel: 'Contenu suffisant — doit être absent',
  },
  {
    key: 'CONTENT.duplicates',
    label: 'Paragraphes dupliqués',
    checkId: 'CONTENT_LENGTH',
    absentLabel: 'Paragraphes dupliqués — doit être absent',
  },
  {
    key: 'CONTENT.no_duplicates',
    label: 'Aucun doublon contenu',
    checkId: 'CONTENT_LENGTH',
    absentLabel: 'Aucun doublon contenu — absence conforme',
  },
  {
    key: 'CONTENT.ratio_low',
    label: 'Ratio texte/code faible',
    checkId: 'CONTENT_LENGTH',
    absentLabel: 'Ratio texte/code faible — absence conforme',
  },
  {
    key: 'CONTENT.ratio_ok',
    label: 'Ratio texte/code OK',
    checkId: 'CONTENT_LENGTH',
    absentLabel: 'Ratio texte/code OK — doit être absent',
  },

  // ── CTA ───────────────────────────────────────────────────────────────────
  {
    key: 'CTA.button_count',
    label: 'Nombre de boutons',
    checkId: 'CTA',
    absentLabel: 'Nombre de boutons — doit être absent',
  },
  {
    key: 'CTA.buttons_empty',
    label: 'Boutons sans texte',
    checkId: 'CTA',
    absentLabel: 'Boutons sans texte — doit être absent',
  },
  {
    key: 'CTA.cta_links',
    label: 'Liens CTA',
    checkId: 'CTA',
    absentLabel: 'Liens CTA — doit être absent',
  },
  {
    key: 'CTA.image_links',
    label: 'Liens images',
    checkId: 'CTA',
    absentLabel: 'Liens images — doit être absent',
  },
  {
    key: 'CTA.phone_count',
    label: 'Liens téléphone',
    checkId: 'CTA',
    absentLabel: 'Liens téléphone — doit être absent',
  },
  {
    key: 'CTA.no_phone',
    label: 'Aucun lien téléphone',
    checkId: 'CTA',
    absentLabel: 'Aucun lien téléphone — absence conforme',
  },
  {
    key: 'CTA.email_count',
    label: 'Liens email',
    checkId: 'CTA',
    absentLabel: 'Liens email — doit être absent',
  },
  {
    key: 'CTA.no_email',
    label: 'Aucun lien email',
    checkId: 'CTA',
    absentLabel: 'Aucun lien email — absence conforme',
  },
  {
    key: 'CTA.no_cta',
    label: 'Aucun CTA détecté',
    checkId: 'CTA',
    absentLabel: 'Aucun CTA détecté — absence conforme',
  },

  // ── MENTIONS_LEGALES ──────────────────────────────────────────────────────
  {
    key: 'ML.legal_missing',
    label: 'Mentions légales absentes',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Mentions légales absentes — absence conforme',
  },
  {
    key: 'ML.legal_ok',
    label: 'Mentions légales présentes',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Mentions légales présentes — doit être absent',
  },
  {
    key: 'ML.legal_inaccessible',
    label: 'Mentions légales inaccessibles',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Mentions légales inaccessibles — absence conforme',
  },
  {
    key: 'ML.privacy_missing',
    label: 'Politique conf. absente',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Politique conf. absente — absence conforme',
  },
  {
    key: 'ML.privacy_ok',
    label: 'Politique conf. présente',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Politique conf. présente — doit être absent',
  },
  {
    key: 'ML.cgu_missing',
    label: 'CGU/CGV absentes',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'CGU/CGV absentes — absence conforme',
  },
  {
    key: 'ML.cgu_ok',
    label: 'CGU/CGV présentes',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'CGU/CGV présentes — doit être absent',
  },
  {
    key: 'ML.solocal_detected',
    label: 'Widget Solocal obsolète',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Widget Solocal obsolète — doit être absent',
  },
  {
    key: 'ML.solocal_ok',
    label: 'Widget Solocal absent',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Widget Solocal absent — absence conforme',
  },
  {
    key: 'ML.cookie_missing',
    label: 'Bandeau cookie absent',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Bandeau cookie absent — absence conforme',
  },
  {
    key: 'ML.cookie_ok',
    label: 'Bandeau cookie présent',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Bandeau cookie présent — doit être absent',
  },
  {
    key: 'ML.hosting_missing',
    label: 'Hébergeur non mentionné',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Hébergeur non mentionné — absence conforme',
  },
  {
    key: 'ML.hosting_ok',
    label: 'Hébergeur mentionné',
    checkId: 'MENTIONS_LEGALES',
    absentLabel: 'Hébergeur mentionné — doit être absent',
  },

  // ── CONTRAST_V2 ───────────────────────────────────────────────────
  {
    key: 'CONTRAST_V2.ok',
    label: 'Contraste conforme (AA/AAA)',
    checkId: 'CONTRAST_V2',
    absentLabel: 'Contraste conforme (AA/AAA) — doit être absent',
  },
  {
    key: 'CONTRAST_V2.ok.var',
    label: 'Paire template conforme',
    checkId: 'CONTRAST_V2',
    absentLabel: 'Paire template conforme — doit être absent',
  },
  {
    key: 'CONTRAST_V2.low',
    label: 'Contraste insuffisant',
    checkId: 'CONTRAST_V2',
    absentLabel: 'Contraste insuffisant — doit être absent',
  },
  {
    key: 'CONTRAST_V2.low.var',
    label: 'Paire template insuffisante',
    checkId: 'CONTRAST_V2',
    absentLabel: 'Paire template insuffisante — doit être absent',
  },

  // ── ACCESSIBILITY ─────────────────────────────────────────────────────────
  {
    key: 'A11Y.skip_missing',
    label: "Lien d'évitement absent",
    checkId: 'ACCESSIBILITY',
    absentLabel: "Lien d'évitement absent — absence conforme",
  },
  {
    key: 'A11Y.skip_ok',
    label: "Lien d'évitement présent",
    checkId: 'ACCESSIBILITY',
    absentLabel: "Lien d'évitement présent — doit être absent",
  },
  {
    key: 'A11Y.structure_incomplete',
    label: 'Structure sémantique incomplète',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Structure sémantique incomplète — absence conforme',
  },
  {
    key: 'A11Y.structure_ok',
    label: 'Structure sémantique OK',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Structure sémantique OK — doit être absent',
  },
  {
    key: 'A11Y.img_alt_missing',
    label: 'Images sans alt',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Images sans alt — absence conforme',
  },
  {
    key: 'A11Y.img_alt_ok',
    label: 'Toutes images avec alt',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Toutes images avec alt — doit être absent',
  },
  {
    key: 'A11Y.links_empty',
    label: 'Liens sans texte descriptif',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Liens sans texte descriptif — absence conforme',
  },
  {
    key: 'A11Y.links_ok',
    label: 'Tous liens avec texte',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Tous liens avec texte — doit être absent',
  },
  {
    key: 'A11Y.form_no_label',
    label: 'Champs sans label',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Champs sans label — absence conforme',
  },
  {
    key: 'A11Y.form_labeled',
    label: 'Champs avec label',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Champs avec label — doit être absent',
  },
  {
    key: 'A11Y.tabindex_positive',
    label: 'tabindex positif détecté',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'tabindex positif détecté — doit être absent',
  },
  {
    key: 'A11Y.aria_invalid',
    label: 'Rôles ARIA invalides',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Rôles ARIA invalides — doit être absent',
  },
  {
    key: 'A11Y.lang_missing',
    label: 'Attribut lang absent',
    checkId: 'ACCESSIBILITY',
    absentLabel: 'Attribut lang absent — absence conforme',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Statistiques calculées — dérivées du registre, jamais saisies à la main.
// Utilisées par le frontend (affichage) et les tests de cohérence des docs.
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupStats {
  /** Critères visibles dans l'UI (non-internes) */
  visible: number;
  /** Critères internes (fusionnés dans un parent ou extraction technique) */
  internal: number;
  /** Points de contrôle associés à ce groupe (via checkId du critère parent) */
  subChecks: number;
}

export interface RegistryStats {
  visibleTotal: number;
  internalTotal: number;
  registryTotal: number;
  subChecksTotal: number;
  byGroup: Record<CheckGroup, GroupStats>;
}

export const REGISTRY_STATS: RegistryStats = (() => {
  const groups: CheckGroup[] = ['Design', 'Technique', 'SEO'];
  const byGroup = {} as Record<CheckGroup, GroupStats>;
  for (const group of groups) {
    byGroup[group] = {
      visible: ANALYZERS_REGISTRY.filter(c => !c.internal && c.group === group).length,
      internal: ANALYZERS_REGISTRY.filter(c => !!c.internal && c.group === group).length,
      // Les points de contrôle sont regroupés par le groupe du critère auquel pointe checkId.
      subChecks: SUB_CHECKS_REGISTRY.filter(s => {
        const check = ANALYZERS_REGISTRY.find(c => c.id === s.checkId);
        return check?.group === group;
      }).length,
    };
  }
  return {
    visibleTotal: ANALYZERS_REGISTRY.filter(c => !c.internal).length,
    internalTotal: ANALYZERS_REGISTRY.filter(c => !!c.internal).length,
    registryTotal: ANALYZERS_REGISTRY.length,
    subChecksTotal: SUB_CHECKS_REGISTRY.length,
    byGroup,
  };
})();
