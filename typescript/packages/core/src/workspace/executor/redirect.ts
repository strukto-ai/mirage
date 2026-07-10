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

import { stripSlash } from '../../utils/slash.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import { materialize } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { type Redirect, RedirectKind } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { DispatchFn } from './cross_mount.ts'
import type { ExecuteNodeFn } from './jobs.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function handleRedirect(
  executeNode: ExecuteNodeFn,
  dispatch: DispatchFn,
  command: TSNodeLike,
  redirects: readonly Redirect[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  let cmdStdin: ByteSource | null = stdin

  for (const r of redirects) {
    if (r.kind === RedirectKind.STDIN) {
      const scope = ensureScope(r.target)
      const [data] = await dispatch('read', scope)
      cmdStdin = data as ByteSource | null
    } else if (r.kind === RedirectKind.HEREDOC) {
      cmdStdin =
        typeof r.target === 'string' ? new TextEncoder().encode(r.target) : (r.target as ByteSource)
    } else if (r.kind === RedirectKind.HERESTRING) {
      const text = r.target
      if (typeof text === 'string') {
        let t = text
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
          t = t.slice(1, -1)
        }
        cmdStdin = new TextEncoder().encode(`${t}\n`)
      } else {
        cmdStdin = text as ByteSource
      }
    }
  }

  const [stdout, io] = await executeNode(command, session, cmdStdin, callStack)
  const stdoutData = (await applyBarrier(stdout, io, BarrierPolicy.VALUE)) as Uint8Array | null
  const stderrData = await materialize(io.stderr)

  let resultStdout: Uint8Array | null = stdoutData ?? new Uint8Array()
  let resultStderr: Uint8Array | null = stderrData

  for (const r of redirects) {
    const stream = r.kind
    const append = r.append
    const fd = r.fd

    if (
      stream === RedirectKind.STDIN ||
      stream === RedirectKind.HEREDOC ||
      stream === RedirectKind.HERESTRING
    ) {
      continue
    }

    if (stream === RedirectKind.STDERR_TO_STDOUT && typeof r.target === 'number') {
      resultStdout = concat([resultStdout ?? new Uint8Array(), resultStderr ?? new Uint8Array()])
      resultStderr = null
      continue
    }

    if (fd === 1 && r.target === 2) {
      resultStderr = concat([resultStderr ?? new Uint8Array(), resultStdout ?? new Uint8Array()])
      resultStdout = null
      continue
    }

    const scope = ensureScope(r.target)
    const path = scope.virtual

    if (fd === -1) {
      let combined = concat([resultStdout ?? new Uint8Array(), resultStderr ?? new Uint8Array()])
      if (append) combined = await appendExisting(dispatch, scope, combined)
      try {
        await dispatch('write', scope, [combined])
        io.writes[path] = combined
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        resultStderr = concat([
          resultStderr ?? new Uint8Array(),
          new TextEncoder().encode(msg + '\n'),
        ])
        io.exitCode = 1
      }
      resultStdout = null
      resultStderr = null
      continue
    }

    if (stream === RedirectKind.STDERR) {
      let data = resultStderr ?? new Uint8Array()
      if (append) data = await appendExisting(dispatch, scope, data)
      if (data.byteLength > 0) {
        try {
          await dispatch('write', scope, [data])
          io.writes[path] = data
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          resultStderr = new TextEncoder().encode(msg + '\n')
          io.exitCode = 1
          continue
        }
      }
      resultStderr = null
      continue
    }

    let data = resultStdout ?? new Uint8Array()
    if (append) data = await appendExisting(dispatch, scope, data)
    try {
      await dispatch('write', scope, [data])
      io.writes[path] = data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      resultStderr = concat([
        resultStderr ?? new Uint8Array(),
        new TextEncoder().encode(msg + '\n'),
      ])
      io.exitCode = 1
    }
    resultStdout = null
  }

  io.stderr = resultStderr
  const execNode = new ExecutionNode({ command: 'redirect', exitCode: io.exitCode })
  const outSource: ByteSource | null =
    resultStdout !== null && resultStdout.byteLength > 0 ? resultStdout : null
  return [outSource, io, execNode]
}

async function appendExisting(
  dispatch: DispatchFn,
  scope: PathSpec,
  data: Uint8Array,
): Promise<Uint8Array> {
  try {
    const [existing] = await dispatch('read', scope)
    if (existing instanceof Uint8Array) return concat([existing, data])
  } catch {
    // file doesn't exist yet, or not readable — treat as starting fresh
  }
  return data
}

function ensureScope(target: unknown): PathSpec {
  if (target instanceof PathSpec) return target
  if (typeof target === 'string') return toScope(target)
  return toScope(String(target))
}

function toScope(path: string): PathSpec {
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ resourcePath: stripSlash(path), virtual: path, directory, resolved: true })
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
