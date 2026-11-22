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
import { MCP_ENV_NAMES, relayWorkspace } from './mcp.ts'
import { fail } from './output.ts'

const ACP_SERVER_NAME = 'mirage'

/** The workspace id in a `/v1/workspaces/:id/...` URL. */
export function workspaceOf(url: string): string {
  const path = new URL(url).pathname
  const tail = path.slice(path.lastIndexOf('/v1/workspaces/') + '/v1/workspaces/'.length)
  return decodeURIComponent(tail.split('/', 1)[0] ?? '')
}

/**
 * The workspace's MCP server as ACP's `McpServerStdio`: this CLI running
 * `mirage mcp` on the same workspace and session.
 */
export function mcpServer(
  workspaceId: string,
  sessionId: string | undefined,
): { name: string; command: string; args: string[]; env: never[] } {
  const args = [process.argv[1] ?? '', 'mcp', '--workspace', workspaceId]
  if (sessionId !== undefined) args.push('--session', sessionId)
  return { name: ACP_SERVER_NAME, command: process.execPath, args, env: [] }
}

/**
 * Run an ACP agent on a Mirage workspace. For an ACP client such as Zed or
 * t3code, in place of the agent's own command: `mirage acp -w demo --
 * claude-agent-acp`. Every message passes through, but the agent's file
 * reads and writes are answered from the workspace, each session gets the
 * workspace's MCP tools, and Claude's built-in tools are turned off. A path
 * in the session's folder lands under `--root`. The workspace is the
 * daemon's, as for `mirage mcp`; the exit status is the agent's.
 */
export function registerAcpCommand(program: Command): void {
  program
    .command('acp')
    .argument('<agent...>', "The ACP agent's command line")
    .option('-c, --config <path>', 'Mirage workspace YAML config')
    .option('-w, --workspace <id>', 'Serve this daemon workspace instead of loading a config')
    .option('-s, --session <id>', "Session the agent acts as; the workspace's default when absent")
    .option('--root <path>', "Workspace path the client's project folder stands for", '/')
    .passThroughOptions()
    .description('Run an ACP agent on a Mirage workspace.')
    .action(acpCmd)
}

async function acpCmd(
  agent: string[],
  options: { config?: string; workspace?: string; session?: string; root: string },
): Promise<void> {
  if (options.workspace !== undefined && options.config !== undefined) {
    fail('pass --config or --workspace, not both', 2)
  }
  if (!options.root.startsWith('/')) fail('--root takes an absolute workspace path', 2)
  let path: string | undefined
  if (options.workspace === undefined) {
    try {
      path = resolveWorkspaceConfig(options.config, { envNames: MCP_ENV_NAMES })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), 2)
    }
  }
  const { relayStdio } = await import('@struktoai/mirage-server/acp')
  let status = 0
  await relayWorkspace(path, options.workspace, options.session, 'rpc', async (url, token) => {
    const server = mcpServer(workspaceOf(url), options.session)
    try {
      status = await relayStdio(agent, url, token, server, options.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      status = 127
      process.stderr.write(`acp: ${agent[0] ?? ''}: command not found\n`)
    }
  })
  if (status !== 0) process.exit(status)
}
