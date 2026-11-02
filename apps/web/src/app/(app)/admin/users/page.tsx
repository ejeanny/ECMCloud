'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/format';
import { trpc } from '@/lib/trpc';

export default function UsersPage() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const [newUser, setNewUser] = useState({ userName: '', firstName: '', lastName: '', email: '' });
  const [issued, setIssued] = useState<{ userName: string; password: string } | null>(null);

  const users = trpc.security.users.useQuery({ skip: 0, take: 200, search: search || undefined });
  const roles = trpc.security.roles.useQuery();
  const rights = trpc.security.rights.useQuery();

  const create = trpc.security.createUser.useMutation({
    onSuccess(result) {
      if (result.temporaryPassword) {
        setIssued({ userName: result.user.userName, password: result.temporaryPassword });
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
    onSuccess: () => void utils.security.users.invalidate(),
  });

  return (
    <>
      <h2>Users &amp; roles</h2>

      {issued ? (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--accent)' }}>
          <strong>Temporary password for {issued.userName}</strong>
          <p className="mono" style={{ userSelect: 'all' }}>
            {issued.password}
          </p>
          <p className="small muted">
            Shown once. The user must change it at first sign-in.
          </p>
          <button onClick={() => setIssued(null)}>Dismiss</button>
        </div>
      ) : null}

      <form
        className="card"
        style={{ marginBottom: 14 }}
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
        <strong>New user</strong>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {(
            [
              ['userName', 'User name', true],
              ['firstName', 'First name', false],
              ['lastName', 'Last name', false],
              ['email', 'Email', false],
            ] as const
          ).map(([key, label, required]) => (
            <div className="field" key={key} style={{ flex: '1 1 160px', marginBottom: 0 }}>
              <label htmlFor={`n-${key}`}>{label}</label>
              <input
                id={`n-${key}`}
                required={required}
                type={key === 'email' ? 'email' : 'text'}
                value={newUser[key]}
                onChange={(e) => setNewUser((u) => ({ ...u, [key]: e.target.value }))}
              />
            </div>
          ))}
          <button className="primary" type="submit" disabled={create.isPending}>
            Create
          </button>
        </div>
        {create.error ? (
          <p className="error small" style={{ marginBottom: 0 }}>
            {create.error.message}
          </p>
        ) : null}
      </form>

      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="search">Filter</label>
        <input
          id="search"
          value={search}
          placeholder="name or email"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {reset.data ? (
        <div className="card" style={{ marginBottom: 14 }}>
          <strong>New temporary password</strong>
          <p className="mono" style={{ userSelect: 'all' }}>
            {reset.data.temporaryPassword}
          </p>
        </div>
      ) : null}

      <table>
        <thead>
          <tr>
            <th>User</th>
            <th style={{ width: 200 }}>Roles</th>
            <th style={{ width: 100 }}>Status</th>
            <th style={{ width: 170 }}>Created</th>
            <th style={{ width: 220 }} />
          </tr>
        </thead>
        <tbody>
          {(users.data?.items ?? []).map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.userName}</strong>
                <div className="small muted">
                  {`${u.firstName} ${u.lastName}`.trim() || '—'}
                  {u.email ? ` · ${u.email}` : ''}
                </div>
              </td>
              <td className="small">
                <select
                  multiple
                  size={Math.min(4, roles.data?.length ?? 1)}
                  value={u.roles.map((r) => r.id)}
                  onChange={(e) =>
                    update.mutate({
                      userId: u.id,
                      roleIds: Array.from(e.target.selectedOptions).map((o) => o.value),
                    })
                  }
                >
                  {(roles.data ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="small muted">
                {u.deleted ? 'deleted' : u.status}
                {u.isTempPassword ? (
                  <div>
                    <span className="pill">temp password</span>
                  </div>
                ) : null}
              </td>
              <td className="small muted">{formatDate(u.created)}</td>
              <td>
                <div className="row small wrap">
                  <button onClick={() => reset.mutate({ userId: u.id })}>
                    Reset password
                  </button>
                  <button
                    onClick={() =>
                      update.mutate({
                        userId: u.id,
                        status: u.status === 'active' ? 'disabled' : 'active',
                      })
                    }
                  >
                    {u.status === 'active' ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="danger"
                    disabled={Boolean(u.deleted)}
                    onClick={() => {
                      if (window.confirm(`Delete ${u.userName}?`)) {
                        remove.mutate({ userId: u.id });
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>Roles</h3>
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th style={{ width: 100 }}>Users</th>
            <th style={{ width: 120 }}>System rights</th>
            <th>Kind</th>
          </tr>
        </thead>
        <tbody>
          {(roles.data ?? []).map((r) => (
            <tr key={r.id}>
              <td>
                {r.name}
                {r.description ? <div className="small muted">{r.description}</div> : null}
              </td>
              <td className="small muted">{r.userCount}</td>
              <td className="small muted">{r.systemRights.length}</td>
              <td className="small muted">
                {r.isAdministrator ? 'administrator' : r.builtin ? 'built-in' : 'custom'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="small muted" style={{ marginTop: 10 }}>
        {rights.data
          ? `${rights.data.all.length} privileges defined (${rights.data.system.length} system-level, ${rights.data.cabinet.length} per cabinet).`
          : null}
      </p>
    </>
  );
}
