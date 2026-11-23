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

import { SPECS, parseCommand } from '../../../commands/spec/index.ts'
import { currentCaller } from '../../../context/session_context.ts'
import { liveEgress } from '../../../io/gateway.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import type { RouteDecision } from '../../../runtime/types.ts'
import { unmarkGlobs } from '../../../utils/glob_walk.ts'
import { parent, resolvePath } from '../../../utils/path.ts'
import type { NamespaceReader } from '../../dispatcher/reader.ts'
import type { Argv } from '../../expand/argv.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { LOCALHOST_WORD, MACHINE_FACTS, NETWORK_CLIENTS } from '../constants.ts'
import { Consumer, type ExternalTarget } from '../types.ts'
import { optionPaths, pathOperands } from './command.ts'
import { isPiped, machineHoldingAll, machineMounts, onlyMachine } from './mounts.ts'
import { folderHolders, holdingMachines } from './search.ts'

/**
 * The machine a command that asks about its machine is about: the one its
 * line names, else the one a command Mirage runs itself prefers
 * (`Caller.preferredMachine`: the machine whose program writes its pipe, or
 * the one machine holding its folder), else the first that takes programs
 * no name captures, where the session's programs run. Null where no machine
 * takes them. Mirrors Python's `about_machine`.
 *
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement.
 */
export function aboutMachine(
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
): RemoteRuntime | null {
  if (routing === undefined) return null
  const told = routing.machine ?? currentCaller().preferredMachine ?? null
  if (told !== null) return onlyMachine([told], registry)
  const first = routing.bindings[EXTERNAL_COMMANDS]
  return first instanceof RemoteRuntime ? first : null
}

/**
 * Whether a command of Mirage's own asks about the machine it runs on: one
 * that reports a machine's facts (`MACHINE_FACTS`), or one that reaches a
 * server at `localhost` (`NETWORK_CLIENTS`). Mirrors Python's
 * `asks_about_machine`.
 *
 * @param argv the command.
 */
export function asksAboutMachine(argv: Argv): boolean {
  if (MACHINE_FACTS.has(argv.name)) return true
  return NETWORK_CLIENTS.has(argv.name) && argv.args.some((word) => LOCALHOST_WORD.test(word))
}

/**
 * The files a client that reaches a server reads or writes through words its
 * spec keeps as text, as typed: curl's `@file` data and `-w @file` template,
 * the cookie file a `-b` without `=` names, and, for wget with neither `-O`
 * nor `--spider`, its folder itself (`.`), where it saves under a name it
 * picks as it runs (`report.1` when `report` is there). Null where Mirage
 * cannot tell which files the program touches: an option its spec does not
 * know, a `-F` field read from a file, which Mirage's curl sends as given,
 * and a second wget operand, a URL to the machine's wget and a destination
 * to Mirage's. Mirrors Python's `_client_files`.
 *
 * @param argv the command, one of `NETWORK_CLIENTS`.
 * @param cwd the directory a relative path resolves against.
 */
function clientFiles(argv: Argv, cwd: string): string[] | null {
  const spec = SPECS[argv.name]
  if (spec === undefined) return null
  const parsed = parseCommand(spec, [...argv.args], cwd, argv.name)
  if (parsed.optionErrorKinds.length > 0) return null
  const flags = parsed.flags
  if (argv.name === 'wget') {
    const urls = parsed.rawOperands.map(([word]) => word)
    if (urls.length > 1) return null
    if ('-O' in flags || flags['--spider'] === true) return []
    return ['.']
  }
  const form = flags['--form']
  if (typeof form === 'string') {
    const at = form.indexOf('=')
    const lead = at < 0 ? '' : form.charAt(at + 1)
    if (lead === '@' || lead === '<') return null
  }
  const given = (key: string): string[] => {
    const value = flags[key]
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  }
  const named: string[] = []
  for (const key of ['--data', '--data-binary', '--json'])
    for (const value of given(key)) if (value.startsWith('@')) named.push(value.slice(1))
  for (const value of given('--data-urlencode')) {
    let sep = value.indexOf('=')
    if (sep < 0) sep = value.indexOf('@')
    if (sep >= 0 && value[sep] === '@') named.push(value.slice(sep + 1))
  }
  for (const value of given('--cookie')) if (!value.includes('=')) named.push(value)
  const template = flags['--write-out']
  if (typeof template === 'string' && template.startsWith('@')) named.push(template.slice(1))
  return named.filter((name) => name !== '' && name !== '-')
}

/**
 * The path a machine must hold for a command that writes `path` to run
 * there: `path` where a machine holds it, else its folder, where the new
 * file lands. Null where a write may not reach it on a machine
 * (`machineMounts`): another mount, a read-only one, a mount the session's
 * rules restrict, or a link of Mirage's own on the way, the name itself
 * included. Mirrors Python's `_written_scope`.
 *
 * @param path an absolute virtual path the command writes.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
async function writtenScope(
  path: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<string | null> {
  if (machineMounts([[path, true]], session, registry, links) === null) return null
  if ((await holdingMachines(path, registry)).length > 0) return path
  return parent(path)
}

/**
 * The machine a command that asks about its machine runs on whole
 * (`asksAboutMachine`): `uname -m` is the machine's own answer, where
 * Mirage's is no machine's, and `curl localhost:8000` reaches the server a
 * program of the session started there. It runs from the session's folder
 * when the machine holds it, else from `/`.
 *
 * Mirage keeps the command where no machine takes programs (`aboutMachine`),
 * or that machine refuses the session's runs or would not find the program
 * on the PATH the run gets; when a path it names or a file it reads or
 * writes is not that machine's own, a file it writes counting by its folder
 * while no machine holds it (`writtenScope`), or is typed relative to a
 * folder the machine does not hold; when a coded file policy speaks for the
 * session and the command touches a path, which the policy judges inside
 * Mirage; when input is piped into a machine that takes none; and, for a
 * command that reaches a server, when the workspace limits its
 * network or a policy watches its connections, which only Mirage judges, or
 * when Mirage cannot tell which files it touches (`clientFiles`). Mirrors
 * Python's `fact_machine`.
 *
 * @param argv the command.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param routing the line's placement.
 * @param stdin what is piped into it.
 * @param asked the machines the line found holding its folders
 *   (`ExecutionFrame.folderHolders`).
 */
export async function factMachine(
  argv: Argv,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  routing: RouteDecision<Runtime> | undefined,
  stdin: ByteSource | null,
  asked: Map<string, string[]>,
): Promise<ExternalTarget | null> {
  if (!asksAboutMachine(argv)) return null
  const runtime = aboutMachine(registry, routing)
  if (runtime === null || runtime.refusesSession()) return null
  if (isPiped(stdin) && !runtime.handle().takesInput) return null
  const client = NETWORK_CLIENTS.has(argv.name)
  if (client)
    for (const egress of liveEgress())
      if (egress.rule !== null || (await egress.hooked)) return null
  const cwd = session.cwd
  const files = client ? clientFiles(argv, cwd) : []
  if (files === null) return null
  const typed = pathOperands(argv, cwd).filter((w) => w.rawPath !== '-')
  const options = optionPaths(argv, cwd)
  if (
    (typed.length > 0 || options.length > 0 || files.length > 0) &&
    (await registry.policies.wantsFor('preVfs', session.sessionId))
  )
    return null
  const holding = await folderHolders(cwd, session, registry, asked)
  const here = holding.includes(runtime.defaultMachine)
  const rooted = optionPaths(argv, '/')
  const leans =
    options.length !== rooted.length ||
    options.some((path, at) => path !== rooted[at]) ||
    typed.some((w) => !w.rawPath.startsWith('/')) ||
    files.some((name) => !name.startsWith('/'))
  if (leans && !here) return null
  const written: string[] = []
  for (const path of options) {
    const scope = await writtenScope(path, session, registry, links)
    if (scope === null) return null
    written.push(scope)
  }
  const paths = [
    ...typed.map((w) => unmarkGlobs(w.virtual)),
    ...written,
    ...files.map((name) => resolvePath(name, cwd)),
  ]
  if (paths.length > 0) {
    const held = await machineHoldingAll(
      paths.map((path) => [path, true] as const),
      session,
      registry,
      links,
      null,
    )
    if (held !== runtime) return null
  }
  const found = await runtime
    .handle()
    .findsProgram(argv.name, envSnapshot(session).PATH ?? null, here ? cwd : '/')
  if (!found) return null
  return { kind: Consumer.EXTERNAL, runtime, ...(here ? {} : { cwd: '/' }) }
}
