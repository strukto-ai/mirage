import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { SSHVFS } from '../vfs/ssh/ssh.ts'
import { makeFakeAccessor } from '../../tests/core/ssh/_test_utils.ts'
import * as diskUtils from '../core/disk/utils.ts'
import { Workspace } from '../workspace.ts'

const DEC = new TextDecoder()

async function setup(kind: string, count = 0) {
  const root = await mkdtemp(join(tmpdir(), 'mirage-walk-'))
  const opened: string[] = []
  const vfs = kind === 'disk' ? new DiskVFS({ root }) : new SSHVFS({ host: 'fake', root: '/srv' })
  if (kind === 'disk') {
    for (const name of ['a', 'b', 'c']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'f'), 'x')
    }
    if (count > 0) {
      await mkdir(join(root, 'large'))
      for (let number = 0; number < count; number++)
        await writeFile(join(root, 'large', String(number)), 'x')
    }
    const original = diskUtils.readEntries
    vi.spyOn(diskUtils, 'readEntries').mockImplementation((path) => {
      opened.push(basename(path))
      if (basename(path) === 'c')
        return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
      return original(path)
    })
  } else if (vfs instanceof SSHVFS) {
    const state = {
      files: new Map(['a', 'b', 'c'].map((d) => [`/srv/${d}/f`, { data: new Uint8Array([120]) }])),
      dirs: new Map(['/srv', '/srv/a', '/srv/b', '/srv/c'].map((d) => [d, {}])),
    }
    const accessor = makeFakeAccessor(state, '/srv')
    if (count > 0) {
      state.dirs.set('/srv/large', {})
      for (let number = 0; number < count; number++)
        state.files.set(`/srv/large/${String(number)}`, { data: new Uint8Array([120]) })
    }
    const sftp = await accessor.sftp()
    const readdir = sftp.readdir.bind(sftp)
    vi.spyOn(sftp, 'readdir').mockImplementation((path, cb) => {
      opened.push(basename(String(path)))
      if (String(path) === '/srv/c')
        cb(Object.assign(new Error('Permission denied'), { code: 3 }), [])
      else readdir(path, cb)
    })
    vi.spyOn(vfs.accessor, 'sftp').mockResolvedValue(sftp)
  }
  const ws = new Workspace({ '/d': vfs, '/t': new RAMVFS() }, { mode: 'exec' })
  const close = async () => {
    await ws.close()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
  return { ws, opened, close }
}

describe.each(['disk', 'ssh'])('partial traversal on %s', (kind) => {
  it('keeps readable output, redirects diagnostics and continues the command line', async () => {
    const { ws, close } = await setup(kind)
    const diagnostic = "find: '/d/c': Permission denied\n"
    try {
      const cases: [string, number, string, string][] = [
        ['find /d -type f', 1, '/d/a/f\n/d/b/f\n', diagnostic],
        ['find /d -maxdepth 1', 0, '/d\n/d/a\n/d/b\n/d/c\n', ''],
        ['find /d -empty', 1, '', diagnostic],
        ['du -s /d', 1, '2\t/d\n', "du: cannot read directory '/d/c': Permission denied\n"],
        [
          'echo before; find /d -type f | head -3; echo after=$?',
          0,
          'before\n/d/a/f\n/d/b/f\nafter=0\n',
          diagnostic,
        ],
        [
          "echo before; find / -maxdepth 3 -type f -name '*zzz*' 2>/dev/null; echo after=$?",
          0,
          'before\nafter=1\n',
          '',
        ],
        [
          'echo before; find /d -type f >/t/o 2>/dev/null; echo after=$?; cat /t/o',
          0,
          'before\nafter=1\n/d/a/f\n/d/b/f\n',
          '',
        ],
      ]
      for (const [line, code, out, err] of cases) {
        const result = await ws.shell(line)
        expect(
          [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)],
          line,
        ).toEqual([code, out, err])
      }
      const result = await ws.shell('echo before; du -s / 2>/dev/null; echo after=$?')
      expect(DEC.decode(result.stdout)).toMatch(/^before\n\d+\t\/\nafter=1\n$/)
      expect(DEC.decode(result.stderr)).toBe('')
    } finally {
      await close()
    }
  })

  it('never opens a directory at the depth limit', async () => {
    const { ws, opened, close } = await setup(kind)
    try {
      expect((await ws.shell('find /d -maxdepth 1')).exitCode).toBe(0)
      expect(opened).not.toContain('c')
      const result = await ws.shell('find /d/c -maxdepth 0')
      expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, '/d/c\n'])
      expect(opened).not.toContain('c')
    } finally {
      await close()
    }
  })
})

it.each(['disk', 'ssh'])(
  'du on %s exceeds the default walker budget',
  async (kind) => {
    const { ws, close } = await setup(kind, 10001)
    try {
      const summary = await ws.shell('du -s /d/large')
      expect([summary.exitCode, DEC.decode(summary.stderr)]).toEqual([0, ''])
      expect(DEC.decode(summary.stdout)).toBe('10001\t/d/large\n')
      const detailed = await ws.shell('du -a /d/large')
      expect([detailed.exitCode, DEC.decode(detailed.stderr)]).toEqual([0, ''])
      const rows = DEC.decode(detailed.stdout).trimEnd().split('\n')
      expect(rows).toHaveLength(10002)
      expect(rows.at(-1)).toBe('10001\t/d/large')
    } finally {
      await close()
    }
  },
  60000,
)
