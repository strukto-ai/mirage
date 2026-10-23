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

import type { ByteSource } from '../io/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { RAMAccessor } from '../accessor/ram.ts'
import { commandFiles } from '../commands/builtin/generic_bind/files.ts'
import { onMount } from '../test-utils.ts'
import { read as ramRead } from '../core/ram/read.ts'
import { readdir as ramReaddir } from '../core/ram/readdir.ts'
import { stat as ramStat } from '../core/ram/stat.ts'
import { write } from '../core/ram/write.ts'
import { eacces } from '../errors/fs.ts'
import { type FileStat, MountMode, PathSpec, type SearchQuery } from '../types.ts'
import { sliceWindow } from '../utils/ranges.ts'
import {
  getTestParser,
  stderrStr,
  stdoutStr,
} from '../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { BaseVFS } from './base.ts'
import { RAMVFS } from './ram/ram.ts'
import { RAMStore } from './ram/store.ts'
import type { Handed } from './types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const PATH = new PathSpec({
  virtual: '/nested/data/a.txt',
  directory: '/nested/data',
  vfsPath: 'a.txt',
})

/** A plug-in VFS over the RAM store with only the required reads. */
class Minimal extends BaseVFS<RAMAccessor> {
  override readdir(path: PathSpec): Promise<FileStat[]> {
    return ramReaddir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    return ramRead(this.accessor, path).then((data) => sliceWindow(data, offset, size))
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

async function* halves(): AsyncIterable<Uint8Array> {
  for (const chunk of [ENC.encode('hel'), ENC.encode('lo\n')]) yield await Promise.resolve(chunk)
}

/** Reads a window natively and streams a whole read. */
class Streaming extends Minimal {
  override readonly readsRanges: boolean = true
  readonly windows: [number, number | null][] = []

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    if (offset === 0 && size === null) return halves()
    this.windows.push([offset, size])
    return super.read(path, handed, offset, size)
  }
}

/** Answers every read by yielding its bytes two at a time. */
class Yielding extends Minimal {
  override async *read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): AsyncIterable<Uint8Array> {
    const data = sliceWindow(await ramRead(this.accessor, path), offset, size)
    for (let at = 0; at < data.byteLength; at += 2) yield data.subarray(at, at + 2)
  }
}

class Searchable extends Minimal {
  override search(): Promise<[string, string][] | null> {
    return Promise.resolve(null)
  }
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
      for await (const chunk of await ws.vfs.read(PATH, { raw: true, stream: true }))
        chunks.push(chunk)
      expect(chunks.filter((c) => c.byteLength > 0)).toEqual([ENC.encode('hello\n')])
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
    const exists = (path: PathSpec): Promise<boolean> =>
      onMount(
        vfs,
        (files) =>
          commandFiles({
            stdin: null,
            flags: {},
            cwd: PathSpec.fromStrPath('/'),
            vfs: files,
          }).exists(path),
        '/nested/data',
      )
    expect(await exists(PATH)).toBe(true)
    const missing = new PathSpec({
      virtual: '/nested/data/missing',
      directory: '/nested/data',
      vfsPath: 'missing',
    })
    expect(await exists(missing)).toBe(false)
    vfs.stat = () => Promise.reject(eacces(PATH.virtual))
    await expect(exists(PATH)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('reads a native window and stream without enabling writes', async () => {
    const accessor = await makeAccessor()
    const vfs = new Streaming({ name: 'custom', accessor })
    const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
    try {
      expect(await ws.dispatch('read', PATH.virtual, [], { offset: 1, size: 3 })).toEqual(
        ENC.encode('ell'),
      )
      expect(vfs.windows).toEqual([[1, 3]])
      const received: Uint8Array[] = []
      for await (const chunk of await ws.vfs.read(PATH, { raw: true, stream: true }))
        received.push(chunk)
      expect(received.filter((c) => c.byteLength > 0)).toEqual([
        ENC.encode('hel'),
        ENC.encode('lo\n'),
      ])
      expect(vfs.windows).toEqual([[1, 3]])
      expect(vfs.supports('write')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  // A read written as a generator serves a command's stream and a caller
  // that wants the whole file, which gets the chunks collected.
  it('serves streams and whole reads from a read that yields', async () => {
    const accessor = await makeAccessor()
    const ws = new Workspace(
      { '/nested/data': new Yielding({ name: 'custom', accessor }) },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    try {
      expect((await ws.shell('cat /nested/data/a.txt')).stdoutText).toBe('hello\n')
      expect(DEC.decode(await ws.vfs.read(PATH))).toBe('hello\n')
      const chunks: string[] = []
      for await (const chunk of await ws.vfs.read(PATH, { stream: true })) {
        chunks.push(DEC.decode(chunk))
      }
      expect(chunks).toEqual(['he', 'll', 'o\n'])
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

it('propagates a search failure without falling back to reads', async () => {
  const accessor = await makeAccessor()
  const vfs = new Searchable({ name: 'custom', accessor })
  const files = vi.spyOn(vfs, 'filesContaining').mockRejectedValue(eacces(PATH.virtual))
  const read = vi.spyOn(vfs, 'read')
  const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
  try {
    const result = await ws.shell('grep -r hello /nested/data')
    expect(result.exitCode).not.toBe(0)
    expect(files).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

it('passes resource options through, and grep and rg never ask the search', async () => {
  const accessor = await makeAccessor()
  const vfs = new Searchable({ name: 'custom', accessor })
  const search = vi
    .spyOn(vfs, 'search')
    .mockResolvedValue([[`${PATH.virtual}/42`, 'deployment 42']])
  const query: SearchQuery = {
    query: 'recent deployments',
    options: { limit: 20, filters: { project: 'backend' } },
  }
  const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
  try {
    expect(await ws.dispatch('search', PATH.virtual, [query])).toEqual([
      [`${PATH.virtual}/42`, 'deployment 42'],
    ])
    const [asked, options] = (search.mock.calls[0] ?? []) as unknown[]
    expect(asked).toMatchObject({ virtual: PATH.virtual, vfsPath: 'a.txt' })
    expect(options).toEqual(query)
    search.mockClear()
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

it('routes a write off a mount without one when an option names another', async () => {
  // Typed on a mount that cannot write, the output option names one that
  // can, and the serving mount's facts decide.
  const ws = new Workspace(
    {
      '/nested/data': new Minimal({ name: 'custom', accessor: await makeAccessor() }),
      '/ram': new RAMVFS(),
    },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    await ws.shell('cd /nested/data')
    const result = await ws.shell('shuf -i 1-1 --output=/ram/out')
    expect([result.exitCode, stderrStr(result)]).toEqual([0, ''])
    expect(stdoutStr(await ws.shell('cat /ram/out'))).toBe('1\n')
  } finally {
    await ws.close()
  }
})
