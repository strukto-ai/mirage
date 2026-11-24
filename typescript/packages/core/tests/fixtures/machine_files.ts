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

import { MachineAccessor } from '../../src/accessor/machine.ts'
import { ENTRY_FORMAT } from '../../src/core/posix/constants.ts'
import { PathSpec } from '../../src/types.ts'
import type { RunAnswer } from '../../src/runtime/types.ts'
import type { MachineHandle } from '../../src/machine/handle.ts'
import type { MachineVFSConfig } from '../../src/vfs/machine/config.ts'
import { MachineVFS } from '../../src/vfs/machine/machine.ts'
import { MountMode } from '../../src/types.ts'
import type { MountSpec, WorkspaceOptions } from '../../src/workspace/workspace/types.ts'
import { Workspace } from '../../src/workspace/workspace/workspace.ts'
import { ScriptedMachine, failed, ok, tableOf, type Answer } from './machine.ts'

const ENC = new TextEncoder()

export const ROW = ENC.encode('f 644 3 1700000000 1700000001 0 50 1 0 \0')
export const DIR = ENC.encode('d 755 4096 1700000000 1700000001 0 0 2 8 \0')

/**
 * An accessor over `handles`, bound as a workspace binds it, the first the
 * default machine. Mirrors Python's `tests/fixtures/machine_files.bound`.
 */
export function bound(
  handles: MachineHandle[],
  config: MachineVFSConfig = { root: '/tmp' },
): MachineAccessor {
  const accessor = new MachineAccessor({ root: '/tmp', ...config })
  accessor.bindMachines(tableOf(...handles), handles[0]?.name ?? '')
  return accessor
}

/** A path on a mount at `prefix`; `path` is slash-led. */
export function spec(path: string, prefix = '/tmp'): PathSpec {
  return new PathSpec({
    virtual: prefix + path,
    directory: prefix + path.slice(0, path.lastIndexOf('/')),
    vfsPath: path.replace(/^\/+/, ''),
    rawPath: prefix + path,
  })
}

/** An answer holding `paths` as files and every other stat missing. */
export function holding(...paths: string[]): Answer {
  return holdingSince(1700000000, ...paths)
}

/**
 * `holding`, the files written at `written`, in epoch seconds. Mirrors
 * Python's `holding(written=)`.
 */
export function holdingSince(written: number, ...paths: string[]): Answer {
  const entry = ENC.encode(`f 644 3 ${String(written)} 1700000001 0 50 1 0 \0`)
  return (line) => {
    if (line.includes('-maxdepth 0')) {
      if (paths.some((p) => line.includes(`'${p}'`))) return ok(entry)
      return failed("find: 'x': No such file or directory\n")
    }
    return ok('hi\n')
  }
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

/** The words of a line Mirage sends, as `sh` splits its single quotes. */
function words(part: string): string[] {
  const out: string[] = []
  for (const m of part.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g))
    out.push(m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : (m[2] ?? ''))
  return out
}

/**
 * One machine's own files, answering the lines a machine mount sends as its
 * POSIX tools would. Every write stamps its file from one clock all the
 * machines share, so the copy written last is the same whichever machine is
 * asked. Mirrors Python's `tests/fixtures/machine_files.FakeFiles`.
 */
export class FakeFiles {
  private static clock = 0
  readonly files: Map<string, Uint8Array>
  readonly written = new Map<string, number>()
  readonly dirs = new Set(['/', '/tmp', '/dev', '/dev/shm'])
  readonly programs: Set<string>
  readonly ran: string[] = []
  readonly links = new Map<string, string>()

  constructor(files: Record<string, string> = {}, programs: readonly string[] = []) {
    this.files = new Map(Object.entries(files).map(([path, text]) => [path, ENC.encode(text)]))
    for (let path of this.files.keys()) {
      while (!this.dirs.has((path = dirname(path)))) this.dirs.add(path)
    }
    this.programs = new Set(programs)
  }

  private real(path: string): string {
    for (const [link, target] of this.links)
      if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length)
    return path
  }

  readonly answer: Answer = (line, data) => {
    let result = ok()
    for (const part of line.split(' && ')) {
      result = this.one(words(part), data)
      if (result.exitCode !== 0) break
    }
    return result
  }

  private stamp(path: string): void {
    FakeFiles.clock += 1
    this.written.set(path, FakeFiles.clock)
  }

  private row(path: string, rel: string): string {
    const at = String(this.written.get(path) ?? 0)
    if (this.dirs.has(path)) return `d 755 4096 ${at} 0 0 0 2 8 ${rel}\0`
    return `f 644 ${String(this.files.get(path)?.byteLength ?? 0)} ${at} 0 0 0 1 0 ${rel}\0`
  }

  private moveFolder(src: string, dst: string): RunAnswer {
    if (!this.dirs.has(dirname(dst))) return this.missing('mv', dst)
    for (const name of [...this.dirs].sort()) {
      if (name === src || name.startsWith(`${src}/`)) {
        this.dirs.delete(name)
        this.dirs.add(dst + name.slice(src.length))
      }
    }
    for (const [name, data] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (name.startsWith(`${src}/`)) {
        this.files.delete(name)
        this.files.set(dst + name.slice(src.length), data)
      }
    }
    for (const [name, at] of [...this.written]) {
      if (name === src || name.startsWith(`${src}/`)) {
        this.written.delete(name)
        this.written.set(dst + name.slice(src.length), at)
      }
    }
    return ok()
  }

  private missing(tool: string, path: string): RunAnswer {
    return failed(`${tool}: '${path}': No such file or directory\n`)
  }

  private one(words: string[], data: Uint8Array | null): RunAnswer {
    const w = words[0]?.startsWith('PATH=') === true ? words.slice(1) : words
    const [head = '', second = ''] = w
    if (head === 'cd' && second === '--') return this.dirs.has(w[2] ?? '') ? ok() : failed('')
    if (head === 'command' && second === '-v')
      return this.programs.has(w[2] ?? '') ? ok() : failed('')
    if (w.slice(0, 3).join(' ') === 'readlink -f --') {
      const real = this.real(w[3] ?? '')
      return this.dirs.has(dirname(real)) ? ok(`${real}\n`) : failed('')
    }
    if (w.slice(0, 4).join(' ') === 'env LC_ALL=C find -L') {
      if (w.at(-2) !== '-printf' || w.at(-1) !== ENTRY_FORMAT)
        throw new Error(`unexpected find format: ${w.join(' ')}`)
      const path = this.real(w[4] ?? '')
      const depth = w[5] === '-maxdepth' ? Number(w[6]) : null
      if ([...this.files.keys()].some((f) => path.startsWith(`${f}/`)))
        return failed(`find: '${path}': Not a directory\n`)
      if (!this.dirs.has(path) && !this.files.has(path)) return this.missing('find', path)
      let out = this.row(path, '')
      const under = `${path.replace(/\/+$/, '')}/`
      for (const child of [...new Set([...this.dirs, ...this.files.keys()])].sort()) {
        const rel = child.startsWith(under) ? child.slice(under.length) : ''
        if (rel !== '' && child !== path && (depth === null || !rel.includes('/')) && depth !== 0)
          out += this.row(child, rel)
      }
      return ok(out)
    }
    if (head === 'cat' && second === '--') {
      const found = this.files.get(this.real(w[2] ?? ''))
      return found === undefined ? this.missing('cat', w[2] ?? '') : ok(found)
    }
    if ((head === 'cat' || head === ':') && (second === '>' || second === '>>')) {
      const path = w[2] ?? ''
      if (!this.dirs.has(dirname(path))) return this.missing('sh', path)
      const old = second === '>>' ? (this.files.get(path) ?? new Uint8Array()) : new Uint8Array()
      const add = data ?? new Uint8Array()
      const joined = new Uint8Array(old.byteLength + add.byteLength)
      joined.set(old)
      joined.set(add, old.byteLength)
      this.files.set(path, joined)
      this.stamp(path)
      return ok()
    }
    if (head === 'mkdir') {
      let path = w.at(-1) ?? ''
      if (!this.dirs.has(dirname(path)) && !w.includes('-p')) return this.missing('mkdir', path)
      while (!this.dirs.has(path)) {
        this.dirs.add(path)
        path = dirname(path)
      }
      return ok()
    }
    if (head === 'rm') {
      const path = w.at(-1) ?? ''
      if (this.dirs.has(path) && w.includes('-r')) {
        for (const name of [...this.files.keys()])
          if (name === path || name.startsWith(`${path}/`)) this.files.delete(name)
        for (const name of [...this.dirs])
          if (name === path || name.startsWith(`${path}/`)) this.dirs.delete(name)
        return ok()
      }
      if (!this.files.has(path)) return this.missing('rm', path)
      this.files.delete(path)
      return ok()
    }
    if (head === 'rmdir') {
      const path = w.at(-1) ?? ''
      if (!this.dirs.has(path)) return this.missing('rmdir', path)
      if ([...this.files.keys(), ...this.dirs].some((n) => n.startsWith(`${path}/`)))
        return failed(`rmdir: failed to remove '${path}': Directory not empty\n`)
      this.dirs.delete(path)
      return ok()
    }
    if (head === 'mv' || head === 'cp') {
      const src = w.at(-2) ?? ''
      const dst = w.at(-1) ?? ''
      if (head === 'mv' && this.dirs.has(src)) return this.moveFolder(src, dst)
      const found = this.files.get(src)
      if (found === undefined) return this.missing(head, src)
      if (!this.dirs.has(dirname(dst))) return this.missing(head, dst)
      this.files.set(dst, found)
      this.written.set(dst, this.written.get(src) ?? 0)
      if (head === 'mv') this.files.delete(src)
      else this.stamp(dst)
      return ok()
    }
    this.ran.push(w.join(' '))
    return ok('ran\n')
  }
}

const DEC = new TextDecoder()

export const TOOLS = ['ls', 'cat', 'grep', 'wc']

/**
 * A workspace running its programs on one machine, `box`, that holds
 * `files`; writable unless `options.mode` says otherwise. Mirrors Python's
 * `tests/fixtures/machine_files.one`.
 */
export function one(
  files: FakeFiles,
  mounts: Record<string, MountSpec> = {},
  options: WorkspaceOptions = {},
): Workspace {
  return new Workspace(mounts, {
    mode: MountMode.WRITE,
    machines: { box: new ScriptedMachine('box', files.answer) },
    ...options,
  })
}

/** What a line writes to stdout. Mirrors Python's `out`. */
export async function out(ws: Workspace, line: string): Promise<string> {
  return DEC.decode((await ws.shell(line)).stdout)
}

/**
 * A writable workspace running its programs on two machines, `a` then `b`.
 * Mirrors Python's `tests/fixtures/machine_files.two`.
 */
export function two(
  a: FakeFiles,
  b: FakeFiles,
  mounts: Record<string, MountSpec | string> = {},
  options: WorkspaceOptions = {},
): Workspace {
  return new Workspace(mounts, {
    mode: MountMode.WRITE,
    machines: { a: new ScriptedMachine('a', a.answer), b: new ScriptedMachine('b', b.answer) },
    ...options,
  })
}

/** A line's exit code, stdout and stderr. Mirrors Python's `run`. */
export async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const result = await ws.shell(line)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

/** A machine's files as text, by path. */
export function texts(files: FakeFiles): Record<string, string> {
  return Object.fromEntries([...files.files].map(([k, v]) => [k, DEC.decode(v)]))
}

/** A mount of /tmp over machines a, b, c, ... holding `files`. Mirrors Python's `shared`. */
export function shared(...files: FakeFiles[]): MachineVFS {
  const vfs = new MachineVFS({ root: '/tmp' })
  vfs.bindMachines(
    tableOf(...files.map((one, at) => new ScriptedMachine('abcdef'.charAt(at), one.answer))),
    'a',
  )
  return vfs
}
