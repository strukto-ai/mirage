// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

// The sessions each workspace holds when the host names no cap: with each
// session's 128 processes, what a shared host can carry per workspace.
export const MAX_SESSIONS = 16

export const MAX_STDIN_BYTES = 64 * 1024 * 1024
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

/**
 * Dispatcher keywords a remote VFS function call may not set: the session,
 * the report and the admission flags are the server's.
 */
export const RESERVED_KWARGS: ReadonlySet<string> = new Set([
  'session_id',
  'sessionId',
  'report',
  'issuer',
  'admit_only',
  'retained',
  'stream',
  'direct',
])

/** Bodies read as sent, never as JSON: an upload, by its Content-Type. */
export const RAW_BODIES = /^(multipart\/|application\/octet-stream)/i
