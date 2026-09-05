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

import type { CLISpec } from '../../../../commands/cli/types.ts'
import { skillFor } from '../../../../commands/cli/skill.ts'
import { findNode, nodeHelp } from '../../../../commands/cli/walk.ts'
import { BUILTIN_SPECS } from '../../../../commands/spec/builtins.ts'
import type { CommandSpec } from '../../../../commands/spec/types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CLIInstall } from '../../../cli/types.ts'
import { DEV_PREFIX } from '../../../mount/registry.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { cliTreeVisible, commandVisible, verbVisible } from '../../../lookup/lookup.ts'
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { ManEntry } from './types.ts'
import type { BuiltinCall, Result } from '../types.ts'

// Shell builtins the manual documents through a spec of another name.
const SHELL_BUILTIN_MAN: Readonly<Record<string, string>> = Object.freeze({
  bash: 'bash',
  sh: 'bash',
})

/** A description, or man's placeholder when the spec carries none. */
function described(text: string | null | undefined): string {
  return text ?? '(no description)'
}

/**
 * The entry for a mount command, null when no mount registers it.
 *
 * A name has one spec however many mounts register it (spec parity holds
 * every registration of a name to one spec), so the first registration
 * found is the page.
 */
function commandEntry(name: string, registry: MountRegistry): ManEntry | null {
  for (const mount of registry.allMounts()) {
    if (mount.prefix === DEV_PREFIX) continue
    const cmd = mount.resolveCommand(name)
    if (cmd !== null) return { name, spec: cmd.spec }
  }
  return null
}

/** The entry for a shell builtin the manual documents, else null. */
function builtinEntry(name: string): ManEntry | null {
  const specKey = SHELL_BUILTIN_MAN[name]
  const spec = specKey !== undefined ? BUILTIN_SPECS[specKey] : undefined
  return spec !== undefined ? { name, spec } : null
}

/**
 * One entry per name registered on any mount that the session can see,
 * first registration wins.
 */
function commandEntries(registry: MountRegistry, session: Session): ManEntry[] {
  const seen = new Map<string, ManEntry>()
  for (const mount of registry.allMounts()) {
    if (mount.prefix === DEV_PREFIX) continue
    for (const cmd of mount.allCommands()) {
      if (!seen.has(cmd.name) && commandVisible(cmd.name, session)) {
        seen.set(cmd.name, { name: cmd.name, spec: cmd.spec })
      }
    }
  }
  return [...seen.values()]
}

/** One entry per installed CLI head word the session can see. */
function cliEntries(registry: MountRegistry, session: Session): ManEntry[] {
  return [...registry.clis.items()]
    .filter(([name]) => commandVisible(name, session))
    .map(([name, install]) => ({ name, spec: install.spec }))
}

function renderOptionsTable(spec: CommandSpec): string[] {
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
  return lines
}

/** The page for one entry: title, description, options table. */
function renderPage(entry: ManEntry): string {
  const lines = [`# ${entry.name}`, '', described(entry.spec.description)]
  const table = renderOptionsTable(entry.spec)
  if (table.length > 0) lines.push('', ...table)
  return lines.join('\n') + '\n'
}

/** One section of the bare listing, empty when there is nothing to list. */
function renderSection(title: string, entries: readonly ManEntry[]): string {
  if (entries.length === 0) return ''
  const lines = [`# ${title}`, '']
  for (const entry of [...entries].sort((a, b) => compareCodePoints(a.name, b.name))) {
    lines.push(`- ${entry.name} — ${described(entry.spec.description)}`)
  }
  return lines.join('\n')
}

/**
 * The page for one node of an installed CLI, null when the verbs miss or
 * the session cannot see the node they name.
 *
 * The page is the node's own `--help`, rendered by the one renderer that
 * serves `--help` and the bare-group refusal, so a CLI's manual cannot
 * drift from the program. A tree is a manual with sections: `man linear`
 * lists the verbs and `man linear issue create` is the page for one leaf.
 *
 * The allow list narrows a tree the same way it narrows the bare listing,
 * one level down: a profile holding `linear issue list` reads a manual for
 * that verb and nothing else, because a row it cannot run is an
 * advertisement for a 126.
 */
function renderCliEntry(
  head: string,
  verbs: readonly string[],
  spec: CLISpec,
  session: Session,
): string | null {
  const found = findNode(spec, verbs)
  if (found === null) return null
  const { node, path } = found
  if (!verbVisible(head, path, session)) return null
  // The root's dialect, so a manual page reads exactly like the --help it
  // renders from.
  return nodeHelp([head, ...path].join(' '), node, spec.usageStyle, (verb) =>
    verbVisible(head, [...path, verb], session),
  )
}

/**
 * The bare `man` listing, by kind of word: commands, then CLIs.
 *
 * Every name registered on any mount is one row however many mounts
 * register it, and no row says which: the manual documents words, and
 * dispatch by name already picks the mount that serves one.
 */
function renderManIndex(registry: MountRegistry, session: Session): string {
  const sections = [
    renderSection('commands', commandEntries(registry, session)),
    renderSection('clis', cliEntries(registry, session)),
  ]
  const body = sections.filter((s) => s !== '').join('\n\n')
  return body === '' ? '' : body + '\n'
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
  session: Session,
): Result {
  const enc = new TextEncoder()
  const head = install.name
  let entry = renderCliEntry(head, verbs, install.spec, session)
  if (entry === null) {
    const err = enc.encode(`man: no entry for ${[head, ...verbs].join(' ')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  // The skill IS the guide when the line asks for the head word bare: its
  // body goes first, the node's own --help rendering follows so the page
  // never drifts from the program it documents.
  if (verbs.length === 0 && cliTreeVisible(head, install.spec, session)) {
    // Respelled for the installed head, so `man ntn-prod` teaches
    // `ntn-prod` lines and not another install's.
    const skill = skillFor(install.spec, head)
    if (skill !== null) entry = `${skill.body}\n\n${entry}`
  }
  const sections = [entry]
  const command = verbs.length === 0 ? commandEntry(head, registry) : null
  if (command !== null) sections.push(renderPage(command))
  return [
    enc.encode(sections.join('\n')),
    new IOResult(),
    new ExecutionNode({ command: cmdStr, exitCode: 0 }),
  ]
}

export function handleMan(args: string[], registry: MountRegistry, session: Session): Result {
  const enc = new TextEncoder()
  const name = args[0]
  if (name === undefined) {
    return [
      enc.encode(renderManIndex(registry, session)),
      new IOResult(),
      new ExecutionNode({ command: 'man', exitCode: 0 }),
    ]
  }
  const cmdStr = `man ${args.join(' ')}`
  // Only an installed head word reads the words after it: they are its
  // verb path. Everything else keeps man's older shape and documents
  // args[0]. A word the session cannot see has no page.
  const visible = commandVisible(name, session)
  const install = registry.clis.get(name)
  if (install !== null && visible) return cliMan(install, args.slice(1), cmdStr, registry, session)
  const entry = visible ? (commandEntry(name, registry) ?? builtinEntry(name)) : null
  if (entry === null) {
    const err = enc.encode(`man: no entry for ${name}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  const out = enc.encode(renderPage(entry))
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}

/** The `man` arm. */
export function manBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleMan([...call.argv.args], call.registry, call.session))
}
