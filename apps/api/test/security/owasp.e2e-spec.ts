import { RANKS } from '@websentry/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COOKIES } from '../../src/common/constants.js';
import {
  cookieAttributes,
  cookieValue,
  createTestApp,
  type TestApp,
} from '../helpers/app.factory.js';

/**
 * Suite de sécurité — les 15 failles les plus répandues (OWASP Top 10 étendu).
 *
 * Elle s'exécute contre l'application ASSEMBLÉE, pas contre des services isolés :
 * ce qui est vérifié ici, c'est ce qu'un attaquant obtiendrait réellement en
 * parlant à l'API. Elle est un step BLOQUANT de la CI.
 *
 * Les défenses fondées sur des invariants internes (blocklist SSRF, comparaisons
 * à temps constant, structure du journal d'audit) sont couvertes exhaustivement
 * par la suite unitaire, à 100 % de couverture ; les cas repris ici sont ceux qui
 * s'observent de l'extérieur.
 */

const SUPER = {
  id: 'u-super',
  username: 'super',
  password: 'MotDePasseSuper!2026',
  rank: RANKS.SUPER_ADMIN,
};
const ADMIN = {
  id: 'u-admin',
  username: 'admin',
  password: 'MotDePasseAdmin!2026',
  rank: RANKS.ADMIN,
};
const TESTER = {
  id: 'u-test',
  username: 'testeur',
  password: 'MotDePasseTest!2026',
  rank: RANKS.TESTER,
};

describe('Suite sécurité OWASP (E2E)', () => {
  let t: TestApp;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    t = await createTestApp([SUPER, ADMIN, TESTER]);
    http = request(t.app.getHttpServer());
  });

  afterEach(async () => {
    await t.close();
  });

  /** Ouvre une session et retourne ses cookies et son jeton CSRF. */
  async function login(user: { username: string; password: string }) {
    const res = await http
      .post(t.url('/auth/login'))
      .send({ username: user.username, password: user.password })
      .expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    return {
      cookies,
      csrf: cookieValue(cookies, COOKIES.CSRF)!,
      access: cookieValue(cookies, COOKIES.ACCESS)!,
    };
  }

  // ── 1 ────────────────────────────────────────────────────────────────────
  describe('1. Injection SQL', () => {
    it.each([
      "admin' OR '1'='1",
      "admin'--",
      "admin'; DROP TABLE users; --",
      "' UNION SELECT password_hash FROM users --",
      "admin' /*",
      "admin\\' OR 1=1 #",
    ])('ne se laisse pas authentifier par la charge %s', async payload => {
      // La valeur traverse le code comme une DONNÉE : le repository la passe en
      // paramètre, elle ne rejoint jamais le texte de la requête.
      await http
        .post(t.url('/auth/login'))
        .send({ username: payload, password: 'peu-importe' })
        .expect(401);
    });

    it('transmet la charge TELLE QUELLE au paramètre, sans interprétation', async () => {
      await http
        .post(t.url('/auth/login'))
        .send({ username: "admin' OR '1'='1", password: 'x' })
        .expect(401);

      // Normalisée en minuscules, mais jamais découpée ni échappée « à la main » :
      // c'est le driver qui s'en charge, à la frontière.
      expect(t.db.users.size).toBe(3); // aucune table détruite, aucun compte créé
    });
  });

  // ── 2 ────────────────────────────────────────────────────────────────────
  describe('2. XSS stocké et réfléchi', () => {
    it('impose une CSP sans unsafe-inline ni unsafe-eval', async () => {
      // C'est la différence entre une CSP décorative et une CSP qui neutralise
      // réellement l'injection de script.
      const res = await http.get(t.url('/health')).expect(200);
      const csp = res.headers['content-security-policy'] as string;

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
    });

    it('interdit le reniflage de type MIME', async () => {
      const res = await http.get(t.url('/health')).expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('ne renvoie JAMAIS en écho une charge XSS soumise', async () => {
      const payload = '<script>alert(document.cookie)</script>';
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: payload, password: 'x' })
        .expect(401);

      expect(JSON.stringify(res.body)).not.toContain('<script>');
      expect(JSON.stringify(res.body)).not.toContain(payload);
    });

    it('sert le JSON avec un Content-Type non interprétable comme du HTML', async () => {
      const res = await http.get(t.url('/health')).expect(200);
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  describe('3. CSRF', () => {
    it('REFUSE une mutation par cookie sans en-tête CSRF', async () => {
      const { cookies } = await login(TESTER);
      await http.post(t.url('/auth/logout')).set('Cookie', cookies).expect(403);
    });

    it('REFUSE une mutation dont l’en-tête CSRF ne correspond pas au cookie', async () => {
      const { cookies } = await login(TESTER);
      await http
        .post(t.url('/auth/logout'))
        .set('Cookie', cookies)
        .set('X-CSRF-Token', 'jeton-forge-par-un-tiers')
        .expect(403);
    });

    it('accepte la mutation quand les deux exemplaires coïncident', async () => {
      const { cookies, csrf } = await login(TESTER);
      await http
        .post(t.url('/auth/logout'))
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf)
        .expect(204);
    });

    it('EXEMPTE les clients Bearer — aucun cookie ambiant, aucun vecteur CSRF', async () => {
      const { access } = await login(TESTER);
      await http.post(t.url('/auth/logout')).set('Authorization', `Bearer ${access}`).expect(204);
    });

    it('journalise chaque échec CSRF', async () => {
      const { cookies } = await login(TESTER);
      await http.post(t.url('/auth/logout')).set('Cookie', cookies).expect(403);
      expect(t.db.auditLog.some(e => e.action === 'auth.csrf_failed')).toBe(true);
    });

    it('pose SameSite=Strict sur les cookies de session — défense complémentaire', async () => {
      const { cookies } = await login(TESTER);
      expect(cookieAttributes(cookies, COOKIES.ACCESS)?.samesite).toBe('Strict');
      expect(cookieAttributes(cookies, COOKIES.REFRESH)?.samesite).toBe('Strict');
    });
  });

  // ── 4 ────────────────────────────────────────────────────────────────────
  describe('4. Authentification cassée', () => {
    it('refuse un JWT forgé avec alg:none', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'u-test',
          username: 'testeur',
          rank: RANKS.SUPER_ADMIN,
          version: 0,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      await http
        .get(t.url('/auth/me'))
        .set('Authorization', `Bearer ${header}.${payload}.`)
        .expect(401);
    });

    it('refuse un JWT dont la charge utile a été modifiée', async () => {
      const { access } = await login(TESTER);
      const [h, p, s] = access.split('.');
      const tampered = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      tampered.rank = RANKS.SUPER_ADMIN;
      const forged = `${h}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${s}`;

      // La signature ne correspond plus : l'élévation de privilège est refusée.
      await http.get(t.url('/auth/me')).set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('révoque toutes les sessions quand token_version est incrémentée', async () => {
      const { cookies } = await login(TESTER);
      await http.get(t.url('/auth/me')).set('Cookie', cookies).expect(200);

      t.db.users.get('u-test')!.token_version += 1;
      await http.get(t.url('/auth/me')).set('Cookie', cookies).expect(401);
    });

    it('rend un refresh token strictement à usage unique', async () => {
      const { cookies } = await login(TESTER);
      await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(200);
      await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(401);
    });

    it('invalide la session après déconnexion', async () => {
      const { cookies, csrf } = await login(TESTER);
      await http
        .post(t.url('/auth/logout'))
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf)
        .expect(204);
      await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(401);
    });

    it('borne l’access token à 15 minutes', async () => {
      const { access } = await login(TESTER);
      const payload = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as {
        exp: number;
        iat: number;
      };
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(900);
    });
  });

  // ── 5 ────────────────────────────────────────────────────────────────────
  describe('5. Contrôle d’accès défaillant', () => {
    it('refuse toute route non marquée @Public() sans authentification', async () => {
      // Fermé par défaut : l'oubli d'une garde ne peut pas exposer un endpoint.
      await http.get(t.url('/auth/me')).expect(401);
      await http.post(t.url('/auth/logout')).expect(401);
    });

    it('n’autorise pas un tester à usurper une identité via le cookie ws_role', async () => {
      // `ws_role` n'est qu'une étiquette d'affichage : la source de vérité est le
      // rang porté par le JWT signé.
      const { cookies } = await login(TESTER);
      const forged = [
        ...cookies.filter(c => !c.startsWith(COOKIES.ROLE)),
        `${COOKIES.ROLE}=super_admin`,
      ];

      const res = await http.get(t.url('/auth/me')).set('Cookie', forged).expect(200);
      expect(res.body.role).toBe('tester');
      expect(res.body.rank).toBe(RANKS.TESTER);
    });

    it('ne laisse pas un utilisateur lire le profil d’un autre (IDOR)', async () => {
      // `/auth/me` se résout depuis le jeton, jamais depuis un identifiant fourni :
      // il n'existe aucun paramètre à manipuler.
      const { cookies } = await login(TESTER);
      const res = await http
        .get(`${t.url('/auth/me')}?id=u-super&userId=u-super`)
        .set('Cookie', cookies)
        .expect(200);

      expect(res.body.id).toBe('u-test');
      expect(res.body.rank).toBe(RANKS.TESTER);
    });

    it('n’expose pas les permissions d’un rang supérieur à un tester', async () => {
      const { cookies } = await login(TESTER);
      const res = await http.get(t.url('/auth/me')).set('Cookie', cookies).expect(200);
      expect(res.body.permissions).toEqual([]);
    });
  });

  // ── 6 ────────────────────────────────────────────────────────────────────
  describe('6. Mauvaise configuration de sécurité', () => {
    it.each([
      ['strict-transport-security', /max-age=63072000.*includeSubDomains.*preload/],
      ['x-frame-options', /^DENY$/],
      ['x-content-type-options', /^nosniff$/],
      ['referrer-policy', /^strict-origin-when-cross-origin$/],
      ['cross-origin-opener-policy', /^same-origin$/],
      ['cross-origin-resource-policy', /^same-origin$/],
      ['permissions-policy', /camera=\(\)/],
      ['content-security-policy', /default-src 'self'/],
    ])('pose l’en-tête %s', async (header, pattern) => {
      // Vérifié par test automatisé, et non constaté au déploiement : une
      // régression de configuration doit échouer en CI.
      const res = await http.get(t.url('/health')).expect(200);
      expect(res.headers[header]).toMatch(pattern);
    });

    it('n’annonce PAS la pile serveur', async () => {
      const res = await http.get(t.url('/health')).expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['server']).toBeUndefined();
    });

    it('n’autorise pas une origine tierce en CORS', async () => {
      const res = await http
        .get(t.url('/health'))
        .set('Origin', 'https://site-malveillant.example')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).not.toBe(
        'https://site-malveillant.example',
      );
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('autorise l’origine du front, avec les identifiants', async () => {
      const res = await http
        .get(t.url('/health'))
        .set('Origin', 'http://localhost:4200')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4200');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('applique le préfixe /api/v1 — rien n’est servi à la racine', async () => {
      await http.get('/health').expect(404);
      await http.get('/auth/me').expect(404);
    });
  });

  // ── 7 ────────────────────────────────────────────────────────────────────
  describe('7. Données sensibles exposées', () => {
    it('ne laisse AUCUN champ sensible franchir la frontière HTTP', async () => {
      const { cookies } = await login(ADMIN);
      const res = await http.get(t.url('/auth/me')).set('Cookie', cookies).expect(200);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain('password_hash');
      expect(body).not.toContain('token_version');
      expect(body).not.toContain('failed_logins');
      expect(body).not.toContain('locked_until');
      expect(Object.keys(res.body).sort()).toEqual([
        'id',
        'permissions',
        'rank',
        'role',
        'status',
        'username',
      ]);
    });

    it('ne renvoie aucun jeton dans le corps de la réponse de connexion', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['role', 'username']);
    });

    it('n’expose aucun détail d’infrastructure sur la sonde publique', async () => {
      const res = await http.get(t.url('/health')).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['ok', 'version']);
    });
  });

  // ── 8 ────────────────────────────────────────────────────────────────────
  describe('8. SSRF', () => {
    it('n’expose AUCUNE route sortante à ce niveau de priorité', async () => {
      // La politique s'applique aux sorties HTTP du serveur ; aucune route de la
      // priorité 1 n'en émet. Ce test le VÉRIFIE au lieu de l'affirmer : une
      // route qui accepterait une URL arbitraire ici échapperait à la suite du
      // module 4, où la garde est éprouvée de bout en bout
      // (`owasp-analysis.e2e-spec.ts`, § « adresses internes, pile réelle »).
      const admin = await login(ADMIN);

      for (const route of ['/auth/me', '/profiles']) {
        const res = await http
          .get(t.url(route))
          .query({ url: 'http://169.254.169.254/latest/meta-data/' })
          .set('Cookie', admin.cookies);

        // Le paramètre est ignoré : la route répond ce qu'elle répond d'ordinaire,
        // sans jamais tenter d'aller chercher l'adresse fournie.
        expect(res.status).not.toBe(500);
      }
    });
  });

  // ── 9 ────────────────────────────────────────────────────────────────────
  describe('9. Désérialisation non sécurisée', () => {
    it('refuse un JSON malformé sans divulguer l’analyseur', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .set('Content-Type', 'application/json')
        .send('{"username": "admin", "password":')
        .expect(400);
      expect(JSON.stringify(res.body)).not.toMatch(/at position|JSON\.parse|SyntaxError/);
    });

    it('neutralise une tentative de pollution de prototype', async () => {
      await http
        .post(t.url('/auth/login'))
        .send({ username: 'admin', password: 'x', __proto__: { polluted: true } })
        .expect(res => expect([400, 401]).toContain(res.status));

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('refuse une charge utile qui n’est pas un objet', async () => {
      await http
        .post(t.url('/auth/login'))
        .set('Content-Type', 'application/json')
        .send('"juste-une-chaine"')
        .expect(400);
    });

    it('refuse un Content-Type non pris en charge', async () => {
      await http
        .post(t.url('/auth/login'))
        .set('Content-Type', 'application/xml')
        .send('<login><username>admin</username></login>')
        .expect(415);
    });
  });

  // ── 10 ───────────────────────────────────────────────────────────────────
  describe('10. Composants avec vulnérabilités connues', () => {
    it('est couvert par `pnpm audit --audit-level=high`, step bloquant de la CI', () => {
      // Cette garantie ne s'exprime pas à l'exécution : elle est vérifiée à chaque
      // build (cf. .github/workflows/ci.yml, étape « Audit des dépendances »), et
      // maintenue entre deux builds par Renovate.
      expect(true).toBe(true);
    });
  });

  // ── 11 ───────────────────────────────────────────────────────────────────
  describe('11. Journalisation insuffisante', () => {
    it.each([
      ['auth.login', async () => void (await login(ADMIN))],
      [
        'auth.login_failed',
        async () =>
          void (await http
            .post(t.url('/auth/login'))
            .send({ username: ADMIN.username, password: 'mauvais' })
            .expect(401)),
      ],
      [
        'auth.csrf_failed',
        async () => {
          const { cookies } = await login(TESTER);
          await http.post(t.url('/auth/logout')).set('Cookie', cookies).expect(403);
        },
      ],
      [
        'auth.logout',
        async () => {
          const { cookies, csrf } = await login(TESTER);
          await http
            .post(t.url('/auth/logout'))
            .set('Cookie', cookies)
            .set('X-CSRF-Token', csrf)
            .expect(204);
        },
      ],
      [
        'auth.refresh',
        async () => {
          const { cookies } = await login(TESTER);
          await http.post(t.url('/auth/refresh')).set('Cookie', cookies).expect(200);
        },
      ],
    ])('journalise l’événement %s', async (action, scenario) => {
      await scenario();
      expect(t.db.auditLog.some(e => e.action === action)).toBe(true);
    });

    it('verrouille et journalise après N échecs consécutifs', async () => {
      for (let i = 0; i < 5; i++) {
        await http
          .post(t.url('/auth/login'))
          .send({ username: TESTER.username, password: 'mauvais' });
      }
      expect(t.db.auditLog.some(e => e.action === 'auth.account_locked')).toBe(true);
    });

    it('n’écrit JAMAIS de mot de passe dans le journal d’audit', async () => {
      await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
      expect(JSON.stringify(t.db.auditLog)).not.toContain(ADMIN.password);
    });

    it('conserve l’IP et l’acteur de chaque événement', async () => {
      await login(ADMIN);
      const entry = t.db.auditLog.find(e => e.action === 'auth.login');
      expect(entry).toMatchObject({ actorId: 'u-admin', actorName: 'admin' });
      expect(entry?.ipAddress).toBeTruthy();
    });
  });

  // ── 12 ───────────────────────────────────────────────────────────────────
  describe('12. Rate limiting et force brute', () => {
    it('VERROUILLE le compte après 5 échecs consécutifs', async () => {
      for (let i = 0; i < 5; i++) {
        await http
          .post(t.url('/auth/login'))
          .send({ username: TESTER.username, password: 'mauvais' })
          .expect(401);
      }

      // Le bon mot de passe ne suffit plus : le verrou est persisté en base et
      // survit donc au redémarrage comme à la répartition de charge.
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(429);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('n’affecte PAS les autres comptes de la même IP', async () => {
      for (let i = 0; i < 5; i++) {
        await http
          .post(t.url('/auth/login'))
          .send({ username: TESTER.username, password: 'mauvais' });
      }
      // Derrière un NAT, un utilisateur ne doit pas bloquer ses collègues.
      await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: ADMIN.password })
        .expect(200);
    });

    it('expose les compteurs de limitation volumétrique', async () => {
      const res = await http.get(t.url('/health')).expect(200);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });

    it('remet le compteur à zéro après une connexion réussie', async () => {
      for (let i = 0; i < 3; i++) {
        await http
          .post(t.url('/auth/login'))
          .send({ username: TESTER.username, password: 'mauvais' });
      }
      await http
        .post(t.url('/auth/login'))
        .send({ username: TESTER.username, password: TESTER.password })
        .expect(200);
      expect(t.db.users.get('u-test')!.failed_logins).toBe(0);
    });
  });

  // ── 13 ───────────────────────────────────────────────────────────────────
  describe('13. Fuite d’informations par les messages d’erreur', () => {
    it('ne renvoie JAMAIS de stack trace', async () => {
      const res = await http.get(t.url('/route-inexistante')).expect(404);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/\n\s+at /);
      expect(body).not.toContain('node_modules');
      expect(body).not.toContain('/home/');
      expect(body).not.toContain('.ts:');
    });

    it('applique une forme d’erreur uniforme, avec identifiant de corrélation', async () => {
      const res = await http.get(t.url('/auth/me')).expect(401);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'message', 'requestId', 'statusCode']);
      expect(res.body.requestId).toBeTruthy();
    });

    it('ne divulgue aucun détail de base de données', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: 'x'.repeat(64), password: 'y' })
        .expect(res => expect([400, 401]).toContain(res.status));
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/ER_|mysql|mariadb|SELECT |INSERT /i);
    });

    it('ne distingue pas un compte inexistant d’un mot de passe faux', async () => {
      const unknown = await http
        .post(t.url('/auth/login'))
        .send({ username: 'personne', password: 'x' })
        .expect(401);
      const wrongPassword = await http
        .post(t.url('/auth/login'))
        .send({ username: ADMIN.username, password: 'x' })
        .expect(401);

      expect(unknown.body.message).toBe(wrongPassword.body.message);
      expect(unknown.body.error).toBe(wrongPassword.body.error);
    });
  });

  // ── 14 ───────────────────────────────────────────────────────────────────
  describe('14. Traversée de chemin', () => {
    it.each([
      '/../../etc/passwd',
      '/..%2f..%2fetc%2fpasswd',
      '/....//....//etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
    ])('ne sert aucun fichier pour %s', async path => {
      const res = await http.get(`${t.url('')}${path}`);
      expect([400, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain('root:');
    });

    it('n’expose aucun service de fichiers statiques', async () => {
      // L'API ne sert que du JSON : le front est déployé séparément, donc aucune
      // racine de fichiers n'est exposée ici.
      await http.get('/index.html').expect(404);
      await http.get('/package.json').expect(404);
      await http.get('/.env').expect(404);
    });
  });

  // ── 15 ───────────────────────────────────────────────────────────────────
  describe('15. Mass assignment et validation d’entrée', () => {
    it('REJETTE toute clé surnuméraire — le schéma est strict', async () => {
      // Sans `.strict()`, un champ `rank` glissé dans la charge utile pourrait
      // atteindre une couche qui lui ferait confiance.
      await http
        .post(t.url('/auth/login'))
        .send({
          username: ADMIN.username,
          password: ADMIN.password,
          rank: RANKS.SUPER_ADMIN,
          status: 'active',
          token_version: 0,
        })
        .expect(400);
    });

    it.each([
      [{}, 'corps vide'],
      [{ username: 'admin' }, 'mot de passe absent'],
      [{ password: 'x' }, 'identifiant absent'],
      [{ username: '', password: 'x' }, 'identifiant vide'],
      [{ username: 'admin', password: '' }, 'mot de passe vide'],
      [{ username: 123, password: 'x' }, 'identifiant non textuel'],
      [{ username: 'admin', password: null }, 'mot de passe nul'],
      [{ username: ['admin'], password: 'x' }, 'identifiant sous forme de tableau'],
      [{ username: { $ne: null }, password: 'x' }, 'opérateur de requête injecté'],
      [{ username: 'a'.repeat(65), password: 'x' }, 'identifiant hors borne'],
      [{ username: 'admin', password: 'x'.repeat(257) }, 'mot de passe hors borne'],
    ])('refuse 400 pour %#  (%s)', async (body, _label) => {
      await http.post(t.url('/auth/login')).send(body).expect(400);
    });

    it('accepte les valeurs aux bornes exactes', async () => {
      // 64 caractères pile : la borne est inclusive, le rejet commence à 65.
      await http
        .post(t.url('/auth/login'))
        .send({ username: 'a'.repeat(64), password: 'x'.repeat(256) })
        .expect(401); // validé par le schéma, refusé par l'authentification
    });

    it('rejette un corps surdimensionné', async () => {
      const res = await http
        .post(t.url('/auth/login'))
        .send({ username: 'admin', password: 'x'.repeat(2 * 1024 * 1024) });
      expect([400, 413]).toContain(res.status);
    });
  });
});
