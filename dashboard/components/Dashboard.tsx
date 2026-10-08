'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardMetrics, RequestStatus, SupportRequest } from '@/lib/types';
import { STATUS_LABELS } from '@/lib/format';
import MetricCards from './MetricCards';
import RequestTable from './RequestTable';
import RequestDetail from './RequestDetail';

const STATUS_FILTERS: Array<RequestStatus | 'all'> = [
  'all',
  'pending_review',
  'in_progress',
  'new',
  'analyzing',
  'auto_handled',
  'resolved',
  'failed',
];

const PRIORITY_OPTIONS = ['all', 'urgent', 'high', 'medium', 'low'] as const;

const EMPTY_FORM = { email: '', name: '', subject: '', body: '' };

export default function Dashboard({ initialRequestId }: { initialRequestId?: string }) {
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const [statusFilter, setStatusFilter] = useState<RequestStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<(typeof PRIORITY_OPTIONS)[number]>('all');
  const [query, setQuery] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(initialRequestId ?? null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [requestsRes, metricsRes] = await Promise.all([
        fetch('/api/requests?limit=200', { cache: 'no-store' }),
        fetch('/api/metrics', { cache: 'no-store' }),
      ]);

      const requestsData = await requestsRes.json();
      if (!requestsRes.ok) throw new Error(requestsData.error ?? `HTTP ${requestsRes.status}`);
      setRequests(requestsData.requests ?? []);

      if (metricsRes.ok) {
        const metricsData = await metricsRes.json();
        setMetrics(metricsData.metrics);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
      setUpdatedAt(new Date());
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll for updates so new emails and n8n status changes appear on their own.
  useEffect(() => {
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // Clear transient notices.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: requests.length };
    for (const request of requests) {
      map[request.status] = (map[request.status] ?? 0) + 1;
    }
    return map;
  }, [requests]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((request) => {
      if (statusFilter !== 'all' && request.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && request.priority !== priorityFilter) return false;
      if (!needle) return true;
      return [
        request.subject,
        request.sender_email,
        request.summary ?? '',
        request.intent ?? '',
        request.customer?.full_name ?? '',
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [requests, statusFilter, priorityFilter, query]);

  const submitForm = async () => {
    setFormBusy(true);
    setFormError(null);
    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setShowForm(false);
      setForm(EMPTY_FORM);
      setNotice(data.message ?? 'Request created');
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create the request');
    } finally {
      setFormBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">CO</div>
          <div>
            <div className="brand-title">Customer Operations</div>
            <div className="brand-subtitle">AI request desk · n8n + Supabase + Claude</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className="live">
            <span className="live-dot" />
            Live · refreshing every 15s
          </span>
          <span>
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : 'Loading…'}
          </span>
          <button className="btn btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>

      <main className="content">
        <div className="page-heading">
          <div>
            <h1>Request queue</h1>
            <p>
              {requests.length} request{requests.length === 1 ? '' : 's'} total
              {filtered.length !== requests.length ? ` · ${filtered.length} shown` : ''}
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            + New request
          </button>
        </div>

        {error && (
          <div className="banner banner-error">
            Could not load data: {error}. Check that Supabase is configured in
            dashboard/.env.local.
          </div>
        )}
        {notice && <div className="banner banner-info">{notice}</div>}

        <MetricCards metrics={metrics} loading={loading} />

        <section className="panel">
          <div className="toolbar">
            <div className="chips">
              {STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  className={`chip ${statusFilter === status ? 'is-active' : ''}`}
                  onClick={() => setStatusFilter(status)}
                >
                  {status === 'all' ? 'All' : STATUS_LABELS[status]}
                  <span className="count">{counts[status] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="toolbar-controls">
              <select
                className="select"
                value={priorityFilter}
                onChange={(event) => setPriorityFilter(event.target.value as typeof priorityFilter)}
                aria-label="Filter by priority"
              >
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority === 'all' ? 'All priorities' : `Priority: ${priority}`}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="Search subject, sender, summary…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search requests"
              />
            </div>
          </div>

          <RequestTable
            requests={filtered}
            loading={loading}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </section>

        <div className="footer-note">
          Intake: Gmail trigger or POST /api/webhook/intake · Analysis: Claude via n8n · Data:
          Supabase
        </div>
      </main>

      {selectedId && (
        <RequestDetail
          requestId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      )}

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>New customer request</h2>
            <p className="hint">
              Stores the request in Supabase and hands it to the n8n pipeline for AI analysis -
              the same path used by the webhook entry point.
            </p>
            {formError && <div className="banner banner-error">{formError}</div>}
            <div className="form-group">
              <label htmlFor="intake-email">Customer email</label>
              <input
                id="intake-email"
                type="email"
                placeholder="customer@example.com"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="intake-name">Customer name (optional)</label>
              <input
                id="intake-name"
                placeholder="Jane Doe"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="intake-subject">Subject</label>
              <input
                id="intake-subject"
                placeholder="Cannot access my account"
                value={form.subject}
                onChange={(event) => setForm({ ...form, subject: event.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="intake-body">Message</label>
              <textarea
                id="intake-body"
                placeholder="Paste the customer's message…"
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowForm(false)} disabled={formBusy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitForm()}
                disabled={formBusy || !form.email.trim() || !form.body.trim()}
              >
                {formBusy ? 'Submitting…' : 'Submit request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
