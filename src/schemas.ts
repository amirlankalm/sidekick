/**
 * schemas.ts — Zod runtime schemas for all LLM-generated payloads
 *
 * TypeScript types are compile-time only. These schemas validate LLM output
 * at runtime so a malformed completion fails fast with a clear error rather
 * than silently corrupting downstream state.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Blueprint — produced by architect_node
// ---------------------------------------------------------------------------

export const BlueprintSchema = z.object({
  name:             z.string().min(1, "name is required"),
  description:      z.string().min(1, "description is required"),
  permissions:      z.array(z.string()).default([]),
  host_permissions: z.array(z.string()).default([]),
  features: z.array(
    z.object({
      id:                  z.string(),
      summary:             z.string(),
      implementation_hint: z.string().optional(),
    })
  ).default([]),
  design_profile:   z.string().optional(),
  connectors:       z.array(z.enum(["supabase", "stripe"])).optional(),
  raw_requirements: z.string().default(""),
});

export type ValidatedBlueprint = z.infer<typeof BlueprintSchema>;

// ---------------------------------------------------------------------------
// SourceCode — produced by coder_node and ui_designer_node
// ---------------------------------------------------------------------------

export const SourceCodeSchema = z.record(z.string(), z.string());

export type ValidatedSourceCode = z.infer<typeof SourceCodeSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates a parsed JSON object against a Zod schema.
 * Returns `{ success: true, data }` or `{ success: false, error }`.
 */
export function validateSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    error: result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}
