'use client';

import Link from 'next/link';
import { trpc } from '@/lib/trpc';

export default function CabinetsPage() {
  const cabinets = trpc.cabinet.list.useQuery();
  const utils = trpc.useUtils();
  const setPinned = trpc.cabinet.setPinned.useMutation({
    onSuccess: () => utils.cabinet.list.invalidate(),
  });

  if (cabinets.isLoading) return <p className="muted">Loading cabinets…</p>;
  if (cabinets.error) return <p className="error">{cabinets.error.message}</p>;

  const items = cabinets.data ?? [];
  if (items.length === 0) {
    return (
      <>
        <h2>Cabinets</h2>
        <p className="muted">
          No cabinet is accessible to you. An administrator grants access per cabinet
          and role.
        </p>
      </>
    );
  }

  return (
    <>
      <h2>Cabinets</h2>
      <div className="grid-cards">
        {items.map((c) => (
          <article key={c.id} className="card">
            <div className="row">
              <Link href={`/c/${c.id}`} style={{ fontWeight: 600, fontSize: 15 }}>
                {c.name}
              </Link>
              <div className="spacer" />
              <button
                className="small"
                title={c.isPinned ? 'Unpin' : 'Pin to sidebar'}
                onClick={() =>
                  setPinned.mutate({ cabinetId: c.id, pinned: !c.isPinned })
                }
              >
                {c.isPinned ? 'Unpin' : 'Pin'}
              </button>
            </div>

            <p className="small muted" style={{ minHeight: 34 }}>
              {c.description ?? 'No description.'}
            </p>

            <div className="row wrap small">
              <span className="pill">{c.indexFieldCount} index fields</span>
              {c.status !== 'active' ? <span className="pill">{c.status}</span> : null}
              {c.isReadOnly ? <span className="pill">read only</span> : null}
              {c.repoEncrypted ? <span className="pill">encrypted</span> : null}
              {c.enableFullTextIndex ? <span className="pill">full text</span> : null}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
