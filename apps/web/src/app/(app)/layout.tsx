'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
  Bell,
  FolderOpen,
  Inbox,
  KeyRound,
  LockOpen,
  LogOut,
  Menu,
  ScrollText,
  Server,
  Star,
  Users,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/theme-toggle';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  /** A nav entry matches its own path and everything under it, except `/`. */
  exact?: boolean;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

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

  // Closing the drawer on navigation is the behaviour people expect from one.
  useEffect(() => setMobileOpen(false), [pathname]);

  if (me.isLoading) {
    return (
      <div className="flex min-h-dvh">
        <div className="bg-sidebar hidden w-64 shrink-0 border-r p-4 md:block">
          <Skeleton className="mb-6 h-7 w-24" />
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="mb-2 h-8 w-full" />
          ))}
        </div>
        <main className="flex-1 p-6">
          <Skeleton className="mb-4 h-8 w-48" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </main>
      </div>
    );
  }

  if (!me.data) {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <p className="text-muted-foreground text-sm">Redirecting to sign in…</p>
      </main>
    );
  }

  const user = me.data.user;
  const isAdmin = me.data.isAdministrator;
  const pinned = (cabinets.data ?? []).filter((c) => c.isPinned);

  const canSeeUsers = isAdmin || me.data.systemRights.includes('User_Administration');
  const canSeeAudit = isAdmin || me.data.systemRights.includes('View_Audit_Log');
  const canSeeJobs = isAdmin || me.data.systemRights.includes('Services_Logs');

  const main: NavItem[] = [
    { href: '/', label: 'Cabinets', icon: FolderOpen, exact: true },
    { href: '/inbox', label: 'My tasks', icon: Inbox, count: todos.data?.total },
    {
      href: '/notifications',
      label: 'Notifications',
      icon: Bell,
      count: notifications.data?.unread,
    },
    { href: '/favorites', label: 'Favourites', icon: Star },
    { href: '/checkouts', label: 'My check-outs', icon: LockOpen },
  ];

  const admin: NavItem[] = [
    ...(canSeeUsers ? [{ href: '/admin/users', label: 'Users & roles', icon: Users }] : []),
    ...(canSeeAudit ? [{ href: '/admin/audit', label: 'Audit log', icon: ScrollText }] : []),
    ...(canSeeJobs ? [{ href: '/admin/jobs', label: 'Services', icon: Server }] : []),
  ];

  const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  const displayName = fullName || user.userName;
  const initials =
    (fullName
      ? fullName
          .split(/\s+/)
          .map((part) => part[0])
          .join('')
      : user.userName.slice(0, 2)
    )
      .slice(0, 2)
      .toUpperCase();

  function isActive(item: NavItem) {
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  const nav = (
    <ScrollArea className="flex-1 -mx-1 px-1">
      <nav className="space-y-1" aria-label="Main">
        {main.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item)} />
        ))}
      </nav>

      {pinned.length > 0 ? (
        <>
          <SectionLabel>Pinned cabinets</SectionLabel>
          <nav className="space-y-1" aria-label="Pinned cabinets">
            {pinned.map((c) => (
              <NavLink
                key={c.id}
                item={{ href: `/c/${c.id}`, label: c.name, icon: FolderOpen }}
                active={pathname.startsWith(`/c/${c.id}`)}
              />
            ))}
          </nav>
        </>
      ) : null}

      {admin.length > 0 ? (
        <>
          <SectionLabel>Administration</SectionLabel>
          <nav className="space-y-1" aria-label="Administration">
            {admin.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item)} />
            ))}
          </nav>
        </>
      ) : null}
    </ScrollArea>
  );

  const brand = (
    <Link href="/" className="flex items-center gap-2 px-1 py-0.5">
      <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md text-[11px] font-bold tracking-tight">
        ECM
      </span>
      <span className="text-sm font-semibold tracking-tight">Content</span>
    </Link>
  );

  const account = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="hover:bg-sidebar-accent flex w-full cursor-pointer items-center gap-2 rounded-md p-2 text-left transition-colors">
          <Avatar className="size-7">
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{displayName}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {isAdmin ? 'Administrator' : user.userName}
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate font-medium">{displayName}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {user.email ?? user.userName}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account/password">
            <KeyRound />
            Change password
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="bg-sidebar text-sidebar-foreground sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-3 border-r p-3 md:flex">
        <div className="flex items-center justify-between">
          {brand}
          <ThemeToggle />
        </div>
        {nav}
        <Separator />
        {account}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="bg-background/80 sticky top-0 z-30 flex items-center gap-2 border-b px-3 py-2 backdrop-blur md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Open navigation">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 gap-3 p-3">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex items-center justify-between">
                {brand}
                <ThemeToggle />
              </div>
              {nav}
              <Separator />
              {account}
            </SheetContent>
          </Sheet>
          {brand}
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6">{children}</main>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground mt-5 mb-1.5 px-2 text-[11px] font-semibold tracking-wider uppercase">
      {children}
    </p>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count ? (
        <Badge variant={active ? 'default' : 'secondary'} className="tabular-nums">
          {item.count}
        </Badge>
      ) : null}
    </Link>
  );
}
