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

import { compileSpec } from '../../commands/spec/compile.ts'
import type { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS } from '../../runtime/constants.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import { isLineExecutor, isProcessExecutor } from '../../runtime/mixin.ts'
import type { RouteDecision } from '../../runtime/routing/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import {
  CAPTURABLE_BUILTINS,
  EXEC_WRAPPERS,
  INTERPRETER_NAMES,
  KEYWORDS,
  NAMESPACE_COMMANDS,
  ROUTED_COMMANDS,
  SHELL_NAMES,
  SHELL_ONLY_BUILTINS,
} from './constants.ts'
import { Consumer } from './types.ts'
import { shellQuote } from '../../utils/quote.ts'
import { compareCodePoints } from '../../utils/sort.ts'

/**
 * Whether a command word is a tool the allow lists govern. Every named
 * command is a subject, shell builtins included: an allow list stating
 * `cat` leaves no `echo` and no `cd`. Two kinds of word are not,
 * because neither is a name the list could hold: a path being executed
 * (its lines are each checked as they run), and the agent's own
 * function where the function is what runs, which in this shell means
 * a name no builtin owns (builtins shadow functions), and its body's
 * lines each pass the gate themselves.
 */
export function isTool(name: string, session: SessionState): boolean {
  if (name.includes('/')) return false
  return !(name in session.functions && !SHELL_NAMES.has(name))
}

/** Whether routing explicitly refused the external runtime for `name`. */
export function runtimeRefused(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  routing?: RouteDecision<Runtime>,
): boolean {
  if (routing === undefined) return false
  const key = Object.hasOwn(routing.bindings, name) ? name : EXTERNAL_COMMANDS
  return (
    Object.hasOwn(routing.bindings, key) &&
    routing.bindings[key] === null &&
    lookup(name, session, registry) === Consumer.EXTERNAL
  )
}

/** The runtime that captures a name by name, not through the fallback. */
function runtimeFor(name: string, registry: MountRegistry): Runtime | undefined {
  return registry.runtimeBindings[name]
}

/**
 * Whether the runtime runs the name as a native program. A language runtime
 * that also runs processes (local) still interprets its own language's
 * names (python3), so those stay the session's builtin; any other name it
 * captures runs natively.
 */
function isNative(runtime: Runtime | null | undefined, name: string): boolean {
  if (runtime == null || !(isLineExecutor(runtime) || isProcessExecutor(runtime))) return false
  if (!(runtime instanceof LanguageRuntime)) return true
  return !(runtime.constructor as typeof LanguageRuntime).commands.includes(name)
}

/**
 * Yield every layer holding the name, most-preferred first.
 *
 * The one place precedence is written down: `lookup` reads the first
 * yield and `lookupAll` reads all of them. Lazy on purpose, so the winner
 * costs exactly what it did before the split (a name an installed CLI
 * answers never reaches the mount lookup). A profile's allow list does
 * not narrow it: a word the list leaves out is found, and the policy gate
 * refuses it. `routing` is the line's placement; outside a line the static
 * bindings answer.
 */
function* layers(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  routing?: RouteDecision<Runtime>,
): Generator<Consumer> {
  let found = false
  const bindings: Readonly<Record<string, Runtime | null | undefined>> =
    routing?.bindings ?? registry.runtimeBindings
  const bound = Object.hasOwn(bindings, name) ? bindings[name] : undefined
  const native = isNative(bound, name)
  const refused = runtimeRefused(name, session, registry, routing)
  if (SHELL_NAMES.has(name)) {
    found = true
    yield (native || refused) && CAPTURABLE_BUILTINS.has(name)
      ? Consumer.EXTERNAL
      : Consumer.SESSION
  }
  if (NAMESPACE_COMMANDS.has(name)) {
    found = true
    yield Consumer.NAMESPACE
  }
  if (Object.hasOwn(session.functions, name)) {
    found = true
    yield Consumer.FUNCTION
  }
  if (registry.clis.get(name) !== null) {
    found = true
    yield Consumer.CLI
  }
  if ((native || refused) && !SHELL_NAMES.has(name)) {
    found = true
    yield Consumer.EXTERNAL
  }
  if (ROUTED_COMMANDS.has(name) || registry.mountForCommand(runsAs(name, registry)) !== null) {
    found = true
    yield Consumer.MOUNT
  }
  const fallback = Object.hasOwn(bindings, EXTERNAL_COMMANDS)
    ? bindings[EXTERNAL_COMMANDS]
    : undefined
  const fallbackNative =
    fallback !== null &&
    fallback !== undefined &&
    (isLineExecutor(fallback) || isProcessExecutor(fallback))
  if (!found && !Object.hasOwn(bindings, name) && (fallbackNative || refused)) {
    yield Consumer.EXTERNAL
  }
}

/**
 * Route a command name to the layer that consumes it.
 *
 * Order mirrors dispatch precedence: shell builtins shadow functions,
 * functions shadow installed CLIs, CLIs shadow mount commands, and a
 * name nobody registers is UNKNOWN (command not found). Install-time
 * collision rules keep the CLI arm honest: a CLI may not take a shell
 * builtin's or a general command's name, so the only shadowing a CLI
 * can actually exert is over a mount-specific custom command.
 *
 * The full landscape, in precedence order. The column to watch is what
 * resolves the name: session or workspace state for the named layers,
 * operand paths for mounts:
 *
 *     Consumer   Example              Resolved by          Words
 *     SESSION    cd, echo, export     name in SHELL_NAMES  shell-expanded
 *     NAMESPACE  ln -s, readlink      NAMESPACE_COMMANDS   shell-expanded
 *     FUNCTION   deploy() {..}        session.functions    shell-expanded
 *     CLI        slack message send   registry.clis        shell-expanded
 *     MOUNT      grep, cat, du        operand paths        pushdown
 *     UNKNOWN    bogus                nobody               untouched, 127
 *
 * Named process captures select EXTERNAL before mount commands.
 * EXTERNAL_COMMANDS handles names no preceding layer owns.
 *
 * This is the winner only. A name can sit in more than one layer at once
 * (a function shadowing an installed CLI); `lookupAll` reports them all,
 * which is what `type -a` prints. Reading one item off the generator is
 * what makes that sharing free: the lookups after the winner never run,
 * so dispatch pays exactly what it did when this was a chain of `if`
 * arms.
 */
export function lookup(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  routing?: RouteDecision<Runtime>,
): Consumer {
  for (const consumer of layers(name, session, registry, routing)) return consumer
  return Consumer.UNKNOWN
}

/**
 * Every layer holding the name, most-preferred first.
 *
 * Empty when nothing holds it, where `lookup` says UNKNOWN. Only
 * introspection (`type -a`, `which -a`) needs this: dispatch runs the
 * winner and never asks what it shadowed.
 */
export function lookupAll(
  name: string,
  session: SessionState,
  registry: MountRegistry,
): Consumer[] {
  return [...layers(name, session, registry)]
}

/**
 * The layer a name runs from as a program, null when it is none.
 *
 * A program is what a real system ships as a file on PATH, so it has one
 * under `/usr/bin` here: every mount, namespace and CLI command, every
 * name a runtime captures by name, and each builtin a real system also
 * finds on disk (echo, test, xargs). The shell's own words (cd, export,
 * history: `SHELL_ONLY_BUILTINS`), reserved words, functions and aliases
 * have no file, and a shell word keeps none when a mount registers the
 * same name, since the builtin is what runs. Nor does a name only the
 * external fallback capture takes: it takes any word, so like bash's
 * `command_not_found_handle` it runs a name without making it a program.
 * An interpreter (python3, node) is a program only where a language
 * runtime is bound to it: without one it answers 127, as it does on a
 * system that never installed it. A function shadowing a program leaves
 * the file in place, as it does on PATH.
 */
export function program(
  name: string,
  session: SessionState,
  registry: MountRegistry,
): Consumer | null {
  if (name.includes('/') || KEYWORDS.has(name)) return null
  for (const consumer of layers(name, session, registry)) {
    if (consumer === Consumer.FUNCTION) continue
    if (consumer === Consumer.SESSION && SHELL_ONLY_BUILTINS.has(name)) return null
    if (
      consumer === Consumer.SESSION &&
      INTERPRETER_NAMES.has(name) &&
      !(runtimeFor(name, registry) instanceof LanguageRuntime)
    )
      return null
    if (consumer === Consumer.EXTERNAL && runtimeFor(name, registry) === undefined) return null
    return consumer
  }
  return null
}

/**
 * Whether a builtin that execs its operand (xargs, timeout) finds it.
 *
 * GNU execs the name, so a shell word with no file on PATH (cd, export) is
 * missing there, as is a name nothing provides. A function runs too, where it
 * is what the name runs (a shell word shadows one): mirage runs the line in
 * the shell, which is how these reach it. A path is left to the run, which
 * reports on it.
 */
export function execs(name: string, session: SessionState, registry: MountRegistry): boolean {
  if (name.includes('/') || program(name, session, registry) !== null) return true
  const consumer = lookup(name, session, registry)
  return consumer === Consumer.FUNCTION || consumer === Consumer.EXTERNAL
}

/**
 * What a program's `/usr/bin` file says about it, null when the name is no
 * program.
 *
 * One line: what runs the name, and `--help` where the program's spec
 * answers it, which a mount command's and a CLI's do; a builtin's answer
 * varies (`ln --help` and `echo --help` print no help), so a builtin's
 * line names none.
 */
export function programNote(
  name: string,
  session: SessionState,
  registry: MountRegistry,
): string | null {
  const consumer = program(name, session, registry)
  if (consumer === null) return null
  const runtime = runtimeFor(name, registry)
  if (runtime !== undefined && (consumer === Consumer.EXTERNAL || INTERPRETER_NAMES.has(name))) {
    return `${name} runs on the workspace's ${runtime.name} runtime.`
  }
  const helpLine = ` Help: ${shellQuote(name)} --help`
  if (consumer === Consumer.CLI) {
    return `${name} is a CLI registered with this workspace.${helpLine}`
  }
  const runs = runsAs(name, registry)
  const spec =
    consumer === Consumer.MOUNT ? (registry.mountForCommand(runs)?.specFor(runs) ?? null) : null
  if (
    spec !== null &&
    compileSpec(spec).options.some((option) => option.names.includes('--help'))
  ) {
    return `${name} is built into mirage.${helpLine}`
  }
  return `${name} is built into mirage.`
}

/**
 * The program a command word runs: a wrapper no mount registers (`egrep`)
 * runs the program it names, any other word itself.
 */
export function runsAs(name: string, registry: MountRegistry): string {
  const wrapped = EXEC_WRAPPERS.get(name)
  return wrapped !== undefined && registry.mountForCommand(name) === null ? wrapped[0] : name
}

/**
 * Every program name the session can run, sorted: the `/usr/bin` listing.
 *
 * The names are gathered from each layer that can hold a program and
 * kept only where `program` says the name runs as one, so the listing and
 * a lookup never disagree. A name only the external fallback capture
 * would take cannot be listed, since that capture takes any word.
 */
export function programs(session: SessionState, registry: MountRegistry): string[] {
  const names = new Set<string>([
    ...SHELL_NAMES,
    ...NAMESPACE_COMMANDS,
    ...ROUTED_COMMANDS,
    ...EXEC_WRAPPERS.keys(),
    ...registry.clis.names(),
  ])
  for (const capture of Object.keys(registry.runtimeBindings)) {
    if (capture !== EXTERNAL_COMMANDS) names.add(capture)
  }
  for (const mount of registry.allMounts()) {
    for (const cmd of mount.allCommands()) names.add(cmd.name.split(' ')[0] ?? cmd.name)
  }
  return [...names]
    .filter((name) => program(name, session, registry) !== null)
    .sort(compareCodePoints)
}
