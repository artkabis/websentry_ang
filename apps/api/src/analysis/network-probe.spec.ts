import { describe, expect, it } from 'vitest';
import {
  AnalysisProbe,
  CHECK_QUOTAS,
  DEFAULT_CHECK_QUOTA,
  type ProbeResult,
} from './network-probe.js';
import type { BilledResult, BilledText, ProbeEngine } from './probe-engine.js';

function ok(url: string): ProbeResult {
  return {
    url,
    status: 200,
    ok: true,
    redirected: false,
    finalUrl: url,
    contentLength: null,
    contentType: 'text/html',
  };
}

/**
 * Moteur simulé.
 *
 * Il facture la PREMIÈRE demande d'une URL et rend les suivantes gratuites,
 * comme le fait le vrai moteur avec son cache — c'est ce qui permet de vérifier
 * que le quota est remboursé quand rien n'est sorti sur le réseau.
 */
function fakeEngine(delayMs = 0): ProbeEngine & { calls: string[]; seen: Set<string> } {
  const calls: string[] = [];
  const seen = new Set<string>();

  const settle = async (url: string): Promise<BilledResult> => {
    calls.push(url);
    const billable = !seen.has(url);
    seen.add(url);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    return { result: ok(url), billable };
  };

  return {
    calls,
    seen,
    resolve: settle,
    text: async (url: string): Promise<BilledText> => ({ ...(await settle(url)), body: 'corps' }),
  };
}

describe('AnalysisProbe', () => {
  describe('répartition du budget', () => {
    it('donne à chaque critère un quota qui NE DÉPEND PAS des autres', async () => {
      // Sans quotas, les critères se servent dans l'ordre où ils se réveillent :
      // deux analyses de la même page rendraient deux rapports différents.
      const engine = fakeEngine();
      const probe = new AnalysisProbe(engine, { budget: 300 });

      const links = probe.forCheck('BROKEN_LINKS');
      const images = probe.forCheck('IMAGES');
      await links.checkMany(Array.from({ length: 500 }, (_, i) => `https://exemple.fr/l${i}`));

      expect(images.remaining).toBe(CHECK_QUOTAS['IMAGES']);
    });

    it('rend la MÊME vue pour un critère donné', () => {
      // Deux vues seraient deux quotas : le critère dépenserait le double.
      const probe = new AnalysisProbe(fakeEngine());

      expect(probe.forCheck('IMAGES')).toBe(probe.forCheck('IMAGES'));
    });

    it('une vue de critère se rend elle-même', () => {
      const view = new AnalysisProbe(fakeEngine()).forCheck('IMAGES');

      expect(view.forCheck('IMAGES')).toBe(view);
    });

    it('accorde un quota modeste à un critère qui n’en déclare pas', () => {
      const view = new AnalysisProbe(fakeEngine()).forCheck('CRITERE_INCONNU');

      expect(view.remaining).toBe(DEFAULT_CHECK_QUOTA);
    });

    it('REFUSE de sortir au-delà du quota du critère', async () => {
      const engine = fakeEngine();
      const view = new AnalysisProbe(engine).forCheck('ROBOTS_META');

      const urls = Array.from(
        { length: CHECK_QUOTAS['ROBOTS_META']! + 3 },
        (_, i) => `https://e.fr/${i}`,
      );
      const results = await view.checkMany(urls);

      expect(engine.calls).toHaveLength(CHECK_QUOTAS['ROBOTS_META']!);
      expect(results.filter(result => result.exhausted)).toHaveLength(3);
    });

    it('marque un dépassement comme NON VÉRIFIÉ, pas comme un échec du site', async () => {
      // Le quota est une limite de l'analyse : la confondre avec un lien mort
      // reprocherait au site ce que nous avons décidé de ne pas faire.
      const view = new AnalysisProbe(fakeEngine(), { budget: 0 }).forCheck('BROKEN_LINKS');

      const result = await view.check('https://exemple.fr/a');

      expect(result.exhausted).toBe(true);
      expect(result.status).toBeNull();
      expect(result.error).toContain('Quota');
    });

    it('fait respecter le plafond ABSOLU de l’analyse', async () => {
      // Le plafond ne répartit pas — les quotas s'en chargent — mais il empêche
      // qu'une page très fournie fasse du serveur un amplificateur.
      const engine = fakeEngine();
      const probe = new AnalysisProbe(engine, { budget: 5 });

      await probe
        .forCheck('BROKEN_LINKS')
        .checkMany(Array.from({ length: 20 }, (_, i) => `https://exemple.fr/a${i}`));
      const images = await probe.forCheck('IMAGES').check('https://exemple.fr/i.png');

      expect(engine.calls).toHaveLength(5);
      expect(images.exhausted).toBe(true);
    });
  });

  describe('déduplication', () => {
    it('ne vérifie qu’UNE FOIS un lien répété dans la page', async () => {
      // Le menu et le pied de page citent les mêmes liens des dizaines de fois
      // sur chaque page d'un site.
      const engine = fakeEngine();
      const view = new AnalysisProbe(engine).forCheck('BROKEN_LINKS');

      const results = await view.checkMany(
        Array.from({ length: 30 }, () => 'https://e.fr/accueil'),
      );

      expect(engine.calls).toHaveLength(1);
      expect(results).toHaveLength(30);
      expect(results.every(result => result.ok)).toBe(true);
    });

    it('ne facture pas une réponse déjà connue', async () => {
      // Deuxième page d'un lot : le menu est déjà en cache, et le quota du
      // critère doit rester disponible pour ce que cette page a de propre.
      const engine = fakeEngine();
      const view = new AnalysisProbe(engine).forCheck('IMAGES');
      const before = view.remaining;

      await view.check('https://cdn.exemple.fr/logo.svg');
      await view.check('https://cdn.exemple.fr/logo.svg');

      expect(view.remaining).toBe(before - 1);
    });

    it('rend les résultats DANS L’ORDRE des URL fournies', async () => {
      // Un rapport qui attribue le statut d'une URL à une autre est pire qu'un
      // rapport absent.
      const engine = fakeEngine();
      engine.resolve = (url: string) =>
        Promise.resolve({
          result: { ...ok(url), status: url.endsWith('lent') ? 404 : 200 },
          billable: true,
        });
      const view = new AnalysisProbe(engine).forCheck('BROKEN_LINKS');

      const results = await view.checkMany([
        'https://exemple.fr/lent',
        'https://exemple.fr/moyen',
        'https://exemple.fr/rapide',
      ]);

      expect(results.map(result => result.status)).toEqual([404, 200, 200]);
    });

    it('rend un tableau vide sans rien demander au moteur', async () => {
      const engine = fakeEngine();

      expect(await new AnalysisProbe(engine).checkMany([])).toEqual([]);
      expect(engine.calls).toHaveLength(0);
    });

    it('BORNE le nombre de demandes simultanées', async () => {
      let inFlight = 0;
      let peak = 0;
      const engine = fakeEngine();
      engine.resolve = async (url: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        return { result: ok(url), billable: true };
      };

      const probe = new AnalysisProbe(engine, { poolSize: 3 });
      await probe.checkMany(Array.from({ length: 12 }, (_, i) => `https://exemple.fr/${i}`));

      expect(peak).toBeLessThanOrEqual(3);
    });
  });

  describe('lecture d’un corps texte', () => {
    it('consomme du quota', async () => {
      const view = new AnalysisProbe(fakeEngine()).forCheck('MENTIONS_LEGALES');
      const before = view.remaining;

      await view.fetchText('https://exemple.fr/mentions');

      expect(view.remaining).toBe(before - 1);
    });

    it('ne consomme rien quand le corps est déjà connu', async () => {
      const view = new AnalysisProbe(fakeEngine()).forCheck('MENTIONS_LEGALES');

      await view.fetchText('https://exemple.fr/mentions');
      const before = view.remaining;
      const { body } = await view.fetchText('https://exemple.fr/mentions');

      expect(view.remaining).toBe(before);
      expect(body).toBe('corps');
    });

    it('rend un corps nul quand le quota est atteint', async () => {
      const view = new AnalysisProbe(fakeEngine(), { budget: 0 }).forCheck('MENTIONS_LEGALES');

      const { result, body } = await view.fetchText('https://exemple.fr/mentions');

      expect(body).toBeNull();
      expect(result.exhausted).toBe(true);
    });
  });
});
