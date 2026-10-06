import { prisma } from "./prisma";
import {
  processDeliveryReport,
  ReportDeps,
  ReportResponse,
  DeliveryState,
} from "./sms-delivery-report";

/**
 * Module 76 – the server side of Africa's Talking delivery reports: wires the pure
 * processDeliveryReport() in sms-delivery-report.ts to the database.
 *
 * The write is CONDITIONAL on the row's deliveryState still being what was read (NULL included), the
 * same fail-closed claim idea Modules 55/66/75 use: two reports for one message arriving together
 * (a "Sent" and a "Success" a second apart is ordinary) race on that write and the loser re-reads and
 * decides again, so a late "Sent" can never overwrite "Success".
 */

function prismaDeps(secret: string): ReportDeps {
  return {
    secret,
    async findByMessageId(messageId) {
      const rows = await prisma.notificationLog.findMany({
        where: { providerMessageId: messageId },
        select: {
          id: true,
          businessId: true,
          channel: true,
          providerName: true,
          recipientAddress: true,
          deliveryState: true,
        },
        take: 5,
      });
      return rows;
    },
    async apply(rowId, expected, next) {
      const res = await prisma.notificationLog.updateMany({
        where: { id: rowId, deliveryState: expected },
        data: {
          deliveryState: next.state,
          deliveryReportedAt: next.reportedAt,
          deliveryFailureReason: next.failureReason,
        },
      });
      return res.count === 1;
    },
    async reload(rowId) {
      const row = await prisma.notificationLog.findUnique({ where: { id: rowId }, select: { deliveryState: true } });
      if (!row) return undefined;
      return row.deliveryState as DeliveryState | null;
    },
  };
}

/**
 * Entry point for the public route. `token` is whatever the caller presented; `fields` is the parsed
 * form body. Never throws for a bad request: a thrown error (database down) is left to become a 500.
 */
export async function handleDeliveryReport(input: {
  token: string | null;
  fields: Record<string, string | undefined | null>;
}): Promise<ReportResponse> {
  const secret = (process.env.AT_DELIVERY_REPORT_SECRET ?? "").trim();
  return processDeliveryReport(prismaDeps(secret), input, new Date());
}
