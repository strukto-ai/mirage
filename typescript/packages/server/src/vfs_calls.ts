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

import type { JsonSchemaType } from '@modelcontextprotocol/server'
import type { Files } from '@struktoai/mirage-core/workspace/files'
import type { JsonValue } from '@struktoai/mirage-core/types'
import type { VfsExplainer } from '@struktoai/mirage-core/workspace/workspace/explainer'

export type Args = Readonly<Record<string, unknown>>
export type Schema = Record<string, JsonValue>

export const PATH: Schema = { type: 'string' }
export const TEXT: Schema = { type: 'string' }
export const BYTES: Schema = { type: 'string', contentEncoding: 'base64' }
export const INTEGER: Schema = { type: 'integer' }
export const SIZE: Schema = { type: ['integer', 'null'] }
export const FLAG: Schema = { type: 'boolean' }
export const OWNER: Schema = { type: ['integer', 'string'] }

/**
 * One `session.vfs` call as the remote entry points carry it: its arguments as
 * JSON schemas, the method it calls on `session.vfs` (or on
 * `session.explain.vfs` to explain it) and the key its result is answered
 * under. `<name>_base64` carries the bytes `<name>` takes. Mirrors
 * Python's `VfsCall`.
 */
export interface VfsCall {
  /** The call's name; `vfs/<name>` on every entry point. */
  readonly name: string
  /** What the call does, in one line. */
  readonly description: string
  /** Each argument's JSON schema, in the order the call takes them. */
  readonly params: Readonly<Record<string, Schema>>
  /** The arguments it cannot do without. */
  readonly required: readonly string[]
  /** The key its result is answered under; null for a call that answers nothing. */
  readonly answer: string | null
  /** The call on `session.vfs`, or on `session.explain.vfs`. */
  readonly run: (target: Files | VfsExplainer, a: Args) => Promise<unknown>
}

function row(
  name: string,
  description: string,
  params: Readonly<Record<string, Schema>>,
  required: readonly string[],
  answer: string | null,
  run: VfsCall['run'],
): VfsCall {
  return { name, description, params, required, answer, run }
}

const str = (a: Args, key: string): string => a[key] as string
const int = (a: Args, key: string): number => a[key] as number
const bin = (a: Args, key: string): Uint8Array => a[key] as Uint8Array
const flag = (a: Args, key: string): boolean => a[key] === true
const nofollow = (a: Args): { nofollow: boolean } => ({ nofollow: flag(a, 'nofollow') })
const PATH_ONLY = { path: PATH }

function attrs(a: Args): {
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
  mtime?: string
  nofollow?: boolean
} {
  return Object.fromEntries(
    ['mode', 'uid', 'gid', 'atime', 'mtime', 'nofollow']
      .filter((key) => a[key] !== undefined)
      .map((key) => [key, a[key]]),
  )
}

export const VFS_CALLS: readonly VfsCall[] = [
  row(
    'read',
    "Read a file's bytes, from an offset.",
    { path: PATH, offset: INTEGER, size: SIZE },
    ['path'],
    'data_base64',
    (t, a) =>
      t.read(str(a, 'path'), {
        offset: (a.offset as number | undefined) ?? 0,
        size: (a.size as number | null | undefined) ?? null,
      }),
  ),
  row(
    'write',
    "Write a file's bytes, replacing what it held.",
    { path: PATH, data_base64: BYTES },
    ['path', 'data_base64'],
    null,
    (t, a) => t.write(str(a, 'path'), bin(a, 'data')),
  ),
  row(
    'append',
    'Append bytes to a file.',
    { path: PATH, data_base64: BYTES },
    ['path', 'data_base64'],
    null,
    (t, a) => t.append(str(a, 'path'), bin(a, 'data')),
  ),
  row(
    'pwrite',
    'Write bytes into a file at an offset.',
    { path: PATH, data_base64: BYTES, offset: INTEGER },
    ['path', 'data_base64', 'offset'],
    null,
    (t, a) => t.pwrite(str(a, 'path'), bin(a, 'data'), int(a, 'offset')),
  ),
  row('stat', "A path's metadata.", { path: PATH, nofollow: FLAG }, ['path'], 'stat', (t, a) =>
    'sessionId' in t
      ? t.stat(str(a, 'path'), undefined, nofollow(a))
      : t.stat(str(a, 'path'), nofollow(a)),
  ),
  row('readdir', "A directory's entries.", PATH_ONLY, ['path'], 'entries', (t, a) =>
    t.readdir(str(a, 'path')),
  ),
  row('exists', 'Whether a path exists.', PATH_ONLY, ['path'], 'exists', (t, a) =>
    t.exists(str(a, 'path')),
  ),
  row('is_dir', 'Whether a path is a directory.', PATH_ONLY, ['path'], 'is_dir', (t, a) =>
    t.isDir(str(a, 'path')),
  ),
  row('is_file', 'Whether a path is a file.', PATH_ONLY, ['path'], 'is_file', (t, a) =>
    t.isFile(str(a, 'path')),
  ),
  row('cat', "A file's text.", PATH_ONLY, ['path'], 'text', (t, a) => t.cat(str(a, 'path'))),
  row('list_files', "The names of a directory's files.", PATH_ONLY, ['path'], 'files', (t, a) =>
    t.listFiles(str(a, 'path')),
  ),
  row('mkdir', 'Make a directory.', PATH_ONLY, ['path'], null, (t, a) => t.mkdir(str(a, 'path'))),
  row('rmdir', 'Remove an empty directory.', PATH_ONLY, ['path'], null, (t, a) =>
    t.rmdir(str(a, 'path')),
  ),
  row('unlink', 'Remove a file.', PATH_ONLY, ['path'], null, (t, a) => t.unlink(str(a, 'path'))),
  row('create', 'Create an empty file.', PATH_ONLY, ['path'], null, (t, a) =>
    t.create(str(a, 'path')),
  ),
  row(
    'rename',
    'Rename a path within its mount.',
    { src: PATH, dst: PATH },
    ['src', 'dst'],
    null,
    (t, a) => t.rename(str(a, 'src'), str(a, 'dst')),
  ),
  row(
    'symlink',
    'Make a symbolic link at a path.',
    { path: PATH, target: TEXT },
    ['path', 'target'],
    null,
    (t, a) => t.symlink(str(a, 'path'), str(a, 'target')),
  ),
  row('readlink', 'Where a symbolic link points.', PATH_ONLY, ['path'], 'target', (t, a) =>
    t.readlink(str(a, 'path')),
  ),
  row(
    'setattr',
    "Change a path's mode, owner or times.",
    { path: PATH, mode: INTEGER, uid: OWNER, gid: OWNER, atime: TEXT, mtime: TEXT, nofollow: FLAG },
    ['path'],
    'changed',
    (t, a) => t.setattr(str(a, 'path'), attrs(a)),
  ),
  row(
    'getxattr',
    "One extended attribute's value.",
    { path: PATH, name: TEXT, nofollow: FLAG },
    ['path', 'name'],
    'value_base64',
    (t, a) => t.getxattr(str(a, 'path'), str(a, 'name'), nofollow(a)),
  ),
  row(
    'listxattr',
    "A path's extended attribute names.",
    { path: PATH, nofollow: FLAG },
    ['path'],
    'names',
    (t, a) => t.listxattr(str(a, 'path'), nofollow(a)),
  ),
  row(
    'setxattr',
    'Set an extended attribute.',
    { path: PATH, name: TEXT, value_base64: BYTES, create: FLAG, replace: FLAG, nofollow: FLAG },
    ['path', 'name', 'value_base64'],
    null,
    (t, a) =>
      t.setxattr(str(a, 'path'), str(a, 'name'), bin(a, 'value'), {
        create: flag(a, 'create'),
        replace: flag(a, 'replace'),
        nofollow: flag(a, 'nofollow'),
      }),
  ),
  row(
    'removexattr',
    'Remove an extended attribute.',
    { path: PATH, name: TEXT, nofollow: FLAG },
    ['path', 'name'],
    null,
    (t, a) => t.removexattr(str(a, 'path'), str(a, 'name'), nofollow(a)),
  ),
  row(
    'truncate',
    'Cut or extend a file to a length.',
    { path: PATH, length: INTEGER },
    ['path', 'length'],
    null,
    (t, a) => t.truncate(str(a, 'path'), int(a, 'length')),
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
