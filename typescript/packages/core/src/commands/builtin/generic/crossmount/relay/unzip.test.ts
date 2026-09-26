import { expect, it } from 'vitest'
import { MountMode } from '../../../../../types.ts'
import { RAMVFS } from '../../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../../workspace/fixtures/workspace_fixture.ts'

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

it.each([
  ['-v', 'Archive:  /a/a.zip\n Length   Method'],
  ['-l', '  Length      Name\n'],
])('lists instead of extracting under %s', async (flag, head) => {
  const { exitCode, out, written } = await run(`unzip ${flag} /a/a.zip -d /b/out`)
  expect(exitCode).toBe(0)
  expect(out.startsWith(head)).toBe(true)
  expect(written).toEqual({})
})

it('honours excludes while extracting', async () => {
  const { exitCode, written } = await run('unzip -q /a/a.zip -x drop.txt -d /b/out')
  expect(exitCode).toBe(0)
  expect(written).toEqual({ '/out/keep.txt': ENC.encode('keep\n') })
})
