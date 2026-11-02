# ECM — a Next.js 16 / tRPC / Node rebuild of Dokmee ECM

A ground-up TypeScript implementation of the document-management product
reverse-engineered in [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) (Dokmee
ECM 7.8.3.27, ASP.NET + Angular 21 + SQL Server). No Dokmee code was copied;
the behaviour, data model and privilege vocabulary were recovered from the
shipped artifacts and the local database, then re-implemented.

## Layout

```
packages/domain   privilege vocabulary, enums, Zod schemas, access evaluation
packages/db       Prisma schema (PostgreSQL) + seed
apps/api          Fastify + tRPC v11, blob repository, job worker, workflow engine
apps/web          Next.js 16 App Router + tRPC client
```

## Running it

```bash
npm install
```

### A PostgreSQL to develop against

If there is no PostgreSQL on the machine and no Docker, the server binaries can
come from npm — no install, no service, no admin rights:

```bash
npm install --no-save embedded-postgres@17.5.0-beta.15
```

```bash
node_modules/@embedded-postgres/windows-x64/native/bin/initdb -D /tmp/ecm-pgdata -U ecm --auth=trust -E UTF8 --locale=C
```

```bash
node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl -D /tmp/ecm-pgdata -o "-p 55432 -c listen_addresses=127.0.0.1" -l /tmp/ecm-pgdata/server.log start
```

`prisma db push` creates the database itself, so no `createdb` is needed; point
`DATABASE_URL` at `postgresql://ecm@127.0.0.1:55432/ecm?schema=public`. Swap
`windows-x64` for your platform's package.

### Configuration

Create `apps/api/.env` — the API and the seed load it through Node's
`--env-file-if-exists`, so it needs no `dotenv`. Write it **without a UTF-8
BOM**: Node's parser treats a leading BOM as part of the first key's name, and
the first variable silently goes missing.

```bash
DATABASE_URL="postgresql://ecm:ecm@localhost:5432/ecm?schema=public"
REPOSITORY_ROOT="C:/ecm-repository"
REPOSITORY_MASTER_KEY="<32 random bytes, base64 — only needed for encrypted cabinets>"
WEB_ORIGIN="http://localhost:3000"
PORT=4000
```

Generate the client and create the schema:

```bash
npm run db:generate
```

```bash
DATABASE_URL=... npm run db:push
```

Seed the four built-in roles, an administrator and a demo cabinet:

```bash
DATABASE_URL=... ECM_ADMIN_PASSWORD='<choose one>' npm run db:seed
```

Run both processes:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

The web app proxies `/trpc`, `/file` and `/upload` to the API, so the browser
stays on one origin and the session cookie is first-party.

## What is implemented

**Cabinets** — the tenancy and configuration boundary, each with its own index
fields, role grants, workflows and audit trail; pinning, per-cabinet stats,
read-only and offline status.

**Documents** — folder/document/link tree with a materialised path, create,
rename, move (whole subtrees in one prefix update), copy (metadata copied,
blob shared by content hash), soft delete into a per-cabinet recycle bin with
restore and permanent purge.

**Index fields** — nine field types, required/locked/default flags, select
lists, folder levels, auto-numbers, reorder, and find-and-replace across a
field with a dry-run preview. Values are typed rows, not dynamic columns.

**Versions** — check-out/check-in with major.minor versioning, revert (itself
undoable), lock breaking by an administrator, and a "my check-outs" view.

**Upload** — chunked, resumable: `begin` → `PUT /upload/:id/:segment` →
`finish`, with a segment-presence query, SHA-256 verification and staging
cleanup on abort.

**Search** — free text over names and extracted text, typed index-field
criteria, multi-cabinet, date ranges, match snippets, CSV export.

**Security** — grant-then-deny over 65 privileges; four built-in roles; system
and per-cabinet grants; per-user and per-cabinet explicit denies; whole-cabinet
denial; read-only role bindings; row-level view restrictions as declared
JSON predicates. A permission change revokes the affected sessions immediately.

**Audit** — every state change plus views and downloads, queryable and
exportable, with a per-day activity rollup.

**Workflow** — design revisions with a publish step, tasks with role/user
assignees, routings on approve/reject/decision, triggers on new document or
index change narrowed by criteria, a per-user task inbox, and per-document
instance history.

**Retention** — rules with a period, a date field, criteria and an action;
expiry preview before anything is deleted; notify / recycle / permanent delete.

**Jobs** — one queue with claim-on-update, exponential backoff and a failure
dashboard, standing in for Dokmee's thirteen Windows services.

**Per-user** — notes, favourites, recents, notifications, settings, password
change.

## What is deliberately not implemented

These need the third-party engines Dokmee licensed (IRIS OCR, ISYS text
extraction, Spire for Office formats, Apryse/PDFTron for rendering and page
manipulation), or an external service. Each is a named job kind whose handler
fails with that reason rather than silently doing nothing:

- OCR and zone OCR; text extraction beyond plain-text formats
- Office/PDF conversion, print-version generation, page manipulation
  (split, merge, extract, rotate, re-order), Bates labelling, annotations and
  stamp burning
- Data extraction, auto-indexing, data export to external systems, RPA
- AI search, AI summaries, AI file creation
- Email ingest and delivery, DocuSign, SAML and Active Directory sync
- The Rappid/JointJS visual workflow designer; workflows are saved through
  `workflow.save`, which takes the task and routing graph directly
- Dokmee Capture, Hub and the Outlook add-in, and licensing

The data model carries the columns these features need (`emailFrom`,
`hasDigitalSignature`, `encryptedKey`, stamp and signature tables), so adding
an engine is a handler, not a migration.

## Design decisions that differ from Dokmee

Set out with reasons in [REVERSE-ENGINEERING.md §6](REVERSE-ENGINEERING.md).
The four that matter most: one database instead of one per cabinet; typed
index-value rows instead of `ALTER TABLE`-added columns; a declared JSON
predicate instead of an opaque `varbinary` restriction blob; and TypeScript
services instead of 441 stored procedures.

## Security notes

- Passwords are argon2id with the cost in the PHC string. Sessions are
  server-side rows with a hashed token, device and window id, and an expiry;
  the cookie is `httpOnly`, `sameSite=lax`, and `secure` in production.
- Login compares a hash even when the user does not exist, so a bad user name
  and a bad password take the same time.
- Blobs live outside the database under a per-cabinet repository root. An
  encrypted cabinet gets a per-file AES-256-GCM key wrapped with the
  repository master key, with the auth tag appended so the file is
  self-verifying — the shape of Dokmee's `CryptoKey`/`CryptoVector` envelope.
- `Content-Disposition` filenames are escaped and `X-Content-Type-Options:
  nosniff` is set, because document names are user-controlled.
- Row-level view restrictions are applied in the database query, not filtered
  in the client, and never hide folders (which would break the tree).
