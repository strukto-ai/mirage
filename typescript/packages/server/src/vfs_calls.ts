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

import { Buffer } from 'node:buffer'
import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'
import type { Ops } from '@struktoai/mirage-core/ops/ops'
import type { VfsExplanation } from '@struktoai/mirage-core/policy/types'
import type { FileStat, JsonValue } from '@struktoai/mirage-core/types'
import type { VfsExplainer } from '@struktoai/mirage-core/workspace/workspace/explainer'
import type { Session } from '@struktoai/mirage-core/workspace/workspace/handle'
import { explanationToDict } from './io_serde.ts'

type Args = Readonly<Record<string, unknown>>
export type Schema = Record<string, JsonValue>
export type Answer = Record<string, JsonValue>

export const PATH: Schema = { type: 'string' }
export const TEXT: Schema = { type: 'string' }
export const BYTES: Schema = { type: 'string', contentEncoding: 'base64' }
export const INTEGER: Schema = { type: 'integer' }
export const SIZE: Schema = { type: ['integer', 'null'] }
export const FLAG: Schema = { type: 'boolean' }
export const OWNER: Schema = { type: ['integer', 'string'] }

/** A call's arguments do not fit its schema. Mirrors Python's `CallArgsError`. */
export class CallArgsError extends Error {}

/**
 * One `session.vfs` call as the remote doors carry it: its arguments as
 * JSON, the call they make on `session.vfs` answered as JSON, and the same
 * call on `session.explain.vfs`. Mirrors Python's `VfsCall`.
 */
export interface VfsCall {
  /** The call's name; `vfs/<name>` on every door. */
  readonly name: string
  /** What the call does, in one line. */
  readonly description: string
  /** Each argument's JSON schema, in the order the call takes them. */
  readonly params: Readonly<Record<string, Schema>>
  /** The arguments it cannot do without. */
  readonly required: readonly string[]
  /** The call on `session.vfs`, its result as JSON. */
  readonly run: (vfs: Ops, a: Args) => Promise<Answer>
  /** The same call on `session.explain.vfs`. */
  readonly explain: (explainer: VfsExplainer, a: Args) => Promise<VfsExplanation>
}

function row<T>(
  name: string,
  description: string,
  params: Readonly<Record<string, Schema>>,
  required: readonly string[],
  run: (vfs: Ops, a: Args) => Promise<T>,
  answer: (result: T) => Answer,
  explain: (explainer: VfsExplainer, a: Args) => Promise<VfsExplanation>,
): VfsCall {
  return {
    name,
    description,
    params,
    required,
    run: async (vfs, a) => answer(await run(vfs, a)),
    explain,
  }
}

const none = (): Answer => ({})
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')
const str = (a: Args, key: string): string => a[key] as string
const int = (a: Args, key: string): number => a[key] as number
const bin = (a: Args, key: string): Uint8Array => a[key] as Uint8Array
const flag = (a: Args, key: string): boolean => a[key] === true
const nofollow = (a: Args): { nofollow: boolean } => ({ nofollow: flag(a, 'nofollow') })

function stat(s: FileStat): Answer {
  return {
    name: s.name,
    size: s.size,
    modified: s.modified,
    fingerprint: s.fingerprint,
    revision: s.revision,
    type: s.type,
    content: s.content,
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    atime: s.atime,
    ctime: s.ctime,
    birthtime: s.birthtime,
  }
}

function attrs(a: Args): {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
  nofollow?: boolean
} {
  const out: Record<string, unknown> = {}
  for (const key of ['mode', 'uid', 'gid', 'atime', 'mtime', 'nofollow']) {
    if (a[key] !== undefined) out[key] = a[key]
  }
  return out
}

function read(a: Args): { offset: number; size: number | null } {
  return { offset: (a.offset as number | undefined) ?? 0, size: (a.size as number | null) ?? null }
}

function xattrOpts(a: Args): { create: boolean; replace: boolean; nofollow: boolean } {
  return { create: flag(a, 'create'), replace: flag(a, 'replace'), nofollow: flag(a, 'nofollow') }
}

export const VFS_CALLS: readonly VfsCall[] = [
  row(
    'read',
    "Read a file's bytes, from an offset.",
    { path: PATH, offset: INTEGER, size: SIZE },
    ['path'],
    (v, a) => v.read(str(a, 'path'), read(a)),
    (data) => ({ data_base64: b64(data) }),
    (e, a) => e.read(str(a, 'path'), read(a)),
  ),
  row(
    'write',
    "Write a file's bytes, replacing what it held.",
    { path: PATH, data_base64: BYTES },
    ['path', 'data_base64'],
    (v, a) => v.write(str(a, 'path'), bin(a, 'data_base64')),
    none,
    (e, a) => e.write(str(a, 'path'), bin(a, 'data_base64')),
  ),
  row(
    'append',
    'Append bytes to a file.',
    { path: PATH, data_base64: BYTES },
    ['path', 'data_base64'],
    (v, a) => v.append(str(a, 'path'), bin(a, 'data_base64')),
    none,
    (e, a) => e.append(str(a, 'path'), bin(a, 'data_base64')),
  ),
  row(
    'pwrite',
    'Write bytes into a file at an offset.',
    { path: PATH, data_base64: BYTES, offset: INTEGER },
    ['path', 'data_base64', 'offset'],
    (v, a) => v.pwrite(str(a, 'path'), bin(a, 'data_base64'), int(a, 'offset')),
    none,
    (e, a) => e.pwrite(str(a, 'path'), bin(a, 'data_base64'), int(a, 'offset')),
  ),
  row(
    'stat',
    "A path's metadata.",
    { path: PATH, nofollow: FLAG },
    ['path'],
    (v, a) => v.stat(str(a, 'path'), undefined, nofollow(a)),
    stat,
    (e, a) => e.stat(str(a, 'path'), nofollow(a)),
  ),
  row(
    'readdir',
    "A directory's entries.",
    { path: PATH },
    ['path'],
    (v, a) => v.readdir(str(a, 'path')),
    (entries) => ({ entries }),
    (e, a) => e.readdir(str(a, 'path')),
  ),
  row(
    'exists',
    'Whether a path exists.',
    { path: PATH },
    ['path'],
    (v, a) => v.exists(str(a, 'path')),
    (exists) => ({ exists }),
    (e, a) => e.exists(str(a, 'path')),
  ),
  row(
    'is_dir',
    'Whether a path is a directory.',
    { path: PATH },
    ['path'],
    (v, a) => v.isDir(str(a, 'path')),
    (found) => ({ is_dir: found }),
    (e, a) => e.isDir(str(a, 'path')),
  ),
  row(
    'is_file',
    'Whether a path is a file.',
    { path: PATH },
    ['path'],
    (v, a) => v.isFile(str(a, 'path')),
    (found) => ({ is_file: found }),
    (e, a) => e.isFile(str(a, 'path')),
  ),
  row(
    'cat',
    "A file's text.",
    { path: PATH },
    ['path'],
    (v, a) => v.cat(str(a, 'path')),
    (text) => ({ text }),
    (e, a) => e.cat(str(a, 'path')),
  ),
  row(
    'list_files',
    "The names of a directory's files.",
    { path: PATH },
    ['path'],
    (v, a) => v.listFiles(str(a, 'path')),
    (files) => ({ files }),
    (e, a) => e.listFiles(str(a, 'path')),
  ),
  row(
    'mkdir',
    'Make a directory.',
    { path: PATH },
    ['path'],
    (v, a) => v.mkdir(str(a, 'path')),
    none,
    (e, a) => e.mkdir(str(a, 'path')),
  ),
  row(
    'rmdir',
    'Remove an empty directory.',
    { path: PATH },
    ['path'],
    (v, a) => v.rmdir(str(a, 'path')),
    none,
    (e, a) => e.rmdir(str(a, 'path')),
  ),
  row(
    'unlink',
    'Remove a file.',
    { path: PATH },
    ['path'],
    (v, a) => v.unlink(str(a, 'path')),
    none,
    (e, a) => e.unlink(str(a, 'path')),
  ),
  row(
    'create',
    'Create an empty file.',
    { path: PATH },
    ['path'],
    (v, a) => v.create(str(a, 'path')),
    none,
    (e, a) => e.create(str(a, 'path')),
  ),
  row(
    'rename',
    'Rename a path within its mount.',
    { src: PATH, dst: PATH },
    ['src', 'dst'],
    (v, a) => v.rename(str(a, 'src'), str(a, 'dst')),
    none,
    (e, a) => e.rename(str(a, 'src'), str(a, 'dst')),
  ),
  row(
    'symlink',
    'Make a symbolic link at a path.',
    { path: PATH, target: TEXT },
    ['path', 'target'],
    (v, a) => v.symlink(str(a, 'path'), str(a, 'target')),
    none,
    (e, a) => e.symlink(str(a, 'path'), str(a, 'target')),
  ),
  row(
    'readlink',
    'Where a symbolic link points.',
    { path: PATH },
    ['path'],
    (v, a) => v.readlink(str(a, 'path')),
    (target) => ({ target }),
    (e, a) => e.readlink(str(a, 'path')),
  ),
  row(
    'setattr',
    "Change a path's mode, owner or times.",
    { path: PATH, mode: INTEGER, uid: OWNER, gid: OWNER, atime: TEXT, mtime: TEXT, nofollow: FLAG },
    ['path'],
    (v, a) => v.setattr(str(a, 'path'), attrs(a)),
    (changed) => ({ changed }),
    (e, a) => e.setattr(str(a, 'path'), attrs(a)),
  ),
  row(
    'getxattr',
    "One extended attribute's value.",
    { path: PATH, name: TEXT, nofollow: FLAG },
    ['path', 'name'],
    (v, a) => v.getxattr(str(a, 'path'), str(a, 'name'), nofollow(a)),
    (value) => ({ value_base64: b64(value) }),
    (e, a) => e.getxattr(str(a, 'path'), str(a, 'name'), nofollow(a)),
  ),
  row(
    'listxattr',
    "A path's extended attribute names.",
    { path: PATH, nofollow: FLAG },
    ['path'],
    (v, a) => v.listxattr(str(a, 'path'), nofollow(a)),
    (names) => ({ names }),
    (e, a) => e.listxattr(str(a, 'path'), nofollow(a)),
  ),
  row(
    'setxattr',
    'Set an extended attribute.',
    {
      path: PATH,
      name: TEXT,
      value_base64: BYTES,
      create: FLAG,
      replace: FLAG,
      nofollow: FLAG,
    },
    ['path', 'name', 'value_base64'],
    (v, a) => v.setxattr(str(a, 'path'), str(a, 'name'), bin(a, 'value_base64'), xattrOpts(a)),
    none,
    (e, a) => e.setxattr(str(a, 'path'), str(a, 'name'), bin(a, 'value_base64'), xattrOpts(a)),
  ),
  row(
    'removexattr',
    'Remove an extended attribute.',
    { path: PATH, name: TEXT, nofollow: FLAG },
    ['path', 'name'],
    (v, a) => v.removexattr(str(a, 'path'), str(a, 'name'), nofollow(a)),
    none,
    (e, a) => e.removexattr(str(a, 'path'), str(a, 'name'), nofollow(a)),
  ),
  row(
    'truncate',
    'Cut or extend a file to a length.',
    { path: PATH, length: INTEGER },
    ['path', 'length'],
    (v, a) => v.truncate(str(a, 'path'), int(a, 'length')),
    none,
    (e, a) => e.truncate(str(a, 'path'), int(a, 'length')),
  ),
]

export const VFS_CALL_BY_NAME: ReadonlyMap<string, VfsCall> = new Map(
  VFS_CALLS.map((call) => [call.name, call]),
)

/** A call's arguments as one JSON object schema. */
export function schemaOf(call: VfsCall): JsonSchemaType {
  return {
    type: 'object',
    properties: call.params,
    required: [...call.required],
    additionalProperties: false,
  } as JsonSchemaType
}

/**
 * A call's arguments, held to its schema, with every base64 argument
 * decoded to bytes. Throws `CallArgsError` when they do not fit. Mirrors
 * Python's `checked`.
 */
export async function checked(call: VfsCall, params: unknown): Promise<Record<string, unknown>> {
  const result = await fromJsonSchema(schemaOf(call))['~standard'].validate(params)
  if (result.issues !== undefined) {
    const why = result.issues.map((issue) => issue.message).join('; ')
    throw new CallArgsError(`invalid arguments for vfs/${call.name}: ${why}`)
  }
  const args: Record<string, unknown> = { ...(params as Args) }
  for (const [name, schema] of Object.entries(call.params)) {
    if (schema !== BYTES || typeof args[name] !== 'string') continue
    const value = args[name]
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw new CallArgsError(`${name} must be base64`)
    }
    args[name] = new Uint8Array(Buffer.from(value, 'base64'))
  }
  return args
}

/**
 * Run a call as a session, or explain it, and answer it as JSON. Mirrors
 * Python's `answered`.
 */
export async function answered(
  session: Session,
  call: VfsCall,
  args: Args,
  explain: boolean,
): Promise<JsonValue> {
  if (explain) return explanationToDict(await call.explain(session.explain.vfs, args))
  return call.run(session.vfs, args)
}
