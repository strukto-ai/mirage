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

import base64
import re
from collections.abc import Mapping, Sequence
from typing import Literal

from mirage.execution.job.constants import HANGUP_SIGNAL
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.types import MachinePid
from mirage.machine.types import MountType
from mirage.mount.constants import FSPROTO_VERSION, KERNEL_CACHE_SECONDS
from mirage.utils.clock import bound_system_clock, system_now
from mirage.utils.quote import single_quote
from mirage.version import __version__


def not_running_hint(
    noun: str,
    name: str,
    state: str,
    hints: Mapping[str, str],
    otherwise: str | None = None,
) -> str:
    """Why a machine cannot take a line, named by the state its status
    command reported.

    Args:
        noun (str): what the provider calls it (container, machine,
            machine).
        name (str): the configured id or name.
        state (str): the reported state.
        hints (Mapping[str, str]): the provider's advice per state, with
            ``{name}`` standing for ``name``.
        otherwise (str | None): advice for a state ``hints`` lacks.
    """
    detail = hints.get(state)
    if detail is not None:
        return f"{noun} {name} is not running: {detail.format(name=name)}"
    said = f"{noun} {name} is not running (state: {state})"
    return said if otherwise is None else f"{said}; {otherwise}"


def stop_signal(runner: ProcessHandle | None) -> int | None:
    """The signal a ``kill`` stopped ``runner`` with, or an interrupt
    stops the program it runs with (``ProcessHandle.interrupted``), when
    a program may handle it: None for KILL, or for a run nothing stopped,
    which is killed at once.

    Args:
        runner (ProcessHandle | None): the caller's runner, if any.
    """
    if runner is None:
        return None
    signal = runner.signal if runner.signal is not None else runner.interrupted
    return None if signal in (None, 9) else signal


MOUNT_TYPES: tuple[MountType, ...] = ("ssh", "mirage", "own", "both")

# How long a machine has to show a served prefix as mounted, and how
# often it is asked.
MOUNT_WAIT_SECONDS = 15.0
MOUNT_POLL_SECONDS = 0.1

# How long a served prefix's SFTP server may take to end once its
# machine side is unmounted.
UNMOUNT_WAIT_SECONDS = 5.0

# How much of a pipe helper's stderr is kept to say why a mount failed,
# and how long a helper still running has to finish saying it.
PIPE_DIAGNOSTIC_BYTES = 16384
PIPE_DIAGNOSTIC_WAIT_SECONDS = 1.0

# sshfs keeps no copy of its own, and every read asks the host, so a file
# whose size the backend does not know reads whole (direct_io), as the
# workspace's own FUSE mounts do. The machine's kernel keeps what a name,
# its absence and its attributes were for KERNEL_CACHE_SECONDS, so an
# import's checks of its script's folder stay on the machine; a program
# starts only once that holds nothing another changed since.
SSHFS_OPTIONS = (
    "passive,dir_cache=no,direct_io,"
    f"attr_timeout={KERNEL_CACHE_SECONDS},"
    f"entry_timeout={KERNEL_CACHE_SECONDS},"
    f"negative_timeout={KERNEL_CACHE_SECONDS}"
)

# sshfs with the fix for CVE-2026-47187 refuses a link whose target is
# absolute or holds a `..` (EPERM), guarding a machine against a hostile
# server. The server here is the workspace, and a project's own links
# (node_modules/.bin, a virtualenv's interpreter, a link out to the
# machine's disk) point that way, so a machine's sshfs that knows this
# option is given it; an older one refuses an option it does not know.
SSHFS_LINKS_OPTION = "no_contain_symlinks"


# How an sshfs source names the mirage serving it:
# ``mirage-<id>-<instance>-<n>:<prefix>``, so each instance knows its own
# mounts from another's on the same machine.
SSHFS_SOURCE_PREFIX = "mirage-"

# The line that makes sure the machine has sshfs, exiting 0 once it does:
# one it lacks is installed by its package manager, as root or through sudo
# without a password, from the package lists the image keeps and, when that
# fails, from fresh ones.
SSHFS_LINE = (
    "command -v sshfs >/dev/null 2>&1 && exit 0; "
    'if [ "$(id -u)" = 0 ]; then s=; '
    'elif sudo -n true 2>/dev/null; then s="sudo -n"; else exit 1; fi; '
    "a='env DEBIAN_FRONTEND=noninteractive apt-get -y -qq'; "
    "{ if command -v apt-get; then "
    "$s $a install --no-install-recommends sshfs || "
    "{ $s $a update && $s $a install --no-install-recommends sshfs; }; "
    "elif command -v apk; then $s apk add --no-cache sshfs; "
    "elif command -v dnf; then $s dnf install -y -q fuse-sshfs; "
    "elif command -v yum; then $s yum install -y -q fuse-sshfs; fi; "
    "} >/dev/null 2>&1; command -v sshfs >/dev/null 2>&1 || exit 1"
)
SSHFS_HINT = (
    "serving the workspace into a machine needs sshfs there, and it could "
    "not be installed: that takes root or sudo without a password, and "
    "apt-get, apk, dnf or yum; install it in the image (apt-get update && "
    "apt-get install sshfs)"
)
PIPE_SERVER_HINT = (
    "serving the workspace into a machine needs asyncssh; "
    "install with: pip install mirage-ai[ssh]"
)

# The type macOS's mount table gives every macFUSE mount, mirage-fuse's
# among them.
MACFUSE_KIND = "macfuse"

# The mount types a machine's mount table gives a prefix a workspace served
# it, each with the program that serves it.
SERVED_KINDS: dict[str, str] = {
    "fuse.sshfs": "sshfs",
    "fuse.mirage": "mirage-fuse",
    MACFUSE_KIND: "macFUSE mount",
}

# Finds the machine's mirage-fuse that speaks this host's fsproto, Mirage's
# folder in its home first and then its PATH, into ``$f``, empty when
# neither does.
MIRAGE_FUSE_FIND = (
    'f=; for c in "${HOME:-/root}/.mirage/bin/mirage-fuse" '
    '"$(command -v mirage-fuse 2>/dev/null)"; do '
    'case "$("$c" --version 2>/dev/null)" in '
    f'(*" fsproto {FSPROTO_VERSION}") f=$c; break;; esac; done; '
)

# This host's version as npm spells it, ``0.1.0-alpha.1`` for PyPI's
# ``0.1.0a1``; uv reads that spelling too.
MIRAGE_FUSE_VERSION = re.sub(
    r"(a|b|rc)(\d+)$",
    lambda m: f"-{ {'a': 'alpha', 'b': 'beta', 'rc': 'rc'}[m[1]] }.{m[2]}",
    __version__,
)

# Exits 0 once the machine's mirage-fuse speaks this host's fsproto: one
# it lacks is installed into Mirage's folder in its home at this host's
# version, with uv or else npm, whichever the machine has, either one
# replacing a stale one there.
MIRAGE_FUSE_LINE = (
    f'{MIRAGE_FUSE_FIND}[ -n "$f" ] && exit 0; '
    'd="${HOME:-/root}/.mirage"; { { command -v uv && '
    'UV_TOOL_BIN_DIR="$d/bin" uv tool install --force '
    f"mirage-fuse=={MIRAGE_FUSE_VERSION}; }} || {{ command -v npm && "
    'npm install -g --force --prefix "$d" '
    f"@struktoai/mirage-fuse@{MIRAGE_FUSE_VERSION}; }}; }} >/dev/null 2>&1; "
    f'{MIRAGE_FUSE_FIND}[ -n "$f" ]'
)
MIRAGE_FUSE_HINT = (
    "mount_type mirage needs a Linux machine, or a Mac with macFUSE, with "
    f"mirage-fuse speaking fsproto {FSPROTO_VERSION}, and it could not be "
    "installed: that takes "
    "uv or npm there; put it in the image (uv tool install "
    f"mirage-fuse=={MIRAGE_FUSE_VERSION} or npm install -g "
    f"@struktoai/mirage-fuse@{MIRAGE_FUSE_VERSION}), or use mount_type ssh"
)

# Every argv a machine runs goes under this POSIX sh prelude, with the
# cwd as $1: a provider program's exec passes `-w /` (exec_args), and a
# provider whose exec takes one command line dresses it (wrap_line), so
# no provider's own cwd is used. An exec's `-e` can append to the image's
# environment rather than replace a name it already sets, `-w` can
# create a missing directory, and an SDK's cwd fails a missing one its
# own way (E2B: exit 1). sh imports the environment last-wins, `cd`
# fails loud (126) on a cwd the machine does not serve, and `exec` hands
# over the argv unchanged. `cd` runs without CDPATH, so a relative cwd
# resolves from `/` and prints nothing, while the program still sees the
# guest's own CDPATH. The shell is named by path, /bin/sh, since the
# command's PATH is the session's and may hold no sh; the argv after the
# prelude is still found on it.
EXEC_PRELUDE = 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"'

# What a wrapper checks before it hands over to the program, so a program
# the machine cannot run is reported in bash's words rather than in those
# of the machine's sh, whose exec would: ``$1`` leads the line (``bash:
# line 3: x: ``), ``$2`` is the reason for a name no folder on PATH holds
# (``command not found``), ``$3`` leads a file PATH holds that cannot run,
# named by its path as bash names it (``bash: line 3: ``; empty to lead
# with ``$1``), and ``$4`` is the program. An empty PATH entry is the
# working directory, as it is to bash and to sh's exec. A path that names
# nothing the machine user can see is reported by its nearest folder that
# exists: one that is a file is ``Not a directory``, one the user cannot
# search ``Permission denied``, as exec's ENOTDIR and EACCES are. It runs
# in a subshell of its own, so none of its names reaches the program's
# environment, and needs only sh's builtins, so a PATH with no tools still
# runs it.
PROGRAM_CHECK = (
    'case $4 in */*) if [ -d "$4" ]; then '
    "printf '%sIs a directory\\n' \"$1\" >&2; exit 126; "
    "elif [ ! -e \"$4\" ]; then e='No such file or directory'; c=127; d=$4; "
    'while case $d in */*) d=${d%/*};; *) d=;; esac; [ -n "$d" ]; do '
    'if [ -e "$d" ]; then if [ ! -d "$d" ]; then e=\'Not a directory\'; c=126; '
    "elif [ ! -x \"$d\" ]; then e='Permission denied'; c=126; fi; break; fi; done; "
    'printf \'%s%s\\n\' "$1" "$e" >&2; exit $c; '
    'elif [ ! -x "$4" ]; then '
    "printf '%sPermission denied\\n' \"$1\" >&2; exit 126; fi;; "
    "*) f=; r=$PATH; while :; do d=${r%%:*}; d=${d:-.}; "
    'if [ -f "$d/$4" ] && [ -x "$d/$4" ]; then exit 0; fi; '
    'if [ -z "$f" ] && [ -e "$d/$4" ] && [ ! -d "$d/$4" ]; then f=$d/$4; fi; '
    "case $r in *:*) r=${r#*:};; *) break;; esac; done; "
    'if [ -z "$f" ]; then printf \'%s%s\\n\' "$1" "$2" >&2; exit 127; fi; '
    'if [ -n "$3" ]; then printf \'%s%s: Permission denied\\n\' "$3" "$f" >&2; '
    "else printf '%sPermission denied\\n' \"$1\" >&2; fi; exit 126;; esac"
)

# What both mount guards run once every mount checks out: the program
# check (``PROGRAM_CHECK``) in a subshell, then the argv after `--`.
GUARDED_EXEC = (
    '( p=$1; w=$2; v=$3; shift 4; while [ "$1" != -- ]; do shift 4; done; '
    'set -- "$p" "$w" "$v" "$2"; ' + PROGRAM_CHECK + " ) || exit $?; "
    'shift 4; while [ "$1" != -- ]; do shift 4; done; shift; exec "$@"'
)

# A line in a machine holding mounts runs under this guard, inside its own
# exec, so it checks the boot the program runs in: a machine that
# restarted after the line was admitted has lost its mounts, and a program
# run over the bare directories would write to the machine's own disk.
# $1 to $3 are the words a program it cannot run is reported in
# (``PROGRAM_CHECK``), $4 the mount table, then four words per mount
# (mountpoint and source as the table escapes them, type, the message),
# then `--` and the argv. Each mount must be the top entry at its
# mountpoint, or the guard prints its message and exits 126 with nothing
# run; then the program is checked. Both checks run in subshells, so their
# names never reach the program's environment, and need only sh's
# builtins, so a PATH with no tools still runs it.
MOUNT_GUARD = (
    "( t=$4; shift 4; "
    '[ -r "$t" ] || { printf \'%s\\n\' "$4" >&2; exit 126; }; '
    'while [ "$1" != -- ]; do f=; '
    'while read -r s m k o; do [ "$m" = "$1" ] || continue; '
    'f=; [ "$s" = "$2" ] && [ "$k" = "$3" ] && f=1; '
    'done < "$t"; '
    '[ -n "$f" ] || { printf \'%s\\n\' "$4" >&2; exit 126; }; '
    "shift 4; done ) || exit 126; " + GUARDED_EXEC
)

# ``MOUNT_GUARD`` on a Mac, which has no mount table file: it reads what
# ``mount`` prints, ``<source> on <mountpoint> (<type>, ...)``, and
# ignores $4.
DARWIN_MOUNT_GUARD = (
    "( shift 4; t=$(/sbin/mount) || { printf '%s\\n' \"$4\" >&2; exit 126; }; "
    "n='\n'; "
    'while [ "$1" != -- ]; do f=; set -f; IFS=$n; for l in $t; do '
    'case $l in *" on $1 ("*) f=; case $l in "$2 on $1 ($3"*) f=1;; esac;; esac; '
    "done; unset IFS; set +f; "
    '[ -n "$f" ] || { printf \'%s\\n\' "$4" >&2; exit 126; }; '
    "shift 4; done ) || exit 126; " + GUARDED_EXEC
)

# Marks the rows ``darwin_table_line`` prints after the mount table: a
# prefix and its real path.
DARWIN_POINT_MARK = "\x1epoint "

# What ``darwin_mountpoint_line`` exits with when a prefix needs a link
# only an administrator can make.
DARWIN_ADMIN_STATUS = 3

# Where macOS reads the root folders it makes at boot, and the tool that
# makes them without a reboot.
SYNTHETIC_CONF = "/etc/synthetic.conf"
APFS_UTIL = "/System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util"

# The PATH a Mac's lines look tools up on.
DARWIN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

# What a Mac's process lines read in place of ``/proc``: every process's
# arguments, a ``DARWIN_SPLIT`` line, then every process's parent, state,
# CPU times, sizes, start and command with its environment (``ps -E``).
# The first listing tells the environment from the arguments, so the run
# wrapper, which takes the tag as an argument, never counts. macOS shows
# no environment for its own programs, so a run is also known by its
# program's pid (``darwin_runs``). It fails when either listing does.
DARWIN_SPLIT = "--"
DARWIN_PS = (
    f"{{ LC_ALL=C ps -axww -o pid=,command= && echo {DARWIN_SPLIT} && "
    "LC_ALL=C ps -axwwE "
    "-o pid=,ppid=,state=,utime=,time=,vsz=,rss=,lstart=,command=; } 2>/dev/null"
)


def darwin_runs(exact: bool, show: Literal["ids", "programs", "rows"]) -> str:
    """The awk program that picks a run's processes out of ``DARWIN_PS``:
    those whose environment holds the tag in ``M``, those ``K`` names
    (``pid@start``) while each is still the process that started then,
    and those under any of them or under a root ``R`` names (``pid:tag``).

    Args:
        exact (bool): match ``M``'s whole tag, not any tag it starts.
        show (Literal["ids", "programs", "rows"]): what it prints: each
            pid with its start (``pid@start``), the pids whose parent was
            not picked, or a ``scan_line`` row each.
    """
    accept = f'ENVIRON["M"] == "{PROCESS}=" t' if exact else "1"
    shown = {
        "ids": 'for (p in tag) printf " %s@%s", p, st[p]',
        "programs": 'for (p in tag) if (!(up[p] in tag)) printf " %s", p',
        "rows": (
            'for (p in tag) { split(row[p], f, " "); s = substr(f[3], 1, 1); '
            'if (s == "I") s = "S"; else if (s == "U") s = "D"; '
            "u = cs(f[4]); c = cs(f[5]) - u; if (c < 0) c = 0; "
            'printf "%s %s %s %s %d %d %d %d %s %s %s %s %s %s\\n", tag[p], p, '
            'f[2], s, u, c, f[6] * 1024, int(f[7] * 1024 / ENVIRON["B"]), '
            "f[8], f[9], f[10], f[11], f[12], arg[p] }"
        ),
    }[show]
    return (
        'function cs(x,  n, a, i, v) { n = split(x, a, ":"); v = 0; '
        "for (i = 1; i <= n; i++) v = v * 60 + a[i]; return int(v * 100 + 0.5) } "
        'BEGIN { n = split(ENVIRON["R"], rs, " "); for (i = 1; i <= n; i++) { '
        'j = index(rs[i], ":"); root[substr(rs[i], 1, j - 1)] = substr(rs[i], j + 1) } '
        'n = split(ENVIRON["K"], ks, " "); for (i = 1; i <= n; i++) kp[ks[i]] = 1; '
        'm = " " ENVIRON["M"] } '
        f'!e {{ if ($0 == "{DARWIN_SPLIT}") e = 1; else {{ c = $0; '
        'sub(/^ *[0-9]+ /, "", c); arg[$1] = c } next } '
        "{ row[$1] = $0; up[$1] = $2; st[$1] = $8 $9 $10 $11 $12; "
        'if (($1 "@" st[$1]) in kp) tag[$1] = "@"; c = $0; '
        'for (j = 1; j <= 12; j++) sub(/^ *[^ ]+/, "", c); sub(/^ +/, "", c); '
        'a = arg[$1]; s = " "; if (a != "" && substr(c, 1, length(a)) == a) '
        's = substr(c, length(a) + 1) " "; k = 0; '
        "while ((i = index(substr(s, k + 1), m)) > 0) k += i; "
        f"if (k) {{ t = substr(s, k + {len(PROCESS) + 2}); "
        f't = substr(t, 1, index(t, " ") - 1); if ({accept}) tag[$1] = t }} }} '
        "END { for (p in row) if (!(p in tag)) { q = up[p]; d = 0; "
        'while (q != "" && d++ < 200) { if (q in tag) { got[p] = tag[q]; break } '
        "if (q in root) { got[p] = root[q]; break } q = up[q] } } "
        "for (p in root) if (p in row) got[p] = root[p]; "
        f"for (p in got) tag[p] = got[p]; {shown} }}"
    )


def darwin_roots(roots: Mapping[int, tuple[str, float]]) -> str:
    """The Mac words that set ``r`` to the ``pid:tag`` word of each of
    ``roots`` still the process that started then (``darwin_start``), for
    ``darwin_runs``'s ``R``.

    Args:
        roots (Mapping[int, tuple[str, float]]): each run's program, by
            its pid: its tag and start.
    """
    words = " ".join(
        single_quote(f"{pid}:{int(started)}:{tag}")
        for pid, (tag, started) in sorted(roots.items())
    )
    return (
        f"r=; for x in {words}; do p=${{x%%:*}}; y=${{x#*:}}; "
        f'[ "$({darwin_start("$p")} 2>/dev/null)" = "${{y%%:*}}" ] '
        '&& r="$r $p:${y#*:}"; done; '
    )


def darwin_start(pid: str) -> str:
    """The Mac command that prints when process ``pid`` started, in
    hundredths of a second since the epoch, from ``ps``'s start time, the
    way a Mac's scan counts (``scan_line``). Its words are double-quoted,
    so it nests in a single-quoted line.

    Args:
        pid (str): the process, as the shell names it.
    """
    return (
        'LC_ALL=C /bin/date -j -f "%a %b %e %T %Y" '
        f'"$(LC_ALL=C /bin/ps -o lstart= -p {pid})" +%s00'
    )


def mount_field(text: str, source: bool = False) -> str:
    """``text`` as ``/proc/mounts`` writes it in a field: space, tab,
    newline and backslash as octal escapes, and in a source ``#`` too.

    Args:
        text (str): a mountpoint or source.
        source (bool): ``text`` is a source.
    """
    escaped = " \t\n\\#" if source else " \t\n\\"
    return "".join(f"\\{ord(c):03o}" if c in escaped else c for c in text)


# Every process a run starts in a machine carries this variable, set to
# the id of the Mirage process the run is (``w1:9``), so a run cancelled
# midway, or one a lapsed workspace left, can be stopped in the box:
# stopping the client that started it does not reach the box everywhere
# (`docker exec` has no kill, and the daemon keeps draining the
# program's output, so a `yes` cut short by `head` would spin on). The id
# rides the environment because every process of a pipeline inherits it.
PROCESS = "MIRAGE_PROCESS"

# How long stopping a cancelled run may hold the cancel: the stop line's
# own second of grace, plus the exec's round trips. A box that stopped
# answering is given up on after it.
MACHINE_STOP_WAIT_SECONDS = 5.0

# What the check line prints first: a result without it is a line no
# shell there ran (a stopped container's exec answers with a status of
# its own), which says nothing of the machine's tools.
CHECK_MARK = "mirage-check"

# The line a check runs: true where Mirage can see and stop every process
# a program on the machine starts, by its ``PROCESS`` tag, which takes
# ``/proc`` and the ``tr`` and ``grep`` the scan and the stop line run, or
# on a Mac the ``ps`` and ``awk`` they run there.
CHECK_LINE = (
    f"echo {CHECK_MARK}; "
    "{ test -d /proc/self && command -v tr && command -v grep; } || "
    '{ test "$(uname -s)" = Darwin && command -v ps && command -v awk; }'
)

# How long a check may take: a machine that does not answer in it is
# unreachable.
CHECK_WAIT_SECONDS = 10.0

# How long a program a ``kill`` signalled may take to exit before it gets
# KILL, for its handlers to clean up: the stop line's same second.
STOP_GRACE_SECONDS = 1.0

# The state letters ``ps`` prints on a host that has others than Linux's:
# an idle process is a sleeping one, and macOS's U is Linux's D.
HOST_STATES = {"I": "S", "U": "D"}

# How far a host process's start, as ``ps`` prints it to the second, may
# be from when a run recorded starting it and still be that run's: past
# it the PID names another process, which a stop leaves alone.
HOST_START_SLACK_SECONDS = 2.0

# How often a stop in its grace checks whether the signalled group ended.
STOP_POLL_SECONDS = 0.02

# Where the stop line finds tr, grep and sleep: the config's PATH is for
# the programs it runs and may name none of the system's directories.
TOOLS_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# How often something waiting for a process a scan found looks at the
# machines, and how long a run's output must stay quiet, once its program
# has exited while what the program left running keeps the exec open,
# before the exec is let go.
RUN_WATCH_SECONDS = 2.0
RUN_DRAIN_SECONDS = 0.5

# How long a background run may take to report its pid, which ``$!`` waits
# for.
RUN_START_WAIT_SECONDS = 10.0

# The folder Mirage keeps its own files in on a machine, under the home of
# the user its lines run as; one per user in ``$TMPDIR`` (``/tmp``) only
# when that home cannot hold it (``machine_dir_line``). A process
# substitution a program names by path becomes a named pipe there, which
# Mirage feeds (``FIFO_NAME``).
MACHINE_DIR = ".mirage"
FIFO_NAME = "fd"

# Every program runs as a child of this wrapper, which outlives it to say
# how it ended, since an exec holds on while anything the program started
# keeps its output open (E2B, msb). ``$1`` is the run's own word, which no
# program's output can know to forge; ``$2`` to ``$4`` the words a program
# the machine cannot run is reported in (``PROGRAM_CHECK``); ``$5`` the
# tag's assignment, exported for the program alone so the wrapper shows in
# no scan and takes no signal by tag; then the program. The wrapper keeps
# every word positional, so it sets no name the program's environment
# would carry. The subshell execs the program, so the pid the wrapper
# writes is the program's, with its start in clock ticks, on stderr
# behind ``RUN_PID_MARK`` ahead of anything the program writes; once the
# program exits its status follows behind ``run_exit_mark``, so the exec
# that runs the program brings both back itself, and stdout ends what the
# program wrote with the same status behind ``run_done_mark``, so a reader
# knows when that output has all arrived. A program a signal ended gets no
# such line: its stdout may have no reader left (head took what it
# wanted), and a machine that keeps that pipe open past its exec (kubectl)
# would hold the wrapper on it, its words still in a scan. A shell reports
# a child a signal ended on its stderr, so the wrapper's goes nowhere and
# the program gets the real one back. It needs only a POSIX shell at
# ``/bin/sh``.
RUN_WRAPPER = (
    "exec 6>&2 2>/dev/null; "
    "( /bin/sh -c 'if read -r s </proc/$PPID/stat; then set -- ${s##*)}; "
    "t=${20}; else t=$(" + darwin_start("$PPID") + "); fi; "
    'printf "\\036mirage-pid %s %s\\n" "$PPID" "$t" >&6\' || exit $?; '
    'export "$5"; exec 2>&6 6>&-; '
    '( set -- "$2" "$3" "$4" "$6"; ' + PROGRAM_CHECK + " ) || exit $?; "
    'shift 5; exec "$@" ); '
    's=$?; [ "$s" -gt 128 ] || printf "\\036mirage-done %s %s\\n" "$1" "$s"; '
    'printf "\\036mirage-exit %s %s\\n" "$1" "$s" >&6; exit "$s"'
)

# ``RUN_WRAPPER`` for a program whose stderr goes where its stdout goes
# (``2>&1``): the program, and the check that reports one the machine
# cannot run, write stderr into stdout, as bash's redirect makes them, so
# the two keep the order the program wrote them in.
RUN_WRAPPER_JOINED = RUN_WRAPPER.replace(
    "exec 2>&6 6>&-; ", "exec 2>&1 6>&-; ", 1
)

# Where a run's program starts in what ``run_argv`` builds: past
# ``/bin/sh -c RUN_WRAPPER sh``, the run's own word, the three words a
# program it cannot run is reported in, and the tag's assignment.
RUN_PROGRAM_AT = 9

# The marks ahead of the pid line and the exit line the wrapper writes on
# stderr, a record separator first so no program's output starts with it.
RUN_PID_MARK = b"\x1emirage-pid "
RUN_EXIT_MARK = b"\x1emirage-exit "
# The mark ahead of the line that ends a program's stdout.
RUN_DONE_MARK = b"\x1emirage-done "
# The most digits an exit status has, 0 to 255.
EXIT_DIGITS = 3
# How much of stderr may come ahead of that line, the exec client's own
# words, before a run is taken to have written none.
RUN_PID_HOLD = 4096

# Output as base64 lines per read, status on fd 3, for an exec that returns text.
ENCODE_PRELUDE = (
    f"e() {{ PATH={TOOLS_PATH}; "
    'while c=$(dd bs=65536 count=1 2>/dev/null | base64) && [ -n "$c" ]; '
    "do printf '%s\\n' \"$c\"; done; }; "
    f"(PATH={TOOLS_PATH}; command -v dd && command -v base64) >/dev/null || "
    "{ echo 'mirage: the machine needs dd and base64 to return output' >&2; "
    "exit 127; }; "
)
ENCODE_OUTPUT = ENCODE_PRELUDE + (
    'exec 4>&1 5>&2; s=$( { { { "$@" 3>&- 4>&- 5>&-; echo $? >&3; } '
    '| e >&4; } 2>&1 | e >&5; } 3>&1 ); exit "$s"'
)
# For an exec that returns one combined stream: stderr joins stdout first.
ENCODE_COMBINED = ENCODE_PRELUDE + (
    'exec 4>&1; s=$( { { "$@" 2>&1 3>&- 4>&-; echo $? >&3; } '
    '| e >&4; } 3>&1 ); exit "$s"'
)

BASE64_LINE = re.compile(
    r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?"
)


def encode_output(line: str, combined: bool = False) -> str:
    """``line`` run so its output comes back as base64 lines, which an
    exec that decodes output as text leaves intact (``ENCODE_OUTPUT``).

    Args:
        line (str): the command, as ``wrap_line`` builds it.
        combined (bool): encode stderr with stdout as one stream, for an
            exec that returns them combined.
    """
    script = ENCODE_COMBINED if combined else ENCODE_OUTPUT
    return f"/bin/sh -c {single_quote(script)} sh {line}"


def decode_output(text: str) -> bytes:
    """The bytes an ``encode_output`` command wrote, from whole lines of
    its output. A blank line adds nothing; a line that is not base64,
    which only the machine's own shell writes (the encoder missing), comes
    back as it is, with its newline.

    Args:
        text (str): whole lines of the command's output.
    """
    out = bytearray()
    for line in text.split("\n"):
        word = line.strip()
        if BASE64_LINE.fullmatch(word):
            out += base64.b64decode(word)
        else:
            out += f"{line}\n".encode()
    return bytes(out)


def wrap_line(argv: Sequence[str], env: Mapping[str, str], cwd: str) -> str:
    """The command line for a machine whose exec takes one (ssh, e2b,
    daytona): cwd, env, then the argv.

    Such an exec has no docker-style ``-w``/``-e`` to trust: SSH's env
    channel is AcceptEnv-gated server-side, so it silently drops names,
    and an SDK's own cwd fails a missing directory in its own words. So
    the working directory and the merged environment ride the command
    itself: the prelude every machine runs a command under enters
    ``cwd`` (exit 126 when the machine lacks it), then
    ``env 'K=V' ... 'prog' 'arg'``; a shell line is the argv
    ``/bin/sh -c line``. Every piece is single-quoted for sh, so the
    shell the exec starts reads each as one word whatever it holds; the
    machine only needs a POSIX shell at ``/bin/sh``.

    Args:
        argv (Sequence[str]): the program and its arguments.
        env (Mapping[str, str]): the merged environment.
        cwd (str): the working directory, passed through verbatim.
    """
    parts = [
        "/bin/sh",
        "-c",
        single_quote(EXEC_PRELUDE),
        "sh",
        single_quote(cwd),
    ]
    parts += ["env"]
    parts += [single_quote(f"{key}={value}") for key, value in env.items()]
    parts += [single_quote(word) for word in argv]
    return " ".join(parts)


# What the stop line exits with when no process carries the run's id: the
# box it ran in holds nothing of the run.
NOT_RUNNING_STATUS = 3

# The signal a run gets once the reader of its output has gone, as a pipe's
# writer does: a machine that keeps a program past its exec stream (kubectl)
# would otherwise leave it running.
PIPE_SIGNAL = 13


def stop_line(
    process: str, signum: int = 15, root: MachinePid | None = None
) -> str:
    """The shell line that stops every process of the run ``process``
    tags.

    Each process whose environment holds the tag, found through
    ``/proc``, gets ``signum``, and what still runs a second later gets
    KILL, so a program that ignores it stops too. The tag is matched as
    a whole entry, so ``w1:9`` never stops the run of ``w1:90``. The line
    exits 0 once it stopped them and ``NOT_RUNNING_STATUS`` when there were
    none. It looks tr and grep up on its own PATH (``TOOLS_PATH``) and
    exits 127 without them, so it needs only a POSIX shell, tr, grep and
    ``/proc``.

    A Mac hides most environments, so there the run is ``root`` and what
    runs under it (``darwin_runs``), each process kept by its pid and
    start once found, so one whose parent exits stays in the run. A ``ps``
    that fails before it found any, or on the last look, exits 1, so KILL
    never reaches a pid the last ``ps`` did not check.

    A hangup (``HANGUP_SIGNAL``) is what a dropped terminal sends: on
    Linux it reaches only the processes still in ``root``'s session, so
    one that left it with ``setsid`` keeps running, and no KILL follows,
    so one that ignores it (``nohup``) keeps running too. CONT follows
    it, as the kernel's own hangup sends it, so a stopped process takes
    the hangup instead of holding it. Once ``root`` has exited its
    session can no longer be read, so the hangup reaches a process only
    when its session's leader is ``root`` or a live process outside the
    run: a session another process of the run leads, or whose leader has
    exited, is what ``setsid`` leaves.

    Args:
        process (str): the id of the Mirage process the run is, as
            ``PROCESS`` carries it.
        signum (int): the first signal, TERM (15) unless a ``kill``
            named another.
        root (MachinePid | None): the run's program, as its wrapper
            reported it; None when it did not.
    """
    mark = single_quote(f"{PROCESS}={process}")
    mine = {root.pid: (process, root.started)} if root is not None else {}
    hangup = signum == HANGUP_SIGNAL
    own = (
        f"z={root.pid}; sid $z && s=$q || g=1; "
        if hangup and root is not None
        else ""
    )
    end = (
        "kill -CONT $l 2>/dev/null; exit 0"
        if hangup
        else "for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.1; left || exit 0; "
        'done; [ -z "$f" ] || exit 1; kill -KILL $l 2>/dev/null; true'
    )
    return (
        f"m={mark}; f=; s=; g=; if [ -d /proc/self ]; then "
        f"PATH={TOOLS_PATH}; "
        "command -v tr >/dev/null || exit 127; "
        "command -v grep >/dev/null || exit 127; "
        'sid() { q=; read -r t 2>/dev/null < "/proc/$1/stat" || return 1; '
        't=${t##*")"}; set -- $t; q=$4; }; '
        f"{own}"
        "left() { a=; l=; for p in /proc/[0-9]*; do "
        "tr '\\000' '\\n' < \"$p/environ\" 2>/dev/null | grep -qxF \"$m\" "
        '&& a="$a ${p#/proc/}"; done; '
        'for p in $a; do if [ -n "$s" ]; then '
        '{ sid $p && [ "$q" = "$s" ]; } || continue; '
        'elif [ -n "$g" ]; then sid $p || continue; '
        'if [ "$q" != "$z" ]; then [ -d "/proc/$q" ] || continue; '
        'case " $a " in *" $q "*) continue ;; esac; fi; fi; '
        'l="$l $p"; done; [ -n "$l" ]; }; '
        f"else PATH={DARWIN_PATH}; k=; l=; {darwin_roots(mine)}"
        f"left() {{ o=$({DARWIN_PS}) || "
        '{ [ -n "$l" ] || exit 1; f=1; return 0; }; f=; '
        'k=$(printf \'%s\\n\' "$o" | M="$m" R="$r" K="$k" awk '
        f"'{darwin_runs(True, 'ids')}'); r=; l=; "
        'for w in $k; do l="$l ${w%%@*}"; done; [ -n "$l" ]; }; fi; '
        f"left || exit {NOT_RUNNING_STATUS}; kill -{signum} $l 2>/dev/null; "
        f"{end}"
    )


# How long a scan may take: a machine that does not answer in it shows
# the processes the last scan found.
SCAN_WAIT_SECONDS = 10.0

# What each row a scan prints starts with, so a provider that mixes the
# line's stderr into its stdout (Daytona) never passes a message for one:
# a process, or the machine's figures.
SCAN_MARK = "M"
SCAN_FACTS_MARK = "F"


def machine_dir_line(prefixes: Sequence[str]) -> str:
    """The shell words that set ``d`` to Mirage's folder on the machine
    (``MACHINE_DIR``), made if need be, the line's user's own and no one
    else's to write in: under that user's home, else beside it in
    ``$TMPDIR`` or ``/tmp``. A place under a workspace prefix is passed
    over, since a mount there would cover what Mirage keeps, and so is a
    symlink. A line that finds no place exits 1 there.

    Args:
        prefixes (Sequence[str]): the workspace prefixes the machine has
            at the same paths (``served_prefixes``).
    """
    covered = "|".join(
        single_quote(prefix.rstrip("/") + "/") + "*" for prefix in prefixes
    )
    skip = f'case "$c/" in ({covered}) continue;; esac; ' if covered else ""
    return (
        f"d=$(PATH={TOOLS_PATH}; u=$(id -u); "
        f'for c in ${{HOME:+"$HOME/{MACHINE_DIR}"}} '
        f'"${{TMPDIR:-/tmp}}/{MACHINE_DIR}-$u" "/tmp/{MACHINE_DIR}-$u"; do '
        f"{skip}"
        'mkdir -p -m 700 "$c" 2>/dev/null && [ ! -L "$c" ] && [ -O "$c" ] && '
        'chmod 700 "$c" 2>/dev/null && [ -w "$c" ] && '
        '{ printf %s "$c"; break; }; done); '
        f'[ -n "$d" ] || {{ echo "mirage: no folder of its own for {MACHINE_DIR}" >&2; '
        "exit 1; }; "
    )


def fifo_line(name: str, prefixes: Sequence[str]) -> str:
    """The shell line that makes a named pipe in Mirage's folder on the
    machine (``machine_dir_line``) and prints its path.

    Args:
        name (str): the pipe's own part of its name.
        prefixes (Sequence[str]): the workspace prefixes the machine has
            at the same paths.
    """
    return (
        machine_dir_line(prefixes)
        + f'p="$d/{FIFO_NAME}-{name}"; mkfifo -m 600 "$p" && printf %s "$p"'
    )


def run_argv(
    tag: str,
    nonce: str,
    argv: Sequence[str],
    missing: tuple[str, str, str] = ("", "command not found", ""),
    joined: bool = False,
) -> tuple[str, ...]:
    """``argv`` under the wrapper every program runs in (``RUN_WRAPPER``).

    Args:
        tag (str): the run's tag.
        nonce (str): the run's own word, which its exit line carries
            (``run_exit_mark``).
        argv (Sequence[str]): the program and its arguments.
        missing (tuple[str, str, str]): the words a program the machine
            cannot run is reported in (``PROGRAM_CHECK``).
        joined (bool): the program writes its stderr into its stdout
            (``RUN_WRAPPER_JOINED``).
    """
    return (
        "/bin/sh",
        "-c",
        RUN_WRAPPER_JOINED if joined else RUN_WRAPPER,
        "sh",
        nonce,
        *missing,
        f"{PROCESS}={tag}",
        *argv,
    )


def run_done_mark(nonce: str) -> bytes:
    """What the line that ends one run's stdout starts with:
    ``RUN_DONE_MARK`` and the run's own word (``run_exit_mark``).

    Args:
        nonce (str): the run's own word (``run_argv``).
    """
    return RUN_DONE_MARK + nonce.encode() + b" "


def run_exit_mark(nonce: str) -> bytes:
    """What one run's exit line starts with: ``RUN_EXIT_MARK`` and the
    run's own word, so a program that writes the mark itself ends
    nothing.

    Args:
        nonce (str): the run's own word (``run_argv``).
    """
    return RUN_EXIT_MARK + nonce.encode() + b" "


def is_run(argv: Sequence[str]) -> bool:
    """Whether ``argv`` is a program's run, which a stop by its tag ends,
    not one of Mirage's own lines (``run_argv``).

    Args:
        argv (Sequence[str]): what an exec is given.
    """
    return len(argv) > 2 and argv[2] in (RUN_WRAPPER, RUN_WRAPPER_JOINED)


def run_tag(argv: Sequence[str]) -> str:
    """The tag a program's run carries (``run_argv``).

    Args:
        argv (Sequence[str]): what ``run_argv`` built.
    """
    return argv[RUN_PROGRAM_AT - 1].partition("=")[2]


# ``scan_line`` on a Mac: the same rows from ``DARWIN_PS``, in Linux's
# units. A start counts hundredths of a second since the epoch
# (``darwin_start``), so the figures row gives the time now as the
# seconds since boot and 100 clock ticks a second; idle (``I``) and
# uninterruptible (``U``) read as Linux's ``S`` and ``D``.
DARWIN_SCAN = (
    f"PATH={DARWIN_PATH}; o=$({DARWIN_PS}) || exit 1; "
    "b=$(pagesize 2>/dev/null) || b=4096; "
    "k=$(sysctl -n hw.memsize 2>/dev/null) || k=0; "
    f'printf \'{SCAN_FACTS_MARK} %s 100 %s %s\\n\' "$(date +%s)" "$b" "$((k / 1024))"; '
    "printf '%s\\n' \"$o\" | "
    f'M="$m" R="$r" B="$b" awk \'{darwin_runs(False, "rows")}\' | '
    "while read -r t p q s u c v z d m n h y a; do "
    "e=$(LC_ALL=C date -j -f '%a %b %e %T %Y' \"$d $m $n $h $y\" +%s00 "
    "2>/dev/null) || continue; "
    f"printf '{SCAN_MARK} %s %s %s %s %s %s %s %s %s %s\\n' "
    '"$t" "$p" "$q" "$e" "$s" "$u" "$c" "$v" "$z" "$a"; done; true'
)


def scan_line(
    workspace: str, roots: Mapping[int, tuple[str, float]] | None = None
) -> str:
    """The shell line that lists every process the runs of ``workspace``
    started on a machine.

    Each process whose ``PROCESS`` tag names one of the workspace's
    processes, found through ``/proc``, prints one row: ``SCAN_MARK``,
    the tag, its pid, its parent's pid, when it started in clock ticks
    after boot (``stat``'s 22nd field), its state letter (``stat``'s
    third), its CPU time in user and system mode, its virtual size and
    resident pages (``stat``'s 14th, 15th, 23rd and 24th) and its
    arguments, space separated. A process that exits mid-scan is skipped.
    One row, ``SCAN_FACTS_MARK``, gives what turns those into
    usage: seconds since boot, clock ticks a second, the page size and
    the machine's memory in KiB. Nothing else is printed. It needs what
    ``stop_line`` does. A Mac is read with ``ps`` (``DARWIN_SCAN``), each
    run known by its program, as ``stop_line`` knows it there.

    Args:
        workspace (str): the workspace's id, which every tag starts
            with.
        roots (Mapping[int, tuple[str, float]] | None): each run's
            program on the machine, by its pid: its tag and start.
    """
    mark = single_quote(f"{PROCESS}={workspace}:")
    return (
        f"m={mark}; if [ ! -d /proc/self ]; then {darwin_roots(roots or {})}"
        f"{DARWIN_SCAN}; exit 0; fi; "
        f"PATH={TOOLS_PATH}; "
        "read -r u _ 2>/dev/null </proc/uptime; "
        "h=$(getconf CLK_TCK 2>/dev/null) || h=100; "
        "b=$(getconf PAGESIZE 2>/dev/null) || b=4096; "
        "k=$(grep -m1 '^MemTotal:' /proc/meminfo 2>/dev/null); "
        "set -- $k; "
        f"printf '{SCAN_FACTS_MARK} %s %s %s %s\\n' "
        '"$u" "$h" "$b" "$2"; '
        "for p in /proc/[0-9]*; do "
        "t=$(tr '\\000' '\\n' 2>/dev/null < \"$p/environ\" "
        f"| grep -m1 '^{PROCESS}=') || continue; "
        'case $t in "$m"*) ;; *) continue ;; esac; '
        's=$(cat "$p/stat" 2>/dev/null) || continue; '
        "set -- ${s##*)}; "
        f"printf '{SCAN_MARK} %s %s %s %s %s %s %s %s %s %s\\n' "
        f'"${{t#{PROCESS}=}}" "${{p#/proc/}}" "$2" "${{20}}" "$1" '
        '"${12}" "${13}" "${21}" "${22}" '
        "\"$(tr '\\000\\n' '  ' 2>/dev/null < \"$p/cmdline\")\"; "
        "done; true"
    )


# Marks the rows ``resources_line`` prints, so what a provider mixes in
# is left out.
RESOURCE_MARK = "X"

# How long a machine has to say what it holds.
RESOURCE_WAIT_SECONDS = 10.0

# How far apart the two reads of the processors' time are.
CPU_SAMPLE_SECONDS = 1


def resources_line(cpu: bool) -> str:
    """The shell line that prints what a Linux machine holds, a row
    each, ``RESOURCE_MARK`` first: its name, ``lscpu``'s rows, processors,
    clock, load, uptime, users and each ``/proc/meminfo`` entry. Asked
    for ``cpu`` it also reads the processors' time twice
    ``CPU_SAMPLE_SECONDS`` apart, as one read says nothing of now, and
    each process's state letter. It
    needs a POSIX shell, ``/proc``, ``date`` and ``grep``; ``nproc``,
    ``who`` and ``lscpu`` where the machine has them.

    Args:
        cpu (bool): read the processors' time and the process states.
    """
    mark = RESOURCE_MARK
    sample = (
        (
            "read -r a 2>/dev/null </proc/stat; "
            f"sleep {CPU_SAMPLE_SECONDS}; "
            "read -r b 2>/dev/null </proc/stat; "
            f"printf '{mark} before %s\\n' \"$a\"; "
            f"printf '{mark} after %s\\n' \"$b\"; "
            "t=; for f in /proc/[0-9]*/stat; do "
            'IFS= read -r s 2>/dev/null <"$f" || continue; '
            "s=${s##*) }; t=$t${s%% *}; done; "
            f"printf '{mark} states %s\\n' \"$t\"; "
        )
        if cpu
        else ""
    )
    return (
        f"PATH={TOOLS_PATH}; "
        "read -r h 2>/dev/null </proc/sys/kernel/hostname; "
        f"printf '{mark} host %s\\n' \"$h\"; "
        "LC_ALL=C lscpu 2>/dev/null | while IFS= read -r c; do "
        f"printf '{mark} lscpu %s\\n' \"$c\"; done; "
        "n=$(nproc 2>/dev/null) || n=$(grep -c ^processor /proc/cpuinfo); "
        "a=$(nproc --all 2>/dev/null) || a=$n; "
        f'printf \'{mark} cpus %s %s\\n\' "$n" "$a"; '
        f"printf '{mark} clock %s\\n' \"$(date '+%s %H:%M:%S %z')\"; "
        "read -r l 2>/dev/null </proc/loadavg; "
        f"printf '{mark} load %s\\n' \"$l\"; "
        "read -r u _ 2>/dev/null </proc/uptime; "
        f"printf '{mark} up %s\\n' \"$u\"; "
        f"printf '{mark} users %s\\n' \"$(who 2>/dev/null | grep -c .)\"; "
        "while read -r k v _; do "
        f'printf \'{mark} mem %s %s\\n\' "$k" "$v"; '
        "done </proc/meminfo; " + sample + "true"
    )


def darwin_resources_line(cpu: bool) -> str:
    """The shell line that prints what a Mac holds, which has no
    ``/proc``, a row each as ``resources_line`` does, from ``sysctl``,
    ``vm_stat`` and, asked for ``cpu``, two reads of ``top``.

    Args:
        cpu (bool): read the processors' time and the process counts.
    """
    mark = RESOURCE_MARK
    sample = (
        (
            f"top -l 2 -n 0 -s {CPU_SAMPLE_SECONDS} 2>/dev/null | "
            "grep -E '^(Processes|CPU usage)' | tail -n 2 | "
            "while IFS= read -r l; do "
            f"printf '{mark} top %s\\n' \"$l\"; done; "
        )
        if cpu
        else ""
    )
    return (
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin; "
        "n=$(sysctl -n hw.ncpu); "
        f"printf '{mark} host %s\\n' \"$(hostname)\"; "
        f"printf '{mark} lscpu %-41s%s\\n' Architecture: \"$(uname -m)\"; "
        f"printf '{mark} lscpu %-41s%s\\n' 'CPU(s):' \"$n\"; "
        f"printf '{mark} lscpu %-41s%s\\n' 'Model name:' "
        '"$(sysctl -n machdep.cpu.brand_string)"; '
        f'printf \'{mark} cpus %s %s\\n\' "$n" "$n"; '
        f"printf '{mark} clock %s\\n' \"$(date '+%s %H:%M:%S %z')\"; "
        f"printf '{mark} load %s\\n' \"$(sysctl -n vm.loadavg)\"; "
        f"printf '{mark} boot %s\\n' \"$(sysctl -n kern.boottime)\"; "
        f"printf '{mark} users %s\\n' \"$(who 2>/dev/null | grep -c .)\"; "
        f"printf '{mark} memsize %s\\n' \"$(sysctl -n hw.memsize)\"; "
        f"printf '{mark} swap %s\\n' \"$(sysctl -n vm.swapusage)\"; "
        "vm_stat | while IFS= read -r l; do "
        f"printf '{mark} vm %s\\n' \"$l\"; done; " + sample + "true"
    )


def machine_resources_line(cpu: bool) -> str:
    """The shell line that says what a machine holds:
    ``resources_line`` where it has ``/proc``, ``darwin_resources_line``
    on a Mac, which has none.

    Args:
        cpu (bool): read the processors' time and the process states.
    """
    return (
        f"if [ -r /proc/meminfo ]; then {resources_line(cpu)}; "
        f"else {darwin_resources_line(cpu)}; fi"
    )


def signal_line(target: str | MachinePid, signum: int) -> str:
    """The shell line that sends ``signum`` to one process on a machine,
    as ``kill`` sent it.

    A tag names the program its run started: the process carrying it
    whose parent carries none. A MachinePid names its pid while that is
    the process that started then. A Mac is read with ``ps``
    (``darwin_runs``, ``darwin_start``). The line exits 0 once it sent the
    signal and ``NOT_RUNNING_STATUS`` when no such process runs.

    Args:
        target (str | MachinePid): the run's tag, or the process.
        signum (int): the signal.
    """
    if isinstance(target, MachinePid):
        pid = target.pid
        started = int(target.started)
        return (
            f"if [ -d /proc/self ]; then PATH={TOOLS_PATH}; "
            f"s=$(cat /proc/{pid}/stat 2>/dev/null) || exit {NOT_RUNNING_STATUS}; "
            "set -- ${s##*)}; "
            f'[ "${{20}}" = {started} ] || exit {NOT_RUNNING_STATUS}; '
            f"else PATH={DARWIN_PATH}; "
            f'[ "$({darwin_start(str(pid))} 2>/dev/null)" = {started} ] '
            f"|| exit {NOT_RUNNING_STATUS}; fi; "
            f"kill -{signum} {pid} 2>/dev/null || exit {NOT_RUNNING_STATUS}"
        )
    mark = single_quote(f"{PROCESS}={target}")
    return (
        f"m={mark}; if [ ! -d /proc/self ]; then PATH={DARWIN_PATH}; "
        f"k=$({DARWIN_PS} | M=\"$m\" awk '{darwin_runs(True, 'programs')}'); "
        f'[ -n "$k" ] || exit {NOT_RUNNING_STATUS}; kill -{signum} $k 2>/dev/null; '
        "exit 0; fi; "
        f"PATH={TOOLS_PATH}; l=' '; r=; "
        "for p in /proc/[0-9]*; do "
        "tr '\\000' '\\n' 2>/dev/null < \"$p/environ\" "
        '| grep -qxF "$m" || continue; '
        's=$(cat "$p/stat" 2>/dev/null) || continue; set -- ${s##*)}; '
        'l="$l${p#/proc/} "; r="$r ${p#/proc/}:$2"; done; '
        'k=; for e in $r; do case $l in *" ${e#*:} "*) ;; '
        '*) k="$k ${e%%:*}" ;; esac; done; '
        f'[ -n "$k" ] || exit {NOT_RUNNING_STATUS}; kill -{signum} $k 2>/dev/null; true'
    )


# How long a machine gets to answer the libfaketime probe, which every run
# waiting on it shares.
FAKETIME_PROBE_SECONDS = 30

# Where Linux distributions install libfaketime, which a process reads a
# workspace's system time through, on this host or in a machine.
FAKETIME_LIBRARIES = (
    "/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1",
    "/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1",
    "/usr/lib64/faketime/libfaketime.so.1",
    "/usr/lib/faketime/libfaketime.so.1",
    "/usr/local/lib/faketime/libfaketime.so.1",
)


def faketime_env(library: str, env: Mapping[str, str]) -> dict[str, str]:
    """What has a process read the running workspace's system time
    through the libfaketime at ``library``: the time now, in epoch
    seconds to the millisecond, which its clock and its children's run
    on from, whatever the machine's own clock or zone; the monotonic
    clock and file dates, which the workspace already gives, left
    alone. Empty when the workspace keeps the host's time. Mirrors
    TypeScript's ``faketimeEnv``.

    Args:
        library (str): the libfaketime path where the process runs.
        env (Mapping[str, str]): the process's environment, whose
            ``LD_PRELOAD`` libraries load after libfaketime.
    """
    if bound_system_clock() is None:
        return {}
    preload = env.get("LD_PRELOAD")
    return {
        "LD_PRELOAD": f"{library}:{preload}" if preload else library,
        "FAKETIME": f"@{system_now():.3f}",
        "FAKETIME_FMT": "%s",
        "FAKETIME_DONT_RESET": "1",
        "FAKETIME_DONT_FAKE_MONOTONIC": "1",
        "NO_FAKE_STAT": "1",
    }


def faketime_probe() -> str:
    """A shell line that prints the first of ``FAKETIME_LIBRARIES`` a
    machine holds, and nothing when it holds none. Mirrors TypeScript's
    ``faketimeProbe``."""
    paths = " ".join(single_quote(path) for path in FAKETIME_LIBRARIES)
    return (
        f'for p in {paths}; do if [ -f "$p" ]; then echo "$p"; break; fi; done'
    )
