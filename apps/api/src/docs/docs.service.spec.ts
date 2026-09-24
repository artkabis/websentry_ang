import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocIndexSchema, DocPageSchema, DocSearchResponseSchema } from '@websentry/shared';
import { DocsService } from './docs.service.js';

/** Le service lit le dossier RÉEL du projet : ce sont les pages livrées. */
function build(): DocsService {
  const service = new DocsService();
  service.onModuleInit();
  return service;
}

describe('DocsService', () => {
  let service: DocsService;

  beforeEach(() => {
    service = build();
  });

  describe('chargement', () => {
    it('charge les pages du dépôt', () => {
      expect(service.index().sections.length).toBeGreaterThan(0);
    });

    it('produit un sommaire CONFORME au schéma partagé', () => {
      expect(() => DocIndexSchema.parse(service.index())).not.toThrow();
    });

    it('produit des pages CONFORMES au schéma partagé', () => {
      // Une page livrée qui ne passerait pas le schéma serait servie telle
      // quelle : la vérifier ici, c'est vérifier le contenu réel.
      for (const section of service.index().sections) {
        for (const resume of section.pages) {
          expect(() => DocPageSchema.parse(service.page(resume.slug))).not.toThrow();
        }
      }
    });

    it('donne un RÉSUMÉ à chaque page', () => {
      // Le sommaire doit situer une page sans l'ouvrir.
      for (const section of service.index().sections) {
        for (const resume of section.pages) {
          expect(resume.resume.length).toBeGreaterThan(10);
        }
      }
    });
  });

  describe('sommaire', () => {
    it('ORDONNE les sections, la prise en main d’abord', () => {
      const sections = service.index().sections.map(s => s.section);
      expect(sections[0]).toBe('Prise en main');
    });

    it('ordonne les pages d’une section par leur ordre déclaré', () => {
      const prise = service.index().sections.find(s => s.section === 'Prise en main');
      const ordres = prise?.pages.map(p => p.ordre) ?? [];

      expect(ordres).toEqual([...ordres].sort((a, b) => a - b));
    });

    it('ne dépend PAS de l’ordre du système de fichiers', () => {
      // Sans départage explicite, deux machines rendraient deux sommaires.
      const premier = JSON.stringify(build().index());
      const second = JSON.stringify(build().index());

      expect(premier).toBe(second);
    });
  });

  describe('lecture d’une page', () => {
    it('rend la page demandée', () => {
      expect(service.page('premiers-pas').titre).toBe('Premiers pas');
    });

    it('rend 404 sur une page inconnue', () => {
      expect(() => service.page('inexistante')).toThrow(NotFoundException);
    });

    it('rend 404 — jamais un fichier — sur une tentative de traversée', () => {
      // Une requête n'atteint JAMAIS le système de fichiers : la table est en
      // mémoire, et il n'y a donc aucun chemin à assembler.
      for (const slug of ['../package', '../../etc/passwd', 'premiers-pas.md']) {
        expect(() => service.page(slug)).toThrow(NotFoundException);
      }
    });
  });

  describe('recherche', () => {
    it('trouve un terme du CORPS', () => {
      const resultat = service.rechercher('pondération', 20);
      expect(resultat.total).toBeGreaterThan(0);
    });

    it('IGNORE les accents et la casse', () => {
      // Exiger l'accent ferait échouer la moitié des recherches au clavier.
      const avec = service.rechercher('données', 20);
      const sans = service.rechercher('DONNEES', 20);

      expect(sans.total).toBe(avec.total);
      expect(sans.total).toBeGreaterThan(0);
    });

    it('fait REMONTER la page dont c’est le titre', () => {
      // Quelqu'un qui tape « profils » cherche la page qui s'appelle ainsi,
      // pas les pages qui la mentionnent.
      const resultat = service.rechercher('profils', 20);
      expect(resultat.resultats[0]?.slug).toBe('profils');
    });

    it('rend un EXTRAIT autour du terme, en texte brut', () => {
      const resultat = service.rechercher('anonymise', 20);
      const extrait = resultat.resultats[0]?.extrait ?? '';

      expect(extrait.toLowerCase()).toContain('anonymise');
      // Aucune balise : l'interface sait où est le terme, elle l'a demandé.
      expect(extrait).not.toContain('<');
    });

    it('BORNE le nombre de résultats sans mentir sur le total', () => {
      const resultat = service.rechercher('e', 1);
      expect(resultat.resultats.length).toBeLessThanOrEqual(1);
      expect(resultat.total).toBeGreaterThanOrEqual(resultat.resultats.length);
    });

    it('rend une réponse VIDE et conforme quand rien ne correspond', () => {
      const resultat = service.rechercher('zzzintrouvable', 20);

      expect(resultat).toEqual({ q: 'zzzintrouvable', resultats: [], total: 0 });
      expect(() => DocSearchResponseSchema.parse(resultat)).not.toThrow();
    });

    it('n’expose AUCUN chemin de fichier dans ses réponses', () => {
      const corps = JSON.stringify(service.rechercher('page', 50));

      expect(corps).not.toContain('/src/');
      expect(corps).not.toContain('.md');
    });
  });

  describe('indépendance de la base', () => {
    it('ne dépend d’AUCUN service — le portail tient sans MariaDB', () => {
      // Une documentation qui tombe avec la base serait indisponible au pire
      // moment : celui où l'on cherche quoi faire. L'arité du constructeur est
      // la preuve vérifiable — y injecter un dépôt ferait tomber ce test.
      expect(DocsService.length).toBe(0);
      expect(() => new DocsService()).not.toThrow();
    });
  });

  describe('avant initialisation', () => {
    it('ne sert RIEN tant que les pages ne sont pas chargées', () => {
      // Le cas du dossier illisible est vérifié dans `docs.service.charge.spec`,
      // où le système de fichiers est réellement remplacé — un double construit
      // ici ne serait jamais appelé, et le test ne prouverait rien.
      const vide = new DocsService();

      expect(vide.index().sections).toEqual([]);
      expect(() => vide.page('premiers-pas')).toThrow(NotFoundException);
    });
  });
});
