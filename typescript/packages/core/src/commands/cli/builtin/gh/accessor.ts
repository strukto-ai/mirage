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

import { HttpGitHubTransport, type GitHubTransport } from '../../../../core/github/client.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { parseRepo, type RepoRef } from '../../../../core/github/repo.ts'
import { jqEval } from '../../../../core/jq/index.ts'
import { UsageError } from '../../../errors.ts'
import type { FlagView } from '../../../spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import { resolvePath } from '../../../../utils/path.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'

const ENC = new TextEncoder()

export function ghTransport(config: unknown): GitHubTransport {
  const cfg = config as GhConfig
  const opts: { token: string; baseUrl?: string } = { token: cfg.token }
  if (cfg.baseUrl !== undefined) opts.baseUrl = cfg.baseUrl
  return new HttpGitHubTransport(opts)
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
  return parseRepo(named)
}

export function jsonOut(value: unknown): CommandFnResult {
  const text = value === null ? '' : `${JSON.stringify(value, null, 2)}\n`
  const out: ByteSource = ENC.encode(text)
  return [out, new IOResult()]
}

export function textOut(text: string): CommandFnResult {
  const out: ByteSource = ENC.encode(text)
  return [out, new IOResult()]
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

function dashOption(inv: CLIInvocation, options: readonly string[]): boolean {
  return options.some((option) =>
    inv.argv.some(
      (word, index) =>
        word === `${option}=-` ||
        (option.length === 2 && word === `${option}-`) ||
        (word === option && inv.argv[index + 1] === '-'),
    ),
  )
}

export async function readCliFile(
  inv: CLIInvocation,
  raw: unknown,
  option: string,
  ...aliases: string[]
): Promise<Uint8Array> {
  if (typeof raw !== 'string') throw new Error(`${option} expects a file`)
  const path = raw === '-' || dashOption(inv, [option, ...aliases]) ? '-' : raw
  if (path === '-') {
    if (inv.stdin === null) throw new Error(`${option} needs standard input`)
    return materialize(inv.stdin)
  }
  const dispatch = inv.doors?.dispatch
  if (dispatch === undefined) throw new Error(`${option} needs a workspace to read files from`)
  const virtual = resolvePath(path, inv.env.PWD ?? '/')
  try {
    const [data] = await dispatch('read', PathSpec.fromStrPath(virtual))
    return await materialize(data as ByteSource)
  } catch (err) {
    if (err instanceof Error && err.name === 'FileNotFoundError') {
      throw new Error(`read ${path}: No such file or directory`)
    }
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
    return new TextDecoder().decode(await readCliFile(inv, source, fileFlag, '-F'))
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

function jqLine(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function select(value: unknown, fields: string[]): unknown {
  const rows = Array.isArray(value) ? value : [value]
  const selected = rows.map((row) => {
    const source = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
    return Object.fromEntries(fields.map((field) => [field, source[field] ?? null]))
  })
  return Array.isArray(value) ? selected : selected[0]
}

export async function typedOut(
  value: unknown,
  fl: FlagView,
  human: string,
  allowed: readonly string[],
): Promise<CommandFnResult> {
  const jsonFields = fl.asStr('json')
  const program = fl.asStr('jq')
  if (jsonFields === undefined) {
    if (program !== undefined && program !== '') throw new UsageError('--jq requires --json')
    return textOut(human)
  }
  const fields = csvValues([jsonFields])
  const known = new Set(allowed)
  const unknown = fields.find((field) => !known.has(field))
  if (unknown !== undefined) throw new UsageError(`unknown JSON field: ${unknown}`)
  const selected = select(value, fields)
  if (program !== undefined && program !== '') {
    const values = await jqEval(selected, program)
    return textOut(values.map((item) => `${jqLine(item)}\n`).join(''))
  }
  return jsonOut(selected)
}
