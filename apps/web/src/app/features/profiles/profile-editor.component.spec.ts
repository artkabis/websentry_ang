import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import {
  PROFILE_EXPORT_VERSION,
  RANKS,
  defaultAnalysisSettings,
  type SettingsProfile,
} from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { ProfileConflictError, ProfilesApi } from '../../core/profiles/profiles.api';
import { ProfileEditorComponent } from './profile-editor.component';

function profile(over: Partial<SettingsProfile> = {}): SettingsProfile {
  return {
    profile: 'premium',
    label: 'Premium',
    description: null,
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'alice',
    settings: defaultAnalysisSettings(),
    ...over,
  };
}

const REGISTRY = {
  checks: [
    { id: 'METAS', title: 'Métadonnées', group: 'SEO' as const },
    { id: 'LOGO', title: 'Logo', group: 'Design' as const },
  ],
  subChecks: [],
};

function setup(opts: { rank?: number; api?: Partial<Record<string, unknown>> } = {}) {
  const api = {
    registry: vi.fn().mockResolvedValue(REGISTRY),
    get: vi.fn().mockResolvedValue(profile()),
    save: vi.fn().mockResolvedValue(profile({ version: 4 })),
    reset: vi.fn().mockResolvedValue(profile({ version: 5 })),
    remove: vi.fn().mockResolvedValue(undefined),
    exportProfile: vi.fn().mockResolvedValue({
      formatVersion: PROFILE_EXPORT_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      profile: 'premium',
      label: 'Premium',
      description: null,
      sourceVersion: 3,
      settings: defaultAnalysisSettings(),
    }),
    ...opts.api,
  };
  const rank = opts.rank ?? RANKS.ADMIN;

  return {
    api,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ProfilesApi, useValue: api },
      { provide: AuthService, useValue: { isAdmin: () => rank >= RANKS.ADMIN } },
    ],
  };
}

const mount = (t: ReturnType<typeof setup>) =>
  render(ProfileEditorComponent, { providers: t.providers, inputs: { gamme: 'premium' } });

describe('ProfileEditorComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('chargement', () => {
    it('alimente le formulaire depuis le profil', async () => {
      const t = setup();
      await mount(t);

      const champ = await screen.findByLabelText<HTMLInputElement>('Titre — minimum');
      expect(champ.value).toBe('50');
      expect(screen.getByText(/version 3/)).toBeDefined();
    });

    it('ouvre sur les valeurs par défaut quand la gamme n’existe pas encore', async () => {
      // Enregistrer la créera : afficher une erreur serait trompeur.
      const t = setup({ api: { get: vi.fn().mockRejectedValue(new Error('404')) } });
      await mount(t);

      expect(await screen.findByText(/nouveau profil/)).toBeDefined();
      const champ = await screen.findByLabelText<HTMLInputElement>('Mots — minimum');
      expect(champ.value).toBe('300');
    });

    it('affiche les critères du registre', async () => {
      const t = setup();
      await mount(t);
      expect(await screen.findByLabelText('Métadonnées')).toBeDefined();
      expect(screen.getByLabelText('Logo')).toBeDefined();
    });

    it('signale un échec de chargement du registre', async () => {
      const t = setup({ api: { registry: vi.fn().mockRejectedValue(new Error('réseau')) } });
      await mount(t);
      expect(await screen.findByRole('alert')).toBeDefined();
    });
  });

  describe('droits', () => {
    it('passe en CONSULTATION SEULE pour un non-administrateur', async () => {
      const t = setup({ rank: RANKS.TESTER });
      await mount(t);

      expect(await screen.findByText(/Consultation seule/)).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Supprimer' })).toBeNull();
    });

    it('propose l’édition à un administrateur', async () => {
      const t = setup();
      await mount(t);
      expect(await screen.findByRole('button', { name: 'Enregistrer' })).toBeDefined();
    });

    it('MASQUE la suppression du profil de repli', async () => {
      const t = setup({ api: { get: vi.fn().mockResolvedValue(profile({ profile: 'default' })) } });
      await render(ProfileEditorComponent, {
        providers: t.providers,
        inputs: { gamme: 'default' },
      });

      await screen.findByRole('button', { name: 'Enregistrer' });
      expect(screen.queryByRole('button', { name: 'Supprimer' })).toBeNull();
    });
  });

  describe('enregistrement', () => {
    it('TRANSMET la version lue — c’est le verrouillage optimiste', async () => {
      const user = userEvent.setup();
      const t = setup();
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));

      expect(t.api.save).toHaveBeenCalledWith(
        'premium',
        expect.objectContaining({ expectedVersion: 3 }),
      );
    });

    it('n’envoie pas de version attendue lors d’une création', async () => {
      const user = userEvent.setup();
      const t = setup({ api: { get: vi.fn().mockRejectedValue(new Error('404')) } });
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));

      const payload = (t.api.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      expect(payload).not.toHaveProperty('expectedVersion');
    });

    it('confirme l’enregistrement avec la nouvelle version', async () => {
      const user = userEvent.setup();
      const t = setup();
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));

      // Ciblé sur le message de confirmation : « version 4 » apparaît aussi
      // dans l'en-tête, qui vient d'être rafraîchi.
      const confirmation = await screen.findByRole('status');
      expect(confirmation.textContent).toContain('Profil enregistré');
      expect(confirmation.textContent).toContain('version 4');
    });

    it('conserve les réglages non édités par le formulaire', async () => {
      const user = userEvent.setup();
      const base = {
        ...defaultAnalysisSettings(),
        pageRules: [{ label: 'Produits', patterns: ['/p/*'] }],
      };
      const t = setup({ api: { get: vi.fn().mockResolvedValue(profile({ settings: base })) } });
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));

      const payload = (t.api.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
        settings: { pageRules?: unknown };
      };
      expect(payload.settings.pageRules).toEqual(base.pageRules);
    });
  });

  describe('conflit de version', () => {
    it('PROPOSE un rechargement plutôt que d’écraser le travail d’autrui', async () => {
      const user = userEvent.setup();
      const t = setup({
        api: { save: vi.fn().mockRejectedValue(new ProfileConflictError(9, 3)) },
      });
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));

      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('modifié par quelqu');
      expect(alerte.textContent).toContain('9');
      expect(screen.getByRole('button', { name: 'Recharger le profil' })).toBeDefined();
    });

    it('recharge le profil à la demande', async () => {
      const user = userEvent.setup();
      const t = setup({
        api: { save: vi.fn().mockRejectedValue(new ProfileConflictError(9, 3)) },
      });
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));
      await user.click(await screen.findByRole('button', { name: 'Recharger le profil' }));

      // Le chargement initial plus le rechargement.
      expect((t.api.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('affiche une erreur ordinaire pour un échec non lié à un conflit', async () => {
      const user = userEvent.setup();
      const t = setup({ api: { save: vi.fn().mockRejectedValue(new Error('503')) } });
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Enregistrer' }));
      const alerte = await screen.findByRole('alert');
      expect(alerte.textContent).toContain('Enregistrement impossible');
    });
  });

  describe('contrôles croisés', () => {
    it('BLOQUE l’enregistrement sur un intervalle inversé, sans appeler l’API', async () => {
      const user = userEvent.setup();
      const t = setup();
      await mount(t);

      const min = await screen.findByLabelText('Titre — minimum');
      await user.clear(min);
      await user.type(min, '900');

      expect(await screen.findByText(/Intervalle titre inversé/)).toBeDefined();
      await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
      expect(t.api.save).not.toHaveBeenCalled();
    });
  });

  describe('critères', () => {
    it('bascule un critère et le transmet à l’enregistrement', async () => {
      const user = userEvent.setup();
      const t = setup({
        api: {
          get: vi.fn().mockResolvedValue(
            profile({
              settings: { ...defaultAnalysisSettings(), enabledChecks: ['METAS', 'LOGO'] },
            }),
          ),
        },
      });
      await mount(t);

      await user.click(await screen.findByLabelText('Logo'));
      await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

      const payload = (t.api.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
        settings: { enabledChecks?: string[] };
      };
      expect(payload.settings.enabledChecks).toEqual(['METAS']);
    });
  });

  describe('actions', () => {
    it('réinitialise le profil', async () => {
      const user = userEvent.setup();
      const t = setup();
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Réinitialiser' }));
      expect(t.api.reset).toHaveBeenCalledWith('premium');
      expect(await screen.findByRole('status')).toBeDefined();
    });

    it('DEMANDE CONFIRMATION avant de supprimer', async () => {
      vi.stubGlobal('confirm', () => false);
      const user = userEvent.setup();
      const t = setup();
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Supprimer' }));
      expect(t.api.remove).not.toHaveBeenCalled();
    });

    it('supprime puis revient à la liste une fois confirmé', async () => {
      vi.stubGlobal('confirm', () => true);
      const user = userEvent.setup();
      const t = setup();
      await mount(t);

      const router = TestBed.inject(Router);
      const navigate = vi.fn().mockResolvedValue(true);
      vi.spyOn(router, 'navigate').mockImplementation(navigate);

      await user.click(await screen.findByRole('button', { name: 'Supprimer' }));
      expect(t.api.remove).toHaveBeenCalledWith('premium');
      expect(navigate).toHaveBeenCalledWith(['/profils']);
    });

    it('exporte le profil en fichier téléchargeable', async () => {
      const createObjectURL = vi.fn().mockReturnValue('blob:faux');
      const revokeObjectURL = vi.fn();
      vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

      const user = userEvent.setup();
      const t = setup();
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Exporter' }));

      expect(t.api.exportProfile).toHaveBeenCalledWith('premium');
      // L'URL objet est révoquée aussitôt : la laisser vivre retiendrait le
      // blob en mémoire pour toute la durée de la page.
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:faux');
    });

    it('signale un échec d’export', async () => {
      const user = userEvent.setup();
      const t = setup({ api: { exportProfile: vi.fn().mockRejectedValue(new Error('x')) } });
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Exporter' }));
      expect(await screen.findByRole('alert')).toBeDefined();
    });
  });

  describe('listes longues et pondérations', () => {
    const user = userEvent.setup();

    it('montre les mots et domaines exclus du profil', async () => {
      // Ils étaient CONSERVÉS mais invisibles : l'administrateur ne pouvait
      // ni les lire ni les corriger depuis l'interface.
      const t = setup({
        api: {
          get: vi.fn().mockResolvedValue(
            profile({
              settings: {
                ...defaultAnalysisSettings(),
                hn: { minLength: 50, maxLength: 90, excludedWords: ['le', 'la'] },
                links: { timeout: 10_000, excludedDomains: ['linkedin.com'] },
              },
            }),
          ),
        },
      });
      await mount(t);

      expect(await screen.findByRole('button', { name: 'Retirer le' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Retirer linkedin.com' })).toBeDefined();
    });

    it('ENREGISTRE un mot ajouté', async () => {
      const t = setup();
      await mount(t);

      await user.type(await screen.findByLabelText('Mot à exclure'), 'donc{Enter}');
      await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

      const envoye = t.api.save.mock.calls[0]?.[1] as {
        settings: { hn: { excludedWords: string[] } };
      };
      expect(envoye.settings.hn.excludedWords).toContain('donc');
    });

    it('ENREGISTRE un domaine retiré', async () => {
      const t = setup({
        api: {
          get: vi.fn().mockResolvedValue(
            profile({
              settings: {
                ...defaultAnalysisSettings(),
                links: { timeout: 10_000, excludedDomains: ['linkedin.com', 'x.com'] },
              },
            }),
          ),
        },
      });
      await mount(t);

      await user.click(await screen.findByRole('button', { name: 'Retirer linkedin.com' }));
      await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

      const envoye = t.api.save.mock.calls[0]?.[1] as {
        settings: { links: { excludedDomains: string[] } };
      };
      expect(envoye.settings.links.excludedDomains).toEqual(['x.com']);
    });

    it('propose un palier de pondération par critère', async () => {
      const t = setup();
      await mount(t);

      const select = await screen.findByLabelText<HTMLSelectElement>('Pondération — Métadonnées');
      expect(select.value).toBe('1');
      expect(Array.from(select.options).map(o => o.text)).toContain('Informatif (×0)');
    });

    it('ENREGISTRE la pondération choisie, et elle seule', async () => {
      // Écrire un coefficient 1 pour tous les critères gonflerait le profil
      // d'un dictionnaire qui ne dit rien.
      const t = setup();
      await mount(t);

      await user.selectOptions(await screen.findByLabelText('Pondération — Métadonnées'), '2');
      await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

      const envoye = t.api.save.mock.calls[0]?.[1] as {
        settings: { checkWeights?: Record<string, number> };
      };
      expect(envoye.settings.checkWeights).toEqual({ METAS: 2 });
    });

    it('montre le poids RÉELLEMENT appliqué, pas la seule surcharge écrite', async () => {
      // Un critère listé « informatif » pèse zéro sans figurer dans
      // `checkWeights` : afficher « Normal » mentirait sur le score.
      const t = setup({
        api: {
          get: vi.fn().mockResolvedValue(
            profile({
              settings: { ...defaultAnalysisSettings(), informationalChecks: ['LOGO'] },
            }),
          ),
        },
      });
      await mount(t);

      const select = await screen.findByLabelText<HTMLSelectElement>('Pondération — Logo');
      expect(select.value).toBe('0');
    });

    it('CONSERVE un coefficient hors paliers au lieu de l’arrondir', async () => {
      // Un profil importé peut porter 1,25 : le forcer au palier voisin
      // changerait le score sans que personne ne l'ait demandé.
      const t = setup({
        api: {
          get: vi.fn().mockResolvedValue(
            profile({
              settings: { ...defaultAnalysisSettings(), checkWeights: { METAS: 1.25 } },
            }),
          ),
        },
      });
      await mount(t);

      const select = await screen.findByLabelText<HTMLSelectElement>('Pondération — Métadonnées');
      expect(select.value).toBe('1.25');
      expect(Array.from(select.options).map(o => o.text)).toContain('Sur mesure (×1.25)');
    });

    it('N’ÉDITE PAS les listes sans les droits', async () => {
      const t = setup({ rank: RANKS.TESTER });
      await mount(t);

      const ajouter = await screen.findByRole<HTMLButtonElement>('button', {
        name: 'Ajouter : Mot à exclure',
      });
      expect(ajouter.disabled).toBe(true);
    });
  });
});
