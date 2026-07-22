/** Optional structured logger shared across the AgentMail channel modules. */
export type AgentMailLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

/** Extracts a human-readable message from an unknown thrown value. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
