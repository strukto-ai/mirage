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

export const MAX_FINISHED_JOBS = 1024
export const FINISHED_JOB_RETENTION_SECONDS = 3600

export const MAX_STDIN_BYTES = 64 * 1024 * 1024

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
  'stream',
  'direct',
])
