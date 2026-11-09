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
  [
    'delete',
    'zip -q out.zip d/a d/b; zip -q -d out.zip d/a; echo rc=$?; unzip -Z1 out.zip',
    [0, 'rc=0\nd/b\n', ''],
  ],
  ['junk_paths', 'zip -qj out.zip d/a; unzip -Z1 out.zip', [0, 'a\n', '']],
  [
    'exclude_and_include',
    "zip -q out.zip d/a d/b -x d/b; unzip -Z1 out.zip; rm out.zip; zip -q out.zip d/a d/b -i 'd/b'; unzip -Z1 out.zip",
    [0, 'd/a\nd/b\n', ''],
  ],
  ['names_from_stdin', "printf 'd/a\\n' | zip -q -@ out.zip; unzip -Z1 out.zip", [0, 'd/a\n', '']],
  ['move', 'zip -qm out.zip d/a; echo rc=$?; ls d', [0, 'rc=0\nb\n', '']],
  ['no_directory_entries', 'zip -qrD out.zip d; unzip -Z1 out.zip | sort', [0, 'd/a\nd/b\n', '']],
]

it.each(ROWS)('zip option %s', async (_name, line, expected) => {
  expect(await shell(line)).toEqual(expected)
})

async function mounted(line: string): Promise<[number, string, string]> {
  const ws = new Workspace(
    { '/data/': new RAMVFS(), '/m/': new RAMVFS() },
    { mode: MountMode.WRITE },
  )
  try {
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

it('refuses a mount root named on stdin like an operand', async () => {
  const line = 'cd /data; echo /m | zip -q -@ o.zip; echo rc=$?'
  expect(await mounted(line)).toEqual([
    0,
    'rc=1\n',
    "zip: cannot read '/m': Device or resource busy\n",
  ])
})

it('deletes a member named like a mount root', async () => {
  const line = 'cd /data; echo x > m; zip -q a.zip m; cd /; zip -q -d /data/a.zip m; echo rc=$?'
  expect((await mounted(line))[1]).toBe('rc=0\n')
})

it('carries names on stdin into a zip across mounts', async () => {
  const line =
    'cd /data; echo a > f; echo b > /m/g; echo f | zip -q -@ /data/o.zip /m/g; unzip -Z1 /data/o.zip | sort'
  expect((await mounted(line))[1]).toBe('f\nm/g\n')
})

it('keeps the root refusal for a d inside a temp path', async () => {
  const line = 'zip -r -bd /data/o.zip /m; echo rc=$?'
  expect(await mounted(line)).toEqual([
    0,
    'rc=1\n',
    "zip: cannot read '/m': Device or resource busy\n",
  ])
})
