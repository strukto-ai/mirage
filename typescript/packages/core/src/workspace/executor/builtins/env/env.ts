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

import { IOResult } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { shellJoin } from '../../../../shell/join.ts'
import { ownRecord, varsFromEnv } from '../../../session/session.ts'
import type { ShellVar } from '../../../../shell/variable.ts'
import type { Session } from '../../../session/session.ts'
import { envSnapshot } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { ENV_HELP_HINT } from './constants.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'

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
  const source = ignoreEnv ? {} : envSnapshot(session)
  const base: Record<string, string> = ownRecord()
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

  // `env NAME=v cmd` runs the command with a replaced environment. Only
  // the scalars are replaced: arrays were never part of the env the old
  // two-container store swapped, and bash does not put one in a child's
  // environment either. A still-unfetched managed entry is a scalar in
  // waiting, so it is replaced too: surviving the swap would let the
  // inner line fetch and read a name `-i` or `-u` just cleared.
  //
  // Built through `varsFromEnv`, the one conversion from an embedder's
  // process environment to session records, so the export attribute is
  // stamped in exactly one place rather than restated here. Seeded
  // plain, `env -i FOO=bar printenv FOO` printed nothing, since the
  // process view a command reads carries only exported names.
  const saved = session.vars
  const swapped = ownRecord<ShellVar>()
  for (const [name, v] of Object.entries(saved)) {
    if (typeof v.value !== 'string' && v.managed === undefined) swapped[name] = v
  }
  Object.assign(swapped, varsFromEnv(base))
  session.vars = swapped
  try {
    const io = await executeFn(shellJoin(command), { sessionId: session.sessionId, stdin })
    return [io.stdout, io, new ExecutionNode({ command: 'env', exitCode: io.exitCode })]
  } finally {
    session.vars = saved
  }
}

/** The `env` arm. */
export async function envBuiltin(call: BuiltinCall): Promise<Result> {
  return handleEnv(call.executeFn, [...call.argv.args], call.session, call.stdin)
}
