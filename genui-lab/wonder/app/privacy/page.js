import { LegalPage, Contact } from '../legal-page';

export const metadata = { title: 'Privacy · Mull', description: 'What Mull collects, why, who it shares it with, and how to delete it.' };

export default function Privacy() {
  return (
    <LegalPage title="Privacy">
      <p>Mull is a learning app run by one independent developer. This page says what Mull keeps about you, why, and who else sees it. Mull does not sell your data and shows no ads.</p>

      <h2>What Mull keeps</h2>
      <ul>
        <li><strong>Your Google account.</strong> Your name, email address and profile picture, from Google sign-in, so Mull knows which lessons are yours.</li>
        <li><strong>What you learn.</strong> The topics you ask for, the lessons, courses and tutor and Teacher conversations Claude writes for you, your quiz and review answers, your cards, streak and settings.</li>
        <li><strong>Learner memory.</strong> Short notes about what you know and what helps you, which Mull uses to fit later lessons to you. You can turn memory off and remove notes on the You page.</li>
        <li><strong>Material you upload.</strong> PDFs and text you add so a lesson can be taught from them.</li>
        <li><strong>Usage and billing records.</strong> How many lessons and messages you used each day (for the daily limits), your plan, and, if you subscribe, the customer and subscription ids from Polar. Mull never sees or stores your card details.</li>
        <li><strong>Reminders.</strong> If you turn on daily reminders, the push subscription your browser gives Mull.</li>
        <li><strong>Visit statistics.</strong> Counts of page views (which screens are opened, from which country and kind of device), through Vercel Web Analytics. It uses no cookies, and Mull sends it the screen name only, never a lesson, topic or id.</li>
      </ul>

      <h2>Who else sees it</h2>
      <p>Mull uses these services to run. Each sees only what it needs:</p>
      <ul>
        <li><strong>Anthropic</strong> (Claude) writes the lessons, tutor replies and Teacher turns. It receives your request, the lesson so far, your learner memory and any material you teach from. Anthropic does not train its models on data sent through its API by default.</li>
        <li><strong>Vercel</strong> hosts Mull and its files and counts visits.</li>
        <li><strong>Neon</strong> hosts the database and the sign-in service.</li>
        <li><strong>Google</strong> handles sign-in.</li>
        <li><strong>Polar</strong> runs checkout and subscriptions as the merchant of record, under its own privacy policy.</li>
        <li><strong>Wikimedia Commons and YouTube.</strong> Lessons can show pictures from Wikimedia Commons and videos from YouTube (through its privacy-enhanced youtube-nocookie.com player). Your browser loads them from those sites, which then see your IP address.</li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li><strong>Delete your account</strong> on the You page. It deletes your lessons, cards, progress, memory and material for good, and ends any subscription first.</li>
        <li><strong>Turn memory off</strong>, or remove single notes, on the You page.</li>
        <li><strong>Ask</strong> for a copy of your data, or a correction, by email: <Contact />.</li>
      </ul>

      <h2>How long it is kept</h2>
      <p>Your data is kept while you have an account and deleted when you delete it. Billing records may be kept longer where the law requires it. Hosting providers keep short-lived server logs.</p>

      <h2>Children</h2>
      <p>Mull is not meant for children under 13, and you must be old enough to agree to these terms where you live.</p>

      <h2>Changes</h2>
      <p>When this page changes, the date above changes with it.</p>

      <h2>Contact</h2>
      <p>Questions or requests: <Contact />.</p>
    </LegalPage>
  );
}
