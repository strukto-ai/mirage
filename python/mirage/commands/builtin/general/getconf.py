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
from mirage.commands.builtin.utils.paths import vfs_stat_path
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.memory import memory_budget
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

USAGE = (
    b"Usage: getconf [-v specification] variable_name [pathname]\n"
    b"       getconf -a [pathname]\n"
)
UNDEFINED = "undefined"
PAGE_SIZE = 4096

# The table `getconf -a` prints, in Mirage's order: POSIX.1-2024's
# tables first, then earlier standards, then Linux's names. None is
# undefined; a confstr() name that is set but empty is "".
GETCONF_VARIABLES: tuple[tuple[str, str | None], ...] = (
    # The pathname variables, in the order of the fpathconf() table in
    # POSIX.1-2024, as Linux answers them for a filesystem it has no entry for:
    # the terminal and link limits from <linux/limits.h>, a 4096-byte page for
    # the transfer sizes, 32 FILESIZEBITS.
    ("FILESIZEBITS", "32"),
    ("LINK_MAX", "127"),
    ("MAX_CANON", "255"),
    ("MAX_INPUT", "255"),
    ("NAME_MAX", "255"),
    ("PATH_MAX", "4096"),
    ("PIPE_BUF", "4096"),
    ("POSIX2_SYMLINKS", "1"),
    ("POSIX_ALLOC_SIZE_MIN", "4096"),
    ("POSIX_REC_INCR_XFER_SIZE", None),
    ("POSIX_REC_MAX_XFER_SIZE", None),
    ("POSIX_REC_MIN_XFER_SIZE", "4096"),
    ("POSIX_REC_XFER_ALIGN", "4096"),
    ("SYMLINK_MAX", None),
    ("_POSIX_CHOWN_RESTRICTED", "1"),
    ("_POSIX_NO_TRUNC", "1"),
    ("_POSIX_VDISABLE", "0"),
    ("_POSIX_ASYNC_IO", None),
    ("_POSIX_PRIO_IO", None),
    ("_POSIX_SYNC_IO", None),
    # Local pathname names: the _POSIX_ name of a pathname limit answers
    # the limit itself, as the image's getconf does, not POSIX's minimum.
    ("_POSIX_LINK_MAX", "127"),
    ("_POSIX_MAX_CANON", "255"),
    ("_POSIX_MAX_INPUT", "255"),
    ("_POSIX_NAME_MAX", "255"),
    ("_POSIX_PATH_MAX", "4096"),
    ("_POSIX_PIPE_BUF", "4096"),
    ("SOCK_MAXBUF", None),
    # The sysconf() variables, in the order of its table in POSIX.1-2024,
    # for x86_64 Linux in a container: ARG_MAX is a quarter of the 8 MiB stack
    # limit, CLK_TCK is USER_HZ, OPEN_MAX the soft RLIMIT_NOFILE and CHILD_MAX
    # an unlimited RLIMIT_NPROC; the options carry POSIX.1-2008's 200809 and
    # the X/Open ones SUSv4's 700. One execution unit and no signal queue
    # limit, as host detail stays out.
    ("AIO_LISTIO_MAX", None),
    ("AIO_MAX", None),
    ("AIO_PRIO_DELTA_MAX", "20"),
    ("ARG_MAX", "2097152"),
    ("ATEXIT_MAX", "2147483647"),
    ("BC_BASE_MAX", "99"),
    ("BC_DIM_MAX", "2048"),
    ("BC_SCALE_MAX", "99"),
    ("BC_STRING_MAX", "1000"),
    ("CHILD_MAX", None),
    ("CLK_TCK", "100"),
    ("COLL_WEIGHTS_MAX", "255"),
    ("DELAYTIMER_MAX", "2147483647"),
    ("EXPR_NEST_MAX", "32"),
    ("HOST_NAME_MAX", "64"),
    ("IOV_MAX", "1024"),
    ("LINE_MAX", "2048"),
    ("LOGIN_NAME_MAX", "256"),
    ("NGROUPS_MAX", "65536"),
    ("MQ_OPEN_MAX", None),
    ("MQ_PRIO_MAX", "32768"),
    ("OPEN_MAX", "1048576"),
    ("PAGE_SIZE", "4096"),
    ("PAGESIZE", "4096"),
    ("PTHREAD_DESTRUCTOR_ITERATIONS", "4"),
    ("PTHREAD_KEYS_MAX", "1024"),
    ("PTHREAD_STACK_MIN", "16384"),
    ("PTHREAD_THREADS_MAX", None),
    ("RE_DUP_MAX", "32767"),
    ("RTSIG_MAX", "32"),
    ("SEM_NSEMS_MAX", None),
    ("SEM_VALUE_MAX", "2147483647"),
    ("SIGQUEUE_MAX", None),
    ("STREAM_MAX", "16"),
    ("SYMLOOP_MAX", None),
    ("TIMER_MAX", None),
    ("TTY_NAME_MAX", "32"),
    ("TZNAME_MAX", None),
    ("_POSIX_ADVISORY_INFO", "200809"),
    ("_POSIX_BARRIERS", "200809"),
    ("_POSIX_ASYNCHRONOUS_IO", "200809"),
    ("_POSIX_CLOCK_SELECTION", "200809"),
    ("_POSIX_CPUTIME", "200809"),
    ("_POSIX_FSYNC", "200809"),
    ("_POSIX_IPV6", "200809"),
    ("_POSIX_JOB_CONTROL", "1"),
    ("_POSIX_MAPPED_FILES", "200809"),
    ("_POSIX_MEMLOCK", "200809"),
    ("_POSIX_MEMLOCK_RANGE", "200809"),
    ("_POSIX_MEMORY_PROTECTION", "200809"),
    ("_POSIX_MESSAGE_PASSING", "200809"),
    ("_POSIX_MONOTONIC_CLOCK", "200809"),
    ("_POSIX_PRIORITIZED_IO", "200809"),
    ("_POSIX_PRIORITY_SCHEDULING", "200809"),
    ("_POSIX_RAW_SOCKETS", "200809"),
    ("_POSIX_READER_WRITER_LOCKS", "200809"),
    ("_POSIX_REALTIME_SIGNALS", "200809"),
    ("_POSIX_REGEXP", "1"),
    ("_POSIX_SAVED_IDS", "1"),
    ("_POSIX_SEMAPHORES", "200809"),
    ("_POSIX_SHARED_MEMORY_OBJECTS", "200809"),
    ("_POSIX_SHELL", "1"),
    ("_POSIX_SPAWN", "200809"),
    ("_POSIX_SPIN_LOCKS", "200809"),
    ("_POSIX_SPORADIC_SERVER", None),
    ("_POSIX_SYNCHRONIZED_IO", "200809"),
    ("_POSIX_THREAD_ATTR_STACKADDR", "200809"),
    ("_POSIX_THREAD_ATTR_STACKSIZE", "200809"),
    ("_POSIX_THREAD_CPUTIME", "200809"),
    ("_POSIX_THREAD_PRIO_INHERIT", "200809"),
    ("_POSIX_THREAD_PRIO_PROTECT", "200809"),
    ("_POSIX_THREAD_PRIORITY_SCHEDULING", "200809"),
    ("_POSIX_THREAD_PROCESS_SHARED", "200809"),
    ("_POSIX_THREAD_ROBUST_PRIO_INHERIT", None),
    ("_POSIX_THREAD_ROBUST_PRIO_PROTECT", None),
    ("_POSIX_THREAD_SAFE_FUNCTIONS", "200809"),
    ("_POSIX_THREAD_SPORADIC_SERVER", None),
    ("_POSIX_THREADS", "200809"),
    ("_POSIX_TIMEOUTS", "200809"),
    ("_POSIX_TIMERS", "200809"),
    ("_POSIX_TYPED_MEMORY_OBJECTS", None),
    ("_POSIX_VERSION", "200809"),
    ("_POSIX_V7_ILP32_OFF32", None),
    ("_POSIX_V7_ILP32_OFFBIG", None),
    ("_POSIX_V7_LP64_OFF64", "1"),
    ("_POSIX_V7_LPBIG_OFFBIG", None),
    ("_XOPEN_CRYPT", None),
    ("_XOPEN_ENH_I18N", "1"),
    ("_XOPEN_REALTIME", "1"),
    ("_XOPEN_REALTIME_THREADS", "1"),
    ("_XOPEN_SHM", "1"),
    ("_XOPEN_UNIX", "1"),
    ("_XOPEN_VERSION", "700"),
    ("NPROCESSORS_CONF", "1"),
    ("NPROCESSORS_ONLN", "1"),
    # The names POSIX.1-2024's getconf keeps for compatibility, each equal
    # to the same name with a leading underscore.
    ("POSIX2_C_BIND", "200809"),
    ("POSIX2_C_DEV", "200809"),
    ("POSIX2_CHAR_TERM", "200809"),
    ("POSIX2_FORT_RUN", None),
    ("POSIX2_LOCALEDEF", "200809"),
    ("POSIX2_SW_DEV", "200809"),
    ("POSIX2_UPE", None),
    ("POSIX2_VERSION", "200809"),
    ("POSIX2_BC_BASE_MAX", "99"),
    ("POSIX2_BC_DIM_MAX", "2048"),
    ("POSIX2_BC_SCALE_MAX", "99"),
    ("POSIX2_BC_STRING_MAX", "1000"),
    ("POSIX2_COLL_WEIGHTS_MAX", "255"),
    ("POSIX2_EXPR_NEST_MAX", "32"),
    ("POSIX2_LINE_MAX", "2048"),
    ("POSIX2_RE_DUP_MAX", "32767"),
    # The confstr() names, in the order of its table in POSIX.1-2024, for
    # LP64 x86_64, whose one native environment is LP64_OFF64.
    ("PATH", "/bin:/usr/bin"),
    ("POSIX_V7_ILP32_OFF32_CFLAGS", ""),
    ("POSIX_V7_ILP32_OFF32_LDFLAGS", ""),
    ("POSIX_V7_ILP32_OFF32_LIBS", ""),
    ("POSIX_V7_ILP32_OFFBIG_CFLAGS", ""),
    ("POSIX_V7_ILP32_OFFBIG_LDFLAGS", ""),
    ("POSIX_V7_ILP32_OFFBIG_LIBS", ""),
    ("POSIX_V7_LP64_OFF64_CFLAGS", "-m64"),
    ("POSIX_V7_LP64_OFF64_LDFLAGS", "-m64"),
    ("POSIX_V7_LP64_OFF64_LIBS", ""),
    ("POSIX_V7_LPBIG_OFFBIG_CFLAGS", ""),
    ("POSIX_V7_LPBIG_OFFBIG_LDFLAGS", ""),
    ("POSIX_V7_LPBIG_OFFBIG_LIBS", ""),
    ("POSIX_V7_WIDTH_RESTRICTED_ENVS", "POSIX_V7_LP64_OFF64"),
    # <limits.h>: Runtime Increasable, Minimum, Numerical and Other
    # Invariant Values, for LP64 x86_64 (char is signed). A _POSIX_ minimum
    # answers the runtime value, but _POSIX_SSIZE_MAX answers POSIX's 32767,
    # and SSIZE_MAX answers that minimum too, as the image's getconf does.
    ("CHARCLASS_NAME_MAX", "2048"),
    ("_POSIX_ARG_MAX", "2097152"),
    ("_POSIX_CHILD_MAX", None),
    ("_POSIX_NGROUPS_MAX", "65536"),
    ("_POSIX_OPEN_MAX", "1048576"),
    ("_POSIX_SSIZE_MAX", "32767"),
    ("_POSIX_STREAM_MAX", "16"),
    ("_POSIX_TZNAME_MAX", None),
    ("_POSIX2_LINE_MAX", "2048"),
    ("CHAR_BIT", "8"),
    ("CHAR_MAX", "127"),
    ("CHAR_MIN", "-128"),
    ("INT_MAX", "2147483647"),
    ("INT_MIN", "-2147483648"),
    ("LONG_BIT", "64"),
    ("MB_LEN_MAX", "16"),
    ("SCHAR_MAX", "127"),
    ("SCHAR_MIN", "-128"),
    ("SHRT_MAX", "32767"),
    ("SHRT_MIN", "-32768"),
    ("SSIZE_MAX", "32767"),
    ("UCHAR_MAX", "255"),
    ("UINT_MAX", "4294967295"),
    ("ULONG_MAX", "18446744073709551615"),
    ("USHRT_MAX", "65535"),
    ("WORD_BIT", "32"),
    ("NL_ARGMAX", "4096"),
    ("NL_LANGMAX", "2048"),
    ("NL_MSGMAX", "2147483647"),
    ("NL_SETMAX", "2147483647"),
    ("NL_TEXTMAX", "2147483647"),
    ("NZERO", "20"),
    # Names from earlier standards Linux still answers: Issue 6's
    # compilation environments and LINTFLAGS, SUSv2's XBS5 environments, the
    # Large File Summit's flags, Issue 6's batch and trace options, XPG's
    # version names and IEEE 1003.1g's and 1003.13's options.
    ("POSIX_V7_ILP32_OFF32_LINTFLAGS", ""),
    ("POSIX_V7_ILP32_OFFBIG_LINTFLAGS", ""),
    ("POSIX_V7_LP64_OFF64_LINTFLAGS", ""),
    ("POSIX_V7_LPBIG_OFFBIG_LINTFLAGS", ""),
    ("_POSIX_V7_WIDTH_RESTRICTED_ENVS", "POSIX_V7_LP64_OFF64"),
    ("_POSIX_V6_ILP32_OFF32", None),
    ("_POSIX_V6_ILP32_OFFBIG", None),
    ("_POSIX_V6_LP64_OFF64", "1"),
    ("_POSIX_V6_LPBIG_OFFBIG", None),
    ("POSIX_V6_ILP32_OFF32_CFLAGS", ""),
    ("POSIX_V6_ILP32_OFF32_LDFLAGS", ""),
    ("POSIX_V6_ILP32_OFF32_LIBS", ""),
    ("POSIX_V6_ILP32_OFF32_LINTFLAGS", ""),
    ("POSIX_V6_ILP32_OFFBIG_CFLAGS", ""),
    ("POSIX_V6_ILP32_OFFBIG_LDFLAGS", ""),
    ("POSIX_V6_ILP32_OFFBIG_LIBS", ""),
    ("POSIX_V6_ILP32_OFFBIG_LINTFLAGS", ""),
    ("POSIX_V6_LP64_OFF64_CFLAGS", "-m64"),
    ("POSIX_V6_LP64_OFF64_LDFLAGS", "-m64"),
    ("POSIX_V6_LP64_OFF64_LIBS", ""),
    ("POSIX_V6_LP64_OFF64_LINTFLAGS", ""),
    ("POSIX_V6_LPBIG_OFFBIG_CFLAGS", ""),
    ("POSIX_V6_LPBIG_OFFBIG_LDFLAGS", ""),
    ("POSIX_V6_LPBIG_OFFBIG_LIBS", ""),
    ("POSIX_V6_LPBIG_OFFBIG_LINTFLAGS", ""),
    ("_POSIX_V6_WIDTH_RESTRICTED_ENVS", "POSIX_V6_LP64_OFF64"),
    ("POSIX_V6_WIDTH_RESTRICTED_ENVS", "POSIX_V6_LP64_OFF64"),
    ("_XBS5_ILP32_OFF32", None),
    ("_XBS5_ILP32_OFFBIG", None),
    ("_XBS5_LP64_OFF64", "1"),
    ("_XBS5_LPBIG_OFFBIG", None),
    ("XBS5_ILP32_OFF32_CFLAGS", ""),
    ("XBS5_ILP32_OFF32_LDFLAGS", ""),
    ("XBS5_ILP32_OFF32_LIBS", ""),
    ("XBS5_ILP32_OFF32_LINTFLAGS", ""),
    ("XBS5_ILP32_OFFBIG_CFLAGS", ""),
    ("XBS5_ILP32_OFFBIG_LDFLAGS", ""),
    ("XBS5_ILP32_OFFBIG_LIBS", ""),
    ("XBS5_ILP32_OFFBIG_LINTFLAGS", ""),
    ("XBS5_LP64_OFF64_CFLAGS", "-m64"),
    ("XBS5_LP64_OFF64_LDFLAGS", "-m64"),
    ("XBS5_LP64_OFF64_LIBS", ""),
    ("XBS5_LP64_OFF64_LINTFLAGS", ""),
    ("XBS5_LPBIG_OFFBIG_CFLAGS", ""),
    ("XBS5_LPBIG_OFFBIG_LDFLAGS", ""),
    ("XBS5_LPBIG_OFFBIG_LIBS", ""),
    ("XBS5_LPBIG_OFFBIG_LINTFLAGS", ""),
    ("_XBS5_WIDTH_RESTRICTED_ENVS", "XBS5_LP64_OFF64"),
    ("XBS5_WIDTH_RESTRICTED_ENVS", "XBS5_LP64_OFF64"),
    ("LFS_CFLAGS", ""),
    ("LFS_LDFLAGS", ""),
    ("LFS_LIBS", ""),
    ("LFS_LINTFLAGS", ""),
    ("LFS64_CFLAGS", "-D_LARGEFILE64_SOURCE"),
    ("LFS64_LDFLAGS", ""),
    ("LFS64_LIBS", ""),
    ("LFS64_LINTFLAGS", "-D_LARGEFILE64_SOURCE"),
    ("POSIX2_C_VERSION", "200809"),
    ("POSIX2_FORT_DEV", None),
    ("POSIX2_PBS", None),
    ("POSIX2_PBS_ACCOUNTING", None),
    ("POSIX2_PBS_LOCATE", None),
    ("POSIX2_PBS_MESSAGE", None),
    ("POSIX2_PBS_TRACK", None),
    ("_POSIX_TRACE", None),
    ("_POSIX_TRACE_EVENT_FILTER", None),
    ("_POSIX_TRACE_INHERIT", None),
    ("_POSIX_TRACE_LOG", None),
    ("_XOPEN_LEGACY", "1"),
    ("_XOPEN_XCU_VERSION", "4"),
    ("_XOPEN_XPG2", "1"),
    ("_XOPEN_XPG3", "1"),
    ("_XOPEN_XPG4", "1"),
    ("NL_NMAX", "2147483647"),
    ("EQUIV_CLASS_MAX", None),
    ("_T_IOV_MAX", None),
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
    ("_POSIX_SELECT", None),
    ("_POSIX_BASE", None),
    ("_POSIX_C_LANG_SUPPORT", None),
    ("_POSIX_C_LANG_SUPPORT_R", None),
    ("_POSIX_DEVICE_IO", None),
    ("_POSIX_DEVICE_SPECIFIC", None),
    ("_POSIX_DEVICE_SPECIFIC_R", None),
    ("_POSIX_FD_MGMT", None),
    ("_POSIX_FIFO", None),
    ("_POSIX_FILE_ATTRIBUTES", None),
    ("_POSIX_FILE_LOCKING", None),
    ("_POSIX_FILE_SYSTEM", None),
    ("_POSIX_MULTI_PROCESS", None),
    ("_POSIX_NETWORKING", None),
    ("_POSIX_PIPE", None),
    ("_POSIX_SIGNALS", None),
    ("_POSIX_SINGLE_PROCESS", None),
    ("_POSIX_SYSTEM_DATABASE", None),
    ("_POSIX_SYSTEM_DATABASE_R", None),
    ("_POSIX_USER_GROUPS", None),
    ("_POSIX_USER_GROUPS_R", None),
    ("_REGEX_VERSION", None),
    # Linux's own names (sysconf(3) and confstr(3) in the man-pages), and
    # the C library version the image reports. Host detail stays out, as
    # uname's does: no memory or cache figures.
    ("_NPROCESSORS_CONF", "1"),
    ("_NPROCESSORS_ONLN", "1"),
    ("_PHYS_PAGES", None),
    ("_AVPHYS_PAGES", None),
    ("LEVEL1_ICACHE_SIZE", None),
    ("LEVEL1_ICACHE_ASSOC", None),
    ("LEVEL1_ICACHE_LINESIZE", None),
    ("LEVEL1_DCACHE_SIZE", None),
    ("LEVEL1_DCACHE_ASSOC", None),
    ("LEVEL1_DCACHE_LINESIZE", None),
    ("LEVEL2_CACHE_SIZE", None),
    ("LEVEL2_CACHE_ASSOC", None),
    ("LEVEL2_CACHE_LINESIZE", None),
    ("LEVEL3_CACHE_SIZE", None),
    ("LEVEL3_CACHE_ASSOC", None),
    ("LEVEL3_CACHE_LINESIZE", None),
    ("LEVEL4_CACHE_SIZE", None),
    ("LEVEL4_CACHE_ASSOC", None),
    ("LEVEL4_CACHE_LINESIZE", None),
    ("IPV6", "200809"),
    ("RAW_SOCKETS", "200809"),
    ("CS_PATH", "/bin:/usr/bin"),
    ("GNU_LIBC_VERSION", "glibc 2.41"),
    ("GNU_LIBPTHREAD_VERSION", "NPTL 2.41"),
    ("LOGNAME_MAX", "256"),
    ("PASS_MAX", "8192"),
    ("NSS_BUFLEN_GROUP", "1024"),
    ("NSS_BUFLEN_PASSWD", "1024"),
    ("UIO_MAXIOV", "1024"),
)

# The variables pathconf answers, which want a PATH operand.
PATH_VARIABLES = frozenset(
    {
        "FILESIZEBITS",
        "LINK_MAX",
        "MAX_CANON",
        "MAX_INPUT",
        "NAME_MAX",
        "PATH_MAX",
        "PIPE_BUF",
        "POSIX2_SYMLINKS",
        "POSIX_ALLOC_SIZE_MIN",
        "POSIX_REC_INCR_XFER_SIZE",
        "POSIX_REC_MAX_XFER_SIZE",
        "POSIX_REC_MIN_XFER_SIZE",
        "POSIX_REC_XFER_ALIGN",
        "SYMLINK_MAX",
        "_POSIX_CHOWN_RESTRICTED",
        "_POSIX_NO_TRUNC",
        "_POSIX_VDISABLE",
        "_POSIX_ASYNC_IO",
        "_POSIX_PRIO_IO",
        "_POSIX_SYNC_IO",
        "_POSIX_LINK_MAX",
        "_POSIX_MAX_CANON",
        "_POSIX_MAX_INPUT",
        "_POSIX_NAME_MAX",
        "_POSIX_PATH_MAX",
        "_POSIX_PIPE_BUF",
        "SOCK_MAXBUF",
    }
)


def variable(name: str) -> tuple[str, str | None] | None:
    """The table row a name selects: its own, or else the ``_POSIX_`` one
    it abbreviates (``getconf VERSION`` is ``_POSIX_VERSION``). Where a
    name has both, the two answer alike.

    Args:
        name (str): the variable as typed.
    """
    for row in GETCONF_VARIABLES:
        if row[0] == name:
            return row
    for row in GETCONF_VARIABLES:
        if row[0].startswith("_POSIX_") and row[0][7:] == name:
            return row
    return None


def live_value(name: str, value: str | None) -> str | None:
    """A variable's answer: the memory ones are the workspace's
    ``max_memory`` and what it has left, in pages, and undefined with no
    cap; the rest are the table's.

    Args:
        name (str): the variable.
        value (str | None): its entry in the table.
    """
    budget = memory_budget()
    if budget is None or name not in ("_PHYS_PAGES", "_AVPHYS_PAGES"):
        return value
    size = budget.limit if name == "_PHYS_PAGES" else budget.room()
    return str(size // PAGE_SIZE)


async def path_exists(ctx: Context, word: str) -> bool:
    """Whether the PATH operand names something pathconf could open.

    Args:
        ctx (Context): the invocation, for its cwd and stat function.
        word (str): the operand as typed.
    """
    stat_path = vfs_stat_path(ctx.vfs)
    if stat_path is None:
        return True
    spec = PathSpec.from_str_path(word, cwd=ctx.cwd)
    return await stat_path(spec) is not None


@command("getconf", vfs=None, spec=SPECS["getconf"])
async def getconf(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """``getconf``: one variable's value, or ``-a`` for all of them. A
    pathconf variable takes exactly one PATH and the rest none (else the usage
    block, exit 2); an unknown name is exit 2, a missing PATH exit 3, and
    ``-v`` is set aside as Debian's build does.
    """
    fl = FlagView(ctx.flags, spec=SPECS["getconf"])
    if fl.as_bool("a"):
        if len(texts) > 1:
            return None, IOResult(exit_code=2, stderr=USAGE)
        found = await path_exists(ctx, texts[0] if texts else "/")
        lines = [
            f"{name:<35}"
            + (
                (live_value(name, value) or "")
                if found or name not in PATH_VARIABLES
                else ""
            )
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
    name, value = row[0], live_value(*row)
    if (name in PATH_VARIABLES) != (len(texts) == 2):
        return None, IOResult(exit_code=2, stderr=USAGE)
    if len(texts) == 2 and not await path_exists(ctx, texts[1]):
        err = f"getconf: pathconf: {texts[1]}: No such file or directory\n"
        return None, IOResult(exit_code=3, stderr=err.encode())
    return f"{UNDEFINED if value is None else value}\n".encode(), IOResult()
