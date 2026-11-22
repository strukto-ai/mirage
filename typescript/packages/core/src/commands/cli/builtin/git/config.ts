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
import { strerrorOf } from '../../../../errors/fs.ts'
import { posixPhrase } from '../../../../errors/posix.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import type { Files } from '../../../../workspace/files.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { CommandSpec } from '../../../spec/types.ts'
import { gitOptionRefusal } from '../../refusal.ts'
import {
  BadConfigValueError,
  BadNumericConfigError,
  ConfigKeyError,
  ConfigUsageError,
  FATAL_EXIT,
  GitError,
  UsageError,
} from './errors.ts'
import { configLines } from './fs.ts'
import { exists, readOptional, removeFile, statOf } from './io.ts'
import { inside } from './session.ts'
import type { RepoLocation } from './types.ts'
import {
  commandLineConfig,
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
const INVALID_FILE_EXIT = 3
const LOCK_EXIT = 255
const BOM = '\ufeff'
const SECTION_CHARS = /[A-Za-z0-9.-]/
const ESCAPED = '"\\ntb'
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
  return (await configLines(decodeText(data))).map((line) => ({
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
  return parsed(data ?? new Uint8Array(), SCOPE_LOCAL, `file:${localLabel(fl, location, path)}`)
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

/** A header's name as a key's stem (section lowercased, then the
 * subsection) and whether that is the older `[section.sub]` spelling, all
 * lowercased. */
type Block = readonly [string, boolean]

/**
 * One line of a config file, as the writer reads it: `end` is one past its
 * last physical line, since a value continued by a backslash runs on. A
 * variable can share a header's line, and `headerEnd` is where that header
 * ends on it; `noted` is a header with a comment after it.
 */
interface ConfigLine {
  readonly start: number
  readonly end: number
  readonly header?: Block | undefined
  readonly noted?: boolean
  readonly name?: string
  readonly comment?: boolean
  readonly headerEnd?: number
}

/** The file's physical lines, each with its ending; only LF ends one. */
function physicalLines(text: string): string[] {
  const parts = text.split('\n')
  const lines = parts.slice(0, -1).map((part) => `${part}\n`)
  const last = parts.at(-1) ?? ''
  return last === '' ? lines : [...lines, last]
}

/** A physical line without its ending, LF or CR LF. */
function lineText(line: string): string {
  if (!line.endsWith('\n')) return line
  const body = line.slice(0, -1)
  return body.endsWith('\r') ? body.slice(0, -1) : body
}

/** The header whose `[` is at `text[at]` and where it ends, or the name git
 * read before refusing it. */
function headerAt(text: string, at: number): [Block, number] | string {
  let end = at + 1
  while (end < text.length && SECTION_CHARS.test(text[end] ?? '')) end += 1
  const name = text.slice(at + 1, end).toLowerCase()
  if (text[end] === ']') {
    if (name === '') return name
    return [[name, name.includes('.')], end + 1]
  }
  const spaced = end
  while (text[end] === ' ' || text[end] === '\t') end += 1
  if (name === '' || end === spaced || text[end] !== '"') return name
  let sub = ''
  end += 1
  while (end < text.length && text[end] !== '"') {
    if (text[end] === '\\') end += 1
    sub += text[end] ?? ''
    end += 1
  }
  if (text[end + 1] !== ']') return `${name}.${sub}`
  return [[`${name}.${sub}`, false], end + 2]
}

/**
 * Where the value at `raw[at]` from `start` ends, one past the last line read
 * (a quote a backslash runs past the end of the file counts the line it ran on
 * to), and whether git reads it. A backslash ending a line runs the value on,
 * unless a comment holds it; `\"`, `\\`, `\n`, `\t` and `\b` are the only other
 * escapes, and a quote must close on its line.
 */
function valueEnd(raw: readonly string[], at: number, start: number): [number, boolean] {
  let quoted = false
  for (;;) {
    const line = raw[at] ?? ''
    const ended = line.endsWith('\n')
    const text = lineText(line)
    let index = start
    let runsOn = false
    while (index < text.length) {
      const char = text[index]
      if (char === '\\') {
        if (index + 1 === text.length) {
          runsOn = true
          break
        }
        if (!ESCAPED.includes(text[index + 1] ?? '')) return [at + 1, false]
        index += 2
        continue
      }
      if (char === '"') quoted = !quoted
      else if (!quoted && (char === '#' || char === ';')) break
      index += 1
    }
    if (runsOn && ended && at + 1 < raw.length) {
      at += 1
      start = 0
      continue
    }
    return [at + (runsOn && quoted ? 2 : 1), !quoted]
  }
}

/** Where the text from `at` resumes past the characters `skipped` holds. */
function skipping(text: string, at: number, skipped: string): number {
  let index = at
  while (index < text.length && skipped.includes(text[index] ?? '')) index += 1
  return index
}

/**
 * The file's lines as git reads them, or its refusal of the file. A header can
 * share its line with a comment or with one variable, and a value continued by
 * a backslash takes the lines it runs on. A header git cannot read is refused
 * by name; any other line git cannot read, by number (pinned against git
 * 2.47.3).
 */
function configLinesOf(raw: readonly string[], shown: string): ConfigLine[] | IOResult {
  const out: ConfigLine[] = []
  let at = 0
  while (at < raw.length) {
    const text = lineText(raw[at] ?? '')
    let index = skipping(text, at === 0 && text.startsWith(BOM) ? BOM.length : 0, ' \t\r\v\f')
    let header: Block | undefined
    let headerEnd = 0
    while (text[index] === '[') {
      const found = headerAt(text, index)
      if (typeof found === 'string')
        return new IOResult({
          exitCode: INVALID_FILE_EXIT,
          stderr: encodeText(
            `error: invalid section name '${found}'\nerror: invalid config file ${shown}\n`,
          ),
        })
      ;[header, headerEnd] = found
      index = skipping(text, headerEnd, ' \t')
    }
    const rest = text.slice(index)
    if (rest === '' || rest.startsWith('#') || rest.startsWith(';')) {
      out.push({
        start: at,
        end: at + 1,
        header,
        noted: header !== undefined && rest !== '',
        comment: header === undefined && rest !== '',
      })
      at += 1
      continue
    }
    let end = index
    while (end < text.length && /[A-Za-z0-9-]/.test(text[end] ?? '')) end += 1
    const name = text.slice(index, end).toLowerCase()
    const after = skipping(text, end, ' \t')
    let finish = at + 1
    let readable = /^[A-Za-z]/.test(rest)
    if (readable && after < text.length) {
      readable = text[after] === '='
      if (readable) [finish, readable] = valueEnd(raw, at, after + 1)
    }
    if (!readable)
      return new IOResult({
        exitCode: FATAL_EXIT,
        stderr: encodeText(`fatal: bad config line ${String(finish)} in file ${shown}\n`),
      })
    out.push({ start: at, end: finish, header, name, headerEnd })
    at = finish
  }
  return out
}

/**
 * Whether a header opens the block a name lives in. git compares the whole
 * stem, so `[a.b "c"]` and `[a "b.c"]` both hold `a.b.c.x`. A name matches
 * exactly, the older spelling's lowercased stem included; placing a new name,
 * that spelling compares without case (pinned against git 2.47.3).
 */
function inBlock(block: Block, stem: string, placing = false): boolean {
  const [name, caseless] = block
  return (
    name === stem ||
    (placing && caseless && name === stem.replace(/[A-Z]/g, (ch) => ch.toLowerCase()))
  )
}

/**
 * The config text with one variable set, added or taken out. A set rewrites
 * the one line the variable has, and a new variable goes after the last
 * variable of the last block it belongs in, or in a new block at the end,
 * spelled as typed. Taking the last variable out of a block takes the block
 * too, with the blank lines around it, unless a comment is there or the next
 * block is the same one. A file git cannot read is left as it is (pinned
 * against git 2.47.3).
 */
function configEdit(
  text: string,
  key: string,
  value: string | null,
  adding: boolean,
  shown: string,
): string | IOResult {
  const dot = key.indexOf('.')
  const section = key.slice(0, dot)
  const rest = key.slice(dot + 1)
  const last = rest.lastIndexOf('.')
  const subsection = last < 0 ? null : rest.slice(0, last)
  const variable = rest.slice(last + 1)
  const stem =
    subsection === null ? section.toLowerCase() : `${section.toLowerCase()}.${subsection}`
  const name = variable.toLowerCase()
  const raw = physicalLines(text)
  const lines = configLinesOf(raw, shown)
  if (lines instanceof IOResult) return lines
  let block: Block | undefined
  const owners: number[] = []
  const matches: number[] = []
  for (const [index, line] of lines.entries()) {
    if (line.header !== undefined) {
      block = line.header
      if (inBlock(block, stem, true)) owners.push(index)
    }
    if (line.name === name && block !== undefined && inBlock(block, stem)) matches.push(index)
  }
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
    const head =
      found.header !== undefined
        ? [`${(raw[found.start] ?? '').slice(0, found.headerEnd ?? 0)}\n`]
        : []
    return [...raw.slice(0, found.start), ...head, entry, ...raw.slice(found.end)].join('')
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
  const opening =
    subsection === null
      ? `[${section}]\n`
      : `[${section} "${subsection.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]\n`
  if (text === BOM) return opening + entry + text
  return (text === '' || text.endsWith('\n') ? text : `${text}\n`) + opening + entry
}

/**
 * The physical lines with one variable out, and its block if that leaves it
 * empty. A variable beside its header leaves the header alone on its line. A
 * block taken from the top of a file that opens with a byte order mark leaves
 * the mark and a line end.
 */
function without(raw: readonly string[], lines: readonly ConfigLine[], index: number): string[] {
  const found = lines[index]
  if (found === undefined) return [...raw]
  let head = index
  let kept: string[]
  if (found.header !== undefined)
    kept = [
      ...raw.slice(0, found.start),
      `${(raw[found.start] ?? '').slice(0, found.headerEnd ?? 0)}\n`,
      ...raw.slice(found.end),
    ]
  else {
    head = -1
    for (let at = 0; at < index; at++) if (lines[at]?.header !== undefined) head = at
    kept = [...raw.slice(0, found.start), ...raw.slice(found.end)]
  }
  const opening = lines[head]
  if (opening === undefined || opening.noted === true) return kept
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
    (head !== index && opening.name !== undefined) ||
    before?.comment === true ||
    same
  )
    return kept
  const first = before?.end ?? 0
  const lastLine = lines[after]?.start ?? raw.length
  const mark = first === 0 && (raw[0] ?? '').startsWith(BOM) ? [`${BOM}\n`] : []
  return [...raw.slice(0, first), ...mark, ...raw.slice(lastLine)]
}

/**
 * The repository's own config as git names it: from the top of the work tree
 * it moved to, so an ordinary checkout says `.git/config` from anywhere inside
 * it.
 */
function localLabel(fl: FlagView, location: RepoLocation, path: PathSpec): string {
  const ordinary = location.commondir.virtual === `${location.worktree.virtual}/.git`
  const start = startPoint(fl).virtual
  const within =
    start === location.worktree.virtual || start.startsWith(`${location.worktree.virtual}/`)
  return ordinary && within ? '.git/config' : path.rawPath
}

/**
 * The one file a write changes, as git picks it, and its name as git says it.
 * `--global` writes `~/.gitconfig`, or the XDG file when only that one exists.
 */
async function configPath(ctx: Context, fl: FlagView): Promise<[PathSpec, string]> {
  const named = fl.asStr('file')
  if (named === '-')
    throw new GitError(
      (await inside(ctx, fl)) !== null
        ? 'writing to stdin is not supported'
        : 'not in a git directory',
    )
  if (named !== undefined) return [startPoint(fl).join(named), named]
  const env = ctx.env ?? {}
  if (fl.asBool('global')) {
    const override = env.GIT_CONFIG_GLOBAL
    if (override !== undefined) return [PathSpec.fromStrPath(override, undefined, '/'), override]
    const home = env.HOME ?? ''
    if (!home) throw new GitError('$HOME not set')
    const target = `${home}/.gitconfig`
    const configured = env.XDG_CONFIG_HOME ?? ''
    const xdg = `${configured === '' ? `${home}/.config` : configured}/git/config`
    const vfs = requireVfs(ctx)
    const shown =
      (await readOptional(vfs, PathSpec.fromStrPath(target, undefined, '/'))) === null &&
      (await readOptional(vfs, PathSpec.fromStrPath(xdg, undefined, '/'))) !== null
        ? xdg
        : target
    return [PathSpec.fromStrPath(shown, undefined, '/'), shown]
  }
  if (fl.asBool('system')) {
    const shown = env.GIT_CONFIG_SYSTEM ?? SYSTEM_CONFIG
    return [PathSpec.fromStrPath(shown, undefined, '/'), shown]
  }
  const location = await inside(ctx, fl)
  if (location === null) throw new GitError('not in a git directory')
  const path = location.commondir.join('config')
  return [path, localLabel(fl, location, path)]
}

/**
 * Take a config file's lock and hold it, or git's refusal. git refuses when
 * the file's folder is missing, when the lock is already there (another writer
 * holds it) or when it cannot be made, on a read-only mount among others. The
 * look and the create are two ops, since the dispatcher has no exclusive
 * create.
 */
async function holdLock(vfs: Files, lock: PathSpec, shown: string): Promise<IOResult | null> {
  const folder = await statOf(vfs, lock.parent)
  let reason: string
  if (folder === null) reason = posixPhrase('ENOENT')
  else if (folder.type !== FileType.DIRECTORY) reason = posixPhrase('ENOTDIR')
  else if (await exists(vfs, lock)) reason = posixPhrase('EEXIST')
  else {
    try {
      await vfs.write(lock, new Uint8Array())
      return null
    } catch (err) {
      reason = strerrorOf(err)
    }
  }
  return new IOResult({
    exitCode: LOCK_EXIT,
    stderr: encodeText(`error: could not lock config file ${shown}: ${reason}\n`),
  })
}

/** Refuse a line naming more than one config file. */
function oneFile(fl: FlagView): void {
  const scopes = ['global', 'system', 'local', 'worktree'].filter((flag) => fl.asBool(flag)).length
  if (scopes + (fl.asStr('file') !== undefined ? 1 : 0) > 1)
    throw new ConfigUsageError('only one config file at a time')
}

/**
 * Refuse options git does not know on this form of write, naming the first one
 * on the line: `--all` and `--value` belong to `set` and `unset`, and the
 * reading options to the reads.
 */
function unknownOption(ctx: Context, given: string[]): void {
  if (given.length === 0) return
  const argv = ctx.argv ?? []
  const word =
    argv
      .slice(argv.indexOf('config') + 1)
      .find((text) => given.some((name) => text === name || text.startsWith(`${name}=`))) ??
    given[0] ??
    ''
  const spec = ctx.spec ?? new CommandSpec({ name: '' })
  throw new UsageError(...gitOptionRefusal(word, spec.name, spec))
}

/**
 * A set, `--add` or unset, or null when the line reads. `set`, `unset`,
 * `--add`, `--unset` and the two-word set change one file, holding its lock
 * from the read to the write. What else writes (a value pattern, `--all`, a
 * type, `--replace-all`, `--worktree`, the section subcommands, `edit`) stays
 * refused.
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
  const adding = writes.length === 1 && writes[0] === 'add'
  let value: string | null
  if (subcommand === 'set' || subcommand === 'unset') {
    unknownOption(
      ctx,
      (
        [
          ['--default', fl.asStr('default') !== undefined],
          ['--name-only', fl.asBool('name_only')],
          ['--show-origin', fl.asBool('show_origin')],
        ] as const
      )
        .filter(([, on]) => on)
        .map(([name]) => name),
    )
    words = words.slice(1)
    const count = subcommand === 'set' ? 2 : 1
    if (words.length !== count) throw new ConfigUsageError(usageOf(count, count))
    if (fl.asBool('all') || fl.asStr('value') !== undefined) return readOnly()
    if (fl.asBool('fixed_value'))
      throw new GitError(
        subcommand === 'set'
          ? '--fixed-value only applies with --value=<pattern>'
          : "--fixed-value only applies with 'value-pattern'",
      )
    value = subcommand === 'set' ? (words[1] ?? '') : null
  } else if (subcommand !== undefined && WRITING_SUBCOMMANDS.includes(subcommand)) return readOnly()
  else if (writes.length === 0 && words.length < 2) return null
  else {
    unknownOption(
      ctx,
      (
        [
          ['--all', fl.asBool('all')],
          ['--value', fl.asStr('value') !== undefined],
        ] as const
      )
        .filter(([, on]) => on)
        .map(([name]) => name),
    )
    for (const [wrong, message] of [
      [fl.asStr('default') !== undefined, '--default is only applicable to --get'],
      [fl.asBool('name_only'), '--name-only is only applicable to --list or --get-regexp'],
      [
        fl.asBool('show_origin'),
        '--show-origin is only applicable to --get, --get-all, --get-regexp, and --list',
      ],
    ] as const)
      if (wrong) throw new ConfigUsageError(message)
    if (adding) {
      if (words.length !== 2) throw new ConfigUsageError(usageOf(2, 2))
      value = words[1] ?? ''
    } else if (writes.length === 1 && writes[0] === 'unset') {
      if (words.length < 1 || words.length > 2) throw new ConfigUsageError(usageOf(1, 2))
      if (words.length === 2) return readOnly()
      value = null
    } else if (words.length === 2) value = words[1] ?? ''
    else return readOnly()
    if (fl.asBool('fixed_value'))
      throw new ConfigUsageError("--fixed-value only applies with 'value-pattern'")
  }
  oneFile(fl)
  if (valueKind(fl) !== null || fl.asBool('worktree')) return readOnly()
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
  const [path, shown] = await configPath(ctx, fl)
  const vfs = requireVfs(ctx)
  const lock = PathSpec.fromStrPath(`${path.dotted ?? path.virtual}.lock`, undefined, '/')
  const refused = await holdLock(vfs, lock, shown)
  if (refused !== null) return [null, refused]
  try {
    const data = await readOptional(vfs, path)
    if (data === null && value === null)
      return [null, new IOResult({ exitCode: NOTHING_TO_CHANGE_EXIT })]
    const edited = configEdit(data === null ? '' : decodeText(data), key, value, adding, shown)
    if (edited instanceof IOResult) return [null, edited]
    await vfs.write(path, encodeText(edited))
  } finally {
    await removeFile(vfs, lock)
  }
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
