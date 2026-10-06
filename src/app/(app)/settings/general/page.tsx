import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/erp/display";
import { authOptions } from "@/lib/auth";
import { listUserBusinesses, hasPermission } from "@/lib/tenant";
import { resolveTimeZone, SUPPORTED_TIME_ZONES } from "@/lib/timezone";
import { MIN_MAX_REOPENS, MAX_MAX_REOPENS } from "@/lib/reopen-constants";
import { MIN_STALE_TRANSFER_ALERT_DAYS, MAX_STALE_TRANSFER_ALERT_DAYS } from "@/lib/stale-transfer";
import { MIN_SERVICE_COST_ALERT_DAYS, MAX_SERVICE_COST_ALERT_DAYS } from "@/lib/service-cost-clearing";
import { TimeZoneForm } from "./time-zone-form";
import { MaxReopensForm } from "./max-reopens-form";
import { StaleTransferThresholdForm } from "./stale-transfer-threshold-form";
import { ServiceCostAlertForm } from "./service-cost-alert-form";

// Module 35 – Business time zone. First page under /settings/general; other
// business-profile settings (name, prefixes) can join it later.
// Module 51 added the reopen-limit section below the time zone one.
// Module 58 added the stale-transfer-threshold section below that.
// Module 80 added the service-cost-clearing alert section below that.
export default async function GeneralSettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  const memberships = await listUserBusinesses(session.user.id);
  if (memberships.length === 0) redirect("/dashboard");

  const membership = memberships[0];
  const canManage = await hasPermission(
    { businessId: membership.businessId, userId: session.user.id, role: membership.role, branchId: membership.branchId },
    "business.settings.manage"
  );

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <PageHeader title="Business Settings" description="Time zone and the limits and alert thresholds that apply business-wide." />
      <TimeZoneForm
        businessId={membership.businessId}
        initialTimeZone={resolveTimeZone(membership.business.timezone)}
        options={SUPPORTED_TIME_ZONES.map((z) => ({ id: z.id, label: z.label, offsetHours: z.offsetHours }))}
        canManage={canManage}
      />
      <MaxReopensForm
        businessId={membership.businessId}
        initialMaxReopens={membership.business.maxReopens}
        min={MIN_MAX_REOPENS}
        max={MAX_MAX_REOPENS}
        canManage={canManage}
      />
      <StaleTransferThresholdForm
        businessId={membership.businessId}
        initialAlertDays={membership.business.staleTransferAlertDays}
        min={MIN_STALE_TRANSFER_ALERT_DAYS}
        max={MAX_STALE_TRANSFER_ALERT_DAYS}
        canManage={canManage}
      />
      <ServiceCostAlertForm
        businessId={membership.businessId}
        initialAlertDays={membership.business.serviceCostAlertDays}
        min={MIN_SERVICE_COST_ALERT_DAYS}
        max={MAX_SERVICE_COST_ALERT_DAYS}
        canManage={canManage}
      />
    </main>
  );
}
