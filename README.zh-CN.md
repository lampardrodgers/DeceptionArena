# King of Diamonds（方片K）

这是 `king-of-diamonds` 分支中的独立游戏：一个基于浏览器的 AI 策略游戏，灵感来自“方片 K”数字博弈。玩家提交数字，系统根据所有玩家数字的平均值计算目标值，最接近目标的玩家获胜，其他玩家扣分。项目支持真人 + AI，也支持纯 AI 对局。

英文文档：[README.md](./README.md)

## 功能特性

- 支持 `Human + AI` 和 `Pure AI` 两种模式。
- 每个 AI 玩家都可以单独选择供应商、模型和思考程度。
- API Key 只放在后端 `.env`，前端不会直接暴露密钥。
- 每个 AI 卡片提供 `Public plan`，用于展示给玩家看的公开策略说明。
- 每个 AI 卡片右上角显示状态：`IDLE`、`THINKING`、`DONE`。
- 右侧历史记录显示每轮目标值、赢家和每个 AI 的出数。
- 支持单轮运行、自动运行和取消。
- 支持分数轨道和随淘汰人数变化的规则变更。

## 支持的 AI 供应商

- OpenAI API
- OpenAI-compatible 第三方接口
- OpenAI Codex 风格供应商配置
- DeepSeek
- Kimi / Moonshot
- GLM
- GLM Coding Plan
- Gemini AI Studio API
- Anthropic Claude API

`reasoning effort` 只有在对应供应商声明支持时才会实际发送。前端选择了不支持的值时，后端会自动过滤，避免请求失败。

## 环境要求

- 推荐 Node.js 20+
- npm
- 你想使用的 AI 供应商 API Key

## 快速启动

```bash
npm install
cp .env.example .env
npm run dev
```

打开：

```text
http://127.0.0.1:13444
```

默认端口：

- 前端：`13444`
- 后端 API：`13445`

## API 配置

先复制环境变量模板：

```bash
cp .env.example .env
```

常用配置示例：

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

不要提交 `.env`。项目已经在 `.gitignore` 中忽略 `.env` 和 `.env.*`。

### OpenAI-compatible 第三方接口

如果你使用第三方 OpenAI-compatible 平台，可以配置：

```env
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_BASE_URL=
OPENAI_COMPAT_MODEL=
OPENAI_COMPAT_MODELS=
OPENAI_COMPAT_REASONING_PARAM=reasoning_effort
OPENAI_COMPAT_REASONING_EFFORTS=low,medium,high
```

如果你想单独配置 OpenAI Codex 风格供应商，可以配置：

```env
OPENAI_CODEX_API_KEY=
OPENAI_CODEX_BASE_URL=
OPENAI_CODEX_MODEL=
OPENAI_CODEX_MODELS=
OPENAI_CODEX_REASONING_PARAM=reasoning_effort
OPENAI_CODEX_REASONING_EFFORTS=low,medium,high
```

## 怎么玩

1. 选择 `Human + AI` 或 `Pure AI`。
2. 在左侧为每个 AI 玩家选择供应商、模型和思考程度。
3. 修改配置后点击 `New Match`，让新配置真正进入当前对局。
4. 纯 AI 模式下点击 `Run Round` 或 `Auto Run`。
5. 真人模式下，在 `Human pick` 输入数字后提交。
6. 在右侧 `Public History` 查看每轮目标值、赢家和每个 AI 的出数。
7. 展开 AI 卡片里的 `Public plan`，可以看到该 AI 给玩家看的公开策略说明。

## 重要说明

- 左侧修改供应商、模型、思考程度后，需要点击 `New Match` 才会对新对局生效。
- AI 会收到当前游戏规则和公开历史记录。
- AI 不会看到其他玩家的私有思考过程。
- `Public plan` 是给玩家看的公开理由摘要，不是完整私有推理链。
- 如果某个供应商未配置或请求失败，游戏可以回退到本地 bot 决策，保证对局可继续。

## 常用命令

```bash
npm run dev          # 同时启动前端和后端
npm run dev:client   # 启动 Vite 前端，地址 127.0.0.1:13444
npm run dev:server   # 启动 Express 后端，默认端口 13445
npm test             # 运行 Vitest 测试
npm run build        # 类型检查并构建前端
npm run preview      # 使用本地环境变量运行后端
```

## 项目结构

```text
src/client/       React 前端
src/server/       Express API、对局状态、AI 供应商适配
src/shared/       共享类型和确定性游戏规则
public/assets/    静态视觉资源
scripts/          本地 smoke test 脚本
```

## 安全说明

- 所有 AI 请求都通过后端代理。
- 浏览器前端不需要也不应该持有供应商 API Key。
- 密钥只放在本地 `.env`。
- `.env`、`node_modules`、`dist` 都已被 Git 忽略。

## 许可证

当前项目尚未声明许可证。
