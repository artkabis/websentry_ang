import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  NOMBRE_MAX_PIECES_JOINTES,
  nomAffichable,
  TAILLE_MAX_PIECE_JOINTE,
  TYPES_PIECE_JOINTE,
  typeReconnu,
  type MimePieceJointe,
} from '@websentry/shared';
import { AppConfigService } from '../config/app-config.service.js';

/** Un fichier reçu, tel que le contrôleur l'a lu du flux multipart. */
export interface FichierRecu {
  /** Nom annoncé par l'appelant — jamais utilisé comme chemin. */
  nomAnnonce: string;
  octets: Buffer;
}

/** Ce qui est réellement rangé, et que la base décrit. */
export interface PieceRangee {
  id: string;
  nom: string;
  mime: MimePieceJointe;
  taille: number;
}

/**
 * Stockage des pièces jointes.
 *
 * Trois règles portent ce service, et elles tiennent en une phrase : **rien de
 * ce que fournit l'appelant n'atteint le système de fichiers**.
 *
 *  1. **Le nom de stockage est GÉNÉRÉ.** Un UUID, suivi de l'extension du type
 *     reconnu. Le nom d'origine ne sert qu'à l'affichage. C'est ce qui rend la
 *     traversée de chemin impossible par construction plutôt que par filtrage :
 *     il n'y a aucun chemin à filtrer.
 *  2. **Le type est LU dans le fichier.** L'extension et l'en-tête
 *     `Content-Type` sont des déclarations de l'appelant ; l'empreinte des
 *     premiers octets, non. Un exécutable renommé `.png` est refusé.
 *  3. **La taille est vérifiée APRÈS lecture.** Le plugin multipart pose déjà
 *     une limite, mais s'en remettre à lui seul ferait dépendre une règle
 *     métier d'un réglage de transport.
 *
 * Le dossier de destination est vérifié à chaque écriture : un chemin résolu
 * qui sortirait du dossier configuré fait échouer l'opération plutôt que
 * d'écrire ailleurs.
 */
@Injectable()
export class AttachmentStorageService {
  private readonly logger = new Logger(AttachmentStorageService.name);
  private readonly racine: string;

  constructor(config: AppConfigService) {
    const configure = config.messageUploadsDir;
    this.racine = isAbsolute(configure) ? configure : resolve(process.cwd(), configure);
  }

  /**
   * Range les fichiers reçus, ou n'en range aucun.
   *
   * En cas de refus au milieu du lot, ce qui a déjà été écrit est retiré : un
   * fichier orphelin sur le disque n'a plus aucune ligne pour le décrire, donc
   * plus personne pour le supprimer un jour.
   */
  async ranger(fichiers: readonly FichierRecu[]): Promise<PieceRangee[]> {
    if (fichiers.length > NOMBRE_MAX_PIECES_JOINTES) {
      throw new BadRequestException(
        `Au plus ${NOMBRE_MAX_PIECES_JOINTES} pièces jointes par message.`,
      );
    }

    const rangees: PieceRangee[] = [];
    try {
      await mkdir(this.racine, { recursive: true });
      for (const fichier of fichiers) {
        rangees.push(await this.rangerUn(fichier));
      }
      return rangees;
    } catch (err) {
      await this.supprimer(rangees.map(p => p.id));
      throw err;
    }
  }

  private async rangerUn(fichier: FichierRecu): Promise<PieceRangee> {
    const taille = fichier.octets.byteLength;
    if (taille === 0) {
      throw new BadRequestException('Pièce jointe vide.');
    }
    if (taille > TAILLE_MAX_PIECE_JOINTE) {
      throw new BadRequestException(
        `Pièce jointe trop volumineuse (maximum ${TAILLE_MAX_PIECE_JOINTE} octets).`,
      );
    }

    const mime = typeReconnu(fichier.octets);
    if (mime === null) {
      // Le message ne nomme PAS le type détecté : le dire renseignerait sur ce
      // que le serveur sait reconnaître, et l'appelant n'en a aucun usage
      // légitime — il sait ce qu'il a envoyé.
      throw new BadRequestException(
        'Type de pièce jointe non accepté (image PNG, JPEG, WebP ou PDF).',
      );
    }

    const id = randomUUID();
    await writeFile(this.cheminDe(id, mime), fichier.octets, { flag: 'wx' });

    return { id, nom: nomAffichable(fichier.nomAnnonce), mime, taille };
  }

  /** Contenu d'une pièce jointe, désignée par son identifiant et son type. */
  lire(id: string, mime: MimePieceJointe): Promise<Buffer> {
    return readFile(this.cheminDe(id, mime));
  }

  /**
   * Retire des fichiers — sans jamais faire échouer l'appelant.
   *
   * Un fichier déjà absent n'est pas une anomalie à propager : la ligne qui le
   * décrivait a pu être supprimée par ailleurs.
   */
  async supprimer(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      for (const { extension } of Object.values(TYPES_PIECE_JOINTE)) {
        await rm(join(this.racine, `${id}.${extension}`), { force: true }).catch((err: unknown) => {
          this.logger.warn(`Pièce jointe non supprimée (${id}) : ${(err as Error).message}`);
        });
      }
    }
  }

  /**
   * Chemin de stockage, à partir d'un identifiant GÉNÉRÉ par le serveur.
   *
   * Il n'y a rien à filtrer ici, et c'est le but : `id` est un UUID produit par
   * `randomUUID`, `mime` appartient à une union fermée dont chaque membre porte
   * une extension écrite en dur. Aucune des deux composantes ne peut contenir
   * un séparateur, donc aucune ne peut sortir du dossier.
   *
   * Un garde de confinement ici serait une branche qu'aucune entrée ne peut
   * atteindre — donc une branche morte, et un test creux pour la couvrir. La
   * défense est dans le TYPE, pas dans une vérification d'exécution.
   */
  private cheminDe(id: string, mime: MimePieceJointe): string {
    return join(this.racine, `${id}.${TYPES_PIECE_JOINTE[mime].extension}`);
  }
}
