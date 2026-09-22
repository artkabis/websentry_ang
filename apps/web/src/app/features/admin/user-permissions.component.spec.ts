import { provideZonelessChangeDetection } from '@angular/core';
import { render, screen, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { PERMISSIONS, type UserPermission } from '@websentry/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import { UsersApi } from '../../core/users/users.api';
import { UserPermissionsComponent } from './user-permissions.component';

const ID = '22222222-2222-4222-8222-222222222222';

function accordee(over: Partial<UserPermission> = {}): UserPermission {
  return {
    permission: PERMISSIONS.SCAN_RUN,
    gammes: null,
    grantedBy: null,
    grantedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...over,
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
  opts: {
    permissions?: UserPermission[];
    listPermissions?: ReturnType<typeof vi.fn>;
    grantPermission?: ReturnType<typeof vi.fn>;
    revokePermission?: ReturnType<typeof vi.fn>;
    /** Ce que l'ACTEUR détient — borne ce qu'il peut déléguer. */
    detenues?: string[];
  } = {},
) {
  const api = {
    listPermissions: opts.listPermissions ?? vi.fn().mockResolvedValue(opts.permissions ?? []),
    grantPermission: opts.grantPermission ?? vi.fn().mockResolvedValue(undefined),
    revokePermission: opts.revokePermission ?? vi.fn().mockResolvedValue(undefined),
  };
  const detenues = opts.detenues ?? [PERMISSIONS.SCAN_RUN, PERMISSIONS.HISTORY_READ];

  return {
    api,
    providers: [
      provideZonelessChangeDetection(),
      { provide: UsersApi, useValue: api },
      { provide: AuthService, useValue: { hasPermission: (c: string) => detenues.includes(c) } },
    ],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('UserPermissionsComponent', () => {
  describe('quatre états', () => {
    it('annonce le chargement', async () => {
      const listPermissions = vi.fn().mockReturnValue(new Promise(() => undefined));
      const t = setup({ listPermissions });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });

      expect((await screen.findByRole('status')).textContent).toContain('Chargement');
    });

    it('EXPLIQUE un compte sans permission fine', async () => {
      const t = setup();
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      expect(await screen.findByText(/que son rang lui donne/)).toBeTruthy();
    });

    it('liste les permissions accordées', async () => {
      const t = setup({ permissions: [accordee({ gammes: ['sante'] })] });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      // Le code figure aussi dans la liste déroulante d'octroi : on interroge
      // la liste des permissions accordées, pas la page entière.
      const liste = await screen.findByRole('list');
      expect(within(liste).getByText(PERMISSIONS.SCAN_RUN)).toBeTruthy();
      expect(within(liste).getByText('gammes : sante')).toBeTruthy();
    });

    it('signale une portée totale plutôt que de la laisser deviner', async () => {
      const t = setup({ permissions: [accordee()] });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      const liste = await screen.findByRole('list');
      expect(within(liste).getByText('toutes gammes')).toBeTruthy();
    });

    it('rend le chargement RATTRAPABLE en cas d’échec', async () => {
      const listPermissions = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ listPermissions });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      expect(await screen.findByRole('alert')).toBeTruthy();
    });
  });

  describe('délégation', () => {
    it('n’offre QUE ce que l’acteur détient lui-même', async () => {
      // Le service refuse de déléguer ce qu'on n'a pas : proposer le choix
      // pour le rejeter ensuite en 403 ne rendrait service à personne.
      const t = setup({ detenues: [PERMISSIONS.SCAN_RUN] });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      const liste = await screen.findByRole('combobox', { name: /Permission/ });
      const options = within(liste)
        .getAllByRole('option')
        .map(o => o.textContent?.trim());
      expect(options).toEqual(['Choisir…', PERMISSIONS.SCAN_RUN]);
    });

    it('accorde une portée TOTALE quand le champ gammes est vide', async () => {
      // Le schéma refuse un tableau vide, qui serait un octroi n'accordant rien.
      const t = setup();
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      await userEvent.selectOptions(screen.getByRole('combobox', { name: /Permission/ }), [
        PERMISSIONS.SCAN_RUN,
      ]);
      await userEvent.click(screen.getByRole('button', { name: /Accorder/ }));
      await tick();

      expect(t.api.grantPermission).toHaveBeenCalledWith(ID, {
        permission: PERMISSIONS.SCAN_RUN,
        gammes: null,
        expiresAt: null,
      });
    });

    it('découpe les gammes et écarte les vides', async () => {
      const t = setup();
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      await userEvent.selectOptions(screen.getByRole('combobox', { name: /Permission/ }), [
        PERMISSIONS.SCAN_RUN,
      ]);
      await userEvent.type(screen.getByRole('textbox', { name: /Portée/ }), ' sante , , premium ');
      await userEvent.click(screen.getByRole('button', { name: /Accorder/ }));
      await tick();

      expect(t.api.grantPermission).toHaveBeenCalledWith(
        ID,
        expect.objectContaining({ gammes: ['sante', 'premium'] }),
      );
    });

    it('GARDE le bouton inerte tant qu’aucune permission n’est choisie', async () => {
      const t = setup();
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Accorder/ }).disabled).toBe(
        true,
      );
    });

    it('RELIT la liste après un octroi', async () => {
      // Réafficher l'ancienne liste laisserait croire que l'octroi a échoué.
      const t = setup();
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      await userEvent.selectOptions(screen.getByRole('combobox', { name: /Permission/ }), [
        PERMISSIONS.SCAN_RUN,
      ]);
      await userEvent.click(screen.getByRole('button', { name: /Accorder/ }));
      await tick();

      expect(t.api.listPermissions).toHaveBeenCalledTimes(2);
    });

    it('DIT que rien n’a été accordé quand l’octroi échoue', async () => {
      const grantPermission = vi.fn().mockRejectedValue(new Error('403'));
      const t = setup({ grantPermission });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      await userEvent.selectOptions(screen.getByRole('combobox', { name: /Permission/ }), [
        PERMISSIONS.SCAN_RUN,
      ]);
      await userEvent.click(screen.getByRole('button', { name: /Accorder/ }));

      expect(await screen.findByText(/n’a pas été accordée/)).toBeTruthy();
    });
  });

  describe('révocation', () => {
    it('révoque puis relit', async () => {
      const t = setup({ permissions: [accordee()] });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      await userEvent.click(
        await screen.findByRole('button', { name: `Révoquer ${PERMISSIONS.SCAN_RUN}` }),
      );
      await tick();

      expect(t.api.revokePermission).toHaveBeenCalledWith(ID, PERMISSIONS.SCAN_RUN);
      expect(t.api.listPermissions).toHaveBeenCalledTimes(2);
    });

    it('DIT que la permission tient toujours quand la révocation échoue', async () => {
      const revokePermission = vi.fn().mockRejectedValue(new Error('réseau'));
      const t = setup({ permissions: [accordee()], revokePermission });
      await render(UserPermissionsComponent, { providers: t.providers, inputs: { userId: ID } });
      await tick();

      await userEvent.click(
        await screen.findByRole('button', { name: `Révoquer ${PERMISSIONS.SCAN_RUN}` }),
      );

      expect(await screen.findByText(/toujours accordée/)).toBeTruthy();
    });
  });

  describe('lecture seule', () => {
    it('affiche sans offrir d’agir', async () => {
      const t = setup({ permissions: [accordee()] });
      await render(UserPermissionsComponent, {
        providers: t.providers,
        inputs: { userId: ID, modifiable: false },
      });
      await tick();

      const liste = await screen.findByRole('list');
      expect(within(liste).getByText(PERMISSIONS.SCAN_RUN)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Révoquer/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Accorder/ })).toBeNull();
    });
  });
});
