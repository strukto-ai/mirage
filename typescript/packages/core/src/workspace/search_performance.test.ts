import { expect, it, vi } from 'vitest'
import { AsyncLineIterator } from '../io/async_line_iterator.ts'
import { MountMode } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { getTestParser, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

const COMMANDS = [
  'grep -c zzqqxx /data/tree/a.txt',
  'grep -ci zzqqxx /data/tree/a.txt',
  "grep -cE 'zzqqxx|qqzzyy' /data/tree/a.txt",
  String.raw`grep -c 'zzqqxx\|qqzzyy' /data/tree/a.txt`,
  "grep -c 'zz.qxx' /data/tree/a.txt",
  'grep -cw zzqqxx /data/tree/a.txt',
  'grep -ci -e zzqqxx -e qqzzyy /data/tree/a.txt',
  'grep -ril zzqqxx /data/tree',
  "grep -rlE 'zzqqxx|qqzzyy' /data/tree",
  'rg -c zzqqxx /data/tree/a.txt',
  'rg -ci zzqqxx /data/tree/a.txt',
  "rg -c 'zzqqxx|qqzzyy' /data/tree/a.txt",
  'rg -w zzqqxx /data/tree/a.txt',
  "rg -li 'zzqqxx|qqzzyy' /data/tree",
]

it.each(COMMANDS)('skips nonmatching blocks through the shell: %s', async (command) => {
  const parser = await getTestParser()
  const ram = new RAMVFS()
  ram.store.dirs.add('/')
  ram.store.dirs.add('/tree')
  const data = new TextEncoder().encode('abcdefg\n'.repeat(40000))
  ram.store.files.set('/tree/a.txt', data)
  ram.store.files.set('/tree/b.txt', data)
  const ws = new Workspace({ '/data': ram }, { mode: MountMode.WRITE, shellParser: parser })
  const lines = vi.spyOn(AsyncLineIterator.prototype, 'readline')
  const records = vi.spyOn(AsyncLineIterator.prototype, 'readUntil')
  try {
    const io = await ws.shell(command)
    expect(stdoutStr(io)).toBe(command.includes('grep -c') ? '0\n' : '')
    expect(io.exitCode).toBe(1)
    expect(lines.mock.calls.length + records.mock.calls.length).toBeLessThan(100)
  } finally {
    lines.mockRestore()
    records.mockRestore()
    await ws.close()
  }
})
