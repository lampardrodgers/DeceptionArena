import { buildProviderPresets, testProvider } from "../src/server/providers";

const provider = buildProviderPresets(process.env).find((item) => item.id === "deepseek");

if (!provider) {
  throw new Error("DeepSeek provider preset missing.");
}

const model = process.env.DEEPSEEK_MODEL || provider.defaultModel;
const decision = await testProvider(provider, model, process.env);

console.log(JSON.stringify({
  ok: true,
  provider: provider.id,
  model,
  number: decision.number,
  rationale: decision.rationale
}, null, 2));
