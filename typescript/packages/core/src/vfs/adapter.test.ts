import { describe, expect, it, vi } from 'vitest'
import { RAMAccessor } from '../accessor/ram.ts'
import { RAM_IO } from '../commands/builtin/ram/io.ts'
import { writeBytes } from '../core/ram/write.ts'
import { MountMode, PathSpec } from '../types.ts'
import { eacces } from '../utils/errors.ts'
import { getTestParser, stderrStr, stdoutStr } from '../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { VFSAdapter } from './adapter.ts'
import { GenericVFS } from './generic.ts'
import { RAMStore } from './ram/store.ts'
import type { ReadOps } from './types.ts'

const ENC = new TextEncoder()
const READ: ReadOps<RAMAccessor> = {
  readdir: RAM_IO.readdir,
  readBytes: RAM_IO.readBytes,
  stat: RAM_IO.stat,
}
const PATH = new PathSpec({
  virtual: '/nested/data/a.txt',
  directory: '/nested/data',
  vfsPath: 'a.txt',
})

async function makeAccessor(): Promise<RAMAccessor> {
  const accessor = new RAMAccessor(new RAMStore())
  await writeBytes(accessor, PATH, ENC.encode('hello\n'))
  return accessor
}

describe('VFSAdapter', () => {
  it('serves shell, streams and dispatcher from only three read operations', async () => {
    const accessor = await makeAccessor()
    const vfs = new GenericVFS({ name: 'custom', accessor, io: new VFSAdapter({ read: READ }) })
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
      for await (const chunk of vfs.io.readStream(accessor, PATH)) chunks.push(chunk)
      expect(chunks).toEqual([ENC.encode('hello\n')])
      const refused = await ws.shell('rm /nested/data/a.txt')
      expect(refused.exitCode).toBe(1)
      expect(stderrStr(refused)).toBe(
        "rm: cannot remove '/nested/data/a.txt': Operation not supported\n",
      )
      expect(vfs.ops().some((op) => op.name === 'write')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('derives existence without swallowing permission failures', async () => {
    const accessor = await makeAccessor()
    const io = new VFSAdapter({ read: READ }).toCommandIO()
    if (!io.exists) throw new Error('adapter must provide exists')
    expect(await io.exists(accessor, PATH)).toBe(true)
    const missing = new PathSpec({ virtual: '/missing', directory: '/', vfsPath: 'missing' })
    expect(await io.exists(accessor, missing)).toBe(false)
    const denied = new VFSAdapter({
      read: { ...READ, stat: () => Promise.reject(eacces(PATH.virtual)) },
    }).toCommandIO()
    if (!denied.exists) throw new Error('adapter must provide exists')
    await expect(denied.exists(accessor, PATH)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('uses native reads without enabling mutations or fetching the whole file', async () => {
    const accessor = await makeAccessor()
    const readBytes = vi.fn(() => Promise.reject(new Error('whole read')))
    const readRange = vi.fn(() => Promise.resolve(ENC.encode('ell')))
    const chunks = [ENC.encode('hel'), ENC.encode('lo\n')]
    const adapter = new VFSAdapter({
      read: { ...READ, readBytes },
      native: {
        readRange,
        async *readStream() {
          for (const chunk of chunks) yield await Promise.resolve(chunk)
        },
      },
    })
    const vfs = new GenericVFS({ name: 'custom', accessor, io: adapter })
    const ws = new Workspace({ '/nested/data': vfs }, { shellParser: await getTestParser() })
    try {
      expect(await ws.dispatch('read', PATH.virtual, [], { offset: 1, size: 3 })).toEqual(
        ENC.encode('ell'),
      )
      expect(readRange).toHaveBeenCalledOnce()
      const received: Uint8Array[] = []
      for await (const chunk of vfs.io.readStream(accessor, PATH)) received.push(chunk)
      expect(received).toEqual(chunks)
      expect(readBytes).not.toHaveBeenCalled()
      expect(vfs.ops().some((op) => op.name === 'write')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it.each([MountMode.READ, MountMode.WRITE])(
    'holds optional writes to mount mode %s',
    async (mode) => {
      const accessor = await makeAccessor()
      const write = vi.fn(writeBytes)
      const vfs = new GenericVFS({
        name: 'custom',
        accessor,
        io: new VFSAdapter({ read: READ, writes: { write } }),
      })
      const ws = new Workspace(
        { '/nested/data': vfs },
        { mode, shellParser: await getTestParser() },
      )
      try {
        const result = await ws.shell('echo changed > /nested/data/a.txt')
        expect(result.exitCode === 0).toBe(mode === MountMode.WRITE)
        expect(write).toHaveBeenCalledTimes(mode === MountMode.WRITE ? 1 : 0)
        const refused = await ws.shell('rm /nested/data/a.txt')
        expect(stderrStr(refused)).toBe(
          "rm: cannot remove '/nested/data/a.txt': Operation not supported\n",
        )
        expect(vfs.ops().some((op) => op.name === 'write')).toBe(true)
        expect(vfs.ops().some((op) => op.name === 'unlink')).toBe(false)
      } finally {
        await ws.close()
      }
    },
  )
})

it.each(['grep', 'rg'])(
  'wires optional native %s and distinguishes decline from no matches',
  async (command) => {
    for (const answer of [['native match'], [], null]) {
      const accessor = await makeAccessor()
      const search = vi.fn(() => Promise.resolve(answer))
      const readBytes = vi.fn(READ.readBytes)
      const adapter = new VFSAdapter({
        read: { ...READ, readBytes },
        search: { search, meta: { grep: { mode: 'literal' } } },
      })
      const ws = new Workspace(
        { '/nested/data': new GenericVFS({ name: 'custom', accessor, io: adapter }) },
        { shellParser: await getTestParser() },
      )
      try {
        const result = await ws.shell(`${command} -F hello ${PATH.virtual}`)
        expect(stdoutStr(result)).toBe(
          answer === null ? 'hello\n' : answer.map((line) => `${line}\n`).join(''),
        )
        expect(result.exitCode).toBe(answer?.length === 0 ? 1 : 0)
        expect(readBytes).toHaveBeenCalledTimes(answer === null ? 1 : 0)
        expect(search).toHaveBeenCalledOnce()
        expect(search).toHaveBeenCalledWith(
          accessor,
          expect.objectContaining({ vfsPath: 'a.txt' }),
          {
            query: 'hello',
            options: {
              grep: {
                fixed_string: true,
                ignore_case: false,
                whole_word: false,
                basic: command === 'grep',
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
])('scans unsupported search %s %s', async (flags, pattern, expected) => {
  const accessor = await makeAccessor()
  const search = vi.fn(() => Promise.reject(new Error('native query must not run')))
  const adapter = new VFSAdapter({
    read: READ,
    search: { search, meta: { grep: { mode: 'literal' } } },
  })
  const ws = new Workspace(
    { '/nested/data': new GenericVFS({ name: 'custom', accessor, io: adapter }) },
    { shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell(`grep ${flags} '${pattern}' ${PATH.virtual}`)
    expect(stdoutStr(result)).toBe(expected)
    expect(result.exitCode).toBe(0)
    expect(search).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

it('propagates native search failures without falling back to reads', async () => {
  const accessor = await makeAccessor()
  const search = vi.fn(() => Promise.reject(eacces(PATH.virtual)))
  const readBytes = vi.fn(READ.readBytes)
  const adapter = new VFSAdapter({
    read: { ...READ, readBytes },
    search: { search, meta: { grep: { mode: 'regex' } } },
  })
  const ws = new Workspace(
    { '/nested/data': new GenericVFS({ name: 'custom', accessor, io: adapter }) },
    { shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell(`grep hello ${PATH.virtual}`)
    expect(result.exitCode).not.toBe(0)
    expect(search).toHaveBeenCalledOnce()
    expect(readBytes).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

it('scans through guarded reads when the subtree contains hidden paths', async () => {
  const accessor = await makeAccessor()
  const search = vi.fn(() => Promise.reject(new Error('native search would bypass visibility')))
  const adapter = new VFSAdapter({
    read: READ,
    search: { search, meta: { grep: { mode: 'regex' } } },
  })
  const ws = new Workspace(
    { '/nested/data': new GenericVFS({ name: 'custom', accessor, io: adapter }) },
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
  const search = vi.fn(() => Promise.resolve(['deployment 42']))
  const adapter = new VFSAdapter({ read: READ, search: { search, meta: { ranking: 'relevance' } } })
  const query = {
    query: 'recent deployments',
    options: { limit: 20, filters: { project: 'backend' } },
  }
  const capability = adapter.toCommandIO().search
  expect(await capability?.search(accessor, PATH, query)).toEqual(['deployment 42'])
  expect(search).toHaveBeenCalledWith(accessor, PATH, query)
  search.mockClear()
  const ws = new Workspace(
    { '/nested/data': new GenericVFS({ name: 'custom', accessor, io: adapter }) },
    { shellParser: await getTestParser() },
  )
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
