import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { NOMBRE_MAX_PIECES_JOINTES, TAILLE_MAX_PIECE_JOINTE } from '@websentry/shared';
import { AppModule } from './app.module.js';
import { API_PREFIX } from './common/constants.js';
import { AppConfigService } from './config/app-config.service.js';

/**
 * Construit l'application Nest sur l'adapter FASTIFY.
 *
 * L'adapter Express n'est pas utilisé : la v1 tourne sur Fastify en production et
 * en tire un débit nettement supérieur — repasser à Express serait une régression
 * de performance sans contrepartie.
 *
 * Factorisé hors de `main.ts` pour que la suite E2E monte exactement la même
 * application, plugins de sécurité compris. Tester une app assemblée autrement
 * reviendrait à ne pas tester ce qui est déployé.
 */
export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Identifiant de corrélation attaché à chaque requête, repris dans les
      // réponses d'erreur et les logs.
      genReqId: () => crypto.randomUUID(),
      trustProxy: true,
      bodyLimit: 1024 * 1024, // 1 Mo — borne les charges utiles JSON.
    }),
    { bufferLogs: true },
  );

  const config = app.get(AppConfigService);

  await registerSecurityPlugins(app, config);

  app.setGlobalPrefix(API_PREFIX);

  // Pas de `ValidationPipe` class-validator ici : la validation est assurée
  // globalement par `StandardSchemaValidationPipe` (cf. AppModule), qui consomme
  // les schémas Zod partagés. Un second pipe imposerait un jeu de règles parallèle
  // — exactement la duplication que l'architecture cherche à éviter.

  app.enableCors({
    origin: config.corsOrigins,
    // Indispensable au mode cookie : sans cela, le navigateur n'envoie pas
    // `ws_access` sur les requêtes cross-origin du front.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    maxAge: 600,
  });

  app.enableShutdownHooks();

  return app;
}

/**
 * En-têtes OWASP, cookies et multipart.
 *
 * EXPORTÉE, et appelée telle quelle par la fabrique de la suite E2E : recopier
 * ces réglages là-bas ferait tester une application qui ressemble à celle qu'on
 * déploie, ce qui n'est pas la même chose que la tester.
 *
 * La CSP interdit `unsafe-inline` et `unsafe-eval` : c'est ce qui fait la
 * différence entre une CSP décorative et une CSP qui neutralise réellement un XSS
 * réfléchi. Les réglages sont vérifiés par un test automatisé (OWASP #6) plutôt
 * que constatés au déploiement.
 */
export async function registerSecurityPlugins(
  app: INestApplication,
  config: AppConfigService,
): Promise<void> {
  const instance = app as NestFastifyApplication;

  await instance.register(fastifyCookie, {
    // Les cookies ne sont pas signés : `ws_access` porte un JWT déjà signé, et
    // `ws_csrf` tire sa valeur du double-submit, pas d'une signature serveur.
    parseOptions: { sameSite: 'strict', path: '/' },
  });

  // Les pièces jointes de la messagerie arrivent en `multipart/form-data`, que
  // `bodyLimit` ne borne pas : les limites sont donc posées ICI, et elles
  // reprennent les constantes du schéma partagé. Deux jeux de bornes — une de
  // transport, une de validation — finiraient par diverger, et la plus large
  // des deux déciderait.
  await instance.register(multipart, {
    limits: {
      fileSize: TAILLE_MAX_PIECE_JOINTE,
      files: NOMBRE_MAX_PIECES_JOINTES,
      // Cinq champs de texte suffisent au formulaire d'envoi ; au-delà, c'est
      // autre chose qui est en train d'être tenté.
      fields: 8,
      fieldSize: 100_000,
    },
  });

  await instance.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", ...config.corsOrigins],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    // HSTS : 2 ans, sous-domaines inclus, éligible au préchargement navigateur.
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // `X-Powered-By` retiré : ne pas annoncer la pile serveur.
    hidePoweredBy: true,
    noSniff: true,
  });

  // Permissions-Policy n'est pas couvert par helmet — posé à la main, en refusant
  // par défaut les API matérielles dont l'application n'a aucun usage.
  instance
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (_req, reply, payload, done) => {
      void reply.header(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
      );
      done(null, payload);
    });

  Logger.log('Plugins de sécurité enregistrés (helmet, cookie, Permissions-Policy)', 'Bootstrap');
}
