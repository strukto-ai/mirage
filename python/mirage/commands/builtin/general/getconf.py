# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.accessor.base import Accessor
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.path import resolve_path

USAGE = (
    b"Usage: getconf [-v specification] variable_name [pathname]\n"
    b"       getconf -a [pathname]\n"
)
UNDEFINED = "undefined"

# glibc 2.41's table as `getconf -a /` prints it on debian:stable-slim
# (x86_64), None for undefined; host detail stays out, as uname's does.
GETCONF_VARIABLES: tuple[tuple[str, str | None], ...] = (
    ("LINK_MAX", "127"),
    ("_POSIX_LINK_MAX", "127"),
    ("MAX_CANON", "255"),
    ("_POSIX_MAX_CANON", "255"),
    ("MAX_INPUT", "255"),
    ("_POSIX_MAX_INPUT", "255"),
    ("NAME_MAX", "255"),
    ("_POSIX_NAME_MAX", "255"),
    ("PATH_MAX", "4096"),
    ("_POSIX_PATH_MAX", "4096"),
    ("PIPE_BUF", "4096"),
    ("_POSIX_PIPE_BUF", "4096"),
    ("SOCK_MAXBUF", None),
    ("_POSIX_ASYNC_IO", None),
    ("_POSIX_CHOWN_RESTRICTED", "1"),
    ("_POSIX_NO_TRUNC", "1"),
    ("_POSIX_PRIO_IO", None),
    ("_POSIX_SYNC_IO", None),
    ("_POSIX_VDISABLE", "0"),
    ("ARG_MAX", "2097152"),
    ("ATEXIT_MAX", "2147483647"),
    ("CHAR_BIT", "8"),
    ("CHAR_MAX", "127"),
    ("CHAR_MIN", "-128"),
    ("CHILD_MAX", None),
    ("CLK_TCK", "100"),
    ("INT_MAX", "2147483647"),
    ("INT_MIN", "-2147483648"),
    ("IOV_MAX", "1024"),
    ("LOGNAME_MAX", "256"),
    ("LONG_BIT", "64"),
    ("MB_LEN_MAX", "16"),
    ("NGROUPS_MAX", "65536"),
    ("NL_ARGMAX", "4096"),
    ("NL_LANGMAX", "2048"),
    ("NL_MSGMAX", "2147483647"),
    ("NL_NMAX", "2147483647"),
    ("NL_SETMAX", "2147483647"),
    ("NL_TEXTMAX", "2147483647"),
    ("NSS_BUFLEN_GROUP", "1024"),
    ("NSS_BUFLEN_PASSWD", "1024"),
    ("NZERO", "20"),
    ("OPEN_MAX", "1048576"),
    ("PAGESIZE", "4096"),
    ("PAGE_SIZE", "4096"),
    ("PASS_MAX", "8192"),
    ("PTHREAD_DESTRUCTOR_ITERATIONS", "4"),
    ("PTHREAD_KEYS_MAX", "1024"),
    ("PTHREAD_STACK_MIN", "16384"),
    ("PTHREAD_THREADS_MAX", None),
    ("SCHAR_MAX", "127"),
    ("SCHAR_MIN", "-128"),
    ("SHRT_MAX", "32767"),
    ("SHRT_MIN", "-32768"),
    ("SSIZE_MAX", "32767"),
    ("TTY_NAME_MAX", "32"),
    ("TZNAME_MAX", None),
    ("UCHAR_MAX", "255"),
    ("UINT_MAX", "4294967295"),
    ("UIO_MAXIOV", "1024"),
    ("ULONG_MAX", "18446744073709551615"),
    ("USHRT_MAX", "65535"),
    ("WORD_BIT", "32"),
    ("_AVPHYS_PAGES", None),
    ("_NPROCESSORS_CONF", "1"),
    ("NPROCESSORS_CONF", "1"),
    ("_NPROCESSORS_ONLN", "1"),
    ("NPROCESSORS_ONLN", "1"),
    ("_PHYS_PAGES", None),
    ("_POSIX_ARG_MAX", "2097152"),
    ("_POSIX_ASYNCHRONOUS_IO", "200809"),
    ("_POSIX_CHILD_MAX", None),
    ("_POSIX_FSYNC", "200809"),
    ("_POSIX_JOB_CONTROL", "1"),
    ("_POSIX_MAPPED_FILES", "200809"),
    ("_POSIX_MEMLOCK", "200809"),
    ("_POSIX_MEMLOCK_RANGE", "200809"),
    ("_POSIX_MEMORY_PROTECTION", "200809"),
    ("_POSIX_MESSAGE_PASSING", "200809"),
    ("_POSIX_NGROUPS_MAX", "65536"),
    ("_POSIX_OPEN_MAX", "1048576"),
    ("_POSIX_PII", None),
    ("_POSIX_PII_INTERNET", None),
    ("_POSIX_PII_INTERNET_DGRAM", None),
    ("_POSIX_PII_INTERNET_STREAM", None),
    ("_POSIX_PII_OSI", None),
    ("_POSIX_PII_OSI_CLTS", None),
    ("_POSIX_PII_OSI_COTS", None),
    ("_POSIX_PII_OSI_M", None),
    ("_POSIX_PII_SOCKET", None),
    ("_POSIX_PII_XTI", None),
    ("_POSIX_POLL", None),
    ("_POSIX_PRIORITIZED_IO", "200809"),
    ("_POSIX_PRIORITY_SCHEDULING", "200809"),
    ("_POSIX_REALTIME_SIGNALS", "200809"),
    ("_POSIX_SAVED_IDS", "1"),
    ("_POSIX_SELECT", None),
    ("_POSIX_SEMAPHORES", "200809"),
    ("_POSIX_SHARED_MEMORY_OBJECTS", "200809"),
    ("_POSIX_SSIZE_MAX", "32767"),
    ("_POSIX_STREAM_MAX", "16"),
    ("_POSIX_SYNCHRONIZED_IO", "200809"),
    ("_POSIX_THREADS", "200809"),
    ("_POSIX_THREAD_ATTR_STACKADDR", "200809"),
    ("_POSIX_THREAD_ATTR_STACKSIZE", "200809"),
    ("_POSIX_THREAD_PRIORITY_SCHEDULING", "200809"),
    ("_POSIX_THREAD_PRIO_INHERIT", "200809"),
    ("_POSIX_THREAD_PRIO_PROTECT", "200809"),
    ("_POSIX_THREAD_ROBUST_PRIO_INHERIT", None),
    ("_POSIX_THREAD_ROBUST_PRIO_PROTECT", None),
    ("_POSIX_THREAD_PROCESS_SHARED", "200809"),
    ("_POSIX_THREAD_SAFE_FUNCTIONS", "200809"),
    ("_POSIX_TIMERS", "200809"),
    ("TIMER_MAX", None),
    ("_POSIX_TZNAME_MAX", None),
    ("_POSIX_VERSION", "200809"),
    ("_T_IOV_MAX", None),
    ("_XOPEN_CRYPT", None),
    ("_XOPEN_ENH_I18N", "1"),
    ("_XOPEN_LEGACY", "1"),
    ("_XOPEN_REALTIME", "1"),
    ("_XOPEN_REALTIME_THREADS", "1"),
    ("_XOPEN_SHM", "1"),
    ("_XOPEN_UNIX", "1"),
    ("_XOPEN_VERSION", "700"),
    ("_XOPEN_XCU_VERSION", "4"),
    ("_XOPEN_XPG2", "1"),
    ("_XOPEN_XPG3", "1"),
    ("_XOPEN_XPG4", "1"),
    ("BC_BASE_MAX", "99"),
    ("BC_DIM_MAX", "2048"),
    ("BC_SCALE_MAX", "99"),
    ("BC_STRING_MAX", "1000"),
    ("CHARCLASS_NAME_MAX", "2048"),
    ("COLL_WEIGHTS_MAX", "255"),
    ("EQUIV_CLASS_MAX", None),
    ("EXPR_NEST_MAX", "32"),
    ("LINE_MAX", "2048"),
    ("POSIX2_BC_BASE_MAX", "99"),
    ("POSIX2_BC_DIM_MAX", "2048"),
    ("POSIX2_BC_SCALE_MAX", "99"),
    ("POSIX2_BC_STRING_MAX", "1000"),
    ("POSIX2_CHAR_TERM", "200809"),
    ("POSIX2_COLL_WEIGHTS_MAX", "255"),
    ("POSIX2_C_BIND", "200809"),
    ("POSIX2_C_DEV", "200809"),
    ("POSIX2_C_VERSION", "200809"),
    ("POSIX2_EXPR_NEST_MAX", "32"),
    ("POSIX2_FORT_DEV", None),
    ("POSIX2_FORT_RUN", None),
    ("_POSIX2_LINE_MAX", "2048"),
    ("POSIX2_LINE_MAX", "2048"),
    ("POSIX2_LOCALEDEF", "200809"),
    ("POSIX2_RE_DUP_MAX", "32767"),
    ("POSIX2_SW_DEV", "200809"),
    ("POSIX2_UPE", None),
    ("POSIX2_VERSION", "200809"),
    ("RE_DUP_MAX", "32767"),
    ("PATH", "/bin:/usr/bin"),
    ("CS_PATH", "/bin:/usr/bin"),
    ("LFS_CFLAGS", ""),
    ("LFS_LDFLAGS", ""),
    ("LFS_LIBS", ""),
    ("LFS_LINTFLAGS", ""),
    ("LFS64_CFLAGS", "-D_LARGEFILE64_SOURCE"),
    ("LFS64_LDFLAGS", ""),
    ("LFS64_LIBS", ""),
    ("LFS64_LINTFLAGS", "-D_LARGEFILE64_SOURCE"),
    ("_XBS5_WIDTH_RESTRICTED_ENVS", "XBS5_LP64_OFF64"),
    ("XBS5_WIDTH_RESTRICTED_ENVS", "XBS5_LP64_OFF64"),
    ("_XBS5_ILP32_OFF32", None),
    ("XBS5_ILP32_OFF32_CFLAGS", ""),
    ("XBS5_ILP32_OFF32_LDFLAGS", ""),
    ("XBS5_ILP32_OFF32_LIBS", ""),
    ("XBS5_ILP32_OFF32_LINTFLAGS", ""),
    ("_XBS5_ILP32_OFFBIG", None),
    ("XBS5_ILP32_OFFBIG_CFLAGS", ""),
    ("XBS5_ILP32_OFFBIG_LDFLAGS", ""),
    ("XBS5_ILP32_OFFBIG_LIBS", ""),
    ("XBS5_ILP32_OFFBIG_LINTFLAGS", ""),
    ("_XBS5_LP64_OFF64", "1"),
    ("XBS5_LP64_OFF64_CFLAGS", "-m64"),
    ("XBS5_LP64_OFF64_LDFLAGS", "-m64"),
    ("XBS5_LP64_OFF64_LIBS", ""),
    ("XBS5_LP64_OFF64_LINTFLAGS", ""),
    ("_XBS5_LPBIG_OFFBIG", None),
    ("XBS5_LPBIG_OFFBIG_CFLAGS", ""),
    ("XBS5_LPBIG_OFFBIG_LDFLAGS", ""),
    ("XBS5_LPBIG_OFFBIG_LIBS", ""),
    ("XBS5_LPBIG_OFFBIG_LINTFLAGS", ""),
    ("_POSIX_V6_ILP32_OFF32", None),
    ("POSIX_V6_ILP32_OFF32_CFLAGS", ""),
    ("POSIX_V6_ILP32_OFF32_LDFLAGS", ""),
    ("POSIX_V6_ILP32_OFF32_LIBS", ""),
    ("POSIX_V6_ILP32_OFF32_LINTFLAGS", ""),
    ("_POSIX_V6_WIDTH_RESTRICTED_ENVS", "POSIX_V6_LP64_OFF64"),
    ("POSIX_V6_WIDTH_RESTRICTED_ENVS", "POSIX_V6_LP64_OFF64"),
    ("_POSIX_V6_ILP32_OFFBIG", None),
    ("POSIX_V6_ILP32_OFFBIG_CFLAGS", ""),
    ("POSIX_V6_ILP32_OFFBIG_LDFLAGS", ""),
    ("POSIX_V6_ILP32_OFFBIG_LIBS", ""),
    ("POSIX_V6_ILP32_OFFBIG_LINTFLAGS", ""),
    ("_POSIX_V6_LP64_OFF64", "1"),
    ("POSIX_V6_LP64_OFF64_CFLAGS", "-m64"),
    ("POSIX_V6_LP64_OFF64_LDFLAGS", "-m64"),
    ("POSIX_V6_LP64_OFF64_LIBS", ""),
    ("POSIX_V6_LP64_OFF64_LINTFLAGS", ""),
    ("_POSIX_V6_LPBIG_OFFBIG", None),
    ("POSIX_V6_LPBIG_OFFBIG_CFLAGS", ""),
    ("POSIX_V6_LPBIG_OFFBIG_LDFLAGS", ""),
    ("POSIX_V6_LPBIG_OFFBIG_LIBS", ""),
    ("POSIX_V6_LPBIG_OFFBIG_LINTFLAGS", ""),
    ("_POSIX_V7_ILP32_OFF32", None),
    ("POSIX_V7_ILP32_OFF32_CFLAGS", ""),
    ("POSIX_V7_ILP32_OFF32_LDFLAGS", ""),
    ("POSIX_V7_ILP32_OFF32_LIBS", ""),
    ("POSIX_V7_ILP32_OFF32_LINTFLAGS", ""),
    ("_POSIX_V7_WIDTH_RESTRICTED_ENVS", "POSIX_V7_LP64_OFF64"),
    ("POSIX_V7_WIDTH_RESTRICTED_ENVS", "POSIX_V7_LP64_OFF64"),
    ("_POSIX_V7_ILP32_OFFBIG", None),
    ("POSIX_V7_ILP32_OFFBIG_CFLAGS", ""),
    ("POSIX_V7_ILP32_OFFBIG_LDFLAGS", ""),
    ("POSIX_V7_ILP32_OFFBIG_LIBS", ""),
    ("POSIX_V7_ILP32_OFFBIG_LINTFLAGS", ""),
    ("_POSIX_V7_LP64_OFF64", "1"),
    ("POSIX_V7_LP64_OFF64_CFLAGS", "-m64"),
    ("POSIX_V7_LP64_OFF64_LDFLAGS", "-m64"),
    ("POSIX_V7_LP64_OFF64_LIBS", ""),
    ("POSIX_V7_LP64_OFF64_LINTFLAGS", ""),
    ("_POSIX_V7_LPBIG_OFFBIG", None),
    ("POSIX_V7_LPBIG_OFFBIG_CFLAGS", ""),
    ("POSIX_V7_LPBIG_OFFBIG_LDFLAGS", ""),
    ("POSIX_V7_LPBIG_OFFBIG_LIBS", ""),
    ("POSIX_V7_LPBIG_OFFBIG_LINTFLAGS", ""),
    ("_POSIX_ADVISORY_INFO", "200809"),
    ("_POSIX_BARRIERS", "200809"),
    ("_POSIX_BASE", None),
    ("_POSIX_C_LANG_SUPPORT", None),
    ("_POSIX_C_LANG_SUPPORT_R", None),
    ("_POSIX_CLOCK_SELECTION", "200809"),
    ("_POSIX_CPUTIME", "200809"),
    ("_POSIX_THREAD_CPUTIME", "200809"),
    ("_POSIX_DEVICE_SPECIFIC", None),
    ("_POSIX_DEVICE_SPECIFIC_R", None),
    ("_POSIX_FD_MGMT", None),
    ("_POSIX_FIFO", None),
    ("_POSIX_PIPE", None),
    ("_POSIX_FILE_ATTRIBUTES", None),
    ("_POSIX_FILE_LOCKING", None),
    ("_POSIX_FILE_SYSTEM", None),
    ("_POSIX_MONOTONIC_CLOCK", "200809"),
    ("_POSIX_MULTI_PROCESS", None),
    ("_POSIX_SINGLE_PROCESS", None),
    ("_POSIX_NETWORKING", None),
    ("_POSIX_READER_WRITER_LOCKS", "200809"),
    ("_POSIX_SPIN_LOCKS", "200809"),
    ("_POSIX_REGEXP", "1"),
    ("_REGEX_VERSION", None),
    ("_POSIX_SHELL", "1"),
    ("_POSIX_SIGNALS", None),
    ("_POSIX_SPAWN", "200809"),
    ("_POSIX_SPORADIC_SERVER", None),
    ("_POSIX_THREAD_SPORADIC_SERVER", None),
    ("_POSIX_SYSTEM_DATABASE", None),
    ("_POSIX_SYSTEM_DATABASE_R", None),
    ("_POSIX_TIMEOUTS", "200809"),
    ("_POSIX_TYPED_MEMORY_OBJECTS", None),
    ("_POSIX_USER_GROUPS", None),
    ("_POSIX_USER_GROUPS_R", None),
    ("POSIX2_PBS", None),
    ("POSIX2_PBS_ACCOUNTING", None),
    ("POSIX2_PBS_LOCATE", None),
    ("POSIX2_PBS_TRACK", None),
    ("POSIX2_PBS_MESSAGE", None),
    ("SYMLOOP_MAX", None),
    ("STREAM_MAX", "16"),
    ("AIO_LISTIO_MAX", None),
    ("AIO_MAX", None),
    ("AIO_PRIO_DELTA_MAX", "20"),
    ("DELAYTIMER_MAX", "2147483647"),
    ("HOST_NAME_MAX", "64"),
    ("LOGIN_NAME_MAX", "256"),
    ("MQ_OPEN_MAX", None),
    ("MQ_PRIO_MAX", "32768"),
    ("_POSIX_DEVICE_IO", None),
    ("_POSIX_TRACE", None),
    ("_POSIX_TRACE_EVENT_FILTER", None),
    ("_POSIX_TRACE_INHERIT", None),
    ("_POSIX_TRACE_LOG", None),
    ("RTSIG_MAX", "32"),
    ("SEM_NSEMS_MAX", None),
    ("SEM_VALUE_MAX", "2147483647"),
    ("SIGQUEUE_MAX", "31877"),
    ("FILESIZEBITS", "32"),
    ("POSIX_ALLOC_SIZE_MIN", "4096"),
    ("POSIX_REC_INCR_XFER_SIZE", None),
    ("POSIX_REC_MAX_XFER_SIZE", None),
    ("POSIX_REC_MIN_XFER_SIZE", "4096"),
    ("POSIX_REC_XFER_ALIGN", "4096"),
    ("SYMLINK_MAX", None),
    ("GNU_LIBC_VERSION", "glibc 2.41"),
    ("GNU_LIBPTHREAD_VERSION", "NPTL 2.41"),
    ("POSIX2_SYMLINKS", "1"),
    ("LEVEL1_ICACHE_SIZE", "0"),
    ("LEVEL1_ICACHE_ASSOC", "0"),
    ("LEVEL1_ICACHE_LINESIZE", "0"),
    ("LEVEL1_DCACHE_SIZE", "0"),
    ("LEVEL1_DCACHE_ASSOC", "0"),
    ("LEVEL1_DCACHE_LINESIZE", "0"),
    ("LEVEL2_CACHE_SIZE", "0"),
    ("LEVEL2_CACHE_ASSOC", "0"),
    ("LEVEL2_CACHE_LINESIZE", "0"),
    ("LEVEL3_CACHE_SIZE", "0"),
    ("LEVEL3_CACHE_ASSOC", "0"),
    ("LEVEL3_CACHE_LINESIZE", "0"),
    ("LEVEL4_CACHE_SIZE", "0"),
    ("LEVEL4_CACHE_ASSOC", "0"),
    ("LEVEL4_CACHE_LINESIZE", "0"),
    ("IPV6", "200809"),
    ("RAW_SOCKETS", "200809"),
    ("_POSIX_IPV6", "200809"),
    ("_POSIX_RAW_SOCKETS", "200809"),
)

# The variables pathconf answers, which want a PATH operand.
PATH_VARIABLES = frozenset(
    {
        "LINK_MAX",
        "_POSIX_LINK_MAX",
        "MAX_CANON",
        "_POSIX_MAX_CANON",
        "MAX_INPUT",
        "_POSIX_MAX_INPUT",
        "NAME_MAX",
        "_POSIX_NAME_MAX",
        "PATH_MAX",
        "_POSIX_PATH_MAX",
        "PIPE_BUF",
        "_POSIX_PIPE_BUF",
        "SOCK_MAXBUF",
        "_POSIX_ASYNC_IO",
        "_POSIX_CHOWN_RESTRICTED",
        "_POSIX_NO_TRUNC",
        "_POSIX_PRIO_IO",
        "_POSIX_SYNC_IO",
        "_POSIX_VDISABLE",
        "FILESIZEBITS",
        "POSIX_ALLOC_SIZE_MIN",
        "POSIX_REC_INCR_XFER_SIZE",
        "POSIX_REC_MAX_XFER_SIZE",
        "POSIX_REC_MIN_XFER_SIZE",
        "POSIX_REC_XFER_ALIGN",
        "SYMLINK_MAX",
        "POSIX2_SYMLINKS",
    }
)


def variable(name: str) -> tuple[str, str | None] | None:
    """The table row a name selects: itself, or the ``_POSIX_`` one it
    abbreviates (``getconf VERSION`` is ``_POSIX_VERSION``), first match
    in table order as glibc scans.

    Args:
        name (str): the variable as typed.
    """
    for row in GETCONF_VARIABLES:
        if row[0] == name or (
            row[0].startswith("_POSIX_") and row[0][7:] == name
        ):
            return row
    return None


async def path_exists(opts: CommandOpts, word: str) -> bool:
    """Whether the PATH operand names something pathconf could open.

    Args:
        opts (CommandOpts): the invocation, for its cwd and stat door.
        word (str): the operand as typed.
    """
    if opts.stat_path is None:
        return True
    return (
        await opts.stat_path(resolve_path(word, opts.cwd.virtual)) is not None
    )


@command("getconf", vfs=None, spec=SPECS["getconf"])
async def getconf(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """glibc ``getconf``: one variable's value, or ``-a`` for all of them. A
    pathconf variable takes exactly one PATH and the rest none (else the usage
    block, exit 2); an unknown name is exit 2, a missing PATH exit 3, and
    ``-v`` is set aside as Debian's build does.
    """
    fl = FlagView(opts.flags, spec=SPECS["getconf"])
    if fl.as_bool("a"):
        if len(texts) > 1:
            return None, IOResult(exit_code=2, stderr=USAGE)
        found = await path_exists(opts, texts[0] if texts else "/")
        lines = [
            f"{name:<35}"
            + ((value or "") if found or name not in PATH_VARIABLES else "")
            + "\n"
            for name, value in GETCONF_VARIABLES
        ]
        return "".join(lines).encode(), IOResult()
    if not texts or len(texts) > 2:
        return None, IOResult(exit_code=2, stderr=USAGE)
    row = variable(texts[0])
    if row is None:
        err = f"getconf: Unrecognized variable `{texts[0]}'\n"
        return None, IOResult(exit_code=2, stderr=err.encode())
    name, value = row
    if (name in PATH_VARIABLES) != (len(texts) == 2):
        return None, IOResult(exit_code=2, stderr=USAGE)
    if len(texts) == 2 and not await path_exists(opts, texts[1]):
        err = f"getconf: pathconf: {texts[1]}: No such file or directory\n"
        return None, IOResult(exit_code=3, stderr=err.encode())
    return f"{UNDEFINED if value is None else value}\n".encode(), IOResult()
