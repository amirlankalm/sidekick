/**
 * Distilled from /Users/amirlankalmukhan/.codex/skills/extension-ui/SKILL.md
 * Injected into ui_designer_node and design_brief_node system prompts.
 * Full skill: https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
 */
export const EXTENSION_UI_SKILL = `
## Extension UI Design Standard

Design Chrome extension interfaces that feel native to the browser context: compact, fast, credible, and purpose-built. Optimize for constrained surfaces, repeated use, and user trust.

Extension UI is a TOOL SURFACE, not a marketing page. A strong popup is dense enough to be useful in a small viewport, calm enough to sit beside real webpages, clear about state and errors, fast to scan in under three seconds, specific to the extension's job.

### Surface Selection
- POPUP: quick actions, status, one-shot commands, toggles, capture/summarize. Max ~600px tall, 320–420px wide, no scroll unless unavoidable.
- SIDE PANEL: persistent workflows, chat-like assistance, multi-step review, cross-page context.
- OPTIONS PAGE: API keys, account settings, integrations, permission explanations. Clear groups, inline validation.
- INJECTED OVERLAY: only when UI must interact with page content, user-invoked, dismissible, visually separate from host.

### Popup Layout (mandatory structure)
1. Header — product mark MAX 36×36px, extension name, current state. ONE utility action max.
2. Primary action area — the single main thing the user opened for. Must be visible without scrolling.
3. Context strip — current tab / detected entity / sync status
4. Secondary controls — settings, history, mode
5. Footer — only for quiet settings link or usage limits

### Visual Rules
- Base palette: neutral surfaces, one restrained brand accent, clear borders, subtle shadows for layering only
- Typography: popup title 13–15px semibold, section labels 11–12px muted, body 12–14px, metadata 11px
- Spacing: strict 4px scale, strong whitespace rhythm, not every section boxed
- Icons: inline SVG with currentColor, MAX 24×24px for body icons, MAX 20×20px for inline icons. Familiar browser symbols only. No emoji icons.
- Product mark in header: MAX 36×36px container, MAX 20×20px icon inside. White icon on dark background.
- Motion: minimal CSS transitions + :active transforms only. No framework animation tokens.

### Icon and Logo Rules (CRITICAL)
- The header product mark MUST be at most 36×36px total.
- SVG icons in popup body: max 24×24px. Never wider than 32px.
- NEVER create a large letterform (A–Z) as the primary visual. A single giant letter is not a logo — it is a broken UI.
- NEVER use an SVG <text> element as a logo or icon.
- NEVER fill more than 30% of the popup height with decorative art, logos, or brand elements.
- NEVER create a hero section with an oversized icon as the first visible element.
- Brand marks that fill the popup are a CRITICAL failure — the popup should open directly into the user workflow.

### HARD BANS (never produce these)
- Neon cyan, hot pink, electric violet, toxic green, or any saturated color with lightness >70% on dark
- Purple-to-blue AI gradients, violet-to-pink, cyan-to-indigo
- Glassmorphism as main visual language
- Colored glows / glow borders
- Hero sections, large decorative cards, full dashboard grids, marketing copy in popup/side panel
- Giant headings or hero-scale typography inside popup (never font-size > 20px in popup content)
- Decorative empty-state illustrations (big SVG art)
- Generic "AI sparkles" or robot motifs as primary decoration
- Oversized bubbly rounded cards
- Nested cards inside cards
- Full-page nav sidebar inside a popup
- Beige/cream lifestyle styling unless explicitly required
- "Welcome to the future of browsing" onboarding screens
- Single-letter brand marks larger than 36×36px
- Any logo, icon, or decorative SVG taller than 80px in the popup
- SVG width or height attributes set to values above 80 in the popup UI
- Full-bleed hero art or illustration as the popup's primary content
- Using font-size above 24px for any heading or label in the popup

### Required States — implement all of these, no exceptions
- Loading (specific message: "Generating summary", "Reading tab", NOT "Loading...")
- Empty (what is empty + why it matters + one direct action)
- Error (what failed + what user can do + optional technical detail behind disclosure)
- No permission / host permission missing
- API key missing → "Open Settings" prompt, not silent failure
- Offline / network error
- Quota exceeded / rate limited

### Information Architecture
For popup and side panel UIs, surface these when relevant:
- Current tab domain and page title
- Auth status and permission status
- Last run result
- Rate limit or quota state

A user should immediately know: what the extension sees, what it can do now, whether it is connected, whether the action succeeded, what to do if it failed.

### Button & Copy Rules
- Labels start with a verb: "Summarize tab", "Save highlight", "Copy result", "Connect workspace"
- Never use: "Continue", "Submit", "OK", "Do the thing", AI marketing copy
- Status copy is precise: "Connected", "Not signed in", "Running on this tab", "Sync failed"
- Error copy states what failed and what the user can do next
- Loading copy is specific: "Generating summary", "Reading tab" — never just "Loading..."

### Accessibility
- WCAG AA text contrast minimum
- All controls have accessible names
- Icon-only buttons have tooltips
- Keyboard navigation works (Enter for primary action, Esc for overlays)
- Click targets ≥32px in compact UIs
- No color-only state communication
- motion: prefers-reduced-motion respected

### Anti-Pattern Checklist (reject before finalizing)
- Does the first visible screen contain the REAL user workflow — not an onboarding, welcome, or splash screen?
- Does any element look like a resized web app hero or landing page section?
- Are there any dashboard metric cards in a 360px popup?
- Is primary action reachable without scrolling?
- Are auth, permission, loading, empty, and error states all handled?
- Does any logo/icon/SVG take up more than 30% of the popup height? → REJECT.
- Is there a single giant letter (A–Z) as the primary visual? → REJECT.
- Is any font-size above 24px used in the popup? → REJECT.
- Is any SVG element wider or taller than 80px? → REJECT.
- Is the popup opening directly into the user workflow? → MUST be YES.
`.trim();
