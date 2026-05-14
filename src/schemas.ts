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

export const DesignBriefSchema = z.object({
  designTokens: z.object({
    colors: z.object({
      primary:    z.string(),
      background: z.string(),
      surface:    z.string(),
      text:       z.string(),
      // Optional extended palette — present on Pro/Max, absent on Free
      border:  z.string().optional(),
      muted:   z.string().optional(),
      accent:  z.string().optional(),
      error:   z.string().optional(),
    }),
    borderRadius: z.string(),
    fontFamily:   z.string(),
    spacingUnit:  z.string(),
  }),
  componentHierarchy: z.array(
    z.object({
      name:     z.string(),
      children: z.array(z.string()),
    })
  ),
  layout:   z.enum(["popup", "sidebar", "side-panel", "fullpage"]),
  iconSet:  z.enum(["lucide", "inline-svg"]).default("inline-svg"),
  responsive: z.boolean(),
  darkMode:   z.enum(["class", "media-query", "none"]),
  // Which UI states must be implemented — validated by ui_designer_node
  requiredStates: z.array(z.string()).optional(),
});

export const SidekickPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(
    z.object({
      node: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      estimatedTokens: z.number(),
    })
  ),
});

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
