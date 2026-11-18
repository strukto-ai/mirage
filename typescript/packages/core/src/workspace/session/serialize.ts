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

import { METHODS } from '../../policy/constants.ts'
import { commandTree, treeDoc } from '../../policy/profile.ts'
import {
  type AdmissionRules,
  type CommandRule,
  type Decision,
  Outcome,
  type ProfileScript,
  type ProfileScripts,
  type Scope,
  type ScriptMethod,
} from '../../policy/types.ts'
import type { Language } from '../../runtime/types.ts'
import { ScriptSource } from '../../runtime/types.ts'
import type { SecretRef } from '../../secrets/config.ts'
import { snakeToCamel } from '../../utils/normalize.ts'
import { OLDER_FORMAT } from './constants.ts'

export interface RuleJSON {
  reason: string
  decision?: string
  paths?: string[]
  at?: string
  mount?: string
  commands?: string[]
}

/** The rule an approval is keyed on, as the session record stores it. */
export function ruleToDict(rule: CommandRule): RuleJSON {
  const out: RuleJSON = { reason: rule.reason }
  const decision = rule.decision ?? Outcome.ASK
  if (decision !== Outcome.ASK) out.decision = decision
  out.paths = [...(rule.paths ?? [])]
  if (rule.at !== undefined && rule.at !== '') out.at = rule.at
  if (rule.mount !== undefined && rule.mount !== '') out.mount = rule.mount
  if ((rule.commands ?? []).length > 0) out.commands = [...(rule.commands ?? [])]
  return out
}

/** The rule an approval is keyed on, read back from a session record. */
export function ruleFromDict(data: RuleJSON): CommandRule {
  return {
    reason: data.reason,
    decision: (data.decision ?? Outcome.ASK) as Outcome,
    at: data.at ?? '',
    paths: data.paths ?? [],
    mount: data.mount ?? '',
    commands: data.commands ?? [],
  }
}

/** One command tree of a session record, with the mount it belongs to. */
export interface TreeJSON {
  mount: string
  commands: Record<string, unknown>
  inline?: boolean
}

/**
 * A session's command trees as the record stores them, each with the
 * mount it belongs to, under the `command_trees` field.
 */
export function commandsToDict(rules: AdmissionRules): TreeJSON[] {
  return rules.trees.map((scoped) => ({
    mount: scoped.mount,
    commands: treeDoc(scoped.tree),
    ...(scoped.inline ? { inline: true } : {}),
  }))
}

/**
 * A session's command trees read back from a record. A record written
 * before command trees holds flat `commands` lists and no
 * `command_trees`. Such a session comes back closed, every line denied,
 * so a restart never leaves it less restricted than it was; recreating
 * the session gives it its profile's trees. `flat` is the record's flat
 * `commands`, undefined for a record without them.
 */
export function commandsFromDict(
  data: readonly TreeJSON[] | undefined,
  flat?: unknown,
): AdmissionRules | null {
  if (data === undefined) return flat === undefined ? null : OLDER_FORMAT
  return {
    trees: data.map((entry) => ({
      tree: commandTree(entry.commands),
      mount: entry.mount,
      inline: entry.inline ?? false,
    })),
  }
}

/** One of a session's policy programs as the record stores it (the Python spelling). */
export interface ScriptJSON {
  profile: string
  language: string
  source: string
  runtime: string
  config?: Record<string, unknown>
  env?: Record<string, string | SecretRef>
}

export function scriptToDict(entry: ProfileScript): ScriptJSON {
  return {
    profile: entry.profile,
    language: entry.script.language,
    source: entry.script.source,
    runtime: entry.runtime,
    config: { ...entry.config },
    env: { ...entry.env },
  }
}

export function scriptFromDict(data: ScriptJSON): ProfileScript {
  return {
    profile: data.profile,
    script: new ScriptSource(data.source, data.language as Language),
    runtime: data.runtime,
    config: { ...(data.config ?? {}) },
    env: { ...(data.env ?? {}) },
  }
}

/** A session's policy programs as the record stores them, keyed by the document's method names. */
export function scriptsToDict(scripts: ProfileScripts): Record<string, ScriptJSON[]> {
  return Object.fromEntries(
    Object.entries(scripts).map(([method, entries]) => [
      METHODS[method as ScriptMethod],
      entries.map(scriptToDict),
    ]),
  )
}

/** A session's policy programs read back from a record, keyed by the document's method names. */
export function scriptsFromDict(data: Record<string, ScriptJSON[]>): ProfileScripts {
  return Object.fromEntries(
    Object.entries(data).map(([key, entries]) => [snakeToCamel(key), entries.map(scriptFromDict)]),
  )
}

/** A ledger record as the session record stores it (the Python spelling). */
export interface DecisionJSON {
  id: string
  session_id: string
  command: string
  argv: string[]
  cwd: string
  paths: string[]
  reason: string
  rule: RuleJSON
  outcome: string | null
  scope: string
  note: string
}

export function decisionToDict(record: Decision): DecisionJSON {
  return {
    id: record.id,
    session_id: record.sessionId,
    command: record.command,
    argv: [...record.argv],
    cwd: record.cwd,
    paths: [...record.paths],
    reason: record.reason,
    rule: ruleToDict(record.rule),
    outcome: record.outcome,
    scope: record.scope,
    note: record.note,
  }
}

export function decisionFromDict(data: DecisionJSON): Decision {
  return {
    id: data.id,
    sessionId: data.session_id,
    command: data.command,
    argv: data.argv,
    cwd: data.cwd,
    paths: data.paths,
    reason: data.reason,
    rule: ruleFromDict(data.rule),
    outcome: data.outcome !== null ? (data.outcome as Outcome) : null,
    scope: data.scope as Scope,
    note: data.note,
  }
}
