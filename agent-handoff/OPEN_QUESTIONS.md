# Open Questions / Next Work

## Highest-value next work

1. Refine connector prompting
- current implementation is good enough to scaffold
- likely needs more nuanced per-project metadata once Extensy persists connectors server-side

2. Revisit model/documentation references
- some comments and README text may still mention Claude / Anthropic
- engine runtime is now Groq-based

3. Improve integration node
- could become more deterministic and less model-dependent
- especially for auth/payment edge cases

4. Deeper QA
- current QA is materially better than before
- still worth adding richer popup path coverage and non-popup extension coverage

## Caveats

- Connector scaffolding exists only for Supabase and Stripe in engine output.
- GitHub is a product-level Extensy connector, not a generated extension runtime connector.
- Extensy and Sidekick need to stay aligned on connector naming and prompt contract.
