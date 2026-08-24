import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';

const geist = Geist({ variable: '--font-geist', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'StarSnap | 사람의 연결부터 일의 흐름까지',
  description: 'StarSnap은 SNS와 ERP를 중심으로 일상과 비즈니스에 필요한 디지털 서비스를 만듭니다.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className={geist.variable}>{children}</body>
    </html>
  );
}
