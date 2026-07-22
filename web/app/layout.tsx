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
  description: 'See how four coding harnesses changed long-horizon performance across 60 trace-published terminal runs.',
  openGraph: {
    title: 'AgentBattler Bench · Long-horizon harness study',
    description: 'Four harnesses, three models, 60 long-running terminal tasks, and every semantic trace.',
    type: 'website',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: 'AgentBattler harness and model leaderboard with 12 combinations' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentBattler Bench · Long-horizon harness study',
    description: 'Four harnesses, three models, 60 long-running terminal tasks, and every semantic trace.',
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
