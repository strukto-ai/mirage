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

import { serveMirageMcp } from '@struktoai/mirage-agents/mcp'
import type { Workspace } from '@struktoai/mirage-node'
import { buildWorkspaceFromConfig, resolveWorkspaceConfig } from '@struktoai/mirage-server'
import type { Command } from 'commander'

export interface McpConfigResolutionOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

interface McpCommandOptions {
  staleWriteProtection: boolean
}

export function resolveMcpConfig(
  config: string | undefined,
  options: McpConfigResolutionOptions = {},
): string {
  return resolveWorkspaceConfig(config, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    envNames: ['MIRAGE_MCP_CONFIG', 'MIRAGE_CONFIG'],
  })
}

export async function buildMcpWorkspace(configPath: string): Promise<Workspace> {
  return buildWorkspaceFromConfig(configPath)
}

async function runMcpServer(config: string | undefined, options: McpCommandOptions): Promise<void> {
  const configPath = resolveMcpConfig(config)
  const workspace = await buildMcpWorkspace(configPath)
  try {
    await serveMirageMcp(workspace, {
      staleWriteProtection: options.staleWriteProtection,
    })
  } catch (error) {
    await workspace.close()
    throw error
  }
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .argument('[config]', 'Mirage workspace YAML config')
    .option('--no-stale-write-protection', 'allow edits after a file changed since it was read')
    .description('Serve a Mirage workspace as MCP tools over stdio.')
    .action(runMcpServer)
}
