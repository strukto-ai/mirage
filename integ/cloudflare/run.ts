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

import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  bindMount,
  compare,
  runCase,
  type Case,
  type ExecWorkspace,
} from '../runners/typescript/execution.ts'
import { GWS_TOKEN, seedGwsWorld } from '../runners/typescript/adapters/gws.ts'
import {
  loadCases,
  loadTargets,
  seedFixture,
  seedMountRoot,
  type Target,
} from '../runners/typescript/harness.ts'

// The integ corpus on the edge host: the same cases and goldens the node
// battery runs, each line sent to an edge worker (workerd, through
// `wrangler dev`) over the server API, its mounts and CLIs built from a
// config the way the node adapters build their instances. A case that needs
// more of a workspace than its shell (sessions, policy checks, faults, stat
// checks) is skipped and counted.

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const edge = resolve(root, '../typescript/packages/cloudflare')
const TOKEN = 'edge-test-token'

// The fakes the targets below run against, on the ports ci/fakes.json pins:
// the hf goldens carry the hub's URL verbatim.
const FAKES = {
  'hf-hub': { port: 5086, mcpPort: 5100 },
  mail: { port: 5085, imapPort: 3143, smtpPort: 3025 },
  slack: { port: 5097 },
  linear: { port: 5094 },
  // Off CI's 5098, which a local github fake may already hold; no golden names it.
  github: { port: 5198, fixture: 'cli' },
  discord: { port: 5090 },
  trello: { port: 5095 },
  airtable: { port: 5101 },
  notion: { port: 5091 },
  dify: { port: 5102 },
  mem0: { port: 5103 },
  gws: { port: 19999 },
}
// The mcp CLI's fake, a process of its own as CI runs it.
const MCP_PORT = 5110

type Config = Record<string, unknown>

// How long the edge worker may take over one request: past the corpus's
// slowest line, a 300,000-pass shell loop that takes over two minutes on a
// CI runner, and short of the five minutes Node's fetch waits for headers,
// as the shell route answers once its line ends. A line that hangs the
// worker, or a worker that never built (wrangler dev holds a request until
// one does), then fails the run rather than holding it to the job's limit.
const ANSWER_MS = 280_000

/** The edge worker left a request unanswered past its limit. */
class NoAnswer extends Error {}

/** A fetch our limit ended, or Node's own wait for headers or a body. */
function timedOut(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'TimeoutError') return true
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT'
}

/** A request of the edge worker's, failing once it has not answered in `ms`. */
async function edgeFetch(url: string, init: RequestInit = {}, ms = ANSWER_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
  } catch (e) {
    if (timedOut(e)) {
      throw new NoAnswer(`${url}: the edge worker did not answer in ${String(ms / 1000)} s`, {
        cause: e,
      })
    }
    throw e
  }
}

/** A fresh id per open, the shape the adapters' `runId` has. */
function runId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

function env(name: string): string {
  const value = process.env[name] ?? ''
  if (value === '') throw new Error(`the edge battery needs ${name}`)
  return value.replace(/\/+$/, '')
}

async function reset(url: string, body?: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
}

/**
 * The mounts a target names, `ram` ones as they are and the rest by `build`,
 * each under the mode the target gives it.
 */
function mounts(target: Target, build: (m: Target['mounts'][number]) => Config): Config {
  return Object.fromEntries(
    target.mounts.map((m) => [
      m.path,
      {
        ...(m.vfs === 'ram' ? { vfs: 'ram' } : { vfs: m.vfs, config: build(m) }),
        ...(m.mode !== undefined ? { mode: m.mode } : {}),
      },
    ]),
  )
}

/** The CLIs the workspace itself carries, which reach no service. */
function localClis(target: Target): Config {
  const names = (target.clis ?? []).filter((name) => name === 'git' || name === 'search')
  return names.length === 0
    ? {}
    : { clis: Object.fromEntries(names.map((name) => [name, { cli: name }])) }
}

/** A fake's base scoped to a run of its own, through its `/_run/<id>` segment. */
async function scopedRun(name: string, body: unknown = {}): Promise<string> {
  const scoped = `${env(name)}/_run/${runId()}`
  await reset(`${scoped}/reset`, body)
  return scoped
}

// One config per service, mirroring its opener in runners/typescript/adapters.
const OPENERS: Record<string, (target: Target) => Promise<Config>> = {
  'hf-hub': async (target) => {
    const endpoint = env('HF_HUB_URL')
    const token = `integ-hfhub-${runId()}`
    await reset(`${endpoint}/reset`, { tenants: [token], fixture: 'v1' })
    return {
      mounts: mounts(target, (m) => ({
        repo_id: m.repo,
        token,
        endpoint,
        ...(m.prefix !== undefined ? { key_prefix: m.prefix } : {}),
      })),
      ...(target.clis?.includes('hf') === true
        ? { clis: { hf: { cli: 'hf', config: { token, endpoint } } } }
        : {}),
    }
  },
  email: async (target) => {
    const base = env('MAIL_URL')
    const imap = new URL(env('MAIL_IMAP_URL'))
    const smtp = new URL(env('MAIL_SMTP_URL'))
    const password = runId()
    await reset(`${base}/_run/${password}/reset`, {
      tenants: ['integ', 'alpha', 'beta'],
      ...(target.mail !== undefined
        ? { extras: { manifest: target.mail.replace(/^email\//, '') } }
        : {}),
    })
    const account = (username: string): Config => ({
      imap_host: imap.hostname,
      imap_port: Number(imap.port),
      smtp_host: smtp.hostname,
      smtp_port: Number(smtp.port),
      username,
      password,
      use_ssl: false,
      trash_folder: 'Trash',
    })
    const installs: Record<string, string> = {
      himalaya: 'integ@example.com',
      h1: 'alpha@example.com',
      h2: 'beta@example.com',
    }
    return {
      mounts: mounts(target, () => ({ ...account('integ@example.com'), max_messages: 200 })),
      clis: Object.fromEntries(
        (target.clis ?? []).map((name) => {
          const user = installs[name]
          if (user === undefined) throw new Error(`email target: unknown cli ${name}`)
          return [name, { cli: 'himalaya', config: account(user) }]
        }),
      ),
    }
  },
  slack: async (target) => {
    const base = env('SLACK_URL')
    const workspace = `integ-${runId()}`
    await reset(`${base}/reset`, { tenants: [workspace], fixture: target.dataset ?? 'v1' })
    const auth = {
      token: `xoxb-${workspace}`,
      search_token: `xoxp-${workspace}`,
      base_url: `${base}/api`,
    }
    return {
      mounts: mounts(target, (m) => ({ ...(m.config ?? {}), ...auth })),
      ...(target.clis?.includes('slack') === true
        ? { clis: { slack: { cli: 'slack', config: auth } } }
        : {}),
    }
  },
  // RAM mounts, and git on them: nothing to reach.
  '': (target) =>
    Promise.resolve({
      mounts: mounts(target, () => ({})),
      ...localClis(target),
      ...(target.system_time !== undefined ? { system_time: target.system_time } : {}),
    }),
  github: async (target) => {
    const base = await scopedRun('GITHUB_URL', {
      fixture: target.clis?.includes('gh') === true ? 'cli' : 'v1',
    })
    return {
      mounts: mounts(target, (m) => {
        const [owner, repo] = String(m.repo).split('/')
        return { token: 'ghp-integ', owner, repo, base_url: base }
      }),
      ...(target.clis?.includes('gh') === true
        ? {
            clis: {
              gh: {
                cli: 'gh',
                config: {
                  token: 'ghp-integ',
                  base_url: base,
                  repo: 'integ/repo-cli',
                  // Not the default branch, so a line that falls back on
                  // it shows which of the two gh read.
                  branch: 'dev',
                },
              },
            },
          }
        : {}),
    }
  },
  discord: async (target) => {
    const base = env('DISCORD_URL')
    await reset(`${base}/reset`, { fixture: target.dataset ?? 'v1' })
    const auth = { token: 'integ-bot-token', base_url: `${base}/api/v10` }
    return {
      mounts: mounts(target, (m) => ({ ...(m.config ?? {}), ...auth })),
      ...(target.clis?.includes('discord') === true
        ? { clis: { discord: { cli: 'discord', config: auth } } }
        : {}),
    }
  },
  trello: async (target) => {
    const base = env('TRELLO_URL')
    await reset(`${base}/reset`)
    const auth = { api_key: 'integ-key', api_token: 'integ-token', base_url: base }
    // A target may scope the install to one mount's workspace and boards.
    const scope = target.mounts.find((m) => m.path === target.cli_scope)?.config ?? {}
    return {
      mounts: mounts(target, (m) => ({ ...auth, ...(m.config ?? {}) })),
      ...(target.clis?.includes('trello') === true
        ? { clis: { trello: { cli: 'trello', config: { ...auth, ...scope } } } }
        : {}),
    }
  },
  airtable: async (target) => {
    const base = `${await scopedRun('AIRTABLE_URL')}/v0`
    // maxReadRecords sits below the fixture's 25-record Backlog, as on node.
    const bounds = { max_read_records: 20, requests_per_second: 50 }
    const token = 'patIntegFullAccess.fake'
    return {
      mounts: mounts(target, (m) => ({
        token,
        base_url: base,
        ...(m.base_ids !== undefined ? { base_ids: m.base_ids } : {}),
        ...bounds,
      })),
      ...(target.clis?.includes('airtable') === true
        ? {
            clis: {
              airtable: {
                cli: 'airtable',
                config: {
                  token,
                  base_url: base,
                  base_ids: ['appRoadmapBase001', 'appOpsFinance0002'],
                  ...bounds,
                },
              },
            },
          }
        : {}),
    }
  },
  notion: async (target) => {
    // One fixed token, as on node: `ntn auth token` prints it.
    const token = 'integ-test'
    const base = `${await scopedRun('NOTION_URL', { tenants: [token] })}/v1`
    const auth = { api_key: token, base_url: base }
    return {
      mounts: mounts(target, () => auth),
      ...(target.clis?.includes('ntn') === true
        ? { clis: { ntn: { cli: 'ntn', config: auth } } }
        : {}),
    }
  },
  mcp: (target) => {
    const url = env('MCP_URL')
    const auth =
      target.cli_door === 'yaml'
        ? { type: 'header', name: 'X-Api-Key', token: 'integ-token' }
        : { type: 'bearer', token: 'integ-token' }
    return Promise.resolve({
      mounts: mounts(target, () => ({})),
      clis: Object.fromEntries(
        (target.clis ?? []).map((name) => [name, { cli: 'mcp', config: { url, auth } }]),
      ),
    })
  },
  dify: async (target) => {
    const base = env('DIFY_URL')
    await reset(`${base}/reset`)
    return {
      mounts: mounts(target, () => ({
        api_key: 'integ-key',
        base_url: base,
        dataset_id: target.dataset ?? 'kb-7f3a',
      })),
      ...localClis(target),
    }
  },
  mem0: async (target) => {
    const base = env('MEM0_URL')
    await reset(`${base}/reset`)
    return {
      mounts: mounts(target, () => ({
        api_key: 'integ-key',
        host: base,
        user_id: 'integ-user',
        default_page_size: 2,
      })),
      ...localClis(target),
    }
  },
  gws: async (target) => {
    const { base, folderIds } = await seedGwsWorld(target)
    const auth = {
      client_id: 'integ',
      client_secret: 'integ',
      refresh_token: GWS_TOKEN,
      api_base: base,
    }
    const scope = target.cli_scope
    return {
      mounts: mounts(target, (m) =>
        m.vfs === 'gdrive'
          ? { ...auth, folder_id: folderIds[m.path] }
          : // today is pinned so a calendar's rolling window lands on the seeded events.
            m.vfs === 'gcal'
            ? { ...auth, today: '2026-02-11', ...(m.config ?? {}) }
            : auth,
      ),
      ...(target.clis?.includes('gws') === true
        ? {
            clis: {
              gws: {
                cli: 'gws',
                config: {
                  ...auth,
                  ...(scope !== undefined ? { folder_id: folderIds[scope] } : {}),
                },
              },
            },
          }
        : {}),
    }
  },
  linear: async (target) => {
    const origin = env('LINEAR_URL')
    await reset(`${origin}/reset`)
    const auth = { api_key: 'integ-key', base_url: `${origin}/graphql` }
    return {
      mounts: mounts(target, () => auth),
      ...(target.clis?.includes('linear') === true
        ? { clis: { linear: { cli: 'linear', config: auth } } }
        : {}),
    }
  },
}

// What a case may ask of a workspace beyond its shell and its documents,
// which an edge workspace reached over the API does not offer here. A
// `clear_cache` case still runs, against warm caches: skipping it would skip
// the write it may make, and every later golden counts on that write.
// Cases whose object outgrows a Worker's 128 MB, where jq refuses it as it
// refuses one past a workspace's max_memory: they pass only with that refusal.
const OVER_ISOLATE_MEMORY = new Set([
  'jq_from_entries_builds_a_large_object',
  'jq_del_of_every_key',
])
// The `clear_cache` cases that check a size before its first read, which a
// warm cache already knows: they pass only with that size known.
const COLD_CACHE = new Set([
  'notion_head_does_not_populate_render_cache',
  'notion_unknown_size_find_direct_and_walk',
  'notion_head_lines_then_full_read',
  'notion_grep_early_then_full_read',
  'sz_notion_page_json_is_size_unknown_until_read',
  'g_native_tree_walk_sizes_from_the_read',
  'sz_trello_comments_jsonl_is_size_unknown_until_read',
])

function needsMore(c: Case): boolean {
  return (
    c.check !== undefined ||
    c.answer !== undefined ||
    c.faults !== undefined ||
    c.read !== undefined ||
    c.mount_capacity !== undefined ||
    c.scenario !== undefined
  )
}

/**
 * Put each session a case names under the profile it gives, creating the
 * session first when the workspace has none by that id. The profile goes
 * as the case states it: a parsed profile does not read back as one.
 */
async function applyProfiles(
  base: string,
  id: string,
  profiles: Record<string, unknown>,
): Promise<void> {
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
  const sessions = `${base}/v1/workspaces/${id}/sessions`
  for (const [sid, profile] of Object.entries(profiles)) {
    const listed = (await (await edgeFetch(sessions, { headers: auth })).json()) as {
      session_id: string
    }[]
    if (!listed.some((s) => s.session_id === sid)) {
      const created = await edgeFetch(sessions, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ session_id: sid }),
      })
      if (created.status !== 201) throw new Error(`session ${sid}: ${await created.text()}`)
    }
    const set = await edgeFetch(`${sessions}/${encodeURIComponent(sid)}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ profile }),
    })
    if (!set.ok) throw new Error(`session ${sid} profile: ${await set.text()}`)
  }
}

function unsupported(name: string): never {
  throw new Error(`an edge workspace over the API has no ${name} here`)
}

/** A workspace on the edge worker, its lines sent over the server API. */
function edgeWorkspace(base: string, id: string): ExecWorkspace {
  const enc = new TextEncoder()
  const shell: ExecWorkspace['shell'] = async (command, opts) => {
    const request = JSON.stringify({ command })
    const init: RequestInit =
      opts?.stdin === undefined
        ? { body: request, headers: { 'Content-Type': 'application/json' } }
        : (() => {
            const form = new FormData()
            form.append('request', new Blob([request], { type: 'application/json' }))
            form.append('stdin', new Blob([opts.stdin as Uint8Array<ArrayBuffer>]))
            return { body: form }
          })()
    const query =
      opts?.sessionId === undefined ? '' : `?session_id=${encodeURIComponent(opts.sessionId)}`
    const response = await edgeFetch(`${base}/v1/workspaces/${id}/shell${query}`, {
      ...init,
      method: 'POST',
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${TOKEN}`,
      },
    })
    const text = await response.text()
    let answer: {
      stdout?: string
      stderr?: string
      exit_code?: number
      error?: { message?: string }
    }
    try {
      answer = JSON.parse(text) as typeof answer
    } catch {
      // workerd answers in plain text when it ends the isolate.
      throw new Error(`${command}: ${String(response.status)} ${text.slice(0, 300)}`)
    }
    if (!response.ok)
      throw new Error(`${command}: ${String(response.status)} ${String(answer.error?.message)}`)
    return {
      stdout: enc.encode(answer.stdout ?? ''),
      stderr: enc.encode(answer.stderr ?? ''),
      exitCode: answer.exit_code ?? -1,
    } as Awaited<ReturnType<ExecWorkspace['shell']>>
  }
  // A document a case reads, or puts at `path` for its session's shell to find.
  const document = async (
    kind: 'vfs' | 'skill',
    path: string | undefined,
    sessionId: string | undefined,
  ): Promise<string> => {
    const scope = sessionId === undefined ? '' : `/sessions/${encodeURIComponent(sessionId)}`
    const response = await edgeFetch(`${base}/v1/workspaces/${id}${scope}/${kind}-md`, {
      method: path === undefined ? 'GET' : 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      ...(path === undefined ? {} : { body: JSON.stringify({ path }) }),
    })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`${kind}-md ${path ?? ''}: ${String(response.status)} ${text}`)
    return text
  }
  return {
    shell,
    vfs: { records: [] },
    env: {},
    dispatch: () => unsupported('dispatch'),
    cache: { clear: () => unsupported('cache') },
    mounts: () => unsupported('mounts'),
    createSession: () => unsupported('sessions'),
    listSessions: () => [],
    setSessionProfile: () => unsupported('sessions'),
    vfsMd: (path?: string, options?: { sessionId?: string }) =>
      document('vfs', path, options?.sessionId),
    skillMd: (path?: string, options?: { sessionId?: string }) =>
      document('skill', path, options?.sessionId),
    decisions: { pending: () => [], answer: () => unsupported('decisions') },
    explain: () => unsupported('explain'),
    close: async () => {
      await edgeFetch(`${base}/v1/workspaces/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    },
  } as unknown as ExecWorkspace
}

/** The fakes' launcher, its announced URLs put in this process's env. */
async function startFakes(dir: string): Promise<ChildProcess> {
  const config = join(dir, 'fakes.json')
  writeFileSync(config, JSON.stringify(FAKES))
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, 'server/launcher/main.ts'), '--config', config],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  const lines = createInterface({ input: child.stdout! })
  const wanted = [
    'HF_HUB_URL',
    'MAIL_URL',
    'MAIL_IMAP_URL',
    'MAIL_SMTP_URL',
    'SLACK_URL',
    'LINEAR_URL',
    'GITHUB_URL',
    'DISCORD_URL',
    'TRELLO_URL',
    'AIRTABLE_URL',
    'NOTION_URL',
    'DIFY_URL',
    'MEM0_URL',
    'GWS_URL',
  ]
  // Only this child's announcements count: a URL already exported names
  // another run's fake.
  const announced = new Set<string>()
  for await (const line of lines) {
    const at = line.indexOf('=')
    if (at > 0) {
      process.env[line.slice(0, at)] = line.slice(at + 1)
      announced.add(line.slice(0, at))
    }
    if (wanted.every((name) => announced.has(name))) return child
  }
  child.kill()
  throw new Error('the fakes exited before announcing their URLs')
}

/** A port no process on this host holds, so no other worker answers for this run's. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

/** The mcp CLI's fake, its URL put in this process's env. */
async function startMcp(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, 'server/mcp/main.ts'), '--port', String(MCP_PORT)],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  for await (const line of createInterface({ input: child.stdout! })) {
    if (!line.startsWith('MCP_URL=')) continue
    process.env.MCP_URL = `http://127.0.0.1:${String(MCP_PORT)}/mcp`
    return child
  }
  child.kill()
  throw new Error('the mcp fake exited before announcing its URL')
}

/**
 * Whether a session's inline permissions layer onto the target's default
 * profile, as a node workspace layers them. The API names a session's
 * profile and takes no inline document, so such a target stays on node.
 */
function layersSessions(t: Target): boolean {
  const base = t.profile ?? ('default' in (t.profiles ?? {}) ? 'default' : undefined)
  return (
    base !== undefined &&
    Object.values(t.sessions ?? {}).some(
      (spec) => typeof spec === 'object' && spec !== null && Object.keys(spec).length > 0,
    )
  )
}

/**
 * Whether the battery runs a target here: a service it opens, or RAM mounts
 * alone, with no secrets channel and no policy program on Pyodide, which an
 * edge isolate cannot load.
 */
function runsHere(t: Target): boolean {
  if (layersSessions(t)) return false
  if (t.service !== undefined) return OPENERS[t.service] !== undefined
  return (
    t.mounts.every((m) => m.vfs === 'ram' && (m.backend ?? 'memory') === 'memory') &&
    t.secrets === undefined &&
    !JSON.stringify(t.profiles ?? {}).includes('"runtime":"pyodide"')
  )
}

type Group = 'ram' | 'gdrive' | 'gdrive-folder' | 'rest'

const GROUPS: Group[] = ['ram', 'gdrive', 'gdrive-folder', 'rest']

function groupOf(target: Target): Group {
  switch (target.id) {
    case 'ram':
    case 'gdrive':
    case 'gdrive-folder':
      return target.id
    default:
      return 'rest'
  }
}

function selectTargets(runnable: Target[], args: string[]): Target[] {
  let targets: Target[]
  if (args[0] === '--group') {
    const group = args[1]
    if (args.length !== 2) throw new Error('--group needs exactly one group name')
    switch (group) {
      case 'ram':
      case 'gdrive':
      case 'gdrive-folder':
      case 'rest':
        targets = runnable.filter((target) => groupOf(target) === group)
        break
      default:
        throw new Error(`unknown edge group: ${String(group)}`)
    }
  } else {
    const unknown = args.filter((id) => !runnable.some((target) => target.id === id))
    if (unknown.length > 0) throw new Error(`the edge host runs no target ${unknown.join(', ')}`)
    targets = runnable.filter((target) => args.length === 0 || args.includes(target.id))
  }
  if (targets.length === 0) throw new Error('the edge selection contains no targets')
  return targets
}

function plan(
  runnable: Target[],
  cases: Case[],
  args: string[],
): { target: Target; cases: Case[] }[] {
  return selectTargets(runnable, args).map((target) => ({
    target,
    cases: cases.filter((c) => c.targets.includes(target.id)),
  }))
}

function checkGroups(runnable: Target[], cases: Case[]): void {
  assert.deepEqual(selectTargets(runnable, []), runnable)
  assert.deepEqual(
    selectTargets(runnable, ['gdrive-folder', 'ram']),
    runnable.filter((target) => target.id === 'ram' || target.id === 'gdrive-folder'),
  )
  for (const args of [
    ['--group'],
    ['--group', ''],
    ['--group', 'unknown'],
    ['--group', 'ram', 'gdrive'],
    ['--group', 'ram', '--group', 'rest'],
    ['unknown'],
  ]) {
    assert.throws(() => selectTargets(runnable, args))
  }
  assert.throws(() =>
    selectTargets(
      runnable.filter((target) => target.id !== 'ram'),
      ['--group', 'ram'],
    ),
  )
  assert.throws(() => selectTargets([], []))
  const targetIds = new Set<string>()
  const inventory = new Map<string, string[]>()
  for (const group of GROUPS) {
    const selected = plan(runnable, cases, ['--group', group])
    let executable = 0
    let skipped = 0
    for (const { target, cases: targetCases } of selected) {
      assert(!targetIds.has(target.id), `target occurs in multiple groups: ${target.id}`)
      targetIds.add(target.id)
      inventory.set(
        target.id,
        targetCases.map((c) => c.id),
      )
      executable += targetCases.filter((c) => !needsMore(c)).length
      skipped += targetCases.filter(needsMore).length
    }
    assert(executable > 0, `edge group ${group} has no executable cases`)
    console.log(
      `${group}: ${String(selected.length)} targets, ${String(executable)} executable, ${String(skipped)} skipped`,
    )
  }
  assert.deepEqual(targetIds, new Set(runnable.map((target) => target.id)))
  for (const target of runnable) {
    assert.deepEqual(
      inventory.get(target.id),
      cases.filter((c) => c.targets.includes(target.id)).map((c) => c.id),
      `edge group changes the ordered case inventory for ${target.id}`,
    )
  }
  console.log(
    'edge groups: disjoint and exhaustive targets and ordered cases; default selection unchanged',
  )
}

/** The edge test worker under `wrangler dev`, answering on `port`. */
async function startEdge(port: number): Promise<ChildProcess> {
  const child = spawn(
    join(edge, 'node_modules/.bin/wrangler'),
    [
      'dev',
      'tests/worker.ts',
      '--config',
      'tests/wrangler.toml',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
    ],
    {
      cwd: edge,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  )
  // Two minutes in all, each probe five seconds of it: a worker that fails
  // to build leaves wrangler dev holding the probe.
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('the edge worker exited before it answered')
    }
    try {
      if ((await edgeFetch(`http://127.0.0.1:${String(port)}/v1/health`, {}, 5_000)).ok) {
        return child
      }
    } catch {
      // Not listening yet, or not built.
    }
    await delay(500)
  }
  child.kill()
  throw new Error('the edge worker did not start in two minutes; its build is in the log above')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const runnable = [...loadTargets(root).values()].filter(runsHere)
  if (args[0] === '--check-groups') {
    if (args.length !== 1) throw new Error('--check-groups takes no other arguments')
    checkGroups(runnable, loadCases(root))
    return
  }
  const selected = plan(runnable, loadCases(root), args)
  const dir = mkdtempSync(join(tmpdir(), 'mirage-integ-edge-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${String(port)}`
  let fakes: ChildProcess | null = null
  let mcp: ChildProcess | null = null
  let worker: ChildProcess | null = null
  let passed = 0
  let failed = 0
  let skipped = 0
  let warm = 0
  let lost = 0
  let heavy = 0
  try {
    fakes = await startFakes(dir)
    mcp = await startMcp()
    worker = await startEdge(port)
    for (const { target, cases } of selected) {
      const config = await OPENERS[target.service ?? '']!(target)
      // A session's inline permissions document rides in as a profile of its
      // own, the one way the API names what a session runs under.
      const profiles: Config = { ...(target.profiles ?? {}) }
      const sessions = Object.entries(target.sessions ?? {}).map(([sid, spec]) => {
        if (typeof spec === 'string') return [sid, spec] as const
        if (spec === null || Object.keys(spec).length === 0) return [sid, null] as const
        profiles[`session-${sid}`] = spec
        return [sid, `session-${sid}`] as const
      })
      if (Object.keys(profiles).length > 0) config.profiles = profiles
      if (target.profile !== undefined) config.profile = target.profile
      if (target.env !== undefined) config.env = target.env
      const id = `integ-${target.id}-${runId()}`
      const ws = edgeWorkspace(base, id)
      const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
      // The workspace, its sessions and its seeds; again after workerd ends
      // an isolate, which takes every workspace it held with it.
      const open = async (): Promise<void> => {
        const created = await edgeFetch(`${base}/v1/workspaces`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ id, config }),
        })
        if (created.status !== 201) {
          throw new Error(`create answered ${String(created.status)} ${await created.text()}`)
        }
        for (const [sid, profile] of sessions) {
          const opened = await edgeFetch(`${base}/v1/workspaces/${id}/sessions`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ session_id: sid, ...(profile !== null ? { profile } : {}) }),
          })
          if (opened.status !== 201) throw new Error(`session ${sid}: ${await opened.text()}`)
        }
        for (const mount of target.mounts) {
          for (const [relative, text] of Object.entries(mount.files ?? {})) {
            const dest = `${mount.path.replace(/\/+$/, '')}/${relative}`
            await ws.shell(`mkdir -p ${dest.slice(0, dest.lastIndexOf('/'))}`)
            await ws.shell(`tee ${dest} > /dev/null`, { stdin: new TextEncoder().encode(text) })
          }
          await seedFixture(ws, mount.fixture, mount.path, root)
          if (mount.seed_root) await seedMountRoot(ws, mount.path)
        }
      }
      const alive = async (): Promise<boolean> =>
        (await edgeFetch(`${base}/v1/workspaces/${id}`, { headers: auth })).status !== 404
      try {
        await open()
      } catch (e) {
        if (e instanceof NoAnswer) throw e
        failed++
        console.log(`FAIL ${target.id}: ${String(e)}`)
        continue
      }
      try {
        for (const c of cases) {
          if (needsMore(c)) {
            skipped++
            continue
          }
          const { session_profiles: profiles, ...bound } = {
            ...bindMount(c, target.mounts[0]!.path),
            clear_cache: false,
          }
          let diffs: string[]
          let ran = false
          try {
            if (profiles !== undefined) await applyProfiles(base, id, profiles)
            const { exitCode, out, err, elapsed, notes } = await runCase(ws, bound)
            ran = true
            diffs = compare(bound, exitCode, out, err, elapsed, null, notes)
          } catch (e) {
            // A line the worker never answered leaves it wedged, failing
            // every line after it, so the run ends at that one.
            if (e instanceof NoAnswer) {
              throw new Error(`${target.id}/${bound.id}: ${bound.command}`, { cause: e })
            }
            diffs = [String(e)]
            if (!(await alive())) {
              lost++
              console.log(`LOST ${target.id}/${c.id}: the isolate ended; reopening`)
              await open()
            }
          }
          if (diffs.length === 0) {
            passed++
          } else if (
            OVER_ISOLATE_MEMORY.has(c.id) &&
            diffs.some((d) => d.includes('jq: memory exhausted'))
          ) {
            heavy++
          } else if (ran && COLD_CACHE.has(c.id)) {
            // It ran for the writes later goldens count on; what it checks
            // reads a cold cache, which the API cannot give it.
            warm++
          } else {
            failed++
            console.log(`FAIL ${target.id}/${bound.id}: ${bound.command}\n  ${diffs.join('\n  ')}`)
          }
        }
      } finally {
        await ws.close()
      }
      console.log(`ok ${target.id}`)
    }
  } finally {
    worker?.kill()
    mcp?.kill()
    fakes?.kill()
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(
    `\nedge: ${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped, ` +
      `${String(warm)} cold-cache checks unmet on a warm cache, ` +
      `${String(heavy)} refused past the isolate's memory, ${String(lost)} isolates lost`,
  )
  // A run that passed nothing proved nothing.
  if (failed > 0 || passed === 0) process.exitCode = 1
}

await main()
