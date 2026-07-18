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
import { type ByteSource, materialize } from '../../io/types.ts'
import { PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'

export async function applyFindActions(
  stdout: ByteSource | null,
  flagKwargs: Record<string, string | boolean | string[]>,
  registry: MountRegistry,
  cwd: string,
): Promise<[ByteSource | null, Uint8Array]> {
  const hasDelete = flagKwargs.delete === true
  const hasPrint0 = flagKwargs.print0 === true
  const hasLs = flagKwargs.ls === true
  const hasPrint = flagKwargs.print === true

  if (!hasDelete && !hasPrint0 && !hasLs) return [stdout, new Uint8Array()]
  if (stdout === null) return [stdout, new Uint8Array()]

  const data = await materialize(stdout)
  const text = new TextDecoder().decode(data)
  const matches = text.split('\n').filter((p) => p !== '')
  const errors: Uint8Array[] = []
  const enc = new TextEncoder()

  let outputMatches: string[]

  if (hasDelete) {
    const deletable = matches.filter((p) => !registry.isMountRoot(p))
    const ordered = [...deletable].sort(
      (a, b) => (b.match(/\//g) ?? []).length - (a.match(/\//g) ?? []).length,
    )
    for (const path of ordered) {
      const mount = registry.mountFor(path)
      if (mount === null) {
        errors.push(enc.encode(`find: cannot delete '${path}': no mount\n`))
        continue
      }
      const slash = path.lastIndexOf('/')
      const ps = new PathSpec({
        resourcePath: stripSlash(path),
        virtual: path,
        directory: slash >= 0 ? path.slice(0, slash + 1) : '/',
        resolved: true,
      })
      try {
        // -d so directories emptied by the deepest-first pass are removable,
        // matching GNU -delete's rmdir behavior.
        const [, rmIo] = await mount.executeCmd('rm', [ps], [], { d: true }, { stdin: null, cwd })
        if (rmIo.exitCode !== 0) {
          const errBytes = await materialize(rmIo.stderr)
          if (errBytes.length > 0) errors.push(errBytes)
          else errors.push(enc.encode(`find: cannot delete '${path}'\n`))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(enc.encode(`find: cannot delete '${path}': ${msg}\n`))
      }
    }
    outputMatches = hasPrint ? matches : []
  } else if (hasLs) {
    outputMatches = []
    for (const path of matches) {
      const mount = registry.mountFor(path)
      if (mount === null) {
        errors.push(enc.encode(`find: cannot ls '${path}': no mount\n`))
        continue
      }
      const slash = path.lastIndexOf('/')
      const ps = new PathSpec({
        resourcePath: stripSlash(path),
        virtual: path,
        directory: slash >= 0 ? path.slice(0, slash + 1) : '/',
        resolved: true,
      })
      try {
        const [lsOut] = await mount.executeCmd(
          'ls',
          [ps],
          [],
          { args_l: true, d: true },
          { stdin: null, cwd },
        )
        if (lsOut !== null) {
          const line = new TextDecoder().decode(await materialize(lsOut)).replace(/\n+$/, '')
          if (line !== '') outputMatches.push(line)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(enc.encode(`find: cannot ls '${path}': ${msg}\n`))
      }
    }
  } else {
    outputMatches = matches
  }

  const errBlob = errors.length > 0 ? concat(errors) : new Uint8Array()
  if (outputMatches.length === 0) return [null, errBlob]

  let body: Uint8Array
  if (hasPrint0) {
    body = enc.encode(outputMatches.join('\x00') + '\x00')
  } else {
    body = enc.encode(outputMatches.join('\n') + '\n')
  }
  return [body, errBlob]
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
