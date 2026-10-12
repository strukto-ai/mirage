import { expect, it } from 'vitest'
import { makeIntegrationWS } from '../fixtures/integration_fixture.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import type { DevFiles } from '../../vfs/dev/store.ts'
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
function assertReleased(ws: Workspace): void {
  const [dev] = ws.registry.resolve('/dev/null')
  expect(dev).toBeInstanceOf(DevVFS)
  expect(((dev as DevVFS).store.files as DevFiles).state.inputs.size).toBe(0)
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
      assertReleased(ws)
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
      assertReleased(ws)
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
      assertReleased(ws)
    } finally {
      data.release.resolve()
      await ws.close()
    }
  },
)
it.each([
  ['head -c 200000 /dev/zero > >(wc -c)', '200000\n'],
  ['head -c 1 <(head -c 200000 /dev/zero)', '\0'],
  ['cat <(cat <(echo nested))', 'nested\n'],
  ['cat <(echo a) <(echo b)', 'a\nb\n'],
  ['printf tail > >(cat); wait', 'tail'],
  ['printf data > >(cat > /dev/null; false); echo status:$?; wait', 'status:0\n'],
  ['x=parent; printf data > >(cat > /dev/null; x=child); echo "$x"', 'parent\n'],
  ['stat -c %F <(echo hi); stat -c %F >(cat)', 'fifo\nfifo\n'],
  [': <(cat /dev/zero); echo after', 'after\n'],
])('owns pipe lifecycle: %s', async (command, output) => {
  const ws = await workspace()
  try {
    const io = await ws.shell(command)
    expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual([0, output, ''])
    assertReleased(ws)
  } finally {
    await ws.close()
  }
})

it('keeps process-substitution operands separate from stdin and releases their paths', async () => {
  const { ws } = await makeIntegrationWS()
  try {
    const result = await ws.shell(
      "printf 'outer\\n' | cat <(echo one) - <(echo two); echo /dev/fd/*",
    )
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([
      0,
      'one\nouter\ntwo\n/dev/fd/*\n',
      '',
    ])
  } finally {
    await ws.close()
  }
})
