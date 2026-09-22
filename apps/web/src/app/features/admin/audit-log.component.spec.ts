import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { of } from 'rxjs';
import type { AuditEntryView } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditApi } from '../../core/users/audit.api';
import { AuditLogComponent } from './audit-log.component';

function trace(over: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    id: 1,
    actorId: 'u-1',
    actorName: 'alice',
    action: 'user.create',
    targetId: 'u-2',
    targetType: 'user',
    details: { username: 'bob' },
    ipAddress: '203.0.113.7',
    createdAt: '2026-01-01T10:00:00.000Z',
    ...over,
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    entries?: AuditEntryView[];
    total?: number;
    list?: ReturnType<typeof vi.fn>;
    params?: Record<string, string>;
  } = {},
) {
  const list =
    opts.list ??
    vi.fn().mockResolvedValue({
      entries: opts.entries ?? [trace()],
      total: opts.total ?? opts.entries?.length ?? 1,
    });

  return {
    list,
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AuditApi, useValue: { list } },
      {
        provide: ActivatedRoute,
        useValue: { queryParams: of(opts.params ?? {}), snapshot: { queryParams: {} } },
      },
    ],
  };
}

function espionnerNavigation(): ReturnType<typeof vi.fn> {
  const router = TestBed.inject(Router);
  const navigate = vi.fn().mockResolvedValue(true);
  vi.spyOn(router, 'navigate').mockImplementation(navigate);
  return navigate;
}

afterEach(() => vi.restoreAllMocks());

describe('AuditLogComponent', () => {
  describe('quatre états', () => {
    it('annonce le chargement', async () => {
      const list = vi.fn().mockReturnValue(new Promise(() => undefined));
      await render(AuditLogComponent, { providers: setup({ list }).providers });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement');
    });

    it('affiche les traces une fois chargées', async () => {
      await render(AuditLogComponent, { providers: setup().providers });
      await tick();

      const tableau = await screen.findByRole('table');
      expect(within(tableau).getByText('alice')).toBeTruthy();
      expect(within(tableau).getByText('Compte créé')).toBeTruthy();
    });

    it('GUIDE l’utilisateur quand le journal est vide', async () => {
      await render(AuditLogComponent, { providers: setup({ entries: [], total: 0 }).providers });
      await tick();

      expect(await screen.findByText(/Le journal est vide/)).toBeTruthy();
      expect(screen.getByText(/au fil de l'usage/)).toBeTruthy();
    });

    it('PROPOSE d’effacer les filtres quand ce sont eux qui vident la liste', async () => {
      const t = setup({ entries: [], total: 0, params: { acteur: 'introuvable' } });
      await render(AuditLogComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText(/Aucune trace ne correspond/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Effacer les filtres/ })).toBeTruthy();
    });

    it('OFFRE une reprise en cas d’échec', async () => {
      const list = vi.fn().mockRejectedValue(new Error('réseau'));
      await render(AuditLogComponent, { providers: setup({ list }).providers });
      await tick();

      await userEvent.click(await screen.findByRole('button', { name: /Réessayer/ }));
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  describe('lecture seule', () => {
    it('n’offre NI purge NI correction', async () => {
      // Le journal est append-only côté serveur : offrir un geste que l'API ne
      // porte pas serait mentir sur ce que l'outil garantit.
      await render(AuditLogComponent, { providers: setup().providers });
      await tick();

      expect(screen.queryByRole('button', { name: /Supprimer|Purger|Modifier/ })).toBeNull();
    });

    it('REPLIE le détail plutôt que d’étaler un mur de JSON', async () => {
      await render(AuditLogComponent, { providers: setup().providers });
      await tick();

      const detail = await screen.findByText('Détail');
      expect(detail.closest('details')?.hasAttribute('open')).toBe(false);
    });

    it('affiche le détail à l’ouverture', async () => {
      await render(AuditLogComponent, { providers: setup().providers });
      await tick();

      await userEvent.click(await screen.findByText('Détail'));
      expect(screen.getByText(/"username": "bob"/)).toBeTruthy();
    });

    it('n’affiche PAS de bloc détail quand il n’y en a pas', async () => {
      const t = setup({ entries: [trace({ details: null })] });
      await render(AuditLogComponent, { providers: t.providers });
      await tick();

      expect(screen.queryByText('Détail')).toBeNull();
    });
  });

  describe('lisibilité', () => {
    it('garde le code brut à côté du libellé traduit', async () => {
      // Une action non traduite doit rester identifiable dans une enquête.
      await render(AuditLogComponent, { providers: setup().providers });
      await tick();

      const tableau = await screen.findByRole('table');
      expect(within(tableau).getByText('user.create')).toBeTruthy();
      expect(within(tableau).getByText('Compte créé')).toBeTruthy();
    });

    it('nomme « système » une action sans acteur', async () => {
      const t = setup({ entries: [trace({ actorId: null, actorName: null })] });
      await render(AuditLogComponent, { providers: t.providers });
      await tick();

      expect(await screen.findByText('système')).toBeTruthy();
    });

    it('marque explicitement une cible ou une adresse absente', async () => {
      const t = setup({ entries: [trace({ targetId: null, targetType: null, ipAddress: null })] });
      await render(AuditLogComponent, { providers: t.providers });
      await tick();

      const tableau = await screen.findByRole('table');
      expect(within(tableau).getAllByText('—')).toHaveLength(2);
    });

    it('décrit le tableau pour les lecteurs d’écran', async () => {
      const t = setup({ total: 412 });
      await render(AuditLogComponent, { providers: t.providers });
      await tick();

      expect((await screen.findByRole('table')).querySelector('caption')?.textContent).toContain(
        '412',
      );
    });
  });

  describe('filtres', () => {
    it('lit les filtres de l’URL et les transmet à l’API', async () => {
      const t = setup({
        params: { acteur: 'alice', action: 'user.', du: '2026-01-01', page: '2' },
      });
      await render(AuditLogComponent, { providers: t.providers });
      await tick();

      expect(t.list).toHaveBeenCalledWith({
        limit: 50,
        offset: 50,
        actor: 'alice',
        action: 'user.',
        from: '2026-01-01',
      });
    });

    it('écrit les filtres dans l’URL à la soumission', async () => {
      await render(AuditLogComponent, { providers: setup().providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.type(screen.getByRole('searchbox', { name: /Acteur/ }), 'alice');
      await userEvent.click(screen.getByRole('button', { name: /^Filtrer/ }));

      expect(navigate.mock.calls[0]?.[1]).toMatchObject({ queryParams: { acteur: 'alice' } });
    });

    it('BLOQUE la soumission sur un intervalle inversé, et le dit', async () => {
      await render(AuditLogComponent, { providers: setup().providers });
      await tick();

      const du = screen.getByLabelText(/Depuis le/);
      const au = screen.getByLabelText(/Jusqu'au/);
      await userEvent.type(du, '2026-02-01');
      await userEvent.type(au, '2026-01-01');

      expect(await screen.findByText(/postérieure à la date de fin/)).toBeTruthy();
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Filtrer/ }).disabled).toBe(
        true,
      );
    });
  });

  describe('pagination', () => {
    it('ne s’affiche pas sur une page unique', async () => {
      await render(AuditLogComponent, { providers: setup({ total: 20 }).providers });
      await tick();

      expect(screen.queryByRole('navigation', { name: /Pagination/ })).toBeNull();
    });

    it('navigue de page en page', async () => {
      const t = setup({ total: 120, params: { page: '2' } });
      await render(AuditLogComponent, { providers: t.providers });
      await tick();
      const navigate = espionnerNavigation();

      await userEvent.click(screen.getByRole('button', { name: /Page suivante/ }));
      expect(navigate.mock.calls[0]?.[1]).toMatchObject({ queryParams: { page: '3' } });
    });
  });
});
