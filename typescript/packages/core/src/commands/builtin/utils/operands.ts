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

import { IOResult, materialize } from '../../../io/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'

const ENC = new TextEncoder()

type Stat = (p: PathSpec) => Promise<FileStat>

// Partition operands into readable paths and GNU stderr lines. Read-family
// commands (cat/head/tail/wc) process remaining operands after one fails,
// per GNU coreutils: each failed operand becomes one `<cmd>: <path>:
// <strerror>` line and the command exits 1 while still emitting output for
// the operands that resolved. Each path is stat'ed eagerly so a lazy output
// stream never aborts mid-drain on a missing operand. Non-filesystem errors
// keep propagating.
export async function splitReadable(
  paths: readonly PathSpec[],
  stat: Stat,
  cmdName: string,
): Promise<[PathSpec[], string]> {
  const readable: PathSpec[] = []
  let err = ''
  for (const p of paths) {
    try {
      await stat(p)
    } catch (e) {
      if (!isFsError(e)) throw e
      err += fsErrorLine(cmdName, p, e)
      continue
    }
    readable.push(p)
  }
  return [readable, err]
}

export interface ReadOperand {
  path: PathSpec
  data: Uint8Array
}

// Read every operand eagerly, skipping the ones whose read fails with a
// filesystem error: each failed operand becomes one GNU stderr line and the
// remaining operands still process (the read-family rule). Lives inside the
// generics so every wrapper — factory builders and bespoke backend commands
// alike — inherits the behavior. Non-filesystem errors keep propagating.
export async function readOperands(
  paths: readonly PathSpec[],
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  cmdName: string,
): Promise<[ReadOperand[], string]> {
  const ok: ReadOperand[] = []
  let err = ''
  for (const p of paths) {
    try {
      ok.push({ path: p, data: await materialize(stream(p)) })
    } catch (e) {
      if (!isFsError(e)) throw e
      err += fsErrorLine(cmdName, p, e)
    }
  }
  return [ok, err]
}

// IOResult carrying the readOperands stderr lines: exit 1 when any operand
// failed, exit 0 otherwise.
export function operandsIo(err: string, init?: { cache?: string[] }): IOResult {
  return new IOResult({
    ...(init?.cache !== undefined ? { cache: init.cache } : {}),
    exitCode: err === '' ? 0 : 1,
    stderr: err === '' ? null : ENC.encode(err),
  })
}

// A one-shot stream over already-materialized bytes, for feeding buffered
// operands back through a stream transformer.
// eslint-disable-next-line @typescript-eslint/require-await
export async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  if (data.byteLength > 0) yield data
}
