import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Le contrôle du chargement initial est une étape BLOQUANTE du build : s'il se
 * trompe en silence, il ne bloque rien et personne ne s'en aperçoit. Ces tests
 * l'exercent donc comme le build l'exerce — en le lançant — et vérifient ce qui
 * compte : le code de sortie.
 *
 * Le fichier vit sous `src/` et non à côté du script parce que c'est là que
 * Vitest cherche les tests de ce paquet. Un test d'outillage posé hors de cette
 * arborescence ne serait jamais exécuté — donc inexistant.
 */

const SCRIPT = 'scripts/verifier-noyau.mjs';

/** Un `stats.json` minimal, à la forme du métafichier d'esbuild. */
function stats(options: {
  zodDansLeNoyau: boolean;
  zodDansUnMorceauDiffere?: boolean;
  octetsDuNoyau?: number;
}) {
  const ZOD = '../../node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js';
  const SCHEMA = '../../packages/shared/dist/esm/schemas/auth.schema.js';

  const noyau: Record<string, { bytesInOutput: number }> = {
    'src/main.ts': { bytesInOutput: 400 },
    'src/app/core/auth/auth.service.ts': { bytesInOutput: 2000 },
  };
  if (options.zodDansLeNoyau) {
    noyau[SCHEMA] = { bytesInOutput: 700 };
    noyau[ZOD] = { bytesInOutput: 128_000 };
  }

  const outputs: Record<string, unknown> = {
    'main-AAAA.js': {
      bytes: options.octetsDuNoyau ?? 4000,
      inputs: noyau,
      imports: [{ path: 'chunk-BBBB.js', kind: 'import-statement' }],
    },
    'chunk-BBBB.js': {
      bytes: 1000,
      inputs: { 'src/app/app.component.ts': { bytesInOutput: 900 } },
      imports: [],
    },
  };
  if (options.zodDansUnMorceauDiffere) {
    // Un `import()` dynamique : le morceau existe, mais il n'est pas téléchargé
    // avant la première navigation — c'est précisément ce qu'on veut autoriser.
    outputs['main-AAAA.js'] = {
      ...(outputs['main-AAAA.js'] as object),
      imports: [
        { path: 'chunk-BBBB.js', kind: 'import-statement' },
        { path: 'chunk-CCCC.js', kind: 'dynamic-import' },
      ],
    };
    outputs['chunk-CCCC.js'] = {
      bytes: 129_000,
      inputs: { [SCHEMA]: { bytesInOutput: 700 }, [ZOD]: { bytesInOutput: 128_000 } },
      imports: [],
    };
  }

  return {
    inputs: {
      'src/main.ts': { imports: [{ path: 'src/app/core/auth/auth.service.ts' }] },
      'src/app/core/auth/auth.service.ts': { imports: [{ path: SCHEMA }] },
      'src/app/app.component.ts': { imports: [] },
      [SCHEMA]: { imports: [{ path: ZOD }] },
      [ZOD]: { imports: [] },
    },
    outputs,
  };
}

function lancer(contenu: unknown): { code: number; sortie: string } {
  const chemin = join(mkdtempSync(join(tmpdir(), 'noyau-')), 'stats.json');
  writeFileSync(chemin, JSON.stringify(contenu));
  try {
    const sortie = execFileSync('node', [SCRIPT, chemin], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, sortie };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, sortie: `${e.stdout}${e.stderr}` };
  }
}

describe('contrôle du chargement initial', () => {
  it('ÉCHOUE quand un paquet interdit est dans le noyau', () => {
    const { code, sortie } = lancer(stats({ zodDansLeNoyau: true }));

    expect(code).toBe(1);
    expect(sortie).toContain('zod');
  });

  it('NOMME la ligne d’import à retirer', () => {
    // Sans la chaîne, on sait qu'on a grossi mais pas quoi corriger.
    const { sortie } = lancer(stats({ zodDansLeNoyau: true }));

    expect(sortie).toContain('src/app/core/auth/auth.service.ts');
    expect(sortie).toContain('auth.schema.js');
  });

  it('PASSE quand le paquet n’est que dans un morceau différé', () => {
    // C'est la cible : le validateur existe, mais après la première navigation.
    const { code } = lancer(stats({ zodDansLeNoyau: false, zodDansUnMorceauDiffere: true }));

    expect(code).toBe(0);
  });

  it('rend compte du poids par paquet, même quand tout va bien', () => {
    const { sortie } = lancer(stats({ zodDansLeNoyau: false }));

    expect(sortie).toContain('JavaScript initial');
    expect(sortie).toContain('Aucun paquet interdit');
  });

  it('ÉCHOUE au-dessus du plafond de JavaScript initial', () => {
    // Le plafond vit ICI et non dans le budget d'Angular : quand ce budget
    // échoue, le constructeur n'écrit pas de rapport, et le contrôle capable
    // de nommer la cause ne tournerait jamais.
    const { code, sortie } = lancer(stats({ zodDansLeNoyau: false, octetsDuNoyau: 400_000 }));

    expect(code).toBe(1);
    expect(sortie).toContain('au-dessus du plafond');
  });

  it('PASSE sous le plafond', () => {
    const { code, sortie } = lancer(stats({ zodDansLeNoyau: false, octetsDuNoyau: 300_000 }));

    expect(code).toBe(0);
    expect(sortie).toContain('le plafond est tenu');
  });

  it('ÉCHOUE quand le rapport de build est absent', () => {
    // Un contrôle qui n'a rien pu lire n'a rien vérifié : se taire
    // équivaudrait à valider.
    let code = 0;
    try {
      execFileSync('node', [SCRIPT, '/inexistant/stats.json'], { stdio: 'pipe' });
    } catch (err) {
      code = (err as { status: number }).status;
    }

    expect(code).toBe(1);
  });
});
