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

import type { CLISpec } from '../../../commands/cli/types.ts'
import { findNode, nodeHelp } from '../../../commands/cli/walk.ts'
import type { RegisteredCommand } from '../../../commands/config.ts'
import { BUILTIN_SPECS } from '../../../commands/spec/builtins.ts'
import type { CommandSpec } from '../../../commands/spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import type { CLIInstall } from '../../cli/types.ts'
import type { MountEntry } from '../../mount/mount.ts'
import { DEV_PREFIX } from '../../mount/registry.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

/** A description, or man's placeholder when the spec carries none. */
function described(text: string | null | undefined): string {
  return text ?? '(no description)'
}

interface ManHit {
  mount: MountEntry
  cmd: RegisteredCommand
  isGeneral: boolean
}

function collectManHits(name: string, registry: MountRegistry): ManHit[] {
  const hits: ManHit[] = []
  for (const mount of registry.allMounts()) {
    if (mount.prefix === DEV_PREFIX) continue
    const cmd = mount.resolveCommand(name)
    if (cmd === null) continue
    hits.push({ mount, cmd, isGeneral: mount.isGeneralCommand(name) })
  }
  return hits
}

function renderOptionsTable(spec: {
  options: readonly {
    short?: string | null
    long?: string | null
    type: string
    description?: string | null
  }[]
}): string[] {
  if (spec.options.length === 0) return []
  const lines: string[] = []
  lines.push('## OPTIONS', '')
  lines.push('| short | long | value | description |')
  lines.push('| ----- | ---- | ----- | ----------- |')
  for (const opt of spec.options) {
    const short = opt.short ?? ''
    const long = opt.long ?? ''
    lines.push(`| ${short} | ${long} | ${opt.type} | ${opt.description ?? ''} |`)
  }
  lines.push('')
  return lines
}

function renderManEntry(name: string, hits: ManHit[]): string {
  const first = hits[0]
  if (first === undefined) return ''
  const spec = first.cmd.spec
  const lines: string[] = []
  lines.push(`# ${name}`, '')
  lines.push(described(spec.description), '')
  lines.push(...renderOptionsTable(spec))
  lines.push('## RESOURCES', '')
  const seen = new Set<string>()
  let hasGeneral = false
  const rows: string[] = []
  for (const h of hits) {
    if (h.isGeneral) {
      hasGeneral = true
      continue
    }
    const kind = h.mount.resource.kind
    const filetype = h.cmd.filetype
    const key = `${kind}\u0000${filetype ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(filetype !== null ? `- ${kind} (filetype: ${filetype})` : `- ${kind}`)
  }
  rows.sort((a, b) => compareCodePoints(a, b))
  if (hasGeneral) lines.push('- general')
  for (const r of rows) lines.push(r)
  return lines.join('\n') + '\n'
}

/**
 * The page for one node of an installed CLI, null when the verbs miss.
 *
 * The page is the node's own `--help`, rendered by the one renderer that
 * serves `--help` and the bare-group refusal, so a CLI's manual cannot
 * drift from the program. A tree is a manual with sections: `man linear`
 * lists the verbs and `man linear issue create` is the page for one leaf.
 */
function renderCliEntry(head: string, verbs: readonly string[], spec: CLISpec): string | null {
  const found = findNode(spec, verbs)
  if (found === null) return null
  // The root's dialect, so a manual page reads exactly like the --help it
  // renders from.
  return nodeHelp([head, ...found.path].join(' '), found.node, spec.usageStyle)
}

/** The installed-CLI section of the bare `man` listing. */
function renderCliIndex(registry: MountRegistry): string[] {
  const installs = [...registry.clis.items().entries()].sort(([a], [b]) => compareCodePoints(a, b))
  if (installs.length === 0) return []
  const lines = ['# clis', '']
  for (const [name, install] of installs) {
    lines.push(`- ${name} — ${described(install.spec.description)}`)
  }
  lines.push('')
  return lines
}

function renderManIndex(session: Session, registry: MountRegistry): string {
  const byKind = new Map<string, MountEntry>()
  for (const m of registry.allMounts()) {
    if (m.prefix === DEV_PREFIX) continue
    if (!byKind.has(m.resource.kind)) byKind.set(m.resource.kind, m)
  }
  const cwdMount = registry.tryMountFor(session.cwd)
  const cwdKind =
    cwdMount !== null && cwdMount.prefix !== DEV_PREFIX ? cwdMount.resource.kind : null

  const kinds = [...byKind.keys()].sort(compareCodePoints)
  const ordered: string[] = []
  if (cwdKind !== null && byKind.has(cwdKind)) ordered.push(cwdKind)
  for (const k of kinds) {
    if (k === cwdKind) continue
    ordered.push(k)
  }

  const lines: string[] = []
  const generalSeen = new Map<string, RegisteredCommand>()
  for (const kind of ordered) {
    const m = byKind.get(kind)
    if (m === undefined) continue
    lines.push(`# ${kind}`, '')
    const allCmds = m.allCommands()
    const resourceCmds = allCmds
      .filter((c) => !m.isGeneralCommand(c.name))
      .slice()
      .sort((a, b) => compareCodePoints(a.name, b.name))
    for (const cmd of resourceCmds) {
      lines.push(`- ${cmd.name} — ${described(cmd.spec.description)}`)
    }
    for (const cmd of allCmds) {
      if (m.isGeneralCommand(cmd.name) && !generalSeen.has(cmd.name)) {
        generalSeen.set(cmd.name, cmd)
      }
    }
    lines.push('')
  }
  lines.push(...renderCliIndex(registry))
  lines.push('# general', '')
  for (const [name, cmd] of [...generalSeen.entries()].sort(([a], [b]) =>
    compareCodePoints(a, b),
  )) {
    lines.push(`- ${name} — ${described(cmd.spec.description)}`)
  }
  return lines.join('\n') + '\n'
}

const SHELL_BUILTIN_MAN: Readonly<Record<string, string>> = Object.freeze({
  bash: 'bash',
  sh: 'bash',
})

function renderShellBuiltinMan(
  name: string,
  spec: { description: string | null; options: CommandSpec['options'] },
): string {
  const lines: string[] = []
  lines.push(`# ${name}`, '')
  lines.push(described(spec.description), '')
  lines.push(...renderOptionsTable(spec))
  lines.push('## RESOURCES', '')
  lines.push('- shell builtin')
  return lines.join('\n') + '\n'
}

/**
 * The page (or pages) for an installed head word.
 *
 * A CLI may not take a general command's name, but a mount can register
 * a custom command under any name, so both pages can exist for one word.
 * The CLI goes first: it is the one dispatch would run.
 */
function cliMan(
  install: CLIInstall,
  verbs: readonly string[],
  cmdStr: string,
  registry: MountRegistry,
): Result {
  const enc = new TextEncoder()
  const head = install.name
  const entry = renderCliEntry(head, verbs, install.spec)
  if (entry === null) {
    const err = enc.encode(`man: no entry for ${[head, ...verbs].join(' ')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  const sections = [entry]
  const hits = verbs.length === 0 ? collectManHits(head, registry) : []
  if (hits.length > 0) sections.push(renderManEntry(head, hits))
  return [
    enc.encode(sections.join('\n')),
    new IOResult(),
    new ExecutionNode({ command: cmdStr, exitCode: 0 }),
  ]
}

export function handleMan(args: string[], session: Session, registry: MountRegistry): Result {
  const enc = new TextEncoder()
  const name = args[0]
  if (name === undefined) {
    return [
      enc.encode(renderManIndex(session, registry)),
      new IOResult(),
      new ExecutionNode({ command: 'man', exitCode: 0 }),
    ]
  }
  const cmdStr = `man ${args.join(' ')}`
  // Only an installed head word reads the words after it: they are its
  // verb path. Everything else keeps man's older shape and documents
  // args[0].
  const install = registry.clis.get(name)
  if (install !== null) return cliMan(install, args.slice(1), cmdStr, registry)
  const hits = collectManHits(name, registry)
  if (hits.length === 0) {
    const specKey = SHELL_BUILTIN_MAN[name]
    const spec = specKey !== undefined ? BUILTIN_SPECS[specKey] : undefined
    if (spec !== undefined) {
      const out = enc.encode(renderShellBuiltinMan(name, spec))
      return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
    }
    const err = enc.encode(`man: no entry for ${name}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  const out = enc.encode(renderManEntry(name, hits))
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}
