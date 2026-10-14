import { afterEach, describe, expect, it, vi } from 'vitest'
import { WordKind } from '../commands/spec/types.ts'
import type { WorkspaceBinding } from '../runtime/binding.ts'
import type * as ScriptModule from '../runtime/script.ts'
import { SCRIPT_EVAL_TIMEOUT } from '../runtime/constants.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import { PrefixResolver } from '../runtime/resolver.ts'
import {
  ScriptSource,
  type BridgeDispatchFn,
  type CodeExecution,
  type ExecutionRequest,
  type RunResult,
} from '../runtime/types.ts'
import {
  type CapacityResult,
  CapacityState,
  ContentType,
  FileStat,
  FileType,
  type JsonValue,
  PathSpec,
} from '../types.ts'
import type { NamespaceView, SessionView } from '../view/types.ts'
import { CALLS } from '../workspace/dispatcher/constants.ts'
import type { VfsCall } from '../vfs/types.ts'
import { CTX_ENV, DEFAULT_ASK_REASON, DEFAULT_DENY_REASON } from './constants.ts'
import { Policies } from './policies.ts'
import { ScriptPolicy, scriptAction, scriptContext } from './script.ts'
import {
  CommandWord,
  type CommandContext,
  type CommandResultContext,
  type ExecuteResultContext,
  type ProfileScript,
  type ProfileScripts,
  type RouteContext,
  type SessionContext,
  type VfsContext,
  type VfsResultContext,
} from './types.ts'

// Mirrors python/tests/policy/test_script.py.

const built = vi.hoisted(() => ({
  factory: null as null | ((runtime: string, config: Readonly<Record<string, unknown>>) => unknown),
}))

vi.mock('../runtime/script.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ScriptModule>()
  return {
    ...real,
    scriptEngine: (
      script: ScriptSource,
      runtime: string,
      config: Readonly<Record<string, unknown>> = {},
    ) =>
      built.factory === null
        ? real.scriptEngine(script, runtime, config)
        : built.factory(runtime, config),
  }
})

/** Stands in for a policy runtime, recording each run it was handed. */
class FakeProgram extends LanguageRuntime {
  readonly name = 'fake'
  readonly language = 'python' as const
  readonly requests: CodeExecution[] = []
  attached: WorkspaceBinding | null = null
  closed = false

  constructor(
    private readonly stdout = '',
    private readonly exitCode = 0,
    private readonly delayMs = 0,
  ) {
    super()
  }

  override bind(binding: WorkspaceBinding): void {
    super.bind(binding)
    this.attached = binding
  }

  override async execute(request: ExecutionRequest): Promise<RunResult> {
    if (request.kind !== 'code') throw new Error('a policy program is a code run')
    this.requests.push(request)
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    return {
      stdout: new TextEncoder().encode(this.stdout),
      stderr: this.exitCode === 0 ? null : new TextEncoder().encode('Traceback'),
      exitCode: this.exitCode,
    }
  }

  run(): Promise<RunResult> {
    throw new Error('unused')
  }

  override close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** A run that waits until a run on another runtime has started. */
class Waiting extends FakeProgram {
  constructor(private readonly started: Promise<void>) {
    super()
  }

  override async execute(request: ExecutionRequest): Promise<RunResult> {
    await this.started
    return super.execute(request)
  }
}

/** A run that says it started. */
class Starting extends FakeProgram {
  constructor(private readonly start: () => void) {
    super()
  }

  override async execute(request: ExecutionRequest): Promise<RunResult> {
    this.start()
    return super.execute(request)
  }
}

/** Records the most runs it was handed at once. */
class Overlapping extends FakeProgram {
  running = 0
  most = 0

  override async execute(request: ExecutionRequest): Promise<RunResult> {
    this.running++
    this.most = Math.max(this.most, this.running)
    await new Promise((resolve) => setTimeout(resolve, 10))
    this.running--
    return super.execute(request)
  }
}

const ENCODE = new TextEncoder()

function answer(fields: Record<string, string>): string {
  return JSON.stringify(fields)
}

function bytes(text: string): Uint8Array {
  return ENCODE.encode(text)
}

function entry(
  runtime = 'monty',
  source = 'SOURCE',
  config: Record<string, unknown> = {},
): ProfileScript {
  return { profile: 'release', script: new ScriptSource(source, 'python'), runtime, config }
}

function scripts(programs: ProfileScripts): { scriptsOf: () => ProfileScripts } {
  return { scriptsOf: () => programs }
}

function callOf(name: string): VfsCall {
  const call = CALLS.get(name)
  if (call === undefined) throw new Error(`no call ${name}`)
  return call
}

function refused(): Promise<void> {
  return Promise.reject(new Error('read only'))
}

function sessionView(cwd = '/data'): SessionView {
  const env: Record<string, string> = { TEAM: 'core', HOME: '/home/agent' }
  return {
    get: (name) => env[name] ?? null,
    snapshot: () => ({ ...env }),
    set: refused,
    unset: refused,
    mark: refused,
    isReadonly: (name) => name === 'HOME',
    profile: () => 'reviewer',
    cwd: () => cwd,
  }
}

function ns(): NamespaceView {
  return {
    mounts: {
      descendants: () => ['/data', '/vault'],
      visibleDescendants: () => ['/data'],
      isRoot: (path) => path === '/data' || path === '/vault',
      rootOf: () => '/data',
    },
  }
}

function ctx(
  command = 'cat',
  extra: Partial<CommandContext> = {},
  sessionId = 's',
): CommandContext {
  const sealed = PathSpec.fromStrPath('/repo/sealed/k')
  return {
    command,
    paths: [sealed],
    words: [
      new CommandWord(command, WordKind.NAME),
      new CommandWord('/repo/sealed/k', WordKind.OPERAND, null, sealed),
    ],
    argv: ['/repo/sealed/k'],
    cwd: '/repo',
    line: `${command} /repo/sealed/k`,
    sessionId,
    tokens: [command, '/repo/sealed/k'],
    program: [command],
    ...extra,
  }
}

function opsCtx(op = 'write', virtual = '/scratch/frozen/f', write = true): VfsContext {
  return {
    call: callOf(op),
    path: PathSpec.fromStrPath(virtual),
    write,
    prefix: '/scratch',
    sessionId: 's',
  }
}

function sessionCtx(key = 'AWS_KEY'): SessionContext {
  return { verb: 'set', key, value: 'v', sessionId: 's' }
}

function line(): RouteContext {
  return { line: 'python3 job.py', commands: [], sessionId: 's' }
}

/** A policy whose every program runs on the given fake, in order. */
function policyWith(method: keyof ProfileScripts, ...engines: FakeProgram[]): ScriptPolicy {
  const queue = [...engines]
  built.factory = () => queue.shift() ?? engines[engines.length - 1]
  const programs = engines.map((_, i) => entry('monty', `SOURCE ${String(i)}`, { slot: i }))
  return track(new ScriptPolicy(scripts({ [method]: programs })))
}

const open: ScriptPolicy[] = []

function track(policy: ScriptPolicy): ScriptPolicy {
  open.push(policy)
  return policy
}

afterEach(async () => {
  built.factory = null
  for (const policy of open.splice(0)) await policy.close()
})

describe('scriptAction', () => {
  it('reads nothing printed as no opinion', () => {
    expect(scriptAction(bytes(''), 'preCommand')).toBeNull()
    expect(scriptAction(bytes('  \n'), 'preCommand')).toBeNull()
    expect(scriptAction(bytes('null\n'), 'preCommand')).toBeNull()
  })

  it('reads a deny or an ask with its reason', () => {
    expect(scriptAction(bytes(answer({ kind: 'deny', reason: 'no' })), 'preVfs')).toEqual({
      kind: 'deny',
      reason: 'no',
    })
    expect(scriptAction(bytes(answer({ kind: 'ask', reason: 'nod' })), 'preVfs')).toEqual({
      kind: 'ask',
      reason: 'nod',
    })
  })

  it("gives a reason left out or empty the document's default", () => {
    for (const printed of [answer({ kind: 'deny' }), answer({ kind: 'deny', reason: '' })]) {
      expect(scriptAction(bytes(printed), 'preCommand')).toEqual({
        kind: 'deny',
        reason: DEFAULT_DENY_REASON,
      })
    }
    for (const printed of [answer({ kind: 'ask' }), answer({ kind: 'ask', reason: '' })]) {
      expect(scriptAction(bytes(printed), 'preCommand')).toEqual({
        kind: 'ask',
        reason: DEFAULT_ASK_REASON,
      })
    }
  })

  it('places a line at preExecute only', () => {
    const printed = bytes(answer({ kind: 'route', runtime: 'docker' }))
    expect(scriptAction(printed, 'preExecute')).toEqual({ kind: 'route', runtime: 'docker' })
    expect(() => scriptAction(printed, 'preCommand')).toThrow('cannot answer route at pre_command')
  })

  it.each([
    'deny',
    '"deny"',
    '{"deny": "x"}',
    '{"kind": "allow"}',
    '{"kind": "route"}',
    '{"kind": "deny", "runtime": "docker"}',
    '{"kind": "deny", "reason": "x", "policy": "Mine"}',
    '{"kind": "deny"}\n{"kind": "ask"}',
  ])('refuses anything else: %s', (printed) => {
    expect(() => scriptAction(bytes(printed), 'preExecute')).toThrow('must print a JSON answer')
  })
})

describe('scriptContext', () => {
  it('reads a context as its fields, with the session as data', () => {
    const data = scriptContext(ctx('cat', { session: sessionView(), ns: ns() }))
    expect(data.command).toBe('cat')
    expect(data.line).toBe('cat /repo/sealed/k')
    expect(data.paths).toEqual(['/repo/sealed/k'])
    expect(data.words).toEqual([
      { text: 'cat', kind: 'name', option: null, path: null },
      { text: '/repo/sealed/k', kind: 'operand', option: null, path: '/repo/sealed/k' },
    ])
    expect(data.session_id).toBe('s')
    expect(data).not.toHaveProperty('agent_id')
    expect(data.cwd).toBe('/data')
    expect(data.env).toEqual({ TEAM: 'core', HOME: '/home/agent' })
    expect(data.profile).toBe('reviewer')
    expect(data.mounts).toEqual(['/data'])
    expect(Object.keys(data)).not.toContain('session')
    expect(Object.keys(data)).not.toContain('ns')
  })

  it('lists each command of a line as preCommand reads it', () => {
    const line: RouteContext = {
      line: 'cat /repo/sealed/k',
      commands: [ctx('cat', { session: sessionView() })],
      sessionId: 's',
      session: sessionView(),
    }
    const data = scriptContext(line)
    expect(data.line).toBe('cat /repo/sealed/k')
    const [first] = data.commands as Record<string, unknown>[]
    expect(first?.command).toBe('cat')
    expect(Object.keys(first ?? {})).not.toContain('session')
    expect(data.cwd).toBe('/data')
  })

  it('reads an op and a variable write as their fields', () => {
    const op = scriptContext(opsCtx())
    expect((op.call as Record<string, unknown>).name).toBe('write')
    expect((op.call as Record<string, unknown>).effect).toBe('write')
    expect(op.path).toBe('/scratch/frozen/f')
    expect(op.write).toBe(true)
    expect([op.cwd, op.env, op.mounts]).toEqual(['/', {}, []])
    const written = scriptContext(sessionCtx())
    expect([written.verb, written.key, written.value]).toEqual(['set', 'AWS_KEY', 'v'])
  })

  it('keeps the keys of what a backend returned', () => {
    const extra = { reviewRequired: true, session: 'kept' }
    const stat = new FileStat({ name: 'f', type: FileType.FILE, extra })
    const done: VfsResultContext = { ...opsCtx('stat', '/scratch/f', false), result: stat }
    const data = scriptContext(done)
    expect((data.result as Record<string, unknown>).extra).toEqual(extra)
    expect(data.session_id).toBe('s')
    const capacity: CapacityResult = { state: CapacityState.QUOTA, inodesUsed: 1, inodesFree: 2 }
    const stated: VfsResultContext = {
      ...opsCtx('stat', '/scratch', false),
      result: ['ram', capacity],
    }
    const df = scriptContext(stated)
    expect((df.result as JsonValue[])[1]).toEqual({
      state: 'quota',
      inodes_used: 1,
      inodes_free: 2,
    })
  })
})

describe('ScriptPolicy', () => {
  it('runs nothing at a method without a program', async () => {
    const engine = new FakeProgram(answer({ kind: 'deny' }))
    const policy = policyWith('preCommand', engine)
    expect(await policy.preVfs(opsCtx())).toBeNull()
    expect(await policy.preSession(sessionCtx())).toBeNull()
    expect(engine.requests).toEqual([])
  })

  it('runs a program unedited, with its context in the env and on stdin', async () => {
    const engine = new FakeProgram(answer({ kind: 'deny', reason: 'sealed' }))
    const policy = policyWith('preCommand', engine)
    const judged = ctx('cat', { session: sessionView('/'), ns: ns() })
    expect(await policy.preCommand(judged)).toEqual([{ kind: 'deny', reason: 'sealed' }])
    const [request] = engine.requests
    if (request === undefined) throw new Error('the program never ran')
    expect(request.code).toBe('SOURCE 0')
    expect(request.language).toBe('python')
    expect(request.cwd?.virtual).toBe('/')
    const payload = request.env[CTX_ENV] ?? ''
    expect(JSON.parse(payload)).toEqual(scriptContext(judged))
    expect(new TextDecoder().decode(request.stdin ?? new Uint8Array())).toBe(payload)
    expect(request.env).toEqual({ [CTX_ENV]: payload })
    expect((JSON.parse(payload) as { env: Record<string, string> }).env.TEAM).toBe('core')
    expect(request.flags).toEqual({})
  })

  it("keeps the session's directory off a pyodide program's path", async () => {
    const engine = new FakeProgram('')
    built.factory = () => engine
    const policy = track(new ScriptPolicy(scripts({ preCommand: [entry('pyodide')] })))
    await policy.preCommand(ctx('cat', { session: sessionView('/data') }))
    expect(engine.requests[0]?.flags).toEqual({ P: true })
  })

  it('answers after the action too', async () => {
    const engine = new FakeProgram(answer({ kind: 'deny', reason: 'after' }))
    const policy = policyWith('postCommand', engine)
    const done: CommandResultContext = { ...ctx(), exitCode: 3, stderr: '', records: [] }
    expect(await policy.postCommand(done)).toEqual([{ kind: 'deny', reason: 'after' }])
    const payload = JSON.parse(engine.requests[0]?.env[CTX_ENV] ?? '{}') as Record<string, unknown>
    expect(payload.exit_code).toBe(3)
  })

  it('cannot route after the action', async () => {
    const policy = policyWith(
      'postExecute',
      new FakeProgram(answer({ kind: 'route', runtime: 'x' })),
    )
    const done = { ...line(), exitCode: 0, output: bytes('out') } as ExecuteResultContext
    expect(await policy.postExecute(done)).toEqual([
      { kind: 'deny', reason: "profile 'release' policy cannot answer route at post_execute" },
    ])
  })

  it("lets the policy's own read through after it, too", async () => {
    const engine = new FakeProgram(answer({ kind: 'deny', reason: 'frozen' }))
    built.factory = () => engine
    const stamped: symbol[] = []
    const policy = track(
      new ScriptPolicy(scripts({ preVfs: [entry()], postVfs: [entry()] }), {
        bridge: (issuer) => {
          stamped.push(issuer)
          return () => Promise.resolve(null)
        },
        resolver: new PrefixResolver(() => ['/repo/']),
      }),
    )
    await policy.preVfs(opsCtx('read', '/repo/a', false))
    const [token] = stamped
    if (token === undefined) throw new Error('the bridge was never built')
    const done: VfsResultContext = { ...opsCtx('read', '/repo/a', false), result: bytes('x') }
    expect(await policy.postVfs({ ...done, issuer: token })).toBeNull()
    expect(await policy.postVfs(done)).toEqual([{ kind: 'deny', reason: 'frozen' }])
  })

  it('returns each answer in order, up to the first deny', async () => {
    const late = new FakeProgram(answer({ kind: 'ask', reason: 'late' }))
    const policy = policyWith(
      'preCommand',
      new FakeProgram(''),
      new FakeProgram(answer({ kind: 'ask', reason: 'nod' })),
      new FakeProgram(answer({ kind: 'deny', reason: 'no' })),
      late,
    )
    expect(await policy.preCommand(ctx())).toEqual([
      { kind: 'ask', reason: 'nod' },
      { kind: 'deny', reason: 'no' },
    ])
    expect(late.requests).toEqual([])
  })

  it("has the chain read each answer as its own policy's", async () => {
    const denies = policyWith(
      'preCommand',
      new FakeProgram(answer({ kind: 'ask', reason: 'nod' })),
      new FakeProgram(answer({ kind: 'deny', reason: 'no' })),
    )
    expect(await new Policies([denies]).preCommand(ctx())).toMatchObject({
      kind: 'deny',
      reason: 'no',
    })
    const asks = policyWith(
      'preVfs',
      new FakeProgram(''),
      new FakeProgram(answer({ kind: 'ask', reason: 'nod' })),
    )
    expect(await new Policies([asks]).preVfs(opsCtx())).toMatchObject({
      kind: 'ask',
      reason: 'nod',
    })
  })

  it('keeps an ask and a route both', async () => {
    const policy = policyWith(
      'preExecute',
      new FakeProgram(answer({ kind: 'ask', reason: 'nod' })),
      new FakeProgram(answer({ kind: 'route', runtime: 'docker' })),
    )
    const [said, route] = await new Policies([policy]).preExecute(line())
    expect(said).toMatchObject({ kind: 'ask', reason: 'nod' })
    expect(route).toMatchObject({ kind: 'route', runtime: 'docker' })
  })

  it('needs every route to agree', async () => {
    const agree = policyWith(
      'preExecute',
      new FakeProgram(answer({ kind: 'route', runtime: 'docker' })),
      new FakeProgram(answer({ kind: 'route', runtime: 'docker' })),
    )
    const [none, route] = await new Policies([agree]).preExecute(line())
    expect(none).toBeNull()
    expect(route).toMatchObject({ kind: 'route', runtime: 'docker' })
    const differ = policyWith(
      'preExecute',
      new FakeProgram(answer({ kind: 'route', runtime: 'docker' })),
      new FakeProgram(answer({ kind: 'route', runtime: 'monty' })),
    )
    const [refused, unplaced] = await new Policies([differ]).preExecute(line())
    expect(unplaced).toBeNull()
    expect(refused).toMatchObject({
      kind: 'deny',
      reason:
        'policies place the line on different runtimes: ScriptPolicy on docker, ScriptPolicy on monty',
    })
  })

  it('fails closed on a program that exits non-zero', async () => {
    const policy = policyWith('preCommand', new FakeProgram('', 3))
    expect(await policy.preCommand(ctx())).toEqual([
      { kind: 'deny', reason: "profile 'release' policy exited 3" },
    ])
  })

  it('fails closed on a program that timed out, and stops it', async () => {
    const seconds = SCRIPT_EVAL_TIMEOUT.seconds
    SCRIPT_EVAL_TIMEOUT.seconds = 0.01
    try {
      const engine = new FakeProgram('', 0, 1000)
      const policy = policyWith('preCommand', engine)
      expect(await policy.preCommand(ctx())).toEqual([
        { kind: 'deny', reason: "profile 'release' policy timed out after 0.01s" },
      ])
      const [request] = engine.requests
      expect(request?.timeoutSeconds).toBe(0.01)
      expect(request?.signal?.aborted).toBe(true)
    } finally {
      SCRIPT_EVAL_TIMEOUT.seconds = seconds
    }
  })

  it('leaves a run that finished in time alone', async () => {
    const engine = new FakeProgram()
    await policyWith('preCommand', engine).preCommand(ctx())
    const [request] = engine.requests
    expect(request?.timeoutSeconds).toBe(SCRIPT_EVAL_TIMEOUT.seconds)
    expect(request?.signal?.aborted).toBe(false)
  })

  it('fails closed on a wrong answer', async () => {
    const policy = policyWith('preCommand', new FakeProgram('{"deny": "x"}'))
    const [action] = (await policy.preCommand(ctx())) ?? []
    expect(action?.kind).toBe('deny')
    expect(action !== undefined && 'reason' in action ? action.reason : '').toMatch(
      /^profile 'release' policy must print a JSON answer at pre_command/,
    )
  })

  it('fails closed on a runtime policies do not run on', async () => {
    const policy = track(new ScriptPolicy(scripts({ preCommand: [entry('quickjs')] })))
    expect(await policy.preCommand(ctx())).toEqual([
      {
        kind: 'deny',
        reason:
          "profile 'release' policy names runtime 'quickjs'; a policy program runs on monty or pyodide",
      },
    ])
  })

  it('fails closed on a runtime it cannot build', async () => {
    built.factory = (runtime) => {
      throw new Error(`script names runtime '${runtime}': nope`)
    }
    const policy = track(new ScriptPolicy(scripts({ preCommand: [entry('pyodide')] })))
    expect(await policy.preCommand(ctx())).toEqual([
      { kind: 'deny', reason: "profile 'release' policy names runtime 'pyodide': nope" },
    ])
  })

  it("gives a program its runtime's memory cap unless it names one", async () => {
    const settings: Record<string, unknown>[] = []
    built.factory = (_runtime, config) => {
      settings.push({ ...config })
      return new FakeProgram()
    }
    const policy = track(
      new ScriptPolicy(
        scripts({
          preCommand: [
            entry('monty'),
            entry('pyodide', 'b', { home: '/a' }),
            entry('pyodide', 'c', { home: '/a', maxMemory: '1G' }),
            entry('monty', 'd', { maxMemory: null }),
          ],
        }),
      ),
    )
    await policy.preCommand(ctx())
    expect(settings).toEqual([
      { maxMemory: '10M' },
      { maxMemory: '128M', home: '/a' },
      { maxMemory: '1G', home: '/a' },
      { maxMemory: null },
    ])
  })

  it('runs one program and throws what went wrong', async () => {
    const program = entry('monty', 'SOURCE 0', { slot: 0 })
    const routing = policyWith(
      'preExecute',
      new FakeProgram(answer({ kind: 'route', runtime: 'x' })),
    )
    expect(await routing.run(program, 'preExecute', line())).toEqual({
      kind: 'route',
      runtime: 'x',
    })
    const failing = policyWith('preExecute', new FakeProgram('', 3))
    await expect(failing.run(program, 'preExecute', line())).rejects.toThrow(/^exited 3$/)
  })

  it('builds a runtime once per name and settings, and closes it', async () => {
    const engines: FakeProgram[] = []
    built.factory = () => {
      const engine = new FakeProgram()
      engines.push(engine)
      return engine
    }
    const policy = track(
      new ScriptPolicy(
        scripts({
          preCommand: [
            entry('pyodide', 'a', { home: '/a' }),
            entry('pyodide', 'b', { home: '/a' }),
            entry('pyodide', 'c', { home: '/b' }),
          ],
        }),
      ),
    )
    await policy.preCommand(ctx())
    await policy.preCommand(ctx())
    expect(engines.map((engine) => engine.requests.length)).toEqual([4, 2])
    await policy.close()
    expect(engines.every((engine) => engine.closed)).toBe(true)
  })

  it('runs programs on two runtimes at once', async () => {
    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const engines: Record<string, FakeProgram> = {
      monty: new Waiting(started),
      pyodide: new Starting(start),
    }
    built.factory = (runtime) => engines[runtime]
    const policy = track(
      new ScriptPolicy({
        scriptsOf: (sessionId: string) => ({
          preCommand: [entry(sessionId === 's' ? 'monty' : 'pyodide')],
        }),
      }),
    )
    const answers = await Promise.all([
      policy.preCommand(ctx('cat', {}, 's')),
      policy.preCommand(ctx('cat', {}, 't')),
    ])
    expect(answers).toEqual([null, null])
  })

  it('never overlaps two runs on one runtime', async () => {
    const engine = new Overlapping()
    built.factory = () => engine
    const policy = track(new ScriptPolicy(scripts({ preCommand: [entry()] })))
    await Promise.all([
      policy.preCommand(ctx()),
      policy.preCommand(ctx()),
      policy.preCommand(ctx()),
    ])
    expect([engine.requests.length, engine.most]).toEqual([3, 1])
  })

  it('attaches the entry points it is wired to, and a bare policy none', async () => {
    const wired = new FakeProgram()
    built.factory = () => wired
    const bridge: BridgeDispatchFn = () => Promise.resolve(null)
    const resolver = new PrefixResolver(() => ['/repo/'])
    const policy = track(
      new ScriptPolicy(scripts({ preCommand: [entry()] }), { bridge: () => bridge, resolver }),
    )
    expect(await policy.preCommand(ctx())).toBeNull()
    expect(wired.attached?.resolver).toBe(resolver)
    const bare = new FakeProgram()
    built.factory = () => bare
    expect(
      await track(new ScriptPolicy(scripts({ preCommand: [entry()] }))).preCommand(ctx()),
    ).toBeNull()
    expect(bare.attached).toBeNull()
  })

  it('lets an op carrying its own token through, and judges every other', async () => {
    const engine = new FakeProgram(answer({ kind: 'deny', reason: 'frozen' }))
    built.factory = () => engine
    const stamped: symbol[] = []
    const policy = track(
      new ScriptPolicy(scripts({ preVfs: [entry()] }), {
        bridge: (issuer) => {
          stamped.push(issuer)
          return () => Promise.resolve(null)
        },
        resolver: new PrefixResolver(() => ['/repo/']),
      }),
    )
    expect(await policy.preVfs(opsCtx('read', '/repo/a', false))).toEqual([
      { kind: 'deny', reason: 'frozen' },
    ])
    const [token] = stamped
    if (token === undefined) throw new Error('the bridge was never built')
    expect(await policy.preVfs({ ...opsCtx('read', '/repo/a', false), issuer: token })).toBeNull()
    expect(engine.requests).toHaveLength(1)
  })

  it('says which sessions a method speaks for', async () => {
    const policy = track(
      new ScriptPolicy({
        scriptsOf: (id) => (id === 's' ? { preCommand: [entry()] } : {}),
      }),
    )
    expect(await policy.wantsFor('preCommand', 's')).toBe(true)
    expect(await policy.wantsFor('preVfs', 's')).toBe(false)
    expect(await policy.wantsFor('preCommand', 't')).toBe(false)
    expect(await policy.wantsFor('postVfs', 's')).toBe(false)
    const policies = new Policies([policy])
    expect(policies.wants('preSession')).toBe(true)
    expect(await policies.wantsFor('preSession', 's')).toBe(false)
    expect(await policies.wantsFor('preCommand', 's')).toBe(true)
  })

  it("starts a program in the session's directory", async () => {
    const engine = new FakeProgram()
    const policy = policyWith('preCommand', engine)
    await policy.preCommand(ctx('cat', { session: sessionView('/data') }))
    expect(engine.requests[0]?.cwd?.virtual).toBe('/data')
  })
})

// A program that asks about what an operand holds, not what it is called:
// the shape a content policy takes when it is a program.
const READER = `\
import json
import os

ctx = json.loads(os.environ['${CTX_ENV}'])
verdict = None
for p in ctx['paths']:
    try:
        body = open(p).read()
    except OSError:
        continue
    if 'payload' in body:
        verdict = {'kind': 'ask', 'reason': 'sign-off on payload'}
print(json.dumps(verdict))
`

/**
 * A read-only dispatcher over a few files, answering ENOENT for the rest. An
 * open lists the directory and stats the file before it reads, so the
 * dispatcher answers all three.
 */
function bridgeOver(files: Record<string, string>): BridgeDispatchFn {
  return (op, path) => {
    if (op === 'readdir') {
      const names = Object.keys(files).filter(
        (p) => p.startsWith(path) && !p.slice(path.length).includes('/'),
      )
      if (names.length === 0) {
        return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
      }
      return Promise.resolve(names)
    }
    const body = files[path]
    if (body === undefined) {
      return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
    }
    const content = ENCODE.encode(body)
    if (op === 'read') return Promise.resolve(content)
    if (op === 'stat') {
      return Promise.resolve(
        new FileStat({
          name: path,
          size: content.length,
          type: FileType.FILE,
          content: ContentType.TEXT,
        }),
      )
    }
    return Promise.reject(Object.assign(new Error(`${op} ${path}`), { code: 'EROFS' }))
  }
}

describe('a policy program on monty', () => {
  it('reads the workspace through the entry points it is wired to', async () => {
    const policy = track(
      new ScriptPolicy(scripts({ preCommand: [entry('monty', READER)] }), {
        bridge: () => bridgeOver({ '/repo/sealed/k': 'subject: invoice\n\na payload\n' }),
        resolver: new PrefixResolver(() => ['/repo/']),
      }),
    )
    expect(await policy.preCommand(ctx('cat'))).toEqual([
      { kind: 'ask', reason: 'sign-off on payload' },
    ])
  }, 60_000)

  it('reads no file when unwired, so nothing is judged on content it never saw', async () => {
    const policy = track(new ScriptPolicy(scripts({ preCommand: [entry('monty', READER)] })))
    expect(await policy.preCommand(ctx('cat'))).toBeNull()
  }, 60_000)
})
