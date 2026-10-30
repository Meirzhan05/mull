// Root layout: fonts (self-hosted by next/font), global CSS, metadata and the pre-paint theme
// script. The page body is the Wonder app shell (app/wonder-app.js).
import { Geist, Geist_Mono } from 'next/font/google';
import { syncConfig } from '../server/sync/index.js';
import { landingScript } from './landing-script.js';
import '../../chatgpt-dil/src/dil.css';
import 'katex/dist/katex.min.css';
import './styles/styles.css';
import './styles/extras.css';
import './styles/lesson-menu.css';
import './styles/math.css';
import './styles/outcomes.css'; // Phases 9-10
import './styles/course-review.css'; // whole-course review
import './styles/search.css';
import './styles/practice.css'; // visual practice cards
import './styles/retry.css'; // recoverable streams

// Type: Geist for everything you read and press, Geist Mono for figures, labels and markers.
const sans = Geist({ subsets: ['latin'], variable: '--font-sans-face', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono-face', display: 'swap' });

export const metadata = {
  title: 'Mull',
  description: 'Learn anything with interactive AI lessons, a tutor, and spaced-repetition review.',
  // icons: app/icon.svg (favicon) and app/apple-icon.png (home screen), picked up by file convention
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


// signed out (account sync on) or a first visit: the home page opens on the landing page
const ACCOUNTS = syncConfig().enabled;
const LANDING_SCRIPT = landingScript({ accounts: ACCOUNTS });

export default function RootLayout({ children }) {
  return (
    // data-accounts: whether everything needs a signed-in user (public/app.js reads it at boot)
    <html lang="en" className={`${sans.variable} ${mono.variable}`} data-accounts={ACCOUNTS ? 'on' : 'off'} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LANDING_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
