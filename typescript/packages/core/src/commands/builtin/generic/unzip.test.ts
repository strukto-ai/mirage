import { expect, it } from 'vitest'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()

async function shell(line: string): Promise<[number, string, string]> {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const io = await ws.shell(
      "cd /data && printf '1\\n' > a; mkdir d; printf '1\\n' > d/a; printf '2\\n' > d/b; " + line,
    )
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

const ROWS: [string, string, [number, string, string]][] = [
  ['junk_paths', 'zip -q z.zip d/a; unzip -qj z.zip -d o; ls o', [0, 'a\n', '']],
  [
    'lower_names',
    'mkdir U; echo 1 > U/F; zip -q z.zip U/F; unzip -qLL z.zip -d o; ls o o/u',
    [0, 'o:\nu\n\no/u:\nf\n', ''],
  ],
  [
    'ignore_case',
    'zip -q z.zip d/a; unzip -qC z.zip D/A -d o; echo rc=$?; cat o/d/a',
    [0, 'rc=0\n1\n', ''],
  ],
  ['comment', 'zip -q z.zip d/a; echo c | zip -zq z.zip; unzip -qz z.zip', [0, 'c\n', '']],
  [
    'update_keeps_newer',
    'zip -q z.zip d/a; mkdir -p o/d; echo NEW > o/d/a; touch -d 2030-01-01T00:00:00Z o/d/a; unzip -qu z.zip -d o; cat o/d/a',
    [0, 'NEW\n', ''],
  ],
]

it.each(ROWS)('unzip option %s', async (_name, line, expected) => {
  expect(await shell(line)).toEqual(expected)
})
