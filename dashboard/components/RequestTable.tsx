import type { SupportRequest } from '@/lib/types';
import { relativeTime, shortId } from '@/lib/format';
import { DecisionBadge, PriorityBadge, SentimentBadge, StatusBadge } from './Badges';

export default function RequestTable({
  requests,
  loading,
  selectedId,
  onSelect,
}: {
  requests: SupportRequest[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!loading && requests.length === 0) {
    return (
      <div className="empty">
        <h3>No requests match the current filters</h3>
        <div>Try another status chip, clear the search, or create a new request.</div>
      </div>
    );
  }

  if (loading && requests.length === 0) {
    return (
      <div className="empty">
        <div className="sk" style={{ width: '40%', margin: '0 auto 10px' }} />
        <div className="sk" style={{ width: '55%', margin: '0 auto 10px' }} />
        <div className="sk" style={{ width: '48%', margin: '0 auto' }} />
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Request</th>
            <th>Customer</th>
            <th>AI analysis</th>
            <th>Priority</th>
            <th>Sentiment</th>
            <th>Decision</th>
            <th>Status</th>
            <th>Received</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr
              key={request.id}
              className={selectedId === request.id ? 'is-selected' : ''}
              onClick={() => onSelect(request.id)}
            >
              <td>
                <div className="cell-subject">{request.subject}</div>
                <div className="cell-sub">
                  {request.sender_email} · {shortId(request.id)}
                </div>
              </td>
              <td>
                <div>{request.customer?.full_name ?? 'Unknown'}</div>
                <div className="cell-sub">
                  {request.customer?.plan ? request.customer.plan + ' plan' : request.sender_email}
                </div>
              </td>
              <td>
                <div className="tag-row">
                  <span className="tag">{request.intent ?? 'unclassified'}</span>
                  {request.category && (
                    <span className="tag tag-category">{request.category}</span>
                  )}
                </div>
              </td>
              <td>
                <PriorityBadge priority={request.priority} />
              </td>
              <td>
                <SentimentBadge sentiment={request.sentiment} />
              </td>
              <td>
                <DecisionBadge decision={request.decision} />
              </td>
              <td>
                <StatusBadge status={request.status} />
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{relativeTime(request.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
