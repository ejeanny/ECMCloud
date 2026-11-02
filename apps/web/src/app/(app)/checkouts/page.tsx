'use client';

import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function CheckoutsPage() {
  const utils = trpc.useUtils();
  const checkouts = trpc.version.myCheckOuts.useQuery();

  function refresh() {
    void utils.version.myCheckOuts.invalidate();
    void utils.node.list.invalidate();
  }

  const checkIn = trpc.version.checkIn.useMutation({ onSuccess: refresh });
  const cancel = trpc.version.cancelCheckOut.useMutation({ onSuccess: refresh });

  if (checkouts.isLoading) return <p className="muted">Loading…</p>;
  if (checkouts.error) return <p className="error">{checkouts.error.message}</p>;

  const items = checkouts.data ?? [];

  return (
    <>
      <h2>My check-outs</h2>
      <p className="muted small">
        A checked-out document is locked against other users&apos; edits until it
        is checked in or the check-out is cancelled.
      </p>

      {items.length === 0 ? (
        <p className="muted">You have nothing checked out.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ width: 170 }}>Since</th>
              <th>Comment</th>
              <th style={{ width: 230 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.checkoutId}>
                <td title={item.node.name}>
                  <a href={`/file/${item.node.id}`} target="_blank" rel="noreferrer">
                    📄 {item.node.name}
                  </a>
                </td>
                <td className="small muted">{formatDate(item.since)}</td>
                <td className="small muted">{item.comment ?? '—'}</td>
                <td>
                  <div className="row small">
                    <button
                      onClick={() =>
                        checkIn.mutate({ nodeId: item.node.id, bump: 'minor' })
                      }
                    >
                      Check in
                    </button>
                    <button
                      className="danger"
                      onClick={() => cancel.mutate({ nodeId: item.node.id })}
                    >
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {checkIn.error ? <p className="error">{checkIn.error.message}</p> : null}
      {cancel.error ? <p className="error">{cancel.error.message}</p> : null}
    </>
  );
}
