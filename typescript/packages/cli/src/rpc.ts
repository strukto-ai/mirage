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

import { resolveWorkspaceConfig } from '@struktoai/mirage-server/workspace_config'
import type { Command } from 'commander'
import { relayWorkspace } from './mcp.ts'
import { fail } from './output.ts'

export const RPC_ENV_NAMES = ['MIRAGE_RPC_CONFIG', 'MIRAGE_CONFIG']

export function resolveRpcConfig(
  config: string | undefined,
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string {
  return resolveWorkspaceConfig(config, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    envNames: RPC_ENV_NAMES,
  })
}

/**
 * Serve a workspace session's API over JSON-RPC on stdio: line-delimited
 * JSON-RPC 2.0 on stdin and stdout, relayed to the workspace's
 * `/v1/workspaces/:id/rpc` endpoint, as `mirage mcp` relays MCP, with the
 * same config, `--workspace` and `--session` rules.
 */
export function registerRpcCommand(program: Command): void {
  program
    .command('rpc')
    .argument('[config]', 'Mirage workspace YAML config')
    .option('-w, --workspace <id>', 'Serve this daemon workspace instead of loading a config')
    .option('-s, --session <id>', "Session the methods act as; the workspace's default when absent")
    .description("Serve a workspace session's API over JSON-RPC on stdio.")
    .action(
      async (config: string | undefined, options: { workspace?: string; session?: string }) => {
        if (options.workspace !== undefined && config !== undefined) {
          fail('pass a config or --workspace, not both', 2)
        }
        let path: string | undefined
        if (options.workspace === undefined) {
          try {
            path = resolveRpcConfig(config)
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error), 2)
          }
        }
        const { relayStdio } = await import('@struktoai/mirage-server/rpc')
        await relayWorkspace(path, options.workspace, options.session, 'rpc', relayStdio)
      },
    )
}
