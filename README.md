# Sidekick Engine

Core LangGraph backend for **Extensy** — the autonomous Chrome Extension builder.

---

## How to Run

```bash
cd /Users/amirlankalmukhan/sidekick/sidekick

npx ts-node src/graph.ts
```

That's it. The pipeline will:
1. Plan the extension (architect)
2. Fetch docs from Nia (Max tier)
3. Generate all source files (coder)
4. QA test with Playwright (headless Chromium)
5. Generate a Terms of Service (legal)
6. Wire any third-party APIs (integration)
7. Package everything into a `.zip` inside `./output/`

---

## Change the Input Prompt

Edit the bottom of `src/graph.ts` — find the `initialState` object:

```ts
const initialState: Partial<ExtensyState> = {
  user_prompt: "Your extension idea here",
  subscription_tier: "max",   // "free" | "pro" | "max"
  planning_mode: true,
};
```

---

## Tiers

| Tier | Planning | Research (Nia) | Legal TOS | Integration | Model |
|------|----------|----------------|-----------|-------------|-------|
| `free` | ✗ | ✗ | ✗ | ✗ | Haiku |
| `pro`  | ✓ | ✗ | ✓ | ✗ | Sonnet |
| `max`  | ✓ | ✓ | ✓ | ✓ | Sonnet |

---

## Output

- **Extension ZIP** → `./output/<name>_<timestamp>.zip`
- **Unzipped files** → `./tmp/extension/` (used during QA)

---

## One-time Setup (already done)

```bash
npm install
npx playwright install chromium
```
