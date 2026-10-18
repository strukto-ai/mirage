import { expect, it } from 'vitest'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import { Channel, JobConsole } from '../../shell/console/index.ts'
import { Workspace } from '../workspace/workspace.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

class BarrierVFS extends RAMVFS {
  readonly release = barrier()
  readonly started = barrier()
  readonly closed = barrier()
  constructor() {
    super()
    this.store.files.set('/source', new TextEncoder().encode('firstlast'))
  }
  override async *readStream(_path: PathSpec): AsyncGenerator<Uint8Array> {
    try {
      this.started.resolve()
      yield new TextEncoder().encode('first')
      await this.release.promise
      yield new TextEncoder().encode('last')
    } finally {
      this.closed.resolve()
    }
  }
}
class FirstByte extends JobConsole {
  readonly first = barrier()
  out = ''
  err = ''
  override emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (channel === Channel.STDOUT) {
      this.out += new TextDecoder().decode(data)
      if (data.byteLength > 0) this.first.resolve()
    } else this.err += new TextDecoder().decode(data)
    return Promise.resolve()
  }
}
async function assertReleased(ws: Workspace): Promise<void> {
  expect((await ws.shell('echo /dev/fd/*')).stdoutText).toBe('/dev/fd/*\n')
}
async function workspace(data = new RAMVFS()): Promise<Workspace> {
  return new Workspace(
    { '/data': data },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
}
it.each(['cat <(cat /data/source)', 'cat < <(cat /data/source)', 'cat /data/source > >(cat)'])(
  'delivers the first byte before producer completion: %s',
  async (command) => {
    const data = new BarrierVFS()
    const sink = new FirstByte()
    const ws = await workspace(data)
    let settled = false
    const running = ws.shell(command, { sink }).finally(() => {
      settled = true
    })
    try {
      await sink.first.promise
      expect(sink.out).toBe('first')
      expect(settled).toBe(false)
      data.release.resolve()
      const io = await running
      expect(io.exitCode).toBe(0)
      expect([sink.out, sink.err]).toEqual(['firstlast', ''])
      await assertReleased(ws)
    } finally {
      data.release.resolve()
      await running
      await ws.close()
    }
  },
)
it.each(['head -c 1 <(cat /data/source)', 'head -c 1 < <(cat /data/source)'])(
  'releases an early reader even while the producer ignores cancellation: %s',
  async (command) => {
    const data = new BarrierVFS()
    const ws = await workspace(data)
    try {
      const io = await ws.shell(command)
      expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual([0, 'f', ''])
      await assertReleased(ws)
      data.release.resolve()
      await data.closed.promise
    } finally {
      data.release.resolve()
      await ws.close()
    }
  },
)
it.each(['cat <(cat /data/source)', 'cat /data/source > >(cat)'])(
  'cancels children and releases descriptors: %s',
  async (command) => {
    const data = new BarrierVFS()
    const ws = await workspace(data)
    const abort = new AbortController()
    const running = ws.shell(command, { signal: abort.signal })
    const rejection = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await data.started.promise
      abort.abort()
      data.release.resolve()
      await rejection
      await data.closed.promise
      await assertReleased(ws)
    } finally {
      data.release.resolve()
      await ws.close()
    }
  },
)
it.each([
  ['head -c 1 <(head -c 200000 /dev/zero)', [0, '\0', '']],
  ['cat <(cat <(echo nested))', [0, 'nested\n', '']],
  [': <(cat /dev/zero); echo after', [0, 'after\n', '']],
  ['printf data > >(cat > /dev/null); echo after:$?', [0, 'after:0\n', '']],
  ['head -c 200000 /dev/zero > >(head -c 1 > /dev/null); echo st:$?', [0, 'st:141\n', '']],
  ["printf '%0200000d' 0 > >(head -c 1 > /dev/null); echo after", [141, '', '']],
  ["printf 'outer\\n' | cat <(echo one) - <(echo two)", [0, 'one\nouter\ntwo\n', '']],
  [
    'exec 3< <(printf a); echo st:$?',
    [0, 'st:2\n', 'mirage: unsupported: exec onto a process substitution\n'],
  ],
])('releases its descriptors: %s', async (command, expected) => {
  const ws = await workspace()
  try {
    const io = await ws.shell(command)
    expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual(expected)
    await assertReleased(ws)
  } finally {
    await ws.close()
  }
})
