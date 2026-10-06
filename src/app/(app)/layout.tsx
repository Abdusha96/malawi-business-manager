import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { getEffectiveSubscriptionStatus } from "@/lib/subscription";
import { getFiscalYear } from "@/lib/fiscal-period";
import { resolveTimeZone, formatDateIn } from "@/lib/timezone";
import { AppShell } from "@/components/erp/app-shell";
import { uiPermissionKeys } from "@/components/erp/nav-config";

// Module 82 – the persistent ERP shell (sidebar, header, breadcrumbs, status
// bar) for every signed-in page. `(app)` is a route group, so it adds no URL
// segment: /dashboard, /sales, /customers … resolve exactly as before.
//
// Tenant rules are unchanged: the active business is still the member's first
// membership (what every page already uses), and this layout only READS –
// the pages and API routes keep enforcing access themselves. Nothing here
// widens what a member can see; it only decides which menu entries to show.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  // No business: render the page bare so it can show its own "contact support" message.
  if (memberships.length === 0) return <>{children}</>;

  const m = memberships[0];
  const business = m.business;
  const memberCtx = { businessId: m.businessId, userId: session.user.id, role: m.role, branchId: m.branchId };
  const tz = resolveTimeZone(business.timezone);

  const keys = uiPermissionKeys();
  const [grants, canViewNotifications, subscription, branch, unreadCount] = await Promise.all([
    Promise.all(keys.map((k) => hasPermission(memberCtx, k))),
    hasPermission(memberCtx, "notifications.view"),
    prisma.subscription.findUnique({ where: { businessId: m.businessId }, include: { plan: true } }),
    m.branchId ? prisma.branch.findUnique({ where: { id: m.branchId }, select: { name: true } }) : Promise.resolve(null),
    // A plain count – NOT getInAppNotificationCounts(), which re-syncs seven
    // alert generators; running that on every page view would be wasteful. The
    // dashboard and the bell's own refresh still sync.
    prisma.inAppNotification.count({ where: { businessId: m.businessId, resolvedAt: null, dismissedAt: null, isRead: false } }),
  ]);

  const fy = getFiscalYear(business.financialYearStartMonth, new Date(), tz);
  const startYear = formatDateIn(fy.start, tz, { year: "numeric" });
  const endYear = formatDateIn(fy.end, tz, { year: "numeric" });
  const fyLabel = startYear === endYear ? `FY ${startYear}` : `FY ${startYear}/${endYear.slice(-2)}`;
  const periodLabel = `${fyLabel} · ${formatDateIn(new Date(), tz, { month: "long" })}`;

  return (
    <AppShell
      ctx={{
        businessId: m.businessId,
        businessName: business.name,
        businessCount: memberships.length,
        branchLabel: branch?.name ?? "All branches",
        periodLabel,
        currency: business.currency,
        timeZone: tz,
        userName: session.user.name ?? session.user.email ?? "User",
        role: m.role,
        planLabel: subscription ? `${subscription.plan.name} · ${getEffectiveSubscriptionStatus(subscription)}` : null,
        granted: keys.filter((_, i) => grants[i]),
        canViewNotifications,
        unreadCount,
        theme: (await cookies()).get("mbm.theme")?.value === "dark" ? "dark" : "light",
      }}
    >
      {children}
    </AppShell>
  );
}
