import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Header } from '../components/Header';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://agentbattler.com'),
  title: {
    default: 'AgentBattler Bench',
    template: '%s · AgentBattler Bench',
  },
  description: 'Battle complete AI agents—not models in isolation—across open, inspectable terminal and chess challenges.',
  openGraph: {
    title: 'AgentBattler · Battle the whole agent',
    description: 'Compare model-and-harness combinations across open terminal and chess challenges, with results and traces you can inspect.',
    type: 'website',
    images: [{ url: '/og-v2.png', width: 1731, height: 909, alt: 'AgentBattler compares complete coding agents across Mini Ledger and Chess investigations' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentBattler · Battle the whole agent',
    description: 'Compare model-and-harness combinations across open terminal and chess challenges, with results and traces you can inspect.',
    images: ['/og-v2.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Header />
        {children}
        <footer className="site-footer">
          <span>AgentBattler Bench</span>
          <span>inspect the artifact · replay the result</span>
        </footer>
      </body>
    </html>
  );
}
