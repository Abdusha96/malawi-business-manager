import { prisma } from "./prisma";
import { sendEmail, sendSms } from "./notifications";
import { renewalReminderDue, RENEWAL_REMINDER_FIRST_DAYS } from "./payment-gateway";
import { getEffectiveSubscriptionStatus } from "./subscription";
import { readGatewayConfig } from "./payment-gateway";

/**
 * Module 74 – renewal reminders for a subscription paid through the gateway.
 *
 * A mobile money or card payment is approved by the payer every time (the hosted checkout stores
 * nothing to charge later), so a subscription cannot silently renew itself. What this module does
 * instead is make sure the person never gets surprised: one email and SMS a week before the paid
 * period ends and a final one the day before, each pointing at Billing where "Renew" is one tap.
 * (The in-app bell alert for the same window is `syncRenewalAlert` in in-app-notifications.ts and
 * needs no scheduler; these messages go out when the cron route runs.)
 *
 * Claim-then-send: the stage is written with a conditional update BEFORE the message goes out, so two
 * overlapping runs cannot both send it. If sending fails the stage stays claimed (a duplicate reminder
 * is worse than a late one), and the failure is on the NotificationLog row like any other message.
 * Since Module 75 a failure caused by a temporary provider problem is retried automatically by the
 * same cron run (notification-retry.ts), and dropped if the plan is renewed meanwhile, so the claim
 * no longer means the reminder can be lost.
 */
export async function sendRenewalReminders(now: Date = new Date()): Promise<{ considered: number; sent: number }> {
  const horizon = new Date(now.getTime() + (RENEWAL_REMINDER_FIRST_DAYS + 1) * 86_400_000);
  const rows = await prisma.subscription.findMany({
    where: { status: "ACTIVE", requiresPayment: true, cancelAtPeriodEnd: false, currentPeriodEnd: { gt: now, lte: horizon } },
    include: { plan: true, business: { select: { id: true, name: true, email: true, phone: true } } },
    take: 500,
  });

  const appUrl = readGatewayConfig(process.env).appUrl;
  let sent = 0;
  for (const sub of rows) {
    if (getEffectiveSubscriptionStatus(sub) !== "ACTIVE") continue;
    const stage = renewalReminderDue({
      now,
      status: sub.status,
      requiresPayment: sub.requiresPayment,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      periodEnd: sub.currentPeriodEnd,
      stage: sub.renewalReminderStage,
      stagePeriodEnd: sub.renewalReminderPeriodEnd,
    });
    if (!stage || !sub.currentPeriodEnd) continue;

    // Claim: only the run that moves (stage, periodEnd) from what it read gets to send.
    const claim = await prisma.subscription.updateMany({
      where: { id: sub.id, renewalReminderStage: sub.renewalReminderStage, renewalReminderPeriodEnd: sub.renewalReminderPeriodEnd },
      data: { renewalReminderStage: stage, renewalReminderPeriodEnd: sub.currentPeriodEnd },
    });
    if (claim.count !== 1) continue;

    const days = Math.max(1, Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / 86_400_000));
    const when = days === 1 ? "tomorrow" : `in ${days} days`;
    const link = appUrl ? `${appUrl}/settings/billing` : "the Billing page";
    const subject = stage === 2 ? `Your ${sub.plan.name} plan ends ${when}` : `Your ${sub.plan.name} plan renews ${when}`;
    const text = `Your ${sub.plan.name} plan for ${sub.business.name} ends ${when}. Renew from ${link} to keep every feature without a break. If you do nothing, you keep access for a few more days and then the account drops to the limits of an expired plan.`;

    if (sub.business.email) {
      await sendEmail({
        businessId: sub.business.id,
        to: sub.business.email,
        subject,
        body: `<p>${text}</p>`,
        templateKey: "subscription_renewal_reminder",
        relatedEntityType: "Subscription",
        relatedEntityId: sub.id,
      }).catch(() => undefined);
    }
    if (sub.business.phone) {
      await sendSms({
        businessId: sub.business.id,
        to: sub.business.phone,
        body: `${sub.business.name}: your ${sub.plan.name} plan ends ${when}. Renew at ${link}`,
        templateKey: "subscription_renewal_reminder",
        relatedEntityType: "Subscription",
        relatedEntityId: sub.id,
      }).catch(() => undefined);
    }
    sent++;
  }
  return { considered: rows.length, sent };
}
