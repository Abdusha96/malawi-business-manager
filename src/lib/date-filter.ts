import { parseDateInput } from "./date-range";

/** Parse optional YYYY-MM-DD range fields using the business calendar. */
export function parseOptionalDateFilter(
  fromValue: string | undefined,
  toValue: string | undefined,
  timeZone: string,
): { from?: Date; to?: Date; error: string | null } {
  const fromRaw = fromValue?.trim() ?? "";
  const toRaw = toValue?.trim() ?? "";
  const fromParsed = fromRaw ? parseDateInput(fromRaw, "start", timeZone) : undefined;
  const toParsed = toRaw ? parseDateInput(toRaw, "end", timeZone) : undefined;
  if (fromRaw && !fromParsed) return { error: "Enter a valid start date." };
  if (toRaw && !toParsed) return { error: "Enter a valid end date." };
  return { from: fromParsed ?? undefined, to: toParsed ?? undefined, error: null };
}
