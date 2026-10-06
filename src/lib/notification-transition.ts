/**
 * Module 61 – closes the KNOWN LIMITATION carried since Module 25 shipped
 * TAX_DUE as payment-cleared rather than condition-based (see the "THE SYNC
 * MODEL" comment at the top of in-app-notifications.ts): once a TAX_DUE
 * alert was dismissed, it stayed dismissed for the rest of that obligation's
 * life even if the working estimate it quoted moved afterward – a late
 * payroll run changing the PAYE figure, a new expense changing a
 * withholding-tax estimate, and so on. The person dismissed one number and
 * would never see that it had since become a different number, without
 * re-opening the Tax Calendar tab themselves.
 *
 * Pulled out of upsertActive() as a pure function, same reasoning
 * paginateRows()/apportionInputVat()/resolveVatDirection() were split out:
 * the branching (recurred / dismissed-but-amount-moved / dismissed-and-
 * unchanged / plain refresh) is worth unit-testing without touching Prisma.
 *
 * AMOUNT_CHANGE_THRESHOLD exists only to absorb float-representation noise –
 * every caller already rounds to 2dp (see round2() in tax-calendar.ts), so
 * any real change is at least one tambala (MWK 0.01).
 */
const AMOUNT_CHANGE_THRESHOLD = 0.01;

export interface NotificationTransitionInput {
  wasResolved: boolean;
  wasDismissed: boolean;
  // The amount snapshot stored on the existing row, or null if this alert
  // type doesn't track one (or it predates Module 61 and hasn't synced since).
  existingAmountSnapshot: number | null;
  // undefined: this alert type (LOW_STOCK, STALE_TRANSFER, TRIAL_ENDING)
  // doesn't track an amount at all, so it never re-surfaces on this basis.
  newAmount: number | null | undefined;
}

export interface NotificationTransition {
  /** true: a genuinely new occurrence – clears dismissal, unread state, resolvedAt. */
  isNewOccurrence: boolean;
  /** true: nothing changed – upsertActive should leave the row untouched and return early. */
  leaveAsIs: boolean;
  /** the amountSnapshot value to persist on this sync. */
  nextAmountSnapshot: number | null;
}

export function resolveNotificationTransition(input: NotificationTransitionInput): NotificationTransition {
  const { wasResolved, wasDismissed, existingAmountSnapshot, newAmount } = input;
  const nextAmountSnapshot = newAmount ?? null;

  if (wasResolved) {
    // The condition cleared and is now true again (TAX_DUE: a payment was
    // voided; the same logic would apply if a future condition-based type
    // ever re-armed after resolving) – always a fresh occurrence.
    return { isNewOccurrence: true, leaveAsIs: false, nextAmountSnapshot };
  }

  if (!wasDismissed) {
    // Untouched and still active – just refresh its content in place.
    return { isNewOccurrence: false, leaveAsIs: false, nextAmountSnapshot };
  }

  // Dismissed, and the condition never resolved in between – the default
  // (Module 25's rule) is to leave it alone, since resurrecting it would
  // turn dismiss into a five-minute snooze. The one exception: an alert
  // type that tracks an amount, where that amount has moved meaningfully
  // since the figure the person actually saw when they dismissed it. They
  // dismissed a number, not a category – a materially different number is
  // new information, not the same alert reappearing.
  const amountMeaningfullyChanged =
    newAmount !== undefined &&
    newAmount !== null &&
    existingAmountSnapshot !== null &&
    Math.abs(newAmount - existingAmountSnapshot) >= AMOUNT_CHANGE_THRESHOLD;

  if (amountMeaningfullyChanged) {
    return { isNewOccurrence: true, leaveAsIs: false, nextAmountSnapshot };
  }

  return { isNewOccurrence: false, leaveAsIs: true, nextAmountSnapshot: existingAmountSnapshot };
}
