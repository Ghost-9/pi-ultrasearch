/**
 * The daemon wire-protocol version, frozen by `docs/protocol.md` (issue #50).
 *
 * The daemon answers newline-delimited JSON over its UNIX socket; this is the
 * version of that request/response contract, not the MCP revision (which has
 * its own negotiation in `src/mcp.ts`) and not the package version.
 *
 * Compatibility rule: same major = compatible. A minor bump only adds
 * optional fields/ops a client may ignore; removing, renaming, retyping or
 * changing the meaning of anything, or narrowing a default, is a major bump.
 * `client.status()` surfaces a mismatch instead of guessing.
 */
export const PROTOCOL_VERSION = "1.1";

/** The major part of a `<major>.<minor>` protocol version. */
export function protocolMajor(version: string): string {
  return version.trim().split(".")[0] ?? "";
}

/** True when a client can speak to a daemon of `daemonVersion` (same major). */
export function protocolCompatible(clientVersion: string, daemonVersion: string): boolean {
  return protocolMajor(clientVersion) === protocolMajor(daemonVersion);
}
