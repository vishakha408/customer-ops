import type { Decision, Priority, RequestStatus, Sentiment } from '@/lib/types';
import {
  DECISION_LABELS,
  PRIORITY_LABELS,
  SENTIMENT_LABELS,
  STATUS_LABELS,
} from '@/lib/format';

const STATUS_TONE: Record<RequestStatus, string> = {
  new: 'tone-blue',
  analyzing: 'tone-purple',
  pending_review: 'tone-amber',
  in_progress: 'tone-blue',
  auto_handled: 'tone-accent',
  resolved: 'tone-green',
  failed: 'tone-red',
};

const PRIORITY_TONE: Record<Priority, string> = {
  low: 'tone-grey',
  medium: 'tone-blue',
  high: 'tone-amber',
  urgent: 'tone-red',
};

const SENTIMENT_TONE: Record<Sentiment, string> = {
  positive: 'tone-green',
  neutral: 'tone-grey',
  negative: 'tone-amber',
  angry: 'tone-red',
};

const DECISION_TONE: Record<Decision, string> = {
  pending: 'tone-grey',
  auto_resolve: 'tone-accent',
  human_review: 'tone-amber',
  escalate: 'tone-red',
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{STATUS_LABELS[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge ${PRIORITY_TONE[priority]}`}>{PRIORITY_LABELS[priority]}</span>;
}

export function SentimentBadge({ sentiment }: { sentiment: Sentiment }) {
  return (
    <span className={`badge ${SENTIMENT_TONE[sentiment]}`}>{SENTIMENT_LABELS[sentiment]}</span>
  );
}

export function DecisionBadge({ decision }: { decision: Decision }) {
  return <span className={`badge ${DECISION_TONE[decision]}`}>{DECISION_LABELS[decision]}</span>;
}
