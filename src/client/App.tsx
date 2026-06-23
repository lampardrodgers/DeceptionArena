import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveRules,
  MatchState,
  ProviderPreset,
  ReasoningEffort,
  RoundResult,
  Seat
} from "../shared/types";
import {
  createMatch,
  fetchProviders,
  runRoundStream,
  submitHuman,
  testProvider,
  type CreateMatchSeat,
  type RoundStreamEvent
} from "./api";

type Mode = "human-ai" | "pure-ai";
type ReasoningChoice = "" | ReasoningEffort;
type PlanDialog = {
  seatName: string;
  provider: string;
  pick: string;
  rationale: string;
} | null;
type SeatProgressStatus = "idle" | "thinking" | "done";
type SeatProgress = {
  status: SeatProgressStatus;
  number?: number;
  rationale?: string;
  elapsedMs?: number;
  stream: string[];
};
type StreamDialog = {
  seatId: string;
  seatName: string;
} | null;

const providerOrder = ["deepseek", "openai", "openai-compatible", "openai-codex", "kimi", "glm", "glmcodingplan", "gemini", "anthropic"];
const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh"
};

function defaultSeats(mode: Mode): CreateMatchSeat[] {
  if (mode === "pure-ai") {
    return [
      { name: "DeepSeek V4 Flash", kind: "ai", providerId: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "high", strategy: "Fast recursive low-average pressure." },
      { name: "DeepSeek V4 Pro", kind: "ai", providerId: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "medium", strategy: "Deeper reasoning with medium effort for play stability." },
      { name: "GLM 5.2", kind: "ai", providerId: "glm", model: "glm-5.2", reasoningEffort: "high", strategy: "Rule-aware level-k estimate." },
      { name: "Kimi K2.7 Code", kind: "ai", providerId: "kimi", model: "kimi-k2.7-code", strategy: "Opponent modelling without provider-specific effort for stability." },
      { name: "Codex 5.5", kind: "ai", providerId: "openai-codex", model: "gpt-5.5", reasoningEffort: "high", strategy: "PackyAPI Codex reasoning pressure." }
    ];
  }

  return [
    { name: "Human", kind: "human", strategy: "Manual number entry." },
    { name: "DeepSeek V4", kind: "ai", providerId: "deepseek", model: "deepseek-v4-flash", strategy: "Recursive low-average pressure." },
    { name: "Kimi", kind: "ai", providerId: "kimi", model: "kimi-k2.6", strategy: "Opponent modelling and duplicate avoidance." },
    { name: "GLM Coding", kind: "ai", providerId: "glmcodingplan", model: "glm-coding-plan", strategy: "Programmatic minimax-style estimate." },
    { name: "Claude", kind: "ai", providerId: "anthropic", model: "claude-sonnet-4-5", strategy: "Conservative survival play." }
  ];
}

export default function App() {
  const [mode, setMode] = useState<Mode>("pure-ai");
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [seatConfigs, setSeatConfigs] = useState<CreateMatchSeat[]>(() => defaultSeats("pure-ai"));
  const [match, setMatch] = useState<MatchState | null>(null);
  const [humanNumber, setHumanNumber] = useState(20);
  const [autoRounds, setAutoRounds] = useState(3);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Booting arena.");
  const [error, setError] = useState("");
  const [planDialog, setPlanDialog] = useState<PlanDialog>(null);
  const [streamDialog, setStreamDialog] = useState<StreamDialog>(null);
  const [seatProgress, setSeatProgress] = useState<Record<string, SeatProgress>>({});
  const [roundStartedAt, setRoundStartedAt] = useState<number | null>(null);
  const [roundElapsedMs, setRoundElapsedMs] = useState(0);
  const [lastRoundElapsedMs, setLastRoundElapsedMs] = useState<number | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const providerData = await fetchProviders();
        if (cancelled) {
          return;
        }
        setProviders(providerData);
        const initialSeats = defaultSeats("pure-ai");
        setSeatConfigs(initialSeats);
        const initialMatch = await createMatch(initialSeats);
        if (!cancelled) {
          setMatch(initialMatch);
          setStatus("Pure AI match ready. Run round one.");
        }
      } catch (err) {
        setError(messageOf(err));
      }
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!busy || !roundStartedAt) {
      return;
    }
    const timer = window.setInterval(() => {
      setRoundElapsedMs(Date.now() - roundStartedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy, roundStartedAt]);

  const activeRules = useMemo(() => rulesFor(match), [match]);
  const lastRound = match?.rounds[match.rounds.length - 1];
  const visibleAverage = !busy && lastRound ? formatNumber(lastRound.average) : "";
  const visibleTarget = !busy && lastRound ? formatNumber(lastRound.target) : "";
  const visibleThinkTime = busy && roundStartedAt
    ? formatElapsed(roundElapsedMs)
    : lastRoundElapsedMs !== null
      ? formatElapsed(lastRoundElapsedMs)
      : "--";
  const activeHuman = match?.seats.find((seat) => seat.kind === "human" && seat.status === "active");
  const activeAiCount = match?.seats.filter((seat) => seat.kind === "ai" && seat.status === "active").length ?? 0;
  const sortedProviders = useMemo(() => {
    return [...providers].sort((a, b) => providerSortIndex(a.id) - providerSortIndex(b.id));
  }, [providers]);

  async function withBusy(action: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setBusy(true);
    setError("");
    try {
      await action(controller.signal);
    } catch (err) {
      if (isAbortError(err)) {
        setStatus("Run cancelled. Start a new match if you want a clean state.");
      } else {
        setError(messageOf(err));
      }
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }
      setBusy(false);
    }
  }

  function cancelRun() {
    activeRequestRef.current?.abort();
    setPlanDialog(null);
    setStreamDialog(null);
    setStatus("Cancelling current run...");
  }

  function switchMode(nextMode: Mode) {
    setMode(nextMode);
    setSeatConfigs(defaultSeats(nextMode));
    resetRoundUi();
    setStatus(nextMode === "pure-ai" ? "Pure AI slate staged." : "Human plus AI slate staged.");
  }

  async function startMatch() {
    await withBusy(async (signal) => {
      setPlanDialog(null);
      setStreamDialog(null);
      resetRoundUi();
      const next = await createMatch(seatConfigs);
      setMatch(next);
      setStatus("New match created.");
    });
  }

  async function submitAndResolve() {
    if (!match || !activeHuman) {
      return;
    }
    await withBusy(async (signal) => {
      beginRoundUi(match);
      await submitHuman(match.id, activeHuman.id, humanNumber, signal);
      const next = await runRoundStream(match.id, handleRoundStreamEvent, signal);
      setMatch(next);
      setStatus(next.status === "complete" ? "Game clear. Winner locked." : `Round ${next.rounds.length} resolved.`);
    });
  }

  async function runOneRound() {
    if (!match) {
      return;
    }
    await withBusy(async (signal) => {
      beginRoundUi(match);
      const next = await runRoundStream(match.id, handleRoundStreamEvent, signal);
      setMatch(next);
      setStatus(next.status === "complete" ? "Game clear. Winner locked." : `Round ${next.rounds.length} resolved.`);
    });
  }

  async function runAuto() {
    if (!match) {
      return;
    }
    await withBusy(async (signal) => {
      setPlanDialog(null);
      setStreamDialog(null);
      let next = match;
      const rounds = Math.max(1, Math.min(50, Math.round(autoRounds)));
      for (let index = 0; index < rounds; index += 1) {
        if (signal.aborted) {
          setStatus(`Auto-run cancelled after ${next.rounds.length} rounds.`);
          return;
        }
        beginRoundUi(next);
        setStatus(`Auto-run ${index + 1}/${rounds}: waiting for ${activeAiCount} AI players...`);
        next = await runRoundStream(next.id, handleRoundStreamEvent, signal);
        setMatch(next);
        if (next.status === "complete") {
          setStatus("Game clear. Winner locked.");
          return;
        }
        setStatus(`Round ${next.rounds.length} resolved. Auto-run ${index + 1}/${rounds}.`);
      }
      setStatus(`${rounds} round auto-run complete.`);
    });
  }

  async function pingProvider(provider: ProviderPreset) {
    await withBusy(async () => {
      const decision = await testProvider(provider.id, provider.defaultModel);
      setStatus(`${provider.label} test returned ${decision.number}: ${decision.rationale}`);
    });
  }

  function updateSeat(index: number, patch: Partial<CreateMatchSeat>) {
    setSeatConfigs((current) => current.map((seat, seatIndex) => (
      seatIndex === index ? { ...seat, ...patch } : seat
    )));
  }

  function resetRoundUi() {
    setSeatProgress({});
    setRoundStartedAt(null);
    setRoundElapsedMs(0);
    setLastRoundElapsedMs(null);
  }

  function beginRoundUi(currentMatch: MatchState) {
    const startedAt = Date.now();
    setPlanDialog(null);
    setStreamDialog(null);
    setRoundStartedAt(startedAt);
    setRoundElapsedMs(0);
    setLastRoundElapsedMs(null);
    setSeatProgress(Object.fromEntries(currentMatch.seats
      .filter((seat) => seat.kind === "ai" && seat.status === "active")
      .map((seat) => [seat.id, {
        status: "thinking" as const,
        stream: [
          `Round ${currentMatch.rounds.length + 1} started.`,
          "Rules and public history sent. Waiting for provider response.",
          "Public status stream only; private chain-of-thought is not exposed."
        ]
      }])));
    const aiCount = currentMatch.seats.filter((seat) => seat.kind === "ai" && seat.status === "active").length;
    setStatus(`Waiting for ${aiCount} AI players to think...`);
  }

  function handleRoundStreamEvent(event: RoundStreamEvent) {
    if (event.type === "round-start") {
      setRoundStartedAt(event.startedAt);
      setRoundElapsedMs(0);
      return;
    }

    if (event.type === "seat-start") {
      setSeatProgress((current) => ({
        ...current,
        [event.seatId]: {
          status: "thinking",
          stream: [
            ...(current[event.seatId]?.stream ?? []),
            `${event.seatName}: request opened${event.model ? ` (${event.model})` : ""}.`
          ]
        }
      }));
      return;
    }

    if (event.type === "seat-done") {
      setSeatProgress((current) => ({
        ...current,
        [event.seatId]: {
          status: "done",
          number: event.submission.number,
          rationale: event.submission.rationale,
          elapsedMs: event.elapsedMs,
          stream: [
            ...(current[event.seatId]?.stream ?? []),
            `Decision sealed at ${formatElapsed(event.elapsedMs)}.`,
            "Pick is hidden until every active player has finished."
          ]
        }
      }));
      return;
    }

    if (event.type === "round-complete") {
      setLastRoundElapsedMs(event.elapsedMs);
      setRoundStartedAt(null);
      setRoundElapsedMs(event.elapsedMs);
      setMatch(event.match);
      const latestRound = event.match.rounds[event.match.rounds.length - 1];
      setSeatProgress((current) => {
        const next = { ...current };
        for (const submission of latestRound?.submissions ?? []) {
          next[submission.seatId] = {
            ...(next[submission.seatId] ?? { status: "done", stream: [] }),
            status: "done",
            number: submission.number,
            rationale: submission.rationale,
            stream: [
              ...(next[submission.seatId]?.stream ?? []),
              `Round complete at ${formatElapsed(event.elapsedMs)}.`,
              `Revealed pick: ${submission.number}.`,
              submission.rationale ? `Public reason: ${submission.rationale}` : "No public reason returned."
            ]
          };
        }
        return next;
      });
    }
  }

  return (
    <main className="app-shell">
      <section className="topline">
        <div>
          <p className="section-label">AI STRATEGY ARENA</p>
          <h1>KING OF DIAMONDS</h1>
        </div>
        <div className="formula">
          <span>Target = average x 0.8</span>
          <strong>{lastRound ? formatNumber(lastRound.target) : "pending"}</strong>
        </div>
      </section>

      <section className="game-grid">
        <aside className="left-rail panel">
          <div className="panel-title">
            <span>Match Setup</span>
            <small>{match?.status ?? "loading"}</small>
          </div>

          <div className="mode-switch" role="group" aria-label="Match mode">
            <button className={mode === "human-ai" ? "active" : ""} onClick={() => switchMode("human-ai")} disabled={busy}>Human + AI</button>
            <button className={mode === "pure-ai" ? "active" : ""} onClick={() => switchMode("pure-ai")} disabled={busy}>Pure AI</button>
          </div>

          <div className="seat-config-list">
            {seatConfigs.map((seat, index) => (
              <div className="seat-config" key={`${seat.name}-${index}`}>
                <div className="seat-config-head">
                  <input
                    value={seat.name}
                    onChange={(event) => updateSeat(index, { name: event.target.value })}
                    aria-label={`Seat ${index + 1} name`}
                  />
                  <select
                    value={seat.kind}
                    onChange={(event) => updateSeat(index, { kind: event.target.value as Seat["kind"] })}
                    aria-label={`Seat ${index + 1} kind`}
                  >
                    <option value="human">Human</option>
                    <option value="ai">AI</option>
                    <option value="bot">Bot</option>
                  </select>
                </div>
                {seat.kind === "ai" ? (
                  <div className="provider-row">
                    <select
                      value={seat.providerId ?? ""}
                      onChange={(event) => {
                        const provider = providers.find((item) => item.id === event.target.value);
                        updateSeat(index, {
                          providerId: event.target.value,
                          model: provider?.defaultModel ?? seat.model,
                          reasoningEffort: nextReasoningEffort(provider, seat.reasoningEffort)
                        });
                      }}
                      aria-label={`Seat ${index + 1} provider`}
                    >
                      {sortedProviders.map((provider) => (
                        <option value={provider.id} key={provider.id}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={seat.model ?? ""}
                      onChange={(event) => updateSeat(index, { model: event.target.value })}
                      aria-label={`Seat ${index + 1} model`}
                      list={`seat-${index + 1}-models`}
                      placeholder="model"
                    />
                    <datalist id={`seat-${index + 1}-models`}>
                      {modelOptionsForSeat(seat, providers).map((model) => (
                        <option value={model} key={model} />
                      ))}
                    </datalist>
                    <select
                      value={seat.reasoningEffort ?? ""}
                      onChange={(event) => {
                        const value = event.target.value as ReasoningChoice;
                        updateSeat(index, { reasoningEffort: value || undefined });
                      }}
                      disabled={reasoningOptionsForSeat(seat, providers).length <= 1}
                      aria-label={`Seat ${index + 1} reasoning effort`}
                    >
                      {reasoningOptionsForSeat(seat, providers).map((option) => (
                        <option value={option.value} key={option.label}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <button className="primary-action" onClick={startMatch} disabled={busy}>New Match</button>

          <div className="provider-status">
            <div className="panel-title compact">
              <span>Providers</span>
              <small>server proxy</small>
            </div>
            {sortedProviders.map((provider) => (
              <button className="provider-pill" key={provider.id} onClick={() => pingProvider(provider)} disabled={busy || !provider.configured}>
                <span>{provider.label}</span>
                <b className={provider.configured ? "ok" : "missing"}>{provider.configured ? "ready" : "missing"}</b>
              </button>
            ))}
          </div>
        </aside>

        <section className="arena-wrap">
          <div className="arena panel">
            <div className="round-header">
              <div>
                <p className="section-label">Round {String((match?.rounds.length ?? 0) + 1).padStart(2, "0")}</p>
                <h2>{match?.status === "complete" ? "GAME CLEAR" : busy ? "AI Thinking" : "Submit Number"}</h2>
              </div>
              <div className="round-metrics" aria-live="polite">
                <div className={`metric-panel ${visibleTarget ? "resolved" : ""}`}>
                  <span>Target</span>
                  <strong>{visibleTarget || "--"}</strong>
                </div>
                <div className={`metric-panel ${visibleAverage ? "resolved" : ""}`}>
                  <span>Average</span>
                  <strong>{visibleAverage || "--"}</strong>
                </div>
                <div className={`metric-panel ${busy || lastRoundElapsedMs !== null ? "resolved" : ""}`}>
                  <span>Time</span>
                  <strong>{visibleThinkTime}</strong>
                </div>
              </div>
            </div>

            {busy ? (
              <div className="thinking-banner" role="status">
                <strong>AI players are thinking</strong>
                <small>Waiting for provider responses. Results will appear when every active AI has submitted.</small>
              </div>
            ) : null}

            <div className="table-stage" aria-label="Contestant table">
              <div className="seat-board">
                {(match?.seats ?? seatConfigs.map((seat, index) => ({
                  ...seat,
                  id: `preview_${index}`,
                  status: "active" as const,
                  score: 0
                }))).map((seat) => (
                  <ContestantSeat
                    key={seat.id}
                    seat={seat}
                    round={lastRound}
                    busy={busy}
                    progress={seatProgress[seat.id]}
                    onOpenPlan={setPlanDialog}
                    onOpenStream={(dialog) => setStreamDialog(dialog)}
                  />
                ))}
              </div>
            </div>

            <div className="control-deck">
              <div className="number-entry">
                <label htmlFor="number-input">Human pick</label>
                <input
                  id="number-input"
                  type="number"
                  min={0}
                  max={100}
                  value={humanNumber}
                  onChange={(event) => setHumanNumber(Number(event.target.value))}
                  disabled={busy || !activeHuman || match?.status === "complete"}
                />
              </div>
              <button className="primary-action" onClick={submitAndResolve} disabled={busy || !activeHuman || match?.status === "complete"}>
                Submit Number
              </button>
              <button onClick={runOneRound} disabled={busy || Boolean(activeHuman) || !match || match.status === "complete"}>
                {busy ? "Thinking..." : "Run Round"}
              </button>
              <div className="auto-run">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={autoRounds}
                  onChange={(event) => setAutoRounds(Number(event.target.value))}
                  aria-label="Auto run rounds"
                />
                <button onClick={runAuto} disabled={busy || Boolean(activeHuman) || !match || match.status === "complete"}>{busy ? "Thinking..." : "Auto Run"}</button>
              </div>
              <button className="cancel-action" onClick={cancelRun} disabled={!busy}>
                Cancel
              </button>
            </div>
          </div>

          <ScoreTrack match={match} />
        </section>

        <aside className="right-rail panel">
          <RuleShift rules={activeRules} eliminated={match?.seats.filter((seat) => seat.status !== "active").length ?? 0} />
          <HistoryPanel rounds={match?.rounds ?? []} seats={match?.seats ?? []} />
          <div className="event-log">
            <div className="panel-title compact">
              <span>Event Log</span>
              <small>{busy ? "thinking" : "live"}</small>
            </div>
            {busy ? (
              <p className="thinking-line">Active AI requests in progress</p>
            ) : null}
            <p className="status-line">{error || status}</p>
            {lastRound?.events.slice(-5).map((event) => (
              <p key={event}>{replaceSeatIds(event, match?.seats ?? [])}</p>
            ))}
          </div>
        </aside>
      </section>
      {planDialog ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setPlanDialog(null)}>
          <section className="plan-modal" role="dialog" aria-modal="true" aria-labelledby="plan-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <p className="section-label">AI REASON</p>
                <h2 id="plan-title">{planDialog.seatName}</h2>
              </div>
              <button className="icon-action" onClick={() => setPlanDialog(null)} aria-label="Close reason dialog">x</button>
            </div>
            <div className="plan-meta">
              <span>{planDialog.provider}</span>
              <span>Pick {planDialog.pick}</span>
            </div>
            <p>{planDialog.rationale}</p>
          </section>
        </div>
      ) : null}
      {streamDialog ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setStreamDialog(null)}>
          <section className="plan-modal stream-modal" role="dialog" aria-modal="true" aria-labelledby="stream-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <p className="section-label">PUBLIC STREAM</p>
                <h2 id="stream-title">{streamDialog.seatName}</h2>
              </div>
              <button className="icon-action" onClick={() => setStreamDialog(null)} aria-label="Close stream dialog">x</button>
            </div>
            <div className="stream-log">
              {(seatProgress[streamDialog.seatId]?.stream ?? ["No stream events yet."]).map((line, index) => (
                <p key={`${streamDialog.seatId}-${index}`}>{line}</p>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function ContestantSeat({
  seat,
  round,
  busy,
  progress,
  onOpenPlan,
  onOpenStream
}: {
  seat: Seat;
  round?: RoundResult;
  busy: boolean;
  progress?: SeatProgress;
  onOpenPlan: (dialog: PlanDialog) => void;
  onOpenStream: (dialog: StreamDialog) => void;
}) {
  const picked = round?.submissions.find((submission) => submission.seatId === seat.id);
  const isWinner = round?.winnerSeatIds.includes(seat.id);
  const thinkingState = progress?.status ?? (busy && seat.kind === "ai" && seat.status === "active"
    ? "thinking"
    : picked || seat.lastNumber !== undefined ? "done" : "idle");
  const isThinking = thinkingState === "thinking";
  const visibleNumber = busy ? undefined : progress?.number ?? picked?.number ?? seat.lastNumber;
  const rationale = progress?.rationale ?? seat.lastRationale ?? picked?.rationale ?? seat.strategy ?? "Awaiting strategy.";
  const hasPlan = seat.kind === "ai" && !busy && !isThinking && Boolean(rationale);
  const scoreDanger = Math.min(100, Math.abs(seat.score) * 10);
  return (
    <div className={`contestant-seat ${seat.kind}-seat ${seat.status} ${isWinner ? "winner" : ""} ${isThinking ? "thinking" : ""} ${thinkingState}`}>
      <div className="seat-head">
        <div className="seat-orb">{seat.kind.toUpperCase()}</div>
        <div>
          <strong>{seat.name}</strong>
          <span>{seat.providerId ?? seat.kind}</span>
        </div>
        {seat.kind === "ai" ? <em>{thinkingState}</em> : null}
      </div>
      <div className="seat-pick">
        <span>Pick</span>
        <b>{visibleNumber ?? "--"}</b>
      </div>
      <div className="seat-score">
        <span>Score {seat.score}</span>
        <i><mark style={{ width: `${scoreDanger}%` }} /></i>
      </div>
      <div className="seat-actions">
        <button
          className="reason-action"
          disabled={!hasPlan}
          onClick={() => onOpenPlan({
            seatName: seat.name,
            provider: seat.providerId ?? seat.kind,
            pick: visibleNumber !== undefined ? String(visibleNumber) : "--",
            rationale
          })}
        >
          Reason
        </button>
        {seat.kind === "ai" ? (
          <button
            className="stream-action"
            onClick={() => onOpenStream({ seatId: seat.id, seatName: seat.name })}
          >
            Stream
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RuleShift({ rules, eliminated }: { rules: ActiveRules; eliminated: number }) {
  return (
    <div className="rule-shift">
      <div className="panel-title compact">
        <span>Rule Shift</span>
        <small>{eliminated} eliminated</small>
      </div>
      <RuleItem label="Duplicate Rule" active={rules.duplicateInvalidation} detail="Same numbers become invalid." />
      <RuleItem label="Exact Target Rule" active={rules.exactTargetPenalty} detail="Exact hit makes others lose 2." />
      <RuleItem label="0 / 100 Final" active={rules.zeroHundredException} detail="In final duel, 100 beats 0." />
      <div className="score-floor">Score Floor -10</div>
    </div>
  );
}

function RuleItem({ label, active, detail }: { label: string; active: boolean; detail: string }) {
  return (
    <div className={`rule-item ${active ? "active" : ""}`}>
      <strong>{label}</strong>
      <span>{active ? "active" : "locked"}</span>
      <small>{detail}</small>
    </div>
  );
}

function HistoryPanel({ rounds, seats }: { rounds: RoundResult[]; seats: Seat[] }) {
  const names = new Map(seats.map((seat) => [seat.id, seat.name]));
  return (
    <div className="history-panel">
      <div className="panel-title compact">
        <span>Public History</span>
        <small>{rounds.length} rounds</small>
      </div>
      <div className="history-table">
        <div className="history-row head">
          <span>R</span>
          <span>Target</span>
          <span>Winner</span>
          <span>Picks</span>
        </div>
        {rounds.slice(-8).map((round) => (
          <div className="history-row" key={round.roundIndex}>
            <span>{round.roundIndex}</span>
            <span>{formatNumber(round.target)}</span>
            <span className="history-winner">{round.winnerSeatIds.map((id) => names.get(id) ?? id).join(", ") || "none"}</span>
            <span className="history-picks">
              {round.submissions.map((submission) => `${names.get(submission.seatId) ?? submission.seatId}: ${submission.number}`).join(" | ")}
            </span>
          </div>
        ))}
        {!rounds.length ? (
          <p className="empty-note">No public rounds yet.</p>
        ) : null}
      </div>
    </div>
  );
}

function ScoreTrack({ match }: { match: MatchState | null }) {
  const seats = match?.seats ?? [];
  return (
    <div className="score-track panel">
      <div className="track-scale" aria-hidden="true">
        {Array.from({ length: 11 }, (_, index) => (
          <span key={index}>{0 - index}</span>
        ))}
      </div>
      <div className="score-lanes">
        {seats.map((seat) => (
          <div className={`score-lane ${seat.status}`} key={seat.id}>
            <span>{seat.name}</span>
            <div className="score-line">
              <i style={{ left: `${Math.abs(seat.score) * 10}%` }} />
            </div>
            <b>{seat.score}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function rulesFor(match: MatchState | null): ActiveRules {
  const eliminated = match?.seats.filter((seat) => seat.status === "eliminated").length ?? 0;
  return {
    duplicateInvalidation: eliminated >= 1,
    exactTargetPenalty: eliminated >= 2,
    zeroHundredException: eliminated >= 3
  };
}

function providerSortIndex(providerId: string): number {
  const index = providerOrder.indexOf(providerId);
  return index === -1 ? providerOrder.length : index;
}

function modelOptionsForSeat(seat: CreateMatchSeat, providers: ProviderPreset[]): string[] {
  const provider = providers.find((item) => item.id === seat.providerId);
  return provider?.modelOptions?.length ? provider.modelOptions : provider?.defaultModel ? [provider.defaultModel] : [];
}

function reasoningOptionsForSeat(seat: CreateMatchSeat, providers: ProviderPreset[]): Array<{ value: ReasoningChoice; label: string }> {
  const provider = providers.find((item) => item.id === seat.providerId);
  const efforts = provider?.reasoningEffortOptions ?? [];
  return [
    { value: "", label: "Default" },
    ...efforts.map((effort) => ({ value: effort, label: reasoningLabels[effort] }))
  ];
}

function nextReasoningEffort(provider: ProviderPreset | undefined, current: ReasoningEffort | undefined): ReasoningEffort | undefined {
  if (!current || !provider?.reasoningEffortOptions?.includes(current)) {
    return undefined;
  }
  return current;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatElapsed(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function replaceSeatIds(value: string, seats: Seat[]): string {
  return seats.reduce((text, seat) => text.replaceAll(seat.id, seat.name), value);
}
