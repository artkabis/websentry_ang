import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  transitionAutorisee,
  type CreateFeedbackInput,
  type Feedback,
  type FeedbackCounts,
  type FeedbackListResponse,
  type FeedbackQuery,
  type FeedbackStatus,
  type TriageFeedbackInput,
} from '@websentry/shared';
import { AuditService } from '../audit/audit.service.js';
import {
  FeedbackRepository,
  type FeedbackFilters,
  type FeedbackRow,
} from '../database/repositories/feedback.repository.js';

/** Qui agit, et ce qu'il a le droit de voir. */
export interface FeedbackActor {
  id: string;
  username: string;
  ipAddress: string | null;
  /** Détient `feedback:read` — il voit et trie TOUS les retours. */
  peutTrier: boolean;
}

/** Statuts, dans l'ordre où l'écran de triage les présente. */
const STATUTS: readonly FeedbackStatus[] = ['nouveau', 'accepte', 'en_cours', 'resolu', 'rejete'];

/**
 * Retours des bêta-testeurs.
 *
 * Deux garde-fous portent ce module :
 *
 *  1. **Qui n'a pas `feedback:read` ne voit QUE ses propres retours.** Un
 *     retour cite des URL clientes, des gammes, parfois une capture de ce qui
 *     a mal tourné : ce n'est pas une donnée publique à l'intérieur de l'outil.
 *  2. **Un statut ne saute pas d'étape.** Le chemin parcouru raconte ce qui
 *     s'est passé ; un retour « résolu » qui n'est jamais passé par « en
 *     cours » n'a jamais été travaillé.
 *
 * Déposer un retour est ouvert à TOUT compte authentifié, et c'est délibéré :
 * si signaler coûte une permission à demander, personne ne signale.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly repo: FeedbackRepository,
    private readonly audit: AuditService,
  ) {}

  private requireDatabase(): void {
    if (!this.repo.available) {
      throw new ServiceUnavailableException(
        'Les retours exigent une base de données (DB_ENABLED=false).',
      );
    }
  }

  /**
   * Restreint la lecture à l'auteur quand il n'a pas le droit de tout voir.
   *
   * La restriction est posée ICI, sur le filtre envoyé à SQL, et non après
   * coup sur les lignes lues : filtrer en mémoire ramènerait d'abord les
   * retours des autres, et une pagination calculée dessus serait fausse.
   */
  private filtresVisibles(requete: FeedbackQuery, acteur: FeedbackActor): FeedbackFilters {
    const filtres: FeedbackFilters = {
      status: requete.status,
      kind: requete.kind,
      severity: requete.severity,
      search: requete.search,
    };

    if (!acteur.peutTrier || requete.mine === true) filtres.authorId = acteur.id;
    return filtres;
  }

  async list(requete: FeedbackQuery, acteur: FeedbackActor): Promise<FeedbackListResponse> {
    this.requireDatabase();
    const filtres = this.filtresVisibles(requete, acteur);

    const [lignes, total] = await Promise.all([
      this.repo.list(filtres, requete.limit, requete.offset),
      this.repo.count(filtres),
    ]);

    return { items: lignes.map(versVue), total };
  }

  /** Compteurs par statut — tous présents, zéros compris. */
  async counts(acteur: FeedbackActor): Promise<FeedbackCounts> {
    this.requireDatabase();
    const filtres: FeedbackFilters = acteur.peutTrier ? {} : { authorId: acteur.id };

    const compteurs: FeedbackCounts = {
      nouveau: 0,
      accepte: 0,
      en_cours: 0,
      resolu: 0,
      rejete: 0,
    };
    for (const ligne of await this.repo.countByStatus(filtres)) {
      const statut = String(ligne['status']);
      // Un statut inconnu — écrit par une version future — est IGNORÉ plutôt
      // que d'ajouter une clé que le schéma de sortie refuserait.
      if (estStatut(statut)) compteurs[statut] = Number(ligne['total']);
    }
    return compteurs;
  }

  async get(id: string, acteur: FeedbackActor): Promise<Feedback> {
    this.requireDatabase();
    const ligne = await this.requireFeedback(id);

    // Le même 404 qu'un retour inexistant : répondre 403 confirmerait qu'un
    // retour existe sous cet identifiant, ce qui est déjà une information.
    if (!acteur.peutTrier && ligne.author_id !== acteur.id) {
      throw new NotFoundException('Retour introuvable.');
    }
    return versVue(ligne);
  }

  async create(entree: CreateFeedbackInput, acteur: FeedbackActor): Promise<Feedback> {
    this.requireDatabase();

    const id = randomUUID();
    await this.repo.create({
      id,
      kind: entree.kind,
      severity: entree.severity,
      title: entree.title,
      body: entree.body,
      context: entree.context ?? null,
      authorId: acteur.id,
      // Le nom est figé AU DÉPÔT : il survit à la suppression du compte, alors
      // que la clé étrangère passera à NULL.
      authorName: acteur.username,
    });

    await this.trace(acteur, 'feedback.create', id, {
      kind: entree.kind,
      severity: entree.severity,
    });
    return versVue(await this.requireFeedback(id));
  }

  async triage(id: string, entree: TriageFeedbackInput, acteur: FeedbackActor): Promise<Feedback> {
    this.requireDatabase();
    if (!acteur.peutTrier) {
      throw new ForbiddenException('Le triage des retours demande la permission feedback:read.');
    }

    const ligne = await this.requireFeedback(id);

    if (entree.status !== undefined) {
      const depuis = ligne.status;
      if (!estStatut(depuis)) {
        throw new BadRequestException(
          'Ce retour porte un statut que cette version ne connaît pas.',
        );
      }
      if (!transitionAutorisee(depuis, entree.status)) {
        throw new BadRequestException(
          `Passage impossible de « ${depuis} » à « ${entree.status} ».`,
        );
      }
    }

    await this.repo.triage(id, {
      status: entree.status,
      severity: entree.severity,
      assigned_to: entree.assignedTo,
      resolution: entree.resolution,
    });

    await this.trace(acteur, 'feedback.triage', id, { ...entree });
    return versVue(await this.requireFeedback(id));
  }

  private async requireFeedback(id: string): Promise<FeedbackRow> {
    const ligne = await this.repo.findById(id);
    if (!ligne) throw new NotFoundException('Retour introuvable.');
    return ligne;
  }

  private trace(
    acteur: FeedbackActor,
    action: string,
    targetId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      actorId: acteur.id,
      actorName: acteur.username,
      action,
      targetId,
      targetType: 'feedback',
      details,
      ipAddress: acteur.ipAddress,
    });
  }
}

function estStatut(valeur: string): valeur is FeedbackStatus {
  return (STATUTS as readonly string[]).includes(valeur);
}

/** Ligne de base → forme exposée. */
function versVue(ligne: FeedbackRow): Feedback {
  return {
    id: ligne.id,
    kind: ligne.kind as Feedback['kind'],
    severity: ligne.severity as Feedback['severity'],
    status: ligne.status as FeedbackStatus,
    title: ligne.title,
    body: ligne.body,
    context: lireContexte(ligne.context),
    authorId: ligne.author_id,
    authorName: ligne.author_name,
    assignedTo: ligne.assigned_to,
    assignedName: ligne.assigned_name,
    resolution: ligne.resolution,
    createdAt: new Date(ligne.created_at).toISOString(),
    updatedAt: new Date(ligne.updated_at).toISOString(),
    resolvedAt: ligne.resolved_at === null ? null : new Date(ligne.resolved_at).toISOString(),
  };
}

/**
 * `context` est une colonne JSON : selon le pilote, un objet déjà décodé ou son
 * texte. Un contenu illisible retombe sur un contexte VIDE plutôt que de faire
 * échouer la lecture — un retour sans contexte reste un retour.
 */
function lireContexte(valeur: unknown): Feedback['context'] {
  let lu = valeur;
  if (typeof lu === 'string') {
    try {
      lu = JSON.parse(lu);
    } catch {
      return { route: null, targetUrl: null, gamme: null };
    }
  }

  // Aucun garde sur la FORME de `lu` : un nombre, un tableau ou `null` n'ont
  // aucun des trois champs, et la vérification faite juste en dessous rend
  // déjà `null` pour chacun. Un garde séparé serait une branche que rien ne
  // peut distinguer — donc une branche morte, et un test creux pour la couvrir.
  const objet = (lu ?? {}) as Record<string, unknown>;
  const texte = (cle: string): string | null =>
    typeof objet[cle] === 'string' ? objet[cle] : null;

  return { route: texte('route'), targetUrl: texte('targetUrl'), gamme: texte('gamme') };
}
