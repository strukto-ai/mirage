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
import { renderHelp } from '../../commands/spec/help.ts'
import { SHELL_SPECS } from '../../commands/spec/shell.ts'
import { versionLine } from '../../commands/spec/standard.ts'
import { SYNOPSES } from '../../commands/spec/synopsis.ts'
import type { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS } from '../../runtime/constants.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import { isLineExecutor, isProcessExecutor } from '../../runtime/mixin.ts'
import type { RouteDecision } from '../../runtime/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import {
  CAPTURABLE_BUILTINS,
  EXEC_WRAPPERS,
  INTERPRETER_NAMES,
  KEYWORDS,
  NAMESPACE_COMMANDS,
  DEFAULT_NICENESS,
  LOWEST_PRIORITY,
  PROGRAM_WRAPPERS,
  ROUTED_COMMANDS,
  RUNNERS,
  niceAdjustment,
  SHELL_NAMES,
  SHELL_ONLY_BUILTINS,
  readWrapper,
} from './constants.ts'
import { Consumer, WrapperAnswer } from './types.ts'
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
 * `lookup`'s answer, with a wrapper no Mirage layer owns bound to the
 * runtime that captures its program by name (`nice gcc`). Mirrors Python's
 * `routed_consumer`.
 */
export function routedConsumer(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
): [Consumer, RouteDecision<Runtime> | undefined] {
  const consumer = lookup(name, session, registry, routing)
  if (routing === undefined || !outsideMirage(consumer)) return [consumer, routing]
  const program = wrapped(name, args, routing.bindings)
  if (program === null) return [consumer, routing]
  const bindings = Object.assign(
    Object.create(null) as Record<string, Runtime | null>,
    routing.bindings,
    {
      [name]: routing.bindings[program] ?? null,
    },
  )
  return [Consumer.EXTERNAL, { ...routing, bindings }]
}

/**
 * The line's placement with no runtime capturing `name`, which is how
 * `builtin` runs its target: the shell's own builtin, though a runtime takes
 * the name by itself (`builtin kill`). Mirrors Python's `without_capture`.
 */
export function withoutCapture(
  routing: RouteDecision<Runtime> | undefined,
  name: string,
): RouteDecision<Runtime> | undefined {
  if (routing === undefined || !Object.hasOwn(routing.bindings, name)) return routing
  const bindings = Object.create(null) as Record<string, Runtime | null>
  for (const [key, bound] of Object.entries(routing.bindings)) {
    if (key !== name) bindings[key] = bound
  }
  return { ...routing, bindings }
}

/**
 * Where a wrapper's program stands in its words when Mirage runs that
 * program itself, without the wrapper (`nice grep`); null otherwise. Mirrors
 * Python's `mirage_program_at`.
 */
export function mirageProgramAt(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
): number | null {
  const bindings = routing?.bindings ?? registry.runtimeBindings
  if (
    !PROGRAM_WRAPPERS.has(name) ||
    Object.hasOwn(bindings, name) ||
    !outsideMirage(lookup(name, session, registry, routing)) ||
    wrapped(name, args, bindings) !== null
  )
    return null
  const [at] = readWrapper(name, args)
  if (at === null) return null
  const inner = args[at] ?? ''
  if (PROGRAM_WRAPPERS.has(inner)) {
    const deeper = mirageProgramAt(inner, args.slice(at + 1), session, registry, routing)
    return deeper === null ? null : at
  }
  if (outsideMirage(lookup(inner, session, registry, routing))) return null
  if (INTERPRETER_NAMES.has(inner) && !((bindings[inner] ?? null) instanceof LanguageRuntime))
    return null
  return at
}

/**
 * The status and stderr GNU's wrapper answers instead of running its
 * program: a bad option, or a word it cannot exec (`nice cd`). Mirrors
 * Python's `wrapper_refusal`.
 */
export function wrapperRefusal(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
): [number, string] | null {
  const grammar = PROGRAM_WRAPPERS.get(name)
  if (grammar === undefined) return null
  const [at, error] = readWrapper(name, args)
  if (error !== null) return [grammar.status, error]
  if (at === null) return null
  const inner = args[at] ?? ''
  if (!PROGRAM_WRAPPERS.has(inner) && !execs(inner, session, registry)) {
    return [127, grammar.missing.replace('{}', inner)]
  }
  return null
}

function usage(name: string, line: string, status: number): WrapperAnswer {
  return new WrapperAnswer({
    exitCode: status,
    stderr: `${line}\nTry '${name} --help' for more information.\n`,
  })
}

/** The `--help` or `--version` a wrapper's options stopped at. */
function helpWord(args: readonly string[]): string | null {
  for (const word of args) {
    if (word === '--' || !word.startsWith('-')) return null
    if (word.length > 2 && '--help'.startsWith(word)) return '--help'
    if (word.length > 2 && '--version'.startsWith(word)) return '--version'
  }
  return null
}

/** `nice` followed down a chain of itself to the end: the niceness it comes
 * to, an adjustment with nothing to run refused. */
function niceness(args: readonly string[]): WrapperAnswer {
  let level = 0
  const warned: string[] = []
  let words = [...args]
  for (;;) {
    const [at] = readWrapper('nice', words)
    const adjustment = niceAdjustment(at === null ? words : words.slice(0, at))
    if (at === null && adjustment !== null)
      return usage('nice', 'nice: a command must be given with an adjustment', 125)
    if (adjustment !== null && adjustment < 0)
      warned.push('nice: cannot set niceness: Permission denied\n')
    else if (adjustment !== null) level = Math.min(level + adjustment, LOWEST_PRIORITY)
    else if (at !== null) level = Math.min(level + DEFAULT_NICENESS, LOWEST_PRIORITY)
    if (at === null) break
    words = words.slice(at + 1)
  }
  return new WrapperAnswer({ stdout: `${String(level)}\n`, stderr: warned.join('') })
}

/** Whether a chain of `nice` ends with nothing left to run. */
function endsBare(args: readonly string[]): boolean {
  let words = [...args]
  for (;;) {
    const [at] = readWrapper('nice', words)
    if (at === null) return true
    if (words[at] !== 'nice') return false
    words = words.slice(at + 1)
  }
}

/**
 * What a wrapper does with no program it can hand to a Mirage layer: refuse
 * the line, say what it is, print the niceness, or run a path or another
 * wrapper through the shell.
 */
export function wrapperAnswer(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
): WrapperAnswer {
  const refused = wrapperRefusal(name, args, session, registry)
  if (refused !== null) {
    const [code, said] = refused
    return new WrapperAnswer({ exitCode: code, stderr: said })
  }
  const [at] = readWrapper(name, args)
  if (at !== null) {
    if (name === 'nice' && args[at] === 'nice' && endsBare(args)) return niceness(args)
    return new WrapperAnswer({ runsFrom: at })
  }
  const word = helpWord(args)
  if (word === '--version') return new WrapperAnswer({ stdout: versionLine(name) })
  if (word === '--help') {
    const spec = SHELL_SPECS[name]
    if (spec === undefined) throw new Error(`${name}: no spec`)
    return new WrapperAnswer({ stdout: renderHelp(name, spec, [], undefined, SYNOPSES[name]) })
  }
  if (name === 'nice') return niceness(args)
  if (name === 'setsid') return usage(name, 'setsid: no command specified', 1)
  return usage(name, `${name}: missing operand`, 125)
}

/** Whether no Mirage layer runs the command. */
function outsideMirage(consumer: Consumer): boolean {
  return consumer === Consumer.EXTERNAL || consumer === Consumer.UNKNOWN
}

/**
 * The program a wrapper runs, nested wrappers followed, when a runtime
 * captures it by name and runs it natively.
 */
function wrapped(
  name: string,
  args: readonly string[],
  bindings: Readonly<Record<string, Runtime | null | undefined>>,
): string | null {
  if (!PROGRAM_WRAPPERS.has(name) || Object.hasOwn(bindings, name)) return null
  const [at] = readWrapper(name, args)
  if (at === null) return null
  const inner = args[at] ?? ''
  if (isNative(Object.hasOwn(bindings, inner) ? bindings[inner] : null, inner)) return inner
  return wrapped(inner, args.slice(at + 1), bindings)
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
      !(registry.runtimeBindings[name] instanceof LanguageRuntime)
    )
      return null
    if (consumer === Consumer.EXTERNAL && registry.runtimeBindings[name] === undefined) return null
    return consumer
  }
  return RUNNERS.has(name) ? Consumer.UNKNOWN : null
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
  const runtime = registry.runtimeBindings[name]
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
    ...RUNNERS,
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
