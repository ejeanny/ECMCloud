'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { InlineError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <div className="max-w-md">
      <PageHeader
        title="Change password"
        description="Changing your password signs out your other sessions."
      />

      <Card>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!mismatch) change.mutate({ currentPassword, newPassword });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new">New password</Label>
              <Input
                id="new"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
                value={newPassword}
                onChange={(e) => setNew(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">At least 10 characters.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={mismatch || undefined}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            {mismatch ? <InlineError message="The two passwords differ." /> : null}
            {change.error ? <InlineError message={change.error.message} /> : null}

            <Button type="submit" disabled={change.isPending || mismatch}>
              {change.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
              {change.isPending ? 'Saving…' : 'Change password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
