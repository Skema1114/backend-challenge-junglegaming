import { randomUUID } from "node:crypto";

export function newUuid(): string {
  if (typeof Bun !== "undefined" && typeof Bun.randomUUIDv7 === "function") {
    return Bun.randomUUIDv7();
  }
  return randomUUID();
}
