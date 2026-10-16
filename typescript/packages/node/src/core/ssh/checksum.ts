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

import type { PathSpec } from '@struktoai/mirage-core/types'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { joinRoot, stripPrefix } from './utils.ts'

export const SUMS: Readonly<Record<string, readonly [string, number]>> = {
  md5: ['md5sum', 32],
  sha1: ['sha1sum', 40],
  sha256: ['sha256sum', 64],
  sha384: ['sha384sum', 96],
  sha512: ['sha512sum', 128],
}

/**
 * A file's digest, by the matching coreutils sum on the server, so the bytes
 * never cross the connection.
 *
 * Only an exit of 0 with nothing on stderr and one digest of the algorithm's
 * length on stdout answers: a server that runs no commands or has no such
 * tool, a directory or a file the tool could not read leaves the file to be
 * read and hashed, which reports it. Mirrors Python's `checksum`.
 */
export async function checksum(
  accessor: SSHAccessor,
  p: PathSpec,
  algorithm: string,
): Promise<string | null> {
  const tool = Object.hasOwn(SUMS, algorithm) ? SUMS[algorithm] : undefined
  if (tool === undefined) return null
  const [name, width] = tool
  const remote = joinRoot(accessor.config.root ?? '/', stripPrefix(p))
  let status: number | null
  let out: Uint8Array
  let err: Uint8Array
  try {
    ;[status, out, err] = await accessor.run(`${name} < ${singleQuote(remote)}`)
  } catch (error) {
    console.debug(`ssh checksum left to the read: ${String(error)}`)
    return null
  }
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
