// Shared types for the dashboard + its API routes.

export const REQUEST_STATUSES = [
  'new',
  'analyzing',
  'pending_review',
  'in_progress',
  'auto_handled',
  'resolved',
  'failed',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const DECISIONS = ['pending', 'auto_resolve', 'human_review', 'escalate'] as const;
export type Decision = (typeof DECISIONS)[number];

export type Actor = 'system' | 'agent' | 'n8n' | 'human';

export interface Customer {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  plan: string;
  lifetime_value: number;
  open_requests: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestActivity {
  id: string;
  request_id: string;
  type: string;
  actor: Actor;
  message: string;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
}

export interface SupportRequest {
  id: string;
  customer_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  source: 'email' | 'webhook' | 'dashboard';
  subject: string;
  body: string;
  sender_email: string;
  intent: string | null;
  category: string | null;
  priority: Priority;
  sentiment: Sentiment;
  summary: string | null;
  recommended_action: string | null;
  decision: Decision;
  confidence: number | null;
  raw_analysis: unknown;
  status: RequestStatus;
  assigned_to: string | null;
  resolution_note: string | null;
  reply_sent: boolean;
  last_error: string | null;
  analyzed_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer | null;
  request_activities?: RequestActivity[];
}

export interface DashboardMetrics {
  total: number;
  new: number;
  analyzing: number;
  pending_review: number;
  in_progress: number;
  auto_handled: number;
  resolved: number;
  failed: number;
  urgent_open: number;
  negative_sentiment_open: number;
  avg_minutes_to_resolve: number | null;
}

export interface ListQuery {
  status?: string;
  priority?: string;
  q?: string;
  limit?: number;
}
