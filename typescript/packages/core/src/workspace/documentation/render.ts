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
import type { CommandSpec } from '../../commands/spec/types.ts'
import { nodeHelp, ownsArgv } from '../../commands/cli/walk.ts'
import type { UsageStyle } from '../../commands/spec/types.ts'
import { effectivePathMode } from '../../context/session_context.ts'
import { decide } from '../../policy/match/decide.ts'
import { Outcome } from '../../policy/types.ts'
import { MountMode } from '../../types.ts'
import { isGlob, pathVisible } from '../../utils/hidden.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import { ASKS, CHANGES, READS, REFUSED, WALKS } from './constants.ts'
import type { Change } from './types.ts'

const SHARED: ReadonlySet<string> = new Set(
  [...GENERIC_COMMANDS, ...GENERAL_COMMANDS].map((c) => c.name),
)

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
 * redirection, which no rule names.
 */
function allowed(session: SessionState, cwd: string, words: readonly string[]): boolean {
  const [command, ...argv] = words
  if (command === undefined) return true
  return decide({ command, paths: [], argv, cwd }, session.commands).outcome !== Outcome.DENY
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

/** `text` in a code fence longer than any fence line inside it. */
function fenced(text: string, info: string): string {
  const fence = '`'.repeat(
    Math.max(
      3,
      ...text
        .split('\n')
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

/** What one mount supports, as VFS.md states it. */
function supported(
  session: SessionState,
  mount: MountEntry,
  prefix: string,
  mode: MountMode,
): string {
  const reads = READS.filter((c) => allowed(session, prefix, [c])).map(code)
  const changes = CHANGES.filter((c) => allowed(session, prefix, c.command))
  const working = changes
    .filter((c) => mode !== MountMode.READ && works(mount, c))
    .map((c) => c.label)
  const parts: string[] = []
  if (working.length > 0 && 2 * working.length > changes.length) {
    parts.push('Almost all Unix commands.')
  } else {
    let text = 'Commands that read files'
    if (reads.length > 0) text += ` (${reads.join(', ')} and the rest)`
    if (working.length > 0) text += `, and ${listing(working)}`
    parts.push(text + '.')
  }
  const name = code(mount.vfs.name)
  const grep = allowed(session, prefix, ['grep'])
  if (grep && mount.answers('files_containing')) {
    const word = mount.vfs.wholeWordSearch ? ' with `-w`' : ''
    parts.push(`\`grep -r\` and \`rg\`${word} use ${name} search.`)
  }
  if (grep && mount.answers('lines_containing'))
    parts.push(`\`grep\` and \`rg\` ask ${name} for the matching lines.`)
  const asks = ASKS.filter(
    ([op, command]) => mount.answers(op) && allowed(session, prefix, command.split(' ')),
  ).map(([, command]) => code(command))
  if (asks.length > 0) parts.push(`${listing(asks)} ask ${name} instead of reading a file.`)
  const own = Object.keys(mount.commands())
    .filter((n) => !SHARED.has(n))
    .sort(compareCodePoints)
    .filter((n) => allowed(session, prefix, [n]))
    .map(code)
  if (own.length > 0) parts.push(`Also ${listing(own)}.`)
  return parts.join(' ')
}

/** Where one mount differs from a local filesystem. */
function limitations(
  session: SessionState,
  mount: MountEntry,
  prefix: string,
  mode: MountMode,
): string {
  const parts: string[] = []
  if (mode === MountMode.READ) {
    parts.push('Read only: no command changes files.')
  } else {
    const changes = CHANGES.filter((c) => allowed(session, prefix, c.command))
    const missing = changes.filter((c) => !works(mount, c)).map((c) => c.label)
    if (missing.length > 0 && missing.length === changes.length)
      parts.push('No command changes files.')
    else if (missing.length > 0) parts.push(`Not supported: ${missing.join(', ')}.`)
  }
  const vfs = mount.vfs
  if (allowed(session, prefix, ['grep']) && mount.answers('files_containing')) {
    if (vfs.wholeWordSearch) parts.push('Without `-w`, `grep -r` and `rg` read every file.')
    if (vfs.searchable !== null)
      parts.push(
        `${code(vfs.name)} search covers only ${listing(vfs.searchable.map(code))}; ` +
          '`grep -r` and `rg` read every other file.',
      )
  }
  if (vfs.fullScanLimit >= 0) {
    const walks = WALKS.filter((c) => allowed(session, prefix, c.split(' '))).map(code)
    const refused = REFUSED.filter((c) => allowed(session, prefix, c.split(' '))).map(code)
    let text = `${listing(walks)} stop after ${String(vfs.fullScanLimit)} files`
    if (refused.length > 0) text += `; a glob matching more, ${listing(refused)} are refused`
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
    paths.push([code(prefix), `${code(mount.vfs.name)}, ${mode}`])
    commands.push([code(prefix), supported(session, mount, prefix, mode)])
    limits.push([code(prefix), limitations(session, mount, prefix, mode)])
    // Backend prose is not a permission document. Under a restricted view
    // it can advertise hidden paths or verbs, so describe only structured
    // facts rather than interpolate unrestricted guidance.
    if (
      vis.paths === null &&
      vis.shown === null &&
      session.commands === null &&
      mode === mount.mode
    ) {
      const texts = [mount.vfs.prompt]
      if (mode !== MountMode.READ) texts.push(mount.vfs.writePrompt)
      const layout = texts
        .filter((t) => t.trim() !== '')
        .map((t) =>
          t
            .replaceAll('{prefix}', prefix)
            .replace(/^\n+|\n+$/g, '')
            .trimEnd(),
        )
        .join('\n\n')
      if (layout !== '') layouts.push(`## ${code(prefix)} layout\n\n${fenced(layout, 'text')}`)
    }
    for (const entry of vis.shown?.entries ?? []) {
      if (entry.mode === null || isGlob(entry.path) || !pathVisible(vis, entry.path)) continue
      if (registry.tryMountFor(entry.path) === mount) {
        const effective = effectivePathMode(entry.path, mount.prefix, mount.mode, session)
        paths.push([code(entry.path), `${code(mount.vfs.name)}, ${effective}`])
      }
    }
  }
  const parts = [
    '---\nname: workspace-filesystem\ndescription: The virtual filesystem layout of this workspace.\n---',
    '# Virtual Filesystem',
    'You work in a terminal over a virtual filesystem. Read files with shell commands; access is checked for each operation.',
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

export function cliPages(
  head: string,
  node: CommandSpec,
  style: UsageStyle,
  session: SessionState,
  path: readonly string[] = [],
): string[] {
  if (!allowed(session, session.cwd, [head, ...path])) return []
  const name = [head, ...path].join(' ')
  const text = nodeHelp(name, node, style).trimEnd()
  const pages = [`## \`${name}\`\n\n${fenced(text, 'text')}`]
  for (const child of node.subcommands)
    pages.push(...cliPages(head, child, style, session, [...path, child.name]))
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
    const found = cliPages(head, install.cli.spec, install.cli.spec.usageStyle, session)
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
