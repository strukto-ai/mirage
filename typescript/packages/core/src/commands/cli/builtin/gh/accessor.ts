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

import {
  GITHUB_API_BASE,
  HttpGitHubTransport,
  type GitHubTransport,
} from '../../../../core/github/client.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { parseRepo, repoHost, type RepoRef } from '../../../../core/github/repo.ts'
import { jqRaised, jqRun, type JqRun } from '../../../../core/jq/index.ts'
import { PartialOutputError, UsageError } from '../../../errors.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import { fsStrerror, isEnoent, isEnotdir } from '../../../../errors/fs.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { CONNECT_HINT, GITHUB_HOST, GOJQ_RAISED } from './constants.ts'

const ENC = new TextEncoder()

export function ghTransport(config: unknown): GitHubTransport {
  const cfg = config as GhConfig
  const opts: { token: string; baseUrl?: string } = { token: cfg.token }
  if (cfg.baseUrl !== undefined) opts.baseUrl = cfg.baseUrl
  return new HttpGitHubTransport(opts)
}

/**
 * Refuse a repository on a host this install cannot reach. Real gh sends the
 * request to whatever host a repository argument names; this one answers
 * github.com, whose subdomains go-gh reads as github.com, and the host its
 * `baseUrl` names. Any other host is one it cannot connect to, and it says so
 * in gh's words (pinned against gh 2.85.0) rather than asking its own host for
 * a repository of the same name.
 */
export function checkHost(config: unknown, host: string | null): void {
  if (host === null) return
  const name = host.toLowerCase()
  if (name === GITHUB_HOST || name.endsWith(`.${GITHUB_HOST}`)) return
  const base = (config as GhConfig).baseUrl
  if (base !== undefined && URL.canParse(base) && new URL(base).hostname === name) return
  throw new Error(`error connecting to ${name}\n${CONNECT_HINT}`)
}

/**
 * The origin the install's GitHub serves its pages and git from: github.com
 * for GitHub's own API, else the API host's own origin, as a GitHub Enterprise
 * server and a local stand-in serve them.
 */
export function webOrigin(config: GhConfig): string {
  const base = config.baseUrl
  if (base === undefined || base.replace(/\/+$/, '') === GITHUB_API_BASE) {
    return `https://${GITHUB_HOST}`
  }
  return new URL(base).origin
}

/**
 * The repository a line is about: the operand if it named one, the
 * install's own otherwise. gh resolves this from the current git remote,
 * which a workspace has no equivalent of, so the config carries it.
 */
export function ghRepo(config: unknown, spec: string | undefined): RepoRef {
  const named = spec ?? (config as GhConfig).repo
  if (named === undefined || named === '') {
    throw new Error('no repository given; pass one or set `repo` on the install')
  }
  const ref = parseRepo(named)
  checkHost(config, repoHost(named))
  return ref
}

// gh's exporter writes with Go's encoding/json, which escapes U+2028 and
// U+2029 where JSON.stringify writes them raw. Every other character comes
// out the same (Go 1.22 and later spell \b and \f short, as JSON.stringify
// does), `<`, `>` and `&` raw too, since gh turns HTML escaping off.
const SEPARATORS = /[\u{2028}\u{2029}]/gu

/** One value as gh's exporter prints it: Go's compact JSON. */
function goJson(value: unknown): string {
  return JSON.stringify(value).replace(
    SEPARATORS,
    (separator) => `\\u${separator.charCodeAt(0).toString(16)}`,
  )
}

/**
 * `--json` output as gh writes it where stdout is not a terminal, which in a
 * workspace it never is: one compact line.
 */
export function jsonOut(value: unknown): CommandFnResult {
  const text = value === null ? '' : `${goJson(value)}\n`
  const out: ByteSource = ENC.encode(text)
  return [out, new IOResult()]
}

export function textOut(text: string): CommandFnResult {
  const out: ByteSource = ENC.encode(text)
  return [out, new IOResult()]
}

/** Whether a gh boolean flag is on: given bare, or as `=true`. */
export function ghBool(fl: FlagView, name: string): boolean {
  return fl.asBool(name) || fl.asStr(name) === 'true'
}

export function repoFor(inv: CLIInvocation, fl: FlagView): RepoRef {
  return ghRepo(inv.config, fl.asStr('repo') ?? undefined)
}

export function repoNumber(
  inv: CLIInvocation,
  fl: FlagView,
  value: string | undefined,
  label: string,
  urlKind: 'issues' | 'pull',
): [RepoRef, number] {
  const raw = value ?? ''
  if (/^\d+$/.test(raw)) return [repoFor(inv, fl), Number(raw)]
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(raw)
  if (match?.[3] !== urlKind) throw new Error(`a ${label} number is required`)
  checkHost(inv.config, new URL(raw).hostname)
  return [parseRepo(`${match[1] ?? ''}/${match[2] ?? ''}`), Number(match[4])]
}

export function csvValues(values: readonly string[]): string[] {
  return values.flatMap((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

export async function readCliFile(
  inv: CLIInvocation,
  raw: FlagValue,
  option: string,
): Promise<Uint8Array> {
  if (!(raw instanceof PathSpec) && typeof raw !== 'string') {
    throw new Error(`${option} expects a file`)
  }
  const path = raw instanceof PathSpec ? raw.rawPath : raw
  if (path === '-') {
    if (inv.stdin === null) throw new Error(`${option} needs standard input`)
    return materialize(inv.stdin)
  }
  const dispatch = inv.doors?.dispatch
  if (dispatch === undefined) throw new Error(`${option} needs a workspace to read files from`)
  const spec = PathSpec.fromStrPath(raw, undefined, inv.env.PWD ?? '/')
  try {
    const [data] = await dispatch('read', spec)
    return await materialize(data as ByteSource)
  } catch (err) {
    const strerror = isEnoent(err) || isEnotdir(err) ? fsStrerror(err) : null
    if (strerror !== null) throw new Error(`read ${path}: ${strerror}`)
    throw err
  }
}

export async function bodyValue(
  inv: CLIInvocation,
  fl: FlagView,
  opts: { value?: string; file?: string; required?: boolean } = {},
): Promise<string | undefined> {
  const value = opts.value ?? 'body'
  const file = opts.file ?? 'body_file'
  const inline = fl.asStr(value)
  const source = fl.raw(file)
  const valueFlag = `--${value.replaceAll('_', '-')}`
  const fileFlag = `--${file.replaceAll('_', '-')}`
  if (inline !== undefined && source !== undefined) {
    throw new UsageError(`${valueFlag} and ${fileFlag} are mutually exclusive`)
  }
  if (inline !== undefined) return inline
  if (source !== undefined)
    return new TextDecoder().decode(await readCliFile(inv, source, fileFlag))
  if (opts.required === true) throw new Error(`${valueFlag} or ${fileFlag} is required`)
  return undefined
}

function camelKey(key: string): string {
  const [head = '', ...tail] = key.split('_')
  return head + tail.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join('')
}

export function camel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camel)
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) result[camelKey(key)] = camel(item)
  if ('htmlUrl' in result) {
    result.url = result.htmlUrl
    delete result.htmlUrl
  }
  if ('user' in result) {
    result.author = result.user
    delete result.user
  }
  return result
}

export function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

// Go's json.Marshal escapes <, > and & for HTML and U+2028 and U+2029 for
// JavaScript on top of the escapes JSON.stringify shares with it; gojq's own
// encoder escapes none of them, but does escape DEL.
const MARSHAL_ESCAPES = /[<>&\u{2028}\u{2029}]/gu

/**
 * A number as Go's JSON encoders, gojq's among them, write a float64, which is
 * how ES6 spells it: the shortest digits that read back the same, in exponent
 * form below 1e-6 and from 1e21 on, anything past the largest finite float at
 * that float.
 */
function goNumber(number: number): string {
  return String(Math.min(Math.max(number, -Number.MAX_VALUE), Number.MAX_VALUE))
}

/** A string as Go's json.Marshal writes it. */
function marshalString(text: string): string {
  return JSON.stringify(text).replace(
    MARSHAL_ESCAPES,
    (escaped) => `\\u${escaped.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** A string as gojq's encoder writes it into an error. */
function gojqString(text: string): string {
  return JSON.stringify(text).replace(/\x7f/g, '\\u007f')
}

/**
 * A decoded JSON value as Go writes it back out: compact, object keys sorted
 * as a Go map's are, every number a float64 (see goNumber) and every string as
 * `quote` writes it.
 */
function goEncoded(value: unknown, quote: (text: string) => string): string {
  if (Array.isArray(value)) return `[${value.map((item) => goEncoded(item, quote)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const pairs = Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => `${quote(key)}:${goEncoded(record[key], quote)}`)
    return `{${pairs.join(',')}}`
  }
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number') return goNumber(value)
  return JSON.stringify(value)
}

/**
 * A number as go-gh prints a float64 on its own line: in fixed notation, with
 * no decimals when it is whole and two otherwise, rounded half to even as
 * strconv rounds. An infinity jq-wasm hands over counts as the largest finite
 * float, which is what jq.py hands over for one.
 */
function fixedNumber(number: number): string {
  const finite = Math.min(Math.max(number, -Number.MAX_VALUE), Number.MAX_VALUE)
  if (Number.isInteger(finite)) return BigInt(finite).toString()
  const text = finite.toFixed(2)
  // toFixed breaks an exact tie away from zero where strconv breaks it to
  // the even digit, and a number ties at two places exactly when its eighths
  // are odd.
  const eighths = finite * 8
  const last = Number(text.slice(-1))
  if (Number.isInteger(eighths) && eighths % 2 !== 0 && last % 2 === 1) {
    return `${text.slice(0, -1)}${String(last - 1)}`
  }
  return text
}

/**
 * One `--jq` output as go-gh prints it: a string raw, null as an empty line, a
 * boolean as its word, a number in fixed notation (see fixedNumber), and
 * anything else as Go's json.Marshal writes it.
 */
function jqLine(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return fixedNumber(value)
  return goEncoded(value, marshalString)
}

/**
 * Each row cut to the fields asked for, keys in sorted order: gh exports a
 * Go map, which its JSON encoder always writes sorted.
 */
function select(value: unknown, fields: string[]): unknown {
  const rows = Array.isArray(value) ? value : [value]
  const keys = [...new Set(fields)].sort(compareCodePoints)
  const selected = rows.map((row) => {
    const source = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
    return Object.fromEntries(keys.map((field) => [field, source[field] ?? null]))
  })
  return Array.isArray(value) ? selected : selected[0]
}

/**
 * The `--json` fields a line asked for, null without `--json`.
 *
 * Checked before any request, as gh checks them: a field gh does not export
 * is refused with gh's own message and every field it does, sorted, exit 1.
 */
export function jsonFields(fl: FlagView, allowed: readonly string[]): string[] | null {
  const spelled = fl.asStr('json')
  if (spelled === undefined) return null
  const fields = csvValues([spelled])
  const listing = [...allowed].sort(compareCodePoints).map((field) => `  ${field}`)
  if (fields.length === 0) {
    throw new UsageError(
      ['Specify one or more comma-separated fields for `--json`:', ...listing].join('\n'),
      1,
    )
  }
  const known = new Set(allowed)
  const unknown = fields.find((field) => !known.has(field))
  if (unknown !== undefined) {
    throw new UsageError(
      [`Unknown JSON field: ${JSON.stringify(unknown)}`, 'Available fields:', ...listing].join(
        '\n',
      ),
      1,
    )
  }
  return fields
}

/**
 * A value jq printed, the way gojq's errors print it: a string as it is,
 * anything else in gojq's own JSON.
 */
function gojqText(text: string, string: boolean): string {
  return string ? text : goEncoded(JSON.parse(text), gojqString)
}

/**
 * The message go-gh fails with when a run stopped early, or null when that
 * stop ends the output without failing.
 *
 * gojq reports an error the program raised with `error` as `error: <value>`,
 * and a builtin's in gojq's own words, which mirage's jq does not share, so
 * jq 1.8.2's stand; the builtins gojq writes in jq raise through `error` too
 * (GOJQ_RAISED). A `halt_error` whose value is not null fails as
 * `halt error: <value>`.
 */
async function jqFailure(value: unknown, program: string, run: JqRun): Promise<string | null> {
  const stop = run.stop
  if (stop === null) return null
  if (stop.kind === 'halt') {
    return stop.message === null ? null : `halt error: ${gojqText(stop.message, stop.string)}`
  }
  if (await jqRaised(value, program, run)) return `error: ${gojqText(stop.text, stop.string)}`
  const raised = GOJQ_RAISED.get(stop.text)
  return raised === undefined ? stop.text : `error: ${raised}`
}

/**
 * The lines `--jq` prints for each value in turn, the way go-gh's jq
 * evaluates them. `halt`, and `halt_error` on null, end that value's output
 * there. An error, or any other `halt_error`, fails the command after the
 * lines printed before it (see jqFailure): a PartialOutputError carries them.
 */
export async function jqLines(values: readonly unknown[], program: string): Promise<string> {
  const lines: string[] = []
  for (const value of values) {
    const run = await jqRun(value, program)
    for (const item of run.outputs) lines.push(`${jqLine(item)}\n`)
    const failure = await jqFailure(value, program, run)
    if (failure !== null) {
      throw new PartialOutputError(failure, new TextEncoder().encode(lines.join('')))
    }
  }
  return lines.join('')
}

export async function typedOut(
  value: unknown,
  fl: FlagView,
  human: string,
  allowed: readonly string[],
): Promise<CommandFnResult> {
  const program = fl.asStr('jq')
  const fields = jsonFields(fl, allowed)
  if (fields === null) {
    if (program !== undefined && program !== '') throw new UsageError('--jq requires --json')
    return textOut(human)
  }
  const selected = select(value, fields)
  if (program !== undefined && program !== '') {
    return textOut(await jqLines([selected], program))
  }
  return jsonOut(selected)
}
