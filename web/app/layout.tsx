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
  description: 'Inspect generated chess agents, harness evidence, and deterministic match replays.',
  openGraph: {
    title: 'AgentBattler Bench · Harness × model leaderboard',
    description: 'Compare 12 harness and model combinations across 11,340 recorded games.',
    type: 'website',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: 'AgentBattler harness and model leaderboard with 12 combinations' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentBattler Bench · Harness × model leaderboard',
    description: 'Compare 12 harness and model combinations across 11,340 recorded games.',
    images: ['/og.png'],
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
