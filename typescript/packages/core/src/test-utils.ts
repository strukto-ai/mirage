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

import { type CacheInvalidator, runWithCacheManager } from './cache/context.ts'
import type { WriteReceipt } from './cache/types.ts'
import type { FileStat, PathSpec } from './types.ts'
import type { BaseVFS } from './vfs/base.ts'
import { DriverOps } from './vfs/testing.ts'

const TABLES = new WeakMap<BaseVFS, DriverOps>()

/** The op table of `vfs`, bound once per instance so its index store persists across calls. */
export function ops(vfs: BaseVFS): DriverOps {
  let table = TABLES.get(vfs)
  if (table === undefined) {
    table = new DriverOps(vfs)
    TABLES.set(vfs, table)
  }
  return table
}

export interface Settled {
  path: string
  data: string
  receipt: WriteReceipt | null
  generation: number | null
}

/**
 * A cache manager that records what a core mutator reports. `generation` is
 * fixed, so a writer that notes it before the upload hands the same number
 * to `settleAfterWrite`.
 */
export class SettleRecorder implements CacheInvalidator {
  generation = 5
  readonly settled: Settled[] = []
  readonly writes: string[] = []

  settleAfterWrite(
    path: PathSpec,
    data: Uint8Array,
    receipt: WriteReceipt | null,
    generation: number | null,
  ): Promise<void> {
    this.settled.push({
      path: path.virtual,
      data: new TextDecoder().decode(data),
      receipt,
      generation,
    })
    return Promise.resolve()
  }

  invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    this.writes.push(typeof path === 'string' ? path : path.virtual)
    return Promise.resolve()
  }

  invalidateAfterUnlink(): Promise<void> {
    return Promise.resolve()
  }

  invalidateSubtree(): Promise<void> {
    return Promise.resolve()
  }

  invalidateAncestors(): Promise<void> {
    return Promise.resolve()
  }

  cachedBytes(): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  readThrough(_path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    return fetch()
  }

  cachedSize(): Promise<number | null> {
    return Promise.resolve(null)
  }

  listingTrusted(): boolean {
    return false
  }

  probedStat(): FileStat | null {
    return null
  }
}

/** Run `fn` with a fresh {@link SettleRecorder} active, and return it. */
export async function settling(
  fn: (recorder: SettleRecorder) => Promise<unknown>,
): Promise<SettleRecorder> {
  const recorder = new SettleRecorder()
  await runWithCacheManager(recorder, async () => {
    await fn(recorder)
  })
  return recorder
}

/**
 * The import an IO table source wires as its whole-file `write`: the name it
 * is exported under and the module it comes from, or null when the table
 * wires no write. Each package's write-settles guard loads the module itself.
 */
export function wiredWriteImport(ioSource: string): { exported: string; from: string } | null {
  const writes = /\bwrites:\s*\{([^}]*)\}/.exec(ioSource)?.[1] ?? ''
  const entry = /(?:^|[\s,])write(?::\s*([A-Za-z_$][\w$]*))?\s*(?:,|$)/m.exec(writes)
  if (entry === null) return null
  const wired = entry[1] ?? 'write'
  for (const [, names = '', from = ''] of ioSource.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g,
  )) {
    for (const item of names.split(',')) {
      const [exported = '', local = exported] = item.trim().split(/\s+as\s+/)
      if (local === wired) return { exported, from }
    }
  }
  return null
}

/**
 * The source of the function an export wraps (`export const write =
 * eaccesOnDenied(writeImpl)` answers `writeImpl`'s), so a wrapped writer is
 * judged by the one function it runs, not by whatever else its module holds.
 */
export function wrappedSource(module: string, exported: string): string | null {
  const inner = new RegExp(`export const ${exported} = \\w+\\((\\w+)\\)`).exec(module)?.[1]
  if (inner === undefined) return null
  const start = module.search(new RegExp(`function ${inner}\\b`))
  if (start < 0) return null
  const open = module.indexOf('{', module.indexOf(')', start))
  let depth = 0
  for (let i = open; i < module.length; i++) {
    if (module[i] === '{') depth++
    if (module[i] === '}' && --depth === 0) return module.slice(start, i + 1)
  }
  return null
}

/** Whether `source` calls `name`, however the transform spelled the import. */
export function calls(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\)?\\(`).test(source)
}
