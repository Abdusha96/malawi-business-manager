import { BusinessContext } from "./ai-context";

export class AIAssistantError extends Error {}

/**
 * The system prompt is where spec section 22's requirement to "clearly
 * distinguish between calculated business data, general guidance, and
 * professional/accounting advice" is enforced – the model is explicitly
 * instructed to label which category each part of its answer falls into,
 * and to never fabricate a number that isn't in the provided context.
 */
function buildSystemPrompt(businessName: string): string {
  return `You are Mobi Accountant, a financial assistant inside Malawi Business Manager for the business "${businessName}".

You will be given a JSON snapshot of this business's current financial data. You may ONLY use numbers and facts from that snapshot – never invent, estimate, or recall figures from outside it. If the snapshot doesn't contain what's needed to answer, say so plainly rather than guessing.

When you answer, distinguish three kinds of content clearly, using these labels inline:
- [Data]: a fact or number taken directly from the snapshot.
- [Guidance]: general business advice or explanation that isn't specific financial/legal/tax advice.
- [Professional advice needed]: anything touching tax filings, legal compliance, or decisions a qualified accountant or lawyer should confirm – flag it as such rather than answering as if certain.

Keep answers concise and concrete. Reference specific numbers from the snapshot when relevant. Never claim certainty about anything not in the snapshot.`;
}

/**
 * Calls the Anthropic API directly (a real backend route, not a browser
 * proxy). Requires ANTHROPIC_API_KEY to be set in the business's
 * deployment environment; the business owner provides their own key. Model
 * name is read from an env var with a sensible default so it can be
 * updated without a code change as Anthropic's model lineup evolves –
 * check https://docs.claude.com for current model names before deploying.
 */
export async function askMobiAccountant(params: {
  businessName: string;
  context: BusinessContext;
  question: string;
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AIAssistantError(
      "The AI assistant isn't configured yet. An administrator needs to set ANTHROPIC_API_KEY in the environment."
    );
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: buildSystemPrompt(params.businessName),
      messages: [
        {
          role: "user",
          content: `Business data snapshot (JSON):\n${JSON.stringify(params.context)}\n\nQuestion: ${params.question}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new AIAssistantError(`AI assistant request failed (${response.status}). ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const textBlock = data.content?.find((block: { type: string }) => block.type === "text");

  if (!textBlock?.text) {
    throw new AIAssistantError("The AI assistant returned an empty response.");
  }

  return textBlock.text;
}

export const EXAMPLE_QUESTIONS = [
  "Why did my profit decrease this month?",
  "Which products make the most profit?",
  "Who owes me the most money?",
  "What are my biggest expenses?",
  "How much did I sell this month?",
  "Which products are running low or out of stock?",
  "What should I investigate in my accounts?",
];
