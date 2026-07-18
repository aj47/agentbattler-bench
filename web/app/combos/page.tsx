import type { Metadata } from 'next';

import { ComboExplorer } from '../../components/ComboExplorer';
import { buildComboRows } from '../../lib/combo-data';
import { siteData } from '../../lib/data';

export const metadata: Metadata = {
  title: 'Combo telemetry',
  description: 'Compare published generation telemetry for every AgentBattler harness and model combination.',
};

export default function CombosPage() {
  return <ComboExplorer rows={buildComboRows(siteData)} />;
}
