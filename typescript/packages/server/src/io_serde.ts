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

import { Buffer } from 'node:buffer'
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { classify, failureText } from '@struktoai/mirage-core/errors/classify'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import type {
  Ask,
  CommandExplanation,
  Deny,
  Route,
  ShellExplanation,
  ShellNode,
  VfsExplanation,
} from '@struktoai/mirage-core/policy/types'
import { FileStat, type JsonValue, type Refusal } from '@struktoai/mirage-core/types'
import type { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { BYTES, schemaOf, type Args, type VfsCall } from './vfs_calls.ts'

interface IoResultDict {
  kind: 'io'
  exit_code: number
  stdout: string
  stderr: string
  refusal: {
    kind: Refusal['kind']
    reason: string
    policy: string
    scope: Refusal['scope']
    ask_id: string | null
  } | null
}

interface RawResultDict {
  kind: 'raw'
  value: string
}

export type ResultDict = IoResultDict | RawResultDict

/** A refusal record as the server's doors carry it. Mirrors Python's `refusal_to_dict`. */
export function refusalToDict(refusal: Refusal | null): IoResultDict['refusal'] {
  return refusal === null
    ? null
    : {
        kind: refusal.kind,
        reason: refusal.reason,
        policy: refusal.policy,
        scope: refusal.scope,
        ask_id: refusal.askId,
      }
}

/**
 * A failed call as the server's doors carry it: its text, the errno it
 * names and, for a policy's refusal, its record. Mirrors Python's
 * `failure_to_dict`.
 */
export function failureToDict(err: unknown): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = { detail: failureText(err) }
  const condition = classify(err)
  if (condition !== null) body.errno = condition
  if (err instanceof PolicyDenied) body.refusal = refusalToDict(err.refusal)
  return body
}

export function ioResultToDict(result: unknown): ResultDict & JsonValue {
  if (result instanceof ExecuteResult) {
    return {
      kind: 'io',
      exit_code: result.exitCode,
      stdout: result.stdoutText,
      stderr: result.stderrText,
      refusal: refusalToDict(result.refusal),
    }
  }
  return { kind: 'raw', value: String(result) }
}

/** One policy's answer as the server's doors carry it. Mirrors Python's `answer_to_dict`. */
function answerToDict(action: Deny | Ask | Route): Record<string, JsonValue> {
  if (action.kind === 'route') {
    return { kind: 'route', runtime: action.runtime, policy: action.policy ?? '' }
  }
  return { kind: action.kind, reason: action.reason, policy: action.policy ?? '' }
}

/**
 * An explanation as the server's doors answer it: a line with its tree
 * (`shell` explained) or a VFS call (`vfs/<call>` explained). Mirrors Python's
 * `explanation_to_dict`.
 */
export function explanationToDict(
  expl: ShellExplanation | VfsExplanation | CommandExplanation,
): Record<string, JsonValue> {
  const verdict: Record<string, JsonValue> = {
    outcome: expl.outcome,
    reason: expl.reason,
    source: expl.source,
    refusal: refusalToDict(expl.refusal),
    answers: expl.answers.map(answerToDict),
  }
  if ('line' in expl) {
    return {
      line: expl.line,
      ...verdict,
      exit_code: expl.exitCode,
      stderr: expl.stderr,
      node: nodeToDict(expl.node),
    }
  }
  if ('call' in expl) {
    return { call: expl.call, paths: [...expl.paths], ...verdict, error: expl.error }
  }
  return {
    type: expl.type,
    text: expl.text,
    command: expl.command,
    argv: [...expl.argv],
    ...verdict,
    exit_code: expl.exitCode,
    stderr: expl.stderr,
    runtime: expl.runtime,
    operands: expl.operands.map((o) => ({ text: o.text, path: o.path, matched: o.matched })),
    children: expl.children.map(nodeToDict),
  }
}

/** One node of a line's tree as the doors carry it. Mirrors Python's `_node_to_dict`. */
function nodeToDict(node: ShellNode | CommandExplanation): Record<string, JsonValue> {
  if ('command' in node) return explanationToDict(node)
  return { type: node.type, text: node.text, children: node.children.map(nodeToDict) }
}

/** A VFS call's arguments do not fit its schema. Mirrors Python's `CallArgsError`. */
export class CallArgsError extends Error {}

/**
 * A VFS call's arguments, held to its schema, as its method takes them:
 * each `<name>_base64` decoded to the bytes `<name>` takes. Throws
 * `CallArgsError` when they do not fit. Mirrors Python's `checked`.
 */
export async function checked(call: VfsCall, params: unknown): Promise<Record<string, unknown>> {
  const result = await fromJsonSchema(schemaOf(call))['~standard'].validate(params)
  if (result.issues !== undefined) {
    const why = result.issues.map((issue) => issue.message).join('; ')
    throw new CallArgsError(`invalid arguments for vfs/${call.name}: ${why}`)
  }
  const args: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    if (call.params[name] !== BYTES) {
      args[name] = value
      continue
    }
    const text = String(value)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
      throw new CallArgsError(`${name} must be base64`)
    }
    args[name.replace(/_base64$/, '')] = new Uint8Array(Buffer.from(text, 'base64'))
  }
  return args
}

function toJson(value: unknown): JsonValue {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (value instanceof FileStat) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'extra')) as JsonValue
  }
  return value as JsonValue
}

/**
 * Run a VFS call as a session, or explain it, and answer it as JSON.
 * Mirrors Python's `answered`.
 */
export async function answered(
  session: Session,
  call: VfsCall,
  args: Args,
  explain: boolean,
): Promise<JsonValue> {
  if (explain) {
    return explanationToDict((await call.run(session.explain.vfs, args)) as VfsExplanation)
  }
  const result = await call.run(session.vfs, args)
  return call.answer === null ? {} : { [call.answer]: toJson(result) }
}
