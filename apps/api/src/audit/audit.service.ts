import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AuditListResponse, AuditQuery } from '@websentry/shared';
import {
  AuditRepository,
  type AuditEntry,
  type AuditRow,
} from '../database/repositories/audit.repository.js';

/**
 * Journal d'audit applicatif.
 *
 * `record()` n'échoue JAMAIS auprès de l'appelant : une base indisponible ne doit
 * pas transformer une connexion réussie en erreur 500. L'échec est tracé côté logs
 * serveur — mais il est bien tracé, pour ne pas créer un angle mort silencieux
 * dans la journalisation (OWASP #11).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly repo: AuditRepository) {}

  async record(entry: AuditEntry): Promise<void> {
    if (!this.repo.available) return;
    try {
      await this.repo.append(entry);
    } catch (err) {
      this.logger.error(
        `Écriture du journal d'audit impossible (action=${entry.action}) : ${(err as Error).message}`,
      );
    }
  }

  /**
   * Lecture paginée et filtrée.
   *
   * Les bornes sont appliquées ICI EN PLUS du schéma : celui-ci protège du lien
   * mal formé, celles-ci protègent de tout appelant interne qui viendrait sans
   * passer par la validation HTTP.
   */
  async list(requete: AuditQuery): Promise<AuditListResponse> {
    if (!this.repo.available) {
      throw new ServiceUnavailableException(
        'Le journal d’audit exige une base de données (DB_ENABLED=false).',
      );
    }

    const limite = Math.min(Math.max(1, Math.trunc(requete.limit)), 200);
    const decalage = Math.max(0, Math.trunc(requete.offset));
    const filtres = {
      actor: requete.actor,
      action: requete.action,
      targetId: requete.targetId,
      from: requete.from,
      to: requete.to,
    };

    const [lignes, total] = await Promise.all([
      this.repo.list(limite, decalage, filtres),
      this.repo.count(filtres),
    ]);

    return { entries: lignes.map(versVue), total };
  }
}

/** Ligne de base → forme exposée. */
function versVue(ligne: AuditRow): AuditListResponse['entries'][number] {
  return {
    id: ligne.id,
    actorId: ligne.actor_id,
    actorName: ligne.actor_name,
    action: ligne.action,
    targetId: ligne.target_id,
    targetType: ligne.target_type,
    details: lireDetails(ligne.details),
    ipAddress: ligne.ip_address,
    createdAt: new Date(ligne.created_at).toISOString(),
  };
}

/**
 * `details` est une colonne JSON : selon le pilote, un objet déjà décodé ou son
 * texte. Une valeur illisible devient `null` — une trace partiellement lisible
 * vaut mieux qu'une page d'audit qui refuse de s'afficher.
 */
function lireDetails(valeur: unknown): Record<string, unknown> | null {
  let lu = valeur;
  if (typeof lu === 'string') {
    try {
      lu = JSON.parse(lu);
    } catch {
      return null;
    }
  }
  if (lu === null || typeof lu !== 'object' || Array.isArray(lu)) return null;
  return lu as Record<string, unknown>;
}
