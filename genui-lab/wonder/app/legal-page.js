// The frame of the two legal pages (/privacy and /terms): a bar back to Mull, the title, the date
// it took effect and the text. Server-rendered, no app shell. WONDER_CONTACT_EMAIL is the address
// both pages give for questions and requests.
import './styles/legal.css';

export const LEGAL_UPDATED = 'October 31, 2026';

export function Contact() {
  const email = process.env.WONDER_CONTACT_EMAIL;
  return email ? <a href={`mailto:${email}`}>{email}</a> : <>the contact address on your Polar receipt</>;
}

export function LegalPage({ title, children }) {
  return (
    <div className="legal">
      <header className="legal-bar">
        <a className="legal-mark" href="/">Mull</a>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </header>
      <main className="legal-body">
        <h1>{title}</h1>
        <p className="legal-date">Last updated {LEGAL_UPDATED}</p>
        {children}
      </main>
    </div>
  );
}
