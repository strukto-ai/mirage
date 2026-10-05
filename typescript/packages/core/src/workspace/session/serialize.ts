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

import type {
  CommandRule,
  AdmissionRules,
  Decision,
  Outcome,
  ProfileScript,
} from '../../policy/types.ts'
import type { Scope } from '../../policy/types.ts'
import { ScriptSource } from '../../runtime/types.ts'
import type { RuntimeLanguage } from '../../runtime/types.ts'

/** A compiled command tier as the session record stores it (the Python spelling). */
export interface CommandsJSON {
  allow: string[] | null
  ask: RuleJSON[]
  deny: RuleJSON[]
}

export interface RuleJSON {
  reason: string
  commands?: string[]
  paths?: string[]
  mount?: string
}

export function ruleToJSON(rule: CommandRule): RuleJSON {
  const out: RuleJSON = {
    reason: rule.reason,
    commands: [...(rule.commands ?? [])],
    paths: [...(rule.paths ?? [])],
  }
  if (rule.mount !== undefined && rule.mount !== '') out.mount = rule.mount
  return out
}

export function ruleFromJSON(data: RuleJSON): CommandRule {
  return {
    reason: data.reason,
    commands: data.commands ?? [],
    paths: data.paths ?? [],
    mount: data.mount ?? '',
  }
}

export function commandsToJSON(spec: AdmissionRules): CommandsJSON {
  return {
    allow: spec.allow === null ? null : [...spec.allow],
    ask: spec.ask.map(ruleToJSON),
    deny: spec.deny.map(ruleToJSON),
  }
}

export function commandsFromJSON(data: CommandsJSON): AdmissionRules {
  return {
    allow: data.allow ?? null,
    ask: data.ask.map(ruleFromJSON),
    deny: data.deny.map(ruleFromJSON),
  }
}

/** A session's profile script as the record stores it (the Python spelling). */
export interface ScriptJSON {
  profile: string
  language: string
  source: string
  runtime: string
}

export function scriptToJSON(entry: ProfileScript): ScriptJSON {
  return {
    profile: entry.profile,
    language: entry.script.language,
    source: entry.script.source,
    runtime: entry.runtime,
  }
}

export function scriptFromJSON(data: ScriptJSON): ProfileScript {
  return {
    profile: data.profile,
    script: new ScriptSource(data.source, data.language as RuntimeLanguage),
    runtime: data.runtime,
  }
}

/** A ledger record as the session record stores it (the Python spelling). */
export interface DecisionJSON {
  id: string
  session_id: string
  agent_id: string
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

export function decisionToJSON(record: Decision): DecisionJSON {
  return {
    id: record.id,
    session_id: record.sessionId,
    agent_id: record.agentId,
    command: record.command,
    argv: [...record.argv],
    cwd: record.cwd,
    paths: [...record.paths],
    reason: record.reason,
    rule: ruleToJSON(record.rule),
    outcome: record.outcome,
    scope: record.scope,
    note: record.note,
  }
}

export function decisionFromJSON(data: DecisionJSON): Decision {
  return {
    id: data.id,
    sessionId: data.session_id,
    agentId: data.agent_id,
    command: data.command,
    argv: data.argv,
    cwd: data.cwd,
    paths: data.paths,
    reason: data.reason,
    rule: ruleFromJSON(data.rule),
    outcome: data.outcome !== null ? (data.outcome as Outcome) : null,
    scope: data.scope as Scope,
    note: data.note,
  }
}
