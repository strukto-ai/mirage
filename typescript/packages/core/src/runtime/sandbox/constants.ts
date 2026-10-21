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

import { singleQuote } from '../../utils/quote.ts'
import type { MountType } from '../types.ts'

export const MOUNT_TYPES: readonly MountType[] = ['ssh', 'fuse', 'both']

// How long a sandbox has to show a served prefix as mounted, and how
// often it is asked.
export const MOUNT_WAIT_SECONDS = 15
export const MOUNT_POLL_SECONDS = 0.1

// How long a served prefix's SFTP server may take to end once its
// sandbox side is unmounted.
export const UNMOUNT_WAIT_SECONDS = 5

// How much of a pipe helper's stderr is kept to say why a mount failed,
// and how long a helper still running has to finish saying it.
export const PIPE_DIAGNOSTIC_BYTES = 16384
export const PIPE_DIAGNOSTIC_WAIT_SECONDS = 1

// sshfs keeps no copy of its own: every listing, stat and read asks the
// host, so a file the host changes, or a profile now hides, shows at
// once, and a file whose size the backend does not know reads whole
// (direct_io), as the workspace's own FUSE mounts do.
export const SSHFS_OPTIONS =
  'passive,dir_cache=no,direct_io,attr_timeout=0,entry_timeout=0,negative_timeout=0'

// Where sshfs writes its errors in the sandbox, one file per prefix; its
// stdout is the SFTP stream, so its stderr cannot share the pipe.
export const SSHFS_LOG_PREFIX = '/tmp/.mirage_sshfs'

export const SSHFS_HINT =
  'serving the workspace into a sandbox needs sshfs there; install it in the image (apt-get install sshfs)'
export const PIPE_SERVER_HINT =
  'serving the workspace into a sandbox needs @struktoai/mirage-node and its ssh2 peer'

/**
 * Every argv a sandbox runs goes under this POSIX sh prelude, with the
 * cwd as $1: a provider CLI's exec passes `-w /` (`execArgs`), and a
 * provider whose exec takes one command line dresses it (`wrapLine`), so
 * no provider's own cwd is used. An exec's `-e` can append to the image's
 * environment rather than replace a name it already sets, `-w` can
 * create a missing directory, and an SDK's cwd fails a missing one its
 * own way (E2B: exit 1). sh imports the
 * environment last-wins, `cd` fails loud (126) on a cwd the sandbox does
 * not serve, and `exec` hands over the argv unchanged. `cd` runs without
 * CDPATH, so a relative cwd resolves from `/` and prints nothing, while
 * the program still sees the guest's own CDPATH.
 */
export const EXEC_PRELUDE = 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"'

/**
 * The line dressed for a sandbox whose exec takes one command line
 * (ssh, e2b, daytona): cwd, env, then sh.
 *
 * Such an exec has no docker-style `-w`/`-e` to trust: SSH's env channel
 * is AcceptEnv-gated server-side, so it silently drops names, and an
 * SDK's own cwd fails a missing directory in its own words. So the
 * working directory and the merged environment ride the command itself:
 * the prelude every sandbox runs a command under enters `cwd` (exit 126
 * when the sandbox lacks it), then `env 'K=V' ... sh -c 'line'`. Every
 * piece is single-quoted for sh, so the shell the exec starts reads each
 * as one word whatever it holds; the sandbox only needs a
 * POSIX-compatible shell.
 */
export function wrapLine(line: string, env: Record<string, string>, cwd: string): string {
  const parts = ['sh', '-c', singleQuote(EXEC_PRELUDE), 'sh', singleQuote(cwd), 'env']
  for (const [key, value] of Object.entries(env)) parts.push(singleQuote(`${key}=${value}`))
  parts.push('sh', '-c', singleQuote(line))
  return parts.join(' ')
}
