import type { AuditTool } from "./telemetry.ts";

export interface UltraSearchHit {
  kind: "file" | "dir" | "link" | "other";
  mtime: number;
  path: string;
  score: number;
  size: number;
  git?: string;
  distance?: number;
  /**
   * The nearness component the daemon added to `score` (issue: one owner for
   * proximity). Scale: +12 in the `near` file's folder, -3 per folder of
   * distance, clamped at 0; the `near` file itself is -20. Absent when no
   * `near` was given or nothing was added.
   */
  near?: number;
  /** The frecency component the daemon added to `score` (`boost: true`). */
  boost?: number;
  /** The query's own match score, before `near`/`boost` were added (engine-owned vector). */
  match?: number;
  /** Definition component: 8 when this row declares the queried symbol, else 0/absent. */
  def?: number;
}

/**
 * Machine-readable accounting attached to every search/grep/multi-grep result.
 * `complete` is true only when the engine explicitly reported completeness;
 * a response without an explicit `complete: true` is not guaranteed to cover
 * the full scope (issues #16, #25, #37).
 */
export interface SearchResultMeta {
  complete: boolean;
  /** The result set was clipped (by `limit` or the scan ceiling). */
  truncated: boolean;
  /**
   * Number of matching items the client dropped to honour `limit` (known count).
   * When `filteredCount > 0` and the result is shorter than `limit`, the caller
   * can raise `limit`: the client over-fetches by a bounded margin but never
   * issues a second round trip.
   */
  truncatedCount: number;
  /** The engine returned exactly the requested limit, so more matches may exist (count unknown). */
  engineCapped?: boolean;
  /** Number of items removed by ignore rules or exact-match post-filtering. */
  filteredCount: number;
  /** Estimated prompt tokens for the result payload: ceil(charCount / 4). ESTIMATE. */
  tokenCount: number;
  /** Estimated prompt characters for the result payload. */
  charCount: number;
  source?: "index" | "scan" | "native_fallback";
  /** Budget requested for this call, when the caller supplied one. */
  budgetMs?: number;
  /** The client-side deadline fired before the engine answered. */
  deadlineExceeded?: boolean;
  /** Non-fatal diagnostics, e.g. a regex backtracking warning. */
  warning?: string;
  /** Raw item count returned by the engine before client-side filtering. */
  rawCount?: number;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
  /** Milliseconds the index was behind a replay for this answer (#19); 0/absent when caught up. */
  staleMs?: number;
}

export interface UltraSearchSearchResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  hits?: UltraSearchHit[];
  source?: "index" | "scan" | "native_fallback";
  complete?: boolean;
  truncated?: boolean;
  truncatedCount?: number;
  filteredCount?: number;
  meta?: SearchResultMeta;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
  /** Milliseconds the index was behind a replay for this answer (#19); 0/absent when caught up. */
  stale_ms?: number;
  error?: string;
}

export interface UltraSearchGrepMatch {
  line: number;
  text: string;
  col?: number;
  before?: string[];
  after?: string[];
  ranges?: Array<[number, number]>;
  /** Engine verdict: this line declares the queried name (`mode: "symbol"`). */
  def?: boolean;
}

export interface UltraSearchGrepFile {
  path: string;
  matches: UltraSearchGrepMatch[];
  /** Definition component for the file (engine symbol mode): 8 declares the name, 0 does not. */
  def?: number;
}

export interface UltraSearchGrepResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  source?: "index" | "scan" | "native_fallback";
  candidates?: number;
  read?: number;
  complete?: boolean;
  truncated?: boolean;
  truncatedCount?: number;
  filteredCount?: number;
  indexing?: number;
  files?: UltraSearchGrepFile[];
  meta?: SearchResultMeta;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
  /** Milliseconds the index was behind a replay for this answer (#19); 0/absent when caught up. */
  stale_ms?: number;
  error?: string;
}

export interface UltraSearchMultiGrepResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  source?: "index" | "scan" | "native_fallback";
  patterns: string[];
  /** Results the daemon's policy held back across the fan-out (#23). */
  withheld?: number;
  /** The longest replay lag seen across the fan-out (#19). */
  stale_ms?: number;
  complete?: boolean;
  truncated?: boolean;
  truncatedCount?: number;
  filteredCount?: number;
  files?: UltraSearchGrepFile[];
  meta?: SearchResultMeta;
  error?: string;
}

export interface UltraSearchStatusResponse {
  id?: number | string | null;
  ok: boolean;
  took_us?: number;
  version?: string;
  /**
   * The daemon wire-protocol version it speaks (`docs/protocol.md`). Absent
   * on daemons older than 1.0; a client with a different major must not
   * assume the rest of this shape (#50).
   */
  protocol_version?: string;
  /**
   * Set by `client.status()` when the daemon reports a different protocol
   * major than the client speaks. The fields below may not mean what this
   * client expects (#50).
   */
  protocol_mismatch?: { client: string; daemon: string };
  entries?: number;
  index_bytes?: number;
  content_files?: number;
  content_bytes?: number;
  content_segments?: number;
  total_content_segments?: number;
  event_id?: number;
  full_disk_access?: boolean;
  owner?: boolean;
  overlay?: number;
  removed?: number;
  error?: string;
  /**
   * Milliseconds the index has been behind a replay when this answer was
   * made (issue #19). Absent or 0: the index is caught up. Non-zero: the
   * result may miss changes made during that window.
   */
  stale_ms?: number;
  /** Results the daemon's policy held back: deny-list, or the caller `root` (#23). */
  withheld?: number;
  /** This daemon's pid (#45). */
  pid?: number;
  /** Milliseconds since this engine started (#45): the cold-start window. */
  uptime_ms?: number;
  /** The socket path the daemon serves (#45). */
  socket?: string;
  socket_dev?: number;
  socket_ino?: number;
  /** The pid recorded in the daemon's single-instance `socket.lock` (#45). */
  lock_pid?: number;
  /**
   * Duplicate/stale daemon signals collected by the client (#45): socket
   * owner pids, a lock/answering pid mismatch, or a second daemon on the
   * legacy socket. Present on `client.status()` replies.
   */
  daemon_health?: {
    pid?: number;
    uptime_ms?: number;
    socket: string;
    socket_owners: number[];
    lock_pid?: number;
    duplicate_suspected: boolean;
    duplicates: Array<{ path: string; pid?: number; reason: string }>;
  };
}

export interface SearchOptions {
  in?: string;
  limit?: number;
  near?: string;
  /**
   * The caller's allowed boundary (an absolute path). The daemon refuses a
   * scope outside it and drops any hit outside it, so a bug in a caller's own
   * containment check cannot widen the search. Omit for a deliberate
   * disk-wide (`global`) query. See issue #23.
   */
  root?: string;
  fuzzy?: boolean;
  git?: boolean;
  /** Ranking boost (frecency + git + mtime). Omitted means the engine default applies. */
  boost?: boolean;
  skipAudit?: boolean;
  /** Tool name recorded in the audit log (single-recording layer). Defaults to ultrasearch_query. */
  auditTool?: AuditTool;
  /** Respect local .gitignore/.ignore rules declared in the scope root (default: true). */
  respectIgnore?: boolean;
  /** Server-side deadline in milliseconds; partial results carry complete:false. */
  budget_ms?: number;
  /**
   * End the scan after a long run of considered entries that did not improve
   * the k-th best (issue #35). The answer is then partial (`complete:false`,
   * `stopped_by:"low_run"`). Off by default; see docs/engine-changes.md.
   */
  early_exit?: boolean;
  /** Explicit low-score run length for `early_exit`; omit for the engine default. */
  low_run?: number;
  /** Cancellation for fallback work (agent turn aborted). */
  signal?: AbortSignal;
}

export interface GrepOptions {
  /** One file to read directly, even when the content index skipped its text. */
  file?: string;
  /** Case handling; default smart (lowercase pattern = insensitive). */
  case?: "smart" | "sensitive" | "insensitive";
  in?: string;
  mode?: "literal" | "regex" | "symbol";
  limit?: number;
  budget_ms?: number;
  /** The caller's allowed boundary; see `SearchOptions.root`. */
  root?: string;
  context?: number;
  skipAudit?: boolean;
  /** Tool name recorded in the audit log (single-recording layer). Defaults to ultrasearch_grep. */
  auditTool?: AuditTool;
  /** Respect local .gitignore/.ignore rules declared in the scope root (default: true). */
  respectIgnore?: boolean;
  /** Cancellation for fallback work (agent turn aborted). */
  signal?: AbortSignal;
  /** Ask the engine for its definition verdicts (`def`) so matches can be tagged. */
  tagSymbols?: boolean;
}
