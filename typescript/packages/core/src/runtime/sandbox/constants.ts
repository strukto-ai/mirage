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
 * own way (E2B: exit 1). sh imports the environment last-wins, `cd`
 * fails loud (126) on a cwd the sandbox does not serve, and `exec` hands
 * over the argv unchanged. `cd` runs without CDPATH, so a relative cwd
 * resolves from `/` and prints nothing, while the program still sees the
 * guest's own CDPATH. The shell is named by path, /bin/sh, since the
 * command's PATH is the session's and may hold no sh; the argv after the
 * prelude is still found on it.
 */
export const EXEC_PRELUDE = 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"'

/**
 * Every process a run starts in a sandbox carries this variable, set to the
 * run's own id, so a run cancelled midway can be stopped in the box:
 * stopping the client that started it does not reach the box everywhere
 * (`docker exec` has no kill, and the daemon keeps draining the program's
 * output, so a `yes` cut short by `head` would spin on). The id rides the
 * environment because every process of a pipeline inherits it.
 */
export const EXEC_ID = 'MIRAGE_EXEC_ID'

// How long stopping a cancelled run may hold the cancel: the stop line's
// own second of grace, plus the exec's round trips. A box that stopped
// answering is given up on after it.
export const REAP_WAIT_SECONDS = 5

// How long a program a `kill` signalled may take to exit before it gets
// KILL, for its handlers to clean up: the stop line's same second.
export const STOP_GRACE_SECONDS = 1

// How often a stop in its grace checks whether the signalled group ended.
export const STOP_POLL_SECONDS = 0.02

// Where the stop line finds grep and sleep: the config's PATH is for the
// programs it runs and may name none of the system's directories.
export const REAP_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/**
 * The command line for a sandbox whose exec takes one (ssh, e2b,
 * daytona): cwd, env, then the argv.
 *
 * Such an exec has no docker-style `-w`/`-e` to trust: SSH's env channel
 * is AcceptEnv-gated server-side, so it silently drops names, and an
 * SDK's own cwd fails a missing directory in its own words. So the
 * working directory and the merged environment ride the command itself:
 * the prelude every sandbox runs a command under enters `cwd` (exit 126
 * when the sandbox lacks it), then `env 'K=V' ... 'prog' 'arg'`; a shell
 * line is the argv `/bin/sh -c line`. Every piece is single-quoted for sh,
 * so the shell the exec starts reads each as one word whatever it holds;
 * the sandbox only needs a POSIX shell at `/bin/sh`.
 *
 * @param argv the program and its arguments.
 * @param env the merged environment.
 * @param cwd the working directory, passed through verbatim.
 */
export function wrapLine(
  argv: readonly string[],
  env: Record<string, string>,
  cwd: string,
): string {
  const parts = ['/bin/sh', '-c', singleQuote(EXEC_PRELUDE), 'sh', singleQuote(cwd), 'env']
  for (const [key, value] of Object.entries(env)) parts.push(singleQuote(`${key}=${value}`))
  for (const word of argv) parts.push(singleQuote(word))
  return parts.join(' ')
}

/**
 * The shell line that stops every process of the run `execId`.
 *
 * Each process whose environment holds the run's id, found through
 * `/proc`, gets `signum`, and what still runs a second later gets KILL,
 * so a program that ignores it stops too. The line looks grep up on its
 * own PATH (`REAP_PATH`) and exits 127 without it, so it needs only a
 * POSIX shell, grep and `/proc`.
 *
 * @param execId the run's id, as `EXEC_ID` carries it.
 * @param signum the first signal, TERM (15) unless a `kill` named another.
 */
export function reapLine(execId: string, signum = 15): string {
  const mark = singleQuote(`${EXEC_ID}=${execId}`)
  return (
    `PATH=${REAP_PATH}; command -v grep >/dev/null || exit 127; ` +
    `m=${mark}; ` +
    'left() { l=; for p in /proc/[0-9]*; do ' +
    'grep -qs "$m" "$p/environ" && l="$l ${p#/proc/}"; done; ' +
    '[ -n "$l" ]; }; ' +
    `left || exit 0; kill -${String(signum)} $l 2>/dev/null; ` +
    'for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.1; left || exit 0; done; ' +
    'kill -KILL $l 2>/dev/null; true'
  )
}
