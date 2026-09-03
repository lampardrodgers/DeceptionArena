# DeceptionArena

DeceptionArena is a shared GitHub repository for standalone browser games. The `main` branch contains only this repository-level description; each concrete game lives in its own branch with its own source, dependencies, and README.

## Games

| Game | Branch | Description |
| --- | --- | --- |
| King of Diamonds (方片K) | `king-of-diamonds` | A multiplayer AI number-strategy game based on the King of Diamonds format. |
| One Poker — Kaiji Kazuya Arc | `OnePoker` | A three.js browser implementation of One Poker, human versus an AI Kazuya. |

## Getting a game

Clone the repository and switch to the game branch you want to run:

```bash
git clone https://github.com/lampardrodgers/DeceptionArena.git
cd DeceptionArena
git switch king-of-diamonds       # or: git switch OnePoker
```

Each game branch has its own quick-start instructions and project structure in its `README.md`. The game code is intentionally not merged into `main`, so the two projects can evolve independently while sharing one repository.

## Branches

- `main` — repository-level description and branch index.
- `king-of-diamonds` — standalone King of Diamonds / 方片K project.
- `OnePoker` — standalone One Poker project.

## License

No license has been declared yet.
