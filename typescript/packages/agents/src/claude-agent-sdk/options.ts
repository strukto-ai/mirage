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

import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { buildSystemPrompt } from '../prompt.ts'
import { MirageServer } from './server.ts'

export interface BuildOptionsOptions {
  systemPrompt?: string
  sessionId?: string | undefined
}

export async function buildOptions(
  workspace: Workspace,
  opts: BuildOptionsOptions = {},
): Promise<Options> {
  return {
    mcpServers: {
      mirage: MirageServer(
        workspace,
        opts.sessionId === undefined ? {} : { sessionId: opts.sessionId },
      ),
    },
    allowedTools: ['mcp__mirage__*'],
    systemPrompt:
      opts.systemPrompt ?? (await buildSystemPrompt({ workspace, sessionId: opts.sessionId })),
  }
}
