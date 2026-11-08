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
import { decide } from '../policy/match/decide.ts'
import { CommandWord, Outcome, type AdmissionRules, type CommandRule } from '../policy/types.ts'
import { PathSpec, type Visibility } from '../types.ts'
import { WordKind } from '../commands/spec/types.ts'
import { pathVisible } from '../utils/hidden.ts'
import { StreamRefusal } from './errors.ts'
import { units } from './document.ts'
import { admissionMatcher, visibilityMatcher } from './policy.ts'
import { PosixRegex } from './regex.ts'
import { openStream, openStreamSync } from './stream.ts'

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: virtual,
    rawPath: virtual,
  })
}

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
  it("answers with the host's own rule objects", () => {
    const rule: CommandRule = { reason: 'review', paths: ['/repo/*'] }
    const rules: AdmissionRules = { allow: null, deny: [], ask: [rule] }
    const target = path('/repo/x')
    const ruling = decide(
      {
        command: 'cat',
        argv: ['/repo/x'],
        cwd: '/',
        paths: [target],
        words: [new CommandWord('/repo/x', WordKind.OPERAND, null, target)],
      },
      rules,
    )
    expect(ruling.outcome).toBe(Outcome.ASK)
    expect(ruling.rule).toBe(rule)
    expect(ruling.asks[0]).toBe(rule)
  })

  it('shares one compiled matcher between equal visibilities', () => {
    expect(visibilityMatcher(hidden(['/secret']))).toBe(visibilityMatcher(hidden(['/secret'])))
    expect(visibilityMatcher(hidden(['/secret']))).not.toBe(visibilityMatcher(hidden(['/other'])))
  })

  it('answers for a rule set as it reads now', () => {
    const deny: CommandRule[] = []
    const rules: AdmissionRules = { allow: null, ask: [], deny }
    expect(admissionMatcher(rules).ask('has_rules')).toBe(false)
    deny.push({ reason: 'no', commands: ['rm'] })
    expect(admissionMatcher(rules).ask('has_rules')).toBe(true)
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
    expect(() => admissionMatcher(null).ask('posix_level', { rule: 0 })).toThrow(
      'policy rule index is out of range',
    )
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
