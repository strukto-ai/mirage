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

import { resolvePath } from '../../../utils/path.ts'
import { materialize, IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { Session } from '../../session/session.ts'
import { sleep } from '../../abort.ts'
import { ExecutionNode } from '../../types.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { toScope, scopePath } from './scope.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

export async function handleEval(
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
): Promise<Result> {
  const script = args.join(' ')
  const io = await executeFn(script, { sessionId: session.sessionId })
  return [io.stdout, io, new ExecutionNode({ command: 'eval', exitCode: io.exitCode })]
}

const BASH_NOOP_SHORT_FLAGS = new Set(['l', 'i', 'e', 'u', 'x'])
const BASH_NOOP_LONG_FLAGS = new Set(['--login', '--norc', '--noprofile', '--posix', '--rcfile'])

function bashCError(): Result {
  const err = new TextEncoder().encode('bash: -c: option requires an argument\n')
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: 'bash', exitCode: 2, stderr: err }),
  ]
}

export async function handleBash(
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
  stdin: ByteSource | null = null,
): Promise<Result> {
  let script: string | null = null
  let readStdin = false
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (tok === '-c') {
      const next = args[i + 1]
      if (next === undefined) return bashCError()
      script = next
      break
    }
    if (tok === '-s') {
      readStdin = true
      i += 1
      continue
    }
    if (tok === '-o' || tok === '+o') {
      i += 2
      continue
    }
    if (BASH_NOOP_LONG_FLAGS.has(tok)) {
      i += 1
      continue
    }
    if (tok.startsWith('-') && tok.length > 1 && !tok.startsWith('--')) {
      const chars = tok.slice(1)
      if (chars.includes('c')) {
        const next = args[i + 1]
        if (next === undefined) return bashCError()
        script = next
        break
      }
      let allNoop = true
      for (let j = 0; j < chars.length; j++) {
        const ch = chars.charAt(j)
        if (!BASH_NOOP_SHORT_FLAGS.has(ch) && ch !== 's') {
          allNoop = false
          break
        }
      }
      if (allNoop) {
        if (chars.includes('s')) readStdin = true
        i += 1
        continue
      }
      const err = new TextEncoder().encode(`bash: ${tok}: unsupported option\n`)
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'bash', exitCode: 2, stderr: err }),
      ]
    }
    script = tok
    break
  }
  if (script === null && readStdin && stdin !== null) {
    const data = await materialize(stdin)
    if (data.length > 0) {
      script = new TextDecoder().decode(data)
      stdin = null
    }
  }
  if (script === null) {
    return [null, new IOResult(), new ExecutionNode({ command: 'bash', exitCode: 0 })]
  }
  const io = await executeFn(script, { sessionId: session.sessionId, stdin })
  return [io.stdout, io, new ExecutionNode({ command: `bash -c ${script}`, exitCode: io.exitCode })]
}

export async function handleSource(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  path: string | PathSpec,
  session: Session,
): Promise<Result> {
  const raw = scopePath(path)
  const resolved = resolvePath(raw, session.cwd)
  const scope = toScope(resolved)
  let script = ''
  try {
    const [data] = await dispatch('read', scope)
    if (data instanceof Uint8Array) {
      script = new TextDecoder().decode(data)
    } else if (data !== null && data !== undefined) {
      // ByteSource: collect into a string
      const chunks: number[] = []
      for await (const chunk of data as AsyncIterable<Uint8Array>) {
        for (const b of chunk) chunks.push(b)
      }
      script = new TextDecoder().decode(new Uint8Array(chunks))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(`source: ${raw}: ${msg}\n`),
      }),
      new ExecutionNode({ command: `source ${raw}`, exitCode: 1 }),
    ]
  }
  session.sourceDepth += 1
  try {
    const io = await executeFn(script, { sessionId: session.sessionId })
    return [io.stdout, io, new ExecutionNode({ command: `source ${raw}`, exitCode: io.exitCode })]
  } finally {
    session.sourceDepth -= 1
  }
}

// Finite non-negative decimals only ("0", "0.2", ".5", "1.", "+1", "1e-3").
// GNU sleep additionally accepts "inf" and sleeps forever; an agent shell
// must never hang, so non-finite intervals are rejected (deliberate
// divergence). The regex also keeps Python/TypeScript parsing identical:
// Number() alone would accept "0x10", "Infinity", and the empty string that
// float() rejects, and float() accepts "inf", "nan", and "1_0".
const SLEEP_INTERVAL = /^\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

export async function handleSleep(args: string[], signal?: AbortSignal): Promise<Result> {
  const raw = args[0]
  if (raw === undefined) {
    const err = new TextEncoder().encode('sleep: missing operand\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  // "1e309" passes the regex but overflows to Infinity, so check both.
  const seconds = SLEEP_INTERVAL.test(raw) ? Number(raw) : Infinity
  if (!Number.isFinite(seconds)) {
    const err = new TextEncoder().encode(`sleep: invalid time interval '${raw}'\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  await sleep(seconds * 1000, signal)
  return [null, new IOResult(), new ExecutionNode({ command: 'sleep', exitCode: 0 })]
}
