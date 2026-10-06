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

from mirage.shell.bytes import encode_text
from mirage.types import MountMode, PathSpec
from mirage.utils.hidden import path_visible
from mirage.workspace.executor.builtins.shared import fail, ok, parse_line
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session import SessionState

# The mount options a mode reads as: the ladder's READ cannot write and
# only EXEC lets the interpreters run a script, which is what ro, rw and
# noexec say about a Linux mount.
MODE_OPTIONS = {
    MountMode.READ: "ro,noexec",
    MountMode.WRITE: "rw,noexec",
    MountMode.EXEC: "rw",
}


# The flags that ask for a mount, which with no operand is a bad usage
# rather than the listing.
MOUNTING = ("bind", "move", "rbind", "read_only", "rw")
BAD_USAGE = "mount: bad usage\nTry 'mount --help' for more information.\n"


def superuser(target: str) -> str:
    """util-linux's refusal of a mount an unprivileged user asks for.

    Args:
        target (str): the mount point as typed.
    """
    return (
        f"mount: {target}: must be superuser to use mount.\n"
        "       dmesg(1) may have more information after failed mount "
        "system call.\n"
    )


def match_type(name: str, pattern: str) -> bool:
    """Whether a filesystem type passes ``-t``, libmount's
    ``mnt_match_fstype``: a case-insensitive comma list, a leading ``no``
    negating the whole list and a later one a single type.

    Args:
        name (str): the mount's type.
        pattern (str): the ``-t`` list as typed.
    """
    negated = pattern.startswith("no")
    body = pattern[2:] if negated else pattern
    for item in body.split(","):
        if item.lower().startswith("no") and item[2:].lower() == name.lower():
            return False
        if item.lower() == name.lower():
            return not negated
    return negated


async def handle_mount(
    registry: MountRegistry,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """mount [-l] [-t TYPES]: list the mounts the session sees, util-linux
    2.41.5's way, with the session's mode as the options (``MODE_OPTIONS``).
    Mounting is an unprivileged user's refusal, since mounts come from the
    configuration, a mounting flag with no operand is a bad usage, and ``-a``
    mounts the empty fstab.

    Args:
        registry (MountRegistry): mount registry (mount enumeration).
        session (SessionState): session providing cwd.
        args (list[str | PathSpec]): args after the command name.
    """
    parsed, fl, refused = parse_line("mount", args, session.cwd)
    if refused is not None:
        return refused
    words = parsed.texts
    if len(words) >= 2:
        return fail("mount", superuser(words[-1]), 32)
    if words:
        return fail("mount", f"mount: {words[0]}: can't find in /etc/fstab.\n")
    if fl.as_bool("all"):
        return ok("mount")
    if fl.as_str("options") is not None or any(map(fl.as_bool, MOUNTING)):
        return fail("mount", BAD_USAGE)
    types = fl.as_str("types")
    lines = [
        f"{m.vfs.name} on {m.prefix.rstrip('/') or '/'} type {m.vfs.name} "
        f"({MODE_OPTIONS[m.effective_mode()]})\n"
        for m in sorted(registry.visible_mounts(), key=lambda m: m.prefix)
        if path_visible(session.visibility, m.prefix.rstrip("/") or "/")
        and (types is None or match_type(m.vfs.name, types))
    ]
    return ok("mount", encode_text("".join(lines)) if lines else None)


__all__ = ["handle_mount"]
