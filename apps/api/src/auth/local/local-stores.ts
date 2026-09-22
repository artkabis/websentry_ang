import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service.js';
import { PermissionRepository } from '../../database/repositories/permission.repository.js';
import {
  SessionRepository,
  type SessionRow,
} from '../../database/repositories/session.repository.js';
import { UserRepository, type UserRow } from '../../database/repositories/user.repository.js';
import {
  accountsFilePath,
  readAccounts,
  writeAccounts,
  type LocalAccount,
  type LocalAccountsFile,
} from './local-accounts.js';

/**
 * Dépôts du mode « sans base ».
 *
 * Ils HÉRITENT des dépôts SQL et en redéfinissent chaque méthode publique. Ce
 * choix évite d'introduire des jetons d'injection et de toucher au câblage de
 * l'authentification : le module fournit l'une ou l'autre implémentation sous
 * le même nom, et rien d'autre ne change.
 *
 * Le revers est qu'une méthode oubliée tomberait sur celle du parent, donc sur
 * une base désactivée, et lèverait à l'exécution. Un test le vérifie par
 * réflexion : toute méthode publique du parent doit être redéfinie ici.
 */

/**
 * Exécute un calcul SYNCHRONE en promesse.
 *
 * Les dépôts redéfinis lisent un fichier, donc sans attente ; mais leur
 * contrat annonce une promesse, et un fichier illisible doit REJETER plutôt
 * que lever de façon synchrone — sans quoi un appelant qui enchaîne un
 * `.catch()` verrait l'erreur lui échapper.
 */
function enPromesse<T>(calcul: () => T): Promise<T> {
  // Le calcul est confié à `then` : ce qu'il jette devient un rejet, sans
  // `try`/`catch` — donc sans branche défensive que rien n'emprunterait et
  // sans normalisation de l'erreur d'origine.
  return Promise.resolve().then(calcul);
}

/** Convertit un compte de fichier vers la forme attendue par l'authentification. */
function versUserRow(compte: LocalAccount): UserRow {
  return {
    id: compte.id,
    username: compte.username,
    password_hash: compte.passwordHash,
    display_name: null,
    email: null,
    rank: compte.rank,
    status: compte.status,
    token_version: compte.tokenVersion,
    failed_logins: compte.failedLogins,
    locked_until: compte.lockedUntil,
  } as UserRow;
}

@Injectable()
export class LocalUserStore extends UserRepository {
  constructor(
    db: DatabaseService,
    private readonly chemin: string = accountsFilePath(),
  ) {
    super(db);
  }

  /** Toujours disponible : c'est précisément la raison d'être de ce mode. */
  override get available(): boolean {
    return true;
  }

  override findByUsername(username: string): Promise<UserRow | null> {
    return enPromesse(() => {
      const compte = this.lire().accounts.find(item => item.username === username);
      return compte ? versUserRow(compte) : null;
    });
  }

  override findById(id: string): Promise<UserRow | null> {
    return enPromesse(() => {
      const compte = this.lire().accounts.find(item => item.id === id);
      return compte ? versUserRow(compte) : null;
    });
  }

  override recordFailedLogin(
    userId: string,
    failedLogins: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    // Le verrouillage après N échecs vaut ici aussi : un mode de développement
    // qui relâcherait la défense contre la force brute apprendrait à s'en
    // passer, et la v1 ne le relâchait pas non plus.
    return this.modifier(userId, compte => ({
      ...compte,
      failedLogins,
      lockedUntil: lockedUntil ? lockedUntil.toISOString() : null,
    }));
  }

  override resetFailedLogins(userId: string): Promise<void> {
    return this.modifier(userId, compte => ({ ...compte, failedLogins: 0, lockedUntil: null }));
  }

  override bumpTokenVersion(userId: string): Promise<void> {
    return this.modifier(userId, compte => ({ ...compte, tokenVersion: compte.tokenVersion + 1 }));
  }

  /**
   * Relit le fichier à CHAQUE accès.
   *
   * Une copie en mémoire deviendrait fausse dès qu'on lance la commande de
   * création de compte pendant que le serveur tourne — ce qui est le geste le
   * plus courant. Le fichier compte quelques comptes : le relire ne coûte rien.
   */
  private lire(): LocalAccountsFile {
    return readAccounts(this.chemin);
  }

  private modifier(userId: string, muter: (compte: LocalAccount) => LocalAccount): Promise<void> {
    return enPromesse(() => {
      const fichier = this.lire();
      const accounts = fichier.accounts.map(compte =>
        compte.id === userId ? muter(compte) : compte,
      );
      writeAccounts(this.chemin, { ...fichier, accounts });
    });
  }
}

interface SessionEnMemoire {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revoked: boolean;
}

@Injectable()
export class LocalSessionStore extends SessionRepository {
  private readonly sessions = new Map<string, SessionEnMemoire>();

  constructor(
    db: DatabaseService,
    private readonly users: UserRepository,
  ) {
    super(db);
  }

  override create(
    userId: string,
    expiryMs: number,
    _ip: string | null,
    _userAgent: string | null,
  ): Promise<string> {
    const rawToken = this.generateRawToken();
    const tokenHash = this.hashToken(rawToken);
    this.sessions.set(tokenHash, {
      id: randomUUID(),
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + expiryMs),
      revoked: false,
    });
    return Promise.resolve(rawToken);
  }

  override async findByRawToken(rawToken: string): Promise<SessionRow | null> {
    const session = this.sessions.get(this.hashToken(rawToken));
    if (!session) return null;

    // La jointure du dépôt SQL est refaite ici : le contrôle de révocation
    // repose sur `token_version`, `rank` et `status` du COMPTE, pas de la
    // session. Les omettre rendrait un jeton révoqué à nouveau valable.
    const utilisateur = await this.users.findById(session.userId);
    if (!utilisateur) return null;

    return {
      session_id: session.id,
      user_id: session.userId,
      expires_at: session.expiresAt.toISOString(),
      revoked: session.revoked ? 1 : 0,
      token_version: utilisateur.token_version,
      rank: utilisateur.rank,
      status: utilisateur.status,
    } as SessionRow;
  }

  override rotate(
    oldSessionId: string,
    userId: string,
    expiryMs: number,
    ip: string | null,
    userAgent: string | null,
  ): Promise<string> {
    // Révocation AVANT création, comme la transaction du dépôt SQL : un jeton
    // présenté deux fois doit tomber sur une session révoquée.
    for (const session of this.sessions.values()) {
      if (session.id === oldSessionId) session.revoked = true;
    }
    return this.create(userId, expiryMs, ip, userAgent);
  }

  override revokeAllForUser(userId: string): Promise<number> {
    let revoquees = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revoked) {
        session.revoked = true;
        revoquees += 1;
      }
    }
    return Promise.resolve(revoquees);
  }

  override deleteExpired(): Promise<number> {
    const maintenant = Date.now();
    let supprimees = 0;
    for (const [empreinte, session] of this.sessions) {
      if (session.expiresAt.getTime() < maintenant) {
        this.sessions.delete(empreinte);
        supprimees += 1;
      }
    }
    return Promise.resolve(supprimees);
  }
}

@Injectable()
export class LocalPermissionStore extends PermissionRepository {
  /**
   * Aucune permission fine en mode local.
   *
   * Les permissions par gamme vivent en base, et les inventer ici donnerait des
   * droits que la v1 n'accordait pas davantage. Le RANG continue de décider —
   * c'est ce dont un compte `admin` ou `tester` a besoin pour travailler.
   */
  override findAllForUser(): Promise<never[]> {
    return Promise.resolve([]);
  }

  override findOne(): Promise<null> {
    return Promise.resolve(null);
  }
}
