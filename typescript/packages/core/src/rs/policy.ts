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
import { DEFAULT_ASK_REASON } from '../policy/constants.ts'
import {
  AdmissionRules,
  type CommandNode,
  type CommandRule,
  type OptionRule,
  Outcome,
  type RuleLeaf,
} from '../policy/types.ts'
import type { MountMode, ProcessScope, Visibility } from '../types.ts'
import type { LinkStep } from '../utils/path.ts'
import { fromUnits, units } from './document.ts'
import { MovableStream } from './stream.ts'

export type Wire = Record<string, util.JSONType>

export const CACHE_SIZE = 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function open(config: Readonly<Wire>): MovableStream {
  return new MovableStream('policy', config)
}

/**
 * A request field already encoded as JSON, which `ask` places as written:
 * a value asked about on every line, such as the reads of the patterns on
 * a command, is encoded once. Mirrors Python's Encoded.
 */
export class Encoded {
  constructor(readonly text: string) {}
}

/** One request's JSON, each `Encoded` field placed as written. Mirrors Python's request. */
export function request(
  op: string,
  args: Readonly<
    Record<string, util.JSONType | Encoded | Readonly<Record<string, util.JSONType | Encoded>>>
  >,
): string {
  const held: string[] = []
  const place = (value: util.JSONType | Encoded): util.JSONType => {
    if (!(value instanceof Encoded)) return value
    held.push(value.text)
    return `\u0000${String(held.length - 1)}\u0000`
  }
  const fields: Record<string, util.JSONType> = { op }
  for (const [key, value] of Object.entries(args)) {
    fields[key] =
      value instanceof Encoded ||
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
        ? place(value as util.JSONType | Encoded)
        : Object.fromEntries(
            Object.entries(value as Readonly<Record<string, util.JSONType | Encoded>>).map(
              ([inner, field]) => [inner, place(field)],
            ),
          )
  }
  const text = JSON.stringify(fields)
  return held.reduce(
    (out, raw, at) => out.replace(`"\\u0000${String(at)}\\u0000"`, () => raw),
    text,
  )
}

/**
 * A profile's rules and visibility, compiled once by mirage-rs's `policy`
 * stream and asked one request at a time. Mirrors Python's PolicyMatcher.
 */
export class PolicyMatcher {
  private readonly stream: MovableStream
  private table: readonly CommandRule[] | null = null

  constructor(config: Readonly<Wire>) {
    this.stream = open(config)
  }

  /**
   * Every leaf of the compiled trees as the rule a ruling names, in the
   * order the stream numbers them, read once. An ask with no reason reads
   * as the default one; a deny's stays empty, since what its refusal names
   * depends on the line (`reasonOf`).
   */
  rules(): readonly CommandRule[] {
    this.table ??= Object.freeze(
      (this.ask('rules') as readonly RuleRow[]).map((row): CommandRule => {
        const reason = fromUnits(row.reason)
        return {
          reason: reason === '' && row.decision === Outcome.ASK ? DEFAULT_ASK_REASON : reason,
          decision: row.decision,
          at: fromUnits(row.at),
          paths: row.paths.map(fromUnits),
          mount: row.mount === null ? '' : fromUnits(row.mount),
        }
      }),
    )
    return this.table
  }

  /** The answer to one request, decoded from its JSON; text travels as code points. */
  ask(op: string, args: Parameters<typeof request>[1] = {}): unknown {
    const stream = this.stream.live
    stream.feed(encoder.encode(request(op, args)))
    return JSON.parse(decoder.decode(stream.finish()))
  }
}

function leavesWire(leaves: readonly RuleLeaf[]): util.JSONType[] {
  return leaves.map((leaf) => ({
    decision: leaf.decision,
    reason: units(leaf.reason),
    paths: leaf.paths.map(units),
  }))
}

function optionWire(rule: OptionRule): Wire {
  return {
    decision: leavesWire(rule.decision),
    values: [...rule.values].map(([word, value]) => [
      units(word),
      {
        decision: leavesWire(value.decision),
        options: [...value.options].map(([name, option]) => [units(name), optionWire(option)]),
      },
    ]),
    options: [...rule.options].map(([name, option]) => [units(name), optionWire(option)]),
  }
}

/**
 * A command tree in the stream's wire shape: each map a list of pairs,
 * text as code points. Mirrors Python's tree_wire.
 */
export function treeWire(node: CommandNode): Wire {
  return {
    decision: leavesWire(node.decision),
    subcommands: [...node.subcommands].map(([name, child]) => [units(name), treeWire(child)]),
    options: [...node.options].map(([name, option]) => [units(name), optionWire(option)]),
    other_options: leavesWire(node.otherOptions),
    operands: [...node.operands].map(([word, child]) => [units(word), treeWire(child)]),
  }
}

/** A session's command trees in the stream's wire shape. Mirrors Python's rules_wire. */
export function rulesWire(rules: AdmissionRules): Wire {
  return {
    trees: rules.trees.map((scoped) => ({
      mount: scoped.mount === '' ? null : units(scoped.mount),
      root: treeWire(scoped.tree),
    })),
  }
}

interface RuleRow {
  readonly decision: Outcome
  readonly reason: number[]
  readonly at: number[]
  readonly paths: number[][]
  readonly mount: number[] | null
}

/**
 * Every leaf of a session's trees as the rule a ruling names, in the
 * order the stream numbers them: the table of the matcher compiled for
 * the rule set (`PolicyMatcher.rules`), so the two never disagree.
 * Mirrors Python's rule_table.
 */
export function ruleTable(rules: AdmissionRules): readonly CommandRule[] {
  return admissionMatcher(rules).rules()
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

const compiled = new WeakMap<AdmissionRules, PolicyMatcher>()

/**
 * The compiled matcher for a rule set, shared by every caller asking the
 * same; null answers the requests no profile scopes. An `AdmissionRules`
 * cannot change in place, so its matcher is found by the object itself
 * and its trees are read once; a rule set written by hand may change, so
 * it is read on every call and answered as it reads now. Mirrors
 * Python's admission_matcher.
 */
export function admissionMatcher(rules: AdmissionRules | null): PolicyMatcher {
  const held = rules instanceof AdmissionRules ? compiled.get(rules) : undefined
  if (held !== undefined) return held
  const key = JSON.stringify({ rules }, (_key, value: unknown) =>
    value instanceof Map ? [...(value as Map<unknown, unknown>)] : value,
  )
  const matcher = cached(key, () => (rules === null ? {} : { rules: rulesWire(rules) }))
  if (rules instanceof AdmissionRules) compiled.set(rules, matcher)
  return matcher
}

/** The compiled matcher for a visibility, shared by every caller asking the same. Mirrors Python's visibility_matcher. */
export function visibilityMatcher(vis: Visibility | null): PolicyMatcher {
  return cached(JSON.stringify({ visibility: vis }), () =>
    vis === null ? {} : { visibility: visibilityWire(vis) },
  )
}
