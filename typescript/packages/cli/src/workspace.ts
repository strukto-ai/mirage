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

import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { Command } from 'commander'
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
// exactly as `create` rebases them, so `vfs: ./wiki.mjs:WikiVFS`
// in an override means "next to this file", never "wherever the daemon
// runs". Not validated, because an override may name only a subset of
// mounts. Mirrors `_resolve_config_arg` in the Python CLI, which is sync:
// this half is async only because it defers `mirage-node/config` and
// `yaml` so a `mirage` spawn that never loads a config pays neither. The
// behaviour is the same; the divergence is the `await`, and it is the
// reason `override` is a JsonValue rather than `unknown` -- dropping that
// `await` would otherwise typecheck and put `{}` on the wire.
async function loadConfigArgument(path: string): Promise<JsonValue> {
  if (!existsSync(path)) fail(`config file not found: ${path}`, 2)
  const { absolutizeScripts, interpolateEnv } = await import('@struktoai/mirage-node/config')
  const { parse: yamlParse } = await import('yaml')
  const text = readFileSync(path, 'utf-8')
  let config: JsonValue
  try {
    // `yamlParse` is typed `any`; naming the shape here is what lets
    // `override` be a JsonValue, which is what makes a dropped `await`
    // on this function a type error rather than an empty body on the wire.
    config = interpolateEnv(yamlParse(text) as JsonValue, envRecord())
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
  mount_count: number
  session_count: number
  created_at: number
}

interface MountSummary {
  prefix: string
  vfs: string
  mode: string
}

interface SessionSummary {
  session_id: string
  cwd: string
}

interface Internals {
  cache_bytes: number | null
  cache_entries: number | null
  history_length: number
  in_flight_jobs: number
}

interface WorkspaceDetail {
  id: string
  mode: string
  created_at: number
  mounts?: MountSummary[]
  sessions?: SessionSummary[]
  internals?: Internals | null
}

function formatWorkspaceList(items: WorkspaceBrief[]): string {
  if (items.length === 0) return 'No active workspaces.'
  const rows = items.map((w) => [
    w.id,
    w.mode,
    String(w.mount_count),
    String(w.session_count),
    formatAge(w.created_at),
  ])
  return formatTable(['ID', 'MODE', 'MOUNTS', 'SESSIONS', 'AGE'], rows)
}

function formatWorkspaceDetail(d: WorkspaceDetail): string {
  const lines: string[] = [
    `ID:        ${d.id}`,
    `Mode:      ${d.mode}`,
    `Created:   ${formatAge(d.created_at)} ago`,
  ]
  if (d.mounts !== undefined && d.mounts.length > 0) {
    const rows = d.mounts.map((m) => [m.prefix, m.vfs, m.mode])
    lines.push('', 'Mounts:')
    for (const ln of formatTable(['PREFIX', 'VFS', 'MODE'], rows).split('\n')) {
      lines.push('  ' + ln)
    }
  }
  if (d.sessions !== undefined && d.sessions.length > 0) {
    const rows = d.sessions.map((s) => [s.session_id, s.cwd])
    lines.push('', 'Sessions:')
    for (const ln of formatTable(['SESSION', 'CWD'], rows).split('\n')) {
      lines.push('  ' + ln)
    }
  }
  if (d.internals != null) {
    lines.push('', 'Internals:')
    for (const k of ['cache_bytes', 'cache_entries', 'history_length', 'in_flight_jobs'] as const) {
      const value = d.internals[k]
      lines.push(`  ${k.padEnd(16)} ${value === null ? 'n/a (not tracked)' : String(value)}`)
    }
  }
  return lines.join('\n')
}

interface AskRecord {
  id: string
  session_id: string
  agent_id: string
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
      a.session_id,
      [a.command, ...a.argv].join(' '),
      a.outcome ?? 'pending',
      a.reason,
    ]),
  )
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
      const { checkWorkspaceConfigFile } = await import('@struktoai/mirage-node/config')
      let cfg: unknown
      try {
        cfg = checkWorkspaceConfigFile(configPath)
      } catch (err: unknown) {
        fail(err instanceof Error ? err.message : String(err), 2)
      }
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
      const path =
        `/v1/workspaces/${encodeURIComponent(id)}` + (opts.verbose === true ? '?verbose=true' : '')
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
        (await handleResponse(
          await c.request('DELETE', `/v1/workspaces/${encodeURIComponent(id)}`),
        )) as {
          id: string
        },
        (d) => `Deleted workspace ${d.id}.`,
      )
    })

  ws.command('close')
    .description('Stop a workspace and keep its state for the same id.')
    .argument('<id>')
    .action(async (id: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(
        (await handleResponse(
          await c.request('POST', `/v1/workspaces/${encodeURIComponent(id)}/close`),
        )) as {
          id: string
        },
        (d) => `Closed workspace ${d.id}.`,
      )
    })

  ws.command('cancel')
    .description('Cancel the running and queued commands of every session.')
    .argument('<id>')
    .action(async (id: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(
        await handleResponse(
          await c.request('POST', `/v1/workspaces/${encodeURIComponent(id)}/cancel`),
        ),
      )
    })

  ws.command('kill')
    .description('Kill the background jobs of every session.')
    .argument('<id>')
    .action(async (id: string) => {
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      emit(
        await handleResponse(
          await c.request('POST', `/v1/workspaces/${encodeURIComponent(id)}/kill`),
        ),
      )
    })

  ws.command('clone')
    .description("Clone a workspace's live state.")
    .argument('<srcId>')
    .option('--id <id>', 'Explicit id for the clone')
    .action(async (srcId: string, opts: { id?: string }) => {
      const body: Record<string, unknown> = {}
      if (opts.id !== undefined) body.id = opts.id
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const r = await c.request('POST', `/v1/workspaces/${encodeURIComponent(srcId)}/clone`, {
        body: JSON.stringify(body),
      })
      emit((await handleResponse(r)) as WorkspaceDetail, formatWorkspaceDetail)
    })

  ws.command('list-asks')
    .description('List pending asks (every decision with --all).')
    .argument('<id>')
    .option('--session <sessionId>', "Only this session's asks")
    .option('--all', 'Include settled decisions, not just pending asks')
    .action(async (id: string, opts: { session?: string; all?: boolean }) => {
      const params = new URLSearchParams()
      if (opts.session !== undefined) params.set('session_id', opts.session)
      if (opts.all === true) params.set('all', 'true')
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const qs = params.toString()
      const r = await c.request(
        'GET',
        `/v1/workspaces/${encodeURIComponent(id)}/asks${qs === '' ? '' : `?${qs}`}`,
      )
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
      const r = await c.request(
        'POST',
        `/v1/workspaces/${encodeURIComponent(id)}/asks/${encodeURIComponent(askId)}`,
        {
          body: JSON.stringify({ answer: 'allow', scope: opts.scope, note: opts.note }),
        },
      )
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
      const r = await c.request(
        'POST',
        `/v1/workspaces/${encodeURIComponent(id)}/asks/${encodeURIComponent(askId)}`,
        {
          body: JSON.stringify({ answer: 'deny', note: opts.note }),
        },
      )
      emit((await handleResponse(r)) as AskRecord, (d) => `Denied ${d.id}.`)
    })

  ws.command('snapshot')
    .description(
      "Snapshot a workspace. The server sends the tar back and it is written to <output> here, whether the server runs on this machine or another; with --key it goes to the server's snapshot store.",
    )
    .argument('<id>')
    .argument('[output]', 'File to write the .tar to, on this machine')
    .option('--key <key>', "Put it in the server's snapshot store instead")
    .action(async (id: string, output: string | undefined, opts: { key?: string }) => {
      if (output !== undefined && opts.key !== undefined) {
        fail('snapshot takes an output file or --key', 2)
      }
      const c = buildClient()
      await c.ensureRunning({ allowSpawn: false })
      const path = `/v1/workspaces/${encodeURIComponent(id)}/snapshot`
      const human = (d: { id: string; size: number }, target: string): string =>
        `Snapshot ${d.id} -> ${target} (${d.size.toLocaleString()} bytes).`
      if (opts.key !== undefined) {
        const key = opts.key
        const r = await c.request('POST', path, {
          body: JSON.stringify({ key }),
          timeoutMs: null,
        })
        emit((await handleResponse(r)) as { id: string; key: string; size: number }, (d) =>
          human(d, key),
        )
        return
      }
      if (output === undefined) fail('snapshot takes an output file or --key', 2)
      const target = output
      const r = await c.request('GET', path, { timeoutMs: null })
      if (!r.ok) await handleResponse(r)
      const tar = new Uint8Array(await r.arrayBuffer())
      writeFileSync(target, tar)
      emit({ id, path: target, size: tar.byteLength }, (d) => human(d, target))
    })

  ws.command('load')
    .description(
      "Load a workspace from a snapshot. <file> is read here and uploaded, whether the server runs on this machine or another; with --key the tar comes from the server's snapshot store.",
    )
    .argument('[file]', 'The .tar to upload; omit with --key')
    .argument('[config]', 'Workspace YAML/JSON config')
    .option('--key <key>', "Load from the server's snapshot store")
    .option('--id <id>', 'Explicit workspace id')
    .action(
      async (
        first: string | undefined,
        second: string | undefined,
        opts: { key?: string; id?: string },
      ) => {
        const given = [first, second].filter((p): p is string => p !== undefined)
        if (opts.key !== undefined && given.length > 1)
          fail('load takes a FILE or --key, not both', 2)
        if (opts.key === undefined && given.length === 0) {
          fail('load takes a FILE (or --key) and an optional CONFIG', 2)
        }
        const tarPath = opts.key === undefined ? given.shift() : undefined
        const configPath = given[0]
        for (const p of [tarPath, configPath]) {
          if (p !== undefined && !existsSync(p)) fail(`file not found: ${p}`, 2)
        }
        const body: Record<string, JsonValue> = {}
        if (opts.id !== undefined) body.id = opts.id
        if (configPath !== undefined) body.override = await loadConfigArgument(configPath)
        const c = buildClient()
        await c.ensureRunning({ allowSpawn: true })
        const r =
          tarPath === undefined
            ? await c.request('POST', '/v1/workspaces/load', {
                body: JSON.stringify({ ...body, key: opts.key }),
                timeoutMs: null,
              })
            : await c.requestUpload('POST', '/v1/workspaces/load', body, {
                name: 'snapshot',
                data: createReadStream(tarPath),
              })
        emit((await handleResponse(r)) as WorkspaceDetail, formatWorkspaceDetail)
      },
    )
}
