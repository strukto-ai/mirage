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

import { splitLines } from '../../../commands/builtin/utils/lines.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import type { Runtime } from '../../../runtime/base.ts'
import type { RouteDecision } from '../../../runtime/types.ts'
import { decodeText } from '../../../shell/bytes.ts'
import { BIN_PREFIX } from '../../../shell/constants.ts'
import { shellJoin } from '../../../shell/join.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { CycleError, resolvePath } from '../../../utils/path.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { BinViewVFS } from '../../../vfs/bin/bin.ts'
import type { NamespaceReader } from '../../dispatcher/reader.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { KEYWORDS } from '../constants.ts'
import { lookupAll } from '../lookup.ts'
import { Consumer, MachineAnswer, ProgramLookup } from '../types.ts'
import { machineHoldingAll } from './mounts.ts'
import { searchedMachine } from './search.ts'

/**
 * The machine a lookup of `name` asks: the one that would run it as a
 * program on this line; null when Mirage answers for it, or no machine would
 * run it.
 *
 * Mirage answers a name it holds in any layer: a builtin, a namespace
 * command, a CLI, a mount command, and a function unless the lookup looks
 * past functions to the file a run would exec (`which`, `type -P`,
 * `type -a`). Any other name is the machine's that takes it by name, else
 * the one taking `@external`, as the line's placement binds them
 * (`ProgramLookup` has the whole rule), unless that machine refuses the
 * session's runs (`refusesSession`). Mirrors Python's `lookup_machine`.
 *
 * @param name the name looked up.
 * @param session the session it is looked up in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement; undefined for the workspace's own
 *   bindings.
 * @param pastFunctions the lookup finds the program a function of the same
 *   name shadows.
 */
export function lookupMachine(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
  pastFunctions: boolean,
): RemoteRuntime | null {
  if (name.includes('/') || KEYWORDS.has(name)) return null
  for (const consumer of lookupAll(name, session, registry, routing)) {
    if (consumer === Consumer.FUNCTION && pastFunctions) continue
    if (consumer !== Consumer.EXTERNAL) return null
  }
  const bindings: Readonly<Record<string, Runtime | null | undefined>> =
    routing?.bindings ?? registry.runtimeBindings
  const runtime = Object.hasOwn(bindings, name) ? bindings[name] : bindings[EXTERNAL_COMMANDS]
  if (!(runtime instanceof RemoteRuntime) || runtime.refusesSession()) return null
  return runtime
}

/**
 * The program a `/usr/bin/NAME` path runs by name, for a path no file of
 * Mirage's or of a machine Mirage shows is at: NAME, where a machine runs it
 * on this line (`lookupMachine`), since a lookup prints that path for a
 * program whose own file Mirage does not show; null for any other path.
 * Mirrors Python's `bin_program`.
 *
 * @param path the head word, as typed.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param routing the line's placement.
 */
export function binProgram(
  path: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  routing: RouteDecision<Runtime> | undefined,
): string | null {
  let target: string
  try {
    target = links.follow(resolvePath(path, session.cwd))
  } catch (err) {
    if (!(err instanceof CycleError)) throw err
    console.debug(`${path}: a link loop names no program`)
    return null
  }
  const entry = registry.tryMountFor(target)
  if (entry === null || !(entry.vfs instanceof BinViewVFS)) return null
  const name = stripSlash(mountKey(target, entry.prefix))
  if (name === '' || name.includes('/')) return null
  if (lookupMachine(name, session, registry, routing, true) === null) return null
  return name
}

/**
 * The line a machine runs for a lookup: the command the agent typed, on this
 * one name, after `--` where it starts with a dash, so the machine reads it
 * as the name it is. `type` and `command` are bash's builtins, so they run
 * in the machine's bash, its `sh` where it has none; dash's `type` takes no
 * options, so there it gets the name bare.
 *
 * @param command `which`, `type` or `command`.
 * @param letters the options the agent gave it.
 * @param name the name looked up.
 */
function lookupLine(command: string, letters: string, name: string): string {
  const words = [command, ...(letters !== '' ? [`-${letters}`] : [])]
  const line = shellJoin([...words, ...(name.startsWith('-') ? ['--'] : []), name])
  if (command === 'which') return line
  const plain = command === 'type' ? shellJoin([...words, name]) : line
  return `if [ -x /bin/bash ]; then exec /bin/bash -c ${shellQuote(line)}; fi; exec /bin/sh -c ${shellQuote(plain)}`
}

/**
 * The path a line of a machine's answer names, null for none: a PATH answer
 * is the path, a KIND one names it after `NAME is`.
 *
 * @param line one line of the answer.
 * @param name the name looked up.
 * @param kind what the lookup asks.
 */
function pathIn(line: string, name: string, kind: ProgramLookup): string | null {
  if (kind === ProgramLookup.PATH) return line.startsWith('/') ? line : null
  const lead = `${name} is `
  if (kind === ProgramLookup.KIND && line.startsWith(`${lead}/`)) return line.slice(lead.length)
  return null
}

/**
 * What `runtime`'s machine answers the lookup of one name, in the
 * environment a program run there gets, each path it prints kept only where
 * Mirage shows that same path as the machine's own file, the name's
 * `/usr/bin` file otherwise.
 *
 * @param command `which`, `type` or `command`.
 * @param letters the options the agent gave it.
 * @param name the name looked up.
 * @param kind what the lookup asks.
 * @param runtime the machine that runs the name.
 * @param session the session it is looked up in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
async function answer(
  command: string,
  letters: string,
  name: string,
  kind: ProgramLookup,
  runtime: RemoteRuntime,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<MachineAnswer> {
  const done = await runtime
    .handle()
    .lookUp(lookupLine(command, letters, name), envSnapshot(session))
  const lines: string[] = []
  for (const said of splitLines(decodeText(done.stdout))) {
    let line = said
    const path = pathIn(line, name, kind)
    if (path !== null) {
      const held = await machineHoldingAll([[path, false]], session, registry, links, null)
      if (held?.defaultMachine !== runtime.defaultMachine)
        line = `${line.slice(0, line.length - path.length)}${BIN_PREFIX}/${name}`
    }
    if (!lines.includes(line)) lines.push(line)
  }
  return new MachineAnswer(done.exitCode === 0, lines)
}

/**
 * What the machine that runs each name answered the lookup the agent typed,
 * for each name a machine runs (`lookupMachine`); a name Mirage answers for,
 * or none runs, has no entry. Every machine is asked at once. Mirrors
 * Python's `machine_answers`.
 *
 * @param command `which`, `type` or `command`.
 * @param letters the options the agent gave it.
 * @param names the names looked up.
 * @param kind what the lookup asks, by its `PROGRAM_LOOKUPS` row.
 * @param pastFunctions the lookup finds the program a function of the same
 *   name shadows.
 * @param session the session they are looked up in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param routing the line's placement.
 *
 * A name no machine captures is asked of the machine search order picks for
 * it (`searchedMachine`).
 */
export async function machineAnswers(
  command: string,
  letters: string,
  names: readonly string[],
  kind: ProgramLookup,
  pastFunctions: boolean,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  routing: RouteDecision<Runtime> | undefined,
): Promise<Map<string, MachineAnswer>> {
  const asked = new Map<string, RemoteRuntime>()
  for (const name of new Set(names)) {
    const runtime = lookupMachine(name, session, registry, routing, pastFunctions)
    if (runtime === null) continue
    const searched = await searchedMachine(
      name,
      [],
      session,
      registry,
      routing,
      null,
      null,
      pastFunctions,
    )
    asked.set(name, searched ?? runtime)
  }
  const found = await Promise.all(
    [...asked].map(
      async ([name, runtime]) =>
        [
          name,
          await answer(command, letters, name, kind, runtime, session, registry, links),
        ] as const,
    ),
  )
  return new Map(found)
}
