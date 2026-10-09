import type { DashboardMetrics } from '@/lib/types';

interface Card {
  key: string;
  label: string;
  value: number | null | undefined;
  hint: string;
  tone: string;
  suffix?: string;
}

export default function MetricCards({
  metrics,
  loading,
}: {
  metrics: DashboardMetrics | null;
  loading: boolean;
}) {
  const cards: Card[] = [
    {
      key: 'pending_review',
      label: 'Needs review',
      value: metrics?.pending_review,
      hint: 'Waiting for a human',
      tone: 'is-amber',
    },
    {
      key: 'in_progress',
      label: 'In progress',
      value: metrics?.in_progress,
      hint: 'Owned by an operator',
      tone: 'is-blue',
    },
    {
      key: 'auto_handled',
      label: 'Auto-handled',
      value: metrics?.auto_handled,
      hint: 'Replied to by the AI agent',
      tone: 'is-accent',
    },
    {
      key: 'resolved',
      label: 'Resolved',
      value: metrics?.resolved,
      hint: 'Closed by the team',
      tone: 'is-green',
    },
    {
      key: 'urgent_open',
      label: 'Urgent open',
      value: metrics?.urgent_open,
      hint: 'Urgent and not closed yet',
      tone: 'is-red',
    },
    {
      key: 'failed',
      label: 'Failed',
      value: metrics?.failed,
      hint: 'Workflow errors to inspect',
      tone: 'is-red',
    },
    {
      key: 'avg_minutes_to_resolve',
      label: 'Avg. resolution',
      value: metrics?.avg_minutes_to_resolve,
      hint: 'Created → resolved, minutes',
      tone: '',
      suffix: 'm',
    },
  ];

  return (
    <div className="metrics">
      {cards.map((card) => (
        <div className={`metric-card ${card.tone}`} key={card.key}>
          <div className="metric-label">{card.label}</div>
          {loading && metrics === null ? (
            <div className="sk sk-value" />
          ) : (
            <div className="metric-value">
              {card.value ?? '—'}
              {card.value == null ? '' : card.suffix ?? ''}
            </div>
          )}
          <div className="metric-hint">{card.hint}</div>
        </div>
      ))}
    </div>
  );
}
