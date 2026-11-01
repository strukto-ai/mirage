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
import type {
  AdmissionRules,
  CommandRule,
  Decision,
  Outcome,
  ProfileScript,
  ProfileScripts,
  Scope,
  ScriptMethod,
} from '../../policy/types.ts'
import type { Language } from '../../runtime/types.ts'
import { ScriptSource } from '../../runtime/types.ts'
import type { SecretRef } from '../../secrets/config.ts'
import { snakeToCamel } from '../../utils/normalize.ts'

export interface RuleJSON {
  reason: string
  commands?: string[]
  paths?: string[]
  mount?: string
}

export function ruleToDict(rule: CommandRule): RuleJSON {
  const out: RuleJSON = {
    reason: rule.reason,
    commands: [...(rule.commands ?? [])],
    paths: [...(rule.paths ?? [])],
  }
  if (rule.mount !== undefined && rule.mount !== '') out.mount = rule.mount
  return out
}

export function ruleFromDict(data: RuleJSON): CommandRule {
  return {
    reason: data.reason,
    commands: data.commands ?? [],
    paths: data.paths ?? [],
    mount: data.mount ?? '',
  }
}

export function commandsToDict(spec: AdmissionRules) {
  return {
    allow: spec.allow === null ? null : [...spec.allow],
    ask: spec.ask.map(ruleToDict),
    deny: spec.deny.map(ruleToDict),
  }
}

export function commandsFromDict(data: ReturnType<typeof commandsToDict>): AdmissionRules {
  return {
    allow: data.allow ?? null,
    ask: data.ask.map(ruleFromDict),
    deny: data.deny.map(ruleFromDict),
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
