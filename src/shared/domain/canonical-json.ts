import { createHash } from "node:crypto";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = sortValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalizeJson(payload: unknown): string {
  return JSON.stringify(sortValue(payload));
}

export function hashCanonicalPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalizeJson(payload)).digest("hex");
}
