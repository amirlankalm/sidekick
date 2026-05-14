/**
 * Distilled from /Users/amirlankalmukhan/.codex/skills/extension-ui/SKILL.md
 * Injected into ui_designer_node and design_brief_node system prompts.
 * Full skill: https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
 */
export const EXTENSION_UI_SKILL = `
## Extension UI Design Standard

### Surface Selection
- POPUP: quick actions, status, one-shot commands, toggles, capture/summarize. Max ~600px tall, no scroll unless unavoidable.
- SIDE PANEL: persistent workflows, chat-like assistance, multi-step review, cross-page context.
- OPTIONS PAGE: API keys, account settings, integrations, permission explanations. Clear groups, inline validation.
- INJECTED OVERLAY: only when UI must interact with page content, user-invoked, dismissible, visually separate from host.

### Popup Layout (mandatory structure)
1. Header — product mark, current state, one compact utility action
2. Primary action area — the single main thing the user opened for
3. Context strip — current tab / detected entity / sync status
4. Secondary controls — settings, history, mode
5. Footer — only for quiet settings link or usage limits

### Visual Rules
- Base palette: neutral surfaces, one restrained brand accent, clear borders, subtle shadows for layering only
- Typography: popup title 13–15px semibold, section labels 11–12px muted, body 12–14px, metadata 11px
- Spacing: strict 4px scale, strong whitespace rhythm, not every section boxed
- Icons: inline SVG with currentColor, familiar browser symbols. No emoji icons.
- Motion: minimal CSS transitions + :active transforms only. No framework animation tokens.

### HARD BANS (never produce these)
- Neon cyan, hot pink, electric violet, toxic green, or any saturated color with lightness >70% on dark
- Purple-to-blue AI gradients, violet-to-pink, cyan-to-indigo
- Glassmorphism as main visual language
- Colored glows / glow borders
- Hero sections, large decorative cards, full dashboard grids, marketing copy in popup/side panel
- Giant headings or hero-scale typography inside popup
- Decorative empty-state illustrations (big SVG art)
- Generic "AI sparkles" or robot motifs as primary decoration
- Oversized bubbly rounded cards
- Nested cards inside cards
- Full-page nav sidebar inside a popup
- Beige/cream lifestyle styling unless explicitly required
- "Welcome to the future of browsing" onboarding screens

### Required States — implement all of these, no exceptions
- Loading (specific message: "Generating summary", "Reading tab", NOT "Loading...")
- Empty (what is empty + why it matters + one direct action)
- Error (what failed + what user can do + optional technical detail behind disclosure)
- No permission / host permission missing
- API key missing → "Open Settings" prompt, not silent failure
- Offline / network error
- Quota exceeded / rate limited

### Button & Copy Rules
- Labels start with a verb: "Summarize tab", "Save highlight", "Copy result", "Connect workspace"
- Never use: "Continue", "Submit", "OK", "Do the thing", AI marketing copy
- Status copy is precise: "Connected", "Not signed in", "Running on this tab", "Sync failed"
- Error copy states what failed and what the user can do next

### Accessibility
- WCAG AA text contrast minimum
- All controls have accessible names
- Icon-only buttons have tooltips
- Keyboard navigation works (Enter for primary action, Esc for overlays)
- Click targets ≥32px in compact UIs
- No color-only state communication
- motion: prefers-reduced-motion respected

### Anti-Pattern Checklist (reject before finalizing)
- Does the first screen contain the real workflow? (not an onboarding or welcome screen)
- Does any component look like a resized web app page?
- Are there any dashboard metric cards in a 360px popup?
- Is primary action reachable without scrolling?
- Are auth, permission, loading, empty, and error states all handled?
`.trim();
