import type { Policy } from '@struktoai/mirage-core/policy/base'
import { Policies, agreed, settled } from '@struktoai/mirage-core/policy/policies'
import type { Ask, CommandContext, CommandRule, Route } from '@struktoai/mirage-core/policy/types'
import { PosixRegex } from '@struktoai/mirage-core/rs/regex'
import { openStream, openStreamSync } from '@struktoai/mirage-core/rs/stream'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-browser'
import { checkCompositionCorpus } from '../policy/composition.ts'

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((ready) => {
    resolve = ready
  })
  return { promise, resolve }
}

function context(command: string): CommandContext {
  return { command, paths: [], argv: [], cwd: '/' }
}

async function allHooks(): Promise<void> {
  const seen = new Set<string>()
  const record = (hook: string): null => {
    seen.add(hook)
    return null
  }
  const policy: Policy = {
    preExecute: () => record('pre_execute'),
    postExecute: () => record('post_execute'),
    preCommand: () => record('pre_command'),
    postCommand: () => record('post_command'),
    preVfs: () => record('pre_vfs'),
    postVfs: () => record('post_vfs'),
    preSession: () => record('pre_session'),
    postSession: () => record('post_session'),
  }
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, policies: [policy] })
  try {
    const result = await ws.shell(
      'export POLICY_CHECK=ok; echo payload > /data/item; cat /data/item',
    )
    equal([result.exitCode, result.stdoutText, result.stderrText], [0, 'payload\n', ''])
    equal([...seen].sort(), [
      'post_command',
      'post_execute',
      'post_session',
      'post_vfs',
      'pre_command',
      'pre_execute',
      'pre_session',
      'pre_vfs',
    ])
  } finally {
    await ws.close()
  }
}

async function suspendedRetirement(): Promise<void> {
  const first = deferred()
  const second = deferred()
  const entered = deferred()
  const calls: string[] = []
  const policies = new Policies([
    {
      async preCommand(ctx) {
        calls.push(ctx.command)
        if (calls.length === 2) entered.resolve()
        await (ctx.command === 'first' ? first.promise : second.promise)
        return { kind: 'deny', reason: ctx.command }
      },
    },
  ])
  const a = policies.preCommand(context('first'))
  const b = policies.preCommand(context('second'))
  await entered.promise
  try {
    const regex = new PosixRegex('x$')
    const size = 34 * 1024 * 1024
    equal(await regex.search('a'.repeat(size) + 'x'), [[size, size + 1]])
    const stream = await openStream('base64', { mode: 'decode', ignore_garbage: false })
    stream.close()
    second.resolve()
    equal((await b)?.reason, 'second')
    first.resolve()
    equal((await a)?.reason, 'first')
    equal(calls, ['first', 'second'])
  } finally {
    first.resolve()
    second.resolve()
    await Promise.allSettled([a, b])
  }
}

async function cancelledCallback(): Promise<void> {
  const entered = deferred()
  const release = deferred()
  const abort = new AbortController()
  let calls = 0
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          async preCommand(ctx) {
            if (ctx.command !== 'touch') return null
            calls++
            entered.resolve()
            await release.promise
            return null
          },
        },
      ],
    },
  )
  const running = ws.shell('touch /data/late', { signal: abort.signal })
  const outcome = running.then(
    () => 'completed',
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  )
  try {
    await entered.promise
    abort.abort()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      equal(
        await Promise.race([
          outcome,
          new Promise<string>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('cancelled callback kept the evaluation waiting')),
              2000,
            )
          }),
        ]),
        'AbortError',
      )
    } finally {
      clearTimeout(timeout)
    }
    release.resolve()
    equal(await ws.vfs.exists('/data/late'), false)
    equal(calls, 1)
    const next = await ws.shell('echo alive')
    equal([next.exitCode, next.stdoutText], [0, 'alive\n'])
  } finally {
    release.resolve()
    await outcome
    await ws.close()
  }
}

async function liveAsks(): Promise<void> {
  const rule = (reason: string): CommandRule => ({ reason, commands: ['cat'] })
  const original = [rule('a')]
  const first: Ask = { kind: 'ask', reason: 'first', policy: 'first', rules: original }
  const policies = new Policies([
    { preCommand: () => first },
    {
      preCommand() {
        original.push(rule('b'))
        return { kind: 'ask', reason: 'second', rules: [rule('c')] }
      },
    },
    {
      preCommand() {
        original.push(rule('not part of the merged copy'))
        return { kind: 'ask', reason: 'third', rules: [rule('e')] }
      },
    },
  ])
  const result = await policies.preCommand(context('cat'))
  if (result?.kind !== 'ask') throw new Error('expected all approval rules')
  equal(
    result.rules?.map((item) => item.reason),
    ['a', 'b', 'c', 'e'],
  )
}

async function liveRoutes(): Promise<void> {
  const first: Route = { kind: 'route', runtime: 'node', reason: 'first', policy: 'first' }
  const policies = new Policies([
    { preExecute: () => first },
    {
      preExecute() {
        first.runtime = 'ssh'
        return { kind: 'route', runtime: 'node', reason: 'second', policy: 'second' }
      },
    },
  ])
  const [result, route] = await policies.preExecute({ line: 'echo x', commands: [], sessionId: '' })
  equal([result?.kind, route], ['deny', null])
}

export const POLICY_CHECKS: [string, () => Promise<void>][] = [
  ['approval rules preserve live values and the merge copy boundary', liveAsks],
  ['changed route values still cause a routing conflict', liveRoutes],
  [
    'standalone route settlement preserves the original action',
    async () => {
      const route: Route = { kind: 'route', runtime: 'node', reason: 'keep this reason' }
      if (agreed([route]) !== route || settled([route]) !== route)
        throw new Error('route settlement did not preserve the original action')
    },
  ],
  [
    'shared policy composition transcripts run through browser Wasm',
    async () => {
      const count = checkCompositionCorpus(
        () => openStreamSync('policy_compose', {}),
        (stream) => stream.close(),
      )
      if (count === 0) throw new Error('no composition transcripts ran')
    },
  ],
  ['policy composition reaches all eight real workspace hooks', allHooks],
  ['suspended policy evaluations survive retirement without callback replay', suspendedRetirement],
  ['a cancelled policy callback cannot authorize a late filesystem effect', cancelledCallback],
]
