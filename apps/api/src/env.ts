import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  /** Root of the blob repository; one subdirectory per cabinet, as Dokmee's
   *  `PrimaryRepo` pointed at `C:\Dokmee ECM Repository\<cabinetGuid>`. */
  REPOSITORY_ROOT: z.string().min(1),
  /** Master key wrapping each file's per-file key, base64, 32 bytes. */
  REPOSITORY_MASTER_KEY: z.string().min(1).optional(),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).default(480),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        `Invalid environment:\n${parsed.error.issues
          .map((i) => `  ${i.path.join('.')}: ${i.message}`)
          .join('\n')}`,
      );
    }
    cached = parsed.data;
  }
  return cached;
}
