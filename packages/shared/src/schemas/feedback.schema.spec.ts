import { describe, expect, it } from 'vitest';
import {
  CreateFeedbackSchema,
  FeedbackQuerySchema,
  FeedbackSchema,
  TRANSITIONS_STATUT,
  TriageFeedbackSchema,
  transitionAutorisee,
  type FeedbackStatus,
} from './feedback.schema';

function creation(over: Record<string, unknown> = {}) {
  return {
    kind: 'bug',
    severity: 'majeur',
    title: 'Le score ne se recalcule pas',
    body: 'Après avoir changé la pondération, le score affiché reste celui d’avant.',
    ...over,
  };
}

describe('CreateFeedbackSchema', () => {
  it('accepte un retour minimal', () => {
    expect(CreateFeedbackSchema.parse(creation()).kind).toBe('bug');
  });

  it('REFUSE un titre trop court pour dire quoi que ce soit', () => {
    expect(() => CreateFeedbackSchema.parse(creation({ title: 'bug' }))).toThrow();
  });

  it('REFUSE un corps vide ou quasi vide', () => {
    // Le plancher est modeste — dix caractères — et c'est délibéré : la
    // longueur ne mesure pas l'utilité, et un seuil plus haut rejetterait des
    // retours brefs mais parfaitement exploitables (« Score figé après F5 »).
    // Il ne barre donc que le champ vide ou le caractère isolé.
    expect(() => CreateFeedbackSchema.parse(creation({ body: '' }))).toThrow();
    expect(() => CreateFeedbackSchema.parse(creation({ body: '   ' }))).toThrow();
    expect(() => CreateFeedbackSchema.parse(creation({ body: 'ko' }))).toThrow();
    expect(CreateFeedbackSchema.parse(creation({ body: 'Score figé après F5' })).body).toBe(
      'Score figé après F5',
    );
  });

  it('BORNE le corps — au-delà, ce n’est plus un retour', () => {
    // La borne protège aussi la table d'un collage de rapport d'analyse.
    expect(() => CreateFeedbackSchema.parse(creation({ body: 'x'.repeat(5001) }))).toThrow();
    expect(CreateFeedbackSchema.parse(creation({ body: 'x'.repeat(5000) })).body).toHaveLength(
      5000,
    );
  });

  it('nettoie les espaces de bordure', () => {
    expect(CreateFeedbackSchema.parse(creation({ title: '  Un titre correct  ' })).title).toBe(
      'Un titre correct',
    );
  });

  it('REFUSE une clé surnuméraire — pas d’affectation de masse', () => {
    // Le statut et l'assignation ne se posent PAS au dépôt.
    expect(() => CreateFeedbackSchema.parse(creation({ status: 'resolu' }))).toThrow();
    expect(() => CreateFeedbackSchema.parse(creation({ authorId: 'u-1' }))).toThrow();
  });

  it('REFUSE un type ou une gravité inventés', () => {
    expect(() => CreateFeedbackSchema.parse(creation({ kind: 'doleance' }))).toThrow();
    expect(() => CreateFeedbackSchema.parse(creation({ severity: 'critique' }))).toThrow();
  });

  describe('contexte', () => {
    it('est facultatif, et se remplit de nulls', () => {
      expect(CreateFeedbackSchema.parse(creation({ context: {} })).context).toEqual({
        route: null,
        targetUrl: null,
        gamme: null,
      });
    });

    it('accepte une route et une URL auditée', () => {
      const lu = CreateFeedbackSchema.parse(
        creation({ context: { route: '/analyse', targetUrl: 'https://exemple.fr/' } }),
      );
      expect(lu.context?.route).toBe('/analyse');
    });

    it('REFUSE une URL qui n’en est pas une', () => {
      expect(() =>
        CreateFeedbackSchema.parse(creation({ context: { targetUrl: 'pas-une-url' } })),
      ).toThrow();
    });
  });
});

describe('TriageFeedbackSchema', () => {
  it('n’expose NI le titre NI le corps', () => {
    // Ils appartiennent à l'auteur : les réécrire effacerait ce qu'il a
    // réellement signalé.
    expect(() => TriageFeedbackSchema.parse({ title: 'Réécrit' })).toThrow();
    expect(() => TriageFeedbackSchema.parse({ body: 'Réécrit' })).toThrow();
  });

  it('REFUSE une demande vide', () => {
    expect(() => TriageFeedbackSchema.parse({})).toThrow();
  });

  it('DISTINGUE une désassignation d’une absence', () => {
    expect(TriageFeedbackSchema.parse({ assignedTo: null }).assignedTo).toBeNull();
    expect(TriageFeedbackSchema.parse({ status: 'accepte' })).not.toHaveProperty('assignedTo');
  });

  it('REFUSE un assigné qui n’est pas un identifiant', () => {
    expect(() => TriageFeedbackSchema.parse({ assignedTo: 'alice' })).toThrow();
  });
});

describe('transitions de statut', () => {
  it('ouvre un retour neuf sur l’acceptation ou le rejet', () => {
    expect(transitionAutorisee('nouveau', 'accepte')).toBe(true);
    expect(transitionAutorisee('nouveau', 'rejete')).toBe(true);
  });

  it('REFUSE de sauter directement du dépôt à la résolution', () => {
    // Un retour « résolu » sans être passé par « en cours » n'a jamais été
    // travaillé : le chemin raconte ce qui s'est passé.
    expect(transitionAutorisee('nouveau', 'resolu')).toBe(false);
    expect(transitionAutorisee('accepte', 'resolu')).toBe(false);
  });

  it('laisse ROUVRIR un retour résolu', () => {
    // Un correctif qui ne corrige pas se constate après coup, et forcer un
    // doublon perdrait le fil de la discussion.
    expect(transitionAutorisee('resolu', 'en_cours')).toBe(true);
  });

  it('laisse reprendre un retour rejeté', () => {
    expect(transitionAutorisee('rejete', 'nouveau')).toBe(true);
  });

  it('REFUSE de rester sur place', () => {
    for (const statut of Object.keys(TRANSITIONS_STATUT) as FeedbackStatus[]) {
      expect(transitionAutorisee(statut, statut)).toBe(false);
    }
  });

  it('n’autorise le rejet QUE tant que le retour est ouvert', () => {
    expect(transitionAutorisee('en_cours', 'rejete')).toBe(true);
    expect(transitionAutorisee('resolu', 'rejete')).toBe(false);
  });

  it('couvre tous les statuts, sans destination inconnue', () => {
    // Une table de transitions incomplète laisserait un statut sans issue.
    const statuts = Object.keys(TRANSITIONS_STATUT) as FeedbackStatus[];
    expect(statuts).toHaveLength(5);
    for (const [depuis, vers] of Object.entries(TRANSITIONS_STATUT)) {
      expect(vers.length).toBeGreaterThan(0);
      for (const destination of vers) {
        expect(statuts).toContain(destination);
        expect(destination).not.toBe(depuis);
      }
    }
  });
});

describe('FeedbackQuerySchema', () => {
  it('pose des bornes par défaut', () => {
    expect(FeedbackQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
  });

  it('COERCE les nombres, qui arrivent en texte depuis l’URL', () => {
    expect(FeedbackQuerySchema.parse({ limit: '10', offset: '20' })).toMatchObject({
      limit: 10,
      offset: 20,
    });
  });

  it('lit « mine » depuis une chaîne de requête', () => {
    // Un paramètre d'URL est toujours du texte : « false » y est une chaîne
    // parfaitement vraie, et sans transformation il filtrerait à l'envers.
    expect(FeedbackQuerySchema.parse({ mine: 'true' }).mine).toBe(true);
    expect(FeedbackQuerySchema.parse({ mine: 'false' }).mine).toBe(false);
  });

  it('BORNE la pagination', () => {
    expect(() => FeedbackQuerySchema.parse({ limit: '500' })).toThrow();
    expect(() => FeedbackQuerySchema.parse({ offset: '-1' })).toThrow();
  });

  it('REFUSE un paramètre inconnu', () => {
    expect(() => FeedbackQuerySchema.parse({ tri: 'date' })).toThrow();
  });
});

describe('FeedbackSchema', () => {
  it('REFUSE une clé surnuméraire — la sortie est explicite', () => {
    const complet = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'bug',
      severity: 'majeur',
      status: 'nouveau',
      title: 'Un titre',
      body: 'Un corps suffisamment long.',
      context: { route: null, targetUrl: null, gamme: null },
      authorId: 'u-1',
      authorName: 'alice',
      assignedTo: null,
      assignedName: null,
      resolution: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
    };
    expect(FeedbackSchema.parse(complet).id).toBe(complet.id);
    expect(() => FeedbackSchema.parse({ ...complet, authorEmail: 'a@b.fr' })).toThrow();
  });
});
