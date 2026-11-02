'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');

  const change = trpc.session.changePassword.useMutation({
    onSuccess: () => router.replace('/'),
  });

  const mismatch = confirm.length > 0 && confirm !== newPassword;

  return (
    <div style={{ maxWidth: 420 }}>
      <h2>Change password</h2>
      <p className="muted small">
        Changing your password signs out your other sessions.
      </p>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) change.mutate({ currentPassword, newPassword });
        }}
      >
        <div className="field">
          <label htmlFor="current">Current password</label>
          <input
            id="current"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="new">New password (at least 10 characters)</label>
          <input
            id="new"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="confirm">Confirm new password</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {mismatch ? <p className="error small">The two passwords differ.</p> : null}
        {change.error ? <p className="error small">{change.error.message}</p> : null}

        <button className="primary" type="submit" disabled={change.isPending || mismatch}>
          {change.isPending ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}
