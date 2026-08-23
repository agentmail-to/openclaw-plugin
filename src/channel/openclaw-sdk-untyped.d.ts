// OpenClaw 2026.8.1-beta.2 ships these plugin SDK subpaths in its package `exports` map but without
// a `types` entry, so TypeScript resolves them to untyped JavaScript. They are still supported public
// subpaths (the Plugin Inspector's sdk-export-missing check reads the same exports map), so the fix is
// local declarations rather than dropping the imports.
//
// Each block mirrors the shipped-but-unexported declaration chunk for the members this plugin uses.
// Delete a block once OpenClaw publishes `types` for that subpath.
declare module "openclaw/plugin-sdk/plugin-state-runtime" {
  export type PluginStateEntry<T> = {
    key: string;
    value: T;
    createdAt: number;
    expiresAt?: number;
  };

  /** Async plugin state API exposed to plugin runtimes. */
  export type PluginStateKeyedStore<T> = {
    register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
    registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }): Promise<boolean>;
    update?: (
      key: string,
      updateValue: (current: T | undefined) => T | undefined,
      opts?: { ttlMs?: number },
    ) => Promise<boolean>;
    /** Atomically deletes an existing entry when its current value matches. */
    deleteIf?: (key: string, predicate: (current: T) => boolean) => Promise<boolean>;
    lookup(key: string): Promise<T | undefined>;
    consume(key: string): Promise<T | undefined>;
    delete(key: string): Promise<boolean>;
    entries(): Promise<PluginStateEntry<T>[]>;
    clear(): Promise<void>;
  };
}

declare module "openclaw/plugin-sdk/web-content-extractor" {
  /** Converts sanitized HTML into coarse markdown plus an optional title. */
  export function htmlToMarkdown(html: string): { text: string; title?: string };
  /** Removes markdown decoration for plain text extraction. */
  export function markdownToText(markdown: string): string;
}

declare module "openclaw/plugin-sdk/outbound-media" {
  import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
  import type { WebMediaResult } from "openclaw/plugin-sdk/web-media";

  /** Media loading policy used before plugin media is handed to channel delivery. */
  export type OutboundMediaLoadOptions = {
    /** Maximum allowed media payload size before the load is rejected. */
    maxBytes?: number;
    /** Whether callers may load remote URLs, local files, or both. */
    mediaAccess?: OutboundMediaAccess;
    /** Approved local roots for file/path media; `"any"` disables root restriction. */
    mediaLocalRoots?: readonly string[] | "any";
    /** Optional local file reader used by tests or plugin-specific filesystem adapters. */
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    /** Workspace root used when resolving relative local media paths. */
    workspaceDir?: string;
    /** Explicit proxy URL forwarded to shared outbound media loading policy. */
    proxyUrl?: string;
    /** Fetch implementation for remote media loads. */
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** Extra fetch options merged into remote media requests. */
    requestInit?: RequestInit;
    /** Whether shared media loading may optimize image payloads. */
    optimizeImages?: boolean;
    /** Allows explicit proxy DNS behavior to be trusted by the media fetch guard. */
    trustExplicitProxyDns?: boolean;
  };

  /** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
  export function loadOutboundMediaFromUrl(
    mediaUrl: string,
    options?: OutboundMediaLoadOptions,
  ): Promise<WebMediaResult>;
}
