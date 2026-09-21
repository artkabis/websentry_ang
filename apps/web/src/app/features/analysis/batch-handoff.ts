/**
 * Clé de passage de relais entre l'écran de sitemap et celui de lot.
 *
 * Une sélection de deux cents URL ne tient pas dans une barre d'adresse : elle
 * voyage donc par l'état de navigation. La clé vit ici, et non dans l'un des
 * deux écrans, pour qu'aucun des deux ne dépende de l'autre.
 */
export const BATCH_URLS_STATE = 'urls';
