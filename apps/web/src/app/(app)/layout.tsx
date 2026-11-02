'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { trpc } from '@/lib/trpc';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = trpc.session.me.useQuery(undefined, { retry: false });
  const cabinets = trpc.cabinet.list.useQuery(undefined, { enabled: me.isSuccess });
  const todos = trpc.workflow.myTodos.useQuery(
    { skip: 0, take: 1 },
    { enabled: me.isSuccess, refetchInterval: 60_000 },
  );
  const notifications = trpc.notification.list.useQuery(
    { skip: 0, take: 1, unreadOnly: true },
    { enabled: me.isSuccess, refetchInterval: 60_000 },
  );

  const logout = trpc.session.logout.useMutation({
    onSuccess: () => router.replace('/login'),
  });

  const unauthorized = me.error?.data?.code === 'UNAUTHORIZED';

  useEffect(() => {
    if (unauthorized) router.replace('/login');
  }, [unauthorized, router]);

  if (me.isLoading) {
    return (
      <main className="main">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!me.data) {
    return (
      <main className="main">
        <p className="muted">Redirecting to sign in…</p>
      </main>
    );
  }

  const pinned = (cabinets.data ?? []).filter((c) => c.isPinned);
  const isAdmin = me.data.isAdministrator;
  const canSeeUsers =
    isAdmin || me.data.systemRights.includes('User_Administration');
  const canSeeAudit = isAdmin || me.data.systemRights.includes('View_Audit_Log');
  const canSeeJobs = isAdmin || me.data.systemRights.includes('Services_Logs');

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>ECM</h1>

        <nav>
          <Link href="/" aria-current={pathname === '/' ? 'page' : undefined}>
            Cabinets
          </Link>
          <Link href="/inbox" aria-current={pathname === '/inbox' ? 'page' : undefined}>
            My tasks{todos.data?.total ? ` (${todos.data.total})` : ''}
          </Link>
          <Link
            href="/notifications"
            aria-current={pathname === '/notifications' ? 'page' : undefined}
          >
            Notifications{notifications.data?.unread ? ` (${notifications.data.unread})` : ''}
          </Link>
          <Link
            href="/favorites"
            aria-current={pathname === '/favorites' ? 'page' : undefined}
          >
            Favourites
          </Link>
          <Link
            href="/checkouts"
            aria-current={pathname === '/checkouts' ? 'page' : undefined}
          >
            My check-outs
          </Link>
        </nav>

        {pinned.length > 0 ? (
          <>
            <p className="small muted" style={{ margin: '14px 0 2px' }}>
              Pinned
            </p>
            <nav>
              {pinned.map((c) => (
                <Link
                  key={c.id}
                  href={`/c/${c.id}`}
                  aria-current={pathname.startsWith(`/c/${c.id}`) ? 'page' : undefined}
                >
                  {c.name}
                </Link>
              ))}
            </nav>
          </>
        ) : null}

        {canSeeUsers || canSeeAudit || canSeeJobs ? (
          <>
            <p className="small muted" style={{ margin: '14px 0 2px' }}>
              Administration
            </p>
            <nav>
              {canSeeUsers ? <Link href="/admin/users">Users &amp; roles</Link> : null}
              {canSeeAudit ? <Link href="/admin/audit">Audit log</Link> : null}
              {canSeeJobs ? <Link href="/admin/jobs">Services</Link> : null}
            </nav>
          </>
        ) : null}

        <div className="spacer" />

        <div className="small muted" style={{ marginBottom: 8 }}>
          {me.data.user.firstName || me.data.user.lastName
            ? `${me.data.user.firstName} ${me.data.user.lastName}`.trim()
            : me.data.user.userName}
          {isAdmin ? <span className="pill" style={{ marginLeft: 6 }}>admin</span> : null}
        </div>
        <button onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </button>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
