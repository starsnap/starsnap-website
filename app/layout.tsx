import type { Metadata } from 'next';
import './globals.css';

const siteUrl = 'https://starsnap-company.hamtory06.chatgpt.site';
const title = 'StarSnap | 사람의 연결부터 일의 흐름까지';
const description =
  'StarSnap은 SNS와 ERP를 중심으로 일상과 비즈니스에 필요한 디지털 서비스를 만듭니다.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: 'StarSnap',
  themeColor: '#f6f7fb',
  alternates: { canonical: '/' },
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
    title,
    description,
    url: '/',
    siteName: 'StarSnap',
    locale: 'ko_KR',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'StarSnap — Connect people. Organize work.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('starsnap-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var n=d?'dark':'light';document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.theme=n;document.documentElement.style.colorScheme=n}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
