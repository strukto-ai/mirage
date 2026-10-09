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

import type { CommandSpec } from '../../commands/spec/types.ts'
import { nodeHelp, ownsArgv } from '../../commands/cli/walk.ts'
import type { UsageStyle } from '../../commands/spec/types.ts'
import { effectivePathMode } from '../../context/session_context.ts'
import { MountMode } from '../../types.ts'
import { isGlob, pathVisible } from '../../utils/hidden.ts'
import { commandVisible, verbVisible } from '../lookup/lookup.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'

const MODE_LINES: Record<MountMode, string> = {
  [MountMode.READ]: 'read-only',
  [MountMode.WRITE]: 'read-write',
  [MountMode.EXEC]: 'read-write; python3 and js can run code here',
}

export function vfsMd(registry: MountRegistry, session: SessionState): string {
  const parts = [
    '# Virtual filesystem',
    'Paths are inside the MIRAGE workspace. Access is checked for each operation; command policies may impose further restrictions.',
  ]
  const vis = session.visibility
  for (const mount of [...registry.visibleMounts()].sort((a, b) =>
    a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0,
  )) {
    const prefix = mount.prefix.replace(/\/$/, '') || '/'
    if (
      ['/dev', '/usr/bin', '/.bash_history'].includes(prefix) ||
      ['dev', 'history', 'bin', 'document'].includes(mount.vfs.name) ||
      !pathVisible(vis, prefix)
    )
      continue
    const mode = effectivePathMode(prefix, mount.prefix, mount.mode)
    parts.push(`## \`${prefix}\`\n\nBackend: \`${mount.vfs.name}\`. Access: ${MODE_LINES[mode]}.`)
    if (
      vis.paths === null &&
      vis.shown === null &&
      vis.commands === null &&
      session.commands === null &&
      mode === mount.mode
    ) {
      if (mount.vfs.prompt) parts.push(mount.vfs.prompt.replaceAll('{prefix}', prefix).trim())
      if (mode !== MountMode.READ && mount.vfs.writePrompt)
        parts.push(mount.vfs.writePrompt.replaceAll('{prefix}', prefix).trim())
    }
    for (const entry of vis.shown?.entries ?? []) {
      if (entry.mode === null || isGlob(entry.path) || !pathVisible(vis, entry.path)) continue
      if (registry.tryMountFor(entry.path) === mount) {
        const effective = effectivePathMode(entry.path, mount.prefix, mount.mode)
        parts.push(`- \`${entry.path}\`: ${MODE_LINES[effective]}.`)
      }
    }
  }
  if (commandVisible('man', session))
    parts.push(
      'Use `man` to discover visible commands and registered CLIs, and `man <cmd>` or `<cmd> --help` for usage.',
    )
  return parts.join('\n\n') + '\n'
}

export function cliPages(
  head: string,
  node: CommandSpec,
  session: SessionState,
  style: UsageStyle,
  path: readonly string[] = [],
): string[] {
  if (!verbVisible(head, path, session)) return []
  const name = [head, ...path].join(' ')
  const text = nodeHelp(name, node, style, (child) =>
    verbVisible(head, [...path, child], session),
  ).trimEnd()
  const fence = '`'.repeat(
    Math.max(
      3,
      ...text
        .split('\n')
        .filter((s) => /^`+$/.test(s))
        .map((s) => s.length + 1),
    ),
  )
  const pages = [`## \`${name}\`\n\n${fence}text\n${text}\n${fence}`]
  for (const child of node.subcommands)
    pages.push(...cliPages(head, child, session, style, [...path, child.name]))
  return pages
}

export function skillMd(registry: MountRegistry, session: SessionState): string {
  const parts = [
    '---\nname: mirage\ndescription: Work with data and registered commands inside a MIRAGE workspace.\n---',
    '# MIRAGE',
    'Run these commands in the MIRAGE terminal. Paths refer to its virtual filesystem. The available commands and access can change with the session profile; permissions are checked on every invocation.',
  ]
  for (const [head, install] of [...registry.clis.items()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (commandVisible(head, session)) {
      const pages = cliPages(head, install.cli.spec, session, install.cli.spec.usageStyle)
      parts.push(...pages)
      if (pages.length > 0 && ownsArgv(install.cli))
        parts.push(
          'This program parses its own arguments; only its registered description is available here.',
        )
    }
  }
  if (parts.length === 3) parts.push('No registered CLIs are visible in this session.')
  return parts.join('\n\n') + '\n'
}
