import { describe, expect, it, vi } from 'vitest';
import type { NetworkProbe, ProbeResult } from '../network-probe.js';
import { asProbe } from '../testing/probe.factory.js';
import { makePage, makeSettings } from '../testing/page.factory.js';
import { MentionsLegalesAnalyzer } from './mentions-legales.analyzer.js';

const analyzer = new MentionsLegalesAnalyzer();
const settings = makeSettings();

/** Sonde simulée : statut du lien légal, et corps de la page légale. */
function probe(over: Partial<ProbeResult> = {}, body = 'Hébergeur : OVH SAS'): NetworkProbe {
  const result: ProbeResult = {
    url: 'https://exemple.fr/mentions-legales',
    status: 200,
    ok: true,
    redirected: false,
    finalUrl: 'https://exemple.fr/mentions-legales',
    contentLength: null,
    contentType: 'text/html',
    ...over,
  };
  return asProbe({
    check: vi.fn().mockResolvedValue(result),
    checkMany: vi.fn().mockResolvedValue([result]),
    fetchText: vi.fn().mockResolvedValue({ result, body: result.ok ? body : null }),
    remaining: 10,
  });
}

const FOOTER = `
  <a href="/mentions-legales">Mentions légales</a>
  <a href="/confidentialite">Politique de confidentialité</a>
  <script src="https://static.axeptio.eu/sdk.js"></script>`;

function page(body: string) {
  return makePage(`<html><body>${body}</body></html>`);
}

describe('MentionsLegalesAnalyzer', () => {
  it('NE DÉCLARE PAS mort un lien légal qu’il n’a pas interrogé', async () => {
    // Accuser un site de mentions légales inaccessibles parce que notre quota
    // était épuisé serait un reproche fabriqué.
    const result = await analyzer.analyze(
      page(FOOTER),
      settings,
      probe({ status: null, ok: false, exhausted: true, error: 'Quota…' }),
    );

    expect(result.items.some(item => item.key === 'ML.legal_inaccessible')).toBe(false);
    expect(result.items.find(item => item.label.includes('quota'))?.status).toBe('info');
  });

  it('valide un site complet', async () => {
    const result = await analyzer.analyze(page(FOOTER), settings, probe());

    expect(result.status).toBe('pass');
    expect(result.globalScore).toBe(5);
  });

  describe('mentions légales', () => {
    it('ÉCHOUE quand le lien est absent', async () => {
      const result = await analyzer.analyze(page('<p>Rien</p>'), settings, probe());

      expect(result.items.some(item => item.key === 'ML.legal_missing')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('ÉCHOUE quand le lien est mort', async () => {
      // Un lien présent mais mort vaut une absence : le visiteur n'atteint pas
      // le document, et l'obligation n'est pas remplie.
      const result = await analyzer.analyze(
        page(FOOTER),
        settings,
        probe({ status: 404, ok: false }),
      );

      expect(result.items.some(item => item.key === 'ML.legal_inaccessible')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('N’ATTRIBUE PAS un lien de confidentialité aux mentions légales', async () => {
      // La v1 testait « legal » en premier : un lien /legal/confidentialite
      // devenait les mentions légales, et la confidentialité était ensuite
      // portée manquante alors qu'elle existait.
      const result = await analyzer.analyze(
        page(
          '<a href="/legal/confidentialite">Confidentialité</a><a href="/legal/mentions-legales">Mentions légales</a>',
        ),
        settings,
        probe(),
      );

      expect(result.items.some(item => item.key === 'ML.privacy_ok')).toBe(true);
      expect(result.items.some(item => item.key === 'ML.legal_ok')).toBe(true);
    });
  });

  it('AVERTIT quand la politique de confidentialité manque', async () => {
    const result = await analyzer.analyze(
      page('<a href="/mentions-legales">Mentions légales</a>'),
      settings,
      probe(),
    );

    expect(result.items.some(item => item.key === 'ML.privacy_missing')).toBe(true);
  });

  it('NE REPROCHE PAS l’absence de CGU', async () => {
    // Sans vente en ligne, elles ne sont pas exigées.
    const result = await analyzer.analyze(page(FOOTER), settings, probe());

    const item = result.items.find(entry => entry.key === 'ML.cgu_missing');
    expect(item?.status).toBe('pass');
  });

  it('reconnaît un lien de CGU', async () => {
    const result = await analyzer.analyze(
      page(`${FOOTER}<a href="/cgv">CGV</a>`),
      settings,
      probe(),
    );

    expect(result.items.some(item => item.key === 'ML.cgu_ok')).toBe(true);
  });

  describe('consentement cookies', () => {
    it('AVERTIT en son absence', async () => {
      const result = await analyzer.analyze(
        page('<a href="/mentions-legales">Mentions légales</a><a href="/rgpd">Confidentialité</a>'),
        settings,
        probe(),
      );

      expect(result.items.some(item => item.key === 'ML.cookie_missing')).toBe(true);
    });

    it('le reconnaît à sa signature', async () => {
      const result = await analyzer.analyze(page(FOOTER), settings, probe());

      expect(result.items.some(item => item.key === 'ML.cookie_ok')).toBe(true);
    });
  });

  describe('ancien widget de l’éditeur', () => {
    it('le SIGNALE dans le pied de page', async () => {
      const result = await analyzer.analyze(
        page(
          `${FOOTER}<div class="dmFooterContainer">Gestion RGPD par Solocal</div><script>window.Parameters={};</script>`,
        ),
        settings,
        probe(),
      );

      expect(result.items.some(item => item.key === 'ML.solocal_detected')).toBe(true);
      expect(result.status).toBe('fail');
    });

    it('constate son absence sur un site de l’éditeur', async () => {
      const result = await analyzer.analyze(
        page(`${FOOTER}<div class="dmFooterContainer">Mentions</div>`),
        settings,
        probe(),
      );

      expect(result.items.some(item => item.key === 'ML.solocal_ok')).toBe(true);
    });

    it('ne dit rien sur un site hors éditeur', async () => {
      const result = await analyzer.analyze(page(FOOTER), settings, probe());

      expect(result.items.some(item => item.key?.startsWith('ML.solocal'))).toBe(false);
    });
  });

  describe('hébergeur', () => {
    it('le cherche dans la PAGE de mentions légales', async () => {
      const net = probe();
      await analyzer.analyze(page(FOOTER), settings, net);

      expect(net.fetchText).toHaveBeenCalledWith(
        'https://exemple.fr/mentions-legales',
        expect.any(Number),
      );
    });

    it('AVERTIT quand il n’y figure pas', async () => {
      const result = await analyzer.analyze(page(FOOTER), settings, probe({}, 'Éditeur : Durand'));

      expect(result.items.some(item => item.key === 'ML.hosting_missing')).toBe(true);
    });

    it('DIT qu’il n’a pas lu la page légale quand la lecture échoue', async () => {
      // La v1 se rabattait en silence sur la page courante : un site dont une
      // page mentionne « OVH » ailleurs était déclaré conforme sans que rien
      // n'ait été vérifié.
      const result = await analyzer.analyze(
        page(`${FOOTER}<p>Hébergé par OVH</p>`),
        settings,
        probe({ status: 500, ok: false }),
      );

      const item = result.items.find(entry => entry.key === 'ML.hosting_ok');
      expect(item?.label).toContain('page analysée');
    });

    it('se contente de la page courante sans sortie réseau', async () => {
      const result = await analyzer.analyze(
        page(`${FOOTER}<p>Hébergeur : Infomaniak</p>`),
        settings,
        undefined,
      );

      expect(result.items.some(item => item.key === 'ML.hosting_ok')).toBe(true);
    });
  });

  it('ne rend rien quand le critère est désactivé', async () => {
    const result = await analyzer.analyze(
      page(FOOTER),
      makeSettings({ disabledChecks: ['MENTIONS_LEGALES'] }),
      probe(),
    );

    expect(result.status).toBe('na');
  });
});
