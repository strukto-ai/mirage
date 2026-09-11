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

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KitError } from './errors.ts'
import type { SeedReport } from './types.ts'
import { runId } from './tenant.ts'

export interface MinimalClient {
  $disconnect(): Promise<void>
}

export type ClientCtor<C extends MinimalClient> = new (opts: { datasourceUrl: string }) => C

export interface PoolOptions<C extends MinimalClient> {
  service: string
  schema: string
  ctor: ClientCtor<C>
}

const SCHEMA_ENV = 'INTEG_DB_URL'

function prismaBin(): string {
  return createRequire(import.meta.url).resolve('prisma/build/index.js')
}

// Measured on this repo: the CLI spawn is ~374ms of which only ~10ms is engine
// work, and a file copy is ~1ms. So the schema is pushed ONCE into a template
// file per pool and every run file is a copy of it. A per-run push
// would put a third of a second on the clock for each /reset.
//
// This is the ONE synchronous spawn on a fake's startup path, and a spawn that
// blocks the event loop is a spawn no timer can interrupt: a CLI that stalls
// (its own update check, an engine fetch, a wedged schema engine) hangs the
// whole launcher with nothing written anywhere. CI saw exactly that, sixty
// seconds of silence and then "only 0 of 14 endpoints came up". The timeout is
// thirty times the measured cost, and the CLI's stderr is appended explicitly:
// node folds it into the message of a failed command but not of a killed one,
// which says only ETIMEDOUT, so the first line is kept and stderr added once.
function pushTemplate(schema: string, target: string): void {
  try {
    execFileSync('node', [prismaBin(), 'db', 'push', '--schema', schema, '--skip-generate'], {
      env: { ...process.env, [SCHEMA_ENV]: `file:${target}` },
      stdio: 'pipe',
      timeout: 30_000,
    })
  } catch (err: unknown) {
    const stderr =
      err instanceof Error && 'stderr' in err ? String(err.stderr as Buffer | string).trim() : ''
    const head = String(err).split('\n')[0] ?? String(err)
    throw new KitError(`db push failed for ${schema}: ${head}${stderr === '' ? '' : `\n${stderr}`}`)
  }
}

// One SQLite FILE per run, keyed by run name. This is the isolation
// level that lets two runs share a process; the tenant column is the other one
// and lives inside a file. The client is constructed with `datasourceUrl`, not
// by mutating process.env: env is process-wide, so the env route cannot serve
// a second run at all (whichever client was constructed last wins).
// The template file and the seed report it would have produced. The report
// rides along because /reset answers with it, and a run served from a copy
// never ran the seed that counts the rows.
export interface SeededTemplate {
  file: string
  rows: SeedReport[]
}

export class ClientPool<C extends MinimalClient> {
  readonly service: string
  readonly schema: string
  readonly root: string
  private readonly internal: string
  private readonly ctor: ClientCtor<C>
  private readonly clients = new Map<string, C>()
  private readonly seeded = new Map<string, Promise<SeededTemplate>>()
  private builds = 0
  private template: string | null = null

  constructor(opts: PoolOptions<C>) {
    this.service = opts.service
    this.schema = opts.schema
    this.ctor = opts.ctor
    this.root = mkdtempSync(join(tmpdir(), `mirage-kit-${opts.service}-${runId()}-`))
    // Templates live BESIDE the run files, not among them. A run is named by
    // the caller and its file is `<root>/<run>.db`, so a template sharing that
    // directory is only safe while no legal run name can spell one. That is
    // true today (checkName refuses a leading underscore, which is why these
    // names have one) but it is an invariant enforced in another module, and a
    // template quietly overwritten by a reset would hand later runs the wrong
    // database while still reporting the original seed. A directory the run
    // namespace cannot reach at all costs one mkdir.
    this.internal = join(this.root, '.templates')
    mkdirSync(this.internal, { recursive: true })
  }

  fileFor(run: string): string {
    return join(this.root, `${run}.db`)
  }

  has(run: string): boolean {
    return this.clients.has(run) || existsSync(this.fileFor(run))
  }

  private ensureTemplate(): string {
    if (this.template === null) {
      const path = join(this.internal, 'schema.db')
      pushTemplate(this.schema, path)
      this.template = path
    }
    return this.template
  }

  client(run: string): C {
    return this.clientFrom(run, this.ensureTemplate())
  }

  private clientFrom(run: string, template: string): C {
    const live = this.clients.get(run)
    if (live !== undefined) return live
    const file = this.fileFor(run)
    copyFileSync(template, file)
    const made = new this.ctor({ datasourceUrl: `file:${file}` })
    this.clients.set(run, made)
    return made
  }

  // A run whose seed is already on disk costs a file copy instead of a seed.
  // The template is built ONCE per key, in a throwaway run that is then
  // DISCONNECTED before the file is copied: SQLite writes through a -wal that
  // only the last connection closing folds back in, so snapshotting a live run
  // file would capture a database missing its most recent commits. The
  // throwaway is the reason this cannot just copy the run that happened to be
  // seeded first.
  //
  // Only NEW runs can use it. An existing run is reset by deleting its named
  // tenants and reseeding them, because recreating its file would destroy the
  // other tenants living in it, which is the whole reason a scoped reset
  // exists.
  // The IN-FLIGHT build is cached, not just the finished one. Router.enqueue
  // serializes per RUN, so two fresh runs sharing a fixture is the ordinary
  // parallel-host case rather than a corner: with only the finished template
  // cached, both callers saw the miss before either could store a result, and
  // each paid a full seed and left an orphaned template file behind. Storing
  // the promise means the second caller awaits the first caller's build.
  seededTemplate(key: string, seed: (db: C) => Promise<SeedReport[]>): Promise<SeededTemplate> {
    const live = this.seeded.get(key)
    if (live !== undefined) return live
    const made = this.buildTemplate(seed)
    this.seeded.set(key, made)
    // A failed build must not be remembered, or every later run with this key
    // replays the same rejection instead of retrying the seed.
    made.catch(() => {
      if (this.seeded.get(key) === made) this.seeded.delete(key)
    })
    return made
  }

  // The throwaway is NOT a run, so it is built without ever entering the run
  // registry or the run directory. Registering it made `runs()` report an
  // internal build for the length of a seed, and /_kit/health hands that list
  // straight to whoever is polling, so a caller-inaccessible name briefly
  // appeared among their own worlds. Keeping it out is better than filtering
  // it out of `runs()`: there is then nothing to filter, and no way for a
  // later reader of `clients` to have to know about it either.
  private async buildTemplate(seed: (db: C) => Promise<SeedReport[]>): Promise<SeededTemplate> {
    // Taken ONCE, before the first await, and used for both names. Reading the
    // counter again after the seed gave two concurrent builds the same number,
    // so two different keys could write the same template file and the second
    // silently handed the first key's later runs another fixture's database.
    const n = String(this.builds++)
    const scratch = join(this.internal, `build-${n}.db`)
    copyFileSync(this.ensureTemplate(), scratch)
    const db = new this.ctor({ datasourceUrl: `file:${scratch}` })
    try {
      const rows = await seed(db)
      // Before the copy, not after: SQLite writes through a -wal that only the
      // last connection closing folds back in, so a snapshot taken while this
      // is open would be missing the seed's most recent commits.
      await db.$disconnect()
      const file = join(this.internal, `seeded-${n}.db`)
      copyFileSync(scratch, file)
      return { file, rows }
    } finally {
      // Also on the failure path. The rejected promise is evicted so a later
      // reset retries, so without this every retry left another live client
      // and another set of SQLite files behind until disposal.
      await db.$disconnect()
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        rmSync(`${scratch}${suffix}`, { force: true })
      }
    }
  }

  clientFromSeeded(run: string, template: SeededTemplate): C {
    return this.clientFrom(run, template.file)
  }

  // /reset recreates the run rather than deleting rows: a copy of the
  // template is one syscall and cannot leave a table the fake forgot to clear.
  async recreate(run: string): Promise<C> {
    await this.close(run)
    const file = this.fileFor(run)
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(`${file}${suffix}`, { force: true })
    }
    return this.client(run)
  }

  async close(run: string): Promise<void> {
    const live = this.clients.get(run)
    if (live === undefined) return
    this.clients.delete(run)
    await live.$disconnect()
  }

  runs(): string[] {
    return [...this.clients.keys()].sort()
  }

  async dispose(): Promise<void> {
    for (const run of [...this.clients.keys()]) {
      await this.close(run)
    }
    rmSync(this.root, { recursive: true, force: true })
    this.template = null
    this.seeded.clear()
  }
}
