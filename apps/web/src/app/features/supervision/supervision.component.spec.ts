import { provideZonelessChangeDetection } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import type { Supervision } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupervisionApi } from '../../core/supervision/supervision.api';
import { SupervisionComponent } from './supervision.component';

function releve(over: Partial<Supervision> = {}): Supervision {
  return {
    etat: 'ok',
    releveA: '2026-01-01T10:00:00.000Z',
    instance: { version: '2.0.0', environnement: 'production', uptimeSec: 90_000 },
    base: { etat: 'ok', message: 'Connectée, 3 ms.', active: true, latenceMs: 3 },
    poolAnalyse: {
      etat: 'ok',
      message: 'Pool démarré — 4 thread(s).',
      active: true,
      demarre: true,
      enEchec: false,
      threadsMax: 4,
    },
    retention: {
      etat: 'ok',
      message: 'Dernier passage réussi, rien en attente.',
      active: true,
      dernierPassage: null,
    },
    volumetrie: { scans24h: 12, scans7j: 1234, comptesActifs: 5, retoursOuverts: 2 },
    ...over,
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(opts: { releve?: Supervision; api?: ReturnType<typeof vi.fn> } = {}) {
  const appel = opts.api ?? vi.fn().mockResolvedValue(opts.releve ?? releve());
  return {
    appel,
    providers: [
      provideZonelessChangeDetection(),
      { provide: SupervisionApi, useValue: { releve: appel } },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('SupervisionComponent', () => {
  describe('quatre états', () => {
    it('annonce le relevé en cours', async () => {
      const api = vi.fn().mockReturnValue(new Promise(() => undefined));
      await render(SupervisionComponent, { providers: setup({ api }).providers });

      expect((await screen.findByRole('status')).textContent).toContain('Relevé en cours');
    });

    it('affiche le verdict une fois relevé', async () => {
      await render(SupervisionComponent, { providers: setup().providers });
      await tick();

      // La carte EXPLIQUE, la région vocale ANNONCE : deux phrases
      // différentes, pour ne pas faire entendre deux fois la même chose.
      expect(await screen.findByText('Tout fonctionne normalement.')).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('État relevé : Opérationnel.');
    });

    it('OFFRE une reprise en cas d’échec', async () => {
      const api = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ api });
      await render(SupervisionComponent, { providers: t.providers });
      await tick();

      await userEvent.click(await screen.findByRole('button', { name: /Réessayer/ }));
      expect(api).toHaveBeenCalledTimes(2);
    });

    it('CONSERVE le relevé précédent quand le rafraîchissement échoue', async () => {
      // Un écran vidé par un échec réseau ferait croire à une panne plus
      // grave que la panne réelle.
      const api = vi
        .fn()
        .mockResolvedValueOnce(releve())
        .mockRejectedValueOnce(new Error('réseau'));
      await render(SupervisionComponent, { providers: setup({ api }).providers });
      await tick();

      await userEvent.click(screen.getByRole('button', { name: /Rafraîchir/ }));
      await tick();

      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(screen.getByText('Connectée, 3 ms.')).toBeTruthy();
    });
  });

  describe('verdict', () => {
    it('DOUBLE la couleur par un libellé, pour chaque composant', async () => {
      // La couleur seule est invisible au lecteur d'écran.
      const degrade = releve({
        etat: 'degrade',
        poolAnalyse: {
          etat: 'degrade',
          message: 'Pool indisponible — analyses exécutées en ligne, donc plus lentes.',
          active: true,
          demarre: false,
          enEchec: true,
          threadsMax: 4,
        },
      });
      await render(SupervisionComponent, { providers: setup({ releve: degrade }).providers });
      await tick();

      expect((await screen.findAllByText('Dégradé')).length).toBeGreaterThanOrEqual(2);
      expect(
        screen.getByText('L’instance fonctionne, mais en repli sur au moins un composant.'),
      ).toBeTruthy();
    });

    it('annonce une PANNE sans la nuancer', async () => {
      const panne = releve({
        etat: 'panne',
        base: {
          etat: 'panne',
          message: 'Injoignable — les lectures et les écritures échouent.',
          active: true,
          latenceMs: null,
        },
        volumetrie: null,
      });
      await render(SupervisionComponent, { providers: setup({ releve: panne }).providers });
      await tick();

      expect(await screen.findByText('Au moins un composant est hors service.')).toBeTruthy();
    });

    it('rappelle version, environnement et durée de service', async () => {
      await render(SupervisionComponent, { providers: setup().providers });
      await tick();

      const entete = (await screen.findByText(/Relevé du/)).textContent ?? '';
      expect(entete).toContain('2.0.0');
      expect(entete).toContain('production');
      // 90 000 s = 1 j 1 h : les minutes disparaissent au-delà d'un jour.
      expect(entete).toContain('1 j 1 h');
    });
  });

  describe('composants', () => {
    it('affiche les trois, avec leur message', async () => {
      await render(SupervisionComponent, { providers: setup().providers });
      await tick();

      for (const titre of ['Base de données', "Pool d'analyse", 'Rétention des rapports']) {
        expect(await screen.findByRole('heading', { name: titre })).toBeTruthy();
      }
      expect(screen.getByText('Pool démarré — 4 thread(s).')).toBeTruthy();
    });

    it('détaille le dernier passage de rétention quand il y en a un', async () => {
      const avecPassage = releve({
        retention: {
          etat: 'degrade',
          message: '4200 ligne(s) encore en attente après le dernier passage.',
          active: true,
          dernierPassage: {
            termineA: '2026-01-01T03:00:00.000Z',
            compresses: 500,
            purges: 100,
            restants: 4200,
            dureeMs: 8200,
            reussi: true,
          },
        },
      });
      await render(SupervisionComponent, { providers: setup({ releve: avecPassage }).providers });
      await tick();

      expect(await screen.findByText('8.2 s')).toBeTruthy();
      const enAttente = screen.getByText('En attente').closest('div')!;
      expect(within(enAttente).getByText(/4\s?200/)).toBeTruthy();
    });

    it('n’affiche AUCUN détail de passage avant le premier', async () => {
      await render(SupervisionComponent, { providers: setup().providers });
      await tick();

      expect(screen.queryByText('Compressés')).toBeNull();
    });
  });

  describe('volumétrie', () => {
    it('affiche les quatre compteurs, milliers séparés', async () => {
      await render(SupervisionComponent, { providers: setup().providers });
      await tick();

      expect(await screen.findByText(/1\s?234/)).toBeTruthy();
      expect(screen.getByText('Comptes actifs')).toBeTruthy();
      expect(screen.getByText('Retours ouverts')).toBeTruthy();
    });

    it('DIT qu’elle est indisponible plutôt que d’afficher des zéros', async () => {
      // Des zéros passeraient pour une instance au repos.
      const sansVolumes = releve({ volumetrie: null });
      await render(SupervisionComponent, { providers: setup({ releve: sansVolumes }).providers });
      await tick();

      expect(await screen.findByText(/Indisponible — la volumétrie se lit en base/)).toBeTruthy();
    });
  });

  describe('lecture seule', () => {
    it('n’offre AUCUNE commande d’exploitation', async () => {
      // L'API n'en expose pas : un bouton qui échouerait serait pire que son
      // absence.
      await render(SupervisionComponent, { providers: setup().providers });
      await tick();

      expect(screen.queryByRole('button', { name: /Redémarrer|Purger|Vider|Forcer/ })).toBeNull();
    });

    it('rafraîchit à la DEMANDE, pas automatiquement', async () => {
      // Un rechargement automatique donnerait l'illusion d'une surveillance
      // continue alors que personne ne regarde l'écran la nuit.
      const t = setup();
      await render(SupervisionComponent, { providers: t.providers });
      await tick();

      expect(t.appel).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole('button', { name: /Rafraîchir/ }));
      expect(t.appel).toHaveBeenCalledTimes(2);
    });
  });
});
