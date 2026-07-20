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

import type { Workspace } from '@struktoai/mirage-core'
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent'
import { buildSystemPrompt } from '../prompt.ts'
import { mirageOperations, type MirageOperationsOptions } from './operations.ts'

export interface MirageExtensionOptions extends MirageOperationsOptions {
  cwd?: string
  systemPrompt?: string | false
}

function bashAtCwd(operations: BashOperations, cwd: string): BashOperations {
  return {
    exec: (command, _hostCwd, options) => operations.exec(command, cwd, options),
  }
}

export function mirageExtension(ws: Workspace, opts: MirageExtensionOptions = {}): InlineExtension {
  const cwd = opts.cwd ?? '/'
  const ops = mirageOperations(ws, opts)
  const userBash = bashAtCwd(ops.bash, cwd)
  const systemPrompt =
    opts.systemPrompt === false
      ? undefined
      : (opts.systemPrompt ?? buildSystemPrompt({ workspace: ws }))
  return {
    name: 'mirage',
    factory: (pi) => {
      pi.registerTool(createReadToolDefinition(cwd, { operations: ops.read }))
      pi.registerTool(createWriteToolDefinition(cwd, { operations: ops.write }))
      pi.registerTool(createEditToolDefinition(cwd, { operations: ops.edit }))
      pi.registerTool(createBashToolDefinition(cwd, { operations: ops.bash }))
      pi.registerTool(createGrepToolDefinition(cwd, { operations: ops.grep }))
      pi.registerTool(createFindToolDefinition(cwd, { operations: ops.find }))
      pi.registerTool(createLsToolDefinition(cwd, { operations: ops.ls }))
      pi.on('user_bash', () => ({ operations: userBash }))
      if (systemPrompt !== undefined) {
        pi.on('before_agent_start', (event) => ({
          systemPrompt: `${event.systemPrompt}\n\n${systemPrompt}`,
        }))
      }
    },
  }
}
