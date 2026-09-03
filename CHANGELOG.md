# Changelog

## king-of-diamonds-v0.1.2 - 2026-09-03

- Renamed the standalone game branch from `方片k` to `king-of-diamonds`, matching the game's English name.
- Standardized the branch documentation and package version for the renamed release.

## v0.1.1 - 2026-09-03

- Published King of Diamonds (方片K) as a standalone game branch.
- Kept the bilingual game documentation and updated the package version for the branch release.

## v0.1.0 - 2026-06-23

- Built the King of Diamonds browser game with React, Vite, and an Express server proxy.
- Added multi-provider AI player support for OpenAI-compatible endpoints, OpenAI Codex-style providers, DeepSeek, Kimi, GLM, Gemini AI Studio, and Anthropic.
- Added per-player provider, model, and reasoning-effort controls with server-side filtering for unsupported effort options.
- Added pure-AI and human-plus-AI match setup, round resolution, auto-run, cancellation, score tracking, public history, and public AI plan display.
- Configured local frontend and backend ports as `13444` and `13445`.
- Refined the game UI with transparent arena panels, compact controls, AI thinking/done badges, and readable per-round AI pick history.
