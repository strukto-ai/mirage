import type { Policy } from '@struktoai/mirage-core/policy/base'
import { Policies, agreed, settled } from '@struktoai/mirage-core/policy/policies'
import { Outcome, Scope } from '@struktoai/mirage-core/policy/types'
import type {
  Ask,
  CommandContext,
  CommandRule,
  Decision,
  Route,
} from '@struktoai/mirage-core/policy/types'
import { PosixRegex } from '@struktoai/mirage-core/rs/regex'
import { openStream, openStreamSync } from '@struktoai/mirage-core/rs/stream'
import { asyncContextIsolatesTasks } from '@struktoai/mirage-core/utils/async_context'
import { applyStateDict, toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
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

async function within<T>(pending: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('approval lifecycle check timed out')), 5000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function rejects(pending: Promise<unknown>): Promise<void> {
  const refused = await pending.then(
    () => false,
    () => true,
  )
  equal(refused, true)
}

function pendingId(ws: Workspace, sessionId: string): string {
  const pending = ws.decisions.pending(sessionId)
  equal(pending.length, 1)
  const record = pending[0]
  if (record === undefined) throw new Error('expected one pending approval')
  return record.id
}

const FILE_APPROVAL = {
  commands: { ask: [{ reason: 'review protected files', paths: ['/data/protected/*'] }] },
}

async function overlappingOnceCalls(): Promise<void> {
  equal(asyncContextIsolatesTasks, false)
  const entered = deferred()
  const release = deferred()
  const asked: Decision[] = []
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      async onAsk(record) {
        asked.push(record)
        if (asked.length === 1) {
          entered.resolve()
          await release.promise
        }
        return { ...record, outcome: Outcome.ALLOW, scope: Scope.ONCE }
      },
    },
  )
  let slow: ReturnType<Workspace['tools']['read']> | undefined
  try {
    await ws.vfs.mkdir('/data/protected')
    await ws.vfs.write('/data/protected/item', 'private payload')
    const first = await ws.session('first', { profile: FILE_APPROVAL })
    const second = await ws.session('second', { profile: FILE_APPROVAL })
    slow = first.tools.read('/data/protected/item')
    await within(entered.promise)
    equal((await first.tools.read('/data/protected/item')).isError, undefined)
    equal((await second.tools.read('/data/protected/item')).isError, undefined)
    equal((await first.tools.read('/data/protected/item')).isError, undefined)
    equal(
      asked.map((record) => record.sessionId),
      ['first', 'first', 'second', 'first'],
    )
    equal(new Set(asked.map((record) => record.id)).size, 4)
    release.resolve()
    equal((await slow).isError, undefined)
  } finally {
    release.resolve()
    if (slow !== undefined) await Promise.allSettled([slow])
    await ws.close()
  }
}

async function cancelledPrompt(): Promise<void> {
  const entered = deferred()
  const release = deferred()
  const abort = new AbortController()
  const asked: Decision[] = []
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          preCommand: (ctx) =>
            ctx.command === 'touch' ? { kind: 'ask', reason: 'review touch' } : null,
        },
      ],
      async onAsk(record) {
        asked.push(record)
        if (asked.length !== 1) return null
        entered.resolve()
        await release.promise
        return { ...record, outcome: Outcome.ALLOW }
      },
    },
  )
  const running = ws.shell('touch /data/late', { signal: abort.signal })
  const outcome = running.then(
    () => 'completed',
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  )
  try {
    await within(entered.promise)
    abort.abort()
    equal(await within(outcome), 'AbortError')
    release.resolve()
    equal(await ws.vfs.exists('/data/late'), false)
    const retry = await ws.shell('touch /data/late')
    equal(retry.refusal?.kind, 'pending')
    equal(asked.length, 2)
    equal(new Set(asked.map((record) => record.id)).size, 2)
    const stale = asked[0]
    if (stale === undefined) throw new Error('expected the canceled prompt')
    await rejects(ws.decisions.answer(stale.id, Outcome.ALLOW))
    equal(await ws.vfs.exists('/data/late'), false)
  } finally {
    abort.abort()
    release.resolve()
    await outcome
    await ws.close()
  }
}

async function closedPrompt(): Promise<void> {
  const entered = deferred()
  const release = deferred()
  let oldId = ''
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      async onAsk(record) {
        if (oldId !== '') return null
        oldId = record.id
        entered.resolve()
        await release.promise
        return { ...record, outcome: Outcome.ALLOW, scope: Scope.SESSION }
      },
    },
  )
  await ws.vfs.mkdir('/data/protected')
  const original = await ws.session('worker', { profile: FILE_APPROVAL })
  const running = original.shell('touch /data/protected/late')
  const outcome = running.then(
    () => undefined,
    () => undefined,
  )
  try {
    await within(entered.promise)
    await ws.closeSession('worker')
    const replacement = await ws.session('worker', { profile: FILE_APPROVAL })
    release.resolve()
    await within(outcome)
    equal(await ws.vfs.exists('/data/protected/late'), false)
    await rejects(ws.decisions.answer(oldId, Outcome.ALLOW))
    equal((await replacement.shell('touch /data/protected/late')).refusal?.kind, 'pending')
    const freshId = pendingId(ws, 'worker')
    equal(freshId === oldId, false)
    await ws.decisions.answer(freshId, Outcome.ALLOW)
    equal((await replacement.shell('touch /data/protected/late')).exitCode, 0)
    equal((await replacement.shell('touch /data/protected/late')).refusal?.kind, 'pending')
  } finally {
    release.resolve()
    await outcome
    await ws.close()
  }
}

async function profileInvalidatesTicket(): Promise<void> {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.vfs.mkdir('/data/protected')
    const agent = await ws.session('agent', { profile: FILE_APPROVAL })
    equal((await agent.shell('touch /data/protected/item')).refusal?.kind, 'pending')
    const oldId = pendingId(ws, 'agent')
    await ws.setSessionProfile('agent', {
      commands: { deny: [{ reason: 'touch is closed', commands: ['touch'] }] },
    })
    await rejects(ws.decisions.answer(oldId, Outcome.ALLOW))
    equal((await agent.shell('touch /data/protected/item')).exitCode, 126)
    equal(await ws.vfs.exists('/data/protected/item'), false)
    await ws.setSessionProfile('agent', FILE_APPROVAL)
    equal((await agent.shell('touch /data/protected/item')).refusal?.kind, 'pending')
    equal(pendingId(ws, 'agent') === oldId, false)
  } finally {
    await ws.close()
  }
}

async function snapshotInvalidatesApprovals(): Promise<void> {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    await ws.vfs.mkdir('/data/protected')
    const agent = await ws.session('agent', { profile: FILE_APPROVAL })
    equal((await agent.shell('touch /data/protected/item')).refusal?.kind, 'pending')
    const pending = pendingId(ws, 'agent')
    const state = await toStateDict(ws)
    await ws.decisions.answer(pending, Outcome.ALLOW, Scope.SESSION)
    equal((await agent.shell('touch /data/protected/item')).exitCode, 0)
    equal((await agent.shell('touch /data/protected/other')).exitCode, 0)
    await applyStateDict(ws, state)
    equal(await ws.vfs.exists('/data/protected/item'), false)
    equal(await ws.vfs.exists('/data/protected/other'), false)
    await rejects(ws.decisions.answer(pending, Outcome.ALLOW))
    equal((await agent.shell('touch /data/protected/item')).refusal?.kind, 'pending')
    const freshId = pendingId(ws, 'agent')
    equal(freshId === pending, false)
    await ws.decisions.answer(freshId, Outcome.ALLOW)
    equal((await agent.shell('touch /data/protected/item')).exitCode, 0)
    equal((await agent.shell('touch /data/protected/item')).refusal?.kind, 'pending')
  } finally {
    await ws.close()
  }
}

class CachedRAM extends RAMVFS {
  override readonly cachesReads = true
  reads = 0

  override read(...args: Parameters<RAMVFS['read']>): ReturnType<RAMVFS['read']> {
    this.reads++
    return super.read(...args)
  }
}

async function invalidatedCachedRead(restore: boolean): Promise<void> {
  const entered = deferred()
  const release = deferred()
  const ram = new CachedRAM()
  let paused = false
  let prompts = 0
  const ws = new Workspace(
    { '/data': ram },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          async postVfs(ctx) {
            if (paused || ctx.call.name !== 'read' || ctx.path.virtual !== '/data/protected/item')
              return null
            paused = true
            entered.resolve()
            await release.promise
            return null
          },
        },
      ],
      onAsk: async (record) => {
        prompts++
        return { ...record, outcome: Outcome.ALLOW }
      },
    },
  )
  let running: ReturnType<Workspace['tools']['read']> | undefined
  try {
    await ws.vfs.mkdir('/data/protected')
    await ws.vfs.write('/data/protected/item', 'cached private payload')
    await ws.cache.set('/data/protected/item', new TextEncoder().encode('cached private payload'), {
      ttl: 600,
    })
    const agent = await ws.session('agent', { profile: FILE_APPROVAL })
    const state = restore ? await toStateDict(ws) : null
    running = agent.tools.read('/data/protected/item')
    await within(entered.promise)
    equal(ram.reads, 0)
    if (state === null) {
      await ws.setSessionProfile('agent', {
        commands: { ask: [{ reason: 'review changed files', paths: ['/data/protected/*'] }] },
      })
    } else await applyStateDict(ws, state)
    release.resolve()
    const result = await within(running)
    equal(result.isError, true)
    equal(
      result.content.some((part) => part.text.includes('cached private payload')),
      false,
    )
    equal((await agent.tools.read('/data/protected/item')).isError, undefined)
    equal(prompts, 2)
  } finally {
    release.resolve()
    if (running !== undefined) await Promise.allSettled([running])
    await ws.close()
  }
}

async function mediaCallerIsolation(): Promise<void> {
  equal(asyncContextIsolatesTasks, false)
  const entered = deferred()
  const release = deferred()
  let paused = false
  let prompts = 0
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          async postVfs(ctx) {
            if (paused || ctx.call.name !== 'read' || ctx.path.virtual !== '/data/protected/item')
              return null
            paused = true
            entered.resolve()
            await release.promise
            return null
          },
        },
      ],
      onAsk: async (record) => {
        prompts++
        return { ...record, outcome: Outcome.ALLOW }
      },
    },
  )
  let slow: ReturnType<Workspace['tools']['read']> | undefined
  try {
    await ws.vfs.mkdir('/data/protected')
    await ws.vfs.write('/data/protected/item', 'private payload')
    const agent = await ws.session('agent', { profile: FILE_APPROVAL })
    slow = agent.tools.read('/data/protected/item')
    await within(entered.promise)
    const media = await agent.tools.readMedia('/data/protected/item')
    if (!('content' in media)) throw new Error('expected a text media fallback')
    equal(media.isError, undefined)
    equal(prompts, 2)
    release.resolve()
    equal((await slow).isError, undefined)
  } finally {
    release.resolve()
    if (slow !== undefined) await Promise.allSettled([slow])
    await ws.close()
  }
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
  [
    'overlapping RAM tool calls keep once approvals on their explicit callers',
    overlappingOnceCalls,
  ],
  ['a canceled inline approval cannot authorize a late filesystem effect', cancelledPrompt],
  ['closing and recreating a RAM session rejects late replies and stale tickets', closedPrompt],
  ['changing a profile invalidates its pending approval ticket', profileInvalidatesTicket],
  [
    'restoring a snapshot invalidates RAM approvals and pending tickets',
    snapshotInvalidatesApprovals,
  ],
  [
    'a profile change revokes a suspended caller before cached data returns',
    () => invalidatedCachedRead(false),
  ],
  [
    'a snapshot restore revokes a suspended caller before cached data returns',
    () => invalidatedCachedRead(true),
  ],
  ['media reads keep once approvals separate from suspended tool calls', mediaCallerIsolation],
]
