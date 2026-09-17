import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
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

/** Type de plugin accepté par `register`, dérivé de la signature de Nest. */
type FastifyPluginArg = Parameters<NestFastifyApplication['register']>[0];

/**
 * En-têtes OWASP et parsing des cookies.
 *
 * La CSP interdit `unsafe-inline` et `unsafe-eval` : c'est ce qui fait la
 * différence entre une CSP décorative et une CSP qui neutralise réellement un XSS
 * réfléchi. Les réglages sont vérifiés par un test automatisé (OWASP #6) plutôt
 * que constatés au déploiement.
 */
async function registerSecurityPlugins(
  app: INestApplication,
  config: AppConfigService,
): Promise<void> {
  const instance = app as NestFastifyApplication;

  // @fastify/cookie et @fastify/helmet augmentent l'interface `FastifyInstance`
  // avec leurs propres décorations ; leur signature de plugin décrit donc une
  // instance DÉJÀ décorée, que l'instance nue ne porte pas encore au moment de
  // l'enregistrement. Le type attendu est dérivé de `register` lui-même, plutôt
  // qu'écrit à la main : il reste exact si la signature de Nest évolue. La
  // conversion ne touche que les types — le comportement à l'exécution est intact.
  await instance.register(fastifyCookie as unknown as FastifyPluginArg, {
    // Les cookies ne sont pas signés : `ws_access` porte un JWT déjà signé, et
    // `ws_csrf` tire sa valeur du double-submit, pas d'une signature serveur.
    parseOptions: { sameSite: 'strict', path: '/' },
  });

  await instance.register(helmet as unknown as FastifyPluginArg, {
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
  instance.getHttpAdapter().getInstance().addHook('onSend', (_req, reply, payload, done) => {
    void reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
    done(null, payload);
  });

  Logger.log('Plugins de sécurité enregistrés (helmet, cookie, Permissions-Policy)', 'Bootstrap');
}
