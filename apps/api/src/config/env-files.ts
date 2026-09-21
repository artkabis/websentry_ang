/**
 * Où chercher le fichier d'environnement, DANS CET ORDRE.
 *
 * Les chemins sont résolus depuis le répertoire courant, et les scripts
 * s'exécutent dans `apps/api`. Sans les deux derniers, un `.env` placé à la
 * racine du dépôt — là où `.env.example` invite à le copier — n'était jamais
 * lu : le démarrage échouait sur « JWT_SECRET manquant » alors que le fichier
 * existait, à deux dossiers de là.
 *
 * Dans un fichier À PART, et non dans le module : importer ce dernier exécute
 * son décorateur, donc la validation de l'environnement — un test qui voudrait
 * seulement lire cette liste ferait alors échouer la suite sur un
 * « JWT_SECRET manquant » sans rapport avec lui.
 */
export const ENV_FILES: readonly string[] = [
  '.env.local',
  '.env',
  '../../.env.local',
  '../../.env',
];
