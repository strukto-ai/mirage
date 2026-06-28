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

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { interpolateEnv, loadWorkspaceConfigFile } from '@struktoai/mirage-server'
import { parse as yamlParse } from 'yaml'
import { makeClient } from './client.ts'
import { emit, fail, formatAge, formatTable, handleResponse } from './output.ts'
import { loadDaemonSettings } from './settings.ts'

function buildClient() {
  return makeClient(loadDaemonSettings())
}

function envRecord(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function loadConfigArgument(path: string): unknown {
  if (!existsSync(path)) fail(`config file not found: ${path}`, 2)
  const text = readFileSync(path, 'utf-8')
  try {
    return interpolateEnv(yamlParse(text), envRecord())
  } catch (err: unknown) {
    fail(`invalid config YAML/JSON at ${path}: ${String(err)}`, 2)
  }
}

interface WorkspaceBrief {
  id: string
  mode: string
  mountCount: number
  sessionCount: number
  createdAt: number
}

interface MountSummary {
  prefix: string
  resource: string
  mode: string
}

interface SessionSummary {
  sessionId: string
  cwd: string
}

interface Internals {
  cacheBytes: number
  cacheEntries: number
  historyLength: number
  inFlightJobs: number
}

interface WorkspaceDetail {
  id: string
  mode: string
  createdAt: number
  mounts?: MountSummary[]
  sessions?: SessionSummary[]
  internals?: Internals | null
}

function formatWorkspaceList(items: WorkspaceBrief[]): string {
  if (items.length === 0) return 'No active workspaces.'
  const rows = items.map((w) => [
    w.id,
    w.mode,
    String(w.mountCount),
    String(w.sessionCount),
    formatAge(w.createdAt),
  ])
  return formatTable(['ID', 'MODE', 'MOUNTS', 'SESSIONS', 'AGE'], rows)
}

function formatWorkspaceDetail(d: WorkspaceDetail): string {
  const lines: string[] = [
    `ID:        ${d.id}`,
    `Mode:      ${d.mode}`,
    `Created:   ${formatAge(d.createdAt)} ago`,
  ]
  if (d.mounts !== undefined && d.mounts.length > 0) {
    const rows = d.mounts.map((m) => [m.prefix, m.resource, m.mode])
    lines.push('', 'Mounts:')
    for (const ln of formatTable(['PREFIX', 'RESOURCE', 'MODE'], rows).split('\n')) {
      lines.push('  ' + ln)
    }
  }
  if (d.sessions !== undefined && d.sessions.length > 0) {
    const rows = d.sessions.map((s) => [s.sessionId, s.cwd])
    lines.push('', 'Sessions:')
    for (const ln of formatTable(['SESSION', 'CWD'], rows).split('\n')) {
      lines.push('  ' + ln)
    }
  }
  if (d.internals != null) {
    lines.push('', 'Internals:')
    for (const k of ['cacheBytes', 'cacheEntries', 'historyLength', 'inFlightJobs'] as const) {
      lines.push(`  ${k.padEnd(16)} ${String(d.internals[k])}`)
    }
  }
  return lines.join('\n')
}

interface VersionLogItem {
  id: string
  message: string
}

interface DiffResult {
  added: string[]
  modified: string[]
  deleted: string[]
}

function formatVersionLog(items: VersionLogItem[]): string {
  if (items.length === 0) return 'No versions.'
  return formatTable(
    ['VERSION', 'MESSAGE'],
    items.map((v) => [v.id.slice(0, 12), v.message]),
  )
}

function formatDiff(changes: DiffResult): string {
  const lines: string[] = []
  for (const kind of ['added', 'modified', 'deleted'] as const) {
    for (const path of changes[kind]) lines.push(`${kind.padEnd(9)} ${path}`)
  }
  return lines.length > 0 ? lines.join('\n') : 'No changes.'
}

export function registerWorkspaceCommands(program: Command): void {
  const ws = program.command('workspace').description('Manage workspaces.')

  ws.command('create')
    .description('Create a workspace; daemon auto-spawns if not running.')
    .argument('<config>', 'YAML/JSON workspace config')
    .option('--id <id>', 'Explicit workspace id')
    .action(async (configPath: string, opts: { id?: string }) => {
      const cfg = loadWorkspaceConfigFile(configPath)
      const body: { config: unknown; id?: string } = { config: cfg }
      if (opts.id !== undefined) body.id = opts.id
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: true })
      const r = await c.request('POST', '/v1/workspaces', { body: JSON.stringify(body) })
      emit((await handleResponse(r)) as WorkspaceDetail, formatWorkspaceDetail)
    })

  ws.command('list')
    .description('List active workspaces.')
    .action(async () => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(
        (await handleResponse(await c.request('GET', '/v1/workspaces'))) as WorkspaceBrief[],
        formatWorkspaceList,
      )
    })

  ws.command('get')
    .description('Show full details for one workspace.')
    .argument('<id>')
    .option('--verbose', 'Include cache/dirty/history internals')
    .action(async (id: string, opts: { verbose?: boolean }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const path = `/v1/workspaces/${id}` + (opts.verbose === true ? '?verbose=true' : '')
      emit(
        (await handleResponse(await c.request('GET', path))) as WorkspaceDetail,
        formatWorkspaceDetail,
      )
    })

  ws.command('delete')
    .description('Stop and remove a workspace.')
    .argument('<id>')
    .action(async (id: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(
        (await handleResponse(await c.request('DELETE', `/v1/workspaces/${id}`))) as {
          id: string
        },
        (d) => `Deleted workspace ${d.id}.`,
      )
    })

  ws.command('clone')
    .description('Clone a workspace, optionally from one of its past versions.')
    .argument('<srcId>')
    .option('--id <id>', 'Explicit id for the clone')
    .option('--at <ref>', 'Clone from a past version (id or branch) not the live state')
    .action(async (srcId: string, opts: { id?: string; at?: string }) => {
      const body: Record<string, unknown> = { sourceId: srcId }
      if (opts.id !== undefined) body.id = opts.id
      if (opts.at !== undefined) body.at = opts.at
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', '/v1/workspaces/clone', { body: JSON.stringify(body) })
      emit((await handleResponse(r)) as WorkspaceDetail, formatWorkspaceDetail)
    })

  ws.command('commit')
    .description("Commit the workspace's current state as a version.")
    .argument('<id>')
    .option('-m, --message <msg>', 'Version message', '')
    .option('-b, --branch <branch>', 'Branch to commit on', 'main')
    .action(async (id: string, opts: { message: string; branch: string }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', `/v1/workspaces/${id}/commit`, {
        body: JSON.stringify({ message: opts.message, branch: opts.branch }),
      })
      emit(
        (await handleResponse(r)) as { version: string; branch: string },
        (d) => `Committed ${d.version.slice(0, 12)} on ${d.branch}.`,
      )
    })

  ws.command('branch')
    .description("Create a branch at another branch's current version.")
    .argument('<id>')
    .argument('<name>')
    .option('--from <branch>', 'Branch to fork from', 'main')
    .action(async (id: string, name: string, opts: { from: string }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', `/v1/workspaces/${id}/branch`, {
        body: JSON.stringify({ name, fromBranch: opts.from }),
      })
      emit(
        (await handleResponse(r)) as { branch: string; version: string },
        (d) => `Created branch ${d.branch} at ${d.version.slice(0, 12)}.`,
      )
    })

  ws.command('log')
    .description("List a workspace's versions (newest first).")
    .argument('<id>')
    .option('-b, --branch <branch>', 'Branch', 'main')
    .action(async (id: string, opts: { branch: string }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('GET', `/v1/workspaces/${id}/versions?branch=${opts.branch}`)
      emit((await handleResponse(r)) as VersionLogItem[], formatVersionLog)
    })

  ws.command('diff')
    .description('Show changed files (git-style): live vs HEAD, live vs <a>, or <a> vs <b>.')
    .argument('<id>')
    .argument('[a]', 'Base ref; omit to use live state')
    .argument('[b]', 'Compare ref; omit to use live state')
    .option('-b, --branch <branch>', 'Branch', 'main')
    .action(
      async (
        id: string,
        a: string | undefined,
        b: string | undefined,
        opts: { branch: string },
      ) => {
        const params = new URLSearchParams({ branch: opts.branch })
        if (a !== undefined) params.set('a', a)
        if (b !== undefined) params.set('b', b)
        const c = buildClient()
        await c.ensureRunning({ allowSpawn: false })
        const r = await c.request('GET', `/v1/workspaces/${id}/diff?${params.toString()}`)
        emit((await handleResponse(r)) as DiffResult, formatDiff)
      },
    )

  ws.command('checkout')
    .description('Restore a workspace in place to one of its versions.')
    .argument('<id>')
    .argument('<ref>', 'Version id or branch to restore')
    .action(async (id: string, ref: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', `/v1/workspaces/${id}/checkout`, {
        body: JSON.stringify({ ref }),
      })
      emit((await handleResponse(r)) as WorkspaceDetail, formatWorkspaceDetail)
    })

  ws.command('snapshot')
    .description(
      'Snapshot a workspace to a tar file. The path is resolved to an absolute path and the daemon writes the tar.',
    )
    .argument('<id>')
    .argument('<output>', 'Path to write the .tar to')
    .action(async (id: string, output: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', `/v1/workspaces/${id}/snapshot`, {
        body: JSON.stringify({ path: resolve(output) }),
      })
      const d = (await handleResponse(r)) as { id: string; path: string; size: number }
      emit(d, (x) => `Snapshot ${x.id} -> ${x.path} (${x.size.toLocaleString()} bytes).`)
    })

  ws.command('load')
    .description('Load a workspace from a tar file.')
    .argument('<tar>', 'Path to a .tar produced by `mirage workspace snapshot`')
    .argument('[config]', 'Workspace YAML/JSON config')
    .option('--id <id>', 'Explicit workspace id')
    .action(async (tarPath: string, configPath: string | undefined, opts: { id?: string }) => {
      if (!existsSync(tarPath)) fail(`tar file not found: ${tarPath}`, 2)
      const body: { path: string; id?: string; override?: unknown } = { path: resolve(tarPath) }
      if (opts.id !== undefined) body.id = opts.id
      if (configPath !== undefined) body.override = loadConfigArgument(configPath)
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: true })
      const r = await c.request('POST', '/v1/workspaces/load', { body: JSON.stringify(body) })
      emit((await handleResponse(r)) as WorkspaceDetail, formatWorkspaceDetail)
    })
}
