import { createHash } from "node:crypto";

/** Hex SHA-256 of a string. Shared by durable ids, catch-up cursor keys, and idempotency keys. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
