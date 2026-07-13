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

import { PathSpec } from '@struktoai/mirage-core'
import { OPFSAccessor } from './accessor/opfs.ts'

export function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

interface DirNode {
  kind: 'directory'
  name: string
  children: Map<string, DirNode | FileNode>
}

interface FileNode {
  kind: 'file'
  name: string
  data: Uint8Array
  modified: Date
}

class MockWritable {
  constructor(private readonly file: FileNode) {}
  async write(data: Blob | BufferSource | string): Promise<void> {
    if (typeof data === 'string') {
      this.file.data = new TextEncoder().encode(data)
    } else if (data instanceof Blob) {
      const buf = new Uint8Array(await data.arrayBuffer())
      this.file.data = buf
    } else if (data instanceof ArrayBuffer) {
      this.file.data = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView
      this.file.data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
    } else {
      throw new TypeError('MockWritable.write: unsupported data type')
    }
    this.file.modified = new Date()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

class MockFileHandle {
  readonly kind = 'file'
  constructor(private readonly node: FileNode) {}
  get name(): string {
    return this.node.name
  }
  getFile(): Promise<File> {
    const blob = new Blob([this.node.data.slice()])
    const file = new File([blob], this.node.name, { lastModified: this.node.modified.getTime() })
    return Promise.resolve(file)
  }
  createWritable(): Promise<MockWritable> {
    return Promise.resolve(new MockWritable(this.node))
  }
}

function notFound(name: string): DOMException {
  return new DOMException(
    `A requested file or directory could not be found: ${name}`,
    'NotFoundError',
  )
}

class MockDirectoryHandle {
  readonly kind = 'directory'
  constructor(private readonly node: DirNode) {}
  get name(): string {
    return this.node.name
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<MockDirectoryHandle> {
    const existing = this.node.children.get(name)
    if (existing !== undefined) {
      if (existing.kind !== 'directory') {
        throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
      }
      return new MockDirectoryHandle(existing)
    }
    if (options.create !== true) throw notFound(name)
    const dir: DirNode = { kind: 'directory', name, children: new Map() }
    this.node.children.set(name, dir)
    return new MockDirectoryHandle(dir)
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MockFileHandle> {
    const existing = this.node.children.get(name)
    if (existing !== undefined) {
      if (existing.kind !== 'file') {
        throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
      }
      return new MockFileHandle(existing)
    }
    if (options.create !== true) throw notFound(name)
    const file: FileNode = { kind: 'file', name, data: new Uint8Array(), modified: new Date() }
    this.node.children.set(name, file)
    return new MockFileHandle(file)
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    const existing = this.node.children.get(name)
    if (existing === undefined) throw notFound(name)
    if (existing.kind === 'directory' && existing.children.size > 0 && options.recursive !== true) {
      throw new DOMException('Directory not empty', 'InvalidModificationError')
    }
    this.node.children.delete(name)
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *entries(): AsyncIterableIterator<[string, MockFileHandle | MockDirectoryHandle]> {
    for (const [name, child] of this.node.children) {
      if (child.kind === 'file') yield [name, new MockFileHandle(child)]
      else yield [name, new MockDirectoryHandle(child)]
    }
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<
    [string, MockFileHandle | MockDirectoryHandle]
  > {
    yield* this.entries()
  }
}

export function makeMockRoot(name = 'root'): FileSystemDirectoryHandle {
  const node: DirNode = { kind: 'directory', name, children: new Map() }
  return new MockDirectoryHandle(node) as unknown as FileSystemDirectoryHandle
}

function fakeOPFSResource(handle: FileSystemDirectoryHandle): {
  requireHandle: () => FileSystemDirectoryHandle
} {
  return { requireHandle: () => handle }
}

export function makeMockAccessor(name = 'root'): OPFSAccessor {
  return new OPFSAccessor(fakeOPFSResource(makeMockRoot(name)))
}

export function installFakeNavigator(getRoot: () => FileSystemDirectoryHandle): () => void {
  const fake = { storage: { getDirectory: () => Promise.resolve(getRoot()) } }
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: fake,
    configurable: true,
    writable: true,
  })
  return () => {
    if (desc !== undefined) Object.defineProperty(globalThis, 'navigator', desc)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}
