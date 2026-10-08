import type * as ClientModule from '../../../core/google/client.ts'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../core/google/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  googleGet: vi.fn(),
}))

import { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { IndexEntry } from '../../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { googleGet, type TokenManager } from '../../../core/google/client.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { GDRIVE_COMMANDS } from './index.ts'
import { ioFor } from '../../../test-utils.ts'
import { GDriveVFS } from '../../../vfs/gdrive/gdrive.ts'

const DEC = new TextDecoder()
const TM = { config: { clientId: 'test', refreshToken: 'test' } } as TokenManager

async function run(kind: string, flags: Record<string, boolean> = {}) {
  const name = `Report.${kind}.json`
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
  const accessor = new GDriveAccessor({ tokenManager: TM })
  const result = await cmd.fn(accessor, [p], ['needle'], {
    stdin: null,
    flags,
    io: ioFor(GDriveVFS, accessor),
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
})
