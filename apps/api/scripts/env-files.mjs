// Emplacements du fichier d'environnement, DANS CET ORDRE.
//
// Cette liste double celle de `src/config/config.module.ts` : le script de
// développement s'exécute AVANT toute compilation, il ne peut donc pas importer
// le module. Un test compare les deux et échoue si elles divergent — c'est ce
// qui rend le doublon supportable.
export const ENV_FILES = ['.env.local', '.env', '../../.env.local', '../../.env'];
