import { afterEach, describe, expect, it } from 'vitest'
import type { AdmissionRules } from '../policy/types.ts'
import { MountMode } from '../types.ts'
import { PosixRegex } from './regex.ts'
import { openStream } from './stream.ts'
import {
  AdmissionMatcher,
  VisibilityMatcher,
  admissionMatcher,
  closePolicyMatchers,
  compilePolicy,
  policyPatternMatches,
  policySplitPattern,
  restrictPolicy,
} from './policy.ts'

afterEach(closePolicyMatchers)

describe('native policy Wasm binding', () => {
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
