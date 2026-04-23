# Recent Work

Recent commit:
- `f05120b` `feat: switch Sidekick to Groq and scaffold connectors`

## LLM provider switch

Changed:
- removed Anthropic-only runtime assumption
- added Groq-backed OpenAI-compatible chat call layer in `/Users/amirlankalmukhan/sidekick/sidekick/src/llm_config.ts`

Verified:
- TypeScript build passed
- live Groq smoke test passed during implementation

## Hardening work

Added:
- path traversal protection when writing generated files to disk
- allowlist filtering for external doc fetches in research
- bounded request parsing / better CORS handling in server

Files:
- `/Users/amirlankalmukhan/sidekick/sidekick/src/graph.ts`
- `/Users/amirlankalmukhan/sidekick/sidekick/src/server.ts`

## QA improvements

Added:
- persistent Chromium context for extension QA
- dynamic remote debugging port allocation
- real popup URL resolution from manifest
- extension ID discovery from service worker
- DevTools MCP diagnostics integration

Files:
- `/Users/amirlankalmukhan/sidekick/sidekick/src/graph.ts`
- `/Users/amirlankalmukhan/sidekick/sidekick/src/devtools_mcp.ts`

## Connector scaffolding

Added to graph:
- connector detection helper
- connector prompt contract
- deterministic files for connector config / Supabase / Stripe
- manifest patching helper

Generated files now may include:
- `lib/extensy-connectors/config.js`
- `lib/extensy-connectors/supabase.js`
- `lib/extensy-connectors/stripe.js`
- `SETUP_CONNECTORS.md`

Important design choice:
- Sidekick should treat connectors as optional capability, not a forced product requirement
- Extensy now sends connector context when appropriate
