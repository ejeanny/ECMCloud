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
apps/web          Next.js 16 App Router + tRPC client, shadcn/ui on Tailwind v4
```

## Running it

```bash
npm install
```

### A database

[Prisma Postgres](https://www.prisma.io/postgres). Create a database in the
Prisma Console; its page gives two connection strings, and they are not
interchangeable:

| String | Host | Used by |
| --- | --- | --- |
| pooled | `pooled.db.prisma.io` | the API and the worker, as `DATABASE_URL` |
| direct | `db.prisma.io` | the Prisma CLI, as `DIRECT_DATABASE_URL` |

Both need `?sslmode=require`. The split is not optional book-keeping: the
pooled host is PgBouncer in transaction mode, and `migrate`/`db push` take an
advisory lock and use a shadow database, neither of which survives being
handed back on a different connection. `directUrl` in `schema.prisma` is what
routes the CLI around the pooler.

Nothing in the application code knows which it is talking to — Prisma Postgres
over TCP is ordinary PostgreSQL, so there is no driver adapter and no client
extension. Queries run through the pooled connection are billed per operation.

#### Or an ordinary PostgreSQL

Set `DATABASE_URL` alone and leave `DIRECT_DATABASE_URL` unset; the CLI
wrapper points the direct connection at the same URL. If there is no
PostgreSQL on the machine and no Docker, the server binaries can come from
npm — no install, no service, no admin rights:

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
DATABASE_URL="postgres://USER:PASSWORD@pooled.db.prisma.io:5432/postgres?sslmode=require"
DIRECT_DATABASE_URL="postgres://USER:PASSWORD@db.prisma.io:5432/postgres?sslmode=require"
REPOSITORY_ROOT="C:/ecm-repository"
REPOSITORY_MASTER_KEY="<32 random bytes, base64 — only needed for encrypted cabinets>"
WEB_ORIGIN="http://localhost:3000"
PORT=4000
```

`apps/api/.env.example` has the same thing with the ordinary-PostgreSQL form
commented beside it. The Prisma CLI reads this file too — the `db:*` scripts
hand it to Node — so the connection strings are written down once.

Generate the client and create the schema:

```bash
npm run db:generate
```

```bash
npm run db:push
```

Seed the four built-in roles, an administrator and a demo cabinet:

```bash
ECM_ADMIN_PASSWORD='<choose one>' npm run db:seed
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

### Tests

```bash
ECM_ADMIN_PASSWORD='<the one you seeded with>' npm test
```

227 checks in eight suites, against a **running** API — they sign in, upload
real bytes, wait for the worker and read the result back over HTTP. That is
deliberate: nearly every bug they have caught lived in a seam (a job that was
never enqueued, a predicate applied on one route and not another, a column
written but never read), not inside a function a unit test would have reached.

Name a suite to run one: `npm test restrictions`. They write into the first
cabinet `cabinet.list` returns and leave their documents behind, so point them
at a development database. `tests/fixtures/invoice.pdf` is generated on first
run rather than committed, so the PDF under test is never a stale blob.

## What is implemented

**Cabinets** — the tenancy and configuration boundary, each with its own index
fields, role grants, workflows and audit trail; pinning, per-cabinet stats,
read-only and offline status.

**The file list** — a document's name is a link, so opening one is a click
rather than a selection and a trip to a side panel; a PDF opens in the viewer
and anything else as its bytes. Check out, check in, open and download sit on
the row. Arrow keys move, Enter opens, Space selects, Backspace goes up a
folder. Files dropped anywhere on the list upload into the folder on screen,
and a breadcrumb gives a way back up that is not the tree.

**Documents** — folder/document/link tree with a materialised path, create,
rename, move (whole subtrees in one prefix update), copy (metadata copied,
blob shared by content hash), soft delete into a per-cabinet recycle bin with
restore and permanent purge.

**Index fields** — nine field types, required/locked/default flags, select
lists, folder levels, auto-numbers, reorder, and find-and-replace across a
field with a dry-run preview. Values are typed rows, not dynamic columns.

**Versions** — check-out/check-in with major.minor versioning, revert (itself
undoable), lock breaking by an administrator, and a "my check-outs" view.
Check-out and check-in are on the row in the file list, and check-in takes the
revised file: the row says who holds a lock, and offers the action only to the
person who can take it.

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

**Workflow** — a visual designer on React Flow (Dokmee's was Rappid/JointJS),
drawing the same graph `workflow.save` takes: tasks joined by routings that
fire on approve, reject or a named choice, with the start and the stop drawn
rather than inferred. Problems that would be rejected on save — an ambiguous
pair of routings, a decision with no branches, a missing start — are shown on
the canvas before the round trip. The trigger is edited beside it: start on a
new document or on an index change, narrowed by conditions on index values,
offering only the operators each field's type can answer. `review`, `approval`
and `decision` wait for a person; `notify`, `updateIndex` and `end` the engine
runs itself and moves on, chaining until the flow reaches a step that waits.
Behind it: design revisions with a publish step, role and user assignees, a
per-user task inbox, and per-document instance history.

**Retention** — rules with a period, a date field, criteria and an action;
expiry preview before anything is deleted; notify / recycle / permanent delete.

**Jobs** — one queue with claim-on-update, exponential backoff and a failure
dashboard, standing in for Dokmee's thirteen Windows services.

**Viewer** — PDF rendering in the browser on PDF.js, behind a seam that keeps
the engine replaceable: page windowing for long scans, zoom and fit modes,
rotation, a selectable text layer, search with hit highlighting, and the
document outline. Annotations are highlight, underline, strike-out, freehand
ink, rectangle and sticky note, drawn over the page in PDF user space so they
survive any zoom — stored beside the document and exported as **XFDF**, which
Acrobat and any other PDF tool can read. Burning merges them into the page
content and keeps the file as it was as a version, so a burn is recorded rather
than destructive and `version.revert` undoes it. Adding, editing, deleting and
burning are four separate privileges, as Dokmee had them.

**Per-user** — notes, favourites, recents, notifications, settings, password
change.

## What is deliberately not implemented

These need the third-party engines Dokmee licensed (IRIS OCR, ISYS text
extraction, Spire for Office formats, Apryse/PDFTron for server-side page
manipulation), or an external service. Each is a named job kind whose handler
fails with the specific reason it has none, rather than silently doing nothing:

- OCR and zone OCR; text extraction beyond plain-text formats
- Office/PDF conversion, print-version generation, page manipulation
  (split, merge, extract, rotate, re-order), Bates labelling, and stamp
  burning. Burning *annotations* into a PDF is implemented
  (`apps/api/src/burn.ts`); the rest still needs a format engine
- Data extraction, auto-indexing, data export to external systems, RPA
- AI search, AI summaries, AI file creation
- Email ingest and delivery, DocuSign, SAML and Active Directory sync
- Workflow task types that need an engine: `rpa`, `email`, `signature`,
  `stamp` and `clone`. The designer marks them, and an instance reaching one
  stops with the reason rather than waiting in an inbox for a person who
  cannot help
- Dokmee Capture, Hub and the Outlook add-in, and licensing

The data model carries the columns these features need (`emailFrom`,
`hasDigitalSignature`, `encryptedKey`, stamp and signature tables), so adding
an engine is a handler, not a migration.

For the viewer specifically, [PDF-VIEWER.md](PDF-VIEWER.md) records how Dokmee
drives Apryse WebViewer — the 8 constructor options it sets, the 6 instance
members it touches, the XFDF annotation channel and the server-side operations
behind it — and sets out the open-source path (PDF.js in the browser, `pdf-lib`
and `qpdf` on the server) with an honest account of what has no good
replacement.

## The web UI

Tailwind v4 and [shadcn/ui](https://ui.shadcn.com). There is no
`tailwind.config.js`: the theme is the `@theme inline` block at the top of
`apps/web/src/app/globals.css`, and the light and dark palettes are the CSS
custom properties under `:root` and `.dark` below it. Dark mode is a class on
`<html>` written by `next-themes`, so the toggle in the sidebar can override
what the operating system asks for.

shadcn components are source, not a dependency: they live in
`apps/web/src/components/ui/` and are edited in place. `components.json`
records the style (`new-york`), the aliases and the icon library, so
`npx shadcn@latest add <component>` drops a new one in beside them.

Above those sit a few application-level pieces, shared so that every module
says the same thing the same way: `page-header.tsx` for a page's title and
actions, `states.tsx` for loading, empty and error states, `pager.tsx` for
paging a list, and `theme-toggle.tsx`.

Three rules the pages follow. Tables that have to truncate a name use
`table-fixed` with widths on every other column, because under the automatic
layout the name column collapses instead. A destructive action asks in an
`AlertDialog` rather than `window.confirm`, and prompts for a value in a
`Dialog` rather than `window.prompt`. Colour is only ever a token
(`text-muted-foreground`, `bg-primary`), never a literal, so dark mode needs
no second pass.

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
  in the client, and never hide folders (which would break the tree). They are
  enforced on every path that takes a document id — its metadata, its bytes,
  its versions, notes and annotations, and every mutation — not only on lists
  and search, because a restriction that only filters lists is not security.
  A hidden document answers `404`, not `403`: saying "you may not see this"
  confirms it exists and matches what the caller was looking for.
#   E C M C l o u d  
 