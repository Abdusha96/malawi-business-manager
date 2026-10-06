import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "./prisma";
import { verifyPassword } from "./password";
import { normalizePhoneNumber } from "./phone";
import { clientKey, hasRequestCapacity, recordHit } from "./rate-limit";

const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * We use NextAuth's JWT session strategy (not database sessions) so it works
 * cleanly with serverless deployment, but we ALSO keep our own `Session`
 * table (see schema) for "log out of all devices" and audit purposes. The
 * JWT is the thing the browser holds; our Session row is what lets us revoke
 * it server-side if needed later.
 *
 * Login accepts either an email or a Malawian phone number in the
 * `identifier` field, per spec section 2 (email/phone authentication).
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 }, // 30 days
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        identifier: { label: "Email or Phone", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.identifier || !credentials?.password) return null;

        const forwardedForHeader = req.headers?.["x-forwarded-for"];
        const forwardedFor = Array.isArray(forwardedForHeader)
          ? forwardedForHeader[0]
          : typeof forwardedForHeader === "string"
            ? forwardedForHeader
            : null;
        const failureKey = clientKey(forwardedFor, "credentials-login");
        if (!hasRequestCapacity(failureKey, LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS)) return null;

        const failed = () => {
          recordHit(failureKey, LOGIN_FAILURE_WINDOW_MS);
          return null;
        };

        const isEmail = credentials.identifier.includes("@");

        let user = await prisma.user.findUnique({
          where: isEmail
            ? { email: credentials.identifier.toLowerCase() }
            : { phone: normalizePhone(credentials.identifier) },
        });
        // Module 72: accounts saved before phones were normalised can hold the
        // old, unvalidated form (e.g. "+265999 123 456" from a team invite).
        // Fall back to that form so nobody is locked out before the backfill
        // script (scripts/normalize-stored-phones.ts) has been run.
        if (!user && !isEmail) {
          const legacy = legacyNormalizePhone(credentials.identifier);
          if (legacy !== normalizePhone(credentials.identifier)) {
            user = await prisma.user.findUnique({ where: { phone: legacy } });
          }
        }

        if (!user || !user.isActive) return failed();

        const validPassword = await verifyPassword(credentials.password, user.passwordHash);
        if (!validPassword) return failed();

        // Note: we deliberately do NOT block login on unverified email here –
        // the app should nudge verification in-app rather than lock people
        // out, since phone-first users may never touch their inbox.
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone ?? undefined,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.userId as string;
      }
      return session;
    },
  },
};

/**
 * Module 72: one phone reader for the whole app (src/lib/phone.ts). A number it
 * can read comes back as "+265..." whatever way it was typed; one it cannot read
 * is returned trimmed and otherwise untouched, exactly as before, so this never
 * throws and a login attempt with a strange identifier simply finds no account.
 */
export function normalizePhone(input: string): string {
  const r = normalizePhoneNumber(input);
  return r.ok ? r.e164 : input.trim();
}

/** The pre-Module-72 rule, kept ONLY for the login fallback above. */
function legacyNormalizePhone(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("+265")) return trimmed;
  if (trimmed.startsWith("0")) return `+265${trimmed.slice(1)}`;
  return trimmed;
}
