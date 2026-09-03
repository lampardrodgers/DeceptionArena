# Changelog

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
