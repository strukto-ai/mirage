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

import type { Context } from '../../../commands/config.ts'
import { renderHelp } from '../../../commands/spec/help.ts'
import { parseShellOptions, SHELL_SPECS, type ShellParse } from '../../../commands/spec/shell.ts'
import { SYNOPSES } from '../../../commands/spec/synopsis.ts'
import { type CommandSpec, UsageStyle } from '../../../commands/spec/types.ts'
import { getCurrentEvaluation, type RedirectResult } from '../../../context/session_context.ts'
import { WORKSPACE_MACHINE } from '../../../execution/process/constants.ts'
import type { ProcessTable } from '../../../execution/process/table.ts'
import type { MachineId, MachineResources } from '../../../execution/types.ts'
import { IOResult } from '../../../io/types.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { ExecutionNode } from '../../types.ts'
import { namesMachine } from './jobspec.ts'

/** The header of the column that says which machine a row is about. */
export const MACHINE_HEADER = 'MACHINE'

/**
 * The machines a command answers for, by id as `ps` shows them: `picked`
 * when the line named one, `workspace` when the workspace answers too, ahead
 * of them. Mirrors Python's `MachineScope`.
 */
export interface MachineScope {
  readonly ids: readonly string[]
  readonly picked: boolean
  readonly several: boolean
  readonly workspace: boolean
}

/**
 * Whether a process on `machine` is in a scope: a machine in it, or Mirage's
 * own unless the line picked another machine. Mirrors Python's `in_scope`.
 */
export function inScope(scope: MachineScope, machine: string): boolean {
  if (machine === WORKSPACE_MACHINE) return scope.workspace || !scope.picked
  return scope.ids.includes(machine)
}

function reachOf(runtime: unknown): string {
  return (runtime as { reach?: string } | null | undefined)?.reach ?? 'workspace'
}

/**
 * The machine programs run on by default: the one taking programs no name
 * captures, else the first that captures any. Mirrors Python's
 * `_default_machine`.
 */
function defaultMachine(
  bindings: Record<string, unknown>,
  machine: string | undefined,
  every: readonly string[],
  host: string,
): string {
  for (const runtime of [bindings[EXTERNAL_COMMANDS], ...Object.values(bindings)]) {
    const reach = reachOf(runtime)
    if (reach === 'process') return host
    if (reach !== 'remote') continue
    try {
      const found = (
        runtime as { machineFor: (ctx: Partial<Context>) => MachineId | null }
      ).machineFor({
        ...(machine === undefined ? {} : { machine }),
      })
      if (found !== null) return found.toString()
    } catch (err) {
      console.debug('no default machine:', err)
    }
  }
  return every[0] ?? ''
}

/**
 * Which machines a command answers for: the one `--machine` or the line's
 * placement names; in a command substitution, whose reader is a script, only
 * the default one, the workspace when there is no machine; otherwise every
 * one. The host counts only while a runtime
 * runs programs on it. A command that also answers for the workspace passes
 * `workspace`, which is `mirage` to `--machine` as it is to `ps`. Null when
 * `name` names none. Mirrors Python's `machine_scope`.
 */
export function machineScope(
  processes: ProcessTable,
  name: string | null,
  workspace = false,
): MachineScope | null {
  const frame = getCurrentEvaluation()?.frame
  const routing = frame?.routing
  const every = [...(processes.machineIds?.() ?? [])]
  const host = processes.machine.toString()
  if (
    routing !== undefined &&
    Object.values(routing.bindings).some((runtime) => reachOf(runtime) === 'process')
  )
    every.push(host)
  if (name !== null) {
    if (workspace && namesMachine(WORKSPACE_MACHINE, name))
      return { ids: [], picked: true, several: false, workspace: true }
    const named = every.filter((machine) => namesMachine(machine, name))
    return named[0] === undefined
      ? null
      : { ids: [named[0]], picked: true, several: false, workspace: false }
  }
  const placed = routing?.machine ?? null
  if (placed !== null) {
    const found = every.find((machine) => namesMachine(machine, placed))
    if (found !== undefined) return { ids: [found], picked: true, several: false, workspace: false }
  }
  const substituted = frame?.substitution === true && routing !== undefined
  if (substituted && every.length > 1)
    return {
      ids: [defaultMachine(routing.bindings, placed ?? undefined, every, host)],
      picked: false,
      several: false,
      workspace: false,
    }
  const answers = workspace && !(substituted && every.length > 0)
  return {
    ids: every,
    picked: false,
    several: every.length + (answers ? 1 : 0) > 1,
    workspace: answers,
  }
}

/**
 * Which machines a process search looks at: those `machineScope` picks, or
 * Mirage's own alone for `mirage`, as `ps` names them. Null when `name` names
 * none. Mirrors Python's `process_scope`.
 */
export function processScope(processes: ProcessTable, name: string | null): MachineScope | null {
  if (name !== null && namesMachine(WORKSPACE_MACHINE, name))
    return { ids: [], picked: true, several: false, workspace: true }
  return machineScope(processes, name)
}

/**
 * Read every machine of a scope at once; one that does not answer leaves its
 * rows out and says so. Mirrors Python's `read_machines`.
 */
export async function readMachines(
  processes: ProcessTable,
  scope: MachineScope,
  name: string,
  cpu = false,
): Promise<[MachineResources[], string]> {
  const reader = processes.machineResources
  if (reader === null)
    return [[], scope.ids.map((id) => `${name}: ${id}: machine did not answer\n`).join('')]
  const answers = await Promise.allSettled(scope.ids.map((id) => reader(id, cpu)))
  const rows: MachineResources[] = []
  const errors: string[] = []
  answers.forEach((answer, at) => {
    if (answer.status === 'fulfilled') {
      rows.push(answer.value)
      return
    }
    console.debug(`${name}: ${scope.ids[at] ?? ''} not read:`, answer.reason)
    errors.push(`${name}: ${scope.ids[at] ?? ''}: machine did not answer\n`)
  })
  return [rows, errors.join('')]
}

/**
 * Whether a parse of `words` stopped at a `--` that ends the options, not one
 * an option took as its value. Mirrors Python's `_ended`.
 */
function ended(spec: CommandSpec, words: readonly string[], parse: ShellParse): boolean {
  const taken = words.length - parse.operands.length
  return (
    taken > 0 &&
    words[taken - 1] === '--' &&
    parseShellOptions(spec, words.slice(0, taken - 1)).needsValue === null
  )
}

/**
 * Read a line's options wherever they stand among its operands, as getopt
 * does; every word after a `--` is an operand.
 */
export function permutedOptions(spec: CommandSpec, words: readonly string[]): ShellParse {
  let parse = parseShellOptions(spec, words)
  let read = words
  const operands: string[] = []
  while (
    parse.operands.length > 0 &&
    parse.invalid === null &&
    parse.needsValue === null &&
    parse.unexpectedValue === null &&
    !ended(spec, read, parse)
  ) {
    operands.push(parse.operands[0] ?? '')
    const rest = parse.operands.slice(1)
    if (rest.length === 0) return { ...parse, operands }
    read = rest
    const following = parseShellOptions(spec, rest)
    parse = {
      ...following,
      flags: { ...parse.flags, ...following.flags },
      given: [...parse.given, ...following.given],
    }
  }
  return { ...parse, operands: [...operands, ...parse.operands] }
}

/** A command's usage page. */
export function usagePage(name: string): string {
  const spec = SHELL_SPECS[name]
  if (spec === undefined) throw new Error(`no spec for ${name}`)
  return renderHelp(name, spec, [], UsageStyle.ARGPARSE, SYNOPSES[name])
}

/**
 * What a command says of an option it could not take, as the getopt-driven
 * tools do; empty when every option was fine. Mirrors Python's
 * `option_refusal`.
 */
export function optionRefusal(name: string, parse: ShellParse, page = true): string {
  let said: string
  if (parse.invalid !== null) {
    said = parse.invalid.startsWith('--')
      ? `${name}: unrecognized option '${parse.invalid}'\n`
      : `${name}: invalid option -- '${parse.invalid}'\n`
  } else if (parse.needsValue !== null) {
    said = parse.needsValue.startsWith('--')
      ? `${name}: option '${parse.needsValue}' requires an argument\n`
      : `${name}: option requires an argument -- '${parse.needsValue}'\n`
  } else if (parse.unexpectedValue !== null) {
    said = `${name}: option '${parse.unexpectedValue.split('=')[0] ?? ''}' doesn't allow an argument\n`
  } else {
    return ''
  }
  return said + (page ? `\n${usagePage(name)}` : '')
}

/**
 * The machine words that `picksMachine` took name, null for none. Mirrors
 * Python's `machine_named`.
 */
export function machineNamed(words: readonly string[]): string | null {
  const first = words[0]
  if (first === undefined) return null
  return words.length === 1 ? first.slice(first.indexOf('=') + 1) : (words[1] ?? null)
}

/**
 * A view's answer: its rows, and what a machine that did not answer left to
 * say. Mirrors Python's `rows_result`.
 */
export function rowsResult(
  cmdStr: string,
  lines: readonly string[],
  errors: string,
): RedirectResult {
  const code = errors === '' ? 0 : 1
  const err = errors === '' ? null : encodeText(errors)
  return [
    encodeText(lines.map((line) => `${line}\n`).join('')),
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err ?? new Uint8Array() }),
  ]
}

/**
 * A row with the machine it is about on its right, past every existing
 * column, so a reader of those columns reads the same.
 */
export function withMachine(line: string, machine: string, width = 0): string {
  return `${line.trimEnd().padEnd(width)}  ${machine}`
}
