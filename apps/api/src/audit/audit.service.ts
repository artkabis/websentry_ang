import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository, type AuditEntry } from '../database/repositories/audit.repository.js';

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

  /** Lecture paginée — bornée à 200 lignes pour éviter l'extraction massive. */
  async list(limit = 50, offset = 0): Promise<unknown[]> {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const safeOffset = Math.max(0, Math.trunc(offset));
    return this.repo.list(safeLimit, safeOffset);
  }
}
