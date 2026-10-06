import { NextRequest, NextResponse } from "next/server";
import { consumeEmailVerificationToken } from "@/lib/tokens";

export async function POST(req: NextRequest) {
  const { token } = await req.json();

  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const result = await consumeEmailVerificationToken(token);

  if (!result.ok) {
    const messages: Record<string, string> = {
      invalid: "This verification link is invalid.",
      already_used: "This verification link has already been used.",
      expired: "This verification link has expired. Please request a new one.",
    };
    return NextResponse.json(
      { error: result.reason, message: messages[result.reason] },
      { status: 400 }
    );
  }

  return NextResponse.json({ message: "Email verified successfully." });
}
