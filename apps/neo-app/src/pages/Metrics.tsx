import { useCallback, useEffect, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract, type MetricsSummary } from '@neometaharness/contracts';
import { Badge, Banner, Button, Card, Heading, InfoTip, Skeleton, Text } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';
import './metrics.css';

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
    <section aria-label="Success metrics" className="settings-page metrics-page">
      <header className="metrics-header">
        <div><Heading level={1}>Success metrics</Heading><Text>Local Inbox, decision trace and skills-registry records. Figures reflect your workspace.</Text></div>
        <Button label="Refresh metrics" onClick={() => void refresh()} isLoading={loading} isDisabled={loading}>Refresh</Button>
      </header>
      {error && <Banner role="alert" status="error" title={error} />}
      {loading && !summary && <div className="metrics-grid" role="status" aria-label="Loading metrics">
        {[0, 1, 2].map(index => <Card key={index}><Skeleton height={24} width="60%" /><Skeleton height={56} /></Card>)}
      </div>}
      {summary && <div className="metrics-grid" aria-busy={loading}>
        <Card>
          <section aria-label="Attention" className="metric-content">
            <Heading level={2}>Attention</Heading>
            <Text>Tickets finished with at most one approval</Text>
            <Heading level={1} accessibilityLevel={3}>{percent(summary.attention.share)}</Heading>
            {summary.attention.share === null && <Badge label="Unavailable" variant="warning" />}
            <Text>{summary.finishedTickets ?? 'Unavailable'} finished Tickets, {summary.attention.withRecordedApproval ?? 'Unavailable'} with a recorded final approval.</Text>
            <div className="metric-proxy"><Badge label="Proxy" /><Text>Finished with no recorded approval</Text><Heading level={3}>{percent(summary.attention.observedWithoutFinalApprovalShare)}</Heading></div>
            {summary.attention.reason && <div className="metric-reason"><InfoTip content={summary.attention.reason} label="Attention methodology" /><Text>{summary.attention.reason}</Text></div>}
          </section>
        </Card>
        <Card>
          <section aria-label="Learning" className="metric-content">
            <Heading level={2}>Learning</Heading>
            <Text>Promoted skills per 20 completed Tickets</Text>
            <Heading level={1} accessibilityLevel={3}>{summary.learning.promotedPer20 ?? 'Unavailable'}</Heading>
            {summary.learning.promotedPer20 === null && <Badge label="Unavailable" variant="warning" />}
            <Text>Promoted-skill rollback rate</Text>
            <Heading level={3}>{percent(summary.learning.rollbackRate)}</Heading>
            <Text>{summary.completedTickets ?? 'Unavailable'} completed Tickets. Qualified current skills: {summary.learning.qualifiedSkills ?? 'Unavailable'}.</Text>
            {summary.learning.reason && <div className="metric-reason"><InfoTip content={summary.learning.reason} label="Learning methodology" /><Text>{summary.learning.reason}</Text></div>}
          </section>
        </Card>
        <Card>
          <section aria-label="Time to first value" className="metric-content">
            <Heading level={2}>Time to first value</Heading>
            <Text>Install to first channel answer</Text>
            <Heading level={1} accessibilityLevel={3}>{summary.firstValue.minutes === null ? 'Unavailable' : summary.firstValue.minutes.toFixed(1) + ' minutes'}</Heading>
            {summary.firstValue.minutes === null && <Badge label="Unavailable" variant="warning" />}
            <div className="metric-proxy"><Badge label="Proxy" /><Text>Onboarding to first channel delivery</Text><Heading level={3}>{summary.firstValue.onboardingToFirstReplyMinutes === null ? 'Unavailable' : summary.firstValue.onboardingToFirstReplyMinutes.toFixed(1) + ' minutes'}</Heading></div>
            {summary.firstValue.reason && <div className="metric-reason"><InfoTip content={summary.firstValue.reason} label="Time to first value methodology" /><Text>{summary.firstValue.reason}</Text></div>}
          </section>
        </Card>
      </div>}
    </section>
  );
}
