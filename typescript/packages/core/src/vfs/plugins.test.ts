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

import { describe, expect, it, vi } from 'vitest'
import { RAMAccessor } from '../accessor/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { commandIo } from '../commands/builtin/generic_bind/adapter.ts'
import { read as ramRead } from '../core/ram/read.ts'
import { readdir as ramReaddir } from '../core/ram/readdir.ts'
import { stat as ramStat } from '../core/ram/stat.ts'
import { write } from '../core/ram/write.ts'
import { eacces } from '../errors/fs.ts'
import { type FileStat, type JsonValue, MountMode, PathSpec } from '../types.ts'
import { sliceWindow } from '../utils/ranges.ts'
import { getTestParser, stderrStr, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { BaseVFS } from './base.ts'
import { RAMStore } from './ram/store.ts'
import type { SearchQuery } from './types.ts'

const ENC = new TextEncoder()
const PATH = new PathSpec({
  virtual: '/nested/data/a.txt',
  directory: '/nested/data',
  vfsPath: 'a.txt',
})

/** A plug-in VFS over the RAM store with only the required reads. */
class Minimal extends BaseVFS<RAMAccessor> {
  override readdir(path: PathSpec): Promise<string[]> {
    return ramReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await ramRead(this.accessor, path, index)
    return offset === 0 && size === null ? data : sliceWindow(data, offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return ramStat(this.accessor, path)
  }
}

class Writable extends Minimal {
  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return write(this.accessor, path, data)
  }
}

class Streaming extends Minimal {
  override readonly readsRanges: boolean = true

  override async *readStream(): AsyncIterable<Uint8Array> {
    for (const chunk of [ENC.encode('hel'), ENC.encode('lo\n')]) yield await Promise.resolve(chunk)
  }
}

class Searchable extends Minimal {
  override search(): Promise<string[] | null> {
    return Promise.resolve(null)
  }
}

function searchable(accessor: RAMAccessor, meta: Readonly<Record<string, JsonValue>>): Searchable {
  const vfs = new Searchable({ name: 'custom', accessor })
  Object.assign(vfs, { searchMeta: meta })
  return vfs
}

async function makeAccessor(): Promise<RAMAccessor> {
  const accessor = new RAMAccessor(new RAMStore())
  await write(accessor, PATH, ENC.encode('hello\n'))
  return accessor
}

describe('a plug-in VFS', () => {
  it('serves shell, streams and dispatcher from only three reads', async () => {
    const accessor = await makeAccessor()
    const vfs = new Minimal({ name: 'custom', accessor })
    const ws = new Workspace(
      { '/nested/data': vfs },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    try {
      for (const line of [
        'cat /nested/data/*.txt',
        'grep hello /nested/data/a.txt',
        'gzip -c /nested/data/a.txt | gunzip',
      ]) {
        const result = await ws.shell(line)
        expect(stdoutStr(result)).toBe('hello\n')
        expect(result.exitCode).toBe(0)
      }
      expect(await ws.stat(PATH.virtual)).toMatchObject({ size: 6 })
      expect(await ws.dispatch('read', PATH.virtual, [], { offset: 1, size: 3 })).toEqual(
        ENC.encode('ell'),
      )
      const chunks: Uint8Array[] = []
      for await (const chunk of commandIo(vfs).readStream(accessor, PATH)) chunks.push(chunk)
      expect(chunks).toEqual([ENC.encode('hello\n')])
      const refused = await ws.shell('rm /nested/data/a.txt')
      expect(refused.exitCode).toBe(1)
      expect(stderrStr(refused)).toBe(
        "rm: cannot remove '/nested/data/a.txt': Read-only file system\n",
      )
      expect(vfs.supports('write')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('derives existence from stat without swallowing permission failures', async () => {
    const accessor = await makeAccessor()
    const vfs = new Minimal({ name: 'custom', accessor })
    const io = commandIo(vfs)
    if (!io.exists) throw new Error('the table must provide exists')
    expect(await io.exists(accessor, PATH)).toBe(true)
    const missing = new PathSpec({ virtual: '/missing', directory: '/', vfsPath: 'missing' })
    expect(await io.exists(accessor, missing)).toBe(false)
    vfs.stat = () => Promise.reject(eacces(PATH.virtual))
    const denied = commandIo(vfs)
    if (!denied.exists) throw new Error('the table must provide exists')
    await expect(denied.exists(accessor, PATH)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('reads a native window and stream without enabling writes', async () => {
    const accessor = await makeAccessor()
    const vfs = new Streaming({ name: 'custom', accessor })
    const read = vi.spyOn(vfs, 'read').mockResolvedValue(ENC.encode('ell'))
    const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
    try {
      expect(await ws.dispatch('read', PATH.virtual, [], { offset: 1, size: 3 })).toEqual(
        ENC.encode('ell'),
      )
      expect(read).toHaveBeenCalledOnce()
      expect(read.mock.calls[0]?.slice(2)).toEqual([1, 3])
      const received: Uint8Array[] = []
      for await (const chunk of commandIo(vfs).readStream(accessor, PATH)) received.push(chunk)
      expect(received).toEqual([ENC.encode('hel'), ENC.encode('lo\n')])
      expect(read).toHaveBeenCalledOnce()
      expect(vfs.supports('write')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it.each([MountMode.READ, MountMode.WRITE])(
    'holds an optional write to mount mode %s',
    async (mode) => {
      const accessor = await makeAccessor()
      const vfs = new Writable({ name: 'custom', accessor })
      const spy = vi.spyOn(vfs, 'write')
      const ws = new Workspace(
        { '/nested/data': vfs },
        { mode, shellParser: await getTestParser() },
      )
      try {
        const result = await ws.shell('echo changed > /nested/data/a.txt')
        expect(result.exitCode === 0).toBe(mode === MountMode.WRITE)
        expect(spy).toHaveBeenCalledTimes(mode === MountMode.WRITE ? 1 : 0)
        const refused = await ws.shell('rm /nested/data/a.txt')
        const reason = mode === MountMode.READ ? 'Read-only file system' : 'Operation not supported'
        expect(stderrStr(refused)).toBe(`rm: cannot remove '/nested/data/a.txt': ${reason}\n`)
        expect(vfs.supports('write')).toBe(true)
        expect(vfs.supports('unlink')).toBe(false)
      } finally {
        await ws.close()
      }
    },
  )
})

it.each(['grep', 'rg'])(
  'wires an optional native %s and distinguishes decline from no matches',
  async (command) => {
    for (const answer of [['native match'], [], null]) {
      const accessor = await makeAccessor()
      const vfs = searchable(accessor, { grep: { mode: 'literal' } })
      const search = vi.spyOn(vfs, 'search').mockResolvedValue(answer)
      const read = vi.spyOn(vfs, 'read')
      const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
      try {
        const result = await ws.shell(`${command} -F hello ${PATH.virtual}`)
        expect(stdoutStr(result)).toBe(
          answer === null ? 'hello\n' : answer.map((line) => `${line}\n`).join(''),
        )
        expect(result.exitCode).toBe(answer?.length === 0 ? 1 : 0)
        expect(read).toHaveBeenCalledTimes(answer === null ? 1 : 0)
        expect(search).toHaveBeenCalledOnce()
        expect(search).toHaveBeenCalledWith(
          expect.objectContaining({ vfsPath: 'a.txt' }),
          {
            query: 'hello',
            options: {
              grep: {
                fixed_string: true,
                ignore_case: false,
                whole_word: false,
                syntax: command === 'grep' ? 'basic' : 'rust',
                ...(command === 'grep' ? { utf8: false } : {}),
              },
            },
          },
          expect.anything(),
        )
      } finally {
        await ws.close()
      }
    }
  },
)

it.each([
  ['-n', 'hello', '1:hello\n'],
  ['-E', 'h.*o', 'hello\n'],
])('scans an unsupported search %s %s', async (flags, pattern, expected) => {
  const accessor = await makeAccessor()
  const vfs = searchable(accessor, { grep: { mode: 'literal' } })
  const search = vi.spyOn(vfs, 'search').mockRejectedValue(new Error('native query must not run'))
  const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
  try {
    const result = await ws.shell(`grep ${flags} '${pattern}' ${PATH.virtual}`)
    expect(stdoutStr(result)).toBe(expected)
    expect(result.exitCode).toBe(0)
    expect(search).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

it('propagates a native search failure without falling back to reads', async () => {
  const accessor = await makeAccessor()
  const vfs = searchable(accessor, { grep: { mode: 'regex' } })
  const search = vi.spyOn(vfs, 'search').mockRejectedValue(eacces(PATH.virtual))
  const read = vi.spyOn(vfs, 'read')
  const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
  try {
    const result = await ws.shell(`grep hello ${PATH.virtual}`)
    expect(result.exitCode).not.toBe(0)
    expect(search).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

it('scans through guarded reads when the subtree holds hidden paths', async () => {
  const accessor = await makeAccessor()
  const vfs = searchable(accessor, { grep: { mode: 'regex' } })
  const search = vi
    .spyOn(vfs, 'search')
    .mockRejectedValue(new Error('native search would bypass visibility'))
  const ws = new Workspace(
    { '/nested/data': vfs },
    {
      shellParser: await getTestParser(),
      profiles: { default: { paths: { hide: ['/nested/data/secret'] } } },
    },
  )
  try {
    const result = await ws.shell('grep -r hello /nested/data')
    expect(result.exitCode).toBe(0)
    expect(stdoutStr(result)).toContain('hello')
    expect(search).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

it('passes resource options through and scans without grep opt-in', async () => {
  const accessor = await makeAccessor()
  const vfs = searchable(accessor, { ranking: 'relevance' })
  const search = vi.spyOn(vfs, 'search').mockResolvedValue(['deployment 42'])
  const query: SearchQuery = {
    query: 'recent deployments',
    options: { limit: 20, filters: { project: 'backend' } },
  }
  expect(await commandIo(vfs).search?.search(accessor, PATH, query)).toEqual(['deployment 42'])
  expect(search).toHaveBeenCalledWith(PATH, query, undefined)
  search.mockClear()
  const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
  try {
    for (const command of ['grep', 'rg']) {
      const result = await ws.shell(`${command} hello ${PATH.virtual}`)
      expect(result.exitCode).toBe(0)
      expect(stdoutStr(result)).toBe('hello\n')
    }
    expect(search).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})
