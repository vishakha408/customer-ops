import type { Decision, Priority, RequestStatus, Sentiment } from './types';

export const STATUS_LABELS: Record<RequestStatus, string> = {
  new: 'New',
  analyzing: 'Analyzing',
  pending_review: 'Pending review',
  in_progress: 'In progress',
  auto_handled: 'Auto-handled',
  resolved: 'Resolved',
  failed: 'Failed',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const SENTIMENT_LABELS: Record<Sentiment, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
  angry: 'Angry',
};

export const DECISION_LABELS: Record<Decision, string> = {
  pending: 'Pending',
  auto_resolve: 'Auto-resolve',
  human_review: 'Human review',
  escalate: 'Escalate',
};

/** Compact relative time such as "4m ago" / "2h ago" / "3d ago". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const abs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? 'ago' : 'from now';

  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ${suffix}`;
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}
