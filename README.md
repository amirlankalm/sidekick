# 🦸‍♂️ Sidekick Engine

> **The autonomous Chrome Extension builder backend for [Extensy](https://extensy.app).**

Sidekick is a powerful, agentic workflow built on top of [LangGraph](https://langchain-ai.github.io/langgraph/). It orchestrates multiple LLM-powered nodes (architect, researcher, coder, UI designer, QA, and legal) to automatically generate, style, test, and package production-ready Chrome Extensions.

---

## 🏗️ Architecture & Workflow

Sidekick doesn't just write code; it plans, tests, and refines it. Here is the lifecycle of a single extension generation request:

```mermaid
flowchart TD
    %% Define Styles
    classDef initStyle fill:#333,stroke:#666,stroke-width:2px,color:#fff
    classDef coreStyle fill:#0052CC,stroke:#003D99,stroke-width:2px,color:#fff
    classDef qaStyle fill:#FF8C00,stroke:#CC7000,stroke-width:2px,color:#fff
    classDef passStyle fill:#008000,stroke:#006600,stroke-width:2px,color:#fff
    classDef errStyle fill:#D32F2F,stroke:#A12424,stroke-width:2px,color:#fff

    Start([Start]) --> InitialRouter{Initial Router}
    
    InitialRouter -- "Free / No Planning" --> Coder["Coder Node"]
    InitialRouter -- "Pro / Max" --> Architect["Architect Node<br/>(Planning)"]
    
    Architect --> ResearchRouter{Research Router}
    
    ResearchRouter -- "Max Tier" --> Researcher["Researcher Node<br/>(Nia Context)"]
    ResearchRouter -- "Pro / Free" --> Coder
    
    Researcher --> Coder:::coreStyle
    
    Coder --> UIDesignerRouter{UI Router}
    
    UIDesignerRouter -- "Free" --> QA["QA Node<br/>(Playwright)"]
    UIDesignerRouter -- "Pro / Max" --> UIDesigner["UI Designer Node<br/>(Styling)"]:::coreStyle
    
    UIDesigner --> QA:::qaStyle
    
    QA --> QARouter{QA Router}
    
    QARouter -- "Errors Found" --> Coder
    QARouter -- "Pass / Max Retries" --> FanOutRouter{Fan Out Router}
    
    FanOutRouter -- "Free Tier" --> Assembler["Assembler Node<br/>(ZIP Creation)"]
    FanOutRouter -- "Pro Tier" --> Legal["Legal Node<br/>(Terms of Service)"]
    FanOutRouter -- "Max Tier" --> ParallelHub(("Parallel<br/>Hub"))
    
    ParallelHub --> Legal
    ParallelHub --> Integration["Integration Node<br/>(3rd Party APIs)"]
    
    Legal --> Assembler:::passStyle
    Integration --> Assembler
    
    Assembler --> End([End])

    %% Assign Classes
    class Start,End initStyle
```

### 🧠 Nodes Explained

- **`architect_node`**: Extracts a structured blueprint (permissions, features) from the user's raw prompt using `claude-sonnet-4-5`.
- **`researcher_node`**: Augments the context by retrieving high-quality Chrome MV3 patterns and UI examples from the **Nia API**.
- **`coder_node`**: The heavy lifter. It writes the `manifest.json`, background workers, and content scripts.
- **`ui_designer_node`**: Refines generated HTML/CSS/JS files, injecting modern aesthetics (glassmorphism, micro-animations, dark mode) into the extension.
- **`qa_node`**: Launches a headless Playwright Chromium instance, loads the unpacked extension, and captures any console errors or crashes.
- **`legal_node`**: Generates a standard Terms of Service document for the extension and uploads it to Supabase.
- **`integration_node`**: Reviews the codebase for third-party API usage and automatically injects rate-limiting, error handling, and API client wrappers.
- **`assembler_node`**: Packs the finalized source code into a ready-to-publish `.zip`.

---

## 🚀 Quick Start

### 1. Prerequisites
Ensure your `.env` is populated with the necessary keys (Anthropic, Supabase, Nia). The dependencies are already installed:
```bash
npm install
npx playwright install chromium
```

### 2. Running the Engine
You can run the full pipeline locally. The engine is written in TypeScript and executed via `ts-node`:
```bash
cd /Users/amirlankalmukhan/sidekick/sidekick
npx ts-node src/graph.ts
```

### 3. Modifying the Input Prompt
To test different extension ideas, edit the `initialState` object at the bottom of `src/graph.ts`:

```typescript
const initialState: Partial<ExtensyState> = {
  user_prompt: "Build an extension that replaces all images with pictures of capybaras.",
  subscription_tier: "max",   // Options: "free" | "pro" | "max"
  planning_mode: true,        // Toggle architect mode
};
```

---

## 💎 Subscription Tiers

Sidekick dynamically routes graphs and chooses LLMs (`Haiku` vs `Sonnet`) based on the user's subscription tier to balance capability and cost-efficiency.

| Feature / Tier | \`Free\` 🐣 | \`Pro\` 🚀 | \`Max\` 👑 |
| :--- | :---: | :---: | :---: |
| **Model** | `claude-haiku-4-5` | `claude-sonnet-4-5` | `claude-sonnet-4-5` |
| **Planning Module** | ❌ | ✅ | ✅ |
| **UI Aesthetics** | ❌ | ✅ | ✅ |
| **Playwright QA** | ❌ | ✅ | ✅ |
| **Legal / TOS** | ❌ | ✅ | ✅ |
| **Nia Search** | ❌ | ❌ | ✅ |
| **API Wiring** | ❌ | ❌ | ✅ |

---

## 📂 Output Structure

After a successful run, Sidekick outputs the following artifacts:

- **Extension Archive**: `./output/<name>_<timestamp>.zip` (Ready for the Chrome Web Store)
- **Raw Files**: `./tmp/extension/` (Used by Playwright for live QA testing)
- **Legal Document**: A public Supabase URL mapped into the `LEGAL.txt` folder inside the generated ZIP.

> **Note on Vercel:** When `VERCEL=1`, the builder avoids disk writes (creating purely in-memory buffers) and uses `@sparticuz/chromium` for serverless Playwright execution.
