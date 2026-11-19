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

import { shellVoice } from '../../../../shell/voice.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'
import { PROGRAM_LOOKUPS } from '../../../lookup/constants.ts'
import { program } from '../../../lookup/lookup.ts'
import { machineAnswers } from '../../../lookup/machine.ts'
import type { MachineAnswer } from '../../../lookup/types.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { type SessionState, sessionEntry } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { aliasesOn } from '../alias/alias.ts'
import { type OptionScan, lastOf, scanOptions } from '../getopt.ts'
import { builtinUsage, result, written } from '../shared.ts'
import type { BuiltinCall } from '../types.ts'
import { describe, locations, programFile } from './classify.ts'
import { TYPE_OPTIONS, WHICH_OPTIONS, WHICH_USAGE } from './constants.ts'
import { NameKind } from './types.ts'

/**
 * What the machines that run a lookup's names answered it, by name: the
 * lookup builtin hands these to its renderer, which prints a machine's answer
 * where Mirage holds no layer of the name it reports (`ProgramLookup` has the
 * rule). An alias the line would expand is Mirage's to report, unless the
 * lookup looks past it. Mirrors Python's `asked_machines`.
 *
 * @param call the lookup's invocation.
 * @param scan its options and operands, a valid scan.
 * @param option the option whose `PROGRAM_LOOKUPS` row it is, "" for none.
 * @param pastFunctions it finds the program a function or alias of the same
 *   name shadows (`which`, `type -P`, `-a`).
 */
export async function askedMachines(
  call: BuiltinCall,
  scan: OptionScan,
  option: string,
  pastFunctions: boolean,
): Promise<Map<string, MachineAnswer>> {
  const session = call.context.session
  const names = scan.operands.filter(
    (name) =>
      pastFunctions || !(aliasesOn(session) && sessionEntry(session.aliases, name) !== undefined),
  )
  if (names.length === 0) return new Map()
  const command = call.argv.name
  const kind = PROGRAM_LOOKUPS.get(command)?.get(option)
  if (kind === undefined) throw new Error(`no PROGRAM_LOOKUPS row for ${command} ${option}`)
  return machineAnswers(
    command,
    scan.letters.join(''),
    names,
    kind,
    pastFunctions,
    session,
    call.registry,
    call.namespace.sessionLinks(session),
    call.context.frame.routing,
  )
}

/**
 * Run the `type` builtin (`type [-afptP] name [name ...]`).
 *
 * Resolution matches `command -V`, but the exit rule is `type`'s: 0 only
 * when every name resolves. `-t` prints the classification word; `-p`
 * prints the file of a name that resolves to one (none for a builtin,
 * which still resolves) and `-P` searches PATH for one even past a
 * builtin, a miss there being a miss; the three are one group, the last
 * winning. `-a` prints one line per layer holding the name (a builtin
 * that is also a program ends with its file's line), `-f` ignores the
 * function table, and a missing name warns on stderr unless a word-only
 * mode (`-t`/`-p`/`-P`) is active. Pinned against bash 5.2 on
 * debian:stable-slim.
 *
 * A name a machine runs (`askedMachines`) is reported by the machine's own
 * `type` wherever Mirage holds no layer of it to report first: Mirage's
 * function, alias or builtin lines come ahead of the machine's file lines
 * under `-a`.
 *
 * @param args words after the `type` name.
 * @param session shell session (function table).
 * @param registry mount registry for name resolution.
 * @param parser the scope a function's body is printed under.
 * @param answers what the machine that runs each name answered, by name.
 */
export function handleType(
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  parser?: ParseScope,
  answers: ReadonlyMap<string, MachineAnswer> = new Map(),
): RedirectResult {
  const scan = scanOptions(args, TYPE_OPTIONS)
  if (scan.bad !== null) {
    return result('type', {
      exitCode: 2,
      stderr: `${shellVoice()}type: ${scan.bad}: invalid option\n${builtinUsage('type')}`,
    })
  }
  const mode = lastOf(scan.letters, 'tpP')
  const allMode = scan.letters.includes('a')
  const hidden = scan.letters.includes('f') ? NameKind.FUNCTION : null
  const pieces: [boolean, string][] = []
  let allFound = true
  for (const name of scan.operands) {
    const answer = answers.get(name)
    if (mode === 'P') {
      if (answer !== undefined) {
        allFound = allFound && answer.found
        for (const line of answer.lines) pieces.push([false, `${line}\n`])
      } else if (program(name, session, registry) === null) allFound = false
      else pieces.push([false, `${programFile(name)}\n`])
      continue
    }
    let kinds = locations(name, session, registry, allMode, hidden)
    let machine: readonly string[] = []
    if (answer !== undefined) {
      kinds = kinds.filter((kind) => kind !== NameKind.FILE)
      if ((allMode || kinds.length === 0) && answer.found) machine = answer.lines
    }
    if (kinds.length === 0 && machine.length === 0) {
      allFound = false
      if (mode === null) pieces.push([true, `${shellVoice()}type: ${name}: not found\n`])
      continue
    }
    if (mode === 't') for (const kind of kinds) pieces.push([false, `${kind}\n`])
    else if (mode === 'p') {
      for (const kind of kinds)
        if (kind === NameKind.FILE) pieces.push([false, `${programFile(name)}\n`])
    } else
      for (const kind of kinds) pieces.push([false, `${describe(name, kind, session, parser)}\n`])
    for (const line of machine) pieces.push([false, `${line}\n`])
  }
  // One call, so the diagnostics never ride on the status: a partial miss
  // both warns and reports through the exit code.
  const code = scan.operands.length === 0 || allFound ? 0 : 1
  return written('type', pieces, code)
}

/**
 * Run the `which` builtin (`which [-as] name [name ...]`).
 *
 * Pinned against debianutils `which` (debian:stable-slim): it prints the
 * file PATH finds for each name, which is the program's under `/usr/bin`
 * (the one PATH directory), a miss prints nothing at all, the exit status
 * is 0 only when every name resolves (1 with no operands), and `-s`
 * reports through the status alone. A builtin with no program (`cd`), a
 * function, an alias and a reserved word are no file, so each is a miss;
 * `-a` has one directory to search and so one line per name. `$PATH`
 * itself is not read: mirage runs a program by its name whatever PATH
 * holds, so `which` answers as dispatch does. The refusal for an unknown
 * option is bash's shape, not the C tool's `Illegal option`, because this
 * is a builtin.
 *
 * A name a machine runs (`askedMachines`) is the machine's own `which` to
 * answer, as Mirage asked it.
 *
 * @param args words after the `which` name.
 * @param session shell session (function table).
 * @param registry mount registry for name resolution.
 * @param answers what the machine that runs each name answered, by name.
 */
export function handleWhich(
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  answers: ReadonlyMap<string, MachineAnswer> = new Map(),
): RedirectResult {
  const scan = scanOptions(args, WHICH_OPTIONS)
  if (scan.bad !== null) {
    return result('which', {
      exitCode: 2,
      stderr: `which: ${scan.bad}: invalid option\n${WHICH_USAGE}`,
    })
  }
  const silent = scan.letters.includes('s')
  const outLines: string[] = []
  let allFound = true
  for (const name of scan.operands) {
    const answer = answers.get(name)
    if (answer !== undefined) {
      allFound = allFound && answer.found
      if (!silent) for (const line of answer.lines) outLines.push(`${line}\n`)
      continue
    }
    if (program(name, session, registry) === null) {
      allFound = false
      continue
    }
    if (!silent) outLines.push(`${programFile(name)}\n`)
  }
  const out = outLines.length > 0 ? encodeText(outLines.join('')) : null
  const code = scan.operands.length > 0 && allFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'which', exitCode: code }),
  ]
}

/** The `type` arm: the machines that run its names are asked first, then
 * `handleType` reports. */
export async function typeBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  const args = [...call.argv.args]
  const scan = scanOptions(args, TYPE_OPTIONS)
  let answers = new Map<string, MachineAnswer>()
  if (scan.bad === null) {
    const mode = lastOf(scan.letters, 'tpP')
    const every = scan.letters.includes('a')
    const option = mode !== null ? `-${mode}` : every ? '-a' : ''
    answers = await askedMachines(call, scan, option, mode === 'P' || every)
  }
  return handleType(args, call.context.session, call.registry, call.parser, answers)
}

/** The `which` arm: the machines that run its names are asked first, then
 * `handleWhich` reports. */
export async function whichBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  const args = [...call.argv.args]
  const scan = scanOptions(args, WHICH_OPTIONS)
  let answers = new Map<string, MachineAnswer>()
  if (scan.bad === null) answers = await askedMachines(call, scan, '', true)
  return handleWhich(args, call.context.session, call.registry, answers)
}
