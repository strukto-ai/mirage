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

import { copyTargets } from '../../commands/builtin/utils/copy.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { ExecutionNode } from '../types.ts'

type Flags = Record<string, string | boolean | string[]>

function flagBool(flags: Flags, key: string): boolean {
  return flags[key] === true
}

async function statOf(dispatch: DispatchFn, spec: PathSpec): Promise<FileStat | null> {
  try {
    const [info] = await dispatch('stat', spec)
    return (info as FileStat | null) ?? null
  } catch {
    return null
  }
}

async function existsPath(dispatch: DispatchFn, spec: PathSpec): Promise<boolean> {
  return (await statOf(dispatch, spec)) !== null
}

async function isDirPath(dispatch: DispatchFn, spec: PathSpec): Promise<boolean> {
  const info = await statOf(dispatch, spec)
  return info !== null && info.type === FileType.DIRECTORY
}

// Recursively collect every directory (top-down) and file under `dir`, each as
// a full-virtual-path PathSpec. readdir returns full virtual paths, so dispatch
// routes each follow-up op to its owning mount.
async function walkTree(
  dispatch: DispatchFn,
  dir: PathSpec,
): Promise<{ dirs: PathSpec[]; files: PathSpec[] }> {
  const dirs: PathSpec[] = []
  const files: PathSpec[] = []
  const [entries] = await dispatch('readdir', dir)
  for (const entry of (entries as string[] | null) ?? []) {
    const spec = PathSpec.fromStrPath(entry, dir.prefix)
    if (await isDirPath(dispatch, spec)) {
      dirs.push(spec)
      const sub = await walkTree(dispatch, spec)
      dirs.push(...sub.dirs)
      files.push(...sub.files)
    } else {
      files.push(spec)
    }
  }
  return { dirs, files }
}

async function ensureDir(dispatch: DispatchFn, spec: PathSpec): Promise<void> {
  const info = await statOf(dispatch, spec)
  if (info === null) {
    await dispatch('mkdir', spec)
    return
  }
  if (info.type !== FileType.DIRECTORY) {
    throw new Error(`cannot create directory '${spec.original}': Not a directory`)
  }
}

// Copy a directory tree from `src` to `target` across mounts: create the target
// root and every subdirectory (so empty dirs survive), then relay each file
// through read+write. Per-file no-clobber matches GNU `cp -rn`.
async function copyTree(
  dispatch: DispatchFn,
  src: PathSpec,
  target: PathSpec,
  noClobber: boolean,
  verbose: boolean,
  writes: Record<string, ByteSource>,
  lines: string[],
): Promise<void> {
  await ensureDir(dispatch, target)
  if (verbose) lines.push(`'${src.original}' -> '${target.original}'`)
  const srcRoot = rstripSlash(src.original)
  const dstRoot = rstripSlash(target.original)
  const { dirs, files } = await walkTree(dispatch, src)
  for (const d of dirs) {
    const destOriginal = dstRoot + rstripSlash(d.original).slice(srcRoot.length)
    await ensureDir(dispatch, PathSpec.fromStrPath(destOriginal, target.prefix))
  }
  for (const f of files) {
    const destOriginal = dstRoot + f.original.slice(srcRoot.length)
    const destSpec = PathSpec.fromStrPath(destOriginal, target.prefix)
    if (noClobber && (await existsPath(dispatch, destSpec))) continue
    const [data] = await dispatch('read', f)
    await dispatch('write', destSpec, [data])
    writes[destOriginal] = new Uint8Array()
    if (verbose) lines.push(`'${f.original}' -> '${destOriginal}'`)
  }
}

const CROSS_COMMANDS: ReadonlySet<string> = new Set(['cp', 'mv', 'diff', 'cmp'])
const MULTI_READ_COMMANDS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
])

export type DispatchFn = (
  op: string,
  path: PathSpec,
  args?: readonly unknown[],
  kwargs?: Record<string, unknown>,
) => Promise<[unknown, IOResult]>

type Result = [ByteSource | null, IOResult, ExecutionNode]

// Mirrors Python str.splitlines(): drops a single trailing empty
// element produced by a terminating "\n". split("\n") does NOT.
function splitLines(text: string): string[] {
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

export function isCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  registry: MountRegistry,
): boolean {
  const allowed = new Set<string>([...CROSS_COMMANDS, ...MULTI_READ_COMMANDS])
  if (!allowed.has(cmdName) || scopes.length < 2) return false
  const mounts = new Set<string>()
  for (const s of scopes) {
    const m = registry.mountFor(s.original)
    if (m !== null) mounts.add(m.prefix)
  }
  return mounts.size > 1
}

export async function handleCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flags: Flags,
  dispatch: DispatchFn,
  cmdStr: string,
): Promise<Result> {
  try {
    if (cmdName === 'cp') return await crossCp(scopes, flags, dispatch, cmdStr)
    if (cmdName === 'mv') return await crossMv(scopes, flags, dispatch, cmdStr)
    if (cmdName === 'diff') return await crossDiff(scopes, dispatch, cmdStr)
    if (cmdName === 'cmp') return await crossCmp(scopes, dispatch, cmdStr)
    if (MULTI_READ_COMMANDS.has(cmdName)) {
      return await crossMultiRead(cmdName, scopes, textArgs, dispatch, cmdStr)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errBytes = new TextEncoder().encode(`${cmdName}: ${msg}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: errBytes }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: errBytes }),
    ]
  }
  const errBytes = new TextEncoder().encode(`${cmdName}: cross-mount not supported\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: errBytes }),
    new ExecutionNode({ command: cmdStr, exitCode: 1 }),
  ]
}

// Copy operands that span two mounts. Reads from the source mount and writes to
// the destination mount through dispatch-relayed primitives, supporting -r
// (recursive), -n (per-file no-clobber) and -v (verbose); a directory without
// -r is a GNU "omitting directory" error. Output matches single-mount cp.
async function crossCp(
  scopes: PathSpec[],
  flags: Flags,
  dispatch: DispatchFn,
  cmdStr: string,
): Promise<Result> {
  const dst = scopes[scopes.length - 1]
  const sources = scopes.slice(0, -1)
  if (dst === undefined || sources.length === 0) throw new Error('cp requires 2 paths')
  const recursive = flagBool(flags, 'r') || flagBool(flags, 'R') || flagBool(flags, 'a')
  const noClobber = flagBool(flags, 'n')
  const verbose = flagBool(flags, 'v')
  const dstIsDir = await isDirPath(dispatch, dst)
  const writes: Record<string, ByteSource> = {}
  const lines: string[] = []
  const errors: string[] = []
  for (const [src, target] of copyTargets(sources, dst, dstIsDir)) {
    if (!(await existsPath(dispatch, src))) {
      errors.push(`cp: cannot stat '${src.original}': No such file or directory`)
      continue
    }
    if (await isDirPath(dispatch, src)) {
      if (!recursive) {
        errors.push(`cp: -r not specified; omitting directory '${src.original}'`)
        continue
      }
      await copyTree(dispatch, src, target, noClobber, verbose, writes, lines)
      continue
    }
    if (noClobber && (await existsPath(dispatch, target))) continue
    const [data] = await dispatch('read', src)
    await dispatch('write', target, [data])
    writes[target.original] = new Uint8Array()
    if (verbose) lines.push(`'${src.original}' -> '${target.original}'`)
  }
  return finishTransfer(writes, lines, errors, cmdStr)
}

// Move operands across mounts: copy then delete the source. Directory operands
// recurse (mv needs no -r); the source tree is removed file-first, then its
// directories bottom-up.
async function crossMv(
  scopes: PathSpec[],
  flags: Flags,
  dispatch: DispatchFn,
  cmdStr: string,
): Promise<Result> {
  const dst = scopes[scopes.length - 1]
  const sources = scopes.slice(0, -1)
  if (dst === undefined || sources.length === 0) throw new Error('mv requires 2 paths')
  const noClobber = flagBool(flags, 'n')
  const verbose = flagBool(flags, 'v')
  const dstIsDir = await isDirPath(dispatch, dst)
  const writes: Record<string, ByteSource> = {}
  const lines: string[] = []
  const errors: string[] = []
  for (const [src, target] of copyTargets(sources, dst, dstIsDir)) {
    if (!(await existsPath(dispatch, src))) {
      errors.push(`mv: cannot stat '${src.original}': No such file or directory`)
      continue
    }
    if (await isDirPath(dispatch, src)) {
      await copyTree(dispatch, src, target, noClobber, verbose, writes, lines)
      const { dirs, files } = await walkTree(dispatch, src)
      for (const f of files) await dispatch('unlink', f)
      for (const d of [...dirs].reverse()) await dispatch('rmdir', d)
      await dispatch('rmdir', src)
      continue
    }
    if (noClobber && (await existsPath(dispatch, target))) continue
    const [data] = await dispatch('read', src)
    await dispatch('write', target, [data])
    await dispatch('unlink', src)
    writes[target.original] = new Uint8Array()
    if (verbose) lines.push(`'${src.original}' -> '${target.original}'`)
  }
  return finishTransfer(writes, lines, errors, cmdStr)
}

function finishTransfer(
  writes: Record<string, ByteSource>,
  lines: string[],
  errors: string[],
  cmdStr: string,
): Result {
  const out = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
  const exitCode = errors.length > 0 ? 1 : 0
  const stderr = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : null
  const io = new IOResult({ writes, exitCode, ...(stderr !== null ? { stderr } : {}) })
  const node = new ExecutionNode({
    command: cmdStr,
    exitCode,
    ...(stderr !== null ? { stderr } : {}),
  })
  return [out, io, node]
}

async function crossDiff(
  scopes: PathSpec[],
  dispatch: DispatchFn,
  cmdStr: string,
): Promise<Result> {
  const [a, b] = [scopes[0], scopes[1]]
  if (a === undefined || b === undefined) throw new Error('diff requires 2 paths')
  const [dataA] = await dispatch('read', a)
  const [dataB] = await dispatch('read', b)
  const textA = new TextDecoder().decode(dataA as Uint8Array).split('\n')
  const textB = new TextDecoder().decode(dataB as Uint8Array).split('\n')
  const hunks = unifiedDiff(textA, textB, a.original, b.original)
  if (hunks.length === 0) {
    return [new Uint8Array(), new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }
  const out = new TextEncoder().encode(hunks.join('\n') + '\n')
  return [out, new IOResult({ exitCode: 1 }), new ExecutionNode({ command: cmdStr, exitCode: 1 })]
}

async function crossCmp(scopes: PathSpec[], dispatch: DispatchFn, cmdStr: string): Promise<Result> {
  const [a, b] = [scopes[0], scopes[1]]
  if (a === undefined || b === undefined) throw new Error('cmp requires 2 paths')
  const [dataA] = await dispatch('read', a)
  const [dataB] = await dispatch('read', b)
  const bufA = dataA as Uint8Array
  const bufB = dataB as Uint8Array
  const minLen = Math.min(bufA.byteLength, bufB.byteLength)
  for (let i = 0; i < minLen; i++) {
    if (bufA[i] !== bufB[i]) {
      const msg = new TextEncoder().encode(
        `${a.original} ${b.original} differ: byte ${(i + 1).toString()}\n`,
      )
      return [
        msg,
        new IOResult({ exitCode: 1 }),
        new ExecutionNode({ command: cmdStr, exitCode: 1 }),
      ]
    }
  }
  if (bufA.byteLength === bufB.byteLength) {
    return [new Uint8Array(), new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }
  const shorter = bufA.byteLength < bufB.byteLength ? a.original : b.original
  const msg = new TextEncoder().encode(`cmp: EOF on ${shorter}\n`)
  return [msg, new IOResult({ exitCode: 1 }), new ExecutionNode({ command: cmdStr, exitCode: 1 })]
}

async function crossMultiRead(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  dispatch: DispatchFn,
  cmdStr: string,
): Promise<Result> {
  const fileData: [string, Uint8Array][] = []
  const reads: Record<string, ByteSource> = {}
  const cache: string[] = []
  for (const scope of scopes) {
    const [data] = await dispatch('read', scope)
    if (data instanceof Uint8Array) {
      fileData.push([scope.original, data])
      reads[scope.original] = data
      cache.push(scope.original)
    }
  }
  const io = new IOResult({ reads, cache })

  if (cmdName === 'cat') {
    const combined = concatAll(fileData.map(([, d]) => d))
    return [combined, io, new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }

  if (cmdName === 'head' || cmdName === 'tail') {
    let n = 10
    for (let i = 0; i < textArgs.length; i++) {
      if (textArgs[i] === '-n' && i + 1 < textArgs.length) {
        const raw = textArgs[i + 1] ?? ''
        const parsed = Number(raw)
        if (!Number.isInteger(parsed)) {
          const err = new TextEncoder().encode(`${cmdName}: invalid number: '${raw}'\n`)
          return [
            null,
            new IOResult({ exitCode: 1, stderr: err }),
            new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
          ]
        }
        n = parsed
      }
    }
    const parts: string[] = []
    const multi = fileData.length > 1
    for (const [name, data] of fileData) {
      const lines = splitLines(new TextDecoder().decode(data))
      if (multi) parts.push(`==> ${name} <==`)
      const slice = cmdName === 'head' ? lines.slice(0, n) : lines.slice(-n)
      parts.push(...slice)
    }
    return [
      new TextEncoder().encode(parts.join('\n') + '\n'),
      io,
      new ExecutionNode({ command: cmdStr, exitCode: 0 }),
    ]
  }

  if (cmdName === 'grep' || cmdName === 'rg') {
    const pattern = textArgs[0] ?? ''
    const flags = textArgs.includes('-i') ? 'i' : ''
    const compiled = new RegExp(pattern, flags)
    const results: string[] = []
    for (const [name, data] of fileData) {
      for (const line of splitLines(new TextDecoder().decode(data))) {
        if (compiled.test(line)) results.push(`${name}:${line}`)
      }
    }
    if (results.length === 0) {
      io.exitCode = 1
      return [new Uint8Array(), io, new ExecutionNode({ command: cmdStr, exitCode: 1 })]
    }
    return [
      new TextEncoder().encode(results.join('\n') + '\n'),
      io,
      new ExecutionNode({ command: cmdStr, exitCode: 0 }),
    ]
  }

  if (cmdName === 'wc') {
    const parts: string[] = []
    let totalLines = 0
    let totalWords = 0
    let totalChars = 0
    for (const [name, data] of fileData) {
      const text = new TextDecoder().decode(data)
      const lines = (text.match(/\n/g) ?? []).length
      const words = text.split(/\s+/).filter(Boolean).length
      const chars = data.byteLength
      totalLines += lines
      totalWords += words
      totalChars += chars
      if (textArgs.includes('-l')) parts.push(`${lines.toString()} ${name}`)
      else if (textArgs.includes('-w')) parts.push(`${words.toString()} ${name}`)
      else if (textArgs.includes('-c')) parts.push(`${chars.toString()} ${name}`)
      else parts.push(`${lines.toString()} ${words.toString()} ${chars.toString()} ${name}`)
    }
    if (fileData.length > 1) {
      if (textArgs.includes('-l')) parts.push(`${totalLines.toString()} total`)
      else if (textArgs.includes('-w')) parts.push(`${totalWords.toString()} total`)
      else if (textArgs.includes('-c')) parts.push(`${totalChars.toString()} total`)
      else
        parts.push(
          `${totalLines.toString()} ${totalWords.toString()} ${totalChars.toString()} total`,
        )
    }
    return [
      new TextEncoder().encode(parts.join('\n') + '\n'),
      io,
      new ExecutionNode({ command: cmdStr, exitCode: 0 }),
    ]
  }

  const combined = concatAll(fileData.map(([, d]) => d))
  return [combined, io, new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

function unifiedDiff(a: string[], b: string[], fromFile: string, toFile: string): string[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = []
  for (let i = 0; i <= n; i++) lcs.push(new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const here = lcs[i]
      const next = lcs[i + 1]
      if (here === undefined || next === undefined) continue
      if (a[i] === b[j]) {
        here[j] = (next[j + 1] ?? 0) + 1
      } else {
        here[j] = Math.max(next[j] ?? 0, here[j + 1] ?? 0)
      }
    }
  }
  const ops: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const here = lcs[i]
    const next = lcs[i + 1]
    if (here === undefined || next === undefined) break
    if (a[i] === b[j]) {
      ops.push(` ${a[i] ?? ''}`)
      i++
      j++
    } else if ((next[j] ?? 0) >= (here[j + 1] ?? 0)) {
      ops.push(`-${a[i] ?? ''}`)
      i++
    } else {
      ops.push(`+${b[j] ?? ''}`)
      j++
    }
  }
  while (i < n) ops.push(`-${a[i++] ?? ''}`)
  while (j < m) ops.push(`+${b[j++] ?? ''}`)
  if (!ops.some((op) => op.startsWith('-') || op.startsWith('+'))) return []
  return [`--- ${fromFile}`, `+++ ${toFile}`, ...ops]
}
