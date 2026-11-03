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

import { readAsText, SESSION } from '../../accessor/postgres.ts'
import type { PgDriver, PgQueryResult } from '../../core/postgres/_driver.ts'
import { judgeSocket } from '../../io/web/network.ts'
import { missingPeer } from '../../utils/optional_peer.ts'
import type { resolvePostgresConfig } from './config.ts'

interface PgPoolLike {
  query: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>
  end: () => Promise<void>
  on: (event: 'error', listener: (err: Error) => void) => unknown
}

interface PgModule {
  Pool: new (options: Record<string, unknown>) => PgPoolLike
  types: Parameters<typeof readAsText>[0]
}

function onWorkers(): boolean {
  return (
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
    'Cloudflare-Workers'
  )
}

const DEFAULT_PORT = 5432

/**
 * The hosts and port a DSN connects to, as pg reads a URL or a list of
 * `key=value` pairs: a `host` parameter overrides the URL's, and a comma
 * lists several hosts.
 */
function dsnEndpoints(dsn: string): [string, number][] {
  let hosts = ''
  let port = ''
  if (/^postgres(ql)?:\/\//i.test(dsn)) {
    const url = new URL(dsn)
    hosts = url.searchParams.get('host') ?? decodeURIComponent(url.hostname)
    port = url.searchParams.get('port') ?? url.port
  } else {
    for (const [, key, value] of dsn.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g)) {
      const bare = (value ?? '').replace(/^'(.*)'$/, '$1')
      if (key === 'host' || key === 'hostaddr') hosts ||= bare
      if (key === 'port') port = bare
    }
  }
  const number = port === '' ? DEFAULT_PORT : Number(port)
  return (hosts === '' ? 'localhost' : hosts).split(',').map((host) => [host, number])
}

export class PostgresStore implements PgDriver {
  readonly config: ReturnType<typeof resolvePostgresConfig>
  private poolPromise: Promise<PgPoolLike> | null = null

  constructor(config: ReturnType<typeof resolvePostgresConfig>) {
    this.config = config
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<R>> {
    // An edge isolate opens the connection past its fetch guard, so the
    // network rule is asked here; elsewhere this is a no-op.
    for (const [host, port] of dsnEndpoints(this.config.dsn)) judgeSocket(host, port)
    const pool = await this._pool()
    const result = await pool.query(sql, params)
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 }
  }

  async close(): Promise<void> {
    if (this.poolPromise === null) return
    const pool = await this.poolPromise
    this.poolPromise = null
    await pool.end()
  }

  private async _pool(): Promise<PgPoolLike> {
    this.poolPromise ??= this._connect()
    return this.poolPromise
  }

  protected async _connect(): Promise<PgPoolLike> {
    const mod = (await import('pg').catch(
      missingPeer({ feature: 'PostgresVFS', packageName: 'pg' }),
    )) as unknown as { default?: PgModule } & Partial<PgModule>
    const Pool = mod.default?.Pool ?? mod.Pool
    const types = mod.default?.types ?? mod.types
    if (Pool === undefined || types === undefined) {
      throw new Error('postgres: pg package missing Pool or types export')
    }
    const pool = new Pool({
      connectionString: this.config.dsn,
      connectionTimeoutMillis: this.config.timeout * 1000,
      options: Object.entries(SESSION)
        .map(([name, value]) => `-c ${name}=${value}`)
        .join(' '),
      types: readAsText(types),
      // A Workers isolate cannot use a socket opened by one request in the
      // next, so there a connection serves one query and closes.
      ...(onWorkers() ? { maxUses: 1 } : {}),
    })
    // pg emits `error` for an idle connection the server or the network
    // dropped, and Node throws an `error` event nobody listens for, which would
    // end the process. The pool has already discarded that connection and the
    // next query takes a fresh one, so the listener is all the handling it
    // needs.
    pool.on('error', () => undefined)
    return pool
  }
}
