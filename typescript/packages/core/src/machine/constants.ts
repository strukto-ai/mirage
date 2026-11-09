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

import { singleQuote } from '../utils/quote.ts'
import { decodeBase64 } from '../utils/base64.ts'
import { boundSystemClock, systemNow } from '../utils/clock.ts'
import type { ProcessHandle } from '../execution/process/handle.ts'
import type { MachinePid } from '../execution/types.ts'
import type { MountType } from './types.ts'

const ENC = new TextEncoder()

/**
 * Why a machine cannot take a line, named by the state its status command
 * reported. `hints` holds the provider's advice per state, with `{name}`
 * standing for `name`; `otherwise` is the advice for a state it lacks.
 * Mirrors Python's `not_running_hint`.
 */
export function notRunningHint(
  noun: string,
  name: string,
  state: string,
  hints: Readonly<Record<string, string>>,
  otherwise: string | null = null,
): string {
  const detail = Object.hasOwn(hints, state) ? hints[state] : undefined
  if (detail !== undefined)
    return `${noun} ${name} is not running: ${detail.replaceAll('{name}', name)}`
  const said = `${noun} ${name} is not running (state: ${state})`
  return otherwise === null ? said : `${said}; ${otherwise}`
}

/**
 * The signal a `kill` stopped `runner` with, or an interrupt stops the
 * program it runs with (`ProcessHandle.interrupted`), when a program may
 * handle it: null for KILL, or for a run nothing stopped, which is killed
 * at once. Mirrors Python's `stop_signal`.
 */
export function stopSignal(runner: ProcessHandle | null): number | null {
  const signal = runner?.signal ?? runner?.interrupted ?? null
  return signal === null || signal === 9 ? null : signal
}

export const MOUNT_TYPES: readonly MountType[] = ['ssh', 'fuse', 'both']

// How long a machine has to show a served prefix as mounted, and how
// often it is asked.
export const MOUNT_WAIT_SECONDS = 15
export const MOUNT_POLL_SECONDS = 0.1

// How long a served prefix's SFTP server may take to end once its
// machine side is unmounted.
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

// Where sshfs writes its errors in the machine, one file per prefix; its
// stdout is the SFTP stream, so its stderr cannot share the pipe.
export const SSHFS_LOG_PREFIX = '/tmp/.mirage_sshfs'

// How an sshfs source names the mirage serving it: `mirage-<id>:<prefix>`,
// so each instance knows its own mounts from another's on the same machine.
export const SSHFS_SOURCE_PREFIX = 'mirage-'

export const SSHFS_HINT =
  'serving the workspace into a machine needs sshfs there; install it in the image (apt-get install sshfs)'
export const PIPE_SERVER_HINT =
  'serving the workspace into a machine needs @struktoai/mirage-node and its ssh2 peer'

/**
 * Every argv a machine runs goes under this POSIX sh prelude, with the
 * cwd as $1: a provider program's exec passes `-w /` (`execArgs`), and a
 * provider whose exec takes one command line dresses it (`wrapLine`), so
 * no provider's own cwd is used. An exec's `-e` can append to the image's
 * environment rather than replace a name it already sets, `-w` can
 * create a missing directory, and an SDK's cwd fails a missing one its
 * own way (E2B: exit 1). sh imports the environment last-wins, `cd`
 * fails loud (126) on a cwd the machine does not serve, and `exec` hands
 * over the argv unchanged. `cd` runs without CDPATH, so a relative cwd
 * resolves from `/` and prints nothing, while the program still sees the
 * guest's own CDPATH. The shell is named by path, /bin/sh, since the
 * command's PATH is the session's and may hold no sh; the argv after the
 * prelude is still found on it.
 */
export const EXEC_PRELUDE = 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"'

/**
 * A line in a machine holding mounts runs under this guard, inside its own
 * exec, so it checks the boot the program runs in: a machine that restarted
 * after the line was admitted has lost its mounts, and a program run over
 * the bare directories would write to the machine's own disk. `$1` is the
 * mount table, then four words per mount (mountpoint and source as the
 * table escapes them, type, the message), then `--` and the argv. Each
 * mount must be the top entry at its mountpoint, or the guard prints its
 * message and exits 126 with nothing run. The check runs in a subshell, so
 * its names never reach the program's environment, and needs only sh's
 * builtins, so a PATH with no tools still runs it.
 */
export const MOUNT_GUARD =
  '( t=$1; shift; ' +
  `[ -r "$t" ] || { printf '%s\\n' "$4" >&2; exit 126; }; ` +
  'while [ "$1" != -- ]; do f=; ' +
  'while read -r s m k o; do [ "$m" = "$1" ] || continue; ' +
  'f=; [ "$s" = "$2" ] && [ "$k" = "$3" ] && f=1; ' +
  'done < "$t"; ' +
  `[ -n "$f" ] || { printf '%s\\n' "$4" >&2; exit 126; }; ` +
  'shift 4; done ) || exit 126; ' +
  'shift; while [ "$1" != -- ]; do shift 4; done; shift; exec "$@"'

/**
 * `text` as `/proc/mounts` writes it in a field: space, tab, newline and
 * backslash as octal escapes, and in a source `#` too.
 */
export function mountField(text: string, source = false): string {
  return text.replace(
    source ? /[ \t\n\\#]/g : /[ \t\n\\]/g,
    (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`,
  )
}

/**
 * Every process a run starts in a machine carries this variable, set to the
 * id of the Mirage process the run is (`w1:9`), so a run cancelled midway,
 * or one a lapsed workspace left, can be stopped in the box: stopping the
 * client that started it does not reach the box everywhere (`docker exec`
 * has no kill, and the daemon keeps draining the program's output, so a
 * `yes` cut short by `head` would spin on). The id rides the environment
 * because every process of a pipeline inherits it.
 */
export const PROCESS = 'MIRAGE_PROCESS'

// How long stopping a cancelled run may hold the cancel: the stop line's
// own second of grace, plus the exec's round trips. A box that stopped
// answering is given up on after it.
export const MACHINE_STOP_WAIT_SECONDS = 5

// What the check line prints first: a result without it is a line no shell
// there ran (a stopped container's exec answers with a status of its own),
// which says nothing of the machine's tools.
export const CHECK_MARK = 'mirage-check'

// The line a check runs: true where Mirage can see and stop every process a
// program on the machine starts, by its `PROCESS` tag, which takes `/proc`
// and the `tr` and `grep` the scan and the stop line run.
export const CHECK_LINE = `echo ${CHECK_MARK}; test -d /proc/self && command -v tr && command -v grep`

// How long a check may take: a machine that does not answer in it is
// unreachable.
export const CHECK_WAIT_SECONDS = 10

// How long a program a `kill` signalled may take to exit before it gets
// KILL, for its handlers to clean up: the stop line's same second.
export const STOP_GRACE_SECONDS = 1

// How far a host process's start, as `ps` prints it to the second, may be
// from when a run recorded starting it and still be that run's: past it the
// PID names another process, which a stop leaves alone.
export const HOST_START_SLACK_SECONDS = 2

// The state letters `ps` prints on a host that has others than Linux's: an
// idle process is a sleeping one, and macOS's U is Linux's D. Mirrors
// Python's `HOST_STATES`.
export const HOST_STATES: Readonly<Record<string, string>> = Object.freeze({ I: 'S', U: 'D' })

// How often a stop in its grace checks whether the signalled group ended.
export const STOP_POLL_SECONDS = 0.02

// Where the stop line finds tr, grep and sleep: the config's PATH is for
// the programs it runs and may name none of the system's directories.
export const TOOLS_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// Output as base64 lines per read, status on fd 3, for an exec that returns text.
// How often something waiting for a run looks for its end on the machine,
// and how long a run's output gets to arrive once its program has exited
// while what the program left running keeps the exec open.
export const RUN_WATCH_SECONDS = 2
export const RUN_DRAIN_SECONDS = 0.5

// How long a background run may take to report its pid, which `$!` waits for.
export const RUN_START_WAIT_SECONDS = 10

// Where a run reports on its machine, then the workspace and the process.
export const RUN_STATUS_PREFIX = '/tmp/.mirage-run-'

// Every program runs as a child of this wrapper, which outlives it to say
// how it ended, since an exec holds on while anything the program started
// keeps its output open (E2B, msb). `$1` is the file it reports in, which it
// creates only if nothing is there; `$2` the tag's assignment, exported for
// the program alone so the wrapper shows in no scan and takes no signal by
// tag; `$3` the reports of earlier runs to remove; then the program. The
// subshell execs it, so the pid written first is the program's, with its
// start in clock ticks; its exit status follows on the next line. A shell
// reports a child a signal ended on its stderr, so the wrapper's goes nowhere
// and the program gets the real one back. It needs only a POSIX shell at
// `/bin/sh`. Mirrors Python's `RUN_WRAPPER`.
export const RUN_WRAPPER =
  'f=$1; t=$2; o=$3; shift 3; ' +
  `[ -z "$o" ] || PATH=${TOOLS_PATH} rm -f $o 2>/dev/null; ` +
  'exec 6>&2 2>/dev/null; ' +
  'set -C; if >"$f"; then g=$f; else g=/dev/null; fi; set +C; ' +
  "( /bin/sh -c 'read -r s </proc/$PPID/stat; set -- ${s##*)}; " +
  'echo "$PPID ${20}"\' >>"$g"; ' +
  'export "$t"; exec 2>&6 6>&-; exec "$@" ); ' +
  's=$?; echo "$s" >>"$g"; exit "$s"'

export const ENCODE_PRELUDE =
  `e() { PATH=${TOOLS_PATH}; ` +
  'while c=$(dd bs=65536 count=1 2>/dev/null | base64) && [ -n "$c" ]; ' +
  `do printf '%s\\n' "$c"; done; }; ` +
  `(PATH=${TOOLS_PATH}; command -v dd && command -v base64) >/dev/null || ` +
  "{ echo 'mirage: the machine needs dd and base64 to return output' >&2; " +
  'exit 127; }; '
export const ENCODE_OUTPUT =
  ENCODE_PRELUDE +
  'exec 4>&1 5>&2; s=$( { { { "$@" 3>&- 4>&- 5>&-; echo $? >&3; } ' +
  '| e >&4; } 2>&1 | e >&5; } 3>&1 ); exit "$s"'
// For an exec that returns one combined stream: stderr joins stdout first.
export const ENCODE_COMBINED =
  ENCODE_PRELUDE +
  'exec 4>&1; s=$( { { "$@" 2>&1 3>&- 4>&-; echo $? >&3; } ' +
  '| e >&4; } 3>&1 ); exit "$s"'

export const BASE64_LINE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * `line` run so its output comes back as base64 lines, which an exec that
 * decodes output as text leaves intact (`ENCODE_OUTPUT`).
 *
 * @param line the command, as `wrapLine` builds it.
 * @param combined encode stderr with stdout as one stream, for an exec
 *   that returns them combined.
 */
export function encodeOutput(line: string, combined = false): string {
  const script = combined ? ENCODE_COMBINED : ENCODE_OUTPUT
  return `/bin/sh -c ${singleQuote(script)} sh ${line}`
}

/**
 * The bytes an `encodeOutput` command wrote, from whole lines of its
 * output. A blank line adds nothing; a line that is not base64, which only
 * the machine's own shell writes (the encoder missing), comes back as it
 * is, with its newline.
 *
 * @param text whole lines of the command's output.
 */
export function decodeOutput(text: string): Uint8Array {
  let out = new Uint8Array(text.length)
  let at = 0
  for (const line of text.split('\n')) {
    const word = line.trim()
    const bytes = BASE64_LINE.test(word) ? decodeBase64(word) : ENC.encode(`${line}\n`)
    if (at + bytes.byteLength > out.byteLength) {
      const grown = new Uint8Array(2 * (at + bytes.byteLength))
      grown.set(out.subarray(0, at))
      out = grown
    }
    out.set(bytes, at)
    at += bytes.byteLength
  }
  return out.slice(0, at)
}

/**
 * The command line for a machine whose exec takes one (ssh, e2b,
 * daytona): cwd, env, then the argv.
 *
 * Such an exec has no docker-style `-w`/`-e` to trust: SSH's env channel
 * is AcceptEnv-gated server-side, so it silently drops names, and an
 * SDK's own cwd fails a missing directory in its own words. So the
 * working directory and the merged environment ride the command itself:
 * the prelude every machine runs a command under enters `cwd` (exit 126
 * when the machine lacks it), then `env 'K=V' ... 'prog' 'arg'`; a shell
 * line is the argv `/bin/sh -c line`. Every piece is single-quoted for sh,
 * so the shell the exec starts reads each as one word whatever it holds;
 * the machine only needs a POSIX shell at `/bin/sh`.
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

// What the stop line exits with when no process carries the run's id: the
// box it ran in holds nothing of the run.
export const NOT_RUNNING_STATUS = 3

/**
 * The shell line that stops every process of the run `process` tags.
 *
 * Each process whose environment holds the tag, found through `/proc`,
 * gets `signum`, and what still runs a second later gets KILL, so a
 * program that ignores it stops too. The tag is matched as a whole entry,
 * so `w1:9` never stops the run of `w1:90`. The line exits 0 once it
 * stopped them and `NOT_RUNNING_STATUS` when there were none. It looks tr and
 * grep up on its own PATH (`TOOLS_PATH`) and exits 127 without them, so it
 * needs only a POSIX shell, tr, grep and `/proc`.
 *
 * @param process the id of the Mirage process the run is, as `PROCESS`
 *   carries it.
 * @param signum the first signal, TERM (15) unless a `kill` named another.
 */
export function stopLine(process: string, signum = 15): string {
  const mark = singleQuote(`${PROCESS}=${process}`)
  return (
    `PATH=${TOOLS_PATH}; command -v tr >/dev/null || exit 127; ` +
    'command -v grep >/dev/null || exit 127; ' +
    `m=${mark}; ` +
    'left() { l=; for p in /proc/[0-9]*; do ' +
    'tr \'\\000\' \'\\n\' < "$p/environ" 2>/dev/null | grep -qxF "$m" ' +
    '&& l="$l ${p#/proc/}"; done; ' +
    '[ -n "$l" ]; }; ' +
    `left || exit ${String(NOT_RUNNING_STATUS)}; kill -${String(signum)} $l 2>/dev/null; ` +
    'for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.1; left || exit 0; done; ' +
    'kill -KILL $l 2>/dev/null; true'
  )
}

// How long a scan may take: a machine that does not answer in it shows the
// processes the last scan found.
export const SCAN_WAIT_SECONDS = 10

// What each row a scan prints starts with, so a provider that mixes the
// line's stderr into its stdout (Daytona) never passes a message for one: a
// process, or a run's report.
export const SCAN_MARK = 'M'
export const SCAN_RUN_MARK = 'R'

/** `text` as part of a report's file name, which a scan's glob and an unquoted `rm` both read as one word. */
function reportName(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/**
 * The file the run `tag` names reports in on its machine. Mirrors Python's
 * `run_status_path`.
 *
 * @param tag the run's tag, `<workspace>:<process>`.
 */
export function runStatusPath(tag: string): string {
  const at = tag.lastIndexOf(':')
  const name = at > 0 ? `${reportName(tag.slice(0, at))}-${tag.slice(at + 1)}` : reportName(tag)
  return `${RUN_STATUS_PREFIX}${name}`
}

/**
 * `argv` under the wrapper every program runs in (`RUN_WRAPPER`). Mirrors
 * Python's `run_argv`.
 *
 * @param tag the run's tag.
 * @param status the file it reports in (`runStatusPath`).
 * @param spent the reports of runs that have ended.
 * @param argv the program and its arguments.
 */
export function runArgv(
  tag: string,
  status: string,
  spent: readonly string[],
  argv: readonly string[],
): string[] {
  return ['/bin/sh', '-c', RUN_WRAPPER, 'sh', status, `${PROCESS}=${tag}`, spent.join(' '), ...argv]
}

/**
 * Whether `argv` is a program's run, which a stop by its tag ends, not one
 * of Mirage's own lines (`runArgv`). Mirrors Python's `is_run`.
 */
export function isRun(argv: readonly string[]): boolean {
  return argv.length > 2 && argv[2] === RUN_WRAPPER
}

/** The tag a program's run carries (`runArgv`). Mirrors Python's `run_tag`. */
export function runTag(argv: readonly string[]): string {
  return (argv[5] ?? '').slice(PROCESS.length + 1)
}

/** The shell line that prints one run's report, nothing while there is none. */
export function statusLine(status: string): string {
  return `PATH=${TOOLS_PATH}; cat ${singleQuote(status)} 2>/dev/null; true`
}

/** The shell line that removes the reports of runs that have ended. */
export function removeLine(spent: readonly string[]): string {
  return `PATH=${TOOLS_PATH}; rm -f ${spent.join(' ')}`
}

/**
 * The shell line that lists every process the runs of `workspace` started
 * on a machine. Each process whose `PROCESS` tag names one of the
 * workspace's processes, found through `/proc`, prints one row:
 * `SCAN_MARK`, the tag, its pid, its parent's pid, when it started in clock
 * ticks after boot (`stat`'s 22nd field), its state letter (`stat`'s third)
 * and its arguments, space separated. A process that exits mid-scan is
 * skipped. Each run's report prints one row as well: `SCAN_RUN_MARK`, the
 * process it is, then the report's first line and its second after a `;`.
 * Nothing else is printed. It needs what `stopLine` does. Mirrors Python's
 * `scan_line`.
 *
 * @param workspace the workspace's id, which every tag starts with.
 */
export function scanLine(workspace: string): string {
  const mark = singleQuote(`${PROCESS}=${workspace}:`)
  const reports = `${RUN_STATUS_PREFIX}${reportName(workspace)}-`
  return (
    `PATH=${TOOLS_PATH}; m=${mark}; ` +
    `for f in ${reports}*; do ` +
    '[ -f "$f" ] || continue; a=; b=; ' +
    '{ read -r a; read -r b; } <"$f"; ' +
    `printf '${SCAN_RUN_MARK} %s %s;%s\\n' "\${f##*-}" "$a" "$b"; ` +
    'done; ' +
    'for p in /proc/[0-9]*; do ' +
    "t=$(tr '\\000' '\\n' 2>/dev/null < \"$p/environ\" " +
    `| grep -m1 '^${PROCESS}=') || continue; ` +
    'case $t in "$m"*) ;; *) continue ;; esac; ' +
    's=$(cat "$p/stat" 2>/dev/null) || continue; ' +
    'set -- ${s##*)}; ' +
    `printf '${SCAN_MARK} %s %s %s %s %s %s\\n' ` +
    `"\${t#${PROCESS}=}" "\${p#/proc/}" "$2" "\${20}" "$1" ` +
    '"$(tr \'\\000\\n\' \'  \' 2>/dev/null < "$p/cmdline")"; ' +
    'done; true'
  )
}

/**
 * The shell line that sends `signum` to one process on a machine, as `kill`
 * sent it. A tag names the program its run started: the process carrying
 * it whose parent carries none. A machine pid names its pid while that is
 * the process that started then. The line exits 0 once it sent the signal
 * and `NOT_RUNNING_STATUS` when no such process runs. Mirrors Python's
 * `signal_line`.
 *
 * @param target the run's tag, or the process.
 * @param signum the signal.
 */
export function signalLine(target: string | MachinePid, signum: number): string {
  const absent = String(NOT_RUNNING_STATUS)
  if (typeof target !== 'string') {
    const pid = String(target.pid)
    return (
      `PATH=${TOOLS_PATH}; ` +
      `s=$(cat /proc/${pid}/stat 2>/dev/null) || exit ${absent}; ` +
      'set -- ${s##*)}; ' +
      `[ "\${20}" = ${String(Math.trunc(target.started))} ] || exit ${absent}; ` +
      `kill -${String(signum)} ${pid} 2>/dev/null || exit ${absent}`
    )
  }
  const mark = singleQuote(`${PROCESS}=${target}`)
  return (
    `PATH=${TOOLS_PATH}; m=${mark}; l=' '; r=; ` +
    'for p in /proc/[0-9]*; do ' +
    "tr '\\000' '\\n' 2>/dev/null < \"$p/environ\" " +
    '| grep -qxF "$m" || continue; ' +
    's=$(cat "$p/stat" 2>/dev/null) || continue; set -- ${s##*)}; ' +
    'l="$l${p#/proc/} "; r="$r ${p#/proc/}:$2"; done; ' +
    'k=; for e in $r; do case $l in *" ${e#*:} "*) ;; ' +
    '*) k="$k ${e%%:*}" ;; esac; done; ' +
    `[ -n "$k" ] || exit ${absent}; kill -${String(signum)} $k 2>/dev/null; true`
  )
}

// How long a machine gets to answer the libfaketime probe, which every run
// waiting on it shares.
export const FAKETIME_PROBE_SECONDS = 30

// Where Linux distributions install libfaketime, which a process reads a
// workspace's system time through, on this host or in a machine.
export const FAKETIME_LIBRARIES = [
  '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1',
  '/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1',
  '/usr/lib64/faketime/libfaketime.so.1',
  '/usr/lib/faketime/libfaketime.so.1',
  '/usr/local/lib/faketime/libfaketime.so.1',
]

/**
 * What has a process read the running workspace's system time through the
 * libfaketime at `library`: the time now, in epoch seconds to the
 * millisecond, which its clock and its children's run on from, whatever
 * the machine's own clock or zone; the monotonic clock and file dates, which
 * the workspace already gives, left alone. `env`'s
 * `LD_PRELOAD` libraries load after it. Empty when the workspace keeps the
 * host's time. Mirrors Python's `faketime_env`.
 */
export function faketimeEnv(library: string, env: Record<string, string>): Record<string, string> {
  if (boundSystemClock() === null) return {}
  const preload = env.LD_PRELOAD
  return {
    LD_PRELOAD: preload === undefined || preload === '' ? library : `${library}:${preload}`,
    FAKETIME: `@${systemNow().toFixed(3)}`,
    FAKETIME_FMT: '%s',
    FAKETIME_DONT_RESET: '1',
    FAKETIME_DONT_FAKE_MONOTONIC: '1',
    NO_FAKE_STAT: '1',
  }
}

/**
 * A shell line that prints the first of `FAKETIME_LIBRARIES` a machine
 * holds, and nothing when it holds none. Mirrors Python's `faketime_probe`.
 */
export function faketimeProbe(): string {
  const paths = FAKETIME_LIBRARIES.map(singleQuote).join(' ')
  return `for p in ${paths}; do if [ -f "$p" ]; then echo "$p"; break; fi; done`
}
