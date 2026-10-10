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
import { makeClient, type DaemonClient } from './client.ts'
import { LoginError } from './credentials.ts'
import { fail, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

export const MCP_ENV_NAMES = ['MIRAGE_MCP_CONFIG', 'MIRAGE_CONFIG']

interface McpCommandOptions {
  workspace?: string
  session?: string
  allCalls?: boolean
}

/**
 * Whether a daemon workspace holds a session. A daemon refusal throws
 * rather than exiting, so a minted workspace is deleted before the exit.
 */
async function hasSession(
  client: DaemonClient,
  workspacePath: string,
  sessionId: string,
): Promise<boolean> {
  const r = await client.request('GET', `${workspacePath}/sessions`)
  if (r.status >= 400) {
    const { detail } = (await r.json()) as { detail?: unknown }
    throw new Error(`daemon error ${String(r.status)}: ${String(detail)}`)
  }
  const rows: unknown = await r.json()
  return (
    Array.isArray(rows) &&
    rows.some((row) => (row as { session_id?: unknown }).session_id === sessionId)
  )
}

/**
 * Serve a workspace's MCP tools over stdio. The tools are the daemon's:
 * this relays stdio to the workspace's `/v1/workspaces/:id/mcp`
 * endpoint, starting the daemon when it is not running. A config with no
 * `workspace_id` makes a workspace that lives as long as this process, as
 * a stdio server's state does. A workspace with a name, the config's
 * `workspace_id` or `--workspace`, outlives it. The daemon answers a
 * config's name with the live workspace created from that same config,
 * and refuses it when the live one came from another. `--session` serves
 * the tools as that session, under its profile, as it does for
 * `mirage shell`. `--all-calls` also serves each VFS call as a
 * `vfs_<call>` tool, and `explain` on `shell` and on each of them.
 */
async function runMcp(config: string | undefined, options: McpCommandOptions): Promise<void> {
  if (options.workspace !== undefined && config !== undefined) {
    fail('pass a config or --workspace, not both', 2)
  }
  let path: string | undefined
  if (options.workspace === undefined) {
    try {
      path = resolveWorkspaceConfig(config, { envNames: MCP_ENV_NAMES })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), 2)
    }
  }
  const { relayStdio } = await import('@struktoai/mirage-server/mcp')
  await relayWorkspace(
    path,
    options.workspace,
    options.session,
    'mcp',
    relayStdio,
    options.allCalls === true,
  )
}

/**
 * Delete a relay's temporary workspace on the relay's own server. Sends the
 * token the relay last used, so it works after the login ended or changed
 * and without a refresh; only when the server refuses that token does it
 * ask the login for a fresh one and try once more. A delete that still
 * fails is reported on stderr.
 */
async function deleteWorkspace(client: DaemonClient, workspaceId: string): Promise<void> {
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const { url, idleGraceSeconds } = client.settings
  const attempt = (bearer: string): Promise<Response> =>
    makeClient({ url, idleGraceSeconds, authToken: bearer }).request('DELETE', path)
  let done = await attempt(client.held)
  if (done.status === 401 && client.settings.login !== undefined) {
    let fresh: string
    try {
      fresh = await client.token()
    } catch (error) {
      if (!(error instanceof LoginError)) throw error
      process.stderr.write(`could not delete workspace ${workspaceId}: ${error.message}\n`)
      return
    }
    done = await attempt(fresh)
  }
  if (!done.ok) {
    process.stderr.write(
      `could not delete workspace ${workspaceId}: daemon error ${String(done.status)}\n`,
    )
  }
}

/**
 * Relay this process's stdio to one of a workspace's endpoints. The
 * workspace is created from `path`, or `workspace` names one the daemon
 * holds; a created workspace with no `workspace_id` in its config is
 * deleted when the relay ends (see `deleteWorkspace`). A named session
 * must exist. `allCalls` asks the MCP endpoint for the VFS calls too.
 */
export async function relayWorkspace(
  path: string | undefined,
  workspace: string | undefined,
  session: string | undefined,
  endpoint: 'mcp' | 'rpc',
  relay: (url: string, token: () => Promise<string>) => Promise<void>,
  allCalls = false,
): Promise<void> {
  const client = makeClient(loadDaemonSettings())
  try {
    await client.ensureRunning({ allowSpawn: true })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  let workspaceId: string
  let minted = false
  if (path !== undefined) {
    const { checkWorkspaceConfigFile } = await import('@struktoai/mirage-node/config')
    const loaded = checkWorkspaceConfigFile(path)
    const body = JSON.stringify({ config: loaded })
    const created = await handleResponse(await client.request('POST', '/v1/workspaces', { body }))
    workspaceId = (created as { id: string }).id
    minted = typeof loaded.workspace_id !== 'string' || loaded.workspace_id === ''
  } else {
    workspaceId = workspace ?? ''
    await handleResponse(
      await client.request('GET', `/v1/workspaces/${encodeURIComponent(workspaceId)}`),
    )
  }
  const workspacePath = `/v1/workspaces/${encodeURIComponent(workspaceId)}`
  const query = new URLSearchParams()
  if (session !== undefined) query.set('session_id', session)
  if (allCalls) query.set('calls', 'all')
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  const url = `${client.settings.url}${workspacePath}/${endpoint}${suffix}`
  let refusal: string | undefined
  try {
    if (session !== undefined) {
      refusal = await hasSession(client, workspacePath, session).then(
        (found) => (found ? undefined : `session not found: ${session}`),
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
    }
    if (refusal === undefined) await relay(url, () => client.token())
  } finally {
    if (minted) await deleteWorkspace(client, workspaceId)
  }
  if (refusal !== undefined) fail(refusal, 2)
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .argument('[config]', 'Mirage workspace YAML config')
    .option('-w, --workspace <id>', 'Serve this daemon workspace instead of loading a config')
    .option('-s, --session <id>', "Session the tools act as; the workspace's default when absent")
    .option('--all-calls', 'Also serve each VFS call as a tool, and explain')
    .description("Serve a Mirage workspace's MCP tools over stdio.")
    .action(runMcp)
}
