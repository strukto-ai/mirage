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

import type { JsonValue } from '../../../types.ts'

/**
 * One tool as an MCP server lists it. Keys are spelled as MCP spells them
 * (`inputSchema`, `annotations.readOnlyHint`), as Python's snapshot does.
 */
export interface MCPTool {
  readonly name: string
  /** Its description, possibly several lines. */
  readonly description: string
  /** The JSON schema of its arguments object. */
  readonly inputSchema: Readonly<Record<string, JsonValue>>
  readonly annotations: Readonly<Record<string, JsonValue>>
}

/** What a CLI is built from: the server's title, the root's description, and its tools in order. */
export interface MCPSource {
  readonly title: string
  readonly tools: readonly MCPTool[]
}
