require("dotenv").config();

const OpenAI = require("openai");

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

function shouldTryNextModel(error) {
  const status = Number(error.status || error.code || 0);
  if ([401, 403, 429].includes(status)) return false;

  const message = String(error.message || "");
  return /model|not found|does not exist|unsupported|not supported|invalid.*model|reasoning/i.test(message);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const primaryModel = process.env.BROGRADE_AI_MODEL || "gpt-5.5";
  const fallbackModels = parseCsv(process.env.BROGRADE_AI_FALLBACK_MODELS || "gpt-5.1,gpt-5");
  const models = uniqueList([primaryModel, ...fallbackModels]);
  const reasoningEffort = process.env.BROGRADE_AI_REASONING_EFFORT || "medium";
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const failures = [];

  for (const model of models) {
    try {
      const response = await openai.responses.create({
        model,
        store: false,
        instructions: "Return exactly the requested confirmation text.",
        input: "Reply with exactly: BroGrade AI ready",
        reasoning: { effort: reasoningEffort },
        max_output_tokens: 24
      });

      const text = (response.output_text || "").trim();
      if (!/BroGrade AI ready/i.test(text)) {
        throw new Error(`Unexpected model response: ${text || "empty output"}`);
      }

      console.log(`OpenAI ready with model: ${model}`);
      return;
    } catch (error) {
      failures.push(`${model}: ${error.message}`);
      if (!shouldTryNextModel(error)) break;
    }
  }

  throw new Error(`OpenAI check failed. ${failures.join(" | ")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
