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

const DIR_MODE = 0o755
const LINK_MODE = 0o777
const FILE_MODE = 0o644

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
    await producer
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
  return entries
}
