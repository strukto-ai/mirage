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

// The Agent Client Protocol methods the relay reads or answers. The client
// says in initialize which of its methods an agent may call; the relay adds
// the two file methods and answers them from the workspace.
export const INITIALIZE = 'initialize'
export const NEW_SESSION = 'session/new'
export const FORK_SESSION = 'session/fork'
export const READ_TEXT_FILE = 'fs/read_text_file'
const WRITE_TEXT_FILE = 'fs/write_text_file'
export const FILE_METHODS: ReadonlySet<string> = new Set([READ_TEXT_FILE, WRITE_TEXT_FILE])

// The requests that start or reopen a session and so take MCP servers. The
// answer to a new or forked one names its session; the others name theirs.
export const SESSION_METHODS: ReadonlySet<string> = new Set([
  NEW_SESSION,
  FORK_SESSION,
  'session/load',
  'session/resume',
])

// ACP's error codes for a missing file, a malformed request and anything
// else.
export const ACP_RESOURCE_NOT_FOUND = -32002
export const ACP_INVALID_PARAMS = -32602
export const ACP_INTERNAL_ERROR = -32603

// The workspace RPC's code for a missing path (ENOENT).
export const RPC_NOT_FOUND = -32004

// The longest line read from the agent: one message carries a whole file.
export const LINE_LIMIT = 64 * 1024 * 1024

// Seconds a workspace RPC call may take before the agent's file request is
// answered with an error.
export const RPC_TIMEOUT = 300

// A line ends at CRLF, CR or LF, as an editor counts lines.
export const LINE_BREAK = /(\r\n|\r|\n)/
