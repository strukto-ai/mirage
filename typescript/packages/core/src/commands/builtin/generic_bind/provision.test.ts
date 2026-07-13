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

import { describe, expect, it } from 'vitest'
import type { Accessor } from '../../../accessor/base.ts'
import { IndexEntry } from '../../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import type { ProvisionResult } from '../../../provision/types.ts'
import { Precision } from '../../../provision/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { CommandOpts } from '../../config.ts'
import { RAM_COMMANDS } from '../ram/index.ts'
import {
  exactZeroProvision,
  indexHitReadProvision,
  MAX_PLAN_WALK,
  defaultProvision,
  makeCopyProvision,
  makeFileReadProvision,
  makeHeadTailProvision,
  makeSearchProvision,
  makeTransformProvision,
  metadataProvision,
  pureProvision,
  writeMetadataProvision,
} from './provision.ts'

const SIZES: Record<string, number> = {
  '/data/known.txt': 5,
  '/data/big.txt': 100,
  '/data/tree/a.txt': 7,
  '/data/tree/skip.parquet': 900,
  '/data/tree/sub/b.txt': 11,
}
const DIRS = new Set(['/data/tree', '/data/tree/sub'])
const TREE: Record<string, string[]> = {
  '/data/tree': ['/data/tree/a.txt', '/data/tree/skip.parquet', '/data/tree/sub'],
  '/data/tree/sub': ['/data/tree/sub/b.txt'],
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resourcePath: mountKey(path, '/data'),
  })
}

const stat = (_accessor: Accessor, p: PathSpec): Promise<FileStat> =>
  Promise.resolve(
    DIRS.has(p.virtual)
      ? new FileStat({ name: p.virtual.split('/').pop() ?? '', type: FileType.DIRECTORY })
      : new FileStat({
          name: p.virtual.split('/').pop() ?? '',
          size: SIZES[p.virtual] ?? null,
          type: FileType.TEXT,
        }),
  )

// Backend ops follow the executor contract: specs arrive in the
// resource view (virtual == mountPath) and entries come back the same
// way. The fakes translate to the '/data'-prefixed fixture keys.
const readdir = (_accessor: Accessor, p: PathSpec): Promise<string[]> =>
  Promise.resolve((TREE[`/data${p.virtual}`] ?? []).map((e) => e.slice('/data'.length)))

const resolveGlob = (_accessor: Accessor, paths: readonly PathSpec[]): Promise<PathSpec[]> => {
  const out: PathSpec[] = []
  for (const p of paths) {
    if (p.pattern !== null && p.pattern !== '') {
      const suffix = p.pattern.replace(/^\*+/, '')
      for (const e of TREE[`/data${p.directory}`.replace(/\/$/, '')] ?? []) {
        if (e.endsWith(suffix)) {
          const rel = e.slice('/data'.length)
          out.push(
            new PathSpec({
              virtual: rel,
              directory: rel.slice(0, rel.lastIndexOf('/') + 1),
              resourcePath: mountKey(e, '/data'),
              resolved: true,
            }),
          )
        }
      }
    } else {
      out.push(p)
    }
  }
  return Promise.resolve(out)
}

function pattern(virtual: string, dir: string, glob: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: dir,
    pattern: glob,
    resourcePath: mountKey(virtual, '/data'),
  })
}

function opts(command: string): CommandOpts {
  return { command, flags: {} } as unknown as CommandOpts
}

function registered(name: string) {
  return RAM_COMMANDS.find((rc) => rc.name === name && rc.filetype === null)
}

describe('defaultProvision families', () => {
  it('maps read families and leaves unknowables null', () => {
    expect(defaultProvision('sort', stat)).not.toBeNull()
    expect(defaultProvision('grep', stat)).not.toBeNull()
    expect(defaultProvision('iconv', stat)).not.toBeNull()
    expect(defaultProvision('file', stat)).not.toBeNull()
    expect(defaultProvision('ls', stat)).toBe(metadataProvision)
    expect(defaultProvision('stat', stat)).toBe(metadataProvision)
    expect(defaultProvision('du', stat)).toBe(metadataProvision)
    expect(defaultProvision('gzip', stat)).not.toBeNull()
    expect(defaultProvision('cp', stat)).not.toBeNull()
    expect(defaultProvision('rm', stat)).toBe(writeMetadataProvision)
    expect(defaultProvision('mv', stat)).toBeNull()
    expect(defaultProvision('tee', stat)).toBeNull()
  })
})

describe('factory default provisions', () => {
  it('registers defaults for estimable commands and none for tee', () => {
    for (const name of ['grep', 'sort', 'ls', 'find', 'md5', 'cat', 'head', 'cp', 'gzip', 'rm']) {
      const rc = registered(name)
      expect(rc, name).toBeDefined()
      expect(rc?.provisionFn, name).not.toBeNull()
    }
    const tee = registered('tee')
    expect(tee).toBeDefined()
    expect(tee?.provisionFn ?? null).toBeNull()
  })
})

describe('size-aware estimators', () => {
  it('file read with known sizes is exact', async () => {
    const provision = makeFileReadProvision(stat)
    const result = (await provision(
      undefined as unknown as Accessor,
      [spec('/data/known.txt'), spec('/data/big.txt')],
      [],
      opts('cat'),
    )) as ProvisionResult
    expect(result.precision).toBe(Precision.EXACT)
    expect(result.networkReadLow).toBe(105)
    expect(result.networkReadHigh).toBe(105)
    expect(result.readOps).toBe(2)
  })

  it('file read keeps the known floor when a size is missing', async () => {
    const provision = makeFileReadProvision(stat)
    const result = (await provision(
      undefined as unknown as Accessor,
      [spec('/data/known.txt'), spec('/data/chat.jsonl')],
      [],
      opts('cat'),
    )) as ProvisionResult
    expect(result.precision).toBe(Precision.UNKNOWN)
    expect(result.networkReadLow).toBe(5)
    expect(result.networkReadHigh).toBe(5)
    expect(result.readOps).toBe(2)
  })

  it('head keeps the known ceiling when a size is missing', async () => {
    const provision = makeHeadTailProvision(stat)
    const result = (await provision(
      undefined as unknown as Accessor,
      [spec('/data/known.txt'), spec('/data/chat.jsonl')],
      [],
      opts('head'),
    )) as ProvisionResult
    expect(result.precision).toBe(Precision.UNKNOWN)
    expect(result.networkReadLow).toBe(0)
    expect(result.networkReadHigh).toBe(5)
    expect(result.readOps).toBe(2)
  })

  it('transform keeps the read floor with unknown output', async () => {
    const provision = makeTransformProvision(stat)
    const result = (await provision(
      undefined as unknown as Accessor,
      [spec('/data/known.txt')],
      [],
      opts('gzip'),
    )) as ProvisionResult
    expect(result.precision).toBe(Precision.UNKNOWN)
    expect(result.networkReadLow).toBe(5)
    expect(result.networkReadHigh).toBe(5)
    expect(result.readOps).toBe(1)
  })

  it('cp brackets read and write between 0 and the source total', async () => {
    const provision = makeCopyProvision(stat)
    const result = (await provision(
      undefined as unknown as Accessor,
      [spec('/data/known.txt'), spec('/data/dest.txt')],
      [],
      opts('cp'),
    )) as ProvisionResult
    expect(result.precision).toBe(Precision.RANGE)
    expect(result.networkReadLow).toBe(0)
    expect(result.networkReadHigh).toBe(5)
    expect(result.networkWriteLow).toBe(0)
    expect(result.networkWriteHigh).toBe(5)
    expect(result.readOps).toBe(1)
  })

  it('metadata writes are zero-byte; recursive rm floors', async () => {
    const plain = await writeMetadataProvision(
      undefined as unknown as Accessor,
      [spec('/data/known.txt')],
      [],
      opts('rm'),
    )
    expect(plain.precision).toBe(Precision.EXACT)
    expect(plain.networkReadHigh).toBe(0)
    expect(plain.readOps).toBe(1)
    const recursive = await writeMetadataProvision(
      undefined as unknown as Accessor,
      [spec('/data/known.txt')],
      [],
      { command: 'rm', flags: { r: true } } as unknown as CommandOpts,
    )
    expect(recursive.precision).toBe(Precision.UNKNOWN)
  })

  it('pure commands are zero-cost exact', async () => {
    const result = await pureProvision(undefined as unknown as Accessor, [], [], opts('seq'))
    expect(result.precision).toBe(Precision.EXACT)
    expect(result.networkReadHigh).toBe(0)
    expect(result.readOps).toBe(0)
  })
})

describe('glob and recursive estimates', () => {
  it('file read expands globs to exact totals', async () => {
    const provision = makeFileReadProvision(stat, resolveGlob)
    const result = (await provision(
      {} as Accessor,
      [pattern('/data/tree/*.txt', '/data/tree/', '*.txt')],
      [],
      opts('cat'),
    )) as ProvisionResult
    expect(result.precision).toBe(Precision.EXACT)
    expect(result.networkReadHigh).toBe(7)
    expect(result.readOps).toBe(1)
  })

  it('unmatched glob stays unknown', async () => {
    const provision = makeFileReadProvision(stat, resolveGlob)
    const result = (await provision(
      {} as Accessor,
      [pattern('/data/tree/*.nope', '/data/tree/', '*.nope')],
      [],
      opts('cat'),
    )) as ProvisionResult
    expect(result.precision).toBe(Precision.UNKNOWN)
    expect(result.networkReadHigh).toBe(0)
  })

  it('recursive search walks the tree exactly, skipping columnar', async () => {
    const provision = makeSearchProvision(stat, resolveGlob, readdir)
    const result = (await provision({} as Accessor, [spec('/data/tree')], ['x'], {
      command: 'grep',
      flags: { r: true },
    } as unknown as CommandOpts)) as ProvisionResult
    expect(result.precision).toBe(Precision.EXACT)
    expect(result.networkReadHigh).toBe(18)
    expect(result.readOps).toBe(2)
  })

  it('recursive search without readdir keeps the floor', async () => {
    const provision = makeSearchProvision(stat, resolveGlob)
    const result = (await provision({} as Accessor, [spec('/data/tree')], ['x'], {
      command: 'grep',
      flags: { r: true },
    } as unknown as CommandOpts)) as ProvisionResult
    expect(result.precision).toBe(Precision.UNKNOWN)
  })

  it('exports a walk cap', () => {
    expect(MAX_PLAN_WALK).toBeGreaterThan(0)
  })
})

describe('chat/KB provision helpers', () => {
  it('exactZeroProvision charges nothing', () => {
    const result = exactZeroProvision(null as unknown as Accessor, [], [], opts('find /chat'))
    expect(result.command).toBe('find /chat')
    expect(result.networkReadHigh).toBe(0)
    expect(result.readOps).toBe(0)
    expect(result.precision).toBe(Precision.EXACT)
  })

  it('indexHitReadProvision counts cached operands', async () => {
    const index = new RAMIndexCacheStore()
    await index.put(
      '/chat/a.jsonl',
      new IndexEntry({ id: 'a', name: 'a.jsonl', resourceType: 'file' }),
    )
    const paths = [
      PathSpec.fromStrPath('/chat/a.jsonl'),
      PathSpec.fromStrPath('/chat/missing.jsonl'),
    ]
    const result = await indexHitReadProvision(null as unknown as Accessor, paths, [], {
      command: 'cat',
      flags: {},
      index,
    } as unknown as CommandOpts)
    expect(result.readOps).toBe(1)
    expect(result.networkReadHigh).toBe(0)
    expect(result.precision).toBe(Precision.EXACT)
  })

  it('indexHitReadProvision without paths is unknown', async () => {
    const result = await indexHitReadProvision(null as unknown as Accessor, [], [], opts('grep x'))
    expect(result.precision).toBe(Precision.UNKNOWN)
  })
})
