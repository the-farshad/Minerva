'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useState } from 'react';
import { AiOverlay } from '@/components/ai-overlay';
import { ThemeBoot } from '@/components/theme-card';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
  }));
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster position="bottom-right" />
      <AiOverlay />
      <ThemeBoot />
    </QueryClientProvider>
  );
}
