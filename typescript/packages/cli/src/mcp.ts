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

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { serveMirageMcp } from '@struktoai/mirage-agents/mcp'
import type { CommandSafeguard, MountSpec } from '@struktoai/mirage-node'
import { Workspace, newWorkspaceId } from '@struktoai/mirage-node'
import { configToWorkspaceArgs, loadWorkspaceConfigFile } from '@struktoai/mirage-server'
import type { Command } from 'commander'

const CONFIG_CANDIDATES = [
  '.mirage/workspace.yaml',
  '.mirage/workspace.yml',
  'workspace.yaml',
  'workspace.yml',
  'mirage.yaml',
  'mirage.yml',
]

export interface McpConfigResolutionOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

interface McpCommandOptions {
  staleWriteProtection: boolean
}

function requireConfig(path: string): string {
  if (!existsSync(path)) throw new Error(`Mirage workspace config not found: ${path}`)
  return path
}

export function resolveMcpConfig(
  config: string | undefined,
  options: McpConfigResolutionOptions = {},
): string {
  const cwd = resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  if (config !== undefined) return requireConfig(resolve(cwd, config))
  if (env.MIRAGE_MCP_CONFIG !== undefined) {
    return requireConfig(resolve(cwd, env.MIRAGE_MCP_CONFIG))
  }

  let dir: string | undefined = cwd
  while (dir !== undefined) {
    for (const candidate of CONFIG_CANDIDATES) {
      const path = resolve(dir, candidate)
      if (existsSync(path)) return path
    }
    const parent = dirname(dir)
    dir = parent === dir ? undefined : parent
  }
  throw new Error(
    'No Mirage workspace config found. Pass one to `mirage mcp <config>` or set MIRAGE_MCP_CONFIG.',
  )
}

export async function buildMcpWorkspace(configPath: string): Promise<Workspace> {
  const config = loadWorkspaceConfigFile(configPath)
  const args = await configToWorkspaceArgs(config)
  const resources: Record<string, MountSpec> = {}
  const commandSafeguards: Record<string, Record<string, CommandSafeguard>> = {}
  for (const [prefix, [resource, mode, safeguards]] of Object.entries(args.resources)) {
    resources[prefix] = [resource, mode]
    if (Object.keys(safeguards).length > 0) commandSafeguards[prefix] = safeguards
  }
  const workspace = new Workspace(resources, {
    mode: args.options.mode,
    consistency: args.options.consistency,
    ...(args.options.sessionId !== undefined ? { sessionId: args.options.sessionId } : {}),
    ...(args.options.agentId !== undefined ? { agentId: args.options.agentId } : {}),
    workspaceId: args.options.workspaceId ?? newWorkspaceId(),
    ...(args.options.store !== undefined ? { store: args.options.store } : {}),
    ...(Object.keys(commandSafeguards).length > 0 ? { commandSafeguards } : {}),
    ...(args.options.cache !== undefined ? { cache: args.options.cache } : {}),
    ...(args.options.index !== undefined ? { index: args.options.index } : {}),
    ...(args.options.runtimes !== undefined ? { runtimes: args.options.runtimes } : {}),
    ...(args.options.route !== undefined ? { route: args.options.route } : {}),
  })
  try {
    for (const [prefix, target] of Object.entries(args.fuseMounts)) {
      const mountpoint = typeof target === 'string' ? target : undefined
      await workspace.addFuseMount(prefix, mountpoint)
    }
  } catch (error) {
    await workspace.close()
    throw error
  }
  return workspace
}

async function runMcpServer(
  config: string | undefined,
  options: McpCommandOptions,
): Promise<void> {
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
