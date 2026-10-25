import { afterEach, describe, expect, it } from 'vitest'
import type { AdmissionRules, CommandRule } from '../policy/types.ts'
import { MountMode, type Visibility } from '../types.ts'
import { PosixRegex } from './regex.ts'
import { openStream } from './stream.ts'
import type { LinkStep } from '../utils/path.ts'
import {
  AdmissionMatcher,
  VisibilityMatcher,
  admissionMatcher,
  closePolicyMatchers,
  compilePolicy,
  hiddenMatcher,
  policyPatternMatches,
  policySplitPattern,
  restrictPolicy,
  ruleMatcher,
  shownMatcher,
  varsMatcher,
  visibilityMatcher,
  type PolicyFacts,
} from './policy.ts'

afterEach(closePolicyMatchers)

const FACTS: PolicyFacts = {
  command: 'cat',
  tokens: ['cat'],
  tool: true,
  cwd: '/repo',
  paths: [],
  operands: [],
  walks: false,
  moveTarget: null,
}

function nativeNumber(fn: WebAssembly.ExportValue | undefined, args: number[]): number {
  if (typeof fn !== 'function') throw new Error('Missing export')
  const value: unknown = Reflect.apply(fn, undefined, args)
  if (typeof value !== 'number') throw new Error('Invalid native result')
  return value
}

function captureInstances(): {
  memories: WebAssembly.Memory[]
  requests: { operation: number; words: number }[]
  restore: () => void
} {
  const original = WebAssembly.Instance
  const memories: WebAssembly.Memory[] = []
  const requests: { operation: number; words: number }[] = []
  class ObservedInstance extends original {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      super(module, imports)
      const memory = super.exports.memory
      if (!(memory instanceof WebAssembly.Memory)) throw new Error('Missing memory')
      memories.push(memory)
    }
    override get exports(): WebAssembly.Exports {
      const exports = super.exports
      let words = 0
      return {
        ...exports,
        mirage_policy_input: (length: number) => {
          words = length
          return nativeNumber(exports.mirage_policy_input, [length])
        },
        mirage_policy_call: (operation: number, handle: number) => {
          requests.push({ operation, words })
          return nativeNumber(exports.mirage_policy_call, [operation, handle])
        },
      }
    }
  }
  WebAssembly.Instance = ObservedInstance
  return {
    memories,
    requests,
    restore: () => {
      WebAssembly.Instance = original
    },
  }
}

const LARGE = 'x'.repeat(2_000_000)

describe('bounded policy link packets', () => {
  it('counts the outer batch header below, at and above the soft target', () => {
    const tracked = captureInstances()
    const matcher = new VisibilityMatcher({ paths: { paths: ['/secret'] } })
    try {
      for (const delta of [-1, 0, 1]) {
        const start = tracked.requests.length
        expect(
          matcher.visibleLinks([
            ['/p', [{ kind: 'landing', path: 'x'.repeat(1024 * 1024 - 7 + delta) }]],
            ['', []],
            ['/secret', []],
          ]),
        ).toEqual([true, true, false])
        expect(
          tracked.requests
            .slice(start)
            .filter((request) => request.operation === 52)
            .map((request) => request.words),
        ).toEqual([1024 * 1024 + delta, 12])
      }
    } finally {
      matcher.close()
      tracked.restore()
    }
  })

  it('falls back when the outer batch header alone crosses the hard cap', () => {
    const tracked = captureInstances()
    const matcher = new VisibilityMatcher({})
    try {
      expect(
        matcher.visibleLinks([
          [
            '/p',
            [{ kind: 'hop_limit' }, { kind: 'landing', path: 'x'.repeat(16 * 1024 * 1024 - 7) }],
          ],
        ]),
      ).toEqual([true])
      expect(tracked.requests.filter((request) => request.operation !== 2)).toEqual([
        { operation: 42, words: 3 },
        { operation: 47, words: 3 },
      ])
    } finally {
      matcher.close()
      tracked.restore()
    }
  }, 30000)

  it('splits large candidate lists without changing their mask order', () => {
    const tracked = captureInstances()
    const matcher = new VisibilityMatcher({ paths: { paths: ['/secret'] } })
    const candidates: [string, LinkStep[]][] = Array.from({ length: 80000 }, (_, index) => [
      `/${index % 2 === 0 ? 'secret' : 'public'}/${String(index)}`,
      [],
    ])
    try {
      expect(matcher.visibleLinks(candidates)).toEqual(
        Array.from({ length: 80000 }, (_, index) => index % 2 !== 0),
      )
      const requests = tracked.requests.filter((request) => request.operation === 52)
      expect(requests.length).toBeGreaterThan(1)
      expect(Math.max(...requests.map((request) => request.words))).toBeLessThanOrEqual(1024 * 1024)
    } finally {
      matcher.close()
      tracked.restore()
    }
  }, 30000)

  it('supports a complete step above the soft target and sends exact bounded packets', () => {
    const tracked = captureInstances()
    const matcher = new VisibilityMatcher({ paths: { paths: ['/secret'] } })
    try {
      expect(
        matcher.linkTraceHidden([
          { kind: 'follow', path: '/open' },
          { kind: 'landing', path: 'x'.repeat(1024 * 1024) },
        ]),
      ).toBe(false)
      expect(
        tracked.requests
          .filter((request) => request.operation === 47)
          .map((request) => request.words),
      ).toEqual([9, 1024 * 1024 + 4])
    } finally {
      matcher.close()
      tracked.restore()
    }
  })

  it('counts hard-boundary Unicode words before querying even after a terminal fact', () => {
    const tracked = captureInstances()
    const matcher = new VisibilityMatcher({})
    const text = '\ud800' + '😀'.repeat(16 * 1024 * 1024 - 5)
    try {
      expect(
        matcher.linkTraceHidden([
          { kind: 'hop_limit' },
          { kind: 'landing', path: text.slice(0, -2) },
        ]),
      ).toBe(false)
      expect(
        matcher.linkTraceHidden([{ kind: 'hop_limit' }, { kind: 'landing', path: text }]),
      ).toBe(false)
      const before = tracked.requests.length
      expect(() =>
        matcher.linkTraceHidden([{ kind: 'hop_limit' }, { kind: 'landing', path: text + 'a' }]),
      ).toThrow('Policy packet is too large')
      expect(tracked.requests).toHaveLength(before)
      expect(
        tracked.requests
          .filter((request) => request.operation === 47)
          .map((request) => request.words),
      ).toEqual([3, 3])
    } finally {
      matcher.close()
      tracked.restore()
    }
  }, 30000)

  it('keeps fold state through multiple synchronous chunks and retires only after the result', async () => {
    const tracked = captureInstances()
    const hidden = { paths: ['/secret'] }
    const matcher = hiddenMatcher(hidden)
    const body = 'x'.repeat(3_000_000)
    try {
      expect(
        matcher.linkTraceHidden([
          { kind: 'follow', path: '/open' },
          { kind: 'landing', path: body },
          { kind: 'follow', path: '/secret' },
        ]),
      ).toBe(true)
      expect(matcher.live).toBe(true)
      expect(tracked.requests.filter((request) => request.operation === 47)).toHaveLength(3)
      expect(tracked.memories[0]?.buffer.byteLength).toBeGreaterThan(32 * 1024 * 1024)
      await Promise.resolve()
      expect(matcher.live).toBe(false)
      expect(hiddenMatcher(hidden).pathVisible('/secret')).toBe(false)
    } finally {
      tracked.restore()
    }
  })

  it('preserves terminal HopLimit and rejects unsupported later records before any query', () => {
    const tracked = captureInstances()
    const matcher = new VisibilityMatcher({ paths: { paths: ['/secret'] } })
    try {
      expect(
        matcher.linkTraceHidden([
          { kind: 'follow', path: '/open' },
          { kind: 'hop_limit' },
          { kind: 'landing', path: LARGE },
          { kind: 'follow', path: '/secret' },
        ]),
      ).toBe(false)
      expect(tracked.requests.filter((request) => request.operation === 47)).toHaveLength(1)
      const before = tracked.requests.length
      expect(() => {
        Reflect.apply(matcher.linkTraceHidden.bind(matcher), undefined, [
          [{ kind: 'hop_limit' }, { kind: 'invalid' }],
        ])
      }).toThrow('Invalid policy link step')
      expect(tracked.requests).toHaveLength(before)
    } finally {
      matcher.close()
      tracked.restore()
    }
  })

  it('keeps large batch and oversized-candidate results in their original order', () => {
    const tracked = captureInstances()
    const matcher = new VisibilityMatcher({ paths: { paths: ['/secret'] } })
    const trace: LinkStep[] = [
      { kind: 'follow', path: '/open' },
      ...Array.from({ length: 9 }, (): LinkStep => ({ kind: 'landing', path: LARGE })),
      { kind: 'follow', path: '/secret' },
    ]
    try {
      expect(
        matcher.visibleLinks([
          ['/before', []],
          ['/large', trace],
          ['/secret/child', []],
          ['/after', []],
        ]),
      ).toEqual([true, false, false, true])
      expect(tracked.requests.filter((request) => request.operation === 52)).toHaveLength(2)
      expect(tracked.requests.filter((request) => request.operation === 47).length).toBeGreaterThan(
        2,
      )
      expect(Math.max(...tracked.requests.map((request) => request.words))).toBeLessThanOrEqual(
        16 * 1024 * 1024,
      )
    } finally {
      matcher.close()
      tracked.restore()
    }
  }, 30000)
})

describe('policy memory retirement', () => {
  it('retires grown instances after yielding and preserves denials across repeated cycles', async () => {
    const tracked = captureInstances()
    const vis = { paths: { paths: ['/secret'] } }
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const matcher = hiddenMatcher(vis.paths)
        expect(matcher.pathVisible('/secret')).toBe(false)
        expect(policySplitPattern(LARGE)).toEqual([LARGE])
        expect(tracked.memories.at(-1)?.buffer.byteLength).toBeGreaterThan(32 * 1024 * 1024)
        expect(matcher.live).toBe(true)
        expect(matcher.pathVisible('/secret')).toBe(false)
        await Promise.resolve()
        expect(matcher.live).toBe(false)
        const fresh = hiddenMatcher(vis.paths)
        expect(fresh).not.toBe(matcher)
        expect(fresh.pathVisible('/secret')).toBe(false)
        expect(tracked.memories.at(-1)?.buffer.byteLength).toBeLessThan(32 * 1024 * 1024)
      }
      expect(tracked.memories).toHaveLength(3)
    } finally {
      tracked.restore()
    }
  })

  it('finishes oversized construction and its immediate query before retirement', async () => {
    const tracked = captureInstances()
    const path = `/${LARGE}`
    const hidden = { paths: [path] }
    try {
      const matcher = hiddenMatcher(hidden)
      expect(matcher.live).toBe(true)
      expect(matcher.pathVisible(path)).toBe(false)
      expect(tracked.memories[0]?.buffer.byteLength).toBeGreaterThan(32 * 1024 * 1024)
      await Promise.resolve()
      expect(matcher.live).toBe(false)
      expect(hiddenMatcher(hidden).pathVisible(path)).toBe(false)
      await Promise.resolve()
    } finally {
      tracked.restore()
    }
  })

  it('allows cache insertion and eviction to complete while retirement is queued', async () => {
    expect(policySplitPattern(LARGE)).toEqual([LARGE])
    let last = hiddenMatcher({ paths: ['/secret0'] })
    for (let index = 1; index <= 1024; index += 1)
      last = hiddenMatcher({ paths: [`/secret${String(index)}`] })
    expect(last.live).toBe(true)
    expect(last.pathVisible('/secret1024')).toBe(false)
    await Promise.resolve()
    expect(last.live).toBe(false)
    expect(hiddenMatcher({ paths: ['/secret1024'] }).pathVisible('/secret1024')).toBe(false)
  })

  it('keeps replacement instances and their queued retirement independent', async () => {
    const tracked = captureInstances()
    try {
      expect(policySplitPattern(LARGE)).toEqual([LARGE])
      closePolicyMatchers()
      const fresh = hiddenMatcher({ paths: ['/secret'] })
      expect(fresh.pathVisible('/secret')).toBe(false)
      await Promise.resolve()
      expect(fresh.live).toBe(true)
      expect(tracked.memories).toHaveLength(2)
      expect(policySplitPattern(LARGE)).toEqual([LARGE])
      closePolicyMatchers()
      const next = hiddenMatcher({ paths: ['/other'] })
      expect(policySplitPattern(LARGE)).toEqual([LARGE])
      expect(next.pathVisible('/other')).toBe(false)
      await Promise.resolve()
      expect(next.live).toBe(false)
      expect(hiddenMatcher({ paths: ['/other'] }).pathVisible('/other')).toBe(false)
      expect(tracked.memories).toHaveLength(4)
    } finally {
      tracked.restore()
    }
  })

  it('keeps ordinary small queries live across microtask boundaries', async () => {
    const matcher = hiddenMatcher({ paths: ['/secret'] })
    for (let index = 0; index < 3; index += 1) {
      expect(policySplitPattern('cat /public')).toEqual(['cat', '/public'])
      await Promise.resolve()
      expect(matcher.live).toBe(true)
      expect(matcher.pathVisible('/secret')).toBe(false)
    }
  })

  it('retires large typed failures without retrying the failed query', async () => {
    const tracked = captureInstances()
    const matcher = new AdmissionMatcher({ deny: [{ reason: 'private', paths: ['/secret'] }] })
    try {
      expect(() =>
        matcher.ruleApplies(999, { ...FACTS, tokens: Array<string>(5).fill(LARGE) }),
      ).toThrow('invalid policy rule index')
      expect(tracked.memories[0]?.buffer.byteLength).toBeGreaterThan(32 * 1024 * 1024)
      expect(matcher.live).toBe(true)
      expect(matcher.opRuling('read', '/secret', [])).toEqual([0, false])
      await Promise.resolve()
      expect(matcher.live).toBe(false)
      expect(tracked.memories).toHaveLength(1)
      expect(
        admissionMatcher({
          allow: null,
          deny: [{ reason: 'private', paths: ['/secret'] }],
          ask: [],
        }).opRuling('read', '/secret', []),
      ).toEqual([0, false])
      expect(tracked.memories).toHaveLength(2)
    } finally {
      tracked.restore()
    }
  })
})

describe('native policy Wasm binding', () => {
  it('rebuilds admission when allow is reassigned or an alias is replaced', () => {
    const allowed = ['cat']
    const rules: AdmissionRules = { allow: allowed, deny: [], ask: [] }
    expect(admissionMatcher(rules).headAllowed('cat')).toBe(true)
    allowed[0] = 'ls'
    expect(admissionMatcher(rules).headAllowed('cat')).toBe(false)
    expect(admissionMatcher(rules).headAllowed('ls')).toBe(true)
    rules.allow = []
    expect(admissionMatcher(rules).headAllowed('ls')).toBe(false)
  })

  it('rebuilds admission when deny and ask arrays change through aliases', () => {
    const deny: CommandRule[] = []
    const ask: CommandRule[] = []
    const rules: AdmissionRules = { allow: null, deny, ask }
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(0)
    ask.push({ reason: 'review', commands: ['cat'] })
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(2)
    deny.push({ reason: 'refuse', commands: ['cat'] })
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(1)
    deny[0] = { reason: 'other', commands: ['ls'] }
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(2)
    rules.ask = []
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(0)
  })

  it('rebuilds a rule when command aliases and mount fields change', () => {
    const commands = ['cat']
    const rule: CommandRule = { reason: 'review', commands, mount: '/repo' }
    expect(ruleMatcher(rule).ruleApplies(0, FACTS)).toBe(true)
    commands[0] = 'ls'
    expect(ruleMatcher(rule).ruleApplies(0, FACTS)).toBe(false)
    commands[0] = 'cat'
    rule.mount = '/other'
    expect(ruleMatcher(rule).ruleApplies(0, FACTS)).toBe(false)
  })

  it('rebuilds admission when a retained rule changes its commands and mount', () => {
    const commands = ['cat']
    const rule: CommandRule = { reason: 'refuse', commands, mount: '/repo' }
    const rules: AdmissionRules = { allow: null, deny: [rule], ask: [] }
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(1)
    commands[0] = 'ls'
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(0)
    commands[0] = 'cat'
    rule.mount = '/other'
    expect(admissionMatcher(rules).decide(FACTS).outcome).toBe(0)
  })

  it('rebuilds visibility when a nested path alias changes', () => {
    const paths: string[] = []
    const vis: Visibility = { paths: { paths }, shown: null, vars: null, processes: 'session' }
    expect(visibilityMatcher(vis).pathVisible('/secret')).toBe(true)
    paths.push('/secret')
    expect(visibilityMatcher(vis).pathVisible('/secret')).toBe(false)
    paths[0] = '/other'
    expect(visibilityMatcher(vis).pathVisible('/secret')).toBe(true)
  })

  it('rebuilds path scopes after same-length exact and pattern replacements', () => {
    const paths = ['/other']
    const patterns = ['*.tmp']
    const hidden = { paths, patterns }
    expect(hiddenMatcher(hidden).pathVisible('/secret')).toBe(true)
    paths[0] = '/secret'
    expect(hiddenMatcher(hidden).pathVisible('/secret')).toBe(false)
    expect(hiddenMatcher(hidden).pathVisible('/token.key')).toBe(true)
    patterns[0] = '*.key'
    expect(hiddenMatcher(hidden).pathVisible('/token.key')).toBe(false)
  })

  it('rebuilds shows and aggregate visibility after a mode alias changes', () => {
    const entry: { path: string; mode: MountMode } = { path: '/repo/out', mode: MountMode.WRITE }
    const shown = { entries: [entry] }
    const vis: Visibility = { paths: null, shown, vars: null, processes: 'session' }
    expect(shownMatcher(shown).shownMode('/repo/out')).toEqual([2, MountMode.WRITE])
    expect(visibilityMatcher(vis).effectiveMode('/repo/out', '/repo', MountMode.EXEC, null)).toBe(
      MountMode.WRITE,
    )
    entry.mode = MountMode.READ
    expect(shownMatcher(shown).shownMode('/repo/out')).toEqual([2, MountMode.READ])
    expect(visibilityMatcher(vis).effectiveMode('/repo/out', '/repo', MountMode.EXEC, null)).toBe(
      MountMode.READ,
    )
    entry.path = '/other'
    expect(shownMatcher(shown).shownMode('/repo/out')).toBeNull()
  })

  it('rebuilds variables and aggregate visibility after name and pattern edits', () => {
    const names = ['OTHER']
    const patterns = ['OLD_*']
    const vars = { names, patterns }
    const vis: Visibility = { paths: null, shown: null, vars, processes: 'session' }
    expect(varsMatcher(vars).varHidden('SECRET')).toBe(false)
    expect(visibilityMatcher(vis).varHidden('SECRET')).toBe(false)
    names[0] = 'SECRET'
    expect(varsMatcher(vars).varHidden('SECRET')).toBe(true)
    expect(visibilityMatcher(vis).varHidden('SECRET')).toBe(true)
    patterns[0] = 'NEW_*'
    expect(varsMatcher(vars).varHidden('NEW_KEY')).toBe(true)
    expect(visibilityMatcher(vis).varHidden('NEW_KEY')).toBe(true)
  })

  it.each([2 ** 32, -1, 0.5, NaN, Infinity])(
    'rejects invalid numeric packet values %s',
    (value) => {
      const matcher = new AdmissionMatcher({ ask: [{ reason: 'review', paths: ['/secret'] }] })
      try {
        expect(() => matcher.opRuling('write', '/secret', [value])).toThrow()
        expect(() => matcher.ruleApplies(value, FACTS)).toThrow()
      } finally {
        matcher.close()
      }
    },
  )

  it('preserves non-BMP and surrogate characters without JSON', () => {
    for (const name of ['snow\u{1f328}', 'lone\ud800', 'low\udfff']) {
      const matcher = new VisibilityMatcher({
        paths: { paths: [`/repo/${name}`] },
        vars: { patterns: [`${name}*`] },
      })
      try {
        expect(matcher.pathVisible(`/repo/${name}/child`)).toBe(false)
        expect(matcher.pathVisible(`/repo/${name}x`)).toBe(true)
        expect(matcher.varHidden(`${name}KEY`)).toBe(true)
      } finally {
        matcher.close()
      }
    }
    expect(policySplitPattern('git\ufeffpush')).toEqual(['git', 'push'])
    expect(policySplitPattern('git\u0085push')).toEqual(['git\u0085push'])
  })

  it('rebuilds restored component patterns with their original depth', () => {
    const matcher = new VisibilityMatcher({
      paths: { paths: [], patterns: ['secret'] },
      shown: { entries: [{ path: '/secret', mode: null }] },
    })
    try {
      expect(matcher.hideDepth('/secret/x')).toBe(0)
      expect(matcher.pathVisible('/secret/x')).toBe(true)
    } finally {
      matcher.close()
    }
  })

  it('passes long native text packets without a JS argument-count limit', () => {
    const token = 'a'.repeat(200_000)
    expect(policyPatternMatches(token, [token])).toBe(true)
    expect(policyPatternMatches(token, [token + 'b'])).toBe(false)
  })

  it('drops matchers on bounded cache eviction and rebuilds from ordinary rules', () => {
    const rules: AdmissionRules = { allow: ['cat'], deny: [], ask: [] }
    const before = admissionMatcher(rules)
    expect(admissionMatcher(rules)).toBe(before)
    for (let index = 0; index < 140; index += 1)
      admissionMatcher({ allow: [`tool${String(index)}`], deny: [], ask: [] })
    expect(before.live).toBe(false)
    expect(() => before.headAllowed('cat')).toThrow('Closed policy matcher')
    const after = admissionMatcher(rules)
    expect(after).not.toBe(before)
    expect(after.headAllowed('cat')).toBe(true)
    expect(after.headAllowed('rm')).toBe(false)
  })

  it('closes idempotently and rejects a retained handle after its instance resets', () => {
    const before = new AdmissionMatcher({ allow: [] })
    before.close()
    before.close()
    expect(() => before.hasRules()).toThrow('Closed policy matcher')
    const retained = new AdmissionMatcher({ allow: ['cat'] })
    closePolicyMatchers()
    expect(() => retained.headAllowed('cat')).toThrow('Closed policy matcher')
    const after = new AdmissionMatcher({ allow: ['ls'] })
    try {
      expect(after.headAllowed('ls')).toBe(true)
    } finally {
      after.close()
    }
  })

  it('keeps policy state valid after command-stream retirement', async () => {
    const matcher = new VisibilityMatcher({ paths: { paths: ['/secret'] } })
    const regex = new PosixRegex('x$')
    const size = 34 * 1024 * 1024
    try {
      expect(regex.search('a'.repeat(size) + 'x')).toEqual([[size, size + 1]])
      const stream = await openStream('base64', { mode: 'decode', ignore_garbage: false })
      stream.close()
      expect(matcher.pathVisible('/secret/key')).toBe(false)
      expect(matcher.pathVisible('/public')).toBe(true)
    } finally {
      matcher.close()
    }
  })

  it('compiles full mount and show-mode profiles and merges inline restrictions', () => {
    const base = {
      commands: { allow: ['cat', 'cp'], deny: [{ reason: 'root', paths: ['/private'] }] },
      paths: { hide: ['/repo'], show: [{ path: '/repo/public', mode: MountMode.WRITE }] },
      mounts: new Map([
        [
          '/repo',
          {
            mode: MountMode.READ,
            paths: { hide: ['*.key'] },
            commands: { ask: [{ reason: 'mount', commands: ['cat'] }] },
          },
        ],
      ]),
    }
    const plan = compilePolicy(base)
    expect(plan.commands?.ask[0]?.mount).toBe('/repo')
    expect(plan.visibility.paths?.patterns).toContain('/repo/*.key')
    expect(plan.visibility.shown?.entries).toEqual(base.paths.show)
    expect(plan.mountModes?.get('/repo')).toBe(MountMode.READ)
    const inline = {
      paths: { hide: ['/added', '/repo'] },
      mounts: new Map([['/repo', { mode: MountMode.WRITE, paths: { hide: ['*.pem'] } }]]),
    }
    const merged = restrictPolicy(base, inline)
    expect(merged?.paths?.hide).toEqual(['/repo', '/added'])
    expect(merged?.paths?.show).toEqual(base.paths.show)
    expect(merged?.mounts?.get('/repo')?.mode).toBe(MountMode.READ)
    expect(merged?.mounts?.get('/repo')?.paths?.hide).toEqual(['*.key', '*.pem'])
    expect(() => restrictPolicy(base, { commands: { allow: [] } })).toThrow('not an allow list')
    expect(() =>
      restrictPolicy(base, { paths: { hide: [], show: [{ path: '/added', mode: null }] } }),
    ).toThrow('not show entries')
  })
})
