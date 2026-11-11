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

import { networkRule, runWithNetwork } from '@struktoai/mirage-core/io/network'
import { Limit } from '@struktoai/mirage-core/types'
import { DurableObject } from 'cloudflare:workers'
import {
  createApp,
  D1SqlDriver,
  DurableObjectSqlDriver,
  MountMode,
  RAMVFS,
  RedisVFS,
  SqlVFS,
  SqlWorkspaceStateStore,
  Workspace,
  type D1DatabaseLike,
} from '../src/index.ts'
import { knownProviders } from '@struktoai/mirage-core/machine/registry'
import { PipeServer } from '@struktoai/mirage-core/mount/sftp'
import type { SqlDriver } from '@struktoai/mirage-core/vfs/sql/types'

interface Env {
  readonly DB: D1DatabaseLike
  readonly SQL_OBJECTS: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
}

interface SqlRun {
  readonly lines: readonly string[]
  readonly on: 'd1' | 'object'
  // The workspace's sessions, and on `object` its Durable Object.
  readonly id: string
}

// The corpus opens as many sessions a workspace as it does on the server.
const app = createApp({ maxWorkspaces: 32, maxSessions: 16 })

interface Run {
  readonly lines: readonly string[]
  readonly maxMemory?: string
  readonly lineSeconds?: number
  // A redis server and key prefix to mount at /r, over Cloudflare's sockets,
  // its keys dropped after the lines when `clear` is set.
  readonly redis?: { readonly url: string; readonly keyPrefix: string; readonly clear?: boolean }
}

interface Follow {
  readonly url: string
  readonly allowed: readonly string[]
}

/** `follow.url` fetched as a mount's client fetches, under a workspace's rule. */
async function follow({ url, allowed }: Follow): Promise<Response> {
  const network = { allowed_domains: allowed }
  const ws = new Workspace({ '/': new RAMVFS() }, { network })
  try {
    const response = await runWithNetwork(networkRule(network), () => fetch(url))
    return Response.json({ status: response.status, body: await response.text() })
  } catch (e) {
    return Response.json({ error: String(e) })
  } finally {
    await ws.close()
  }
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

// One SFTP v3 packet: its length, type and body.
function packet(kind: number, ...parts: (number | string | Uint8Array)[]): Uint8Array {
  const bytes = parts.map((part) => {
    if (part instanceof Uint8Array) return part
    if (typeof part === 'number') {
      const out = new Uint8Array(4)
      new DataView(out.buffer).setUint32(0, part)
      return out
    }
    const text = encoder.encode(part)
    const out = new Uint8Array(4 + text.length)
    new DataView(out.buffer).setUint32(0, text.length)
    out.set(text, 4)
    return out
  })
  const size = bytes.reduce((sum, part) => sum + part.length, 1)
  const out = new Uint8Array(4 + size)
  new DataView(out.buffer).setUint32(0, size)
  out[4] = kind
  let at = 5
  for (const part of bytes) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Read a file through the SFTP server as a machine's sshfs does: INIT, OPEN, READ. */
async function sftpRead(): Promise<Response> {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/data/f.txt', 'served from the edge')
  await ws.session('agent')
  let feed: ReadableStreamDefaultController<Uint8Array> | null = null
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      feed = controller
    },
  })
  let got = new Uint8Array()
  let wake = (): void => undefined
  const writer = {
    write(data: Uint8Array) {
      const next = new Uint8Array(got.length + data.length)
      next.set(got)
      next.set(data, got.length)
      got = next
      wake()
    },
    end() {
      return undefined
    },
  }
  const answer = async (): Promise<[number, Uint8Array]> => {
    const size = () => new DataView(got.buffer).getUint32(0)
    while (got.length < 4 || got.length < 4 + size()) {
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    const body = got.slice(5, 4 + size())
    const kind = got[4] ?? 0
    got = got.slice(4 + size())
    return [kind, body]
  }
  const served = new PipeServer(ws.vfs, ws.getSession('agent')).serve(reader, writer)
  const send = (data: Uint8Array) => feed?.enqueue(data)
  const close = () => feed?.close()
  try {
    send(packet(1, 3))
    const kinds = [(await answer())[0]]
    send(packet(3, 1, '/data/f.txt', 1, 0))
    const [opened, handle] = await answer()
    kinds.push(opened)
    send(packet(5, 2, handle.slice(4), 0, 0, 100))
    const [read, data] = await answer()
    kinds.push(read)
    return Response.json({ kinds, data: decoder.decode(data.slice(8)) })
  } finally {
    close()
    await served
    await ws.close()
  }
}

// A workspace whose files and sessions live in `driver`, as a fresh one
// built for each request: what it answers comes from the database alone.
async function sqlLines(driver: SqlDriver, run: SqlRun): Promise<Response> {
  const ws = new Workspace(
    { '/s': new SqlVFS(driver) },
    {
      mode: MountMode.EXEC,
      workspaceId: run.id,
      store: new SqlWorkspaceStateStore(driver, { scope: run.id }),
      ownsStore: true,
    },
  )
  try {
    const results = []
    for (const line of run.lines) {
      const result = await ws.shell(line)
      results.push({
        exit: result.exitCode,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      })
    }
    return Response.json(results)
  } finally {
    await ws.close()
  }
}

/** A SQLite-backed Durable Object whose workspace lives in its own storage. */
export class SqlObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    return sqlLines(new DurableObjectSqlDriver(this.ctx.storage), (await request.json()) as SqlRun)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/follow') return follow((await request.json()) as Follow)
    if (pathname === '/sftp') return sftpRead()
    if (pathname === '/machines') return Response.json(knownProviders())
    if (pathname === '/sql') {
      const run = (await request.clone().json()) as SqlRun
      if (run.on === 'd1') return sqlLines(new D1SqlDriver(env.DB), run)
      return env.SQL_OBJECTS.get(env.SQL_OBJECTS.idFromName(run.id)).fetch(request)
    }
    if (pathname !== '/run') return app.fetch(request)
    const run = (await request.json()) as Run
    const redis = run.redis !== undefined ? new RedisVFS(run.redis) : null
    const ws = new Workspace(
      {
        '/data': new RAMVFS(),
        '/tmp': new RAMVFS(),
        ...(redis !== null ? { '/r': redis } : {}),
      },
      {
        mode: MountMode.EXEC,
        runtimes: ['workspace', 'monty'],
        ...(run.maxMemory !== undefined ? { maxMemory: run.maxMemory } : {}),
        ...(run.lineSeconds !== undefined
          ? { commandLimits: { '@line': new Limit({ timeoutSeconds: run.lineSeconds }) } }
          : {}),
      },
    )
    try {
      const results = []
      for (const line of run.lines) {
        const result = await ws.shell(line)
        results.push({
          exit: result.exitCode,
          stdout: decoder.decode(result.stdout),
          stderr: decoder.decode(result.stderr),
        })
      }
      if (run.redis?.clear === true) await redis?.store.clear()
      return Response.json(results)
    } finally {
      await ws.close()
    }
  },
}
