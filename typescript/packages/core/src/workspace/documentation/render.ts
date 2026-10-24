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

import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { standardRequest } from '../../commands/spec/standard.ts'
import { CommandSpec } from '../../commands/spec/types.ts'
import { nodeHelp, ownsArgv } from '../../commands/cli/walk.ts'
import type { CommandSpecInit, UsageStyle } from '../../commands/spec/types.ts'
import { effectivePathMode } from '../../context/session_context.ts'
import { decide } from '../../policy/match/decide.ts'
import { patternReaches, splitPattern } from '../../policy/match/pattern.ts'
import { Outcome } from '../../policy/types.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { isGlob, pathVisible } from '../../utils/hidden.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { unlistedService } from '../node/admission.ts'
import type { SessionState } from '../session/session.ts'
import { ASKS, CHANGES, INTRO, READS, REFUSED, WALKS } from './constants.ts'
import type { Change } from './types.ts'

const SHARED: ReadonlySet<string> = new Set(
  [...GENERIC_COMMANDS, ...GENERAL_COMMANDS].map((c) => c.name),
)
const SEARCHES: readonly string[] = ['grep -r', 'rg']
const FINDS: readonly string[] = ['grep', 'rg']

/**
 * The mounts the documents describe, each with its prefix and the mode in
 * force there: every one the session sees but mirage's own.
 */
function* listed(
  registry: MountRegistry,
  session: SessionState,
): Generator<[MountEntry, string, MountMode]> {
  for (const mount of [...registry.visibleMounts()].sort((a, b) =>
    compareCodePoints(a.prefix, b.prefix),
  )) {
    const prefix = mount.prefix.replace(/\/$/, '') || '/'
    if (
      ['/dev', '/usr/bin', '/.bash_history'].includes(prefix) ||
      ['dev', 'history', 'bin', 'document'].includes(mount.vfs.name) ||
      !pathVisible(session.visibility, prefix)
    )
      continue
    yield [mount, prefix, effectivePathMode(prefix, mount.prefix, mount.mode, session)]
  }
}

/**
 * Whether the session's profile lets a line of `words` run in `cwd`: the
 * documents name nothing the profile refuses. Empty `words` is a
 * redirection, which no rule names. `inside` names a file under `cwd`, so
 * that a rule written for paths there speaks; a CLI names none. `registry`
 * holds the CLIs, so that a CLI reaching a service is refused as execution
 * refuses it under a profile that hides paths; null for a file command.
 */
function allowed(
  session: SessionState,
  cwd: string,
  words: readonly string[],
  inside = false,
  registry: MountRegistry | null = null,
): boolean {
  const [command, ...argv] = words
  if (command === undefined) return true
  const paths = inside ? [PathSpec.fromStrPath(`${cwd.replace(/\/+$/, '')}/<file>`)] : []
  const ctx = { command, paths, argv, cwd }
  if (registry !== null && unlistedService(ctx, registry, session)) return false
  return decide(ctx, session.commands).outcome !== Outcome.DENY
}

/**
 * The lines that stand for `words` under the session's profile: the words as
 * they stand, and followed by what each longer pattern in its allow list adds
 * (`rm -f` where the list holds only that), unless `spec` answers that line
 * with `--help` or `--version`. A null `spec` counts every form.
 */
function forms(
  session: SessionState,
  words: readonly string[],
  spec: CommandSpec | null,
): (readonly string[])[] {
  const found: (readonly string[])[] = [words]
  const [command] = words
  const allow = session.commands?.allow ?? null
  if (command !== undefined && allow !== null) {
    for (const pattern of allow) {
      const form = [...words, ...splitPattern(pattern).slice(words.length)]
      if (
        form.length > words.length &&
        patternReaches(pattern, words) &&
        standardRequest(command, spec, form.slice(1)) === null
      )
        found.push(form)
    }
  }
  return found
}

/**
 * Whether the profile lets some line of `words` do its work on a file under
 * `path`. A form starting with one of the `claimed` longer commands, which
 * are answered on their own, does not count here.
 */
function runnable(
  session: SessionState,
  mount: MountEntry,
  path: string,
  words: readonly string[],
  claimed: readonly (readonly string[])[] = [],
): boolean {
  const [command] = words
  const spec = command === undefined ? null : mount.specFor(command)
  return forms(session, words, spec)
    .filter((form) => !claimed.some((k) => k.every((w, i) => form[i] === w)))
    .some((form) => allowed(session, path, form, true))
}

/**
 * Whether the profile lets `change` run at `path`. A longer form another
 * change names counts for that change alone where it runs on other ops
 * (`tee -a` appends where `tee` writes); one running on more ops (`rm -r`)
 * does this change's work on a file too.
 */
function admitted(session: SessionState, mount: MountEntry, path: string, change: Change): boolean {
  const size = change.command.length
  const claimed = CHANGES.filter(
    (other) =>
      other.command.length > size &&
      change.command.every((w, i) => other.command[i] === w) &&
      !change.needs.every((ops) =>
        other.needs.some((more) => ops.every((op) => more.includes(op))),
      ),
  ).map((other) => other.command)
  return runnable(session, mount, path, change.command, claimed)
}

/**
 * Whether the profile lets the mount's own command `name` run at `path`
 * without changing files, and whether it lets it change them. A command tree
 * answers leaf by leaf, each by its own `write`.
 */
function uses(
  session: SessionState,
  mount: MountEntry,
  path: string,
  name: string,
): [boolean, boolean] {
  const tree = mount.cliFor(name)
  if (tree === null) {
    const ok = runnable(session, mount, path, [name])
    const writes = mount.mayWrite(name)
    return [ok && !writes, ok && writes]
  }
  const leaves = Object.entries(tree.handlers)
    .filter(([, handler]) => handler.fn !== null)
    .map(
      ([verbs, handler]) =>
        [
          handler.write,
          runnable(session, mount, path, [name, ...verbs.split(' ').filter(Boolean)]),
        ] as const,
    )
  return [leaves.some(([write, ok]) => ok && !write), leaves.some(([write, ok]) => ok && write)]
}

/** The mount's own commands that the profile lets change files at `path`. */
function writers(session: SessionState, mount: MountEntry, path: string): string[] {
  return Object.keys(mount.commands())
    .filter((n) => !SHARED.has(n))
    .sort(compareCodePoints)
    .filter((n) => uses(session, mount, path, n)[1])
}

function works(mount: MountEntry, change: Change): boolean {
  return change.needs.some((ops) => ops.every((op) => mount.answers(op)))
}

function code(text: string): string {
  return '`' + text.replaceAll('|', '\\|') + '`'
}

function listing(items: readonly string[]): string {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`
}

function agree(items: readonly string[], verb: string): string {
  return items.length > 1 ? verb : verb + 's'
}

/** `text` in a code fence longer than any fence line inside it, spaces around one included. */
function fenced(text: string, info: string): string {
  const fence = '`'.repeat(
    Math.max(
      3,
      ...text
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /^`+$/.test(s))
        .map((s) => s.length + 1),
    ),
  )
  return `${fence}${info}\n${text}\n${fence}`
}

function table(
  head: readonly [string, string],
  rows: readonly (readonly [string, string])[],
): string {
  return [
    `| ${head[0]} | ${head[1]} |`,
    '| --- | --- |',
    ...rows.map(([path, text]) => `| ${path} | ${text} |`),
  ].join('\n')
}

/**
 * The mode VFS.md states for `path`: `read` where a write mode lets no
 * command the profile allows change a file there, neither a Unix one nor
 * one of the mount's own.
 */
function granted(
  session: SessionState,
  mount: MountEntry,
  path: string,
  mode: MountMode,
): MountMode {
  if (
    mode === MountMode.WRITE &&
    writers(session, mount, path).length === 0 &&
    !CHANGES.some((c) => admitted(session, mount, path, c) && works(mount, c))
  )
    return MountMode.READ
  return mode
}

/** What one path supports, as VFS.md states it. */
function supported(
  session: SessionState,
  mount: MountEntry,
  path: string,
  mode: MountMode,
): string {
  const runs = (words: readonly string[]): boolean => runnable(session, mount, path, words)
  const reads = READS.filter((c) => runs([c])).map(code)
  const changes = CHANGES.filter((c) => admitted(session, mount, path, c))
  const working = changes
    .filter((c) => mode !== MountMode.READ && works(mount, c))
    .map((c) => c.label)
  const unrestricted = reads.length === READS.length && changes.length === CHANGES.length
  const parts: string[] = []
  if (unrestricted && working.length > 0 && 2 * working.length > changes.length) {
    parts.push('Almost all Unix commands.')
  } else {
    let text = 'Commands that read files'
    if (reads.length > 0) text += ` (${reads.join(', ')} and the rest)`
    if (working.length > 0) text += `, and ${listing(working)}`
    parts.push(text + '.')
  }
  const name = code(mount.vfs.name)
  const word = mount.vfs.wholeWordSearch ? ['-w'] : []
  const searches = SEARCHES.filter((c) => runs([...c.split(' '), ...word])).map(code)
  if (searches.length > 0 && mount.answers('files_containing')) {
    const wordText = word.length > 0 ? ' with `-w`' : ''
    parts.push(`${listing(searches)}${wordText} ${agree(searches, 'use')} ${name} search.`)
  }
  const finds = FINDS.filter((c) => runs([c])).map(code)
  if (finds.length > 0 && mount.answers('lines_containing'))
    parts.push(`${listing(finds)} ${agree(finds, 'ask')} ${name} for the matching lines.`)
  const asks = ASKS.filter(([op, command]) => mount.answers(op) && runs(command.split(' '))).map(
    ([, command]) => code(command),
  )
  if (asks.length > 0)
    parts.push(`${listing(asks)} ${agree(asks, 'ask')} ${name} instead of reading a file.`)
  const offered = (name: string): boolean => {
    const [reads, writes] = uses(session, mount, path, name)
    return reads || (writes && mode !== MountMode.READ)
  }
  const own = Object.keys(mount.commands())
    .filter((n) => !SHARED.has(n))
    .sort(compareCodePoints)
    .filter(offered)
    .map(code)
  if (own.length > 0) parts.push(`Also ${listing(own)}.`)
  return parts.join(' ')
}

/** Where one path differs from a local filesystem. */
function limitations(
  session: SessionState,
  mount: MountEntry,
  path: string,
  mode: MountMode,
): string {
  const runs = (words: readonly string[]): boolean => runnable(session, mount, path, words)
  const parts: string[] = []
  if (mode === MountMode.READ) {
    parts.push('Read only: no command changes files.')
  } else {
    const changes = CHANGES.filter((c) => admitted(session, mount, path, c))
    const missing = changes.filter((c) => !works(mount, c)).map((c) => c.label)
    if (missing.length > 0 && missing.length === changes.length)
      parts.push('No Unix command changes files.')
    else if (missing.length > 0) parts.push(`Not supported: ${missing.join(', ')}.`)
  }
  const vfs = mount.vfs
  const word = vfs.wholeWordSearch ? ['-w'] : []
  const searches = SEARCHES.filter((c) => runs([...c.split(' '), ...word])).map(code)
  if (searches.length > 0 && mount.answers('files_containing')) {
    const reads = `${listing(searches)} ${agree(searches, 'read')}`
    if (vfs.wholeWordSearch) parts.push(`Without \`-w\`, ${reads} every file.`)
    if (vfs.searchable !== null)
      parts.push(
        `${code(vfs.name)} search covers only ${listing(vfs.searchable.map(code))}; ` +
          `${reads} every other file.`,
      )
  }
  if (vfs.walkLimit >= 0) {
    const limit = String(vfs.walkLimit)
    const walks = WALKS.filter((c) => runs(c.split(' '))).map(code)
    const refused = REFUSED.filter((c) => runs(c.split(' '))).map(code)
    let text =
      walks.length > 0
        ? `${listing(walks)} ${agree(walks, 'stop')} after ${limit} files; a glob matching more`
        : `A glob matching more than ${limit} files`
    text += refused.length > 0 ? `, ${listing(refused)} are refused` : ' is refused'
    parts.push(text + '.')
  }
  return parts.join(' ') || 'None.'
}

/**
 * Describe the current namespace without enumerating backend data: each
 * path, its layout, and the Unix commands it supports.
 */
export function vfsMd(registry: MountRegistry, session: SessionState): string {
  const paths: [string, string][] = []
  const layouts: string[] = []
  const commands: [string, string][] = []
  const limits: [string, string][] = []
  const vis = session.visibility
  for (const [mount, prefix, mode] of listed(registry, session)) {
    const shown = granted(session, mount, prefix, mode)
    paths.push([code(prefix), `${code(mount.vfs.name)}, ${shown}`])
    commands.push([code(prefix), supported(session, mount, prefix, shown)])
    limits.push([code(prefix), limitations(session, mount, prefix, shown)])
    // Backend prose is not a permission document. Under a restricted view
    // it can advertise hidden paths or verbs, so describe only structured
    // facts rather than interpolate unrestricted guidance.
    if (
      vis.paths === null &&
      vis.shown === null &&
      session.commands === null &&
      mode === mount.mode &&
      mount.vfs.vfsMd.trim() !== ''
    ) {
      const layout = mount.vfs.vfsMd
        .replaceAll('{prefix}', prefix)
        .replace(/^\n+|\n+$/g, '')
        .trimEnd()
      layouts.push(`## ${code(prefix)} layout\n\n${fenced(layout, 'text')}`)
    }
    for (const entry of vis.shown?.entries ?? []) {
      if (entry.mode === null || isGlob(entry.path) || !pathVisible(vis, entry.path)) continue
      if (registry.tryMountFor(entry.path) === mount) {
        const effective = granted(
          session,
          mount,
          entry.path,
          effectivePathMode(entry.path, mount.prefix, mount.mode, session),
        )
        const at = code(entry.path)
        paths.push([at, `${code(mount.vfs.name)}, ${effective}`])
        commands.push([at, supported(session, mount, entry.path, effective)])
        limits.push([at, limitations(session, mount, entry.path, effective)])
      }
    }
  }
  const parts = [
    '---\nname: workspace-filesystem\ndescription: The virtual filesystem layout of this workspace.\n---',
    '# Virtual Filesystem',
    INTRO,
  ]
  if (paths.length === 0) {
    parts.push('No paths are visible.')
  } else {
    parts.push(
      table(['Path', 'Description'], paths),
      ...layouts,
      '## Supported Unix Commands for VFS',
      'Unix commands work on each path as on a local filesystem, as far as the path supports them:',
      table(['Path', 'Supported'], commands),
      '## Limitations of Unix Commands for VFS',
      'Where a path differs from a local filesystem:',
      table(['Path', 'Limitations'], limits),
    )
  }
  parts.push(
    "Run `man` to list every command, and `man <cmd>` or `<cmd> --help` for one command's usage.",
  )
  return parts.join('\n\n') + '\n'
}

/**
 * The help pages of one CLI node and its descendants the profile allows. A
 * node gets a page when the profile allows it or leads to a descendant it
 * allows, so a group's own options stay documented; a page lists only the
 * children leading to an allowed one. A leaf counts a longer form its allow
 * list names (`gws gmail read --id`).
 */
export function cliPages(
  head: string,
  node: CommandSpec,
  style: UsageStyle,
  session: SessionState,
  registry: MountRegistry,
  path: readonly string[] = [],
): string[] {
  const children = node.subcommands.map(
    (child) =>
      [child, cliPages(head, child, style, session, registry, [...path, child.name])] as const,
  )
  const pages: string[] = []
  const words = [head, ...path]
  const kept = children.filter(([, found]) => found.length > 0).map(([child]) => child)
  if (
    kept.length > 0 ||
    (children.length === 0 ? forms(session, words, null) : [words]).some((form) =>
      allowed(session, session.cwd, form, false, registry),
    )
  ) {
    const name = words.join(' ')
    const init: CommandSpecInit = node
    const text = nodeHelp(name, new CommandSpec({ ...init, subcommands: kept }), style).trimEnd()
    pages.push(`## \`${name}\`\n\n${fenced(text, 'text')}`)
  }
  for (const [, found] of children) pages.push(...found)
  return pages
}

/**
 * Render the skill: the registered CLIs the session's profile lets it run,
 * from their specs. Mirrors Python's `skill_md`.
 */
export function skillMd(registry: MountRegistry, session: SessionState): string {
  const parts = [
    '---\nname: workspace-commands\ndescription: The CLIs registered in this workspace and how to call them.\n---',
    '# Available commands',
  ]
  const pages: string[] = []
  for (const [head, install] of [...registry.clis.items()].sort(([a], [b]) =>
    compareCodePoints(a, b),
  )) {
    const found = cliPages(head, install.cli.spec, install.cli.spec.usageStyle, session, registry)
    pages.push(...found)
    if (found.length > 0 && ownsArgv(install.cli))
      pages.push(
        'This program parses its own arguments; only its registered description is available here.',
      )
  }
  if (pages.length > 0) {
    parts.push(
      "These commands are registered with this shell; `<cmd> --help` shows each one's usage.",
      ...pages,
    )
  } else {
    parts.push('No CLIs are registered.')
  }
  return parts.join('\n\n') + '\n'
}
