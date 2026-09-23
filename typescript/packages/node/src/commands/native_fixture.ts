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

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { Workspace } from '../workspace.ts'

const DEC = new TextDecoder()

export type BackendKind = 'ram' | 'disk'

export interface NativeEnv {
  kind: BackendKind
  ws: Workspace
  native(cmd: string, stdin?: Uint8Array | null): Promise<string>
  mirage(cmd: string, stdin?: Uint8Array | null): Promise<string>
  createFile(relativePath: string, content: Uint8Array): void
  cleanup(): Promise<void>
}

function runNative(cwd: string, cmd: string, stdin: Uint8Array | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', cmd], { cwd })
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk)
    })
    child.on('error', reject)
    child.on('close', () => {
      resolve(Buffer.concat(out).toString('utf8'))
    })
    // A program that never reads its stdin (`jq -n`) can exit before the
    // write below lands, and a pipe with no reader left answers EPIPE.
    // That is the program's own behavior, not a failed run; anything else
    // still fails the test.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') reject(err)
    })
    if (stdin !== null) child.stdin.write(Buffer.from(stdin))
    child.stdin.end()
  })
}

function makeRamEnv(): NativeEnv {
  const tmp = mkdtempSync(join(tmpdir(), 'mirage-native-ram-'))
  const vfs = new RAMVFS()
  const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })

  const env: NativeEnv = {
    kind: 'ram',
    ws,
    createFile(relative, content) {
      const local = join(tmp, relative)
      mkdirSync(dirname(local), { recursive: true })
      writeFileSync(local, content)
      const remote = '/' + relative
      const parts = relative.split('/')
      for (let i = 1; i < parts.length; i++) {
        vfs.store.dirs.add('/' + parts.slice(0, i).join('/'))
      }
      vfs.store.files.set(remote, content)
      // Mirror the native side: files on the tmp filesystem carry an
      // mtime, and -mtime windows exclude unknown-mtime entries.
      vfs.store.modified.set(remote, new Date().toISOString())
    },
    native(cmd, stdin = null) {
      return runNative(tmp, cmd, stdin)
    },
    async mirage(cmd, stdin = null) {
      ws.cwd = '/data'
      const io = await ws.shell(cmd, stdin === null ? {} : { stdin })
      return DEC.decode(io.stdout)
    },
    async cleanup() {
      await ws.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  return env
}

function makeDiskEnv(): NativeEnv {
  const tmp = mkdtempSync(join(tmpdir(), 'mirage-native-disk-'))
  const diskRoot = join(tmp, 'disk')
  mkdirSync(diskRoot, { recursive: true })
  const vfs = new DiskVFS({ root: diskRoot })
  const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })

  const env: NativeEnv = {
    kind: 'disk',
    ws,
    createFile(relative, content) {
      const local = join(diskRoot, relative)
      mkdirSync(dirname(local), { recursive: true })
      writeFileSync(local, content)
    },
    native(cmd, stdin = null) {
      return runNative(diskRoot, cmd, stdin)
    },
    async mirage(cmd, stdin = null) {
      ws.cwd = '/data'
      const io = await ws.shell(cmd, stdin === null ? {} : { stdin })
      return DEC.decode(io.stdout)
    },
    async cleanup() {
      await ws.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  return env
}

export const NATIVE_BACKENDS: readonly BackendKind[] = ['ram', 'disk'] as const

export function makeEnv(kind: BackendKind): NativeEnv {
  if (kind === 'ram') return makeRamEnv()
  return makeDiskEnv()
}

export interface CrossEnv {
  kinds: readonly [BackendKind, BackendKind]
  ws: Workspace
  createFile(mountIdx: 1 | 2, relativePath: string, content: Uint8Array): void
  run(cmd: string): Promise<string>
  exit(cmd: string): Promise<number>
  stderr(cmd: string): Promise<string>
  provision(cmd: string): Promise<unknown>
  cleanup(): Promise<void>
}

interface MountHandle {
  kind: BackendKind
  vfs: VFS
  diskRoot: string | null
  ramVfs: RAMVFS | null
}

function makeMount(kind: BackendKind, tmp: string, idx: number): MountHandle {
  if (kind === 'ram') {
    const vfs = new RAMVFS()
    return { kind, vfs, diskRoot: null, ramVfs: vfs }
  }
  const diskRoot = join(tmp, `disk${String(idx)}`)
  mkdirSync(diskRoot, { recursive: true })
  const vfs = new DiskVFS({ root: diskRoot })
  return { kind, vfs, diskRoot, ramVfs: null }
}

function writeToMount(mount: MountHandle, relative: string, content: Uint8Array): void {
  if (mount.kind === 'ram') {
    const ram = mount.ramVfs
    if (ram === null) throw new Error('ram mount missing VFS')
    const parts = relative.split('/')
    for (let i = 1; i < parts.length; i++) {
      ram.store.dirs.add('/' + parts.slice(0, i).join('/'))
    }
    ram.store.files.set('/' + relative, content)
    ram.store.modified.set('/' + relative, new Date().toISOString())
    return
  }
  if (mount.diskRoot === null) throw new Error('disk mount missing root')
  const local = join(mount.diskRoot, relative)
  mkdirSync(dirname(local), { recursive: true })
  writeFileSync(local, content)
}

export function makeCrossEnv(kinds: readonly [BackendKind, BackendKind]): CrossEnv {
  const tmp = mkdtempSync(join(tmpdir(), 'mirage-native-cross-'))
  const m1 = makeMount(kinds[0], tmp, 1)
  const m2 = makeMount(kinds[1], tmp, 2)
  const ws = new Workspace({ '/m1': m1.vfs, '/m2': m2.vfs }, { mode: MountMode.WRITE })
  ws.cwd = '/m1'

  return {
    kinds,
    ws,
    createFile(mountIdx, relative, content) {
      const mount = mountIdx === 1 ? m1 : m2
      writeToMount(mount, relative, content)
    },
    async run(cmd) {
      const io = await ws.shell(cmd)
      return DEC.decode(io.stdout)
    },
    async exit(cmd) {
      const io = await ws.shell(cmd)
      return io.exitCode
    },
    async stderr(cmd) {
      const io = await ws.shell(cmd)
      return DEC.decode(io.stderr)
    },
    async provision(cmd) {
      return ws.shell(cmd, { provision: true })
    },
    async cleanup() {
      await ws.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

export const CROSS_MOUNT_PAIRS: readonly (readonly [BackendKind, BackendKind])[] = [
  ['ram', 'ram'],
  ['ram', 'disk'],
  ['disk', 'ram'],
] as const
