'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CircleAlert, Loader2, LockKeyhole } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ThemeToggle } from '@/components/theme-toggle';
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
    <main className="relative grid min-h-dvh place-items-center p-4">
      {/* A quiet wash behind the card, so signing in does not look like a 404. */}
      <div
        aria-hidden
        className="from-primary/8 pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent"
      />

      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <Card className="relative w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="bg-primary text-primary-foreground mx-auto mb-2 grid size-10 place-items-center rounded-xl">
            <LockKeyhole className="size-5" />
          </div>
          <CardTitle className="text-lg">Sign in to ECM</CardTitle>
          <CardDescription>
            Cabinets, index fields, versions and workflow.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              login.mutate({ userName, password });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="userName">User name</Label>
              <Input
                id="userName"
                name="userName"
                autoComplete="username"
                autoFocus
                required
                aria-invalid={login.error ? true : undefined}
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={login.error ? true : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {login.error ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{login.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" className="w-full" disabled={login.isPending}>
              {login.isPending ? <Loader2 className="animate-spin" /> : null}
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
