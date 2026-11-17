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

import { singleQuote } from '../../utils/quote.ts'
import { SUMS } from './constants.ts'
import type { RunFn } from './types.ts'

/**
 * A file's digest, by the matching coreutils sum where it is, so the bytes
 * never travel. Only an exit of 0 with nothing on stderr and one digest of
 * the algorithm's length on stdout answers: a host that runs no commands or
 * has no such tool, a directory or a file the tool could not read leaves
 * the file to be read and hashed, which reports it.
 *
 * @param run runs a line where the file is.
 * @param remote the file's path there.
 * @param algorithm the hashlib name asked for.
 */
export async function checksum(
  run: RunFn,
  remote: string,
  algorithm: string,
): Promise<string | null> {
  const tool = Object.hasOwn(SUMS, algorithm) ? SUMS[algorithm] : undefined
  if (tool === undefined) return null
  const [name, width] = tool
  const [status, out, err] = await run(`${name} < ${singleQuote(remote)}`)
  const text = new TextDecoder().decode(out)
  const digest = text.slice(0, width)
  if (
    status !== 0 ||
    err.length > 0 ||
    text.slice(width) !== '  -\n' ||
    !new RegExp(`^[0-9a-f]{${String(width)}}$`).test(digest)
  ) {
    return null
  }
  return digest
}
