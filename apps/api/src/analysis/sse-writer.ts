import { Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SseAnalyzeEventSchema, type SseAnalyzeEvent } from '@websentry/shared';
import { SSRF_PUBLIC_MESSAGE, SsrfBlockedError } from '../security/ssrf.service.js';

/**
 * Émission d'événements Server-Sent Events.
 *
 * Un flux SSE prend la main sur la réponse : dès le premier octet écrit, les
 * en-têtes sont partis et le filtre d'exceptions global ne peut plus rien
 * produire. Tout ce qu'il garantit ailleurs — pas de trace d'exécution, forme
 * d'erreur uniforme, code HTTP juste — doit donc être refait ICI, à la main.
 * C'est la raison d'être de cette classe.
 */
export class SseWriter {
  private readonly logger = new Logger(SseWriter.name);
  private closed = false;

  constructor(
    private readonly reply: FastifyReply,
    request: FastifyRequest,
  ) {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    // Demande aux proxys de ne pas tamponner : sans cela, la progression
    // arrive d'un bloc à la fin, ce qui revient à n'avoir pas de progression.
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    reply.raw.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    reply.raw.flushHeaders();

    // Désactive l'algorithme de Nagle : chaque événement part immédiatement au
    // lieu d'attendre de remplir un segment TCP.
    request.raw.socket.setNoDelay(true);

    // Le client parti, plus rien à écrire — et surtout, plus rien à calculer
    // pour lui. Marquer la fermeture évite d'écrire dans un socket mort à
    // chaque critère terminé.
    request.raw.on('close', () => {
      this.closed = true;
    });
  }

  /** Vrai quand le client s'est déconnecté. */
  get disconnected(): boolean {
    return this.closed;
  }

  send(event: SseAnalyzeEvent): void {
    if (this.closed) return;

    // Validation AVANT émission : un événement mal formé serait accepté par le
    // client comme du JSON valide, et casserait son affichage sans rien dire.
    const parsed = SseAnalyzeEventSchema.safeParse(event);
    if (!parsed.success) {
      this.logger.error(`Événement SSE non conforme (${event.type}) — non émis`);
      return;
    }

    try {
      this.reply.raw.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
    } catch {
      this.closed = true;
    }
  }

  /**
   * Émet une erreur assainie.
   *
   * Le message est choisi par TYPE d'erreur, jamais recopié depuis l'exception :
   * un message d'undici cite l'hôte, le port et parfois le code système, autant
   * d'informations sur le réseau interne qu'un flux public n'a pas à porter.
   */
  sendError(err: unknown, analyzeId: string | null = null): void {
    this.send({ type: 'error', analyzeId, message: publicMessageOf(err) });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.reply.raw.end();
    } catch {
      /* socket déjà fermé */
    }
  }
}

/**
 * Message public correspondant à une erreur.
 *
 * Exporté pour être testé seul : c'est la frontière où une fuite d'information
 * passerait inaperçue, le flux SSE échappant au filtre global.
 */
export function publicMessageOf(err: unknown): string {
  if (err instanceof SsrfBlockedError) return SSRF_PUBLIC_MESSAGE;
  if (err instanceof Error && err.name === 'TimeoutError') {
    return 'Le site analysé n’a pas répondu dans le délai imparti.';
  }
  return 'L’analyse a échoué. Vérifiez que l’URL est joignable publiquement.';
}
