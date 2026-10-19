import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { Delta, FileEvent, FileChangeKind, PathSpec } from '@struktoai/mirage-core/types'
import { cursorOf, longpoll, runLongpoll, runWithShutdown } from './dropbox.ts'

const checkpoint = (cursor: string): string =>
  JSON.stringify({ dropbox: { cursor, seen: { a: 'old' } } })

test('longpoll refreshes its cursor after every pull and honors idle backoff', async () => {
  const calls: (string | number)[][] = []
  const checkpoints: (string | null)[] = []
  const states = ['a', 'b', 'c'].map(checkpoint)
  const stop = new Error('stop')
  await assert.rejects(
    runLongpoll(
      {
        pull: async (_root, previous) => {
          checkpoints.push(previous)
          return new Delta({
            changes: [],
            checkpoint: states[checkpoints.length - 1]!,
          })
        },
      },
      PathSpec.fromStrPath('/dropbox', ''),
      async () => {
        assert.fail('unexpected event')
      },
      async (cursor) => {
        calls.push(['poll', cursor])
        if (calls.length === 1) return [false, 5]
        if (cursor === 'a') return [true, 2]
        if (cursor === 'b') return [true, 0]
        throw stop
      },
      async (seconds) => {
        calls.push(['pause', seconds])
      },
    ),
    (error) => error === stop,
  )
  assert.deepEqual(calls, [
    ['poll', 'a'],
    ['pause', 5],
    ['poll', 'a'],
    ['pause', 2],
    ['poll', 'b'],
    ['poll', 'c'],
  ])
  assert.deepEqual(checkpoints, [null, ...states.slice(0, 2)])
})

test('longpoll sends no authorization and treats reset as a pull with the old checkpoint', async (t) => {
  const calls: RequestInit[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://notify.dropboxapi.com/2/files/list_folder/longpoll')
    calls.push(options)
    return new Response(JSON.stringify({ error: { '.tag': 'reset' } }), {
      status: 409,
    })
  })
  assert.deepEqual(await longpoll('cursor', new AbortController().signal), [true, 0])
  assert.deepEqual(calls[0]!.headers, { 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(calls[0]!.body as string), {
    cursor: 'cursor',
    timeout: 30,
  })
})

test('an unknown checkpoint fails loudly', () => {
  assert.throws(() => cursorOf('{"_dbx":1,"c":"a"}'), /Expected/)
})

test('a missing root retries, preserves its snapshot, and notifies before polling', async () => {
  const root = PathSpec.fromStrPath('/dropbox', '')
  const change = new FileEvent({
    kind: FileChangeKind.CREATE,
    path: PathSpec.fromStrPath('/dropbox/a'),
    timestamp: new Date(0),
  })
  const states = [
    new Delta({ changes: [], checkpoint: checkpoint('') }),
    new Delta({ changes: [change], checkpoint: checkpoint('recovered') }),
  ]
  const calls: unknown[] = []
  const stop = new Error('stop')
  await assert.rejects(
    runLongpoll(
      {
        pull: async (_root, previous) => {
          calls.push(['pull', previous])
          return states.shift()!
        },
      },
      root,
      async (event) => {
        calls.push(['notify', event])
      },
      async (cursor) => {
        calls.push(['poll', cursor])
        throw stop
      },
      async (seconds) => {
        calls.push(['pause', seconds])
      },
    ),
    (error) => error === stop,
  )
  assert.deepEqual(calls, [
    ['pull', null],
    ['pause', 30],
    ['pull', checkpoint('')],
    ['notify', change],
    ['poll', 'recovered'],
  ])
})

for (const [stage, closeDelay] of [
  ['baseline', 0],
  ['delta', 0],
  ['baseline', 1500],
] as const) {
  test(
    `shutdown finishes ${closeDelay}ms cleanup before exiting a stalled ${stage} pull`,
    { timeout: 10_000 },
    async () => {
      const code = `
      import { createServer } from 'node:http'
      import { runLongpoll, runWithShutdown } from ${JSON.stringify(new URL('./dropbox.ts', import.meta.url).href)}
      import { Workspace, PathSpec } from ${JSON.stringify(import.meta.resolve('@struktoai/mirage-node'))}
      import { Delta } from ${JSON.stringify(import.meta.resolve('@struktoai/mirage-core/types'))}
      const controller = new AbortController()
      const ws = new Workspace({})
      const server = createServer(() => controller.abort())
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      let pulls = 0
      const hook = { pull: async () => {
        if (${JSON.stringify(stage)} === 'baseline' || pulls++ > 0) {
          await fetch('http://127.0.0.1:' + server.address().port)
          throw new Error('stalled pull unexpectedly completed')
        }
        return new Delta({ changes: [], checkpoint: JSON.stringify({ dropbox: { cursor: 'cursor', seen: {} } }) })
      } }
      await runWithShutdown(
        () => runLongpoll(hook, PathSpec.fromStrPath('/dropbox', ''), async () => {},
          async () => [true, 0], async () => {}),
        async () => {
          await new Promise(resolve => setTimeout(resolve, ${closeDelay}))
          await ws.close()
          console.log('closed')
        }, controller.signal)
    `
      const child = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        err += String(chunk)
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
      try {
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
        assert.equal(exit, 130, err)
        assert.equal(out, 'closed\n')
        assert.equal(err, '')
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  )
}

test('normal completion and failure both close without forced shutdown', async () => {
  for (const failure of [false, true]) {
    let closed = 0
    const error = new Error('pull failed')
    const result = runWithShutdown(
      async () => {
        if (failure) throw error
      },
      async () => {
        closed++
      },
      new AbortController().signal,
    )
    if (failure) await assert.rejects(result, (e) => e === error)
    else await result
    assert.equal(closed, 1)
  }
})

test('an already cancelled subscription closes without starting a pull', async () => {
  const controller = new AbortController()
  controller.abort()
  let closed = false
  await runWithShutdown(
    async () => {
      assert.fail('unexpected pull')
    },
    async () => {
      closed = true
    },
    controller.signal,
  )
  assert.equal(closed, true)
})

for (const stage of ['baseline', 'poll', 'delta']) {
  test(`cancellation during ${stage} prevents further pulls and notifications`, async () => {
    const controller = new AbortController()
    const root = PathSpec.fromStrPath('/dropbox', '')
    const change = new FileEvent({
      kind: FileChangeKind.CREATE,
      path: root,
      timestamp: new Date(0),
    })
    let pulls = 0
    await assert.rejects(
      runLongpoll(
        {
          pull: async () => {
            pulls++
            if (stage === 'baseline' || pulls === 2) controller.abort()
            return new Delta({ changes: [change], checkpoint: checkpoint('cursor') })
          },
        },
        root,
        async () => {
          assert.fail('notification after cancellation')
        },
        async () => {
          if (stage === 'poll') controller.abort()
          return [true, 0]
        },
        async () => {
          assert.fail('unexpected pause')
        },
        controller.signal,
      ),
      (error) => error === controller.signal.reason,
    )
    assert.equal(pulls, stage === 'delta' ? 2 : 1)
  })
}
