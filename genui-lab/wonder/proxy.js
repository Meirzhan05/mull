// Next.js proxy (formerly middleware). With accounts configured (Clerk keys set), Clerk reads the
// session on page and API requests so the API route can ask who is signed in (server/auth.js).
// Without the keys this is a no-op and Wonder runs without accounts, exactly as before; Clerk is
// never initialized (no keyless development instance either).
import { NextResponse } from 'next/server';
import { clerkMiddleware } from '@clerk/nextjs/server';

const clerk = process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? clerkMiddleware() : null;

export default function proxy(request, event) {
  return clerk ? clerk(request, event) : NextResponse.next();
}

export const config = {
  // Clerk's recommended matcher: skip Next internals and static files (the client's ES modules)
  matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|mjs|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)'],
};
