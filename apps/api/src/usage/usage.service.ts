import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  JOURS_PAR_PERIODE,
  type UsageDay,
  type UsageFunnelKey,
  type UsageFunnelStep,
  type UsageGamme,
  type UsageGovernance,
  type UsageOverview,
  type UsagePeriod,
  type UsageSource,
} from '@websentry/shared';
import { AppConfigService } from '../config/app-config.service.js';
import {
  UsageRepository,
  type GammeRow,
  type JourRow,
} from '../database/repositories/usage.repository.js';
import { AuditAnonymizationService } from './audit-anonymization.service.js';

/**
 * Actions du journal qui marquent chaque étape du tunnel.
 *
 * L'étape « analyse » ne vient PAS du journal : lancer une analyse n'y laisse
 * pas de trace, parce que l'historique des scans est déjà cette trace — et
 * mieux renseignée. Écrire deux fois le même événement aurait produit deux
 * comptes qui divergent.
 */
const ACTIONS_CONNEXION = ['auth.login'] as const;

/**
 * Exploiter, c'est agir SUR ce qu'on a trouvé.
 *
 * Ajuster un profil, signaler un retour, nettoyer l'historique : trois façons
 * de dire « j'ai vu quelque chose et j'en fais quelque chose ». Consulter un
 * rapport n'en fait pas partie, et c'est volontaire — la lecture n'est pas
 * journalisée, et l'ajouter au journal pour nourrir un compteur reviendrait à
 * collecter pour mesurer.
 */
const ACTIONS_EXPLOITATION = [
  'profile.updated',
  'profile.created',
  'profile.imported',
  'profile.reset',
  'feedback.create',
  'scans.delete_session',
  'scans.delete_site',
  'scans.delete_pages',
  'scans.delete_domain',
] as const;

/**
 * Analytics d'usage.
 *
 * Le module N'ENREGISTRE RIEN. Il lit le journal d'audit et l'historique des
 * scans, qui existent l'un pour la traçabilité, l'autre pour la preuve, et il
 * en tire des compteurs. Aucune réponse ne nomme une personne : la question
 * « qui a fait quoi » se lit dans le journal d'audit, réservé au rang 100 ;
 * la question « combien de comptes font quoi » se lit ici.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly repo: UsageRepository,
    private readonly anonymisation: AuditAnonymizationService,
    private readonly config: AppConfigService,
  ) {}

  private requireDatabase(): void {
    if (!this.repo.available) {
      throw new ServiceUnavailableException(
        "Les statistiques d'usage exigent une base de données (DB_ENABLED=false).",
      );
    }
  }

  async overview(periode: UsagePeriod, maintenant = new Date()): Promise<UsageOverview> {
    this.requireDatabase();

    const jours = JOURS_PAR_PERIODE[periode];
    const depuis = new Date(maintenant);
    depuis.setUTCDate(depuis.getUTCDate() - jours);
    const depuisSql = sql(depuis);

    const [actifs, connexion, analyse, exploitation, connexionsJour, analysesJour, gammes] =
      await Promise.all([
        this.repo.comptesActifs(depuisSql),
        this.repo.compteurAudit([...ACTIONS_CONNEXION], depuisSql),
        this.repo.compteurAnalyses(depuisSql),
        this.repo.compteurAudit([...ACTIONS_EXPLOITATION], depuisSql),
        this.repo.connexionsParJour(depuisSql),
        this.repo.analysesParJour(depuisSql),
        this.repo.gammes(depuisSql),
      ]);

    const tunnel: UsageFunnelStep[] = [
      etape('connexion', connexion),
      etape('analyse', analyse),
      etape('exploitation', exploitation),
    ];

    return {
      periode,
      depuis: depuis.toISOString(),
      jusqua: maintenant.toISOString(),
      comptesActifs: actifs,
      tunnel,
      parJour: serieQuotidienne(depuis, maintenant, connexionsJour, analysesJour),
      gammes: gammes.map(versGamme),
    };
  }

  /**
   * Registre de traitement, RENDU par le code.
   *
   * Un registre écrit à la main décrit l'intention du jour où il a été écrit.
   * Celui-ci décrit les tables réellement lues, et les compteurs qu'il annonce
   * sont interrogés au moment de la demande.
   */
  async governance(maintenant = new Date()): Promise<UsageGovernance> {
    this.requireDatabase();

    const politique = this.config.anonymisation;
    const avant = sql(this.anonymisation.seuil(maintenant));

    const [anonymisees, enAttente] = await Promise.all([
      this.repo.lignesAnonymisees(),
      this.repo.lignesEnAttente(avant),
    ]);

    return {
      sources: SOURCES(
        politique.afterDays,
        this.config.retention.purgeAfterDays,
        this.config.retention.trashRetentionDays,
      ),
      anonymisation: {
        apresJours: politique.afterDays,
        anonymisees,
        enAttente,
        dernierPassage: this.anonymisation.dernierPassage()?.termineA ?? null,
      },
      // Toujours faux, et c'est le point : la réponse est affichée plutôt
      // qu'affirmée dans une documentation que personne ne relit.
      collecteDediee: false,
    };
  }
}

/** Les tables qui portent de la donnée personnelle, et pourquoi. */
function SOURCES(
  anonymiseApres: number,
  purgeApres: number,
  corbeilleApres: number,
): UsageSource[] {
  return [
    {
      table: 'audit_log',
      finalite: 'Tracer les actions sensibles — qui a créé, modifié ou supprimé quoi',
      donnees: ['identifiant de compte', 'nom au moment de l’action', 'adresse IP'],
      retentionJours: anonymiseApres,
    },
    {
      table: 'scan_sessions',
      finalite: 'Conserver la preuve de l’état d’un site à une date',
      donnees: ['nom du compte ayant lancé le scan'],
      // Les sessions sont purgées par la rétention des rapports ; leur
      // conservation suit donc cette politique-là, et non la nôtre.
      retentionJours: purgeApres,
    },
    {
      table: 'scan_trash',
      finalite: 'Permettre de revenir sur une suppression, et dire qui l’a faite',
      donnees: ['identifiant de compte', 'nom au moment de la suppression'],
      // La corbeille se vide d'elle-même : l'entrée part entière, nom compris,
      // à l'échéance inscrite lors de la suppression.
      retentionJours: corbeilleApres,
    },
    {
      table: 'users',
      finalite: 'Authentifier et autoriser',
      donnees: ['identifiant', 'nom affiché', 'adresse de courriel'],
      // Aucune purge automatique : un compte existe tant qu'il existe. Sa
      // suppression met les clés étrangères du journal à NULL, ce qui
      // anonymise ses traces sans les effacer.
      retentionJours: null,
    },
  ];
}

function etape(
  cle: UsageFunnelKey,
  ligne: { comptes: number; actions: number } | null,
): UsageFunnelStep {
  // `COUNT` rend NULL sur une table vide selon le pilote : la conversion évite
  // qu'un tunnel affiche « null » au premier jour d'une installation.
  return {
    cle,
    comptes: Number(ligne?.comptes ?? 0),
    actions: Number(ligne?.actions ?? 0),
  };
}

/**
 * Série quotidienne CONTINUE, jours vides compris.
 *
 * Une courbe qui saute les jours sans activité ment sur sa pente : deux points
 * espacés d'une semaine y paraissent consécutifs.
 */
function serieQuotidienne(
  depuis: Date,
  jusqua: Date,
  connexions: readonly JourRow[],
  analyses: readonly JourRow[],
): UsageDay[] {
  const parJour = (lignes: readonly JourRow[]): Map<string, number> =>
    new Map(lignes.map(l => [jourIso(l.jour), Number(l.total)]));

  const c = parJour(connexions);
  const a = parJour(analyses);

  const serie: UsageDay[] = [];
  const curseur = new Date(
    Date.UTC(depuis.getUTCFullYear(), depuis.getUTCMonth(), depuis.getUTCDate()),
  );
  const fin = Date.UTC(jusqua.getUTCFullYear(), jusqua.getUTCMonth(), jusqua.getUTCDate());

  while (curseur.getTime() <= fin) {
    const jour = curseur.toISOString().slice(0, 10);
    serie.push({ jour, connexions: c.get(jour) ?? 0, analyses: a.get(jour) ?? 0 });
    curseur.setUTCDate(curseur.getUTCDate() + 1);
  }
  return serie;
}

/**
 * `DATE()` rend une chaîne ou une `Date` selon le pilote et la configuration.
 * Les deux se ramènent au même jour ISO.
 */
function jourIso(brut: unknown): string {
  if (brut instanceof Date) return brut.toISOString().slice(0, 10);
  return String(brut).slice(0, 10);
}

function versGamme(ligne: GammeRow): UsageGamme {
  return {
    gamme: String(ligne.gamme),
    analyses: Number(ligne.analyses),
    // Une gamme dont aucune page n'a été notée rend NULL — ce n'est pas zéro.
    scoreMoyen: ligne.score_moyen === null ? null : Number(ligne.score_moyen),
  };
}

/** Horodatage au format que MariaDB compare sans conversion implicite. */
function sql(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
