import Dashboard from '@/components/Dashboard';

/**
 * Deep link used in the ops alerts sent by n8n:
 *   http://localhost:3000/requests/<uuid>
 */
export default function RequestPage({ params }: { params: { id: string } }) {
  return <Dashboard initialRequestId={params.id} />;
}
