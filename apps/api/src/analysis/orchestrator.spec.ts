import { describe, expect, it } from 'vitest';
import { AnalysisReportSchema, type CheckResult, type CheckStatus } from '@websentry/shared';
import { applyPolarity, runAnalysis } from './orchestrator.js';
import { makePage, makeSettings } from './testing/page.factory.js';

const GOOD_PAGE = `
<html lang="fr">
  <head>
    <title>Boulangerie artisanale à Lyon — pains au levain</title>
    <meta name="description" content="Notre boulangerie artisanale lyonnaise propose des pains au levain naturel, viennoiseries et pâtisseries préparés chaque matin sur place." />
    <link rel="canonical" href="https://exemple.fr/" />
    <meta property="og:title" content="Boulangerie artisanale" />
    <meta property="og:description" content="Pains au levain" />
    <meta property="og:image" content="https://exemple.fr/img.jpg" />
    <meta property="og:url" content="https://exemple.fr/" />
  </head>
  <body>
    <h1>Boulangerie artisanale à Lyon</h1>
    <h2>Nos pains</h2>
    <p>${'Un texte de contenu suffisamment long pour satisfaire le seuil minimal. '.repeat(20)}</p>
    <h2>Nos horaires</h2>
    <p>${'Encore du contenu rédactionnel pour atteindre le volume attendu. '.repeat(20)}</p>
  </body>
</html>`;

describe('runAnalysis', () => {
  it('produit un rapport CONFORME au contrat partagé', async () => {
    // Le rapport est sérialisé vers un worker, stocké en base, puis relu : le
    // valider ici détecte une dérive à sa source plutôt qu'à la relecture.
    const report = await runAnalysis(makePage(GOOD_PAGE), makeSettings());
    expect(AnalysisReportSchema.safeParse(report).success).toBe(true);
  });

  it('note haut une page bien construite', async () => {
    const report = await runAnalysis(makePage(GOOD_PAGE), makeSettings());
    expect(report.globalScore).toBeGreaterThanOrEqual(4);
  });

  it('exécute TOUS les analyseurs enregistrés', async () => {
    const report = await runAnalysis(makePage(GOOD_PAGE), makeSettings());
    expect(Object.keys(report.checks)).toEqual(
      expect.arrayContaining(['METAS', 'HN_STRUCTURE', 'CANONICAL', 'LANG', 'CONTENT_LENGTH']),
    );
  });

  it('sanctionne une page vide', async () => {
    const report = await runAnalysis(makePage('<html><body></body></html>'), makeSettings());
    expect(report.globalScore).toBeLessThan(3);
  });

  it('FILTRE les en-têtes HTTP par liste fermée', async () => {
    const page = makePage(GOOD_PAGE, {
      headers: { 'content-type': 'text/html', 'set-cookie': 'session=secret' },
    });
    const report = await runAnalysis(page, makeSettings());
    expect(report.httpHeaders).toEqual({ 'content-type': 'text/html' });
  });

  it('honore l’identifiant d’analyse fourni', async () => {
    const analyzeId = '11111111-1111-4111-8111-111111111111';
    const report = await runAnalysis(makePage(GOOD_PAGE), makeSettings(), { analyzeId });
    expect(report.analyzeId).toBe(analyzeId);
  });

  it('remonte la progression critère par critère', async () => {
    const seen: number[] = [];
    await runAnalysis(makePage(GOOD_PAGE), makeSettings(), {
      onProgress: (_result, completed, total) => {
        seen.push(completed);
        expect(total).toBeGreaterThan(0);
      },
    });
    // Un rappel par critère, et le dernier annonce bien le total.
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(seen.length);
  });

  it('DÉSACTIVE un critère retiré des réglages', async () => {
    const report = await runAnalysis(
      makePage(GOOD_PAGE),
      makeSettings({ enabledChecks: ['METAS'] }),
    );
    expect(report.checks['METAS']?.status).not.toBe('na');
    expect(report.checks['CANONICAL']?.status).toBe('na');
  });

  it('applique les règles par page', async () => {
    const settings = makeSettings({
      pageRules: [{ label: 'Contact', patterns: ['contact'], disabledChecks: ['CONTENT_LENGTH'] }],
    });
    const page = makePage(GOOD_PAGE, { url: 'https://exemple.fr/nous-contacter' });
    const report = await runAnalysis(page, settings);
    expect(report.checks['CONTENT_LENGTH']?.status).toBe('na');
  });

  it('ISOLE l’échec d’un analyseur', async () => {
    // Un analyseur qui lève ne doit pas emporter les autres : un rapport
    // partiel reste exploitable, une absence de rapport ne l'est pas.
    const page = makePage(GOOD_PAGE);
    // `$` rendu inutilisable : chaque analyseur qui l'interroge lèvera.
    const broken = {
      ...page,
      $: (() => {
        throw new Error('DOM indisponible');
      }) as unknown as typeof page.$,
    };
    const report = await runAnalysis(broken, makeSettings());

    const failed = Object.values(report.checks).filter(check => check.status === 'fail');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.summary).toContain('Erreur interne');
  });

  it('n’expose PAS la trace d’exécution d’un analyseur en échec', async () => {
    const page = makePage(GOOD_PAGE);
    const broken = {
      ...page,
      $: (() => {
        throw new Error('ENOENT /srv/app/secret.ts:42');
      }) as unknown as typeof page.$,
    };
    const report = await runAnalysis(broken, makeSettings());

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/at .*\.ts:\d+/);
  });
});

describe('applyPolarity', () => {
  const result = (
    items: Array<{ key?: string; label: string; status: CheckStatus }>,
  ): CheckResult => ({
    checkId: 'METAS',
    checkTitle: 'Balises méta',
    globalScore: 5,
    status: 'pass',
    items,
    summary: 'résumé',
    recommendations: [],
  });

  it('rend l’objet d’origine sans polarité définie', () => {
    const original = result([{ key: 'METAS.title_ok', label: 'ok', status: 'pass' }]);
    expect(applyPolarity(original, {})).toBe(original);
  });

  it('rend l’objet d’origine quand aucun item n’est concerné', () => {
    const original = result([{ key: 'METAS.title_ok', label: 'ok', status: 'pass' }]);
    expect(applyPolarity(original, { 'AUTRE.cle': 'absent' })).toBe(original);
  });

  it('rend l’objet d’origine sans items', () => {
    const original = result([]);
    expect(applyPolarity(original, { 'METAS.title_ok': 'absent' })).toBe(original);
  });

  it('INVERSE conforme et échec', () => {
    const inverted = applyPolarity(
      result([{ key: 'METAS.title_ok', label: 'ok', status: 'pass' }]),
      { 'METAS.title_ok': 'absent' },
    );
    expect(inverted.items[0]?.status).toBe('fail');
    expect(inverted.status).toBe('fail');
  });

  it('inverse un échec en conforme', () => {
    const inverted = applyPolarity(
      result([{ key: 'METAS.title_missing', label: 'manquant', status: 'fail' }]),
      { 'METAS.title_missing': 'absent' },
    );
    expect(inverted.items[0]?.status).toBe('pass');
    expect(inverted.status).toBe('pass');
  });

  it('transforme un avertissement en INFO, pas en réussite', () => {
    // L'inverse d'un « attention » n'est pas un « très bien », c'est l'absence
    // de remarque.
    const inverted = applyPolarity(
      result([{ key: 'METAS.title_short', label: 'court', status: 'warning' }]),
      { 'METAS.title_short': 'absent' },
    );
    expect(inverted.items[0]?.status).toBe('info');
  });

  it.each(['info', 'na'] as const)('N’INVERSE PAS le statut %s', status => {
    // Ils ne portent aucun jugement : leur contraire n'existe pas.
    const inverted = applyPolarity(result([{ key: 'METAS.x', label: 'x', status }]), {
      'METAS.x': 'absent',
    });
    expect(inverted.items[0]?.status).toBe(status);
  });

  it('REMPLACE le libellé, sans quoi le rapport se contredirait', () => {
    // Afficher « conforme » sous un intitulé qui dit « manquant » est pire que
    // de ne rien afficher.
    const inverted = applyPolarity(
      result([{ key: 'METAS.title_ok', label: 'Title présent', status: 'pass' }]),
      { 'METAS.title_ok': 'absent' },
    );
    expect(inverted.items[0]?.label).not.toBe('Title présent');
  });

  it('laisse intacts les items sans clé', () => {
    const inverted = applyPolarity(
      result([
        { key: 'METAS.title_ok', label: 'ok', status: 'pass' },
        { label: 'note libre', status: 'info' },
      ]),
      { 'METAS.title_ok': 'absent' },
    );
    expect(inverted.items[1]).toEqual({ label: 'note libre', status: 'info' });
  });

  it('RECALCULE la note après inversion', () => {
    const inverted = applyPolarity(
      result([
        { key: 'A.un', label: 'a', status: 'pass' },
        { key: 'A.deux', label: 'b', status: 'pass' },
      ]),
      { 'A.un': 'absent', 'A.deux': 'absent' },
    );
    // Deux échecs après inversion : la note doit avoir chuté.
    expect(inverted.globalScore).toBeLessThan(5);
  });
});
