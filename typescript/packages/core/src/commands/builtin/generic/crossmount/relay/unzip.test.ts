import { expect, it } from 'vitest'
import { MountMode } from '../../../../../types.ts'
import { RAMVFS } from '../../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../../../tests/workspace/fixtures/workspace_fixture.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function run(
  line: string,
): Promise<{ exitCode: number; out: string; written: Record<string, Uint8Array> }> {
  const source = new RAMVFS()
  const dest = new RAMVFS()
  source.loadState({
    type: 'ram',
    files: { '/keep.txt': ENC.encode('keep\n'), '/drop.txt': ENC.encode('drop\n') },
  })
  const ws = new Workspace(
    { '/a': source, '/b': dest },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    await ws.shell('cd /a && zip -q a.zip keep.txt drop.txt && cd /')
    const result = await ws.shell(line)
    return {
      exitCode: result.exitCode,
      out: DEC.decode(result.stdout),
      written: dest.getState().files ?? {},
    }
  } finally {
    await ws.close()
  }
}

it('lists instead of extracting under -l', async () => {
  const { exitCode, out, written } = await run('unzip -l /a/a.zip -d /b/out')
  expect(exitCode).toBe(0)
  expect(out.startsWith('  Length      Name\n')).toBe(true)
  expect(written).toEqual({})
})
