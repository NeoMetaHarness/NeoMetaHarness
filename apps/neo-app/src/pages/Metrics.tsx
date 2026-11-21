import { useCallback, useEffect, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type MetricsSummary } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';

type Client = ContractRouterClient<typeof neoContract>;
const client = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

const percent = (value: number | null) => value === null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;

export default function Metrics() {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setSummary(await client.x.metrics.summary()); }
    catch (reason) { setSummary(null); setError(`Metrics unavailable. ${String(reason)}`); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <section aria-label="Success metrics" className="settings-page">
      <h1>Success metrics</h1>
      <p>Local Inbox, decision trace and skills-registry records. Figures reflect your workspace.</p>
      <Button label="Refresh metrics" onClick={() => void refresh()} disabled={loading}>Refresh</Button>
      {loading && <p role="status">Loading metrics…</p>}
      {error && <p role="alert">{error}</p>}
      {summary && <>
        <section aria-label="Attention">
          <h2>Attention</h2>
          <p>Tickets finished with at most one approval — <strong>{percent(summary.attention.share)}</strong></p>
          <p>{summary.finishedTickets} finished Tickets, {summary.attention.withRecordedApproval} with a recorded final approval.</p>
          <p>Observed without a final approval — {percent(summary.attention.observedWithoutFinalApprovalShare)}.</p>
          <p>{summary.attention.reason}</p>
        </section>
        <section aria-label="Learning">
          <h2>Learning</h2>
          <p>Promoted skills per 20 completed Tickets — <strong>{summary.learning.promotedPer20 ?? 'Unavailable'}</strong></p>
          <p>Promoted-skill rollback rate — <strong>{percent(summary.learning.rollbackRate)}</strong></p>
          <p>{summary.completedTickets} completed Tickets. Qualified current skills — {summary.learning.qualifiedSkills ?? 'Unavailable'}.</p>
          <p>{summary.learning.reason}</p>
        </section>
        <section aria-label="Time to first value">
          <h2>Time to first value</h2>
          <p>Install to first channel answer — <strong>{summary.firstValue.minutes === null ? 'Unavailable' : `${summary.firstValue.minutes.toFixed(1)} minutes`}</strong></p>
          <p>Onboarding to first recorded channel delivery — {summary.firstValue.onboardingToFirstReplyMinutes === null
            ? 'Unavailable' : `${summary.firstValue.onboardingToFirstReplyMinutes.toFixed(1)} minutes`}.</p>
          <p>{summary.firstValue.reason}</p>
        </section>
      </>}
    </section>
  );
}
