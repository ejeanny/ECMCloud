import { z } from 'zod';

/**
 * `prisma+postgres://` is Prisma Postgres's own protocol, which is served
 * locally by `prisma dev`; the hosted form of it is being retired in favour of
 * ordinary TCP, so both spellings are accepted here.
 */
function isPostgresUrl(value: string): boolean {
  return /^(postgres|postgresql|prisma\+postgres):\/\//.test(value);
}

/**
 * An optional setting, where blank means absent.
 *
 * `FOO=""` in an env file arrives as the empty string, not as undefined, so a
 * plain `.optional()` rejects it — and writing the key with no value is the
 * obvious way to say "I am not using this". `.env.example` did exactly that
 * and could not be copied without editing it first.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  /**
   * The database the API and the worker query. Against Prisma Postgres this is
   * the **pooled** connection string (`pooled.db.prisma.io`); the unpooled one
   * belongs in `DIRECT_DATABASE_URL`, where the Prisma CLI picks it up.
   */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(isPostgresUrl, {
      message:
        'must be a PostgreSQL connection string (postgres://, postgresql:// or prisma+postgres://)',
    }),
  /**
   * The unpooled connection, used only by the Prisma CLI — migrations take
   * advisory locks and a shadow database, and a transaction-mode pooler does
   * not hold either across statements. Unset against an ordinary PostgreSQL,
   * where there is one URL and it serves both.
   */
  DIRECT_DATABASE_URL: optional(
    z
      .string()
      .min(1)
      .refine(isPostgresUrl, {
        message:
          'must be a PostgreSQL connection string (postgres://, postgresql:// or prisma+postgres://)',
      }),
  ),
  /** Root of the blob repository; one subdirectory per cabinet, as Dokmee's
   *  `PrimaryRepo` pointed at `C:\Dokmee ECM Repository\<cabinetGuid>`. */
  REPOSITORY_ROOT: z.string().min(1),
  /** Master key wrapping each file's per-file key, base64, 32 bytes. */
  REPOSITORY_MASTER_KEY: optional(z.string().min(1)),
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
