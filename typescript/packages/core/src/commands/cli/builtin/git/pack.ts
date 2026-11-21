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

import { StreamRefusal } from '../../../../rs/errors.ts'
import { openStreamSync } from '../../../../rs/stream.ts'
import type { PathSpec } from '../../../../types.ts'
import { sha1Hex } from '../../../../utils/hash.ts'
import { fromHex, toHex } from '../../../../utils/hex.ts'
import type { IdSource } from '../../../../utils/ids.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { Files } from '../../../../workspace/files.ts'
import { IDX_SUFFIX, PACK_DIR } from './constants.ts'
import { GitError } from './errors.ts'
import {
  applyDelta,
  FANOUT_SIZE,
  IDX_MAGIC,
  inflate,
  KINDS,
  LARGE,
  OFS_DELTA,
  openBlocks,
  readBlocks,
  SHA_BYTES,
  V2_HEADER,
  wrapped,
} from './fs.ts'
import { ensureDir, exists, removeFile } from './io.ts'

const DEC = new TextDecoder()

/** One entry the scan listed. */
interface Scanned {
  readonly offset: number
  readonly data: number
  readonly end: number
  readonly crc: number
  readonly kind: number
  readonly base: string
}

/** A pack's v2 index: its sorted names, their CRCs and offsets, the pack's checksum, its own. */
async function packIndex(
  entries: readonly { oid: string; offset: number; crc: number }[],
  checksum: Uint8Array,
): Promise<Uint8Array> {
  const count = entries.length
  const wide = entries.filter((entry) => entry.offset >= LARGE)
  const out = new Uint8Array(V2_HEADER + FANOUT_SIZE + count * 28 + wide.length * 8 + 2 * SHA_BYTES)
  const view = new DataView(out.buffer)
  out.set([...IDX_MAGIC, 0, 0, 0, 2])
  const names = V2_HEADER + FANOUT_SIZE
  const crcs = names + count * SHA_BYTES
  const offsets = crcs + count * 4
  const large = offsets + count * 4
  let slot = 0
  entries.forEach((entry, i) => {
    out.set(fromHex(entry.oid), names + i * SHA_BYTES)
    view.setUint32(crcs + i * 4, entry.crc, false)
    if (entry.offset < LARGE) view.setUint32(offsets + i * 4, entry.offset, false)
    else {
      view.setUint32(offsets + i * 4, (LARGE | slot) >>> 0, false)
      view.setUint32(large + slot * 8, Math.floor(entry.offset / 2 ** 32), false)
      view.setUint32(large + slot * 8 + 4, entry.offset % 2 ** 32, false)
      slot++
    }
  })
  let at = 0
  for (let byte = 0; byte < 256; byte++) {
    while (at < count && Number.parseInt(entries[at]?.oid.slice(0, 2) ?? 'ff', 16) <= byte) at++
    view.setUint32(V2_HEADER + byte * 4, at, false)
  }
  out.set(checksum, out.byteLength - 2 * SHA_BYTES)
  out.set(
    fromHex(await sha1Hex(out.subarray(0, out.byteLength - SHA_BYTES))),
    out.byteLength - SHA_BYTES,
  )
  return out
}

/**
 * Each delta's id, read back from the stored pack: a base's content is read
 * once and every delta on it rebuilt from it, depth first, so only the chain
 * being rebuilt is held. The pack is read a block at a time, the last few
 * blocks kept, since the objects of a pack sit side by side.
 */
async function deltaIds(
  vfs: Files,
  path: PathSpec,
  scanned: readonly Scanned[],
): Promise<Map<number, string>> {
  const ids = new Map<number, string>()
  const onOffset = new Map<number, Scanned[]>()
  const onId = new Map<string, Scanned[]>()
  for (const entry of scanned) {
    if (entry.kind < OFS_DELTA) ids.set(entry.offset, entry.base)
    else if (entry.kind === OFS_DELTA) {
      const key = Number(entry.base)
      const list = onOffset.get(key)
      if (list === undefined) onOffset.set(key, [entry])
      else list.push(entry)
    } else {
      const list = onId.get(entry.base)
      if (list === undefined) onId.set(entry.base, [entry])
      else list.push(entry)
    }
  }
  const blocks = openBlocks(vfs, path)
  const content = async (entry: Scanned): Promise<Uint8Array> =>
    inflate(await readBlocks(blocks, entry.data, entry.end - entry.data))
  const children = (offset: number, oid: string): Scanned[] => {
    const waiting = [...(onOffset.get(offset) ?? []), ...(onId.get(oid) ?? [])]
    onOffset.delete(offset)
    onId.delete(oid)
    return waiting
  }
  for (const entry of scanned) {
    if (entry.kind >= OFS_DELTA || (!onOffset.has(entry.offset) && !onId.has(entry.base))) continue
    const kind = KINDS[entry.kind - 1] ?? 'blob'
    const stack: [Uint8Array, Scanned[]][] = [
      [await content(entry), children(entry.offset, entry.base)],
    ]
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      const [base, waiting] = top
      const child = waiting.shift()
      if (child === undefined) {
        stack.pop()
        continue
      }
      const rebuilt = applyDelta(await content(child), base)
      if (!waiting.length) stack.pop()
      const oid = await sha1Hex(wrapped(kind, rebuilt))
      ids.set(child.offset, oid)
      stack.push([rebuilt, children(child.offset, oid)])
    }
  }
  const left = [...onOffset.values(), ...onId.values()].reduce((sum, list) => sum + list.length, 0)
  if (left) throw new GitError(`pack has ${String(left)} unresolved delta${left === 1 ? '' : 's'}`)
  return ids
}

/** Six hex digits that name a temporary pack, as git's mkstemp does. */
function token(ids: IdSource): string {
  return toHex(ids.secureBytes(3))
}

/**
 * Keep a fetched pack whole, beside the index git reads it through, as it
 * arrives: the bytes go straight to a temporary file while a scan lists
 * each entry, then each delta's id is worked out from the stored bytes and
 * the index is written. Nothing holds the pack itself, so a clone costs one
 * object's bytes at a time, not the repository's.
 *
 * Named by the pack's own checksum, as git names one it receives. The index
 * is written aside and renamed in after the pack, as git does, so a reader
 * that lists `.idx` files never finds one cut short or one whose pack is not
 * there yet. An empty pack stores nothing.
 *
 * @param vfs the session's files
 * @param commondir the shared git directory, which owns the object database
 * @param chunks the packfile, as it arrives
 * @param ids where the temporary file's name is drawn from
 */
export async function storePack(
  vfs: Files,
  commondir: PathSpec,
  chunks: AsyncIterable<Uint8Array>,
  ids: IdSource,
): Promise<void> {
  const source = chunks[Symbol.asyncIterator]()
  let first = await source.next()
  while (first.done !== true && first.value.byteLength === 0) first = await source.next()
  if (first.done === true) return
  const dir = commondir.join(PACK_DIR)
  await ensureDir(vfs, dir)
  const temporary = dir.join(`tmp_pack_${token(ids)}`)
  const staged = dir.join(`tmp_idx_${token(ids)}`)
  const scan = openStreamSync('git_pack', {})
  const scanned: Scanned[] = []
  let checksum = ''
  let partial = ''
  const take = (out: Uint8Array): void => {
    const lines = (partial + DEC.decode(out)).split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      const fields = line.split(' ')
      if (fields.length === 1) {
        checksum = line
        continue
      }
      const [offset, data, end, crc, kind, base] = fields
      scanned.push({
        offset: Number(offset),
        data: Number(data),
        end: Number(end),
        crc: Number(crc),
        kind: Number(kind),
        base: base ?? '',
      })
    }
  }
  const head = first.value
  async function* fed(): AsyncGenerator<Uint8Array> {
    take(scan.feed(head))
    yield head
    for (let next = await source.next(); next.done !== true; next = await source.next()) {
      take(scan.feed(next.value))
      yield next.value
    }
    take(scan.finish())
  }
  try {
    try {
      await vfs.write(temporary, fed())
    } catch (err) {
      if (err instanceof StreamRefusal) throw new GitError(err.message)
      throw err
    } finally {
      scan.close()
      await source.return?.()
    }
    const named = await deltaIds(vfs, temporary, scanned)
    const entries = scanned
      .map((entry) => ({
        oid: named.get(entry.offset) ?? '',
        offset: entry.offset,
        crc: entry.crc,
      }))
      .sort((a, b) => compareCodePoints(a.oid, b.oid))
    const stem = `pack-${checksum}`
    if (await exists(vfs, dir.join(`${stem}${IDX_SUFFIX}`))) {
      await removeFile(vfs, temporary)
      return
    }
    await vfs.write(staged, await packIndex(entries, fromHex(checksum)))
    await vfs.rename(temporary, dir.join(`${stem}.pack`))
    await vfs.rename(staged, dir.join(`${stem}${IDX_SUFFIX}`))
  } catch (err) {
    await removeFile(vfs, temporary)
    await removeFile(vfs, staged)
    throw err
  }
}
