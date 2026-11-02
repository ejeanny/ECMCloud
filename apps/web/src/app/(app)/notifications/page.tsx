'use client';

import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function NotificationsPage() {
  const utils = trpc.useUtils();
  const list = trpc.notification.list.useQuery({ skip: 0, take: 100, unreadOnly: false });

  const markViewed = trpc.notification.markViewed.useMutation({
    onSuccess: () => utils.notification.list.invalidate(),
  });
  const markAll = trpc.notification.markAllViewed.useMutation({
    onSuccess: () => utils.notification.list.invalidate(),
  });

  if (list.isLoading) return <p className="muted">Loading…</p>;
  if (list.error) return <p className="error">{list.error.message}</p>;

  const items = list.data?.items ?? [];

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Notifications</h2>
        <span className="spacer" />
        <button disabled={!list.data?.unread} onClick={() => markAll.mutate()}>
          Mark all read ({list.data?.unread ?? 0})
        </button>
      </div>

      {items.length === 0 ? <p className="muted">Nothing here.</p> : null}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((n) => (
          <li
            key={n.id}
            className="card"
            style={{
              marginBottom: 8,
              borderLeft: n.isViewed ? undefined : '3px solid var(--accent)',
            }}
          >
            <div className="row wrap">
              <span className="pill">{n.type}</span>
              <span className="pill">{n.action}</span>
              <span className="spacer" />
              <span className="small muted">{formatDate(n.created)}</span>
              {!n.isViewed ? (
                <button
                  className="small"
                  onClick={() => markViewed.mutate({ ids: [n.id] })}
                >
                  Mark read
                </button>
              ) : null}
            </div>
            <p style={{ margin: '6px 0 0' }}>{n.message}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
