'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useEffect, useState } from 'react';
import { AiOverlay } from '@/components/ai-overlay';
import { ThemeBoot } from '@/components/theme-card';
import { ConfirmHost } from '@/components/confirm';
import { PromptHost } from '@/components/prompt';
import { pullServerPrefs } from '@/lib/prefs';

function PrefsBoot() {
  useEffect(() => { void pullServerPrefs(); }, []);
  return null;
}

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
      <PrefsBoot />
      <ConfirmHost />
      <PromptHost />
    </QueryClientProvider>
  );
}
