import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Header } from '../components/Header';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AgentBattler Bench',
    template: '%s · AgentBattler Bench',
  },
  description: 'Inspect generated chess agents, harness evidence, and deterministic match replays.',
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
