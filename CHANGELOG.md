# Changelog

## main-v0.2.0 - 2026-09-03

- Reorganized the repository into a repository-only `main` branch and standalone game branches.
- Published the 方片K (King of Diamonds) game on `方片k`.
- Added the One Poker game on `pokesolo`.
- Added bilingual branch discovery and checkout instructions.

## v0.1.0 - 2026-06-23

- Built the King of Diamonds browser game with React, Vite, and an Express server proxy.
- Added multi-provider AI player support for OpenAI-compatible endpoints, OpenAI Codex-style providers, DeepSeek, Kimi, GLM, Gemini AI Studio, and Anthropic.
- Added per-player provider, model, and reasoning-effort controls with server-side filtering for unsupported effort options.
- Added pure-AI and human-plus-AI match setup, round resolution, auto-run, cancellation, score tracking, public history, and public AI plan display.
- Configured local frontend and backend ports as `13444` and `13445`.
- Refined the game UI with transparent arena panels, compact controls, AI thinking/done badges, and readable per-round AI pick history.
