import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppConfigService } from '../../config/app-config.service.js';

/**
 * Filtre d'exception global — forme d'erreur unique pour toute l'API.
 *
 * Règle centrale (OWASP #13) : AUCUNE stack trace, AUCUN message de driver SQL,
 * AUCUN chemin de fichier ne franchit la frontière HTTP. Le détail complet part
 * dans les logs serveur, corrélé par `requestId` ; le client, lui, reçoit un
 * message générique et cet identifiant à communiquer au support.
 *
 * Le rendu est identique en développement et en production : une divergence
 * laisserait passer en production une fuite jamais observée en local.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  constructor(private readonly config: AppConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();
    const requestId = req.id ?? 'unknown';

    const { status, error, message, extra } = this.describe(exception);

    // Journalisation complète côté serveur — c'est le SEUL endroit où la trace vit.
    if (status >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      this.logger.error(
        `[${requestId}] ${req.method} ${req.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${requestId}] ${req.method} ${req.url} → ${status} : ${message}`);
    }

    // `Retry-After` doit être un en-tête, sinon les clients HTTP l'ignorent.
    if (typeof extra?.retryAfter === 'number') {
      void reply.header('Retry-After', String(extra.retryAfter));
    }

    void reply.status(status).send({
      statusCode: status,
      error,
      message,
      requestId,
    });
  }

  /** Traduit une exception en triplet (statut, libellé, message) exposable. */
  private describe(exception: unknown): {
    status: number;
    error: string;
    message: string;
    extra?: Record<string, unknown>;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return { status, error: this.labelFor(status), message: response };
      }

      const body = response as Record<string, unknown>;
      const rawMessage = body.message;
      const message = Array.isArray(rawMessage)
        ? rawMessage.map(String).join(', ')
        : typeof rawMessage === 'string'
          ? rawMessage
          : this.labelFor(status);

      return {
        status,
        error: typeof body.error === 'string' ? body.error : this.labelFor(status),
        message,
        extra: body,
      };
    }

    // Erreur de validation Zod remontée hors du pipe : on n'expose que les chemins
    // de champs fautifs, jamais les valeurs reçues (elles peuvent être sensibles).
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: `Données invalides : ${exception.issues.map(i => i.path.join('.')).join(', ')}`,
      };
    }

    // Tout le reste est une panne interne — message rigoureusement générique.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Une erreur interne est survenue',
    };
  }

  private labelFor(status: number): string {
    // Recherche inverse dans l'énumération : rend le NOM du membre (une chaîne),
    // ou `undefined` pour un code inconnu.
    const name: string | undefined = (HttpStatus as unknown as Record<number, string | undefined>)[
      status
    ];
    return name ? name.replace(/_/g, ' ') : 'Error';
  }

  /** Exposé pour les tests : confirme que le filtre ne varie pas selon l'environnement. */
  get isProduction(): boolean {
    return this.config.isProduction;
  }
}
