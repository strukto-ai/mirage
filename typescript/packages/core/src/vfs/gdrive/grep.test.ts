import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FileStat, FileType, MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount } from '../../../tests/core/google/account.ts'
import { GoogleDriveVFS } from './gdrive.ts'

const DEC = new TextDecoder()
const MIMES: Record<string, string> = {
  gdoc: 'application/vnd.google-apps.document',
  gsheet: 'application/vnd.google-apps.spreadsheet',
  gslide: 'application/vnd.google-apps.presentation',
}

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

// Mirrors python's test_grep_i_keeps_rendered_google_json: an id-addressed
// file is reached through a mount, which hands the read the row its listing
// named.
describe('Drive grep through a mount', () => {
  it.each(['gdoc', 'gsheet', 'gslide'])('-I keeps rendered %s JSON', async (kind) => {
    // A title holding a NUL: the rendered JSON escapes it, so the file is
    // text to grep -I, and the raw byte never reaches the output.
    const made = await account.create('needle\0tail', MIMES[kind] ?? '')
    const ws = new Workspace(
      { '/drive/': new GoogleDriveVFS(account.config()) },
      { mode: MountMode.READ },
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
              extra: { file_id: made, resource_type: `gdrive/${kind}` },
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
