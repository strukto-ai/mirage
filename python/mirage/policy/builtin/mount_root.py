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

from mirage.policy.base import Policy
from mirage.policy.types import Action, CommandContext, Deny


def has_symlink_flag(argv: tuple[str, ...]) -> bool:
    """Spot ln's -s/--symbolic by raw token scan.

    Same reason as :func:`has_parents_flag`: the policy fires before
    flag parsing, and GNU words the refusal by link kind ("failed to
    create symbolic link" vs "failed to create link").

    Args:
        argv (tuple[str, ...]): raw argv after the command name.
    """
    for tok in argv:
        if isinstance(tok, str) and (tok == "--symbolic" or
                                     (tok.startswith("-") and "s" in tok[1:]
                                      and not tok.startswith("--"))):
            return True
    return False


def has_parents_flag(argv: tuple[str, ...]) -> bool:
    """Spot mkdir's -p/--parents by raw token scan.

    The policy fires before flag parsing (its refusals must win over
    parse errors and stay consistent across the single-mount and
    cross-mount paths), so the shorthand cluster (-pv) is detected on
    the raw argv rather than through the spec parser.

    Args:
        argv (tuple[str, ...]): raw argv after the command name.
    """
    for tok in argv:
        if isinstance(tok, str) and (tok == "-p" or tok == "--parents" or
                                     (tok.startswith("-") and "p" in tok[1:]
                                      and not tok.startswith("--"))):
            return True
    return False


class MountRootPolicy(Policy):
    """The built-in POSIX rule: a mount root is busy, not a directory.

    Mirrors the kernel's refusal to unlink or replace a mountpoint
    (EBUSY on Linux), with each command's own GNU message. Fires before
    mount resolution and cross-mount routing so the refusal is the same
    however the operands span mounts, and before runtime placement so a
    routed command is refused identically. MountRegistry seeds it as
    the first policy (mount-root semantics belong to the mount layer),
    so its exact GNU messages win over user policies by order, not by
    privilege.
    """

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if not ctx.paths:
            return None
        cmd = ctx.command
        if cmd in ("rm", "rmdir"):
            for p in ctx.paths:
                if ctx.registry.is_mount_root(p.virtual):
                    if cmd == "rmdir":
                        msg = (f"rmdir: failed to remove '{p.virtual}': "
                               f"Device or resource busy\n")
                    else:
                        msg = (f"rm: cannot remove '{p.virtual}': "
                               f"Device or resource busy\n")
                    return Deny(msg)
        elif cmd == "mv":
            if ctx.registry.is_mount_root(ctx.paths[0].virtual):
                dst = ctx.paths[1].virtual if len(ctx.paths) > 1 else "?"
                return Deny(
                    f"mv: cannot move '{ctx.paths[0].virtual}' to '{dst}': "
                    f"Device or resource busy\n")
        elif cmd == "mkdir":
            # GNU mkdir -p makes "already exists" a no-op.
            if has_parents_flag(ctx.argv):
                return None
            for p in ctx.paths:
                if ctx.registry.is_mount_root(p.virtual):
                    return Deny(f"mkdir: cannot create directory "
                                f"'{p.virtual}': File exists\n")
        elif cmd == "touch":
            for p in ctx.paths:
                if ctx.registry.is_mount_root(p.virtual):
                    return Deny(
                        f"touch: cannot touch '{p.virtual}': Is a directory\n")
        elif cmd == "ln":
            if ctx.registry.is_mount_root(ctx.paths[-1].virtual):
                kind = ("symbolic link"
                        if has_symlink_flag(ctx.argv) else "link")
                return Deny(f"ln: failed to create {kind} "
                            f"'{ctx.paths[-1].virtual}': File exists\n")
        return None
