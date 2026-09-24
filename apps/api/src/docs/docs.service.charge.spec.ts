import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Chargement de la documentation quand le système de fichiers se dérobe.
 *
 * Ces cas vivent dans un fichier SÉPARÉ parce qu'ils remplacent `node:fs` pour
 * tout le module : les mélanger aux tests qui lisent les pages réelles ferait
 * disparaître celles-ci.
 */
vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const { readdirSync, readFileSync } = await import('node:fs');
const { DocsService } = await import('./docs.service.js');

describe('DocsService — chargement dégradé', () => {
  beforeEach(() => {
    vi.mocked(readdirSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  it('reste DEBOUT quand le dossier est illisible', () => {
    // Un portail vide vaut mieux qu'une API qui refuse de démarrer parce
    // qu'un dossier de documentation manque.
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const service = new DocsService();
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.index().sections).toEqual([]);
  });

  it('IGNORE un fichier dont le nom ne fait pas un identifiant', () => {
    // Le nom de fichier devient une clé d'API : il est validé comme le serait
    // une entrée.
    vi.mocked(readdirSync).mockReturnValue(['Majuscule.md', '../evasion.md', 'bon.md'] as never);
    vi.mocked(readFileSync).mockReturnValue('---\ntitre: Bon\n---\n\nDu texte.');

    const service = new DocsService();
    service.onModuleInit();

    const slugs = service.index().sections.flatMap(s => s.pages.map(p => p.slug));
    expect(slugs).toEqual(['bon']);
  });

  it('DIT pourquoi il a ignoré un fichier mal nommé', () => {
    /*
     * Ce contrôle est redondant avec le schéma, qui refuserait la page de
     * toute façon — une mutation qui le retire ne change donc RIEN de ce que
     * l'API sert. Sa valeur est ailleurs : dans le diagnostic. Sans lui,
     * l'exploitant lit une erreur de schéma sur une page qu'il n'a pas écrite,
     * au lieu de « ce nom de fichier n'est pas un identifiant ».
     *
     * C'est cette valeur-là que le test fixe, et elle, une mutation la voit.
     */
    vi.mocked(readdirSync).mockReturnValue(['Majuscule.md'] as never);
    vi.mocked(readFileSync).mockReturnValue('---\ntitre: X\n---\n\nTexte.');

    const service = new DocsService();
    const avertir = vi
      .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    service.onModuleInit();

    expect(avertir).toHaveBeenCalledWith(expect.stringContaining('identifiant invalide'));
    expect(avertir).toHaveBeenCalledWith(expect.stringContaining('Majuscule.md'));
  });

  it('IGNORE une page illisible sans perdre les autres', () => {
    // Un fichier corrompu ne doit pas emporter tout le portail.
    vi.mocked(readdirSync).mockReturnValue(['casse.md', 'bon.md'] as never);
    vi.mocked(readFileSync).mockImplementation(((chemin: string) => {
      if (String(chemin).endsWith('casse.md')) throw new Error('EIO');
      return '---\ntitre: Bon\n---\n\nDu texte.';
    }) as never);

    const service = new DocsService();
    service.onModuleInit();

    const slugs = service.index().sections.flatMap(s => s.pages.map(p => p.slug));
    expect(slugs).toEqual(['bon']);
  });

  it('IGNORE les fichiers qui ne sont pas du Markdown', () => {
    vi.mocked(readdirSync).mockReturnValue(['notes.txt', 'script.js', 'bon.md'] as never);
    vi.mocked(readFileSync).mockReturnValue('---\ntitre: Bon\n---\n\nDu texte.');

    const service = new DocsService();
    service.onModuleInit();

    expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1);
  });

  it('DÉPARTAGE deux pages de même ordre par leur titre', () => {
    // Sans départage, l'ordre dépendrait de celui du système de fichiers, qui
    // varie d'une machine à l'autre.
    vi.mocked(readdirSync).mockReturnValue(['b.md', 'a.md'] as never);
    vi.mocked(readFileSync).mockImplementation(((chemin: string) => {
      const titre = String(chemin).endsWith('a.md') ? 'Alpha' : 'Beta';
      return `---\ntitre: ${titre}\nsection: Prise en main\nordre: 1\n---\n\nTexte.`;
    }) as never);

    const service = new DocsService();
    service.onModuleInit();

    const titres = service.index().sections[0]?.pages.map(p => p.titre);
    expect(titres).toEqual(['Alpha', 'Beta']);
  });

  it('place une section INCONNUE après celles qui sont ordonnées', () => {
    // Une section nouvelle ne doit pas prendre la tête du sommaire par
    // accident.
    vi.mocked(readdirSync).mockReturnValue(['z.md', 'p.md'] as never);
    vi.mocked(readFileSync).mockImplementation(((chemin: string) =>
      String(chemin).endsWith('p.md')
        ? '---\ntitre: P\nsection: Prise en main\n---\n\nTexte.'
        : '---\ntitre: Z\nsection: Annexes\n---\n\nTexte.') as never);

    const service = new DocsService();
    service.onModuleInit();

    expect(service.index().sections.map(s => s.section)).toEqual(['Prise en main', 'Annexes']);
  });

  it('départage deux sections INCONNUES par leur nom', () => {
    vi.mocked(readdirSync).mockReturnValue(['b.md', 'a.md'] as never);
    vi.mocked(readFileSync).mockImplementation(((chemin: string) =>
      String(chemin).endsWith('a.md')
        ? '---\ntitre: A\nsection: Alpha\n---\n\nTexte.'
        : '---\ntitre: B\nsection: Beta\n---\n\nTexte.') as never);

    const service = new DocsService();
    service.onModuleInit();

    expect(service.index().sections.map(s => s.section)).toEqual(['Alpha', 'Beta']);
  });

  describe('recherche — cas limites', () => {
    function servir(source: string): InstanceType<typeof DocsService> {
      vi.mocked(readdirSync).mockReturnValue(['page.md'] as never);
      vi.mocked(readFileSync).mockReturnValue(source);
      const service = new DocsService();
      service.onModuleInit();
      return service;
    }

    it('ne BOUCLE PAS sur un terme qui se normalise en RIEN', () => {
      // Deux accents combinants font deux caractères — assez pour franchir la
      // borne du schéma — mais la normalisation les retire. Sans garde,
      // `indexOf('')` rendrait 0 indéfiniment.
      const service = servir('---\ntitre: Page\n---\n\nDu texte.');

      const resultat = service.rechercher('\u0301\u0301', 20);
      expect(resultat.total).toBe(0);
    });

    it('retombe sur le DÉBUT de la page quand l’extrait ne retrouve pas le terme', () => {
      // L'index garde les espaces multiples, l'extrait les réduit : un terme
      // qui en contient est trouvé par l'un et pas par l'autre. Mieux vaut un
      // extrait approximatif qu'une découpe sur une position négative.
      const service = servir('---\ntitre: Page\n---\n\nun   trou dans le texte.');

      const resultat = service.rechercher('un   trou', 20);
      expect(resultat.total).toBe(1);
      expect(resultat.resultats[0]?.extrait.length).toBeGreaterThan(0);
    });

    it('ENCADRE l’extrait de points de suspension quand la page déborde', () => {
      const service = servir(
        `---\ntitre: Page\n---\n\n${'remplissage '.repeat(40)}cible ${'suite '.repeat(40)}`,
      );

      const extrait = service.rechercher('cible', 20).resultats[0]?.extrait ?? '';
      expect(extrait.startsWith('…')).toBe(true);
      expect(extrait.endsWith('…')).toBe(true);
    });

    it('n’ajoute AUCUN point de suspension sur une page courte', () => {
      const service = servir('---\ntitre: Page\n---\n\nUne page courte avec cible dedans.');

      const extrait = service.rechercher('cible', 20).resultats[0]?.extrait ?? '';
      expect(extrait.startsWith('…')).toBe(false);
      expect(extrait.endsWith('…')).toBe(false);
    });
  });

  it('RECHARGE proprement — deux initialisations ne doublent pas les pages', () => {
    vi.mocked(readdirSync).mockReturnValue(['bon.md'] as never);
    vi.mocked(readFileSync).mockReturnValue('---\ntitre: Bon\n---\n\nDu texte.');

    const service = new DocsService();
    service.onModuleInit();
    service.onModuleInit();

    expect(service.index().sections.flatMap(s => s.pages)).toHaveLength(1);
  });
});
