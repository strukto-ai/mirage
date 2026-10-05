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

interface FileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>
  write(
    data: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesWritten: number }>
  stat(): Promise<{ isFile(): boolean }>
  close(): Promise<void>
}

interface NodeFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  open(path: string, flags: string | number): Promise<FileHandle>
  stat(path: string): Promise<{ size: number }>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  realpath(path: string): Promise<string>
  mkdtemp(prefix: string): Promise<string>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
  constants: { O_RDONLY: number; O_NOFOLLOW?: number }
}

interface NodePath {
  resolve(...paths: string[]): string
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
  dirname(path: string): string
  basename(path: string): string
  join(...paths: string[]): string
  sep: string
}

// How much of a file one read or write moves while a tar streams.
const CHUNK = 1024 * 1024

async function tryLoadFs(): Promise<NodeFs | null> {
  const g = globalThis as unknown as { process?: { versions?: { node?: string } } }
  if (g.process?.versions?.node === undefined) return null
  try {
    const modName = 'node:fs/promises'
    const mod = (await import(/* @vite-ignore */ modName)) as NodeFs
    return mod
  } catch {
    return null
  }
}

const nodeFs: NodeFs | null = await tryLoadFs()

export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (nodeFs === null) throw new Error('readFileBytes: not available (node:fs unavailable)')
  return nodeFs.readFile(path)
}

export async function writeFileBytes(path: string, data: Uint8Array): Promise<void> {
  if (nodeFs === null) throw new Error('writeFileBytes: not available (node:fs unavailable)')
  await nodeFs.writeFile(path, data)
}

function requireFs(caller: string): NodeFs {
  if (nodeFs === null) throw new Error(`${caller}: not available (node:fs unavailable)`)
  return nodeFs
}

export async function fileSize(path: string): Promise<number> {
  return (await requireFs('fileSize').stat(path)).size
}

/**
 * Write exactly `size` bytes of the file at `path` to `sink`, one chunk at
 * a time, so a large file never sits in memory whole.
 */
export async function copyFileInto(
  path: string,
  sink: WritableStreamDefaultWriter<Uint8Array>,
  size: number,
): Promise<void> {
  // A captured file read later is refused when a link or anything but a
  // regular file has replaced it since its state named it.
  const fs = requireFs('copyFileInto')
  const handle = await fs.open(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`not a regular file: ${path}`)
    let left = size
    while (left > 0) {
      const chunk = new Uint8Array(Math.min(CHUNK, left))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) throw new Error(`${path}: file ended ${String(left)} bytes early`)
      await sink.write(chunk.subarray(0, bytesRead))
      left -= bytesRead
    }
  } finally {
    await handle.close()
  }
}

/** Write `source` to a file at `path`, chunk by chunk; returns the bytes written. */
export async function writeStreamToFile(
  path: string,
  source: ReadableStream<Uint8Array>,
): Promise<number> {
  const fs = requireFs('writeStreamToFile')
  const slash = path.lastIndexOf('/')
  if (slash > 0) await fs.mkdir(path.slice(0, slash), { recursive: true })
  const handle = await fs.open(path, 'w')
  const reader = source.getReader()
  let written = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let offset = 0
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset, null)
        if (bytesWritten === 0) throw new Error(`${path}: write made no progress`)
        offset += bytesWritten
      }
      written += value.byteLength
    }
  } finally {
    reader.releaseLock()
    await handle.close()
  }
  return written
}

/** The file at `path` as a stream of chunks. */
export function fileReadable(path: string): ReadableStream<Uint8Array> {
  const fs = requireFs('fileReadable')
  let handle: FileHandle | null = null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      handle ??= await fs.open(path, 'r')
      const chunk = new Uint8Array(CHUNK)
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, null)
      if (bytesRead === 0) {
        await handle.close()
        controller.close()
        return
      }
      controller.enqueue(chunk.subarray(0, bytesRead))
    },
    async cancel() {
      await handle?.close()
    },
  })
}

/** A fresh directory under the system temp dir, for staging a restore. */
/**
 * Where blob `name` is staged under `staging`, its directory made; a name
 * landing outside it, as written or through a link, is refused.
 */
export async function stagedPath(staging: string, name: string): Promise<string> {
  const fs = requireFs('stagedPath')
  const modName = 'node:path'
  const path = (await import(/* @vite-ignore */ modName)) as NodePath
  const root = await fs.realpath(staging)
  const inside = (target: string): boolean => {
    const rel = path.relative(root, target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }
  const target = path.resolve(root, name)
  if (!inside(target)) throw new Error(`Unsafe blob path: ${name}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const real = path.join(await fs.realpath(path.dirname(target)), path.basename(target))
  if (!inside(real)) throw new Error(`Unsafe blob path: ${name}`)
  return real
}

export async function makeStagingDir(): Promise<string> {
  const modName = 'node:os'
  const os = (await import(/* @vite-ignore */ modName)) as { tmpdir(): string }
  return requireFs('makeStagingDir').mkdtemp(`${os.tmpdir()}/mirage-restore-`)
}

export async function removeDir(path: string): Promise<void> {
  await requireFs('removeDir').rm(path, { recursive: true, force: true })
}
