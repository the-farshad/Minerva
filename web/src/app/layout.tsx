import type { Metadata } from 'next';
import { Inter, Ubuntu, Roboto, Vazirmatn } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const inter   = Inter({   variable: '--font-inter',   subsets: ['latin'] });
const ubuntu  = Ubuntu({  variable: '--font-ubuntu',  subsets: ['latin'], weight: ['300', '400', '500', '700'] });
const roboto  = Roboto({  variable: '--font-roboto',  subsets: ['latin'] });
const vazir   = Vazirmatn({ variable: '--font-vazir', subsets: ['arabic', 'latin'] });

export const metadata: Metadata = {
  title: { default: 'Minerva', template: '%s · Minerva' },
  description: 'A schema-driven planner backed by your own Google data.',
  applicationName: 'Minerva',
  authors: [{ name: 'Farshad' }],
  themeColor: [
    { color: '#fbfbfa', media: '(prefers-color-scheme: light)' },
    { color: '#0b0d10', media: '(prefers-color-scheme: dark)' },
  ],
  formatDetection: { telephone: false, email: false, address: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${ubuntu.variable} ${roboto.variable} ${vazir.variable} h-full antialiased`}>
      <body className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
