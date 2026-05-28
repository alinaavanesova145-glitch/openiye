import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets:  ['latin'],
  variable: '--font-inter',
  display:  'swap',
});

export const metadata: Metadata = {
  title:       'iye — vector field engine',
  description: 'real-time sanitised vector field visualisation powered by the iye math engine',
  keywords:    ['vector field', 'webgpu', 'three.js', 'real-time', 'iye'],
  authors:     [{ name: 'iye systems' }],
  robots:      'noindex',   // internal tool — restrict crawling
  viewport:    'width=device-width, initial-scale=1',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
