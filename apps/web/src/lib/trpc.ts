'use client';

import type { AppRouter } from '@ecm/api/router';
import { createTRPCReact } from '@trpc/react-query';

export const trpc = createTRPCReact<AppRouter>();
