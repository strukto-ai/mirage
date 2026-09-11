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
import { dirname, resolve } from 'node:path'
import type { Command } from 'commander'
import {
  absolutizeScripts,
  checkWorkspaceConfigFile,
  interpolateEnv,
} from '@struktoai/mirage-server'
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

// A config handed to `load` or `clone`: env-interpolated, and with its
// relative script paths and code refs rebased onto the file's directory
// exactly as `create` rebases them, so `resource: ./wiki.mjs:WikiResource`
// in an override means "next to this file", never "wherever the daemon
// runs". Not validated, because an override may name only a subset of
// mounts. Mirrors `_resolve_config_arg` in the Python CLI.
function loadConfigArgument(path: string): unknown {
  if (!existsSync(path)) fail(`config file not found: ${path}`, 2)
  const text = readFileSync(path, 'utf-8')
  let config: unknown
  try {
    config = interpolateEnv(yamlParse(text), envRecord())
  } catch (err: unknown) {
    fail(`invalid config YAML/JSON at ${path}: ${String(err)}`, 2)
  }
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    absolutizeScripts(config as Record<string, unknown>, dirname(resolve(path)))
  }
  return config
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
  cacheBytes: number | null
  cacheEntries: number | null
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
      const value = d.internals[k]
      lines.push(`  ${k.padEnd(16)} ${value === null ? 'n/a (not tracked)' : String(value)}`)
    }
  }
  return lines.join('\n')
}

interface AskRecord {
  id: string
  sessionId: string
  agentId: string
  command: string
  argv: string[]
  cwd: string
  paths: string[]
  reason: string
  outcome: string | null
  scope: string
  note: string
}

function formatAsks(items: AskRecord[]): string {
  if (items.length === 0) return 'No asks.'
  return formatTable(
    ['ID', 'SESSION', 'COMMAND', 'STATUS', 'REASON'],
    items.map((a) => [
      a.id,
      a.sessionId,
      [a.command, ...a.argv].join(' '),
      a.outcome ?? 'pending',
      a.reason,
    ]),
  )
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
      // Checked and env-interpolated here (the user's shell env is the
      // source of truth, and a missing var must fail before the round
      // trip), but sent in the file's own spelling: the daemon runs the
      // same check, and it speaks snake_case like the Python one.
      const cfg = checkWorkspaceConfigFile(configPath)
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

  ws.command('list-asks')
    .description('List pending asks (every decision with --all).')
    .argument('<id>')
    .option('--session <sessionId>', "Only this session's asks")
    .option('--all', 'Include settled decisions, not just pending asks')
    .action(async (id: string, opts: { session?: string; all?: boolean }) => {
      const params = new URLSearchParams()
      if (opts.session !== undefined) params.set('sessionId', opts.session)
      if (opts.all === true) params.set('all', 'true')
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const qs = params.toString()
      const r = await c.request('GET', `/v1/workspaces/${id}/asks${qs === '' ? '' : `?${qs}`}`)
      emit((await handleResponse(r)) as AskRecord[], formatAsks)
    })

  ws.command('allow')
    .description('Allow a pending ask; the retry of the asked line passes.')
    .argument('<id>')
    .argument('<askId>', 'Ask id, as quoted in the refusal')
    .option(
      '--scope <scope>',
      'once answers the exact line; session answers every line the rule covers',
      'once',
    )
    .option('--note <note>', 'What to record alongside the answer', '')
    .action(async (id: string, askId: string, opts: { scope: string; note: string }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', `/v1/workspaces/${id}/asks/${askId}`, {
        body: JSON.stringify({ answer: 'allow', scope: opts.scope, note: opts.note }),
      })
      emit((await handleResponse(r)) as AskRecord, (d) => `Allowed ${d.id} (${d.scope}).`)
    })

  ws.command('deny')
    .description('Deny a pending ask; the retry is refused in the deny voice, once.')
    .argument('<id>')
    .argument('<askId>', 'Ask id, as quoted in the refusal')
    .option('--note <note>', 'What to record alongside the answer', '')
    .action(async (id: string, askId: string, opts: { note: string }) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', `/v1/workspaces/${id}/asks/${askId}`, {
        body: JSON.stringify({ answer: 'deny', note: opts.note }),
      })
      emit((await handleResponse(r)) as AskRecord, (d) => `Denied ${d.id}.`)
    })

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
