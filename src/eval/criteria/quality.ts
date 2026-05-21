/**
 * criteria/quality.ts — Output quality and MV3 compliance
 *
 * Evaluates the structural and semantic quality of generated Chrome Extension
 * artifacts: manifest correctness, file completeness, code hygiene, and
 * adherence to Chrome Web Store publishing requirements.
 */

import type { EvalResult } from "../reporter";
import type { SourceCode } from "../../state";
import { VALID_SOURCE, VALID_BLUEPRINT } from "../harness";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseManifest(src: SourceCode): Record<string, unknown> | null {
  try {
    return JSON.parse(src["manifest.json"] ?? "null");
  } catch {
    return null;
  }
}

// ─── MV3 Compliance ───────────────────────────────────────────────────────────

export async function evalManifestVersionIs3(): Promise<Omit<EvalResult, "durationMs">> {
  const m = parseManifest(VALID_SOURCE);
  const correct = m?.manifest_version === 3;
  return {
    id: "quality_manifest_version_3",
    name: "manifest.json → manifest_version === 3 (MV3)",
    category: "critical",
    weight: 10,
    score: correct ? 100 : 0,
    threshold: 100,
    passed: correct,
    details: correct ? "manifest_version=3" : `manifest_version=${m?.manifest_version}`,
  };
}

export async function evalManifestHasRequiredFields(): Promise<Omit<EvalResult, "durationMs">> {
  const m = parseManifest(VALID_SOURCE);
  const REQUIRED = ["manifest_version", "name", "version", "description"];
  const present = REQUIRED.filter(f => f in (m ?? {}));
  const score = Math.round((present.length / REQUIRED.length) * 100);
  return {
    id: "quality_manifest_required_fields",
    name: "manifest.json → all required fields present",
    category: "critical",
    weight: 9,
    score,
    threshold: 100,
    passed: score === 100,
    details: `present: [${present.join(", ")}]  missing: [${REQUIRED.filter(f => !present.includes(f)).join(", ")}]`,
  };
}

export async function evalManifestHasAction(): Promise<Omit<EvalResult, "durationMs">> {
  const m = parseManifest(VALID_SOURCE);
  const hasAction = typeof (m as { action?: unknown })?.action === "object";
  return {
    id: "quality_manifest_action",
    name: "manifest.json → action field present (popup or default_icon)",
    category: "high",
    weight: 8,
    score: hasAction ? 100 : 0,
    threshold: 100,
    passed: hasAction,
    details: hasAction ? "action field present" : "no action field — extension won't show in toolbar",
  };
}

export async function evalManifestNoBackgroundPage(): Promise<Omit<EvalResult, "durationMs">> {
  // MV3 uses service_worker, not background.page or background.scripts
  const m = parseManifest(VALID_SOURCE);
  const bg = (m as { background?: Record<string, unknown> })?.background;
  const usesServiceWorker = !bg || bg["service_worker"] !== undefined;
  const usesDeprecatedPage = bg?.["page"] !== undefined || bg?.["scripts"] !== undefined;
  const correct = !usesDeprecatedPage;
  return {
    id: "quality_manifest_no_bg_page",
    name: "manifest.json → background uses service_worker not page/scripts",
    category: "critical",
    weight: 9,
    score: correct ? 100 : 0,
    threshold: 100,
    passed: correct,
    details: correct ? "no deprecated background.page/scripts" : "DEPRECATED: background.page or background.scripts found",
  };
}

export async function evalManifestPermissionsArray(): Promise<Omit<EvalResult, "durationMs">> {
  const m = parseManifest(VALID_SOURCE);
  const perms = (m as { permissions?: unknown })?.permissions;
  const valid = Array.isArray(perms) && perms.every(p => typeof p === "string");
  return {
    id: "quality_manifest_permissions_array",
    name: "manifest.json → permissions is array of strings",
    category: "high",
    weight: 7,
    score: valid ? 100 : 0,
    threshold: 100,
    passed: valid,
    details: valid ? `permissions: [${(perms as string[]).join(", ")}]` : `invalid permissions type: ${JSON.stringify(perms)}`,
  };
}

// ─── File completeness ────────────────────────────────────────────────────────

export async function evalRequiredFilesPresent(): Promise<Omit<EvalResult, "durationMs">> {
  const REQUIRED = ["manifest.json", "popup.html", "popup.css", "popup.js"];
  const present = REQUIRED.filter(f => f in VALID_SOURCE && VALID_SOURCE[f].length > 0);
  const score = Math.round((present.length / REQUIRED.length) * 100);
  return {
    id: "quality_required_files",
    name: "extension output → all 4 core files present and non-empty",
    category: "critical",
    weight: 10,
    score,
    threshold: 100,
    passed: score === 100,
    details: `present: [${present.join(", ")}]  missing: [${REQUIRED.filter(f => !present.includes(f)).join(", ")}]`,
  };
}

export async function evalPopupHTMLHasScriptTag(): Promise<Omit<EvalResult, "durationMs">> {
  const html = VALID_SOURCE["popup.html"] ?? "";
  const hasScript = /<script\s+src=/.test(html);
  return {
    id: "quality_popup_html_external_script",
    name: "popup.html → uses <script src=...> not inline script",
    category: "critical",
    weight: 9,
    score: hasScript ? 100 : 0,
    threshold: 100,
    passed: hasScript,
    details: hasScript ? "external script tag found" : "no external <script src> — may violate CSP",
  };
}

export async function evalPopupHTMLHasDoctype(): Promise<Omit<EvalResult, "durationMs">> {
  const html = VALID_SOURCE["popup.html"] ?? "";
  const hasDoctype = html.trimStart().toLowerCase().startsWith("<!doctype");
  return {
    id: "quality_popup_html_doctype",
    name: "popup.html → begins with <!DOCTYPE html>",
    category: "medium",
    weight: 5,
    score: hasDoctype ? 100 : 0,
    threshold: 100,
    passed: hasDoctype,
    details: hasDoctype ? "DOCTYPE present" : "missing <!DOCTYPE html>",
  };
}

export async function evalBackgroundUsesServiceWorker(): Promise<Omit<EvalResult, "durationMs">> {
  const m = parseManifest(VALID_SOURCE);
  const bg = (m as { background?: Record<string, unknown> })?.background;
  if (!bg) {
    return {
      id: "quality_bg_service_worker",
      name: "background.js → referenced as service_worker in manifest",
      category: "high",
      weight: 7,
      score: 100,  // no background node = not applicable
      threshold: 100,
      passed: true,
      details: "no background node declared (acceptable for simple extensions)",
    };
  }
  const correct = typeof bg["service_worker"] === "string";
  return {
    id: "quality_bg_service_worker",
    name: "background.js → referenced as service_worker in manifest",
    category: "high",
    weight: 7,
    score: correct ? 100 : 0,
    threshold: 100,
    passed: correct,
    details: correct ? `service_worker="${bg["service_worker"]}"` : `background entry: ${JSON.stringify(bg)}`,
  };
}

// ─── Blueprint ↔ code consistency ─────────────────────────────────────────────

export async function evalPermissionsMatchBlueprint(): Promise<Omit<EvalResult, "durationMs">> {
  const m = parseManifest(VALID_SOURCE);
  const manifestPerms: string[] = (m as { permissions?: string[] })?.permissions ?? [];
  const blueprintPerms = VALID_BLUEPRINT.permissions;

  // Every blueprint permission should appear in manifest
  const covered = blueprintPerms.filter(p => manifestPerms.includes(p));
  const score = blueprintPerms.length === 0 ? 100 : Math.round((covered.length / blueprintPerms.length) * 100);

  return {
    id: "quality_permissions_match_blueprint",
    name: "manifest permissions ⊇ blueprint permissions",
    category: "high",
    weight: 8,
    score,
    threshold: 80,
    passed: score >= 80,
    details: `covered ${covered.length}/${blueprintPerms.length}: [${covered.join(", ")}]`,
  };
}

export async function evalBlueprintFeaturesNonEmpty(): Promise<Omit<EvalResult, "durationMs">> {
  const { features } = VALID_BLUEPRINT;
  const valid = Array.isArray(features) && features.length > 0 &&
    features.every(f => typeof f.id === "string" && f.id.length > 0 && typeof f.summary === "string" && f.summary.length > 0);
  return {
    id: "quality_blueprint_features",
    name: "blueprint → features array is non-empty with valid shape",
    category: "high",
    weight: 7,
    score: valid ? 100 : 0,
    threshold: 100,
    passed: valid,
    details: valid ? `${features.length} feature(s) validated` : "features array empty or malformed",
  };
}

// ─── Code hygiene ─────────────────────────────────────────────────────────────

export async function evalNoCodeFencesInGeneratedFiles(): Promise<Omit<EvalResult, "durationMs">> {
  // LLM sometimes wraps output in ```js or ```json — these corrupt generated files
  const fenceRe = /^```/m;
  const violations = Object.entries(VALID_SOURCE).filter(([, content]) => fenceRe.test(content));
  const clean = violations.length === 0;
  return {
    id: "quality_no_code_fences",
    name: "generated files → no markdown code fences in content",
    category: "critical",
    weight: 8,
    score: clean ? 100 : 0,
    threshold: 100,
    passed: clean,
    details: clean ? "no code fences found" : `code fences in: [${violations.map(([k]) => k).join(", ")}]`,
  };
}

export async function evalManifestIsValidJSON(): Promise<Omit<EvalResult, "durationMs">> {
  try {
    JSON.parse(VALID_SOURCE["manifest.json"] ?? "");
    return {
      id: "quality_manifest_valid_json",
      name: "manifest.json → parseable as valid JSON",
      category: "critical",
      weight: 10,
      score: 100,
      threshold: 100,
      passed: true,
      details: "JSON.parse succeeded",
    };
  } catch (e) {
    return {
      id: "quality_manifest_valid_json",
      name: "manifest.json → parseable as valid JSON",
      category: "critical",
      weight: 10,
      score: 0,
      threshold: 100,
      passed: false,
      details: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function evalNoEmptyFiles(): Promise<Omit<EvalResult, "durationMs">> {
  const empty = Object.entries(VALID_SOURCE).filter(([, v]) => v.trim().length === 0).map(([k]) => k);
  const clean = empty.length === 0;
  return {
    id: "quality_no_empty_files",
    name: "generated files → no empty or whitespace-only files",
    category: "high",
    weight: 7,
    score: clean ? 100 : 0,
    threshold: 100,
    passed: clean,
    details: clean ? "all files have content" : `empty files: [${empty.join(", ")}]`,
  };
}

export const QUALITY_CRITERIA = [
  evalManifestVersionIs3,
  evalManifestHasRequiredFields,
  evalManifestHasAction,
  evalManifestNoBackgroundPage,
  evalManifestPermissionsArray,
  evalRequiredFilesPresent,
  evalPopupHTMLHasScriptTag,
  evalPopupHTMLHasDoctype,
  evalBackgroundUsesServiceWorker,
  evalPermissionsMatchBlueprint,
  evalBlueprintFeaturesNonEmpty,
  evalNoCodeFencesInGeneratedFiles,
  evalManifestIsValidJSON,
  evalNoEmptyFiles,
];
