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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { IOResult } from '../../../../io/types.ts'
import { RegexError } from '../../../../rs/errors.ts'
import { type PosixRegex, posixRegex } from '../../../../rs/regex.ts'
import { byteView, encodeText, utf8Locale } from '../../../../shell/bytes.ts'
import { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { BadConfigValueError, BadNumericConfigError, ConfigUsageError, GitError } from './errors.ts'
import { configLines } from './fs.ts'
import { readOptional } from './io.ts'
import { inside } from './session.ts'
import type { RepoLocation } from './types.ts'
import {
  commandLineConfig,
  WIDE_INT_BITS,
  configInt,
  maybeBool,
  parseConfigKey,
  requireVfs,
  startPoint,
} from './util.ts'

const SYSTEM_CONFIG = '/etc/gitconfig'
const SCOPE_LOCAL = 'local'
const SCOPE_GLOBAL = 'global'
const SCOPE_SYSTEM = 'system'
const SCOPE_COMMAND = 'command'
const COMMAND_LINE_ORIGIN = 'command line:'
const WRITING_SUBCOMMANDS = ['set', 'unset', 'rename-section', 'remove-section', 'edit']
// The value types mirage renders; git's others paint or read dates.
const VALUE_KINDS = ['bool', 'int', 'bool-or-int', 'path']
const OTHER_VALUE_KINDS = ['bool-or-str', 'color', 'expiry-date']
const INVALID_REGEX_EXIT = 6

/** One value a config source holds; a null value is a bare name. */
interface Variable {
  readonly scope: string
  readonly origin: string
  readonly name: string
  readonly value: string | null
}

/** What one invocation asks of the variables. */
interface Query {
  readonly listing?: boolean
  readonly regexp?: boolean
  readonly every?: boolean
  readonly names?: boolean
}

export function configKey(key: string): string {
  const parts = key.split('.')
  return parts
    .map((part, i) => (i === 0 || i === parts.length - 1 ? part.toLowerCase() : part))
    .join('.')
}

async function parsed(data: Uint8Array, scope: string, origin: string): Promise<Variable[]> {
  return (await configLines(new TextDecoder().decode(data))).map((line) => ({
    scope,
    origin,
    name: line.path,
    value: line.value ?? null,
  }))
}

/**
 * The per-user config files `--global` reads, in git's order: `$GIT_CONFIG_GLOBAL`
 * alone when set, else the XDG file then `~/.gitconfig`, each read through the
 * dispatcher from the session's own `HOME`. Only `--list` refuses when neither
 * exists.
 */
export async function globalSources(
  ctx: Context,
  listing: boolean,
): Promise<{ source: string; data: Uint8Array }[]> {
  const vfs = requireVfs(ctx)
  const home = ctx.env?.HOME ?? ''
  const override = ctx.env?.GIT_CONFIG_GLOBAL
  if (override === undefined && !home) throw new GitError('$HOME not set')
  const target = override ?? `${home}/.gitconfig`
  const configured = ctx.env?.XDG_CONFIG_HOME ?? ''
  const xdg = configured === '' ? `${home}/.config` : configured
  const sources: { source: string; data: Uint8Array }[] = []
  for (const source of override === undefined ? [`${xdg}/git/config`, target] : [target]) {
    const data = await readOptional(vfs, PathSpec.fromStrPath(source, undefined, '/'))
    if (data !== null) sources.push({ source, data })
  }
  if (!sources.length && listing)
    throw new GitError(`unable to read config file '${target}': No such file or directory`)
  return sources
}

function missingFile(path: string): GitError {
  return new GitError(`unable to read config file '${path}': No such file or directory`)
}

async function systemVariables(ctx: Context, listing: boolean): Promise<Variable[]> {
  const path = ctx.env?.GIT_CONFIG_SYSTEM ?? SYSTEM_CONFIG
  const data = await readOptional(requireVfs(ctx), PathSpec.fromStrPath(path, undefined, '/'))
  if (data === null) {
    if (listing) throw missingFile(path)
    return []
  }
  return parsed(data, SCOPE_SYSTEM, `file:${path}`)
}

/**
 * The repository's own config. git names it from the top of the work tree it
 * moved to, so an ordinary checkout reads `.git/config` from anywhere inside it.
 */
async function localVariables(
  ctx: Context,
  fl: FlagView,
  location: RepoLocation,
): Promise<Variable[]> {
  const path = location.commondir.join('config')
  const data = await readOptional(requireVfs(ctx), path)
  const ordinary = location.commondir.virtual === `${location.worktree.virtual}/.git`
  const start = startPoint(fl).virtual
  const inside =
    start === location.worktree.virtual || start.startsWith(`${location.worktree.virtual}/`)
  const label = ordinary && inside ? '.git/config' : path.rawPath
  return parsed(data ?? new Uint8Array(), SCOPE_LOCAL, `file:${label}`)
}

/**
 * The variables the line's scope reads, in the order git reads them. Without a
 * scope that is every file then the command line; a scope names one file, and
 * `--list` then refuses a missing one.
 */
/** What `-c` and `--config-env` set, last in every default read. */
function commandVariables(ctx: Context): Variable[] {
  return commandLineConfig(ctx).map(([name, value]) => ({
    scope: SCOPE_COMMAND,
    origin: COMMAND_LINE_ORIGIN,
    name,
    value,
  }))
}

async function variablesOf(ctx: Context, fl: FlagView, listing: boolean): Promise<Variable[]> {
  const named = fl.asStr('file')
  if (named !== undefined) {
    const data = await readOptional(requireVfs(ctx), startPoint(fl).join(named))
    if (data === null && listing) throw missingFile(named)
    return parsed(data ?? new Uint8Array(), SCOPE_COMMAND, `file:${named}`)
  }
  if (fl.asBool('global')) {
    const rows: Variable[] = []
    for (const { source, data } of await globalSources(ctx, listing))
      rows.push(...(await parsed(data, SCOPE_GLOBAL, `file:${source}`)))
    return rows
  }
  if (fl.asBool('system')) return systemVariables(ctx, listing)
  const location = await inside(ctx, fl)
  for (const scope of ['local', 'worktree']) {
    if (!fl.asBool(scope)) continue
    if (location === null) throw new GitError(`--${scope} can only be used inside a git repository`)
    return localVariables(ctx, fl, location)
  }
  const rows = await systemVariables(ctx, false)
  if ((ctx.env?.HOME ?? '') !== '' || (ctx.env?.GIT_CONFIG_GLOBAL ?? '') !== '')
    for (const { source, data } of await globalSources(ctx, false))
      rows.push(...(await parsed(data, SCOPE_GLOBAL, `file:${source}`)))
  if (location !== null) rows.push(...(await localVariables(ctx, fl, location)))
  return [...rows, ...commandVariables(ctx)]
}

function valueKind(fl: FlagView): string | null {
  const kinds = ['bool', 'int', 'bool_or_int', 'path']
    .filter((flag) => fl.asBool(flag))
    .map((flag) => flag.replaceAll('_', '-'))
  const typed = fl.asStr('type')
  if (typed !== undefined) kinds.push(typed)
  if (kinds.length > 1) throw new ConfigUsageError('only one type at a time')
  const [kind] = kinds
  if (kind === undefined) return null
  if (OTHER_VALUE_KINDS.includes(kind)) throw new GitError(`unsupported --type argument, ${kind}`)
  if (!VALUE_KINDS.includes(kind)) throw new GitError(`unrecognized --type argument, ${kind}`)
  return kind
}

function typedValue(
  value: string | null,
  kind: string | null,
  name: string,
  env: Readonly<Record<string, string>>,
): string | null {
  if (kind === null) return value
  if (kind === 'path')
    return value?.startsWith('~/') === true ? `${env.HOME ?? ''}/${value.slice(2)}` : value
  if (kind === 'int') return String(configInt(value ?? '', name, WIDE_INT_BITS))
  if (kind === 'bool-or-int') {
    if (value === null) return 'true'
    try {
      return String(configInt(value, name))
    } catch (err) {
      if (!(err instanceof BadNumericConfigError)) throw err
      const answer = maybeBool(value)
      if (answer === null) throw err
      return answer ? 'true' : 'false'
    }
  }
  const answer = value === null ? true : maybeBool(value)
  if (answer === null) throw new BadConfigValueError(value ?? '', name)
  return answer ? 'true' : 'false'
}

function queryOf(fl: FlagView, words: string[]): [Query, number, number] {
  if (words[0] === 'list') {
    words.shift()
    return [{ listing: true }, 0, 0]
  }
  if (words[0] === 'get') {
    words.shift()
    return [
      { regexp: fl.asBool('regexp'), every: fl.asBool('all'), names: fl.asBool('show_names') },
      1,
      1,
    ]
  }
  if (fl.asBool('list')) return [{ listing: true }, 0, 0]
  if (fl.asBool('get_regexp')) return [{ regexp: true, every: true, names: true }, 1, 2]
  if (fl.asBool('get_all')) return [{ every: true }, 1, 2]
  return [{}, 1, 2]
}

function usageOf(fewest: number, most: number): string {
  return fewest === most
    ? `wrong number of arguments, should be ${String(fewest)}`
    : `wrong number of arguments, should be from ${String(fewest)} to ${String(most)}`
}

/**
 * The test a value pattern puts each value to: `!` in front negates a pattern,
 * and `--fixed-value` compares the whole value instead.
 */
function every(): boolean {
  return true
}

function valueTest(
  pattern: string | undefined,
  fixed: boolean,
  utf8: boolean,
  signal: AbortSignal | undefined,
): (value: string | null) => Promise<boolean> | boolean {
  if (pattern === undefined) return every
  if (fixed) return (value) => value === pattern
  const negated = pattern.startsWith('!')
  const compiled = posixRegex(
    byteView(negated ? pattern.slice(1) : pattern, utf8),
    true,
    'posix',
    false,
    utf8,
  )
  return async (value) =>
    ((await compiled.search(byteView(value ?? '', utf8), 0, signal)) !== null) !== negated
}

function readOnly(): CommandFnResult {
  return [
    null,
    new IOResult({
      exitCode: 1,
      stderr: encodeText('error: git config is read-only in Mirage; writes are not supported\n'),
    }),
  ]
}

function regexRefused(message: string): CommandFnResult {
  return [null, new IOResult({ exitCode: INVALID_REGEX_EXIT, stderr: encodeText(message) })]
}

/**
 * Read configuration: `--list`, `--get` and their subcommands. Writes stay
 * refused. Reading goes through the same scopes git has, and a default read
 * takes every file and then the command line, so the last value wins across
 * all of them.
 */
export async function config(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const words = [...texts]
  const actionNamed = ['list', 'get', 'get_all', 'get_regexp'].some((flag) => fl.asBool(flag))
  if (!actionNamed && words[0] !== undefined && WRITING_SUBCOMMANDS.includes(words[0]))
    return readOnly()
  if (!actionNamed && words[0] !== 'list' && words[0] !== 'get') {
    if (words.length === 0 && fl.asStr('default') === undefined)
      throw new ConfigUsageError('no action specified')
    if (words.length > 1) return readOnly()
  }
  const [query, fewest, most] = queryOf(fl, words)
  if (words.length < fewest || words.length > most)
    throw new ConfigUsageError(usageOf(fewest, most))
  const scopes = ['global', 'system', 'local', 'worktree'].filter((flag) => fl.asBool(flag)).length
  if (scopes + (fl.asStr('file') !== undefined ? 1 : 0) > 1)
    throw new ConfigUsageError('only one config file at a time')
  const kind = valueKind(fl)
  const key = words[0] ?? ''
  const utf8 = utf8Locale(ctx.env)
  let wanted: string | null = null
  let pattern: PosixRegex | null = null
  if (query.regexp === true) {
    try {
      pattern = posixRegex(byteView(configKey(key), utf8), true, 'posix', false, utf8)
    } catch (err) {
      if (!(err instanceof RegexError)) throw err
      return regexRefused(`error: invalid key pattern: ${key}\n`)
    }
  } else if (query.listing !== true) wanted = parseConfigKey(key)
  const filter = words.length > 1 ? words[1] : fl.asStr('value')
  let accepted: (value: string | null) => Promise<boolean> | boolean
  try {
    accepted = valueTest(filter, fl.asBool('fixed_value'), utf8, ctx.signal)
  } catch (err) {
    if (!(err instanceof RegexError)) throw err
    return regexRefused(`error: invalid pattern: ${filter ?? ''}\n`)
  }
  let rows: Variable[] = []
  for (const variable of await variablesOf(ctx, fl, query.listing === true)) {
    const named =
      query.listing === true ||
      (pattern !== null
        ? (await pattern.search(byteView(variable.name, utf8), 0, ctx.signal)) !== null
        : variable.name === wanted)
    if (named && (await accepted(variable.value))) rows.push(variable)
  }
  if (query.listing !== true && query.every !== true) rows = rows.slice(-1)
  const fallback = fl.asStr('default')
  if (rows.length === 0 && fallback !== undefined && query.listing !== true)
    rows = [{ scope: '', origin: '', name: wanted ?? key, value: fallback }]
  const nul = fl.asBool('null')
  const end = nul ? '\0' : '\n'
  const between = nul ? '\0' : '\t'
  const origin = fl.asBool('show_origin')
  const scope = fl.asBool('show_scope')
  const onlyNames = fl.asBool('name_only')
  const paired = query.listing === true || query.names === true
  let out = ''
  for (const row of rows) {
    const shown = typedValue(row.value, kind, row.name, ctx.env ?? {})
    const head =
      (scope && row.scope !== '' ? `${row.scope}${between}` : '') +
      (origin && row.origin !== '' ? `${row.origin}${between}` : '')
    if (paired && onlyNames) out += `${head}${row.name}${end}`
    else if (paired) {
      const mark = nul ? '\n' : query.listing === true ? '=' : ' '
      out += head + (shown === null ? `${row.name}${end}` : `${row.name}${mark}${shown}${end}`)
    } else out += `${head}${shown ?? ''}${end}`
  }
  return [
    encodeText(out),
    new IOResult({ exitCode: rows.length > 0 || query.listing === true ? 0 : 1 }),
  ]
}
