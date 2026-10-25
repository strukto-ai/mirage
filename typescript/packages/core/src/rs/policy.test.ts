import { afterEach, describe, expect, it } from 'vitest'
import type { AdmissionRules, CommandRule } from '../policy/types.ts'
import { MountMode, type Visibility } from '../types.ts'
import { PosixRegex } from './regex.ts'
import { openStream } from './stream.ts'
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
