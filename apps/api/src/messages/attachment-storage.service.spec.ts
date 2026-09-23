import { BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAILLE_MAX_PIECE_JOINTE } from '@websentry/shared';
import type { AppConfigService } from '../config/app-config.service.js';
import { AttachmentStorageService } from './attachment-storage.service.js';

/** Un PNG minimal — seule l'empreinte compte. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);

describe('AttachmentStorageService', () => {
  let racine: string;
  let stockage: AttachmentStorageService;

  beforeEach(async () => {
    racine = await mkdtemp(join(tmpdir(), 'ws-pj-'));
    stockage = new AttachmentStorageService({
      messageUploadsDir: racine,
    } as unknown as AppConfigService);
  });

  afterEach(async () => {
    await rm(racine, { recursive: true, force: true });
  });

  describe('ce qui atteint le disque', () => {
    it('range le fichier sous un nom GÉNÉRÉ, jamais celui annoncé', async () => {
      const [piece] = await stockage.ranger([{ nomAnnonce: '../../etc/passwd', octets: PNG }]);

      const fichiers = await readdir(racine);
      expect(fichiers).toEqual([`${piece?.id}.png`]);
      // Le nom d'origine survit pour l'affichage, nettoyé — mais il n'est pas
      // le chemin.
      expect(piece?.nom).toBe('.._.._etc_passwd');
    });

    it('déduit l’extension du type RECONNU, pas de celle annoncée', async () => {
      const [piece] = await stockage.ranger([{ nomAnnonce: 'rapport.png', octets: PDF }]);

      expect(piece?.mime).toBe('application/pdf');
      expect(await readdir(racine)).toEqual([`${piece?.id}.pdf`]);
    });

    it('rend un identifiant DIFFÉRENT pour deux fichiers identiques', async () => {
      const pieces = await stockage.ranger([
        { nomAnnonce: 'a.png', octets: PNG },
        { nomAnnonce: 'a.png', octets: PNG },
      ]);

      expect(pieces[0]?.id).not.toBe(pieces[1]?.id);
      expect(await readdir(racine)).toHaveLength(2);
    });

    it('crée le dossier s’il n’existe pas encore', async () => {
      const absent = join(racine, 'sous', 'dossier');
      const neuf = new AttachmentStorageService({
        messageUploadsDir: absent,
      } as unknown as AppConfigService);

      await neuf.ranger([{ nomAnnonce: 'a.png', octets: PNG }]);
      expect(await readdir(absent)).toHaveLength(1);
    });

    it('accepte un dossier RELATIF, résolu depuis le répertoire courant', async () => {
      const relatif = new AttachmentStorageService({
        messageUploadsDir: './data-test-pj',
      } as unknown as AppConfigService);

      try {
        const [piece] = await relatif.ranger([{ nomAnnonce: 'a.png', octets: PNG }]);
        expect(piece).toBeDefined();
      } finally {
        await rm(join(process.cwd(), 'data-test-pj'), { recursive: true, force: true });
      }
    });
  });

  describe('ce qui est refusé', () => {
    it('REFUSE un exécutable, quel que soit son nom', async () => {
      await expect(stockage.ranger([{ nomAnnonce: 'capture.png', octets: EXE }])).rejects.toThrow(
        BadRequestException,
      );
      expect(await readdir(racine)).toEqual([]);
    });

    it('ne NOMME PAS le type détecté dans le refus', async () => {
      // Le dire renseignerait sur ce que le serveur sait reconnaître, et
      // l'appelant sait déjà ce qu'il a envoyé.
      await expect(stockage.ranger([{ nomAnnonce: 'x.png', octets: EXE }])).rejects.toThrow(
        /PNG, JPEG, WebP ou PDF/,
      );
    });

    it('REFUSE un fichier vide', async () => {
      await expect(
        stockage.ranger([{ nomAnnonce: 'vide.png', octets: Buffer.alloc(0) }]),
      ).rejects.toThrow(/vide/);
    });

    it('REFUSE au-delà du plafond de taille', async () => {
      // Le plugin multipart borne déjà le transport ; s'en remettre à lui seul
      // ferait dépendre une règle métier d'un réglage de transport.
      const trop = Buffer.concat([PNG, Buffer.alloc(TAILLE_MAX_PIECE_JOINTE)]);
      await expect(stockage.ranger([{ nomAnnonce: 'gros.png', octets: trop }])).rejects.toThrow(
        /volumineuse/,
      );
      expect(await readdir(racine)).toEqual([]);
    });

    it('REFUSE au-delà du nombre de pièces, sans rien écrire', async () => {
      await expect(
        stockage.ranger([
          { nomAnnonce: '1.png', octets: PNG },
          { nomAnnonce: '2.png', octets: PNG },
          { nomAnnonce: '3.png', octets: PNG },
          { nomAnnonce: '4.png', octets: PNG },
        ]),
      ).rejects.toThrow(/Au plus 3/);
      expect(await readdir(racine)).toEqual([]);
    });

    it('RETIRE ce qui a déjà été écrit quand un fichier du lot est refusé', async () => {
      // Un fichier orphelin n'a plus aucune ligne pour le décrire : plus
      // personne ne le supprimera jamais.
      await expect(
        stockage.ranger([
          { nomAnnonce: 'bon.png', octets: PNG },
          { nomAnnonce: 'mauvais.png', octets: EXE },
        ]),
      ).rejects.toThrow(BadRequestException);

      expect(await readdir(racine)).toEqual([]);
    });
  });

  describe('relecture', () => {
    it('rend exactement les octets rangés', async () => {
      const [piece] = await stockage.ranger([{ nomAnnonce: 'a.png', octets: PNG }]);
      const lu = await stockage.lire(piece!.id, piece!.mime);

      expect(Buffer.compare(lu, PNG)).toBe(0);
    });

    it('ÉCHOUE sur un identifiant qui ne désigne aucun fichier', async () => {
      await expect(
        stockage.lire('11111111-1111-4111-8111-111111111111', 'image/png'),
      ).rejects.toThrow();
    });
  });

  describe('suppression', () => {
    it('retire le fichier, quelle que soit son extension', async () => {
      const [png] = await stockage.ranger([{ nomAnnonce: 'a.png', octets: PNG }]);
      const [pdf] = await stockage.ranger([{ nomAnnonce: 'b.pdf', octets: PDF }]);

      await stockage.supprimer([png!.id, pdf!.id]);
      expect(await readdir(racine)).toEqual([]);
    });

    it('ne PROPAGE PAS l’échec d’une suppression', async () => {
      // La ligne qui décrivait le fichier a pu disparaître par ailleurs : ce
      // n'est pas une anomalie à faire remonter à l'appelant.
      await expect(
        stockage.supprimer(['11111111-1111-4111-8111-111111111111']),
      ).resolves.toBeUndefined();
    });

    it('JOURNALISE un retrait impossible plutôt que de le taire', async () => {
      // Aucun mock du système de fichiers : un DOSSIER non vide portant le nom
      // attendu fait réellement échouer `rm` sans `recursive`. Le service doit
      // le dire, et poursuivre.
      const id = '11111111-1111-4111-8111-111111111111';
      await mkdir(join(racine, `${id}.png`), { recursive: true });
      await writeFile(join(racine, `${id}.png`, 'occupe'), 'x');

      const avertissement = vi
        .spyOn((stockage as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);

      await expect(stockage.supprimer([id])).resolves.toBeUndefined();
      expect(avertissement).toHaveBeenCalledWith(expect.stringContaining(id));
    });
  });

  describe('écriture concurrente', () => {
    it('REFUSE d’écraser un fichier existant', async () => {
      // `flag: 'wx'` : si un identifiant se répétait, l'écriture échouerait au
      // lieu d'effacer silencieusement une pièce jointe d'autrui.
      const [piece] = await stockage.ranger([{ nomAnnonce: 'a.png', octets: PNG }]);
      const chemin = join(racine, `${piece?.id}.png`);

      await expect(writeFile(chemin, PNG, { flag: 'wx' })).rejects.toThrow();
      expect(Buffer.compare(await readFile(chemin), PNG)).toBe(0);
    });
  });
});
