import { z } from 'zod';

/** Sonde publique `GET /api/v1/health` — aucune information d'infrastructure exposée. */
export const HealthSchema = z
  .object({
    ok: z.literal(true),
    version: z.string(),
  })
  .strict();

export type Health = z.infer<typeof HealthSchema>;
