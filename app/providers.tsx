'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { messages } from '@/lib/messages';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <NextIntlClientProvider locale="zh" messages={messages}><QueryClientProvider client={client}>{children}</QueryClientProvider></NextIntlClientProvider>;
}
