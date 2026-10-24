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

from collections.abc import Mapping, Sequence

from mirage.process.handle import ProcessHandle
from mirage.runtime.types import MountType
from mirage.utils.quote import single_quote


def sdk_install_hint(name: str) -> str:
    """The message shown when a provider SDK extra is missing.

    Args:
        name (str): the runtime name, which is also its pip extra
            (daytona, e2b).
    """
    return (
        f"the {name} runtime needs the {name} SDK; install with: "
        f"pip install mirage-ai[{name}]"
    )


def not_running_hint(
    noun: str,
    name: str,
    state: str,
    hints: Mapping[str, str],
    otherwise: str | None = None,
) -> str:
    """Why a sandbox cannot take a line, named by the state its status
    command reported.

    Args:
        noun (str): what the provider calls it (container, machine,
            sandbox).
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
    """The signal a ``kill`` stopped ``runner`` with, when a program may
    handle it: None for KILL, or for a run no ``kill`` stopped, which is
    killed at once.

    Args:
        runner (ProcessHandle | None): the caller's runner, if any.
    """
    if runner is None or runner.signal in (None, 9):
        return None
    return runner.signal


MOUNT_TYPES: tuple[MountType, ...] = ("ssh", "fuse", "both")

# How long a sandbox has to show a served prefix as mounted, and how
# often it is asked.
MOUNT_WAIT_SECONDS = 15.0
MOUNT_POLL_SECONDS = 0.1

# How long a served prefix's SFTP server may take to end once its
# sandbox side is unmounted.
UNMOUNT_WAIT_SECONDS = 5.0

# How much of a pipe helper's stderr is kept to say why a mount failed,
# and how long a helper still running has to finish saying it.
PIPE_DIAGNOSTIC_BYTES = 16384
PIPE_DIAGNOSTIC_WAIT_SECONDS = 1.0

# sshfs keeps no copy of its own: every listing, stat and read asks the
# host, so a file the host changes, or a profile now hides, shows at
# once, and a file whose size the backend does not know reads whole
# (direct_io), as the workspace's own FUSE mounts do.
SSHFS_OPTIONS = (
    "passive,dir_cache=no,direct_io,"
    "attr_timeout=0,entry_timeout=0,negative_timeout=0"
)

# Where sshfs writes its errors in the sandbox, one file per prefix; its
# stdout is the SFTP stream, so its stderr cannot share the pipe.
SSHFS_LOG_PREFIX = "/tmp/.mirage_sshfs"

SSHFS_HINT = (
    "serving the workspace into a sandbox needs sshfs there; "
    "install it in the image (apt-get install sshfs)"
)
PIPE_SERVER_HINT = (
    "serving the workspace into a sandbox needs asyncssh; "
    "install with: pip install mirage-ai[ssh]"
)

# Every argv a sandbox runs goes under this POSIX sh prelude, with the
# cwd as $1: a provider program's exec passes `-w /` (exec_args), and a
# provider whose exec takes one command line dresses it (wrap_line), so
# no provider's own cwd is used. An exec's `-e` can append to the image's
# environment rather than replace a name it already sets, `-w` can
# create a missing directory, and an SDK's cwd fails a missing one its
# own way (E2B: exit 1). sh imports the environment last-wins, `cd`
# fails loud (126) on a cwd the sandbox does not serve, and `exec` hands
# over the argv unchanged. `cd` runs without CDPATH, so a relative cwd
# resolves from `/` and prints nothing, while the program still sees the
# guest's own CDPATH. The shell is named by path, /bin/sh, since the
# command's PATH is the session's and may hold no sh; the argv after the
# prelude is still found on it.
EXEC_PRELUDE = 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"'

# Every process a run starts in a sandbox carries this variable, set to
# the run's own id, so a run cancelled midway can be stopped in the box:
# stopping the client that started it does not reach the box everywhere
# (`docker exec` has no kill, and the daemon keeps draining the
# program's output, so a `yes` cut short by `head` would spin on). The id
# rides the environment because every process of a pipeline inherits it.
EXEC_ID = "MIRAGE_EXEC_ID"

# How long stopping a cancelled run may hold the cancel: the stop line's
# own second of grace, plus the exec's round trips. A box that stopped
# answering is given up on after it.
REAP_WAIT_SECONDS = 5.0

# How long a program a ``kill`` signalled may take to exit before it gets
# KILL, for its handlers to clean up: the stop line's same second.
STOP_GRACE_SECONDS = 1.0

# How often a stop in its grace checks whether the signalled group ended.
STOP_POLL_SECONDS = 0.02

# Where the stop line finds grep and sleep: the config's PATH is for the
# programs it runs and may name none of the system's directories.
REAP_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def wrap_line(argv: Sequence[str], env: Mapping[str, str], cwd: str) -> str:
    """The command line for a sandbox whose exec takes one (ssh, e2b,
    daytona): cwd, env, then the argv.

    Such an exec has no docker-style ``-w``/``-e`` to trust: SSH's env
    channel is AcceptEnv-gated server-side, so it silently drops names,
    and an SDK's own cwd fails a missing directory in its own words. So
    the working directory and the merged environment ride the command
    itself: the prelude every sandbox runs a command under enters
    ``cwd`` (exit 126 when the sandbox lacks it), then
    ``env 'K=V' ... 'prog' 'arg'``; a shell line is the argv
    ``/bin/sh -c line``. Every piece is single-quoted for sh, so the
    shell the exec starts reads each as one word whatever it holds; the
    sandbox only needs a POSIX shell at ``/bin/sh``.

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


def reap_line(exec_id: str, signum: int = 15) -> str:
    """The shell line that stops every process of the run ``exec_id``.

    Each process whose environment holds the run's id, found through
    ``/proc``, gets ``signum``, and what still runs a second later gets
    KILL, so a program that ignores it stops too. The line looks grep up
    on its own PATH (``REAP_PATH``) and exits 127 without it, so it
    needs only a POSIX shell, grep and ``/proc``.

    Args:
        exec_id (str): the run's id, as ``EXEC_ID`` carries it.
        signum (int): the first signal, TERM (15) unless a ``kill``
            named another.
    """
    mark = single_quote(f"{EXEC_ID}={exec_id}")
    return (
        f"PATH={REAP_PATH}; command -v grep >/dev/null || exit 127; "
        f"m={mark}; "
        "left() { l=; for p in /proc/[0-9]*; do "
        'grep -qs "$m" "$p/environ" && l="$l ${p#/proc/}"; done; '
        '[ -n "$l" ]; }; '
        f"left || exit 0; kill -{signum} $l 2>/dev/null; "
        "for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.1; left || exit 0; done; "
        "kill -KILL $l 2>/dev/null; true"
    )
