# Changelog

## OnePoker-v0.1.9 - 2026-09-04

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
