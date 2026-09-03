# DeceptionArena

DeceptionArena 是一个用于存放独立网页版游戏的 GitHub 仓库。`main` 分支只保留仓库级别的说明；每个具体游戏都维护在自己的分支中，并拥有独立的源码、依赖和 README。

## 游戏列表

| 游戏 | 分支 | 说明 |
| --- | --- | --- |
| King of Diamonds（方片K） | `king-of-diamonds` | 基于“方片 K”规则的多人 AI 数字策略游戏。 |
| One Poker — 开司·和也篇 | `OnePoker` | 基于 three.js 的 One Poker 网页版，真人对战 AI 和也。 |

## 获取具体游戏

克隆仓库后切换到想运行的游戏分支：

```bash
git clone https://github.com/lampardrodgers/DeceptionArena.git
cd DeceptionArena
git switch king-of-diamonds       # 或：git switch OnePoker
```

每个游戏分支的 `README.md` 都包含自己的启动方式和目录结构。游戏源码不会合并到 `main`，这样两个项目可以在同一个仓库中独立演进。

## 分支说明

- `main` — 仓库级别的项目说明和游戏分支索引。
- `king-of-diamonds` — 独立的 King of Diamonds / 方片K 项目。
- `OnePoker` — 独立的 One Poker 项目。

## 许可证

当前尚未声明许可证。
