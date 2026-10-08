'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupportRequest } from '@/lib/types';
import { formatDateTime, formatMoney, relativeTime, shortId } from '@/lib/format';
import { DecisionBadge, PriorityBadge, SentimentBadge, StatusBadge } from './Badges';

function getFirstName(fullName: string | null, email: string): string {
  if (fullName) {
    const [first] = fullName.trim().split(/\s+/);
    if (first) return first;
  }
  if (email && email.includes('@')) return email.split('@')[0];
  return 'there';
}

export default function RequestDetail({
  requestId,
  onClose,
  onChanged,
}: {
  requestId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [request, setRequest] = useState<SupportRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [replySubject, setReplySubject] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
  const [sendReply, setSendReply] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/requests/${requestId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRequest(data.request);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the request');
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    setLoading(true);
    setNote('');
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = async (fields: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const applyNote = (fields: Record<string, unknown>) =>
    update(note.trim() ? { ...fields, resolution_note: note.trim() } : fields);

  useEffect(() => {
    if (!showResolveModal || !request) return;
    const firstName = getFirstName(request.customer?.full_name ?? null, request.sender_email);
    const baseNote = note.trim() || request.resolution_note?.trim() || 'Your request has been resolved.';
    const draft = `Hi ${firstName},

${baseNote}

Thanks,
Support Team`;
    const subject = request.reply_subject?.trim() || `Re: ${request.subject}` || `Re: ${request.sender_email}`;
    setReplySubject(subject);
    setReplyDraft(request.reply_draft?.trim() || draft);
    setSendReply(true);
  }, [showResolveModal, request, note]);

  const resolveWithReply = async () => {
    if (!request) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        status: 'resolved',
        reply_subject: replySubject.trim() || null,
        reply_draft: replyDraft.trim() || null,
        send_reply: sendReply && replyDraft.trim().length > 0,
      };
      const resolutionNote = note.trim();
      if (resolutionNote) payload.resolution_note = resolutionNote;
      await update(payload);
      setShowResolveModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed');
    } finally {
      setBusy(false);
    }
  };

  const resolveWithoutReply = async () => {
    if (!request) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { status: 'resolved', send_reply: false };
      const resolutionNote = note.trim();
      if (resolutionNote) payload.resolution_note = resolutionNote;
      await update(payload);
      setShowResolveModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Request details">
        <header className="drawer-header">
          <div>
            <h2>{request ? request.subject : 'Loading request…'}</h2>
            {request && (
              <div className="drawer-meta">
                <StatusBadge status={request.status} />
                <PriorityBadge priority={request.priority} />
                <SentimentBadge sentiment={request.sentiment} />
                <DecisionBadge decision={request.decision} />
                <span className="tag mono">#{shortId(request.id)}</span>
              </div>
            )}
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="drawer-body">
          {error && <div className="banner banner-error">{error}</div>}

          {loading && !request && (
            <>
              <div className="sk" style={{ width: '70%', height: 18 }} />
              <div className="sk" style={{ width: '100%', height: 90 }} />
              <div className="sk" style={{ width: '100%', height: 130 }} />
            </>
          )}

          {request && (
            <>
              {request.status === 'pending_review' && (
                <div className="banner banner-warning">
                  Waiting for a human. Take ownership below to start working on it.
                </div>
              )}
              {request.status === 'failed' && (
                <div className="banner banner-error">
                  The workflow failed: {request.last_error || 'unknown error'}
                </div>
              )}
              {request.status === 'auto_handled' && (
                <div className="banner banner-info">
                  The AI agent replied to the customer and closed this request automatically
                  {request.reply_sent ? ' (email delivered).' : ' (no delivery confirmation).'}
                </div>
              )}

              <section className="section">
                <h3 className="section-title">Customer</h3>
                {request.customer ? (
                  <dl className="kv">
                    <dt>Name</dt>
                    <dd>{request.customer.full_name ?? '—'}</dd>
                    <dt>Email</dt>
                    <dd>{request.customer.email}</dd>
                    <dt>Plan</dt>
                    <dd>{request.customer.plan}</dd>
                    <dt>Lifetime value</dt>
                    <dd>{formatMoney(request.customer.lifetime_value)}</dd>
                    <dt>Open requests</dt>
                    <dd>{request.customer.open_requests}</dd>
                    <dt>Phone</dt>
                    <dd>{request.customer.phone ?? '—'}</dd>
                  </dl>
                ) : (
                  <dl className="kv">
                    <dt>Sender</dt>
                    <dd>{request.sender_email}</dd>
                    <dt>Customer record</dt>
                    <dd>Unknown - no matching customer found at intake</dd>
                  </dl>
                )}
              </section>

              <section className="section">
                <h3 className="section-title">AI analysis</h3>
                {request.intent ? (
                  <>
                    <p className="summary-text">{request.summary ?? 'No summary recorded.'}</p>
                    <dl className="kv">
                      <dt>Intent</dt>
                      <dd>{request.intent}</dd>
                      <dt>Category</dt>
                      <dd>{request.category ?? '—'}</dd>
                      <dt>Recommended action</dt>
                      <dd>{request.recommended_action ?? '—'}</dd>
                      <dt>Decision</dt>
                      <dd>{request.decision.replace('_', ' ')}</dd>
                      <dt>Analyzed</dt>
                      <dd>{formatDateTime(request.analyzed_at)}</dd>
                    </dl>
                    <div className="confidence">
                      <div className="confidence-head">
                        <span>Model confidence</span>
                        <span>{Math.round((request.confidence ?? 0) * 100)}%</span>
                      </div>
                      <div className="confidence-bar">
                        <span
                          style={{
                            width: `${Math.round((request.confidence ?? 0) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                    Not analyzed yet - the request is still queued for the AI pipeline.
                  </div>
                )}
              </section>

              <section className="section">
                <h3 className="section-title">Original message</h3>
                <dl className="kv" style={{ marginBottom: 10 }}>
                  <dt>From</dt>
                  <dd>
                    {request.sender_email} · {relativeTime(request.created_at)}
                  </dd>
                  <dt>Source</dt>
                  <dd>{request.source}</dd>
                </dl>
                <pre className="message-body">{request.body}</pre>
              </section>

              <section className="section">
                <h3 className="section-title">Human intervention</h3>
                <textarea
                  className="note"
                  placeholder="Resolution note (optional) - stored on the request and visible in the timeline"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="actions">
                  {['new', 'analyzing', 'pending_review', 'failed'].includes(request.status) && (
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => applyNote({ status: 'in_progress' })}
                    >
                      Take ownership
                    </button>
                  )}
                  {request.status === 'in_progress' && (
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => setShowResolveModal(true)}
                    >
                      Mark resolved
                    </button>
                  )}
                  {['resolved', 'auto_handled'].includes(request.status) && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => applyNote({ status: 'in_progress' })}
                    >
                      Reopen request
                    </button>
                  )}
                  <button className="btn" disabled={busy} onClick={() => void load()}>
                    Refresh
                  </button>
                </div>
                {request.resolution_note && (
                  <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 0 }}>
                    Last note: {request.resolution_note}
                  </p>
                )}
              </section>

              <section className="section">
                <h3 className="section-title">Activity timeline</h3>
                {(request.request_activities ?? []).length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>No activity recorded.</div>
                ) : (
                  <ul className="timeline">
                    {(request.request_activities ?? []).map((activity) => (
                      <li key={activity.id}>
                        <span className={`dot actor-${activity.actor}`} />
                        <div className="entry">
                          <div>{activity.message}</div>
                          <div className="entry-meta">
                            {formatDateTime(activity.created_at)} · {activity.actor} · {activity.type}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </aside>

      {showResolveModal && request && (
        <>
          <div className="overlay" onClick={() => setShowResolveModal(false)} />
          <aside className="drawer drawer-sm" role="dialog" aria-modal="true" aria-label="Review reply before resolving">
            <header className="drawer-header">
              <div>
                <h2>Resolve request</h2>
                <div className="drawer-meta">
                  <span className="tag mono">#{shortId(request.id)}</span>
                  <StatusBadge status={request.status} />
                </div>
              </div>
              <button className="btn btn-sm" onClick={() => setShowResolveModal(false)}>
                Close
              </button>
            </header>
            <div className="drawer-body">
              <section className="section">
                <h3 className="section-title">Customer reply (review before sending)</h3>
                <label className="field-label" htmlFor="reply-subject">
                  Subject
                </label>
                <input
                  id="reply-subject"
                  className="input"
                  value={replySubject}
                  onChange={(event) => setReplySubject(event.target.value)}
                  disabled={busy}
                />
                <label className="field-label" htmlFor="reply-body" style={{ marginTop: 12 }}>
                  Body
                </label>
                <textarea
                  id="reply-body"
                  className="note"
                  style={{ minHeight: 180 }}
                  value={replyDraft}
                  onChange={(event) => setReplyDraft(event.target.value)}
                  disabled={busy}
                />
                <label className="checkbox" style={{ marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={sendReply}
                    onChange={(event) => setSendReply(event.target.checked)}
                    disabled={busy}
                  />
                  <span>Send this reply to the customer</span>
                </label>
                <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                  If unchecked, the request will be marked resolved with no email sent.
                </p>
              </section>
              <div className="actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || (sendReply && replyDraft.trim().length === 0)}
                  onClick={() => void resolveWithReply()}
                >
                  {sendReply ? 'Send reply & resolve' : 'Save & resolve'}
                </button>
                <button className="btn" disabled={busy} onClick={() => void resolveWithoutReply()}>
                  Resolve without replying
                </button>
                <button className="btn" disabled={busy} onClick={() => setShowResolveModal(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </aside>
        </>
      )}
    </>
  );
}