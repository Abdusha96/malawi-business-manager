"use client";

import { describePhoneForSms } from "@/lib/phone";

/**
 * Module 72: one line under a phone field saying what a text would be sent to,
 * or why it can't be. Same wording everywhere (src/lib/phone.ts owns it).
 * Renders nothing for an empty field.
 */
export function PhoneHint({ value }: { value: string | null | undefined }) {
  const note = describePhoneForSms(value);
  if (!note) return null;
  return (
    <p className={`mt-1 text-xs ${note.level === "warn" ? "text-amber-700" : "text-gray-500"}`}>{note.text}</p>
  );
}
