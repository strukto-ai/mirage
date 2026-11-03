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

import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// checks, cache control) is skipped and counted.

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const edge = resolve(root, '../typescript/packages/edge')
const TOKEN = 'edge-test-token'

// The fakes the targets below run against, on the ports ci/fakes.json pins:
// the hf goldens carry the hub's URL verbatim.
const FAKES = {
  'hf-hub': { port: 5086, mcpPort: 5100 },
  mail: { port: 5085, imapPort: 3143, smtpPort: 3025 },
  slack: { port: 5097 },
  linear: { port: 5094 },
}

type Config = Record<string, unknown>

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

/** The mounts a target names, `ram` ones as they are and the rest by `build`. */
function mounts(target: Target, build: (m: Target['mounts'][number]) => Config): Config {
  return Object.fromEntries(
    target.mounts.map((m) => [
      m.path,
      m.vfs === 'ram' ? { vfs: 'ram' } : { vfs: m.vfs, config: build(m) },
    ]),
  )
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

// What a case may ask of a workspace beyond its shell, which an edge
// workspace reached over the API does not offer here. A `clear_cache` case
// still runs, against warm caches: skipping it would skip the write it may
// make, and every later golden counts on that write.
function needsMore(c: Case): boolean {
  return (
    c.session_profiles !== undefined ||
    c.documents !== undefined ||
    c.check !== undefined ||
    c.answer !== undefined ||
    c.faults !== undefined ||
    c.read !== undefined ||
    c.mount_capacity !== undefined ||
    c.scenario !== undefined
  )
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
    const response = await fetch(`${base}/v1/workspaces/${id}/shell${query}`, {
      ...init,
      method: 'POST',
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${TOKEN}`,
      },
    })
    const answer = (await response.json()) as {
      stdout?: string
      stderr?: string
      exit_code?: number
      detail?: unknown
    }
    if (!response.ok)
      throw new Error(`${command}: ${String(response.status)} ${JSON.stringify(answer.detail)}`)
    return {
      stdout: enc.encode(answer.stdout ?? ''),
      stderr: enc.encode(answer.stderr ?? ''),
      exitCode: answer.exit_code ?? -1,
    } as Awaited<ReturnType<ExecWorkspace['shell']>>
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
    vfsMd: () => unsupported('VFS.md'),
    skillMd: () => unsupported('SKILL.md'),
    decisions: { pending: () => [], answer: () => unsupported('decisions') },
    explain: () => unsupported('explain'),
    close: async () => {
      await fetch(`${base}/v1/workspaces/${id}`, {
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
  ]
  for await (const line of lines) {
    const at = line.indexOf('=')
    if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1)
    if (wanted.every((name) => process.env[name] !== undefined)) break
  }
  return child
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
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/v1/health`)).ok) return child
    } catch {
      await delay(500)
    }
  }
  child.kill()
  throw new Error('the edge worker did not start')
}

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  const dir = mkdtempSync(join(tmpdir(), 'mirage-integ-edge-'))
  const fakes = await startFakes(dir)
  const port = 8799
  const worker = await startEdge(port)
  const base = `http://127.0.0.1:${String(port)}`
  const cases = loadCases(root)
  const targets = [...loadTargets(root).values()].filter(
    (t) =>
      OPENERS[t.service ?? ''] !== undefined &&
      t.env === undefined &&
      (only.length === 0 || only.includes(t.id)),
  )
  let passed = 0
  let failed = 0
  let skipped = 0
  try {
    for (const target of targets) {
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
      const id = `integ-${target.id}-${runId()}`
      const created = await fetch(`${base}/v1/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ id, config }),
      })
      if (created.status !== 201) {
        failed++
        console.log(
          `FAIL ${target.id}: create answered ${String(created.status)} ${await created.text()}`,
        )
        continue
      }
      const ws = edgeWorkspace(base, id)
      try {
        for (const [sid, profile] of sessions) {
          const opened = await fetch(`${base}/v1/workspaces/${id}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ session_id: sid, ...(profile !== null ? { profile } : {}) }),
          })
          if (opened.status !== 201) throw new Error(`session ${sid}: ${await opened.text()}`)
        }
        for (const mount of target.mounts) {
          await seedFixture(ws, mount.fixture, mount.path, root)
          if (mount.seed_root) await seedMountRoot(ws, mount.path)
        }
        for (const c of cases) {
          if (!c.targets.includes(target.id)) continue
          if (needsMore(c)) {
            skipped++
            continue
          }
          const bound = { ...bindMount(c, target.mounts[0]!.path), clear_cache: false }
          const { exitCode, out, err, elapsed, notes } = await runCase(ws, bound)
          const diffs = compare(bound, exitCode, out, err, elapsed, null, notes)
          if (diffs.length === 0) {
            passed++
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
    worker.kill()
    fakes.kill()
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(
    `\nedge: ${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped`,
  )
  if (failed > 0) process.exitCode = 1
}

await main()
