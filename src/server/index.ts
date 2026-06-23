import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderPresets, testProvider } from "./providers.js";
import { MatchStore } from "./matchStore.js";

const app = express();
const store = new MatchStore();
const port = Number(process.env.PORT || 13445);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/providers", (_req, res) => {
  res.json({ providers: buildProviderPresets(process.env) });
});

app.post("/api/providers/test", async (req, res) => {
  try {
    const { providerId, model } = req.body ?? {};
    const provider = buildProviderPresets(process.env).find((item) => item.id === providerId);
    if (!provider) {
      res.status(404).json({ error: "Provider not found." });
      return;
    }
    const decision = await testProvider(provider, model || provider.defaultModel, process.env);
    res.json({ ok: true, decision });
  } catch (error) {
    res.status(400).json({ ok: false, error: messageOf(error) });
  }
});

app.post("/api/matches", (req, res) => {
  try {
    const seats = Array.isArray(req.body?.seats) ? req.body.seats : defaultSeats();
    res.json({ match: store.createMatch(seats.slice(0, 5)) });
  } catch (error) {
    res.status(400).json({ error: messageOf(error) });
  }
});

app.get("/api/matches/:id", (req, res) => {
  const match = store.getMatch(req.params.id);
  if (!match) {
    res.status(404).json({ error: "Match not found." });
    return;
  }
  res.json({ match });
});

app.post("/api/matches/:id/submit", (req, res) => {
  try {
    const match = store.submitHuman(req.params.id, {
      seatId: String(req.body?.seatId ?? ""),
      number: Number(req.body?.number),
      rationale: "Human submission."
    });
    res.json({ match });
  } catch (error) {
    res.status(400).json({ error: messageOf(error) });
  }
});

app.post("/api/matches/:id/run-round", async (req, res) => {
  try {
    const match = await store.runRound(req.params.id, process.env);
    res.json({ match });
  } catch (error) {
    res.status(400).json({ error: messageOf(error) });
  }
});

app.post("/api/matches/:id/run-round-stream", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  try {
    for await (const event of store.runRoundStream(req.params.id, process.env)) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  } catch (error) {
    res.write(`${JSON.stringify({ type: "error", error: messageOf(error) })}\n`);
  } finally {
    res.end();
  }
});

app.post("/api/matches/:id/autorun", async (req, res) => {
  try {
    const match = await store.autoRun(req.params.id, Number(req.body?.rounds ?? 1), process.env);
    res.json({ match });
  } catch (error) {
    res.status(400).json({ error: messageOf(error) });
  }
});

app.get("/api/matches/:id/replay", (req, res) => {
  const stored = store.getReplay(req.params.id);
  if (!stored) {
    res.status(404).json({ error: "Match not found." });
    return;
  }
  res.json(stored);
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(dirname, "../../client");
app.use(express.static(clientDist));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(port, () => {
  console.log(`King of Diamonds server listening on http://127.0.0.1:${port}`);
});

function defaultSeats() {
  return [
    { name: "You", kind: "human" as const },
    { name: "DeepSeek", kind: "ai" as const, providerId: "deepseek", model: "deepseek-v4-flash", strategy: "Recursive low-average pressure." },
    { name: "Kimi", kind: "ai" as const, providerId: "kimi", model: "kimi-k2.6", strategy: "Opponent modelling with late-stage noise." },
    { name: "Gemini", kind: "ai" as const, providerId: "gemini", model: "gemini-3.5-flash", strategy: "Balanced estimate with duplicate avoidance." },
    { name: "Claude", kind: "ai" as const, providerId: "anthropic", model: "claude-sonnet-4-5", strategy: "Conservative survival play." }
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
