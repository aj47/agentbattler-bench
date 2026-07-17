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
    title: 'AgentBattler Bench · DotAgents placement',
    description: 'DotAgents scores 50.9% across 540 targeted same-model placement games.',
    type: 'website',
    images: [{ url: '/og.png', width: 1729, height: 910, alt: 'AgentBattler DotAgents placement: 50.9% across 540 same-model games' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'AgentBattler Bench · DotAgents placement',
    description: 'DotAgents scores 50.9% across 540 targeted same-model placement games.',
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
