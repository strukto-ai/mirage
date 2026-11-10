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

import { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { memoryBudget } from '../../../io/memory.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { vfsStatPath } from '../utils/paths.ts'

const ENC = new TextEncoder()

const USAGE =
  'Usage: getconf [-v specification] variable_name [pathname]\n' + '       getconf -a [pathname]\n'
const UNDEFINED = 'undefined'
const PAGE_SIZE = 4096

// The table `getconf -a` prints, in Mirage's order: POSIX.1-2024's
// tables first, then earlier standards, then Linux's names. null is
// undefined; a confstr() name that is set but empty is ''.
const GETCONF_VARIABLES: readonly (readonly [string, string | null])[] = [
  // The pathname variables, in the order of the fpathconf() table in
  // POSIX.1-2024, as Linux answers them for a filesystem it has no entry for:
  // the terminal and link limits from <linux/limits.h>, a 4096-byte page for
  // the transfer sizes, 32 FILESIZEBITS.
  ['FILESIZEBITS', '32'],
  ['LINK_MAX', '127'],
  ['MAX_CANON', '255'],
  ['MAX_INPUT', '255'],
  ['NAME_MAX', '255'],
  ['PATH_MAX', '4096'],
  ['PIPE_BUF', '4096'],
  ['POSIX2_SYMLINKS', '1'],
  ['POSIX_ALLOC_SIZE_MIN', '4096'],
  ['POSIX_REC_INCR_XFER_SIZE', null],
  ['POSIX_REC_MAX_XFER_SIZE', null],
  ['POSIX_REC_MIN_XFER_SIZE', '4096'],
  ['POSIX_REC_XFER_ALIGN', '4096'],
  ['SYMLINK_MAX', null],
  ['_POSIX_CHOWN_RESTRICTED', '1'],
  ['_POSIX_NO_TRUNC', '1'],
  ['_POSIX_VDISABLE', '0'],
  ['_POSIX_ASYNC_IO', null],
  ['_POSIX_PRIO_IO', null],
  ['_POSIX_SYNC_IO', null],
  // Local pathname names: the _POSIX_ name of a pathname limit answers
  // the limit itself, as the image's getconf does, not POSIX's minimum.
  ['_POSIX_LINK_MAX', '127'],
  ['_POSIX_MAX_CANON', '255'],
  ['_POSIX_MAX_INPUT', '255'],
  ['_POSIX_NAME_MAX', '255'],
  ['_POSIX_PATH_MAX', '4096'],
  ['_POSIX_PIPE_BUF', '4096'],
  ['SOCK_MAXBUF', null],
  // The sysconf() variables, in the order of its table in POSIX.1-2024,
  // for x86_64 Linux in a container: ARG_MAX is a quarter of the 8 MiB stack
  // limit, CLK_TCK is USER_HZ, OPEN_MAX the soft RLIMIT_NOFILE and CHILD_MAX
  // an unlimited RLIMIT_NPROC; the options carry POSIX.1-2008's 200809 and
  // the X/Open ones SUSv4's 700. One execution unit and no signal queue
  // limit, as host detail stays out.
  ['AIO_LISTIO_MAX', null],
  ['AIO_MAX', null],
  ['AIO_PRIO_DELTA_MAX', '20'],
  ['ARG_MAX', '2097152'],
  ['ATEXIT_MAX', '2147483647'],
  ['BC_BASE_MAX', '99'],
  ['BC_DIM_MAX', '2048'],
  ['BC_SCALE_MAX', '99'],
  ['BC_STRING_MAX', '1000'],
  ['CHILD_MAX', null],
  ['CLK_TCK', '100'],
  ['COLL_WEIGHTS_MAX', '255'],
  ['DELAYTIMER_MAX', '2147483647'],
  ['EXPR_NEST_MAX', '32'],
  ['HOST_NAME_MAX', '64'],
  ['IOV_MAX', '1024'],
  ['LINE_MAX', '2048'],
  ['LOGIN_NAME_MAX', '256'],
  ['NGROUPS_MAX', '65536'],
  ['MQ_OPEN_MAX', null],
  ['MQ_PRIO_MAX', '32768'],
  ['OPEN_MAX', '1048576'],
  ['PAGE_SIZE', '4096'],
  ['PAGESIZE', '4096'],
  ['PTHREAD_DESTRUCTOR_ITERATIONS', '4'],
  ['PTHREAD_KEYS_MAX', '1024'],
  ['PTHREAD_STACK_MIN', '16384'],
  ['PTHREAD_THREADS_MAX', null],
  ['RE_DUP_MAX', '32767'],
  ['RTSIG_MAX', '32'],
  ['SEM_NSEMS_MAX', null],
  ['SEM_VALUE_MAX', '2147483647'],
  ['SIGQUEUE_MAX', null],
  ['STREAM_MAX', '16'],
  ['SYMLOOP_MAX', null],
  ['TIMER_MAX', null],
  ['TTY_NAME_MAX', '32'],
  ['TZNAME_MAX', null],
  ['_POSIX_ADVISORY_INFO', '200809'],
  ['_POSIX_BARRIERS', '200809'],
  ['_POSIX_ASYNCHRONOUS_IO', '200809'],
  ['_POSIX_CLOCK_SELECTION', '200809'],
  ['_POSIX_CPUTIME', '200809'],
  ['_POSIX_FSYNC', '200809'],
  ['_POSIX_IPV6', '200809'],
  ['_POSIX_JOB_CONTROL', '1'],
  ['_POSIX_MAPPED_FILES', '200809'],
  ['_POSIX_MEMLOCK', '200809'],
  ['_POSIX_MEMLOCK_RANGE', '200809'],
  ['_POSIX_MEMORY_PROTECTION', '200809'],
  ['_POSIX_MESSAGE_PASSING', '200809'],
  ['_POSIX_MONOTONIC_CLOCK', '200809'],
  ['_POSIX_PRIORITIZED_IO', '200809'],
  ['_POSIX_PRIORITY_SCHEDULING', '200809'],
  ['_POSIX_RAW_SOCKETS', '200809'],
  ['_POSIX_READER_WRITER_LOCKS', '200809'],
  ['_POSIX_REALTIME_SIGNALS', '200809'],
  ['_POSIX_REGEXP', '1'],
  ['_POSIX_SAVED_IDS', '1'],
  ['_POSIX_SEMAPHORES', '200809'],
  ['_POSIX_SHARED_MEMORY_OBJECTS', '200809'],
  ['_POSIX_SHELL', '1'],
  ['_POSIX_SPAWN', '200809'],
  ['_POSIX_SPIN_LOCKS', '200809'],
  ['_POSIX_SPORADIC_SERVER', null],
  ['_POSIX_SYNCHRONIZED_IO', '200809'],
  ['_POSIX_THREAD_ATTR_STACKADDR', '200809'],
  ['_POSIX_THREAD_ATTR_STACKSIZE', '200809'],
  ['_POSIX_THREAD_CPUTIME', '200809'],
  ['_POSIX_THREAD_PRIO_INHERIT', '200809'],
  ['_POSIX_THREAD_PRIO_PROTECT', '200809'],
  ['_POSIX_THREAD_PRIORITY_SCHEDULING', '200809'],
  ['_POSIX_THREAD_PROCESS_SHARED', '200809'],
  ['_POSIX_THREAD_ROBUST_PRIO_INHERIT', null],
  ['_POSIX_THREAD_ROBUST_PRIO_PROTECT', null],
  ['_POSIX_THREAD_SAFE_FUNCTIONS', '200809'],
  ['_POSIX_THREAD_SPORADIC_SERVER', null],
  ['_POSIX_THREADS', '200809'],
  ['_POSIX_TIMEOUTS', '200809'],
  ['_POSIX_TIMERS', '200809'],
  ['_POSIX_TYPED_MEMORY_OBJECTS', null],
  ['_POSIX_VERSION', '200809'],
  ['_POSIX_V7_ILP32_OFF32', null],
  ['_POSIX_V7_ILP32_OFFBIG', null],
  ['_POSIX_V7_LP64_OFF64', '1'],
  ['_POSIX_V7_LPBIG_OFFBIG', null],
  ['_XOPEN_CRYPT', null],
  ['_XOPEN_ENH_I18N', '1'],
  ['_XOPEN_REALTIME', '1'],
  ['_XOPEN_REALTIME_THREADS', '1'],
  ['_XOPEN_SHM', '1'],
  ['_XOPEN_UNIX', '1'],
  ['_XOPEN_VERSION', '700'],
  ['NPROCESSORS_CONF', '1'],
  ['NPROCESSORS_ONLN', '1'],
  // The names POSIX.1-2024's getconf keeps for compatibility, each equal
  // to the same name with a leading underscore.
  ['POSIX2_C_BIND', '200809'],
  ['POSIX2_C_DEV', '200809'],
  ['POSIX2_CHAR_TERM', '200809'],
  ['POSIX2_FORT_RUN', null],
  ['POSIX2_LOCALEDEF', '200809'],
  ['POSIX2_SW_DEV', '200809'],
  ['POSIX2_UPE', null],
  ['POSIX2_VERSION', '200809'],
  ['POSIX2_BC_BASE_MAX', '99'],
  ['POSIX2_BC_DIM_MAX', '2048'],
  ['POSIX2_BC_SCALE_MAX', '99'],
  ['POSIX2_BC_STRING_MAX', '1000'],
  ['POSIX2_COLL_WEIGHTS_MAX', '255'],
  ['POSIX2_EXPR_NEST_MAX', '32'],
  ['POSIX2_LINE_MAX', '2048'],
  ['POSIX2_RE_DUP_MAX', '32767'],
  // The confstr() names, in the order of its table in POSIX.1-2024, for
  // LP64 x86_64, whose one native environment is LP64_OFF64.
  ['PATH', '/bin:/usr/bin'],
  ['POSIX_V7_ILP32_OFF32_CFLAGS', ''],
  ['POSIX_V7_ILP32_OFF32_LDFLAGS', ''],
  ['POSIX_V7_ILP32_OFF32_LIBS', ''],
  ['POSIX_V7_ILP32_OFFBIG_CFLAGS', ''],
  ['POSIX_V7_ILP32_OFFBIG_LDFLAGS', ''],
  ['POSIX_V7_ILP32_OFFBIG_LIBS', ''],
  ['POSIX_V7_LP64_OFF64_CFLAGS', '-m64'],
  ['POSIX_V7_LP64_OFF64_LDFLAGS', '-m64'],
  ['POSIX_V7_LP64_OFF64_LIBS', ''],
  ['POSIX_V7_LPBIG_OFFBIG_CFLAGS', ''],
  ['POSIX_V7_LPBIG_OFFBIG_LDFLAGS', ''],
  ['POSIX_V7_LPBIG_OFFBIG_LIBS', ''],
  ['POSIX_V7_WIDTH_RESTRICTED_ENVS', 'POSIX_V7_LP64_OFF64'],
  // <limits.h>: Runtime Increasable, Minimum, Numerical and Other
  // Invariant Values, for LP64 x86_64 (char is signed). A _POSIX_ minimum
  // answers the runtime value, but _POSIX_SSIZE_MAX answers POSIX's 32767,
  // and SSIZE_MAX answers that minimum too, as the image's getconf does.
  ['CHARCLASS_NAME_MAX', '2048'],
  ['_POSIX_ARG_MAX', '2097152'],
  ['_POSIX_CHILD_MAX', null],
  ['_POSIX_NGROUPS_MAX', '65536'],
  ['_POSIX_OPEN_MAX', '1048576'],
  ['_POSIX_SSIZE_MAX', '32767'],
  ['_POSIX_STREAM_MAX', '16'],
  ['_POSIX_TZNAME_MAX', null],
  ['_POSIX2_LINE_MAX', '2048'],
  ['CHAR_BIT', '8'],
  ['CHAR_MAX', '127'],
  ['CHAR_MIN', '-128'],
  ['INT_MAX', '2147483647'],
  ['INT_MIN', '-2147483648'],
  ['LONG_BIT', '64'],
  ['MB_LEN_MAX', '16'],
  ['SCHAR_MAX', '127'],
  ['SCHAR_MIN', '-128'],
  ['SHRT_MAX', '32767'],
  ['SHRT_MIN', '-32768'],
  ['SSIZE_MAX', '32767'],
  ['UCHAR_MAX', '255'],
  ['UINT_MAX', '4294967295'],
  ['ULONG_MAX', '18446744073709551615'],
  ['USHRT_MAX', '65535'],
  ['WORD_BIT', '32'],
  ['NL_ARGMAX', '4096'],
  ['NL_LANGMAX', '2048'],
  ['NL_MSGMAX', '2147483647'],
  ['NL_SETMAX', '2147483647'],
  ['NL_TEXTMAX', '2147483647'],
  ['NZERO', '20'],
  // Names from earlier standards Linux still answers: Issue 6's
  // compilation environments and LINTFLAGS, SUSv2's XBS5 environments, the
  // Large File Summit's flags, Issue 6's batch and trace options, XPG's
  // version names and IEEE 1003.1g's and 1003.13's options.
  ['POSIX_V7_ILP32_OFF32_LINTFLAGS', ''],
  ['POSIX_V7_ILP32_OFFBIG_LINTFLAGS', ''],
  ['POSIX_V7_LP64_OFF64_LINTFLAGS', ''],
  ['POSIX_V7_LPBIG_OFFBIG_LINTFLAGS', ''],
  ['_POSIX_V7_WIDTH_RESTRICTED_ENVS', 'POSIX_V7_LP64_OFF64'],
  ['_POSIX_V6_ILP32_OFF32', null],
  ['_POSIX_V6_ILP32_OFFBIG', null],
  ['_POSIX_V6_LP64_OFF64', '1'],
  ['_POSIX_V6_LPBIG_OFFBIG', null],
  ['POSIX_V6_ILP32_OFF32_CFLAGS', ''],
  ['POSIX_V6_ILP32_OFF32_LDFLAGS', ''],
  ['POSIX_V6_ILP32_OFF32_LIBS', ''],
  ['POSIX_V6_ILP32_OFF32_LINTFLAGS', ''],
  ['POSIX_V6_ILP32_OFFBIG_CFLAGS', ''],
  ['POSIX_V6_ILP32_OFFBIG_LDFLAGS', ''],
  ['POSIX_V6_ILP32_OFFBIG_LIBS', ''],
  ['POSIX_V6_ILP32_OFFBIG_LINTFLAGS', ''],
  ['POSIX_V6_LP64_OFF64_CFLAGS', '-m64'],
  ['POSIX_V6_LP64_OFF64_LDFLAGS', '-m64'],
  ['POSIX_V6_LP64_OFF64_LIBS', ''],
  ['POSIX_V6_LP64_OFF64_LINTFLAGS', ''],
  ['POSIX_V6_LPBIG_OFFBIG_CFLAGS', ''],
  ['POSIX_V6_LPBIG_OFFBIG_LDFLAGS', ''],
  ['POSIX_V6_LPBIG_OFFBIG_LIBS', ''],
  ['POSIX_V6_LPBIG_OFFBIG_LINTFLAGS', ''],
  ['_POSIX_V6_WIDTH_RESTRICTED_ENVS', 'POSIX_V6_LP64_OFF64'],
  ['POSIX_V6_WIDTH_RESTRICTED_ENVS', 'POSIX_V6_LP64_OFF64'],
  ['_XBS5_ILP32_OFF32', null],
  ['_XBS5_ILP32_OFFBIG', null],
  ['_XBS5_LP64_OFF64', '1'],
  ['_XBS5_LPBIG_OFFBIG', null],
  ['XBS5_ILP32_OFF32_CFLAGS', ''],
  ['XBS5_ILP32_OFF32_LDFLAGS', ''],
  ['XBS5_ILP32_OFF32_LIBS', ''],
  ['XBS5_ILP32_OFF32_LINTFLAGS', ''],
  ['XBS5_ILP32_OFFBIG_CFLAGS', ''],
  ['XBS5_ILP32_OFFBIG_LDFLAGS', ''],
  ['XBS5_ILP32_OFFBIG_LIBS', ''],
  ['XBS5_ILP32_OFFBIG_LINTFLAGS', ''],
  ['XBS5_LP64_OFF64_CFLAGS', '-m64'],
  ['XBS5_LP64_OFF64_LDFLAGS', '-m64'],
  ['XBS5_LP64_OFF64_LIBS', ''],
  ['XBS5_LP64_OFF64_LINTFLAGS', ''],
  ['XBS5_LPBIG_OFFBIG_CFLAGS', ''],
  ['XBS5_LPBIG_OFFBIG_LDFLAGS', ''],
  ['XBS5_LPBIG_OFFBIG_LIBS', ''],
  ['XBS5_LPBIG_OFFBIG_LINTFLAGS', ''],
  ['_XBS5_WIDTH_RESTRICTED_ENVS', 'XBS5_LP64_OFF64'],
  ['XBS5_WIDTH_RESTRICTED_ENVS', 'XBS5_LP64_OFF64'],
  ['LFS_CFLAGS', ''],
  ['LFS_LDFLAGS', ''],
  ['LFS_LIBS', ''],
  ['LFS_LINTFLAGS', ''],
  ['LFS64_CFLAGS', '-D_LARGEFILE64_SOURCE'],
  ['LFS64_LDFLAGS', ''],
  ['LFS64_LIBS', ''],
  ['LFS64_LINTFLAGS', '-D_LARGEFILE64_SOURCE'],
  ['POSIX2_C_VERSION', '200809'],
  ['POSIX2_FORT_DEV', null],
  ['POSIX2_PBS', null],
  ['POSIX2_PBS_ACCOUNTING', null],
  ['POSIX2_PBS_LOCATE', null],
  ['POSIX2_PBS_MESSAGE', null],
  ['POSIX2_PBS_TRACK', null],
  ['_POSIX_TRACE', null],
  ['_POSIX_TRACE_EVENT_FILTER', null],
  ['_POSIX_TRACE_INHERIT', null],
  ['_POSIX_TRACE_LOG', null],
  ['_XOPEN_LEGACY', '1'],
  ['_XOPEN_XCU_VERSION', '4'],
  ['_XOPEN_XPG2', '1'],
  ['_XOPEN_XPG3', '1'],
  ['_XOPEN_XPG4', '1'],
  ['NL_NMAX', '2147483647'],
  ['EQUIV_CLASS_MAX', null],
  ['_T_IOV_MAX', null],
  ['_POSIX_PII', null],
  ['_POSIX_PII_INTERNET', null],
  ['_POSIX_PII_INTERNET_DGRAM', null],
  ['_POSIX_PII_INTERNET_STREAM', null],
  ['_POSIX_PII_OSI', null],
  ['_POSIX_PII_OSI_CLTS', null],
  ['_POSIX_PII_OSI_COTS', null],
  ['_POSIX_PII_OSI_M', null],
  ['_POSIX_PII_SOCKET', null],
  ['_POSIX_PII_XTI', null],
  ['_POSIX_POLL', null],
  ['_POSIX_SELECT', null],
  ['_POSIX_BASE', null],
  ['_POSIX_C_LANG_SUPPORT', null],
  ['_POSIX_C_LANG_SUPPORT_R', null],
  ['_POSIX_DEVICE_IO', null],
  ['_POSIX_DEVICE_SPECIFIC', null],
  ['_POSIX_DEVICE_SPECIFIC_R', null],
  ['_POSIX_FD_MGMT', null],
  ['_POSIX_FIFO', null],
  ['_POSIX_FILE_ATTRIBUTES', null],
  ['_POSIX_FILE_LOCKING', null],
  ['_POSIX_FILE_SYSTEM', null],
  ['_POSIX_MULTI_PROCESS', null],
  ['_POSIX_NETWORKING', null],
  ['_POSIX_PIPE', null],
  ['_POSIX_SIGNALS', null],
  ['_POSIX_SINGLE_PROCESS', null],
  ['_POSIX_SYSTEM_DATABASE', null],
  ['_POSIX_SYSTEM_DATABASE_R', null],
  ['_POSIX_USER_GROUPS', null],
  ['_POSIX_USER_GROUPS_R', null],
  ['_REGEX_VERSION', null],
  // Linux's own names (sysconf(3) and confstr(3) in the man-pages), and
  // the C library version the image reports. Host detail stays out, as
  // uname's does: no memory or cache figures.
  ['_NPROCESSORS_CONF', '1'],
  ['_NPROCESSORS_ONLN', '1'],
  ['_PHYS_PAGES', null],
  ['_AVPHYS_PAGES', null],
  ['LEVEL1_ICACHE_SIZE', null],
  ['LEVEL1_ICACHE_ASSOC', null],
  ['LEVEL1_ICACHE_LINESIZE', null],
  ['LEVEL1_DCACHE_SIZE', null],
  ['LEVEL1_DCACHE_ASSOC', null],
  ['LEVEL1_DCACHE_LINESIZE', null],
  ['LEVEL2_CACHE_SIZE', null],
  ['LEVEL2_CACHE_ASSOC', null],
  ['LEVEL2_CACHE_LINESIZE', null],
  ['LEVEL3_CACHE_SIZE', null],
  ['LEVEL3_CACHE_ASSOC', null],
  ['LEVEL3_CACHE_LINESIZE', null],
  ['LEVEL4_CACHE_SIZE', null],
  ['LEVEL4_CACHE_ASSOC', null],
  ['LEVEL4_CACHE_LINESIZE', null],
  ['IPV6', '200809'],
  ['RAW_SOCKETS', '200809'],
  ['CS_PATH', '/bin:/usr/bin'],
  ['GNU_LIBC_VERSION', 'glibc 2.41'],
  ['GNU_LIBPTHREAD_VERSION', 'NPTL 2.41'],
  ['LOGNAME_MAX', '256'],
  ['PASS_MAX', '8192'],
  ['NSS_BUFLEN_GROUP', '1024'],
  ['NSS_BUFLEN_PASSWD', '1024'],
  ['UIO_MAXIOV', '1024'],
]

// The variables pathconf answers, which want a PATH operand.
const PATH_VARIABLES: ReadonlySet<string> = new Set([
  'FILESIZEBITS',
  'LINK_MAX',
  'MAX_CANON',
  'MAX_INPUT',
  'NAME_MAX',
  'PATH_MAX',
  'PIPE_BUF',
  'POSIX2_SYMLINKS',
  'POSIX_ALLOC_SIZE_MIN',
  'POSIX_REC_INCR_XFER_SIZE',
  'POSIX_REC_MAX_XFER_SIZE',
  'POSIX_REC_MIN_XFER_SIZE',
  'POSIX_REC_XFER_ALIGN',
  'SYMLINK_MAX',
  '_POSIX_CHOWN_RESTRICTED',
  '_POSIX_NO_TRUNC',
  '_POSIX_VDISABLE',
  '_POSIX_ASYNC_IO',
  '_POSIX_PRIO_IO',
  '_POSIX_SYNC_IO',
  '_POSIX_LINK_MAX',
  '_POSIX_MAX_CANON',
  '_POSIX_MAX_INPUT',
  '_POSIX_NAME_MAX',
  '_POSIX_PATH_MAX',
  '_POSIX_PIPE_BUF',
  'SOCK_MAXBUF',
])

/**
 * The table row a name selects: its own, or else the `_POSIX_` one it
 * abbreviates (`getconf VERSION` is `_POSIX_VERSION`). Where a name has both,
 * the two answer alike.
 */
function variable(name: string): readonly [string, string | null] | undefined {
  return (
    GETCONF_VARIABLES.find(([row]) => row === name) ??
    GETCONF_VARIABLES.find(([row]) => row.startsWith('_POSIX_') && row.slice(7) === name)
  )
}

/**
 * A variable's answer: the memory ones are the workspace's `max_memory` and
 * what it has left, in pages, and undefined with no cap; the rest are the
 * table's.
 */
function liveValue(name: string, value: string | null): string | null {
  const budget = memoryBudget()
  if (budget === null || (name !== '_PHYS_PAGES' && name !== '_AVPHYS_PAGES')) return value
  const size = name === '_PHYS_PAGES' ? budget.limit : budget.room()
  return String(Math.floor(size / PAGE_SIZE))
}

/** Whether the PATH operand names something pathconf could open. */
async function pathExists(ctx: Context, word: string): Promise<boolean> {
  const statPath = vfsStatPath(ctx.vfs)
  if (statPath === undefined) return true
  return (await statPath(PathSpec.fromStrPath(word, undefined, ctx.cwd))) !== null
}

// `getconf`: one variable's value, or `-a` for all of them. A pathconf
// variable takes exactly one PATH and the rest none (else the usage block, exit
// 2); an unknown name is exit 2, a missing PATH exit 3, and `-v` is set aside
// as Debian's build does.
async function getconf(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('getconf'))
  const usage: CommandFnResult = [null, new IOResult({ exitCode: 2, stderr: ENC.encode(USAGE) })]
  if (fl.asBool('a')) {
    if (texts.length > 1) return usage
    const found = await pathExists(ctx, texts[0] ?? '/')
    const lines = GETCONF_VARIABLES.map(
      ([name, value]) =>
        name.padEnd(35) +
        (found || !PATH_VARIABLES.has(name) ? (liveValue(name, value) ?? '') : '') +
        '\n',
    )
    return [ENC.encode(lines.join('')), new IOResult()]
  }
  const asked = texts[0]
  if (asked === undefined || texts.length > 2) return usage
  const row = variable(asked)
  if (row === undefined) {
    const err = `getconf: Unrecognized variable \`${asked}'\n`
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(err) })]
  }
  const [name] = row
  const value = liveValue(...row)
  const path = texts[1]
  if (PATH_VARIABLES.has(name) !== (path !== undefined)) return usage
  if (path !== undefined && !(await pathExists(ctx, path))) {
    const err = `getconf: pathconf: ${path}: No such file or directory\n`
    return [null, new IOResult({ exitCode: 3, stderr: ENC.encode(err) })]
  }
  return [ENC.encode(`${value ?? UNDEFINED}\n`), new IOResult()]
}

export const GENERAL_GETCONF = command({
  name: 'getconf',
  vfs: null,
  spec: specOf('getconf'),
  fn: getconf,
})
