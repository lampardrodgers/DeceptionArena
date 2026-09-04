# Changelog

## OnePoker-v0.1.12 - 2026-09-04

- Card selection is now solved jointly with betting (`selectionPolicy` in `src/ai/bot.ts`): from Kaiji's point of view every two-card holding consistent with the bot's lights is enumerated, and a regret-matching fixed point (6 rounds of range solve + per-pair evaluation, 2% floor per choice) decides how often each pair plays its UP or DOWN card. The solver's "what Kaiji thinks I might have played" range is aggregated from that policy instead of the flat per-lights prior, `botSelect` samples from it and `botBet` reuses it, so the bluffs the solver plans are bluffs the bot actually makes.
- The value of the card kept for the next round is estimated with the same range solver (`src/ai/futureValue.ts`, replacing the deleted best-response tree `src/ai/bettingTree.ts`): one table per round (first mover × my next lights × Kaiji's next lights, at most 18 cached solves), valued in certainty-equivalent lives on the bot's own risk curve, discounted by 0.7 and measured against the average kept card. The old tree took the maximum over the bot's own actions and therefore overvalued keeping a big card by more than a whole life; with UP+DOWN in hand the bot played the small card 70.4% of the time (baseline 252-cell scan) and 73.9% in the cells where the big card was a certain win and the small card a certain loss. Now: 33% overall and 19% in those cells; the remaining exception is K+2 against DOWN2 lights, where bluff-raising the 2 while keeping the K (the best card to hold, since an A loses to a 2) is a deliberate line.
- Opponent model V2 (`src/ai/opponentModel.ts`): fold-to-raise and re-raise rates are learned per raise-size bucket (three buckets by fraction of the remaining stack) with hierarchical shrinkage to the per-strength rate and then to the prior, so the bot learns the opponent's price curve instead of assuming a fixed one; when Kaiji shows UP+DOWN, "which card he played × how he bet" is learned jointly (aggression and fold rates by category); model confidence is now contextual (`contextConfidence`: samples in the cells this decision actually reads, floor 0.15, cap 0.8), so the exploitative share of the solve grows only where the model has evidence.
- Solver: terminal values are given per played rank (the kept card differs), raise sizes deepen to {min, mid, all-in} with the raise cap raised along the real betting line (history + 2), execution pruning lowered from 3% to 0.5% (display pruning 2%) so low-frequency bluffs and slow-plays survive, `exploitability()` (NashConv) is available for the strict zero-sum setting, and off-path branches no longer inherit the deepened raise cap — a 30-life minimum-raise war made the tree exponential (71 s decisions, one 4 GB out-of-memory crash in the bench).
- Kaiji's copy in the solver values outcomes on its own curve (`PARAMS.oppEdge`; 0 = strict zero-sum, 0.5 = risk-neutral in lives, 0.9 = a copy of the bot's own caution). The strict zero-sum variant suggested by review was implemented and measured first: the negated concave curve makes the free copy a risk-seeking shover, the bot folds ~85–90% of raises, and head-to-head against v0.1.10 fell from 59% to 35–40%. A copy with the bot's own caution (0.9) restores parity but folds too readily without evidence, so the bot bluffed the small card in 48% of the "big card certain win, small card certain loss" cells. The default is now 0.5 (risk-neutral copy): head-to-head 24/40 at 12 lives, those cells at 19%; 0.7 measured the same head-to-head (46/80) with 26%.
- `PARAMS.edgeScaling` is now 0: the match-win curve keeps the 12-vs-12 shape at every life total. With 1 the 30-vs-30 curve required ~99.6% equity to call an all-in, the first player to shove collected the antes, and the bot lost 2/16 to v0.1.10 at 30 lives; with 0 it wins 13/32 over two seeds, the same as v0.1.11 (7/16), and beats the scripted opponents 46/50 in about half the rounds v0.1.11 needed. At 12 lives the two settings are identical.
- Bench (`src/ai/bench.test.ts`, `src/ai/sim.ts`, `src/ai/metrics.ts`): games, seeds, lives, opponents and thresholds come from `BENCH_*` environment variables, results are written as JSON with Wilson 95% intervals, four new scripted opponents (`minRaiseLadder`, `mixDownBluffer`, `onlineReader`, `trapper`), behaviour metrics (small-card rate with UP+DOWN, value extraction per strong hand, tell AUC, adaptation curve) and head-to-head against the v0.1.10 snapshot at 12 and 30 lives. Results for this version (12 lives, 40 games per opponent, seed 11): 506/600 against the 15 scripted opponents, every opponent above its gate (worst: `tellReader` and `minRaiseLadder` 30/40, best: `bluffer` 39/40); head-to-head against the v0.1.10 snapshot 24/40 at 12 lives and 13/32 at 30 lives; strong hands raise 81% of the time with sizes min/mid/all-in 19/62/19% and win 2.4 lives on average, weak hands bluff 15% (two thirds at the minimum size); tell readability (|AUC−0.5|×2) 0.19 against 0.48 for v0.1.10; NashConv of the strict zero-sum solve at 200 iterations is at most 0.3 lives (UP+DOWN vs UP+DOWN, 0.085 at 400) and ~0 elsewhere; decision latency on an idle machine: `botSelect` median 327 ms, `botBet` median 21 ms (max ~60 ms at 12 lives).
- Tests: `src/ai/selection.test.ts` (fixed point, 252-cell selection scan, doomed-cell rate), solver tests for the new tree/pruning/exploitability, model V2 tests; the short-stack call test uses a J instead of a 10 because Kaiji's general-sum copy shoves a narrower all-in range than the old best-response model did.

## OnePoker-v0.1.11 - 2026-09-04

- Replaced the built-in bot's root decision with a CFR+ / Restricted Nash Response solver (`src/ai/solver.ts`). The bot now solves the whole betting subgame for its **entire range** instead of picking the single best action for the one card it holds, so value hands and bluffs share the same raise sizes, strong hands occasionally check, and hands facing a raise defend at the pot-odds minimum. The old expected-value tree (`src/ai/bettingTree.ts`) is kept only for terminal valuation (`makeVal`, which still folds the kept card's next-round value into match-win probability).
- The solver mixes exploitation and safety with a standard Restricted Nash Response: a root chance node makes Kaiji play the learned opponent model with probability `p` and a freely-optimising copy with probability `1 - p`, where `p` is the opponent model's confidence, so the bot exploits a well-understood opponent and falls back towards equilibrium against an unfamiliar one. Both copies share one public tree via separate reach vectors, and each player is given his own risk-averse match-win utility rather than a zero-sum negation, which stops the underdog side from degenerating into shoving every hand.
- Betting decisions are now sampled from the solved average strategy (actions below 3% are pruned and the rest renormalised, sorted by probability so a fixed RNG still reproduces the most likely line); card selection scores each candidate by the solver's root value for that card, including the value of the card kept back. The AI thinking panel gained a range-strategy section: the RNR weight, how each rank in the range plays this spot, per-action expected values with Kaiji's fold rate, and Kaiji's view of the bot's range before and after the chosen action.
- Solver internals: strict per-engine game tree with a three-raise cap, raise-size abstraction (six representative sizes for the first raise, min/all-in deeper, with the real historical amounts always injected so the actual line keeps exact stakes), vectorised regret matching+ over all 13 ranks at once, Linear-CFR regret weighting with quadratic strategy averaging so 200 iterations suffice, alternating passes that only propagate the learning side's counterfactual values, an average-strategy floor and opponent freezing that keep unreachable infosets from propping up non-credible threats.
- Added `src/ai/solver.test.ts` covering range shape (bluffs and value bets in the same size, defence against a minimum raise, purity at `p = 1`, legality and normalisation of every infoset) and a solve-latency record.

## OnePoker-v0.1.10 - 2026-09-04

- Corrected the release metadata so the package version and changelog history match the published OnePoker updates.

## OnePoker-v0.1.9 - 2026-09-04

- Improved the mobile layout with a dynamic viewport, safe-area support, touch-friendly controls, responsive top-bar/actions, and dedicated portrait/landscape arrangements.
- Moved result banners below the top bar and resized table cards/action areas so they do not overlap on short mobile screens.
- Added the OnePoker deployment configuration for `onepoker.995003.xyz`.

## OnePoker-v0.1.8 - 2026-09-03

- Replaced the built-in heuristic with an algorithmic Kazuya bot (`src/ai/bot.ts`): card counting over the three-deck shoe and discard pile, Bayesian tracking of the card Kaiji keeps between rounds, per-player tendency models learned from match history (DOWN-from-mixed-hand preference, same-category card ordering, raise/fold/re-raise rates by hand strength, raise sizing), betting actions treated as evidence, and expected-value search over every legal bet with a two-ply opponent response model. Utility is match-win probability, so the bot declines marginal all-ins when ahead and gambles when short.
- Fixed unknown-card counting, which compared against a single 52-card deck and therefore never removed revealed or held cards; the LLM prompt's `unknownCardsByRank` and `estimatedWinProbability` now use the bot's card counter and belief model.
- The AI thinking panel now shows the built-in bot's reasoning (opponent model, inferred hand distribution, per-card and per-action EV) when no LLM is configured, and appends it when an LLM call falls back to the bot.
- Added `src/ai/bot.test.ts`: counting, betting, card-selection, opponent-modelling tests and a self-play simulation against random, calling-station, tight, and previous-heuristic opponents. Simulation helpers (scripted Kaiji strategies, a mirrored adapter that lets one bot version play as Kaiji against another) live in `src/ai/sim.ts`.
- Bot review follow-ups: the value of the card kept for the next round is now estimated per outcome of the current round (updated lives and first mover, zero when the match would end, measured against an average next round instead of in absolute terms), so a bot on its last life plays to survive; betting is searched as a depth-limited tree in which a call below the cap returns the action to the raiser (continuation bets, check-raises and re-raise lines are evaluated instead of approximating a call as a showdown), with a separately learned "raise again after being called" tendency; a call at the stake cap no longer counts as reluctance to re-raise, and opening/re-raise tendencies are only learned when raising was possible; the kept-card filter replays history with the unknown-card pool of each round; after a reshuffle the pool is the rebuilt shoe (revealed cards of the previous cycle) rather than the full three decks, with cards Kaiji kept across the reshuffle tracked separately; Kaiji's perceived strength counts a draw as half a win; the match-win utility is now parameterised explicitly (`PARAMS.matchEdge`, the assumed win probability at even stacks in a 12-vs-12 match, and `PARAMS.edgeScaling`, how that caution grows with the life total) and was calibrated by simulation: a near-risk-neutral setting collapsed to 3-8 rounds per match and lost 10-20 points, while the chosen 0.9 with per-life scaling wins about 83-95% against the scripted opponents at 12 lives and 92-95% at 30 lives, and beats the pre-review bot 65% (12 lives) and 77% (30 lives) head-to-head; opponent statistics decay exponentially so recent rounds weigh more.
- Engine: `GameState.reshuffles` records the rounds at which the exhausted deck was rebuilt from the discard pile.

## OnePoker-v0.1.7 - 2026-09-03

- Added streaming AI responses with a live thinking panel showing the prompt, reasoning/output stream, final decision, usage, cache hits, retries, and fallback errors.
- Added reasoning-effort controls for OpenAI-compatible, Anthropic, and Gemini providers, plus provider-specific finish-reason and token-usage handling.
- Added saved AI profiles, setup-time opponent summaries, and persisted provider/model/credential settings.
- Updated the betting flow so a call can be followed by a closing check or another raise, with matching prompt guidance and regression coverage.
- Added the One Poker web icon and expanded AI decision tests.

## OnePoker-v0.1.6 - 2026-09-03

- Added provider model discovery in AI settings, with connectivity checks and a selectable model list.
- Added support for listing models from OpenAI-compatible, Anthropic, and Gemini endpoints, including endpoint normalization for OpenAI-compatible chat URLs.

## OnePoker-v0.1.5 - 2026-09-03

- Added a timed, prominent banner for Kazuya's check, call, raise, and all-in actions while avoiding duplicate fold announcements.
- Preserved the action banner's cancellation behavior when a new game state supersedes the current round.

## OnePoker-v0.1.4 - 2026-09-03

- Added a prominent timed banner for Kazuya's check, call, raise, and all-in actions without duplicating the existing fold announcement.
- Corrected the face-down deck print orientation so card backs appear upright from the player's seat.
- Corrected played-card orientation so Kazuya's card faces his side of the table while the player's card faces the player.

## OnePoker-v0.1.3 - 2026-09-03

- Published the standalone One Poker — Kaiji Kazuya Arc game on the `OnePoker` branch.
- Moved the complete project from the repository's `pokesolo/` directory to the branch root for direct installation and development.
- Removed the unrelated shared Liar Game reference document from this standalone branch.
- Synchronized the project version with the branch release tag.
- Renamed the standalone game branch from `pokesolo` to `OnePoker`.
