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

from mirage.types import PathSpec
from mirage.workspace.mount import MountRegistry


def _has_parents_flag(argv: list[str]) -> bool:
    """Spot mkdir's -p/--parents by raw token scan.

    The guard fires before ``parse_flags`` runs (its refusals must win
    over parse errors and stay consistent across the single-mount and
    cross-mount paths), so the shorthand cluster (-pv) is detected on
    the raw argv rather than through the spec parser.

    Args:
        argv (list[str]): raw argv after the command name.
    """
    for tok in argv:
        if isinstance(tok, str) and (tok == "-p" or tok == "--parents" or
                                     (tok.startswith("-") and "p" in tok[1:]
                                      and not tok.startswith("--"))):
            return True
    return False


def check_mount_root_guard(
    cmd_name: str,
    paths: list[PathSpec],
    registry: MountRegistry,
    argv: list[str],
) -> tuple[str, int] | None:
    """Refuse destructive/conflicting ops targeting a mount root.

    Fires before mount resolution / cross-mount routing so a refusal
    message is consistent regardless of whether the operands span mounts.
    Returns (stderr_message, exit_code) when the guard fires, else None.

    Args:
        cmd_name (str): command name (rm/mv/mkdir/touch/ln/...).
        paths (list[PathSpec]): raw positional path arguments.
        registry (MountRegistry): mount registry for is_mount_root checks.
        argv (list[str]): raw argv after the command name (used to spot
            shorthand flags like `mkdir -p` before parse_flags runs).
    """
    if not paths:
        return None

    def _is_root(p: PathSpec) -> bool:
        return registry.is_mount_root(p.virtual)

    if cmd_name in ("rm", "rmdir"):
        for p in paths:
            if _is_root(p):
                if cmd_name == "rmdir":
                    msg = (f"rmdir: failed to remove '{p.virtual}': "
                           f"Device or resource busy\n")
                else:
                    msg = (f"rm: cannot remove '{p.virtual}': "
                           f"Device or resource busy\n")
                return msg, 1
    elif cmd_name == "mv":
        if _is_root(paths[0]):
            dst = paths[1].virtual if len(paths) > 1 else "?"
            msg = (f"mv: cannot move '{paths[0].virtual}' to '{dst}': "
                   f"Device or resource busy\n")
            return msg, 1
    elif cmd_name == "mkdir":
        # GNU mkdir -p makes "already exists" a no-op.
        if _has_parents_flag(argv):
            return None
        for p in paths:
            if _is_root(p):
                msg = (f"mkdir: cannot create directory '{p.virtual}': "
                       f"File exists\n")
                return msg, 1
    elif cmd_name == "touch":
        for p in paths:
            if _is_root(p):
                msg = (f"touch: cannot touch '{p.virtual}': "
                       f"Is a directory\n")
                return msg, 1
    elif cmd_name == "ln":
        if _is_root(paths[-1]):
            msg = (f"ln: failed to create link '{paths[-1].virtual}': "
                   f"File exists\n")
            return msg, 1
    return None
