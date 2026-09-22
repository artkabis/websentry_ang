import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS, RANKS } from '@websentry/shared';
import { describe, expect, it, vi } from 'vitest';
import { MIN_RANK_KEY } from '../common/decorators/roles.decorator.js';
import { PERMISSIONS_KEY } from '../common/decorators/permissions.decorator.js';
import type { AuthenticatedRequest, AuthUser } from '../common/types.js';
import type { RbacService } from '../rbac/rbac.service.js';
import { FeedbackController } from './feedback.controller.js';
import type { FeedbackService } from './feedback.service.js';

const USER: AuthUser = { sub: 'u1', username: 'alice', rank: RANKS.TESTER, version: 0 };
const ID = '11111111-1111-4111-8111-111111111111';

function req(over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return { ip: '203.0.113.10', headers: {}, cookies: {}, ...over } as AuthenticatedRequest;
}

function build(detientFeedbackRead = false) {
  const feedback = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    counts: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({ id: ID }),
    create: vi.fn().mockResolvedValue({ id: ID }),
    triage: vi.fn().mockResolvedValue({ id: ID }),
  };
  const rbac = {
    resolve: vi.fn().mockResolvedValue(detientFeedbackRead ? { gammes: null } : null),
  };

  return {
    feedback,
    rbac,
    controller: new FeedbackController(
      feedback as unknown as FeedbackService,
      rbac as unknown as RbacService,
    ),
  };
}

describe('FeedbackController', () => {
  const reflector = new Reflector();

  describe('gardes de route', () => {
    const routes = ['list', 'counts', 'get', 'create', 'triage'] as const;

    it('n’exige AUCUNE permission fine, volontairement', () => {
      // Déposer un retour doit rester ouvert à tout compte authentifié : si
      // signaler coûte une permission à demander, personne ne signale. Et une
      // garde sur la liste fermerait l'écran « mes retours » à ceux-là mêmes
      // qu'on veut faire remonter des retours.
      for (const route of routes) {
        expect(reflector.get(PERMISSIONS_KEY, FeedbackController.prototype[route])).toBeUndefined();
      }
    });

    it('n’exige AUCUN rang minimal', () => {
      for (const route of routes) {
        expect(reflector.get(MIN_RANK_KEY, FeedbackController.prototype[route])).toBeUndefined();
      }
    });

    it('n’expose aucune route en dehors de celles-ci', () => {
      // Une méthode ajoutée plus tard sans garde ferait tomber ce test, et
      // c'est le but : l'absence de garde est un choix, pas un oubli.
      const declarees = Object.getOwnPropertyNames(FeedbackController.prototype).filter(nom => {
        if (nom === 'constructor') return false;
        const membre = (FeedbackController.prototype as unknown as Record<string, unknown>)[nom];
        return typeof membre === 'function' && reflector.get(PATH_METADATA, membre) !== undefined;
      });

      expect(declarees.sort()).toEqual([...routes].sort());
    });

    it('n’offre NI suppression NI réécriture d’un retour', () => {
      // Le corps appartient à son auteur ; l'effacer perdrait ce qu'il a
      // réellement signalé.
      const noms = Object.getOwnPropertyNames(FeedbackController.prototype);
      expect(noms).not.toContain('remove');
      expect(noms).not.toContain('update');
    });
  });

  describe('construction de l’acteur', () => {
    it('RÉSOUT feedback:read par le RBAC, pas par le rang', async () => {
      // Le rang seul ne suffit pas : la permission peut être accordée
      // explicitement à un compte de rang inférieur.
      const t = build(true);
      await t.controller.list({ limit: 25, offset: 0 }, USER, req());

      expect(t.rbac.resolve).toHaveBeenCalledWith('u1', RANKS.TESTER, PERMISSIONS.FEEDBACK_READ);
      expect(t.feedback.list).toHaveBeenCalledWith(
        { limit: 25, offset: 0 },
        expect.objectContaining({ peutTrier: true }),
      );
    });

    it('marque l’acteur SANS droit de triage quand le RBAC refuse', async () => {
      const t = build(false);
      await t.controller.list({ limit: 25, offset: 0 }, USER, req());

      expect(t.feedback.list).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ peutTrier: false }),
      );
    });

    it('transmet l’IP, et accepte son absence', async () => {
      const t = build();
      await t.controller.create(
        { kind: 'bug', severity: 'majeur', title: 'Un titre', body: 'Un corps assez long.' },
        USER,
        req({ ip: undefined }),
      );

      expect(t.feedback.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: 'u1', username: 'alice', ipAddress: null }),
      );
    });
  });

  describe('délégation', () => {
    it('transmet la requête de liste telle quelle', async () => {
      const t = build();
      await t.controller.list({ limit: 10, offset: 5, status: 'nouveau' }, USER, req());

      expect(t.feedback.list).toHaveBeenCalledWith(
        { limit: 10, offset: 5, status: 'nouveau' },
        expect.anything(),
      );
    });

    it('transmet la lecture unitaire et les compteurs', async () => {
      const t = build();
      await t.controller.get(ID, USER, req());
      await t.controller.counts(USER, req());

      expect(t.feedback.get).toHaveBeenCalledWith(ID, expect.anything());
      expect(t.feedback.counts).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));
    });

    it('transmet le triage', async () => {
      const t = build(true);
      await t.controller.triage(ID, { status: 'accepte' }, USER, req());

      expect(t.feedback.triage).toHaveBeenCalledWith(
        ID,
        { status: 'accepte' },
        expect.objectContaining({ peutTrier: true }),
      );
    });
  });
});
