import type * as DriveModule from '../../../core/google/drive.ts'
import type * as ClientModule from '../../../core/google/client.ts'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../core/google/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  googleGet: vi.fn(),
}))
vi.mock('../../../core/google/drive.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof DriveModule>()),
  downloadFile: vi.fn(),
}))

import { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { IndexEntry } from '../../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { googleGet, type TokenManager } from '../../../core/google/client.ts'
import { downloadFile } from '../../../core/google/drive.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { GDRIVE_COMMANDS } from './index.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const TM = { config: { clientId: 'test', refreshToken: 'test' } } as TokenManager

async function run(kind: string, flags: Record<string, boolean> = {}) {
  const name = kind === 'file' ? 'report.pdf' : `Report.${kind}.json`
  const index = new RAMIndexCacheStore()
  const p = new PathSpec({
    virtual: `/drive/${name}`,
    directory: `/drive/${name}`,
    vfsPath: name,
    resolved: true,
  })
  await index.setDir('/drive', [
    [name, new IndexEntry({ id: 'file1', name, resourceType: `gdrive/${kind}`, vfsName: name })],
  ])
  const cmd = GDRIVE_COMMANDS.find((c) => c.name === 'grep')
  if (cmd === undefined) throw new Error('grep not registered')
  const result = await cmd.fn(new GDriveAccessor({ tokenManager: TM }), [p], ['needle'], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    index,
  })
  if (result === null) throw new Error('no grep result')
  return { out: await materialize(result[0]), io: result[1] }
}

describe('Drive grep through registered mount commands', () => {
  it.each(['gdoc', 'gsheet', 'gslide'])('-I keeps rendered %s JSON', async (kind) => {
    vi.mocked(googleGet).mockResolvedValue({ title: 'needle\0tail' })
    const { out, io } = await run(kind, { args_I: true })
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(out)).toContain('needle')
    expect(out.includes(0)).toBe(false)
    expect(io.stderr).toBeNull()
  })
  it.each([
    [{}, 0],
    [{ args_I: true }, 1],
    [{ text: true }, 0],
  ] as const)('classifies downloaded PDF bytes for %j', async (flags, code) => {
    vi.mocked(downloadFile).mockResolvedValue(ENC.encode('needle\0tail\n'))
    const { out, io } = await run('file', flags)
    expect(io.exitCode).toBe(code)
    expect(out).toEqual('text' in flags ? ENC.encode('needle\0tail\n') : new Uint8Array())
    expect(io.stderr !== null).toBe(Object.keys(flags).length === 0)
  })
})
