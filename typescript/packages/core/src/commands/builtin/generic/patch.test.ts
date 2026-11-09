import { expect, it } from 'vitest'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const DEC = new TextDecoder()

async function shell(line: string): Promise<[number, string, string]> {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const io = await ws.shell('cd /data && ' + line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

const ROWS: [string, string, [number, string, string]][] = [
  [
    'output_that_cannot_open',
    "printf 'a\\nb\\nc\\n' > f; printf -- '--- f\\n+++ f\\n@@ -1,3 +1,3 @@\\n a\\n-b\\n+X\\n c\\n' > p; patch -o sub/out < p; echo rc=$?",
    [0, 'rc=2\n', "patch: **** Can't create file sub/out : No such file or directory\n"],
  ],
  [
    'backup',
    "printf 'a\\nb\\nc\\n' > f; printf -- '--- f\\n+++ f\\n@@ -1,3 +1,3 @@\\n a\\n-b\\n+X\\n c\\n' > p; patch -b f p; echo rc=$?; cat f.orig f",
    [0, 'patching file f\nrc=0\na\nb\nc\na\nX\nc\n', ''],
  ],
  [
    'reject_that_cannot_open',
    "printf 'a\\n' > f; printf -- '--- f\\n+++ f\\n@@ -1 +1 @@\\n-z\\n+A\\n' > q; patch -f -r sub/r f q; echo rc=$?",
    [
      0,
      'patching file f\nHunk #1 FAILED at 1.\n1 out of 1 hunk FAILED -- saving rejects to file sub/r\nrc=2\n',
      "patch: **** Can't create file sub/r : No such file or directory\n",
    ],
  ],
]

it.each(ROWS)('patch option %s', async (_name, line, expected) => {
  expect(await shell(line)).toEqual(expected)
})
