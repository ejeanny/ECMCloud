'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export default function LoginPage() {
  const router = useRouter();
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');

  const login = trpc.session.login.useMutation({
    onSuccess(result) {
      router.replace(result.mustChangePassword ? '/account/password' : '/');
    },
  });

  return (
    <main className="login">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ userName, password });
        }}
      >
        <h1 style={{ marginTop: 0 }}>Sign in</h1>

        <div className="field">
          <label htmlFor="userName">User name</label>
          <input
            id="userName"
            name="userName"
            autoComplete="username"
            autoFocus
            required
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {login.error ? (
          <p className="error small" role="alert">
            {login.error.message}
          </p>
        ) : null}

        <button className="primary" type="submit" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
