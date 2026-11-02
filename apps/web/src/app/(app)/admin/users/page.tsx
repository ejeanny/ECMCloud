'use client';

import { useState } from 'react';
import {
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { InlineError, TableSkeleton } from '@/components/states';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

const NEW_USER_FIELDS = [
  ['userName', 'User name', true],
  ['firstName', 'First name', false],
  ['lastName', 'Last name', false],
  ['email', 'Email', false],
] as const;

export default function UsersPage() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const [newUser, setNewUser] = useState({
    userName: '',
    firstName: '',
    lastName: '',
    email: '',
  });
  const [issued, setIssued] = useState<{ userName: string; password: string } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    userName: string;
  } | null>(null);

  const users = trpc.security.users.useQuery({
    skip: 0,
    take: 200,
    search: search || undefined,
  });
  const roles = trpc.security.roles.useQuery();
  const rights = trpc.security.rights.useQuery();

  const create = trpc.security.createUser.useMutation({
    onSuccess(result) {
      if (result.temporaryPassword) {
        setIssued({
          userName: result.user.userName,
          password: result.temporaryPassword,
        });
      }
      setNewUser({ userName: '', firstName: '', lastName: '', email: '' });
      void utils.security.users.invalidate();
    },
  });

  const reset = trpc.security.resetPassword.useMutation({
    onSuccess: () => void utils.security.users.invalidate(),
  });

  const update = trpc.security.updateUser.useMutation({
    onSuccess: () => void utils.security.users.invalidate(),
  });

  const remove = trpc.security.deleteUser.useMutation({
    onSuccess() {
      setPendingDelete(null);
      void utils.security.users.invalidate();
    },
  });

  const items = users.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Users & roles"
        description="Accounts, the roles they hold, and the privileges those roles carry."
      />

      {issued ? (
        <Alert variant="info" className="mb-4">
          <KeyRound />
          <AlertTitle>Temporary password for {issued.userName}</AlertTitle>
          <AlertDescription>
            <code className="bg-background rounded-md border px-2 py-1 font-mono text-sm select-all">
              {issued.password}
            </code>
            <p className="text-xs">
              Shown once. The user must change it at first sign-in.
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigator.clipboard?.writeText(issued.password)}
              >
                <Copy />
                Copy
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setIssued(null)}>
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {reset.data ? (
        <Alert variant="info" className="mb-4">
          <KeyRound />
          <AlertTitle>New temporary password</AlertTitle>
          <AlertDescription>
            <code className="bg-background rounded-md border px-2 py-1 font-mono text-sm select-all">
              {reset.data.temporaryPassword}
            </code>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-5 py-5">
        <CardHeader className="px-5">
          <CardTitle className="text-sm">New user</CardTitle>
        </CardHeader>
        <CardContent className="px-5">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate({
                userName: newUser.userName.trim(),
                firstName: newUser.firstName,
                lastName: newUser.lastName,
                email: newUser.email || undefined,
                isTempPassword: true,
                userType: 'local',
                status: 'active',
                roleIds: [],
              });
            }}
          >
            {NEW_USER_FIELDS.map(([key, label, required]) => (
              <div key={key} className="min-w-40 flex-1 space-y-2">
                <Label htmlFor={`n-${key}`} className="text-muted-foreground text-xs">
                  {label}
                </Label>
                <Input
                  id={`n-${key}`}
                  required={required}
                  type={key === 'email' ? 'email' : 'text'}
                  value={newUser[key]}
                  onChange={(e) => setNewUser((u) => ({ ...u, [key]: e.target.value }))}
                />
              </div>
            ))}
            <Button type="submit" disabled={create.isPending || !newUser.userName.trim()}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
              Create
            </Button>
          </form>
          {create.error ? (
            <InlineError className="mt-3" message={create.error.message} />
          ) : null}
        </CardContent>
      </Card>

      <div className="mb-3 max-w-xs">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            aria-label="Filter users"
            className="pl-9"
            value={search}
            placeholder="Filter by name or email"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="bg-card overflow-hidden rounded-xl border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-muted/50">
              <TableHead>User</TableHead>
              <TableHead className="w-56">Roles</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-44">Created</TableHead>
              <TableHead className="w-60" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isLoading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <TableSkeleton rows={6} columns={5} />
                </TableCell>
              </TableRow>
            ) : null}

            {items.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <span className="block truncate font-medium">{u.userName}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {`${u.firstName} ${u.lastName}`.trim() || '—'}
                    {u.email ? ` · ${u.email}` : ''}
                  </span>
                </TableCell>

                <TableCell>
                  {/* A popover of checkboxes rather than a native multi-select:
                      a <select multiple> loses every other selection the moment
                      someone clicks without holding Ctrl. */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="xs" className="w-full justify-start">
                        {u.roles.length === 0
                          ? 'No roles'
                          : u.roles.length === 1
                            ? u.roles[0]!.name
                            : `${u.roles.length} roles`}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-56 p-2">
                      <div className="max-h-56 space-y-1 overflow-auto">
                        {(roles.data ?? []).map((r) => {
                          const held = u.roles.some((x) => x.id === r.id);
                          return (
                            <label
                              key={r.id}
                              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
                            >
                              <Checkbox
                                checked={held}
                                disabled={update.isPending}
                                onCheckedChange={(checked) =>
                                  update.mutate({
                                    userId: u.id,
                                    roleIds:
                                      checked === true
                                        ? [...u.roles.map((x) => x.id), r.id]
                                        : u.roles
                                            .map((x) => x.id)
                                            .filter((id) => id !== r.id),
                                  })
                                }
                              />
                              <span className="min-w-0 truncate">{r.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                </TableCell>

                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <Badge
                      variant={
                        u.deleted
                          ? 'destructive'
                          : u.status === 'active'
                            ? 'success'
                            : 'secondary'
                      }
                    >
                      {u.deleted ? 'deleted' : u.status}
                    </Badge>
                    {u.isTempPassword ? (
                      <Badge variant="warning">temp password</Badge>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell className="text-muted-foreground text-xs">
                  {formatDate(u.created)}
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={reset.isPending}
                          onClick={() => reset.mutate({ userId: u.id })}
                        >
                          <KeyRound />
                          Reset
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Issue a new temporary password</TooltipContent>
                    </Tooltip>

                    <Button
                      variant="outline"
                      size="xs"
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          userId: u.id,
                          status: u.status === 'active' ? 'disabled' : 'active',
                        })
                      }
                    >
                      {u.status === 'active' ? <UserX /> : <UserCheck />}
                      {u.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>

                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete ${u.userName}`}
                      className="text-destructive hover:text-destructive"
                      disabled={Boolean(u.deleted)}
                      onClick={() =>
                        setPendingDelete({ id: u.id, userName: u.userName })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {remove.error ? (
        <InlineError className="mt-3" message={remove.error.message} />
      ) : null}

      <h2 className="mt-8 mb-3 text-base font-semibold tracking-tight">Roles</h2>
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-muted/50">
              <TableHead>Role</TableHead>
              <TableHead className="w-24">Users</TableHead>
              <TableHead className="w-32">System rights</TableHead>
              <TableHead className="w-40">Kind</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(roles.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <span className="block truncate font-medium">{r.name}</span>
                  {r.description ? (
                    <span className="text-muted-foreground block truncate text-xs">
                      {r.description}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {r.userCount}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs tabular-nums">
                  {r.systemRights.length}
                </TableCell>
                <TableCell>
                  {r.isAdministrator ? (
                    <Badge variant="default">
                      <ShieldCheck />
                      administrator
                    </Badge>
                  ) : r.builtin ? (
                    <Badge variant="secondary">built-in</Badge>
                  ) : (
                    <Badge variant="outline">custom</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {rights.data ? (
        <p className="text-muted-foreground mt-3 text-xs">
          {rights.data.all.length} privileges defined ({rights.data.system.length}{' '}
          system-level, {rights.data.cabinet.length} per cabinet).
        </p>
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.userName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The account is marked deleted and can no longer sign in. What they filed
              stays where it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => pendingDelete && remove.mutate({ userId: pendingDelete.id })}
            >
              <Trash2 />
              Delete user
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
