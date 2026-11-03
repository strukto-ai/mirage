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

/** Seconds one MCP request may wait for its answer. */
export const TIMEOUT = 300
/** Pages of tools read before the listing is refused. */
export const MAX_PAGES = 64
/** Bytes one MCP reply may carry, and a whole tool listing across its pages. */
export const MAX_REPLY = 16 * 1024 * 1024
/** Tools one MCP server may list. */
export const MAX_TOOLS = 1024
export const REPLY_TOO_LARGE = `MCP server reply exceeds ${String(MAX_REPLY)} bytes`
export const REPLY_ENCODING = 'MCP server reply uses an encoding the client cannot read'
