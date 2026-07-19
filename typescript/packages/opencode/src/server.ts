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

import type { Plugin, PluginModule, PluginOptions } from '@opencode-ai/plugin'
import { mirageTools } from '@struktoai/mirage-agents/opencode'
import { buildWorkspaceFromConfig, resolveWorkspaceConfig } from '@struktoai/mirage-server'

export interface MirageOpenCodePluginOptions {
  config?: string
  staleWriteProtection?: boolean
}

function parseOptions(options: PluginOptions): MirageOpenCodePluginOptions {
  const config = options.config
  const staleWriteProtection = options.staleWriteProtection
  if (config !== undefined && typeof config !== 'string') {
    throw new TypeError('Mirage OpenCode plugin option "config" must be a string')
  }
  if (staleWriteProtection !== undefined && typeof staleWriteProtection !== 'boolean') {
    throw new TypeError('Mirage OpenCode plugin option "staleWriteProtection" must be a boolean')
  }
  return {
    ...(config !== undefined ? { config } : {}),
    ...(staleWriteProtection !== undefined ? { staleWriteProtection } : {}),
  }
}

export const MirageOpenCodePlugin: Plugin = async (input, rawOptions = {}) => {
  const options = parseOptions(rawOptions)
  const configPath = resolveWorkspaceConfig(options.config, {
    cwd: input.directory,
    envNames: ['MIRAGE_OPENCODE_CONFIG', 'MIRAGE_CONFIG'],
  })
  const workspace = await buildWorkspaceFromConfig(configPath)
  return {
    tool: mirageTools(workspace, {
      staleWriteProtection: options.staleWriteProtection ?? true,
    }),
    dispose: () => workspace.close(),
  }
}

const plugin: PluginModule = {
  id: '@struktoai/mirage-opencode',
  server: MirageOpenCodePlugin,
}

export default plugin
