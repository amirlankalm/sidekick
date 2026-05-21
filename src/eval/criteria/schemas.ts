/**
 * criteria/schemas.ts — Zod schema validation and LLM output robustness
 *
 * Ensures that every validateSchema call correctly accepts valid payloads,
 * rejects malformed ones, and that partial or edge-case LLM outputs are
 * handled gracefully rather than crashing the pipeline.
 */

import {
  validateSchema,
  BlueprintSchema,
  SourceCodeSchema,
  DesignBriefSchema,
  SidekickPlanSchema,
} from "../../schemas";
import type { EvalResult } from "../reporter";

// ─── Blueprint schema ─────────────────────────────────────────────────────────

export async function evalBlueprintAcceptsValid(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    name: "Focus Timer",
    description: "Pomodoro timer for Chrome.",
    permissions: ["activeTab", "alarms"],
    host_permissions: [],
    features: [{ id: "timer", summary: "25-minute countdown" }],
    raw_requirements: "Build a pomodoro timer",
  };
  const result = validateSchema(BlueprintSchema, payload);
  return {
    id: "schema_blueprint_valid",
    name: "BlueprintSchema → accepts well-formed payload",
    category: "critical",
    weight: 9,
    score: result.success ? 100 : 0,
    threshold: 100,
    passed: result.success,
    details: result.success ? "validation passed" : `error: ${(result as { error: string }).error}`,
  };
}

export async function evalBlueprintRejectsMissingName(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    // name intentionally missing
    description: "Missing name test",
    permissions: [],
    host_permissions: [],
    features: [],
    raw_requirements: "",
  };
  const result = validateSchema(BlueprintSchema, payload);
  const rejected = !result.success;
  return {
    id: "schema_blueprint_rejects_missing_name",
    name: "BlueprintSchema → rejects missing 'name' field",
    category: "critical",
    weight: 8,
    score: rejected ? 100 : 0,
    threshold: 100,
    passed: rejected,
    details: rejected ? "correctly rejected" : "unexpectedly passed — missing required field not caught",
  };
}

export async function evalBlueprintRejectsEmptyName(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    name: "",
    description: "Empty name test",
    permissions: [],
    host_permissions: [],
    features: [],
    raw_requirements: "",
  };
  const result = validateSchema(BlueprintSchema, payload);
  const rejected = !result.success;
  return {
    id: "schema_blueprint_rejects_empty_name",
    name: "BlueprintSchema → rejects empty string name",
    category: "critical",
    weight: 7,
    score: rejected ? 100 : 0,
    threshold: 100,
    passed: rejected,
    details: rejected ? "correctly rejected empty name" : "min(1) constraint not enforced",
  };
}

export async function evalBlueprintAllowsOptionalFields(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    name: "Minimal Ext",
    description: "Minimal valid blueprint",
    // permissions, host_permissions, features should default to []
    raw_requirements: "",
  };
  const result = validateSchema(BlueprintSchema, payload);
  const passed =
    result.success &&
    Array.isArray((result as { data: { permissions: unknown[] } }).data.permissions) &&
    Array.isArray((result as { data: { features: unknown[] } }).data.features);
  return {
    id: "schema_blueprint_defaults",
    name: "BlueprintSchema → applies defaults for optional arrays",
    category: "high",
    weight: 7,
    score: passed ? 100 : 0,
    threshold: 100,
    passed,
    details: passed ? "defaults applied correctly" : `result=${JSON.stringify(result).slice(0, 80)}`,
  };
}

// ─── SourceCode schema ────────────────────────────────────────────────────────

export async function evalSourceCodeAcceptsValid(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    "manifest.json": '{"manifest_version":3}',
    "popup.html": "<html></html>",
  };
  const result = validateSchema(SourceCodeSchema, payload);
  return {
    id: "schema_source_code_valid",
    name: "SourceCodeSchema → accepts string-keyed string-value record",
    category: "high",
    weight: 7,
    score: result.success ? 100 : 0,
    threshold: 100,
    passed: result.success,
    details: result.success ? "validation passed" : `error: ${(result as { error: string }).error}`,
  };
}

export async function evalSourceCodeRejectsNonStringValues(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    "manifest.json": 42,  // should be string
  };
  const result = validateSchema(SourceCodeSchema, payload);
  const rejected = !result.success;
  return {
    id: "schema_source_code_rejects_non_string",
    name: "SourceCodeSchema → rejects numeric values",
    category: "high",
    weight: 6,
    score: rejected ? 100 : 0,
    threshold: 100,
    passed: rejected,
    details: rejected ? "correctly rejected" : "numeric value accepted — type safety broken",
  };
}

// ─── DesignBrief schema ───────────────────────────────────────────────────────

export async function evalDesignBriefAcceptsValid(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    designTokens: {
      colors: { primary: "#0f766e", background: "#ffffff", surface: "#f8f8f8", text: "#111111" },
      borderRadius: "6px",
      fontFamily: "system-ui",
      spacingUnit: "8px",
    },
    componentHierarchy: [{ name: "App", children: ["Header", "Body"] }],
    layout: "popup",
    iconSet: "inline-svg",
    responsive: false,
    darkMode: "none",
  };
  const result = validateSchema(DesignBriefSchema, payload);
  return {
    id: "schema_design_brief_valid",
    name: "DesignBriefSchema → accepts valid design brief",
    category: "high",
    weight: 6,
    score: result.success ? 100 : 0,
    threshold: 100,
    passed: result.success,
    details: result.success ? "validation passed" : `error: ${(result as { error: string }).error}`,
  };
}

export async function evalDesignBriefRejectsInvalidLayout(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    designTokens: {
      colors: { primary: "#000", background: "#fff", surface: "#eee", text: "#111" },
      borderRadius: "4px",
      fontFamily: "sans-serif",
      spacingUnit: "4px",
    },
    componentHierarchy: [],
    layout: "invalid_layout",  // not in enum
    iconSet: "lucide",
    responsive: true,
    darkMode: "class",
  };
  const result = validateSchema(DesignBriefSchema, payload);
  const rejected = !result.success;
  return {
    id: "schema_design_brief_invalid_layout",
    name: "DesignBriefSchema → rejects invalid layout enum",
    category: "medium",
    weight: 5,
    score: rejected ? 100 : 0,
    threshold: 100,
    passed: rejected,
    details: rejected ? "invalid layout enum correctly rejected" : "enum constraint not enforced",
  };
}

// ─── SidekickPlan schema ──────────────────────────────────────────────────────

export async function evalSidekickPlanAcceptsValid(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = {
    summary: "Build a focus timer extension",
    steps: [
      { node: "architect_node", description: "Plan blueprint", files: ["manifest.json"], estimatedTokens: 500 },
      { node: "coder_node",     description: "Write code",     files: ["popup.js"],      estimatedTokens: 2000 },
    ],
  };
  const result = validateSchema(SidekickPlanSchema, payload);
  return {
    id: "schema_sidekick_plan_valid",
    name: "SidekickPlanSchema → accepts valid plan",
    category: "medium",
    weight: 5,
    score: result.success ? 100 : 0,
    threshold: 100,
    passed: result.success,
    details: result.success ? "validation passed" : `error: ${(result as { error: string }).error}`,
  };
}

export async function evalSidekickPlanRejectsMissingSteps(): Promise<Omit<EvalResult, "durationMs">> {
  const payload = { summary: "Plan without steps" };  // steps missing
  const result = validateSchema(SidekickPlanSchema, payload);
  const rejected = !result.success;
  return {
    id: "schema_sidekick_plan_missing_steps",
    name: "SidekickPlanSchema → rejects missing steps array",
    category: "medium",
    weight: 4,
    score: rejected ? 100 : 0,
    threshold: 100,
    passed: rejected,
    details: rejected ? "correctly rejected" : "required field 'steps' not enforced",
  };
}

// ─── validateSchema helper ────────────────────────────────────────────────────

export async function evalValidateSchemaHelperSuccessPath(): Promise<Omit<EvalResult, "durationMs">> {
  const { z } = await import("zod");
  const schema = z.object({ x: z.number() });
  const result = validateSchema(schema, { x: 42 });
  const correct = result.success && (result as { data: { x: number } }).data.x === 42;
  return {
    id: "schema_helper_success",
    name: "validateSchema helper → success path shape correct",
    category: "medium",
    weight: 4,
    score: correct ? 100 : 0,
    threshold: 100,
    passed: correct,
    details: correct ? "{ success: true, data } shape correct" : `result=${JSON.stringify(result)}`,
  };
}

export async function evalValidateSchemaHelperErrorPath(): Promise<Omit<EvalResult, "durationMs">> {
  const { z } = await import("zod");
  const schema = z.object({ x: z.number() });
  const result = validateSchema(schema, { x: "not a number" });
  const correct = !result.success && typeof (result as { error: string }).error === "string";
  return {
    id: "schema_helper_error",
    name: "validateSchema helper → error path has string message",
    category: "medium",
    weight: 4,
    score: correct ? 100 : 0,
    threshold: 100,
    passed: correct,
    details: correct ? "{ success: false, error: string } shape correct" : `result=${JSON.stringify(result)}`,
  };
}

export const SCHEMA_CRITERIA = [
  evalBlueprintAcceptsValid,
  evalBlueprintRejectsMissingName,
  evalBlueprintRejectsEmptyName,
  evalBlueprintAllowsOptionalFields,
  evalSourceCodeAcceptsValid,
  evalSourceCodeRejectsNonStringValues,
  evalDesignBriefAcceptsValid,
  evalDesignBriefRejectsInvalidLayout,
  evalSidekickPlanAcceptsValid,
  evalSidekickPlanRejectsMissingSteps,
  evalValidateSchemaHelperSuccessPath,
  evalValidateSchemaHelperErrorPath,
];
