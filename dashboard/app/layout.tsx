import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Customer Operations | AI Request Desk',
  description:
    'AI-powered customer operations dashboard: incoming requests, AI analysis, human review queue and status monitoring.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
