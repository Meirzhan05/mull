import { LegalPage, Contact } from '../legal-page';

export const metadata = { title: 'Terms · Mull', description: 'The terms for using Mull and Mull Pro.' };

export default function Terms() {
  return (
    <LegalPage title="Terms">
      <p>These terms cover your use of Mull, a learning app run by one independent developer. By signing in you agree to them, and to the <a href="/privacy">privacy page</a>.</p>

      <h2>What Mull is</h2>
      <p>Mull writes lessons, tutor replies and study plans with Claude, an AI made by Anthropic. <strong>AI can be wrong.</strong> Lessons are checked by a second pass, but they can still contain mistakes. Use them to learn, not as professional advice: check anything that matters (health, law, money, safety) with a qualified source.</p>

      <h2>Your account</h2>
      <ul>
        <li>You sign in with Google and are responsible for what happens under your account.</li>
        <li>You must be at least 13, and old enough to agree to these terms where you live.</li>
        <li>You can delete your account at any time on the You page.</li>
      </ul>

      <h2>Fair use</h2>
      <p>Don't use Mull to break the law, to make harmful or abusive content, to get around its daily limits (for example with many accounts), or to overload or attack the service. Upload only material you have the right to use. Mull may suspend an account that does these things.</p>

      <h2>Free and Pro</h2>
      <ul>
        <li><strong>Free</strong> has daily limits on lessons and messages. They reset at midnight UTC and may change.</li>
        <li><strong>Pro</strong> is a monthly subscription with higher limits. It is sold by Polar, the merchant of record, which handles payment, taxes, invoices and refunds under its own terms.</li>
        <li>You can cancel at any time from Manage billing on the You page. Pro stays on until the end of the period you paid for and is not renewed.</li>
        <li>If Mull changes the price, it applies from your next period, after notice.</li>
      </ul>

      <h2>Your content</h2>
      <p>The lessons written for you and the material you upload are yours to use. You give Mull permission to store and process them only to run the service for you.</p>

      <h2>No guarantees</h2>
      <p>Mull is provided as is. It may change, have outages or stop. As far as the law allows, Mull is not liable for indirect losses, and its total liability to you is limited to what you paid for Mull in the past 12 months.</p>

      <h2>Changes</h2>
      <p>These terms may change, and the date above changes with them. Using Mull after a change means you accept the new terms.</p>

      <h2>Contact</h2>
      <p>Questions: <Contact />.</p>
    </LegalPage>
  );
}
