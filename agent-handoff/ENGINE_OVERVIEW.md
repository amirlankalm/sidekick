# Sidekick Engine Overview

Repo path:
- `/Users/amirlankalmukhan/sidekick/sidekick`

## Purpose

Sidekick is the engine behind Extensy. It takes a prompt, runs a LangGraph pipeline, generates a Chrome extension codebase, validates it, and returns files/metadata over SSE.

## Main files

- `/Users/amirlankalmukhan/sidekick/sidekick/src/server.ts`
- `/Users/amirlankalmukhan/sidekick/sidekick/src/graph.ts`
- `/Users/amirlankalmukhan/sidekick/sidekick/src/llm_config.ts`
- `/Users/amirlankalmukhan/sidekick/sidekick/src/devtools_mcp.ts`
- `/Users/amirlankalmukhan/sidekick/sidekick/src/state.ts`

## Pipeline shape

Main graph:
1. initial router
2. architect node
3. researcher node
4. coder node
5. UI designer node
6. QA node
7. legal and integration fan-out
8. assembler

## Runtime

Current active LLM provider:
- Groq
- model default: `meta-llama/llama-4-scout-17b-16e-instruct`

Important env:
- `GROQ_API_KEY`
- `GROQ_MODEL`
- `NIA_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## Connector support

Sidekick now supports optional connector-aware scaffolding.

Current connector kinds:
- Supabase
- Stripe

Behavior:
- detects connector need from prompt/blueprint/research/source
- injects deterministic connector files
- patches manifest permissions/host permissions
- tells the model to wire against Extensy connector modules instead of inventing ad hoc integration code
