import WonderApp from './wonder-app';

// The link preview for the bare address, the one people paste. Crawlers don't run the pre-paint
// script that sends a visitor to /welcome, so they read these; they match the landing page's.
export const metadata = {
  openGraph: {
    type: 'website',
    siteName: 'Mull',
    url: '/',
    title: 'Mull · Name anything you want to understand',
    description: 'Name anything you want to understand. Mull writes you a short lesson as you read, with a tutor beside the text and reviews that help it stay.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'A glass prism splitting a beam of light into a spectrum, beside the words: Mull. Name anything you want to understand.' }],
  },
  twitter: { card: 'summary_large_image' },
};

// One page: the client routes between screens with the URL hash (#/lesson/…, #/review, …).
export default function Page() {
  return <WonderApp />;
}
