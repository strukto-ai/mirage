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

import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { EnvWorld } from './world.ts'

const ids = new WeakMap<Workspace, string>()

function workspaceId(ws: Workspace): string {
  let id = ids.get(ws)
  if (id === undefined) {
    id = `mirage:${crypto.randomUUID()}`
    ids.set(ws, id)
  }
  return id
}

/**
 * A workspace in this process, as one session sees it: its dispatcher and
 * its shell.
 *
 * @param ws the workspace.
 * @param sessionId the session every call acts as; the default when absent.
 * @param id Pi's file namespace; one per workspace when absent.
 * @returns the world `MirageExecutionEnv` works in.
 */
export function localWorld(ws: Workspace, sessionId?: string, id?: string): EnvWorld {
  const session = new Session(ws, sessionId ?? null)
  const files = session.vfs
  return {
    id: id ?? workspaceId(ws),
    files: {
      read: (path) => files.read(path),
      readStream: (path) => files.read(path, { stream: true }),
      write: (path, data) => files.write(path, data),
      writeStream: (path, chunks) => files.write(path, chunks),
      append: (path, data) => files.append(path, data),
      stat: (path, options = {}) => files.stat(path, undefined, options),
      readdir: (path) => files.readdir(path),
      exists: (path) => files.exists(path),
      isDir: (path) => files.isDir(path),
      mkdir: (path) => files.mkdir(path),
      rmdir: (path) => files.rmdir(path),
      unlink: (path) => files.unlink(path),
      truncate: (path, length) => files.truncate(path, length),
      rename: (source, destination) => files.rename(source, destination),
      readlink: (path) => files.readlink(path),
      holdsMount: (path) =>
        Promise.resolve(files.isMount(path) || files.submounts(path).length > 0),
    },
    shell: {
      run: (line, options = {}) =>
        session.shell(line, {
          record: false,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        }),
      stream: (line, options) =>
        session.shell(line, {
          stream: true,
          cwd: options.cwd,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
    },
  }
}
