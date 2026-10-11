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

import shlex
import uuid

from mirage.runtime.types import MountType

# Providers whose exec API has no stdin stream (Daytona) upload
# piped bytes to a per-invocation file and redirect it into the line.
STDIN_PREFIX = "/tmp/.mirage_stdin"


def stdin_path() -> str:
    """A unique in-sandbox path for one invocation's stdin bytes.

    Unique per invocation so concurrent lines on the same runtime
    never overwrite each other's payload.
    """
    return f"{STDIN_PREFIX}_{uuid.uuid4().hex}"


def stdin_redirect(line: str, path: str) -> str:
    """The line rewritten to read its stdin from an uploaded file.

    Runs the line in a subshell with stdin redirected from ``path``,
    removes the file afterward, and preserves the line's exit code.
    Daytona uses this when its exec API has no stdin stream; a PTY
    would merge streams and mangle bytes.

    Known limitations, all inherent to the file transport:
    - stdin is fully buffered and uploaded before the line starts;
      nothing is streamed, so no interactive stdin.
    - the bytes briefly touch the sandbox's /tmp, readable by other
      processes in the sandbox and left behind if the exec dies
      before the ``rm`` runs (a later line's unique path is never
      affected).
    - each stdin line costs two extra provider API calls (mkdir +
      upload).
    - the sandbox must have a POSIX sh (subshell, ``$?``, ``rm``).
    If a provider ever adds real exec stdin, drop this for that
    provider (docker already streams via ``docker exec -i``).

    Args:
        line (str): the raw shell line.
        path (str): the uploaded stdin file (from stdin_path()).
    """
    quoted = shlex.quote(path)
    return f"( {line} ) < {quoted}; _s=$?; rm -f {quoted}; exit $_s"


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

# A PTY carries a served prefix's SFTP where a provider's exec decodes
# output as text (E2B): the terminal goes raw, so bytes pass unchanged,
# and the marker ends the shell's own output before sshfs starts.
PTY_MARK = b"\x01mirage-sftp\x02"
PTY_RAW = "stty raw -echo -iexten; printf '\\001mirage-sftp\\002'; "

SSHFS_HINT = (
    "serving the workspace into a sandbox needs sshfs there; "
    "install it in the image (apt-get install sshfs)"
)
PIPE_SERVER_HINT = (
    "serving the workspace into a sandbox needs asyncssh; "
    "install with: pip install mirage-ai[ssh]"
)
