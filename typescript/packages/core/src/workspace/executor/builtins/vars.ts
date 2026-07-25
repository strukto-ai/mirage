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

import { SHELL_SPECS, parseShellOptions } from '../../../commands/spec/shell.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { asyncChain } from '../../../io/stream.ts'
import { IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import { ExitSignal } from '../../../shell/errors.ts'
import { shellJoin } from '../../../shell/join.ts'
import { SET_FLAG_TO_OPTION } from '../../../shell/types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import { ReturnSignal } from '../command.ts'
import type { ExecuteStringFn, Result } from './scope.ts'

export function handleExport(assignments: string[], session: Session): Result {
  for (const assign of assignments) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (session.readonlyVars.has(key)) {
        const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'export', exitCode: 1, stderr: err }),
        ]
      }
      session.env[key] = assign.slice(eq + 1)
    } else if (!(assign in session.env)) {
      session.env[assign] = ''
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
}

export function handleReadonly(assignments: string[], session: Session): Result {
  for (const assign of assignments) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (session.readonlyVars.has(key)) {
        const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'readonly', exitCode: 1, stderr: err }),
        ]
      }
      session.env[key] = assign.slice(eq + 1)
      session.readonlyVars.add(key)
    } else {
      session.readonlyVars.add(assign)
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}

export function handleUnset(names: string[], session: Session): Result {
  for (const name of names) {
    if (session.readonlyVars.has(name)) {
      const err = new TextEncoder().encode(
        `bash: unset: ${name}: cannot unset: readonly variable\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.env[name]
    if (name === 'OPTIND') session.getoptsOptind = null
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'unset', exitCode: 0 })]
}

export function handlePrintenv(name: string | null, session: Session): Result {
  if (name !== null) {
    const val = session.env[name]
    if (val === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1 }),
        new ExecutionNode({ command: 'printenv', exitCode: 1 }),
      ]
    }
    const out = new TextEncoder().encode(`${val}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
  }
  const lines = Object.entries(session.env).map(([k, v]) => `${k}=${v}`)
  lines.sort()
  const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
}

const ENV_HELP_HINT = "Try 'env --help' for more information.\n"

function envError(message: string): Result {
  const err = new TextEncoder().encode(`${message}\n${ENV_HELP_HINT}`)
  return [
    null,
    new IOResult({ exitCode: 125, stderr: err }),
    new ExecutionNode({ command: 'env', exitCode: 125, stderr: err }),
  ]
}

export async function handleEnv(
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
  stdin: ByteSource | null = null,
): Promise<Result> {
  let ignoreEnv = false
  let nullSep = false
  const unset: string[] = []
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (tok === '-i' || tok === '--ignore-environment') {
      ignoreEnv = true
      i += 1
      continue
    }
    if (tok === '-0' || tok === '--null') {
      nullSep = true
      i += 1
      continue
    }
    if (tok === '-') {
      // GNU: "a mere - implies -i".
      ignoreEnv = true
      i += 1
      continue
    }
    if (tok === '--unset') {
      if (i + 1 >= args.length) {
        return envError("env: option '--unset' requires an argument")
      }
      unset.push(args[i + 1] ?? '')
      i += 2
      continue
    }
    if (tok.startsWith('--unset=')) {
      unset.push(tok.slice('--unset='.length))
      i += 1
      continue
    }
    if (tok.startsWith('--')) {
      return envError(`env: unrecognized option '${tok}'`)
    }
    if (tok.startsWith('-') && tok.length > 1) {
      let j = 1
      let consumedNext = false
      let errored: string | null = null
      while (j < tok.length) {
        const ch = tok[j]
        if (ch === 'i') {
          ignoreEnv = true
        } else if (ch === '0') {
          nullSep = true
        } else if (ch === 'u') {
          const rest = tok.slice(j + 1)
          if (rest !== '') {
            unset.push(rest)
          } else if (i + 1 < args.length) {
            unset.push(args[i + 1] ?? '')
            consumedNext = true
          } else {
            errored = "env: option requires an argument -- 'u'"
          }
          break
        } else {
          errored = `env: invalid option -- '${ch ?? ''}'`
          break
        }
        j += 1
      }
      if (errored !== null) return envError(errored)
      i += consumedNext ? 2 : 1
      continue
    }
    break
  }

  const dropSet = new Set(unset)
  const source = ignoreEnv ? {} : session.env
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) {
    if (!dropSet.has(k)) base[k] = v
  }
  while (i < args.length && (args[i] ?? '').includes('=') && !(args[i] ?? '').startsWith('=')) {
    const tok = args[i] ?? ''
    const eq = tok.indexOf('=')
    base[tok.slice(0, eq)] = tok.slice(eq + 1)
    i += 1
  }

  const command = args.slice(i)
  if (command.length > 0 && nullSep) {
    return envError('env: cannot specify --null (-0) with command')
  }
  if (command.length === 0) {
    const sep = nullSep ? '\0' : '\n'
    const out = new TextEncoder().encode(
      Object.entries(base)
        .map(([k, v]) => `${k}=${v}${sep}`)
        .join(''),
    )
    return [out, new IOResult(), new ExecutionNode({ command: 'env', exitCode: 0 })]
  }

  const saved = session.env
  session.env = base
  try {
    const io = await executeFn(shellJoin(command), { sessionId: session.sessionId, stdin })
    return [io.stdout, io, new ExecutionNode({ command: 'env', exitCode: io.exitCode })]
  } finally {
    session.env = saved
  }
}

export function handleWhoami(namespace: Namespace): Result {
  // GNU whoami reports the effective user and never consults $USER; the
  // workspace user (launch agentId, shared via the namespace store) is
  // the effective identity here. With no claimed identity it fails like
  // GNU does for a uid with no passwd entry.
  if (namespace.user === null) {
    const err = new TextEncoder().encode('whoami: cannot find name for user ID\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'whoami', exitCode: 1, stderr: err }),
    ]
  }
  const out = new TextEncoder().encode(`${namespace.user}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'whoami', exitCode: 0 })]
}

export function handleLocal(assignments: string[], session: Session): Result {
  const locals = session.localVars
  for (const assign of assignments) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (locals !== null && !locals.has(key)) {
        locals.set(key, key in session.env ? (session.env[key] ?? null) : null)
      }
      session.env[key] = assign.slice(eq + 1)
    } else {
      if (locals !== null && !locals.has(assign)) {
        locals.set(assign, assign in session.env ? (session.env[assign] ?? null) : null)
      }
      if (!(assign in session.env)) session.env[assign] = ''
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'local', exitCode: 0 })]
}

function isShiftCount(word: string): boolean {
  const body = word.startsWith('-') || word.startsWith('+') ? word.slice(1) : word
  return /^\d+$/.test(body)
}

/** Shift positional parameters, with bash's argument checks. */
export function handleShift(
  args: readonly string[],
  callStack: CallStack | null,
  session: Session | null = null,
): Result {
  if (args.length > 1) {
    const err = new TextEncoder().encode('shift: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    const err = new TextEncoder().encode(`shift: ${first}: numeric argument required\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const n = first !== undefined ? Number(first) : 1
  let shifted = false
  if (callStack !== null && callStack.getAllPositional().length > 0) {
    callStack.shift(n)
    shifted = true
  }
  if (!shifted && session !== null) {
    session.positionalArgs = session.positionalArgs.slice(n)
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'shift', exitCode: 0 })]
}

export function handleSet(
  args: string[],
  session: Session,
  _callStack: CallStack | null = null,
): Result {
  if (args.length === 0) {
    const lines = Object.entries(session.env).map(([k, v]) => `${k}=${v}`)
    lines.sort()
    const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
  }
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      session.positionalArgs = args.slice(i + 1)
      return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
    }
    if (tok === '-o' || tok === '+o') {
      if (i + 1 < args.length) {
        const optName = args[i + 1] ?? ''
        session.shellOptions[optName] = tok === '-o'
        i += 2
        continue
      }
      i += 1
      continue
    }
    if ((tok.startsWith('-') || tok.startsWith('+')) && tok.length > 1) {
      const enable = tok.startsWith('-')
      for (const ch of tok.slice(1)) {
        const opt = SET_FLAG_TO_OPTION[ch]
        if (opt !== undefined) session.shellOptions[opt] = enable
      }
      i += 1
      continue
    }
    session.positionalArgs = args.slice(i)
    break
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isValidName(name: string): boolean {
  return IDENTIFIER_RE.test(name)
}

function getoptsFinish(
  session: Session,
  name: string,
  optValue: string,
  optarg: string | null,
  newOptind: number,
  newPos: number,
  exitCode: number,
  stderr: Uint8Array | null = null,
): Result {
  // The name is assigned last, exactly as bash does: OPTIND/OPTARG and
  // the hidden cursor still advance, but a bad destination fails the
  // write and turns the call into a status-1 error.
  if (!isValidName(name)) {
    stderr = new TextEncoder().encode(`bash: getopts: \`${name}': not a valid identifier\n`)
    exitCode = 1
  } else if (session.readonlyVars.has(name)) {
    stderr = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
    exitCode = 1
  } else {
    session.env[name] = optValue
  }
  if (optarg === null) delete session.env.OPTARG
  else session.env.OPTARG = optarg
  session.env.OPTIND = String(newOptind)
  session.getoptsPos = newPos
  session.getoptsOptind = newOptind
  const io = new IOResult(stderr === null ? { exitCode } : { exitCode, stderr })
  const node =
    stderr === null
      ? new ExecutionNode({ command: 'getopts', exitCode })
      : new ExecutionNode({ command: 'getopts', exitCode, stderr })
  return [null, io, node]
}

/** Parse one option per call, with bash's getopts semantics. */
export function handleGetopts(
  args: readonly string[],
  session: Session,
  callStack: CallStack | null = null,
): Result {
  if (args.length < 2) {
    const err = new TextEncoder().encode('getopts: usage: getopts optstring name [arg]\n')
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'getopts', exitCode: 2, stderr: err }),
    ]
  }
  const optstring = args[0] ?? ''
  const name = args[1] ?? ''
  let params: readonly string[]
  if (args.length > 2) params = args.slice(2)
  else if (callStack !== null && callStack.getAllPositional().length > 0)
    params = callStack.getAllPositional()
  else params = session.positionalArgs
  const silent = optstring.startsWith(':')
  const verbose = !silent && (session.env.OPTERR ?? '1') !== '0'
  const parsed = Number.parseInt(session.env.OPTIND ?? '1', 10)
  let optind = Number.isNaN(parsed) ? 1 : parsed
  // Bash treats a nonpositive OPTIND as a restart at argument 1.
  const restart = optind < 1
  if (restart) optind = 1
  if (restart || session.getoptsOptind !== optind) session.getoptsPos = 0
  let pos = session.getoptsPos

  if (optind > params.length) {
    return getoptsFinish(session, name, '?', null, optind, 0, 1)
  }
  const word = params[optind - 1] ?? ''
  // A stale cursor left past the end of the current word (a shorter or
  // reused argument) restarts the scan rather than reading undefined.
  if (pos >= word.length) pos = 0
  if (pos === 0) {
    if (!word.startsWith('-') || word === '-') {
      return getoptsFinish(session, name, '?', null, optind, 0, 1)
    }
    if (word === '--') return getoptsFinish(session, name, '?', null, optind + 1, 0, 1)
    pos = 1
  }

  const letter = word[pos] ?? ''
  const rest = word.slice(pos + 1)
  const idx = optstring.indexOf(letter)
  const isValid = letter !== ':' && idx !== -1
  const takesArg = isValid && idx + 1 < optstring.length && optstring[idx + 1] === ':'
  const enc = new TextEncoder()

  if (!isValid) {
    const [afterOptind, afterPos] = rest ? [optind, pos + 1] : [optind + 1, 0]
    if (silent) return getoptsFinish(session, name, '?', letter, afterOptind, afterPos, 0)
    const err = verbose ? enc.encode(`bash: illegal option -- ${letter}\n`) : null
    return getoptsFinish(session, name, '?', null, afterOptind, afterPos, 0, err)
  }

  if (!takesArg) {
    const [afterOptind, afterPos] = rest ? [optind, pos + 1] : [optind + 1, 0]
    return getoptsFinish(session, name, letter, null, afterOptind, afterPos, 0)
  }

  if (rest) return getoptsFinish(session, name, letter, rest, optind + 1, 0, 0)
  if (optind < params.length) {
    return getoptsFinish(session, name, letter, params[optind] ?? '', optind + 2, 0, 0)
  }
  if (silent) return getoptsFinish(session, name, ':', letter, optind + 1, 0, 0)
  const err = verbose ? enc.encode(`bash: option requires an argument -- ${letter}\n`) : null
  return getoptsFinish(session, name, '?', null, optind + 1, 0, 0, err)
}

export function handleTrap(_session: Session): Result {
  return [null, new IOResult(), new ExecutionNode({ command: 'trap', exitCode: 0 })]
}

/** Return from a function or sourced script, with bash's checks. */
export function handleReturn(
  args: readonly string[],
  session: Session,
  callStack: CallStack | null = null,
): Result {
  const inFunction = callStack !== null && callStack.depth > 1
  if (!inFunction && session.sourceDepth === 0) {
    // bash prints the diagnostic, sets $? to 2, and carries on with
    // the rest of the line.
    const err = new TextEncoder().encode(
      "return: can only `return' from a function or sourced script\n",
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 2, stderr: err }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    // bash prints the error and the function returns 2.
    throw new ReturnSignal(
      2,
      new TextEncoder().encode(`return: ${first}: numeric argument required\n`),
    )
  }
  if (args.length > 1) {
    const err = new TextEncoder().encode('return: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 1, stderr: err }),
    ]
  }
  // A bare return propagates the status of the last command executed.
  throw new ReturnSignal(
    first !== undefined ? ((Number(first) % 256) + 256) % 256 : session.lastExitCode,
  )
}

/** Exit the shell, with bash's argument checks. */
export function handleExit(args: readonly string[], session: Session): Result {
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    // bash exits with 2 after the diagnostic.
    throw new ExitSignal(2, new TextEncoder().encode(`exit: ${first}: numeric argument required\n`))
  }
  if (args.length > 1) {
    // bash refuses to exit and the command fails with 1.
    const err = new TextEncoder().encode('exit: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'exit', exitCode: 1, stderr: err }),
    ]
  }
  const code = first !== undefined ? Number(first) : session.lastExitCode
  throw new ExitSignal(((code % 256) + 256) % 256)
}

/** Split on whitespace runs with a maxsplit, like Python's split(None, n). */
function splitOnWhitespace(text: string, maxsplit: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /[ \t\n]/.test(text[i] ?? '')) i++
    if (i >= text.length) break
    if (out.length === maxsplit) {
      out.push(text.slice(i))
      return out
    }
    let j = i
    while (j < text.length && !/[ \t\n]/.test(text[j] ?? '')) j++
    out.push(text.slice(i, j))
    i = j
  }
  return out
}

/**
 * Read one line into variables, with bash's option handling.
 *
 * Only -r is accepted (our read is already raw, so it is consumed with
 * no effect); anything else errors like bash instead of being treated
 * as a variable name.
 */
export async function handleRead(
  args: string[],
  session: Session,
  stdin: ByteSource | null,
): Promise<Result> {
  const parse = parseShellOptions(SHELL_SPECS.read, args)
  if (parse.invalid !== null) {
    const token = parse.invalid.startsWith('--') ? parse.invalid : `-${parse.invalid}`
    const err = new TextEncoder().encode(`read: ${token}: invalid option\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 2 }),
    ]
  }
  const variables = parse.operands.length > 0 ? parse.operands : ['REPLY']
  // A NEW stdin source replaces any leftover buffer (a previous
  // command's exhausted herestring/pipe must not shadow this one); the
  // SAME source object reuses the buffer so sequential reads advance
  // through its lines.
  if (stdin !== null && (session.stdinBuffer === null || session.stdinSource !== stdin)) {
    if (stdin instanceof Uint8Array) {
      session.stdinBuffer = new AsyncLineIterator(asyncChain(stdin))
    } else {
      session.stdinBuffer = new AsyncLineIterator(stdin)
    }
    session.stdinSource = stdin
  }
  let lineBytes: Uint8Array | null = null
  if (session.stdinBuffer !== null) {
    lineBytes = await session.stdinBuffer.readline()
  }
  if (lineBytes === null) {
    for (const v of variables) {
      session.env[v] = ''
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.arrays[v]
    }
    return [
      null,
      new IOResult({ exitCode: 1 }),
      new ExecutionNode({ command: 'read', exitCode: 1 }),
    ]
  }
  const decodedLine = new TextDecoder().decode(lineBytes)
  let lineEnd = decodedLine.length
  while (lineEnd > 0 && decodedLine.charCodeAt(lineEnd - 1) === 10) lineEnd--
  const line = decodedLine.slice(0, lineEnd)
  const ifs = session.env.IFS ?? ' \t\n'
  let parts: string[]
  if (ifs === ' \t\n') {
    // GNU trims IFS whitespace from both ends before splitting; the
    // remainder assigned to the last variable keeps inner whitespace.
    parts = splitOnWhitespace(line.replace(/^[ \t\n]+|[ \t\n]+$/g, ''), variables.length - 1)
  } else if (ifs === '') {
    parts = [line]
  } else {
    const ifsWs = new Set<string>(
      ifs.split('').filter((c) => c === ' ' || c === '\t' || c === '\n'),
    )
    let start = 0
    let end = line.length
    while (start < end && ifsWs.has(line[start] ?? '')) start++
    while (end > start && ifsWs.has(line[end - 1] ?? '')) end--
    const work = line.slice(start, end)
    const nSplits = Math.max(0, variables.length - 1)
    const chars = new Set(ifs.split(''))
    const out: string[] = []
    let cur = ''
    for (const ch of work) {
      if (chars.has(ch) && out.length < nSplits) {
        out.push(cur)
        cur = ''
        continue
      }
      cur += ch
    }
    out.push(cur)
    parts = out
  }
  for (let i = 0; i < variables.length; i++) {
    const name = variables[i]
    if (name === undefined) continue
    session.env[name] = parts[i] ?? ''
    // A scalar write replaces any array of the same name, matching
    // the variable_assignment path.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.arrays[name]
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'read', exitCode: 0 })]
}

/**
 * `source FILE` / `. FILE` — read a script file and execute it.
 * Mirrors Python's `mirage.workspace.executor.builtins.handle_source`.
 */
