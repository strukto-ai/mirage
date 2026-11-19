// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { z, type util } from 'zod'
import { AdmissionRules, type ScopedTree } from '../policy/types.ts'
import { tree } from '../test-utils.ts'
import type { Visibility } from '../types.ts'
import { pathVisible } from '../utils/hidden.ts'
import { StreamRefusal } from './errors.ts'
import { units } from './document.ts'
import { admissionMatcher, Encoded, request, ruleTable, visibilityMatcher } from './policy.ts'
import { PosixRegex } from './regex.ts'
import { openStream, openStreamSync } from './stream.ts'

function hidden(paths: string[]): Visibility {
  return { paths: { paths, patterns: [] }, shown: null, vars: null, processes: 'session' }
}

describe('policy stream', () => {
  it('preserves shared composition transcripts through Wasm', () => {
    const corpus = z
      .object({
        cases: z.array(
          z.object({
            name: z.string(),
            input: z.record(z.string(), z.json()),
            effects: z.array(
              z.object({
                request: z.record(z.string(), z.json()),
                reply: z.record(z.string(), z.json()),
              }),
            ),
            expected: z.json(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          readFileSync(
            new URL('../../../../../integ/policy/composition.json', import.meta.url),
            'utf8',
          ),
        ),
      )
    expect(corpus.cases.length).toBeGreaterThan(0)
    for (const row of corpus.cases) {
      const stream = openStreamSync('policy_compose', {})
      try {
        expect(stream.feed(new TextEncoder().encode(JSON.stringify(row.input))).byteLength).toBe(0)
        expect(stream.finish().byteLength).toBe(0)
        for (const [index, effect] of row.effects.entries()) {
          const taken = stream.request()
          expect(taken, row.name).not.toBeNull()
          if (taken === null) throw new Error(row.name)
          const [header, data] = taken
          expect(header).toEqual({
            ...effect.request,
            evaluation: row.input.evaluation,
            effect: index + 1,
          })
          expect(data.byteLength).toBe(0)
          expect(stream.request()).toBeNull()
          expect(
            stream.respond(
              {
                ...effect.reply,
                evaluation: header.evaluation ?? null,
                effect: header.effect ?? null,
              },
              new Uint8Array(),
            ).byteLength,
          ).toBe(0)
        }
        expect(stream.request()).toBeNull()
        const output = stream.finish()
        expect(JSON.parse(new TextDecoder().decode(output)), row.name).toEqual(row.expected)
      } finally {
        stream.close()
      }
    }
  })
  it('shares one compiled matcher between equal visibilities', () => {
    expect(visibilityMatcher(hidden(['/secret']))).toBe(visibilityMatcher(hidden(['/secret'])))
    expect(visibilityMatcher(hidden(['/secret']))).not.toBe(visibilityMatcher(hidden(['/other'])))
  })

  it('answers for a rule set as it reads now', () => {
    const held: ScopedTree[] = []
    const rules: AdmissionRules = { trees: held }
    expect(admissionMatcher(rules).ask('runs', { name: units('rm') })).toBe(true)
    held.push({ tree: tree({ rm: 'deny' }), mount: '', inline: false })
    expect(admissionMatcher(rules).ask('runs', { name: units('rm') })).toBe(false)
  })

  it('numbers a changed rule set by the matcher that answers for it', () => {
    const held: ScopedTree[] = []
    const rules: AdmissionRules = { trees: held }
    expect(ruleTable(rules)).toEqual([])
    held.push({ tree: tree({ rm: 'deny' }), mount: '', inline: false })
    expect(ruleTable(rules).map((rule) => rule.at)).toEqual(['/rm/*'])
  })

  it('holds a built rule set as it was built, and finds its matcher by the object', () => {
    const held: ScopedTree[] = [{ tree: tree({ rm: 'deny' }), mount: '', inline: false }]
    const rules = new AdmissionRules(held)
    const matcher = admissionMatcher(rules)
    held.push({ tree: tree({ cat: 'deny' }), mount: '', inline: false })
    ;(held[0]?.tree.subcommands as Map<string, unknown>).clear()
    expect(rules.trees).toHaveLength(1)
    expect(admissionMatcher(rules)).toBe(matcher)
    expect(matcher.ask('runs', { name: units('rm') })).toBe(false)
    expect(matcher.ask('runs', { name: units('cat') })).toBe(true)
    expect(admissionMatcher(new AdmissionRules([...rules.trees]))).toBe(matcher)
  })

  it('refuses a change to a built rule set in place', () => {
    const scoped: ScopedTree = { tree: tree({ rm: 'deny' }), mount: '', inline: false }
    const rules = new AdmissionRules([scoped], new Set(['gh']))
    const root = rules.trees[0]?.tree
    expect(() => (rules.trees as ScopedTree[]).push(scoped)).toThrow(TypeError)
    expect(() => (root?.subcommands as Map<string, unknown>).delete('rm')).toThrow(TypeError)
    expect(() => (root?.subcommands as Map<string, unknown>).set('cat', root)).toThrow(TypeError)
    expect(() => (rules.unread as Set<string>).add('git')).toThrow(TypeError)
    expect(admissionMatcher(rules).ask('runs', { name: units('rm') })).toBe(false)
  })

  it('shares a rule table nobody can change between equal rule sets', () => {
    const built = () =>
      new AdmissionRules([
        { tree: tree({ rm: { decision: 'deny', paths: ['/a'] } }), mount: '', inline: false },
      ])
    const [first, second] = [built(), built()]
    const row = ruleTable(first)[0]
    if (row === undefined) throw new Error('expected one rule')
    expect(() => {
      row.reason = 'changed'
    }).toThrow(TypeError)
    expect(() => (row.paths as string[]).push('/b')).toThrow(TypeError)
    expect(ruleTable(second)[0]).toMatchObject({ reason: '', paths: ['/a'] })
  })

  it('keeps component depth and surrogate text', () => {
    const vis: Visibility = {
      paths: { paths: [], patterns: ['secret', '*.key'] },
      shown: { entries: [{ path: '/secret', mode: null }] },
      vars: null,
      processes: 'session',
    }
    expect(pathVisible(vis, '/secret/x')).toBe(true)
    expect(pathVisible(vis, '/\ud800.key')).toBe(false)
    expect(pathVisible(vis, '/\u{1f600}.key')).toBe(false)
  })

  it('keeps a link landing nonterminal and its hop limit terminal', () => {
    const matcher = visibilityMatcher(hidden(['/secret']))
    const traceHidden = (...trace: util.JSONType[]): boolean =>
      matcher.ask('link_trace_hidden', { trace }) === true
    expect(traceHidden({ landing: units('/secret') })).toBe(false)
    expect(
      traceHidden(
        { follow: units('/open') },
        { landing: units('/open') },
        { enter: { path: units('/secret'), next_is_parent: true } },
      ),
    ).toBe(true)
    expect(traceHidden({ follow: units('/open') }, 'hop_limit', { follow: units('/secret') })).toBe(
      false,
    )
    expect(traceHidden({ follow: units('/secret') }, 'hop_limit')).toBe(true)
  })

  it('refuses a bad request as a stream refusal', () => {
    expect(() => admissionMatcher(null).ask('no_such_op')).toThrow(StreamRefusal)
    expect(() =>
      admissionMatcher(null).ask('io_refusal', {
        walked: [{ tree: 0, branches: [] }],
        path: units('/x'),
        granted: [],
      }),
    ).toThrow('rule index is out of range')
  })

  it('opens its stream again after the shared instance retires', async () => {
    const matcher = visibilityMatcher(hidden(['/secret']))
    expect(matcher.ask('path_visible', { path: units('/secret/key') })).toBe(false)
    const regex = new PosixRegex('x$')
    const size = 34 * 1024 * 1024
    expect(await regex.search('a'.repeat(size) + 'x')).toEqual([[size, size + 1]])
    const stream = await openStream('base64', { mode: 'decode', ignore_garbage: false })
    stream.close()
    expect(matcher.ask('path_visible', { path: units('/secret/key') })).toBe(false)
    expect(matcher.ask('path_visible', { path: units('/public') })).toBe(true)
  })
})

describe('request', () => {
  it('places an encoded field as written', () => {
    const reads = new Encoded('[{"pattern":[114],"read":null}]')
    expect(JSON.parse(request('decide', { facts: { reads }, n: 1 }))).toEqual({
      op: 'decide',
      facts: { reads: [{ pattern: [114], read: null }] },
      n: 1,
    })
  })
})
