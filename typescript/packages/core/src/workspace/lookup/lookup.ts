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

import type { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS } from '../../runtime/constants.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import { isLineExecutor, isProcessExecutor } from '../../runtime/mixin.ts'
import type { RouteDecision } from '../../runtime/routing/types.ts'
import { headVisible, nodeVisible } from '../../policy/match/allow.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import {
  CAPTURABLE_BUILTINS,
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
 * What the session's allow list says about a tool word. A profile without a
 * list installs everything; a profile with one installs only the names its
 * patterns start with (`headVisible`). This is the raw answer;
 * `commandVisible` and `layers` add the words that are never subjects.
 */
export function listed(name: string, session: SessionState): boolean {
  return headVisible(name, session.commands)
}

/**
 * Whether a command word is a tool the allow lists govern. Every named
 * command is a subject, shell builtins included: an allow list stating
 * `cat` leaves no `echo` and no `cd`. Two kinds of word are not,
 * because neither is a name the list could hold: a path being executed
 * (its lines are each checked as they run), and the agent's own
 * function where the function is what runs, which in this shell means
 * a name no builtin owns (builtins shadow functions), so a function
 * cannot resurrect a hidden builtin, and its body's lines each pass
 * this gate themselves.
 */
export function isTool(name: string, session: SessionState): boolean {
  if (name.includes('/')) return false
  return !(name in session.functions && !SHELL_NAMES.has(name))
}

/**
 * Whether a session can see a command word at all. The profile's allow list
 * (`commands.allow`) decides: a tool name no pattern of it starts with
 * is not installed for the session, so it is 127 at the chokepoint and
 * absent from every enumerator; a word that is not a tool (`isTool`) is
 * always visible.
 */
export function commandVisible(name: string, session: SessionState): boolean {
  return !isTool(name, session) || listed(name, session)
}

/**
 * Whether a session can see one node of an installed CLI's tree.
 *
 * `commandVisible` answers for a word, which is all dispatch needs: a CLI
 * is routed by its head word and the verbs after it are the program's own
 * operand. Discovery needs the finer answer, because a profile allowed
 * `linear issue list` is not allowed `linear team`, and a manual that
 * lists the second is advertising a line that cannot run. `isTool`'s
 * exemptions have nothing to say here: shell grammar and functions are
 * single words, so a verb path only ever belongs to a CLI whose head word
 * already passed.
 */
export function verbVisible(head: string, path: readonly string[], session: SessionState): boolean {
  return nodeVisible([head, ...path], session.commands)
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
  return registry.runtimeEntries.find((entry) => entry.captures.includes(name))
}

/**
 * Yield every layer holding the name, most-preferred first.
 *
 * The one place precedence is written down: `lookup` reads the first
 * yield and `lookupAll` reads all of them. Lazy on purpose, so the winner
 * costs exactly what it did before the split (a name an installed CLI
 * answers never reaches the mount lookup). The document's visibility
 * filter lives here too, so `type`, `which`, `command -v` and dispatch
 * agree on what a session can see: an unlisted word yields nothing,
 * builtins included (only functions are not subjects, and a function
 * named after a hidden builtin is as unreachable as the builtin).
 */
function* layers(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  routing?: RouteDecision<Runtime>,
): Generator<Consumer> {
  const installed = listed(name, session)
  let found = false
  const declared = runtimeFor(name, registry)
  const bound =
    routing !== undefined && Object.hasOwn(routing.bindings, name)
      ? routing.bindings[name]
      : declared
  const native = bound != null && (isLineExecutor(bound) || isProcessExecutor(bound))
  const refused = runtimeRefused(name, session, registry, routing)
  if (SHELL_NAMES.has(name) && installed) {
    found = true
    yield (native || refused) && CAPTURABLE_BUILTINS.has(name)
      ? Consumer.EXTERNAL
      : Consumer.SESSION
  }
  if (installed && NAMESPACE_COMMANDS.has(name)) {
    found = true
    yield Consumer.NAMESPACE
  }
  if (Object.hasOwn(session.functions, name) && (installed || !SHELL_NAMES.has(name))) {
    found = true
    yield Consumer.FUNCTION
  }
  if (installed && registry.clis.get(name) !== null) {
    found = true
    yield Consumer.CLI
  }
  if (installed && (native || refused) && !SHELL_NAMES.has(name)) {
    found = true
    yield Consumer.EXTERNAL
  }
  if (installed && (ROUTED_COMMANDS.has(name) || registry.mountForCommand(name) !== null)) {
    found = true
    yield Consumer.MOUNT
  }
  const fallback =
    routing !== undefined && Object.hasOwn(routing.bindings, EXTERNAL_COMMANDS)
      ? routing.bindings[EXTERNAL_COMMANDS]
      : registry.runtimeEntries.find((entry) => entry.captures.includes(EXTERNAL_COMMANDS))
  const fallbackNative =
    fallback !== null &&
    fallback !== undefined &&
    (isLineExecutor(fallback) || isProcessExecutor(fallback))
  if (
    installed &&
    !found &&
    declared === undefined &&
    (routing === undefined || !Object.hasOwn(routing.bindings, name)) &&
    (fallbackNative || refused)
  ) {
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
  return (
    name.includes('/') ||
    program(name, session, registry) !== null ||
    lookup(name, session, registry) === Consumer.FUNCTION
  )
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
  const spec =
    consumer === Consumer.MOUNT ? (registry.mountForCommand(name)?.specFor(name) ?? null) : null
  if (spec?.options.some((option) => option.long === '--help') === true) {
    return `${name} is built into mirage.${helpLine}`
  }
  return `${name} is built into mirage.`
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
    ...registry.clis.names(),
  ])
  for (const entry of registry.runtimeEntries) {
    for (const capture of entry.captures) if (capture !== EXTERNAL_COMMANDS) names.add(capture)
  }
  for (const mount of registry.allMounts()) {
    for (const cmd of mount.allCommands()) names.add(cmd.name.split(' ')[0] ?? cmd.name)
  }
  return [...names]
    .filter((name) => program(name, session, registry) !== null)
    .sort(compareCodePoints)
}
