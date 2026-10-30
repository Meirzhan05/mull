'use client';

// The app shell. React renders the empty frame (sidebar, top bar, main, tabs, toast); after
// hydration the Wonder client (public/app.js and its modules) takes over those nodes. Those
// modules stay unbundled ES modules on purpose: the lesson renderer runs model-written UI in a
// sandboxed Web Worker (public/wonder-worker.js) that imports the DIL runtime by URL.
import { useEffect } from 'react';
import { createAuthClient } from '@neondatabase/auth/next';

let started = false;

export default function WonderApp() {
  useEffect(() => {
    if (started) return; // Strict Mode runs effects twice in development
    started = true;
    // Neon Auth's browser client for the vanilla app (public/account.js): sign-in with Google,
    // the OAuth session exchange on return, sign-out. It only talks to /api/auth/* when used.
    globalThis.__wonderAuth ??= createAuthClient();
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '/app.js').catch((err) => {
      console.error('[wonder] client failed to start', err);
      document.documentElement.removeAttribute('data-handoff'); // (app/landing-script.js)
      const main = document.getElementById('app');
      if (main) main.textContent = 'Mull could not start. Reload the page to try again.';
    });
  }, []);

  const skip = (e) => {
    e.preventDefault();
    document.getElementById('app')?.focus();
  };

  return (
    <>
      <a className="skip-link" href="#app" onClick={skip}>Skip to content</a>
      <div className="shell">
        <aside className="sidebar" id="sidebar" aria-label="Main" />
        <div className="main-col">
          <header className="topbar" id="topbar" />
          <div id="setup-banner" className="setup-banner" hidden role="status" />
          <main id="app" tabIndex={-1} />
        </div>
      </div>
      <nav className="tabbar" id="tabbar" aria-label="Main" />
      <div id="toast" className="toast" role="status" aria-live="polite" hidden />
    </>
  );
}
