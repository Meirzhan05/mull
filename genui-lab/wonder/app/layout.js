// Root layout: fonts (self-hosted by next/font), global CSS, metadata and the pre-paint theme
// script. The page body is the Wonder app shell (app/wonder-app.js).
import { Geist, Geist_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import '../../chatgpt-dil/src/dil.css';
import 'katex/dist/katex.min.css';
import './styles/styles.css';
import './styles/extras.css';
import './styles/lesson-menu.css';
import './styles/math.css';
import './styles/outcomes.css'; // Phases 9-10

// Type: Geist for everything you read and press, Geist Mono for figures, labels and markers.
const sans = Geist({ subsets: ['latin'], variable: '--font-sans-face', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono-face', display: 'swap' });

export const metadata = {
  title: 'Wonder',
  description: 'Learn anything with interactive AI lessons, a tutor, and spaced-repetition review.',
  icons: { icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23111111'/%3E%3Cpath d='M9 11l3 11 4-8 4 8 3-11' fill='none' stroke='%23FFFFFF' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#141310' },
  ],
};

// apply the saved theme before first paint (no flash); the shell manages it afterwards
const THEME_SCRIPT = "try{var t=localStorage.getItem('wonder.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}";

// Accounts (sync across devices) only when Clerk is configured; the vanilla client reaches it as
// window.Clerk (public/account.js). Without the keys the page is exactly as before.
const ACCOUNTS = !!(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{ACCOUNTS ? <ClerkProvider>{children}</ClerkProvider> : children}</body>
    </html>
  );
}
