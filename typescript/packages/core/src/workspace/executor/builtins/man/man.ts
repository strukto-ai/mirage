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
import { findChild, listedNode, subcommandRows } from '../../../../commands/cli/walk.ts'
import { BUILTIN_SPECS } from '../../../../commands/spec/builtins.ts'
import {
  argparseParts,
  flagRows,
  operandRows,
  renderHelp,
  usageLine,
} from '../../../../commands/spec/help.ts'
import { SHELL_SPECS, type ShellParse, parseShellOptions } from '../../../../commands/spec/shell.ts'
import { SHELL_SYNOPSES, SYNOPSES } from '../../../../commands/spec/synopsis.ts'
import { type CommandSpec, UsageStyle } from '../../../../commands/spec/types.ts'
import { RegexError } from '../../../../rs/errors.ts'
import { type PosixRegex, posixRegex } from '../../../../rs/regex.ts'
import { byteView, encodeText, utf8Locale } from '../../../../shell/bytes.ts'
import { ShellBuiltin } from '../../../../shell/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { VERSION } from '../../../../version.ts'
import { BASH_BUILTINS, EXEC_WRAPPERS } from '../../../lookup/constants.ts'
import { DEV_PREFIX, type MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { envSnapshot } from '../../../session/state.ts'
import { envWidth, fill, optionRows, paragraphs, summary } from '../help/help.ts'
import { result } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'
import {
  DEFAULT_WIDTH,
  HINT,
  MANUAL,
  MAX_WIDTH,
  MIN_WIDTH,
  NO_PAGE,
  SECTION,
  SECTION_RE,
  TAG_INDENT,
  TEXT_INDENT,
  WHATIS_WIDTH,
} from './constants.ts'
import type { ManPage, ManSection } from './types.ts'

const SHELL_WORDS: ReadonlySet<string> = new Set(Object.values(ShellBuiltin))

// Builtins whose page is the spec of another name.
const SPEC_OF: ReadonlyMap<string, string> = new Map([['sh', 'bash']])

/** A page's sections after NAME, leaving out the empty ones. */
function sections(
  synopsis: string,
  description: readonly string[],
  options: readonly (readonly [string, string])[],
  extra: readonly ManSection[] = [],
): ManSection[] {
  const out: ManSection[] = [['SYNOPSIS', [synopsis]]]
  if (description.length > 0) out.push(['DESCRIPTION', description])
  if (options.length > 0) out.push(['OPTIONS', options])
  for (const [head, blocks] of extra) if (blocks.length > 0) out.push([head, blocks])
  return out
}

/**
 * A spec's DESCRIPTION: what its description says after the summary NAME
 * carries, and its epilog; the summary alone when that is all.
 */
function described(spec: CommandSpec): string[] {
  const [lead = '', ...text] = paragraphs(spec.description)
  const rest = [...text, ...paragraphs(spec.epilog)]
  if (rest.length > 0) return rest
  return lead !== '' ? [lead] : []
}

/** The page of a shell builtin, from the spec `help` shows it by: its epilog is the exit status. */
export function builtinPage(name: string): ManPage {
  const spec = SHELL_SPECS[name]
  if (spec === undefined) throw new Error(`no shell spec: ${name}`)
  const [lead = '', ...text] = paragraphs(spec.description)
  const status: ManSection[] =
    spec.epilog !== null && spec.epilog !== '' ? [['EXIT STATUS', [spec.epilog]]] : []
  return {
    name,
    summary: lead,
    sections: sections(
      SHELL_SYNOPSES[name] ?? '',
      text.length > 0 ? text : [lead],
      optionRows(spec),
      status,
    ),
  }
}

/**
 * The page of a command, from its spec. The synopsis is the program's own
 * first `--help` line where mirage keeps one, else the line the spec's slots
 * spell.
 */
export function specPage(name: string, spec: CommandSpec): ManPage {
  const synopsis =
    SYNOPSES[name] ?? usageLine(name, spec, [], spec.usageStyle).replace(/^Usage: /, '')
  return {
    name,
    summary: summary(spec),
    sections: sections(synopsis, described(spec), flagRows(spec), [
      ['OPERANDS', operandRows(spec)],
    ]),
  }
}

/**
 * The page of one node of an installed CLI, named after its path with
 * hyphens (`git-commit`). The synopsis, the options and the operands are the
 * ones the node's `--help` prints, in the root's dialect.
 */
export function cliPage(
  head: string,
  path: readonly string[],
  node: CommandSpec,
  style: UsageStyle,
): ManPage {
  const words = [head, ...path].join(' ')
  const rows = subcommandRows(node)
  const listed = listedNode(node, style)
  let synopsis: string
  let operands: [string, string][]
  let options: [string, string][]
  if (style === UsageStyle.ARGPARSE || style === UsageStyle.COBRA) {
    const [usage, parsedOperands, parsedOptions] = argparseParts(words, listed, rows)
    synopsis = usage.replace(/^usage: /, '')
    operands = parsedOperands
    options = parsedOptions
  } else {
    synopsis = usageLine(words, listed, rows, style).replace(/^Usage: /, '')
    operands = operandRows(listed)
    options = flagRows(listed)
  }
  return {
    name: words.replaceAll(' ', '-'),
    summary: node.description ?? '',
    sections: sections(synopsis, described(node), options, [
      ['OPERANDS', operands.filter(([, does]) => does !== '')],
      ['COMMANDS', rows],
    ]),
  }
}

/**
 * The page of a shell builtin: bash's from its help, else the spec of one
 * that is a program elsewhere (`man`, `sleep`, `env`).
 */
function shellPage(name: string): ManPage | null {
  if (SHELL_SYNOPSES[name] !== undefined && BASH_BUILTINS.has(name)) return builtinPage(name)
  const spec = SHELL_SPECS[name] ?? BUILTIN_SPECS[SPEC_OF.get(name) ?? name]
  if (SHELL_WORDS.has(name) && spec !== undefined) return specPage(name, spec)
  return null
}

/**
 * The page of a mounted command, null when no mount registers it. A name has
 * one spec however many mounts register it, so the first registration is the
 * page. A wrapper no mount registers (`egrep`) has the page of the program it
 * runs, as Debian links one to the other.
 */
function commandPage(name: string, registry: MountRegistry): ManPage | null {
  for (const mount of registry.allMounts()) {
    if (mount.prefix === DEV_PREFIX) continue
    const cmd = mount.resolveCommand(name)
    if (cmd !== null) return specPage(name, cmd.spec)
  }
  const runs = EXEC_WRAPPERS.get(name)
  if (runs !== undefined) {
    const page = commandPage(runs[0], registry)
    if (page !== null) return { name, summary: page.summary, sections: page.sections }
  }
  return null
}

/** The node a hyphenated rest of a page name spells below `node`. */
function subpage(node: CommandSpec, rest: string): [CommandSpec, string[]] | null {
  for (const child of node.subcommands) {
    for (const word of [child.name, ...child.aliases]) {
      if (rest === word) return [child, [child.name]]
      if (rest.startsWith(`${word}-`)) {
        const deeper = subpage(child, rest.slice(word.length + 1))
        if (deeper !== null) return [deeper[0], [child.name, ...deeper[1]]]
      }
    }
  }
  return null
}

/**
 * The page an installed CLI has under a name: its head word, or a subcommand
 * spelled with hyphens (`git-commit`). A head wins over another install's
 * subcommand spelled the same way.
 */
function cliLookup(name: string, registry: MountRegistry): ManPage | null {
  const installs = registry.clis.items()
  const exact = installs.get(name)
  if (exact !== undefined) return cliPage(name, [], exact.cli.spec, exact.cli.spec.usageStyle)
  for (const [head, install] of installs) {
    const spec = install.cli.spec
    if (name.startsWith(`${head}-`)) {
      const found = subpage(spec, name.slice(head.length + 1))
      if (found !== null) return cliPage(head, found[1], found[0], spec.usageStyle)
    }
  }
  return null
}

/**
 * Every page a name has, in the order `man` prefers them: an installed CLI's,
 * then a builtin's, then a mounted command's.
 */
export function pagesOf(name: string, registry: MountRegistry): ManPage[] {
  return [cliLookup(name, registry), shellPage(name), commandPage(name, registry)].filter(
    (page): page is ManPage => page !== null,
  )
}

/** The page a name opens, the first of `pagesOf`. */
export function findPage(name: string, registry: MountRegistry): ManPage | null {
  return pagesOf(name, registry)[0] ?? null
}

/** Every page of an installed CLI's tree, the node's first. */
function* cliPages(
  head: string,
  path: readonly string[],
  node: CommandSpec,
  style: UsageStyle,
): Generator<ManPage> {
  yield cliPage(head, path, node, style)
  for (const child of node.subcommands) yield* cliPages(head, [...path, child.name], child, style)
}

/** Every page of the manual, one per name, sorted by name. */
function allPages(registry: MountRegistry): ManPage[] {
  const pages = new Map<string, ManPage>()
  for (const [head, install] of registry.clis.items()) {
    const spec = install.cli.spec
    for (const page of cliPages(head, [], spec, spec.usageStyle)) {
      if (page.name === head || !pages.has(page.name)) pages.set(page.name, page)
    }
  }
  const words = new Set<string>([
    ...Object.keys(SHELL_SYNOPSES).filter((name) => BASH_BUILTINS.has(name)),
    ...SHELL_WORDS,
  ])
  for (const mount of registry.allMounts()) {
    if (mount.prefix !== DEV_PREFIX) for (const cmd of mount.allCommands()) words.add(cmd.name)
  }
  for (const [word, [runs]] of EXEC_WRAPPERS) if (words.has(runs)) words.add(word)
  for (const word of words) {
    if (pages.has(word)) continue
    const found = findPage(word, registry)
    if (found !== null) pages.set(word, found)
  }
  return [...pages].sort(([a], [b]) => compareCodePoints(a, b)).map(([, page]) => page)
}

/** A header or footer line: one part at each margin, one centered. */
function three(left: string, center: string, right: string, length: number): string {
  let line = left
  if (center !== '') {
    const start = Math.max(Math.floor((length - center.length + 1) / 2), line.length + 1)
    line = line.padEnd(start) + center
  }
  return line.padEnd(Math.max(length - right.length, line.length + 1)) + right
}

/**
 * A page laid out as man prints it with justification and hyphenation off: a
 * header, NAME, each section with its text indented and its tags hanging,
 * and a footer. Lines stop one short of the terminal width.
 */
export function renderPage(page: ManPage, width: number): string {
  const length = width - 1
  const title = `${page.name.toUpperCase()}(${SECTION})`
  const text = ' '.repeat(TEXT_INDENT)
  const tagged = ' '.repeat(TAG_INDENT)
  const lines = [three(title, MANUAL, title, length), '']
  const named = page.summary !== '' ? `${page.name} - ${page.summary}` : page.name
  const all: ManSection[] = [['NAME', [named]], ...page.sections]
  for (const [heading, blocks] of all) {
    lines.push(heading)
    blocks.forEach((block, i) => {
      if (i > 0) lines.push('')
      if (typeof block === 'string') {
        lines.push(...fill(block, length - TEXT_INDENT).map((line) => text + line))
        return
      }
      const [tag, does] = block
      let body = fill(does, length - TAG_INDENT)
      const first = body[0]
      if (first !== undefined && tag.length < TAG_INDENT - TEXT_INDENT) {
        lines.push(text + tag.padEnd(TAG_INDENT - TEXT_INDENT) + first)
        body = body.slice(1)
      } else {
        lines.push(text + tag)
      }
      lines.push(...body.map((line) => tagged + line))
    })
    lines.push('')
  }
  lines.push(three(`Mirage ${VERSION}`, '', title, length))
  return `${lines.join('\n')}\n`
}

/** A page's line in `man -f` and `man -k`. */
function whatis(page: ManPage): string {
  const named = `${page.name} (${SECTION})`.padEnd(WHATIS_WIDTH)
  return `${named} - ${page.summary !== '' ? page.summary : '(unknown subject)'}\n`
}

/** man's refusal of its own command line: the message, then the hint, status 1. */
function usageError(message: string): Result {
  return result('man', { exitCode: 1, stderr: `man: ${message}\n${HINT}` })
}

/** What man says of a command line its options refuse, null when they take it. */
function refusal(parse: ShellParse): string | null {
  if (parse.unexpectedValue !== null) {
    const spelled = parse.unexpectedValue.split('=')[0] ?? ''
    return `option '${spelled}' doesn't allow an argument`
  }
  if (parse.invalid === null) return null
  if (!parse.invalid.startsWith('--')) return `invalid option -- '${parse.invalid}'`
  if (parse.candidates.length > 0) {
    const listed = parse.candidates.map((name) => `'${name}'`).join(' ')
    return `option '${parse.invalid}' is ambiguous; possibilities: ${listed}`
  }
  return `unrecognized option '${parse.invalid}'`
}

/**
 * Each page asked for and every page it opens. Words after an installed
 * CLI's head that name its subcommands make one page with it, as
 * `man git commit` opens git-commit.
 */
function* lookup(
  pages: readonly string[],
  registry: MountRegistry,
): Generator<[string, ManPage[]]> {
  let i = 0
  while (i < pages.length) {
    const name = pages[i] ?? ''
    i += 1
    const install = registry.clis.get(name)
    if (install === null) {
      yield [name, pagesOf(name, registry)]
      continue
    }
    const spec = install.cli.spec
    let node: CommandSpec = spec
    const path: string[] = []
    while (i < pages.length) {
      const child = findChild(node, pages[i] ?? '')
      if (child === null) break
      node = child
      path.push(child.name)
      i += 1
    }
    yield [
      name,
      path.length > 0 ? [cliPage(name, path, node, spec.usageStyle)] : pagesOf(name, registry),
    ]
  }
}

/**
 * Run `man`: show the pages asked for, or their summary lines. Status 16
 * when a page is missing, as man-db answers, after the pages it did find; 1
 * for a command line it refuses. $MANWIDTH or $COLUMNS sets the width.
 */
export async function handleMan(
  args: readonly string[],
  registry: MountRegistry,
  session: SessionState,
): Promise<Result> {
  const spec = SHELL_SPECS.man
  const parse = parseShellOptions(spec, [...args])
  const wrong = refusal(parse)
  if (wrong !== null) return usageError(wrong)
  const chosen = parse.flags
  const pages = [...parse.operands]
  if (chosen['?'] !== undefined) {
    return result('man', { out: encodeText(renderHelp('man', spec, [], undefined, SYNOPSES.man)) })
  }
  if (chosen.usage !== undefined) {
    const line = usageLine('man', spec, [], spec.usageStyle, SYNOPSES.man)
    return result('man', { out: encodeText(`${line}\n`) })
  }
  if (chosen.f !== undefined && chosen.k !== undefined) {
    return usageError('-f -k : incompatible options')
  }
  if (chosen.f !== undefined || chosen.k !== undefined) {
    return summaries(pages, registry, chosen.f !== undefined, utf8Locale(envSnapshot(session)))
  }
  if (pages.length === 0) return result('man', { exitCode: 1, stderr: NO_PAGE })
  let section = ''
  if (pages.length > 1 && SECTION_RE.test(pages[0] ?? '')) section = pages.shift() ?? ''
  const width = Math.min(
    envWidth(session, ['MANWIDTH', 'COLUMNS'], MIN_WIDTH, DEFAULT_WIDTH),
    MAX_WIDTH,
  )
  const out: string[] = []
  const errors: string[] = []
  for (const [name, found] of lookup(pages, registry)) {
    if (found.length === 0 || (section !== '' && section !== SECTION)) {
      const where = section !== '' ? ` in section ${section}` : ''
      errors.push(`No manual entry for ${name}${where}\n`)
      continue
    }
    const shown = chosen.a !== undefined ? found : found.slice(0, 1)
    out.push(...shown.map((page) => renderPage(page, width)))
  }
  return result('man', {
    out: out.length > 0 ? encodeText(out.join('')) : null,
    exitCode: errors.length > 0 ? 16 : 0,
    stderr: errors.join(''),
  })
}

/**
 * `man -f` (each page's summary line) or `man -k` (every page whose name or
 * summary the word matches, as a regular expression, ignoring case).
 */
async function summaries(
  words: readonly string[],
  registry: MountRegistry,
  isWhatis: boolean,
  utf8: boolean,
): Promise<Result> {
  if (words.length === 0) {
    return result('man', { exitCode: 1, stderr: `${isWhatis ? 'whatis' : 'apropos'} what?\n` })
  }
  const patterns: PosixRegex[] = []
  for (const word of isWhatis ? [] : words) {
    try {
      patterns.push(posixRegex(byteView(word, utf8), true, 'posix', true, utf8))
    } catch (err) {
      if (!(err instanceof RegexError)) throw err
      const message = `apropos: fatal: regex \`${word}': ${err.message}\n`
      return result('man', { exitCode: 2, stderr: message })
    }
  }
  const found: ManPage[] = []
  const errors: string[] = []
  const every = isWhatis ? [] : allPages(registry)
  for (const [index, word] of words.entries()) {
    let hits: ManPage[] = []
    if (isWhatis) {
      const page = findPage(word, registry)
      hits = page !== null ? [page] : []
    } else {
      const pattern = patterns[index]
      if (pattern !== undefined) {
        for (const page of every) if (await matches(pattern, page, utf8)) hits.push(page)
      }
    }
    if (hits.length === 0) errors.push(`${word}: nothing appropriate.\n`)
    for (const page of hits) if (!found.some((seen) => seen.name === page.name)) found.push(page)
  }
  if (!isWhatis) found.sort((a, b) => compareCodePoints(a.name, b.name))
  return result('man', {
    out: found.length > 0 ? encodeText(found.map(whatis).join('')) : null,
    exitCode: found.length > 0 ? 0 : 16,
    stderr: errors.join(''),
  })
}

/** Whether a keyword matches a page's name or its summary. */
async function matches(pattern: PosixRegex, page: ManPage, utf8: boolean): Promise<boolean> {
  for (const text of [page.name, page.summary]) {
    if ((await pattern.search(byteView(text, utf8))) !== null) return true
  }
  return false
}

/** The `man` arm. */
export function manBuiltin(call: BuiltinCall): Promise<Result> {
  return handleMan([...call.argv.args], call.registry, call.context.session)
}
