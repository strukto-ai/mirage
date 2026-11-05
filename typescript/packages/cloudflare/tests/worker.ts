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

const app = createApp({ maxWorkspaces: 32 })

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
        runtimes: ['workspace', 'monty', 'quickjs'],
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
