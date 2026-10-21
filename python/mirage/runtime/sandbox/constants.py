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
# cwd as $1: a provider CLI's exec passes `-w /` (exec_args), and a
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


def wrap_line(line: str, env: dict[str, str], cwd: str) -> str:
    """The line dressed for a sandbox whose exec takes one command line
    (ssh, e2b, daytona): cwd, env, then sh.

    Such an exec has no docker-style ``-w``/``-e`` to trust: SSH's env
    channel is AcceptEnv-gated server-side, so it silently drops names,
    and an SDK's own cwd fails a missing directory in its own words. So
    the working directory and the merged environment ride the command
    itself: the prelude every sandbox runs a command under enters
    ``cwd`` (exit 126 when the sandbox lacks it), then
    ``env 'K=V' ... /bin/sh -c 'line'``. Every piece is single-quoted for sh,
    so the shell the exec starts reads each as one word whatever it
    holds; the sandbox only needs a POSIX shell at ``/bin/sh``.

    Args:
        line (str): the raw shell line.
        env (dict[str, str]): the merged environment.
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
    parts += ["/bin/sh", "-c", single_quote(line)]
    return " ".join(parts)
