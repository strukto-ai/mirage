import type * as ClientModule from '../../core/google/client.ts'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../core/google/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  googleGet: vi.fn(),
}))

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { googleGet, type TokenManager } from '../../core/google/client.ts'
import { FileStat, FileType, MountMode } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GDriveVFS } from './gdrive.ts'

const DEC = new TextDecoder()
const TM = { config: { clientId: 'test', refreshToken: 'test' } } as TokenManager

// Mirrors python's test_grep_i_keeps_rendered_google_json: an id-addressed
// file is reached through a mount, which hands the read the row its listing
// named.
describe('Drive grep through a mount', () => {
  it.each(['gdoc', 'gsheet', 'gslide'])('-I keeps rendered %s JSON', async (kind) => {
    vi.mocked(googleGet).mockResolvedValue({ title: 'needle\0tail' })
    const vfs = new GDriveVFS({ clientId: 'test', refreshToken: 'test' })
    Object.assign(vfs, { accessor: new GDriveAccessor({ tokenManager: TM }) })
    const ws = new Workspace(
      { '/drive/': vfs },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    const name = `Report.${kind}.json`
    try {
      await ws.mount('/drive/').indexStore.setDir(
        '/drive',
        [
          [
            name,
            new FileStat({
              name,
              type: FileType.FILE,
              extra: { file_id: 'file1', resource_type: `gdrive/${kind}` },
            }),
          ],
        ],
        new Date(Date.now() + 3_600_000),
      )
      const io = await ws.shell(`grep -I needle /drive/${name}`)
      const out = io.stdout
      expect(io.exitCode).toBe(0)
      expect(DEC.decode(out)).toContain('needle')
      expect(out.includes(0)).toBe(false)
      expect(DEC.decode(io.stderr)).toBe('')
    } finally {
      await ws.close()
    }
  })
})
