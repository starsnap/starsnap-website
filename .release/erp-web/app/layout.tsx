import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_ORIGIN ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3001'),
  title: 'StarSnap ERP',
  description: '상품, 발주, 재고, 생산, 배송, 정산 등 다양한 업종의 업무를 연결하는 통합 ERP',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
      { url: '/icon.png', type: 'image/png', sizes: '1254x1254' },
    ],
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' }],
  },
  openGraph: {
    title: 'StarSnap ERP',
    description: '모든 업무를 하나의 흐름으로',
    type: 'website',
    locale: 'ko_KR',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'StarSnap ERP 통합 업무 관리' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StarSnap ERP',
    description: '모든 업무를 하나의 흐름으로',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
