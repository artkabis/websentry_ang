import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyserPage,
  DocPageSchema,
  DocSlugSchema,
  texteBrut,
  type DocIndex,
  type DocPage,
  type DocSearchHit,
  type DocSearchResponse,
  type DocSection,
  type DocSummary,
} from '@websentry/shared';

/** Dossier des pages — voisin de ce fichier, jamais configurable. */
const DOSSIER = join(import.meta.dirname, 'contenu');

/** Longueur de l'extrait rendu autour d'un terme trouvé. */
const FENETRE_EXTRAIT = 160;

/** Ordre des sections dans le sommaire — le reste suit, par ordre alphabétique. */
const ORDRE_SECTIONS = ['Prise en main', 'Au quotidien', 'Gouvernance'];

/** Page chargée, avec son texte indexé une fois pour toutes. */
interface PageIndexee {
  page: DocPage;
  /** Minuscules, accents retirés — ce que la recherche compare. */
  index: string;
  /** Texte d'origine, pour découper un extrait lisible. */
  brut: string;
}

/**
 * Portail de documentation.
 *
 * Les pages vivent DANS LE DÉPÔT, en Markdown, et sont lues UNE SEULE FOIS au
 * démarrage. Une requête n'atteint jamais le système de fichiers : elle
 * interroge une table en mémoire, indexée par identifiant. Il n'y a donc aucun
 * chemin à valider, aucune traversée possible — la question ne se pose pas.
 *
 * Ce choix a d'autres conséquences utiles : la documentation est relue comme du
 * code, elle suit la version de l'application qui la sert, et aucune route
 * d'écriture n'existe. Une documentation éditable en ligne aurait demandé une
 * table, un éditeur, une désinfection du contenu et un contrôle d'accès de
 * plus.
 */
@Injectable()
export class DocsService implements OnModuleInit {
  private readonly logger = new Logger(DocsService.name);
  private readonly pages = new Map<string, PageIndexee>();

  onModuleInit(): void {
    this.charger();
  }

  /**
   * Charge et indexe les pages.
   *
   * Une page illisible ou non conforme est SIGNALÉE et ignorée : elle ne doit
   * pas empêcher le portail de servir les autres. Un démarrage qui échoue
   * parce qu'un paragraphe est mal tapé serait disproportionné.
   */
  private charger(): void {
    this.pages.clear();

    let fichiers: string[];
    try {
      fichiers = readdirSync(DOSSIER).filter(nom => nom.endsWith('.md'));
    } catch (err) {
      // Pas de dossier : le portail est vide, l'API reste debout.
      this.logger.error(`Documentation illisible (${DOSSIER}) : ${(err as Error).message}`);
      return;
    }

    for (const fichier of fichiers) {
      const slug = fichier.slice(0, -3);
      // L'identifiant vient du NOM DE FICHIER : il est validé comme le serait
      // une entrée, parce qu'il devient une clé d'API.
      if (!DocSlugSchema.safeParse(slug).success) {
        this.logger.warn(`Page ignorée — identifiant invalide : ${fichier}`);
        continue;
      }

      try {
        const source = readFileSync(join(DOSSIER, fichier), 'utf8');
        const page = DocPageSchema.parse(analyserPage(slug, source));
        const brut = `${page.titre}\n${texteBrut(page.blocs)}`;
        this.pages.set(slug, { page, index: normaliser(brut), brut });
      } catch (err) {
        this.logger.warn(`Page ignorée — ${fichier} : ${(err as Error).message}`);
      }
    }

    this.logger.log(`Documentation chargée — ${this.pages.size} page(s)`);
  }

  /** Sommaire groupé par section, chaque section dans son ordre. */
  index(): DocIndex {
    const parSection = new Map<string, DocSummary[]>();

    for (const { page } of this.pages.values()) {
      const liste = parSection.get(page.section) ?? [];
      liste.push(resumer(page));
      parSection.set(page.section, liste);
    }

    const sections: DocSection[] = [...parSection]
      .map(([section, pages]) => ({
        section,
        // À ordre égal, le titre départage : sans cela, l'ordre dépendrait de
        // celui du système de fichiers, qui varie d'une machine à l'autre.
        pages: pages.sort((a, b) => a.ordre - b.ordre || a.titre.localeCompare(b.titre)),
      }))
      .sort(
        (a, b) =>
          rangSection(a.section) - rangSection(b.section) || a.section.localeCompare(b.section),
      );

    return { sections };
  }

  /** Une page par son identifiant — 404 si elle n'existe pas. */
  page(slug: string): DocPage {
    const trouvee = this.pages.get(slug);
    if (!trouvee) throw new NotFoundException('Page de documentation introuvable.');
    return trouvee.page;
  }

  /**
   * Recherche plein texte, en mémoire.
   *
   * Le score privilégie le TITRE : quelqu'un qui tape « profils » cherche la
   * page qui s'appelle ainsi, pas les douze pages qui la mentionnent.
   */
  rechercher(q: string, limite: number): DocSearchResponse {
    const terme = normaliser(q);
    const resultats: DocSearchHit[] = [];

    for (const { page, index, brut } of this.pages.values()) {
      const dansTitre = normaliser(page.titre).includes(terme);
      const occurrences = compter(index, terme);
      if (occurrences === 0) continue;

      resultats.push({
        ...resumer(page),
        extrait: extraire(brut, terme),
        // Le titre vaut dix occurrences dans le corps : c'est ce qui fait
        // remonter la page cherchée avant celles qui la citent.
        score: occurrences + (dansTitre ? 10 : 0),
      });
    }

    resultats.sort((a, b) => b.score - a.score || a.titre.localeCompare(b.titre));
    return { q, resultats: resultats.slice(0, limite), total: resultats.length };
  }
}

function resumer(page: DocPage): DocSummary {
  return {
    slug: page.slug,
    titre: page.titre,
    section: page.section,
    ordre: page.ordre,
    resume: page.resume,
  };
}

function rangSection(section: string): number {
  const rang = ORDRE_SECTIONS.indexOf(section);
  // Une section inconnue passe APRÈS celles qu'on a ordonnées, plutôt que de
  // prendre la tête par accident.
  return rang === -1 ? ORDRE_SECTIONS.length : rang;
}

/**
 * Minuscules, accents retirés.
 *
 * Chercher « donnees » doit trouver « données » : exiger l'accent ferait
 * échouer la moitié des recherches faites au clavier, sans rien protéger.
 */
function normaliser(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function compter(index: string, terme: string): number {
  if (terme === '') return 0;
  let total = 0;
  let position = index.indexOf(terme);
  while (position !== -1) {
    total += 1;
    position = index.indexOf(terme, position + terme.length);
  }
  return total;
}

/**
 * Extrait autour de la première occurrence, coupé sur des mots.
 *
 * L'extrait est du TEXTE BRUT : aucune balise de surbrillance. L'interface
 * sait où se trouve le terme, puisqu'elle l'a demandé, et renvoyer du balisage
 * rouvrirait la porte que la structure ferme.
 */
function extraire(brut: string, terme: string): string {
  const aplati = brut.replace(/\s+/g, ' ').trim();
  const position = normaliser(aplati).indexOf(terme);
  if (position === -1) return aplati.slice(0, FENETRE_EXTRAIT);

  const debut = Math.max(0, position - Math.floor(FENETRE_EXTRAIT / 3));
  const fin = Math.min(aplati.length, debut + FENETRE_EXTRAIT);
  const morceau = aplati.slice(debut, fin);

  return `${debut > 0 ? '…' : ''}${morceau}${fin < aplati.length ? '…' : ''}`;
}
