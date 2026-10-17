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

import { createTarDecoder, createTarPacker, packTar, unpackTar, type TarHeader } from 'modern-tar'
import type { ByteSpool } from '../../io/spool.ts'
import { ByteSlice } from '../../io/spool.ts'
import { chunks } from '../../io/cooperative.ts'
import type { ByteSource } from '../../io/types.ts'
import { decodeText } from '../../shell/bytes.ts'

const DIR_MODE = 0o755
const LINK_MODE = 0o777
const FILE_MODE = 0o644
const BLOCK = 512
const REPLACEMENT = '\ufffd'
const META_FLAGS = new Set(['x', 'g', 'L', 'K'])
const USTAR_MAGIC = 'ustar\0'

export interface TarEntry {
  name: string
  data: Uint8Array
  body?: ByteSlice
  isFile: boolean
  // Directories carry no content and a trailing slash; a symlink carries
  // its target in the header's linkname field instead of any content.
  isDir?: boolean
  linkname?: string
  header?: TarHeader
}

function headerOf(entry: TarEntry): TarHeader {
  if (entry.isDir === true) {
    // A directory member is spelled with a trailing slash; that slash is
    // what tells every extractor it holds no content.
    const name = entry.name.endsWith('/') ? entry.name : `${entry.name}/`
    return { name, size: 0, type: 'directory', mode: DIR_MODE }
  }
  const linkname = entry.linkname ?? ''
  if (linkname !== '') {
    return { name: entry.name, size: 0, type: 'symlink', mode: LINK_MODE, linkname }
  }
  return { name: entry.name, size: entry.data.byteLength, type: 'file', mode: FILE_MODE }
}

export async function writeTar(entries: readonly TarEntry[]): Promise<Uint8Array> {
  // A directory and a symlink record their identity in the header and
  // occupy no data blocks, whatever the caller put in `data`.
  return packTar(
    entries.map((entry) => {
      const header = { mtime: new Date(0), ...headerOf(entry), ...entry.header }
      return header.type === 'file' ? { header, body: entry.data } : { header }
    }),
  )
}

function validateHeader(data: Uint8Array): void {
  if (data.byteLength < 512) throw new Error('Invalid tar header')
  // Like Python's tarfile.open, identify an archive by its first header.
  // modern-tar's strict mode also requires two EOF blocks and rejects
  // trailing data, both of which GNU tar permits. Keep its tolerant reader
  // after checking the header checksum (including old signed checksums).
  const block = data.subarray(0, 512)
  if (block.some((byte) => byte !== 0)) {
    const field = new TextDecoder().decode(block.subarray(148, 156)).split('\0')[0]?.trim() ?? ''
    let unsigned = 0
    let signed = 0
    for (const [index, byte] of block.entries()) {
      const value = index >= 148 && index < 156 ? 32 : byte
      unsigned += value
      signed += value < 128 ? value : value - 256
    }
    const checksum = /^[0-7]+$/.test(field) ? Number.parseInt(field, 8) : -1
    if (checksum !== unsigned && checksum !== signed) throw new Error('Invalid tar header')
  }
}

export async function readTar(data: Uint8Array): Promise<TarEntry[]> {
  validateHeader(data)
  const parsed = await unpackTar(data)
  return parsed.map((entry) => {
    // A trailing slash marks a directory even on an archive written
    // before ustar typeflags (GNU tar has always spelled it that way).
    const isDir = entry.header.type === 'directory' || entry.header.name.endsWith('/')
    return {
      header: entry.header,
      name: entry.header.name,
      data: entry.data ?? new Uint8Array(0),
      isFile: entry.header.type === 'file' && !isDir,
      isDir,
      linkname: entry.header.linkname ?? '',
    }
  })
}

interface StoredNames {
  name?: Uint8Array
  linkname?: Uint8Array
}

function fieldBytes(block: Uint8Array, offset: number, size: number): Uint8Array {
  const field = block.subarray(offset, offset + size)
  const end = field.indexOf(0)
  return end === -1 ? field : field.subarray(0, end)
}

// A header's size field: octal digits, or GNU's base-256 form when the
// high bit of its first byte is set, read the way modern-tar reads it.
function headerSize(block: Uint8Array): number {
  const field = block.subarray(124, 136)
  const lead = field[0] ?? 0
  if ((lead & 0x80) !== 0)
    return field.subarray(1).reduce((value, byte) => value * 256 + byte, lead & 0x7f)
  let value = 0
  for (const byte of field) {
    if (byte === 0) break
    if (byte !== 0x20) value = value * 8 + (byte - 0x30)
  }
  return value
}

function paxNames(data: Uint8Array): StoredNames {
  const names: StoredNames = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(decodeText(data.subarray(offset, space)), 10)
    if (!(length > 0)) break
    const record = data.subarray(space + 1, offset + length - 1)
    const equals = record.indexOf(0x3d)
    const key = equals > 0 ? decodeText(record.subarray(0, equals)) : ''
    if (key === 'path') names.name = record.subarray(equals + 1)
    if (key === 'linkpath') names.linkname = record.subarray(equals + 1)
    offset += length
  }
  return names
}

/**
 * The name and link target each entry was stored with, as bytes.
 *
 * Walks the headers again in the order modern-tar consumed them: zero
 * blocks are skipped, a pax record or a GNU long name or link applies to
 * the next entry (a global pax record to every later one), a ustar prefix
 * joins its name with a slash, and each entry's body is skipped by the
 * length modern-tar streamed for it.
 */
async function storedNames(
  source: ByteSpool,
  entries: readonly TarEntry[],
): Promise<StoredNames[]> {
  const globals: StoredNames = {}
  const stored: StoredNames[] = []
  let at = 0
  for (const entry of entries) {
    const pending: StoredNames = {}
    let block = await source.read(at, BLOCK)
    for (; block.length === BLOCK; block = await source.read(at, BLOCK)) {
      at += BLOCK
      if (block.every((byte) => byte === 0)) continue
      const flag = String.fromCharCode(block[156] ?? 0)
      if (!META_FLAGS.has(flag)) break
      const size = headerSize(block)
      const data = await source.read(at, size)
      at += size + (-size & (BLOCK - 1))
      const found =
        flag === 'L'
          ? { name: fieldBytes(data, 0, data.length) }
          : flag === 'K'
            ? { linkname: fieldBytes(data, 0, data.length) }
            : paxNames(data)
      Object.assign(flag === 'g' ? globals : pending, found)
    }
    if (block.length < BLOCK) break
    const base = fieldBytes(block, 0, 100)
    const ustar = decodeText(block.subarray(257, 263)) === USTAR_MAGIC
    const prefix = ustar ? fieldBytes(block, 345, 155) : new Uint8Array()
    const name = prefix.length > 0 ? Uint8Array.from([...prefix, 0x2f, ...base]) : base
    stored.push({ name, linkname: fieldBytes(block, 157, 100), ...globals, ...pending })
    const body = entry.body?.size ?? 0
    at += body + (-body & (BLOCK - 1))
  }
  return stored
}

function lossyName(entry: TarEntry): boolean {
  return entry.name.includes(REPLACEMENT) || (entry.linkname ?? '').includes(REPLACEMENT)
}

/**
 * Put back the bytes modern-tar decoded away in member names.
 *
 * modern-tar reads every header string through a plain TextDecoder, so a
 * name byte that is not UTF-8 arrives as U+FFFD. CPython's tarfile keeps it
 * as its surrogate escape instead, and GNU tar lists it as an octal escape
 * (`a\377b`), which needs the byte back. Only an archive whose decoded
 * names hold U+FFFD pays for a second walk over its headers.
 */
async function restoreNames(source: ByteSpool, entries: TarEntry[]): Promise<TarEntry[]> {
  if (!entries.some(lossyName)) return entries
  const stored = await storedNames(source, entries)
  return entries.map((entry, index) => {
    const names = stored[index]
    if (names === undefined || !lossyName(entry)) return entry
    return {
      ...entry,
      name: names.name !== undefined ? decodeText(names.name) : entry.name,
      linkname: names.linkname !== undefined ? decodeText(names.linkname) : (entry.linkname ?? ''),
    }
  })
}

export interface StreamingTarEntry {
  header: TarHeader
  body: ByteSource
}

export async function* writeTarStream(
  entries: AsyncIterable<StreamingTarEntry>,
): AsyncGenerator<Uint8Array> {
  const { readable, controller } = createTarPacker()
  const reader = readable.getReader()
  const producer = (async () => {
    try {
      for await (const entry of entries) {
        const writer = controller.add(entry.header).getWriter()
        try {
          for await (const data of chunks(entry.body)) await writer.write(data)
          await writer.close()
        } finally {
          writer.releaseLock()
        }
      }
      controller.finalize()
    } catch (error) {
      controller.error(error)
      throw error
    }
  })()
  // Mark failures observed while the reader is awaiting its next block.
  void producer.catch(() => undefined)
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      yield next.value
    }
    await producer
  } finally {
    await reader.cancel()
    reader.releaseLock()
    // A consumer that stops early cancels the packer, which fails the
    // producer with that cancel; a real failure already surfaced above.
    await producer.catch(() => undefined)
  }
}

export async function readTarSpool(source: ByteSpool, contents: ByteSpool): Promise<TarEntry[]> {
  validateHeader(await source.read(0, 512))
  const iterator = source.stream(0, source.size - (source.size % 512))
  const input = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await iterator.return(undefined)
    },
  })
  const reader = input.pipeThrough(createTarDecoder()).getReader()
  const entries: TarEntry[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const entry = next.value
      const body = entry.body.getReader()
      const offset = contents.size
      try {
        for (;;) {
          const part = await body.read()
          if (part.done) break
          await contents.append(part.value)
        }
      } finally {
        await body.cancel()
        body.releaseLock()
      }
      const isDir = entry.header.type === 'directory' || entry.header.name.endsWith('/')
      entries.push({
        header: entry.header,
        name: entry.header.name,
        data: new Uint8Array(),
        body: new ByteSlice(contents, offset, contents.size - offset),
        isDir,
        isFile: entry.header.type === 'file' && !isDir,
        linkname: entry.header.linkname ?? '',
      })
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  return restoreNames(source, entries)
}
