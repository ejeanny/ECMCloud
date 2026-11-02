'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { trpc } from './trpc';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Document lists go stale as soon as someone else uploads, so
            // refetch on focus but not on every mount.
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: (count, error) => {
              const code = (error as { data?: { code?: string } }).data?.code;
              if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return false;
              return count < 2;
            },
          },
        },
      }),
  );

  const [client] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: '/trpc',
          // A batched query travels in the URL; the explorer fires eight at
          // once. Capping the batch keeps requests clear of proxy URL limits
          // (the server also raises Fastify's maxParamLength to match).
          maxURLLength: 2000,
          // The session is a first-party cookie, as Dokmee's was.
          fetch: (url, options) => fetch(url, { ...options, credentials: 'include' }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* `class` rather than the media query, so the toggle in the sidebar
            can override what the operating system asks for. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
