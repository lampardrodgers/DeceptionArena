# 方片K (King of Diamonds)

This branch contains the standalone browser-based AI strategy game **方片K (King of Diamonds)**. Players submit numbers, the target is calculated from the group average, and the closest player survives while others lose score. The app supports both human-vs-AI and pure-AI matches.

Chinese documentation: [README.zh-CN.md](./README.zh-CN.md)

## Features

- Pure AI and Human + AI match modes.
- Per-seat provider, model, and reasoning-effort selection.
- Server-side provider proxy so API keys stay out of the browser.
- Public AI plan display for readable, non-private rationale summaries.
- AI status badges: `IDLE`, `THINKING`, and `DONE`.
- Round history with every AI player's submitted number.
- Auto-run and cancel controls.
- Score track and progressive rule shifts.

## Supported AI Providers

- OpenAI API
- OpenAI-compatible third-party base URLs
- OpenAI Codex-style provider profile
- DeepSeek
- Kimi / Moonshot
- GLM
- GLM Coding Plan
- Gemini AI Studio API
- Anthropic Claude API

Reasoning effort is only sent when the selected provider advertises support for it. Unsupported effort values are filtered out by the server before requests are sent.

## Requirements

- Node.js 20+ recommended
- npm
- API keys for any remote AI providers you want to use

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://127.0.0.1:13444
```

Default ports:

- Frontend: `13444`
- Backend API: `13445`

## API Configuration

Create a local `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Common settings:

```env
PORT=13445
PROVIDER_TIMEOUT_MS=180000

DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro
DEEPSEEK_REASONING_EFFORTS=low,medium,high

KIMI_API_KEY=
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.7-code

GLM_API_KEY=
GLM_REASONING_EFFORTS=low,medium,high

OPENAI_CODEX_API_KEY=
OPENAI_CODEX_BASE_URL=
OPENAI_CODEX_MODEL=
OPENAI_CODEX_REASONING_EFFORTS=low,medium,high
```

Do not commit `.env`. It is already ignored by `.gitignore`.

### OpenAI-Compatible Providers

Use these variables for a generic third-party OpenAI-compatible endpoint:

```env
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_BASE_URL=
OPENAI_COMPAT_MODEL=
OPENAI_COMPAT_MODELS=
OPENAI_COMPAT_REASONING_PARAM=reasoning_effort
OPENAI_COMPAT_REASONING_EFFORTS=low,medium,high
```

Use these variables for the separate OpenAI Codex-style provider profile:

```env
OPENAI_CODEX_API_KEY=
OPENAI_CODEX_BASE_URL=
OPENAI_CODEX_MODEL=
OPENAI_CODEX_MODELS=
OPENAI_CODEX_REASONING_PARAM=reasoning_effort
OPENAI_CODEX_REASONING_EFFORTS=low,medium,high
```

## How to Play

1. Choose `Human + AI` or `Pure AI`.
2. Configure each AI seat's provider, model, and reasoning effort.
3. Click `New Match` so the current seat configuration takes effect.
4. In pure-AI mode, click `Run Round` or `Auto Run`.
5. In human mode, enter a number in `Human pick`, then submit.
6. Check `Public History` for each round's target, winner, and submitted numbers.
7. Expand `Public plan` on an AI card to read that AI's public rationale summary.

## Important Notes

- Changing provider/model/reasoning controls affects the next match. Click `New Match` after editing seat configuration.
- AI players receive the current game rules and public history. They do not receive other players' private reasoning.
- `Public plan` is a player-facing rationale summary, not private chain-of-thought.
- If a provider is not configured or fails, the game can fall back to local bot decisions.

## Scripts

```bash
npm run dev          # Start frontend and backend in development mode
npm run dev:client   # Start Vite frontend on 127.0.0.1:13444
npm run dev:server   # Start Express backend on PORT, default 13445
npm test             # Run Vitest tests
npm run build        # Type-check server and build frontend
npm run preview      # Run backend using local env
```

## Project Structure

```text
src/client/       React frontend
src/server/       Express API, match store, AI provider adapters
src/shared/       Shared types and deterministic game rules
public/assets/    Static visual assets
scripts/          Local smoke-test helpers
```

## Security

- API calls go through the backend proxy.
- Browser code does not need provider API keys.
- Keep secrets in `.env` only.
- `.env`, `node_modules`, and `dist` are ignored by Git.

## License

No license has been declared yet.
