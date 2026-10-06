import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

/**
 * This layer only confirms "is there a logged-in user" – it cannot check
 * business membership or role/permission (those require a DB call, and
 * middleware runs on the edge before that's convenient). Every protected API
 * route MUST still call requireBusinessMember()/requirePermission() from
 * src/lib/tenant.ts itself. Treat this as the outer gate, not the tenant
 * boundary.
 */
export default withAuth(
  function middleware() {
    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token }) => !!token,
    },
    pages: {
      signIn: "/login",
    },
  }
);

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/sales/:path*",
    "/inventory/:path*",
    "/customers/:path*",
    "/expenses/:path*",
    "/accounting/:path*",
    "/reports/:path*",
    "/ai-assistant/:path*",
    "/settings/:path*",
    "/api/business/:path*",
  ],
};
