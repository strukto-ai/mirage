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
import { byteView, decodeText, encodeText, utf8Locale } from '../../../../shell/bytes.ts'
import { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  BadConfigValueError,
  BadNumericConfigError,
  ConfigKeyError,
  ConfigUsageError,
  GitError,
} from './errors.ts'
import { configLines } from './fs.ts'
import { readOptional, writeFile } from './io.ts'
import { inside } from './session.ts'
import type { RepoLocation } from './types.ts'
import {
  commandLineConfig,
  DOTTED_HEADER,
  QUOTED_HEADER,
  WIDE_INT_BITS,
  configInt,
  configValue,
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
const READING_ACTIONS = ['list', 'get', 'get_all', 'get_regexp']
const WRITING_ACTIONS = ['add', 'unset']
const NOTHING_TO_CHANGE_EXIT = 5
const WRITE_KEY_EXIT = 2
const PLAIN_HEADER = /^\s*\[([A-Za-z0-9-]+)\s*\]/
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

/** A header's section (lowercased), subsection and whether that compares
 * without case (the older `[section.sub]` spelling). */
type Block = readonly [string, string | null, boolean]

/** One line of a config file, as the writer reads it: `end` is one past its
 * last physical line, since a value continued by a backslash runs on. */
interface ConfigLine {
  readonly start: number
  readonly end: number
  readonly header?: Block
  readonly noted?: boolean
  readonly name?: string
  readonly comment?: boolean
}

/** A header line's block and whether more follows it on the line. */
function headerOf(line: string): [Block, boolean] {
  const quoted = QUOTED_HEADER.exec(line)
  const dotted = DOTTED_HEADER.exec(line)
  const plain = PLAIN_HEADER.exec(line)
  let block: Block
  let end: number
  if (quoted !== null) {
    block = [(quoted[1] ?? '').toLowerCase(), (quoted[2] ?? '').replace(/\\(.)/g, '$1'), false]
    end = quoted[0].length
  } else if (dotted !== null) {
    block = [(dotted[1] ?? '').toLowerCase(), (dotted[2] ?? '').toLowerCase(), true]
    end = dotted[0].length
  } else if (plain !== null) {
    block = [(plain[1] ?? '').toLowerCase(), null, false]
    end = plain[0].length
  } else return [['', null, false], true]
  return [block, line.slice(end).trim() !== '']
}

/** The file's lines, a continued value joined to the line it opens. */
function configLinesOf(raw: readonly string[]): ConfigLine[] {
  const out: ConfigLine[] = []
  let at = 0
  while (at < raw.length) {
    const line = raw[at] ?? ''
    const text = line.trim()
    if (text.startsWith('[')) {
      const [header, noted] = headerOf(line)
      out.push({ start: at, end: at + 1, header, noted })
      at += 1
      continue
    }
    if (text === '' || text.startsWith('#') || text.startsWith(';')) {
      out.push({ start: at, end: at + 1, comment: text !== '' })
      at += 1
      continue
    }
    let end = at + 1
    let body = line.replace(/\r?\n$/, '')
    while (body.endsWith('\\') && end < raw.length) {
      body = (raw[end] ?? '').replace(/\r?\n$/, '')
      end += 1
    }
    out.push({ start: at, end, name: (text.split('=')[0] ?? '').trim().toLowerCase() })
    at = end
  }
  return out
}

/** Whether a header opens the block a name lives in. */
function inBlock(block: Block, section: string, subsection: string | null): boolean {
  const [name, sub, caseless] = block
  if (name !== section || (sub === null) !== (subsection === null)) return false
  if (sub === null || subsection === null) return true
  return sub === (caseless ? subsection.toLowerCase() : subsection)
}

/**
 * The config text with one variable set, added or taken out. A set rewrites
 * the one line the variable has, and a new variable goes after the last
 * variable of the last block it belongs in, or in a new block at the end,
 * spelled as typed. Taking the last variable out of a block takes the block
 * too, with the blank lines around it, unless a comment is there or the next
 * block is the same one (pinned against git 2.47.3).
 */
function configEdit(
  text: string,
  key: string,
  value: string | null,
  adding: boolean,
): string | IOResult {
  const dot = key.indexOf('.')
  const section = key.slice(0, dot)
  const rest = key.slice(dot + 1)
  const last = rest.lastIndexOf('.')
  const subsection = last < 0 ? null : rest.slice(0, last)
  const variable = rest.slice(last + 1)
  const wanted = section.toLowerCase()
  const name = variable.toLowerCase()
  const raw = text.split(/(?<=\n)/).filter((line) => line !== '')
  const lines = configLinesOf(raw)
  let block: Block | null = null
  const owners: number[] = []
  const matches: number[] = []
  lines.forEach((line, index) => {
    if (line.header !== undefined) {
      block = line.header
      if (inBlock(block, wanted, subsection)) owners.push(index)
    } else if (line.name === name && block !== null && inBlock(block, wanted, subsection))
      matches.push(index)
  })
  if (value === null) {
    if (matches.length === 0) return new IOResult({ exitCode: NOTHING_TO_CHANGE_EXIT })
    if (matches.length > 1)
      return new IOResult({
        exitCode: NOTHING_TO_CHANGE_EXIT,
        stderr: encodeText(`warning: ${key} has multiple values\n`),
      })
    return without(raw, lines, matches[0] ?? 0).join('')
  }
  let entry = `\t${variable} = ${configValue(value)}\n`
  if (matches.length > 0 && !adding) {
    if (matches.length > 1)
      return new IOResult({
        exitCode: NOTHING_TO_CHANGE_EXIT,
        stderr: encodeText(
          `warning: ${key} has multiple values\n` +
            'error: cannot overwrite multiple values with a single value\n' +
            `       Use a regexp, --add or --replace-all to change ${key}.\n`,
        ),
      })
    const found = lines[matches[0] ?? 0]
    if (found === undefined) return text
    return [...raw.slice(0, found.start), entry, ...raw.slice(found.end)].join('')
  }
  const owner = owners.at(-1)
  if (owner !== undefined) {
    let after = lines[owner]?.end ?? 0
    for (const line of lines.slice(owner + 1)) {
      if (line.header !== undefined) break
      if (line.name !== undefined) after = line.end
    }
    if (!(raw[after - 1] ?? '\n').endsWith('\n')) entry = `\n${entry}`
    return [...raw.slice(0, after), entry, ...raw.slice(after)].join('')
  }
  const head =
    subsection === null
      ? `[${section}]\n`
      : `[${section} "${subsection.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]\n`
  return (text === '' || text.endsWith('\n') ? text : `${text}\n`) + head + entry
}

/** The physical lines with one variable out, and its block if that leaves it
 * empty. */
function without(raw: readonly string[], lines: readonly ConfigLine[], index: number): string[] {
  const found = lines[index]
  if (found === undefined) return [...raw]
  const kept = (): string[] => raw.filter((_, at) => at < found.start || at >= found.end)
  let head = -1
  for (let at = 0; at < index; at++) if (lines[at]?.header !== undefined) head = at
  const opening = lines[head]
  if (opening === undefined || opening.noted === true) return kept()
  let after = lines.length
  for (let at = head + 1; at < lines.length; at++)
    if (lines[at]?.header !== undefined) {
      after = at
      break
    }
  const inner = lines.slice(head + 1, after).filter((_, at) => at + head + 1 !== index)
  let before: ConfigLine | undefined
  for (let at = head - 1; at >= 0; at--) {
    const line = lines[at]
    if (
      line !== undefined &&
      (line.header !== undefined || line.name !== undefined || line.comment === true)
    ) {
      before = line
      break
    }
  }
  const next = lines[after]?.header
  const same =
    next !== undefined &&
    opening.header !== undefined &&
    next.every((part, at) => part === opening.header?.[at])
  if (
    inner.some((line) => line.name !== undefined || line.comment === true) ||
    before?.comment === true ||
    same
  )
    return kept()
  const first = before?.end ?? 0
  const lastLine = lines[after]?.start ?? raw.length
  return [...raw.slice(0, first), ...raw.slice(lastLine)]
}

/**
 * The one file a write changes, as git picks it. `--global` writes
 * `~/.gitconfig`, or the XDG file when only that one exists.
 */
async function configPath(ctx: Context, fl: FlagView): Promise<PathSpec> {
  const named = fl.asStr('file')
  if (named !== undefined) return startPoint(fl).join(named)
  const env = ctx.env ?? {}
  if (fl.asBool('global')) {
    const override = env.GIT_CONFIG_GLOBAL
    if (override !== undefined) return PathSpec.fromStrPath(override, undefined, '/')
    const home = env.HOME ?? ''
    if (!home) throw new GitError('$HOME not set')
    const target = PathSpec.fromStrPath(`${home}/.gitconfig`, undefined, '/')
    const configured = env.XDG_CONFIG_HOME ?? ''
    const xdg = PathSpec.fromStrPath(
      `${configured === '' ? `${home}/.config` : configured}/git/config`,
      undefined,
      '/',
    )
    const vfs = requireVfs(ctx)
    if ((await readOptional(vfs, target)) === null && (await readOptional(vfs, xdg)) !== null)
      return xdg
    return target
  }
  if (fl.asBool('system'))
    return PathSpec.fromStrPath(env.GIT_CONFIG_SYSTEM ?? SYSTEM_CONFIG, undefined, '/')
  const location = await inside(ctx, fl)
  if (location === null) throw new GitError('not in a git directory')
  return location.commondir.join('config')
}

/** Refuse a line naming more than one config file. */
function oneFile(fl: FlagView): void {
  const scopes = ['global', 'system', 'local', 'worktree'].filter((flag) => fl.asBool(flag)).length
  if (scopes + (fl.asStr('file') !== undefined ? 1 : 0) > 1)
    throw new ConfigUsageError('only one config file at a time')
}

/**
 * A set, `--add` or unset, or null when the line reads. `set`, `unset`,
 * `--add`, `--unset` and the two-word set change one file. What else writes
 * (a value pattern, `--all`, a type, `--replace-all`, the section subcommands,
 * `edit`) stays refused.
 */
async function configWrite(
  ctx: Context,
  fl: FlagView,
  words: string[],
): Promise<CommandFnResult | null> {
  const actions = fl.typedOrder(...READING_ACTIONS, ...WRITING_ACTIONS)
  const writes = actions.filter((name) => WRITING_ACTIONS.includes(name))
  if (writes.length > 0 && actions.length > 1) {
    const later = actions.at(-1) ?? ''
    const earlier = actions.find((name) => name !== later) ?? ''
    throw new ConfigUsageError(
      `options '--${later.replaceAll('_', '-')}' and '--${earlier.replaceAll('_', '-')}' cannot be used together`,
    )
  }
  if (actions.length > 0 && writes.length === 0) return null
  const subcommand = actions.length === 0 ? words[0] : undefined
  if (subcommand === 'list' || subcommand === 'get') return null
  let value: string | null
  if (subcommand === 'set' || subcommand === 'unset') {
    words = words.slice(1)
    const count = subcommand === 'set' ? 2 : 1
    if (words.length !== count) throw new ConfigUsageError(usageOf(count, count))
    if (fl.asBool('all') || fl.asStr('value') !== undefined) return readOnly()
    value = subcommand === 'set' ? (words[1] ?? '') : null
  } else if (subcommand !== undefined && WRITING_SUBCOMMANDS.includes(subcommand)) return readOnly()
  else if (writes.length === 1 && writes[0] === 'add') {
    if (words.length !== 2) throw new ConfigUsageError(usageOf(2, 2))
    value = words[1] ?? ''
  } else if (writes.length === 1 && writes[0] === 'unset') {
    if (words.length < 1 || words.length > 2) throw new ConfigUsageError(usageOf(1, 2))
    if (words.length === 2) return readOnly()
    value = null
  } else if (words.length === 2) value = words[1] ?? ''
  else if (words.length > 2) return readOnly()
  else return null
  oneFile(fl)
  if (valueKind(fl) !== null) return readOnly()
  const key = words[0] ?? ''
  try {
    parseConfigKey(key)
  } catch (err) {
    if (!(err instanceof ConfigKeyError) || !err.message.startsWith('key does not contain'))
      throw err
    return [
      null,
      new IOResult({ exitCode: WRITE_KEY_EXIT, stderr: encodeText(`error: ${err.message}\n`) }),
    ]
  }
  const path = await configPath(ctx, fl)
  const vfs = requireVfs(ctx)
  const data = await readOptional(vfs, path)
  if (data === null && value === null)
    return [null, new IOResult({ exitCode: NOTHING_TO_CHANGE_EXIT })]
  const adding = writes.length === 1 && writes[0] === 'add'
  const edited = configEdit(data === null ? '' : decodeText(data), key, value, adding)
  if (edited instanceof IOResult) return [null, edited]
  await writeFile(vfs, path, encodeText(edited))
  return [null, new IOResult()]
}

/**
 * Read configuration, or set, add and unset one variable. Reading goes
 * through the same scopes git has, and a default read takes every file and
 * then the command line, so the last value wins across all of them. A write
 * changes the one file its scope names.
 */
export async function config(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const words = [...texts]
  const written = await configWrite(ctx, fl, words)
  if (written !== null) return written
  const actionNamed = READING_ACTIONS.some((flag) => fl.asBool(flag))
  if (
    !actionNamed &&
    words[0] !== 'list' &&
    words[0] !== 'get' &&
    words.length === 0 &&
    fl.asStr('default') === undefined
  )
    throw new ConfigUsageError('no action specified')
  const [query, fewest, most] = queryOf(fl, words)
  if (words.length < fewest || words.length > most)
    throw new ConfigUsageError(usageOf(fewest, most))
  oneFile(fl)
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
