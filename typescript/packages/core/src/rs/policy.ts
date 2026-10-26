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

import type { util } from 'zod'
import type { AdmissionRules, CommandRule } from '../policy/types.ts'
import type { MountMode, ProcessScope, Visibility } from '../types.ts'
import type { LinkStep } from '../utils/path.ts'
import { MovableStream } from './stream.ts'

export type Wire = Record<string, util.JSONType>

const CACHE_SIZE = 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function open(config: Readonly<Wire>): MovableStream {
  return new MovableStream('policy', { ...config, dialect: 'ecmascript' })
}

/**
 * A profile's rules and visibility, compiled once by mirage-rs's `policy`
 * stream and asked one request at a time. Mirrors Python's PolicyMatcher.
 */
export class PolicyMatcher {
  private readonly stream: MovableStream

  constructor(config: Readonly<Wire>) {
    this.stream = open(config)
  }

  /** The answer to one request, decoded from its JSON; text travels as code points. */
  ask(op: string, args: Readonly<Wire> = {}): unknown {
    const stream = this.stream.live
    stream.feed(encoder.encode(JSON.stringify({ op, ...args })))
    return JSON.parse(decoder.decode(stream.finish()))
  }
}

/** Text as the code points the stream reads, lone surrogates kept. Mirrors Python's units. */
export function units(value: string): number[] {
  return Array.from(value, (ch) => ch.codePointAt(0) ?? 0)
}

/** Code points from the stream back as text. Mirrors Python's from_units. */
export function fromUnits(value: readonly number[]): string {
  let out = ''
  for (let at = 0; at < value.length; at += 4096)
    out += String.fromCodePoint(...value.slice(at, at + 4096))
  return out
}

/** One rule in the stream's wire shape. Mirrors Python's rule_wire. */
export function ruleWire(rule: CommandRule): Wire {
  return {
    reason: units(rule.reason),
    commands: (rule.commands ?? []).map(units),
    paths: (rule.paths ?? []).map(units),
    mount: rule.mount === undefined ? null : units(rule.mount),
  }
}

/** A rule set in the stream's wire shape. Mirrors Python's rules_wire. */
export function rulesWire(rules: Partial<AdmissionRules>): Wire {
  return {
    allow: rules.allow == null ? null : rules.allow.map(units),
    deny: (rules.deny ?? []).map(ruleWire),
    ask: (rules.ask ?? []).map(ruleWire),
  }
}

/** A session's visibility in the stream's wire shape. Mirrors Python's visibility_wire. */
export function visibilityWire(vis: Visibility): Wire {
  return {
    hidden:
      vis.paths === null
        ? {}
        : {
            paths: (vis.paths.paths ?? []).map(units),
            patterns: (vis.paths.patterns ?? []).map(units),
          },
    shown: (vis.shown?.entries ?? []).map((entry) => ({
      path: units(entry.path),
      mode: entry.mode,
    })),
    vars:
      vis.vars === null
        ? {}
        : {
            names: (vis.vars.names ?? []).map(units),
            patterns: (vis.vars.patterns ?? []).map(units),
          },
  }
}

/** A compiled visibility from the stream's wire shape. Mirrors Python's visibility_from. */
export function visibilityFrom(
  value: {
    readonly hidden: { readonly paths: number[][]; readonly patterns: number[][] }
    readonly shown: readonly { readonly path: number[]; readonly mode: MountMode | null }[]
    readonly vars: { readonly names: number[][]; readonly patterns: number[][] }
  },
  processes: ProcessScope = 'session',
): Visibility {
  const { hidden, shown, vars } = value
  return {
    paths:
      hidden.paths.length + hidden.patterns.length === 0
        ? null
        : { paths: hidden.paths.map(fromUnits), patterns: hidden.patterns.map(fromUnits) },
    shown:
      shown.length === 0
        ? null
        : { entries: shown.map((entry) => ({ path: fromUnits(entry.path), mode: entry.mode })) },
    vars:
      vars.names.length + vars.patterns.length === 0
        ? null
        : { names: vars.names.map(fromUnits), patterns: vars.patterns.map(fromUnits) },
    processes,
  }
}

/** A symlink walk's steps in the stream's wire shape. Mirrors Python's link_trace_wire. */
export function linkTraceWire(trace: readonly LinkStep[]): util.JSONType[] {
  return trace.map((step): util.JSONType => {
    switch (step.kind) {
      case 'follow':
        return { follow: units(step.path) }
      case 'enter':
        return { enter: { path: units(step.path), next_is_parent: step.nextIsParent } }
      case 'landing':
        return { landing: units(step.path) }
      case 'hop_limit':
        return 'hop_limit'
    }
  })
}

const byValue = new Map<string, PolicyMatcher>()

// One matcher per configuration as its JSON reads now, however many
// objects spell it, the least recently asked dropped first; the wire is
// built only for a configuration not seen yet.
function cached(text: string, config: () => Wire): PolicyMatcher {
  const matcher = byValue.get(text) ?? new PolicyMatcher(config())
  byValue.delete(text)
  byValue.set(text, matcher)
  if (byValue.size > CACHE_SIZE) {
    const oldest = byValue.keys().next()
    if (oldest.done !== true) byValue.delete(oldest.value)
  }
  return matcher
}

/**
 * The compiled matcher for a rule set, shared by every caller asking the
 * same; null answers the requests no profile scopes. Mirrors Python's
 * admission_matcher.
 */
export function admissionMatcher(rules: AdmissionRules | null): PolicyMatcher {
  return cached(JSON.stringify({ rules }), () =>
    rules === null ? {} : { rules: rulesWire(rules) },
  )
}

/** The compiled matcher for a visibility, shared by every caller asking the same. Mirrors Python's visibility_matcher. */
export function visibilityMatcher(vis: Visibility | null): PolicyMatcher {
  return cached(JSON.stringify({ visibility: vis }), () =>
    vis === null ? {} : { visibility: visibilityWire(vis) },
  )
}
