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

from collections.abc import Sequence

from mirage.policy.base import Policy
from mirage.policy.types import Action, CommandContext, Deny, MountRootQuery
from mirage.types import PathSpec


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


def is_create_mode(argv: tuple[str, ...]) -> bool:
    """Whether a tar line reads the filesystem rather than an archive.

    Only ``-c`` makes tar's operands source paths. Under ``-t`` and
    ``-x`` they are member selectors matched against names inside the
    archive, so a selector that happens to spell a mount root is not a
    mount at all and refusing it would deny an ordinary listing.

    Scanned raw for the same reason :func:`has_symlink_flag` is: the
    policy fires before flag parsing. Only the first word may be GNU's
    dashless option cluster (``tar cf a.tar d``), so a later bare word
    is an operand and cannot turn the mode on.

    Args:
        argv (tuple[str, ...]): raw argv after the command name.
    """
    for i, tok in enumerate(argv):
        if not isinstance(tok, str):
            continue
        if tok == "--create":
            return True
        if tok.startswith("--"):
            continue
        if tok.startswith("-"):
            if "c" in tok[1:]:
                return True
            continue
        if i == 0 and "c" in tok:
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


def first_root(query: MountRootQuery,
               paths: Sequence[PathSpec]) -> PathSpec | None:
    """The first of these paths that is a mount root, if any.

    Args:
        query (MountRootQuery): the mount-root oracle.
        paths (Sequence[PathSpec]): paths to test, in operand order.
    """
    for path in paths:
        if query.is_mount_root(path.virtual):
            return path
    return None


class MountRootPolicy(Policy):
    """The built-in rule: a mount root is not an ordinary directory.

    Two rules, one boundary. The first mirrors the kernel's refusal to
    unlink or replace a mountpoint (EBUSY on Linux), with each command's
    own GNU message: rm, rmdir, mv, mkdir, touch and ln.

    The second is mirage's own, and is a deliberate divergence: an
    archiver or a recursive copy pointed at a mount root would read an
    entire backend into one object. Real tar and cp allow it because a
    mountpoint there is just another directory; here the mount table is
    the deployment's configuration, and consuming a whole mount is
    neither what the operand looks like it costs nor something an agent
    should be able to do to data it was merely given a view of. The
    refusal names the boundary in each tool's own voice rather than
    inventing a mirage error, so a caller sees a filesystem answer.

    Only positional operands are tested. tar's ``-C`` and unzip's ``-d``
    are destinations to extract INTO, which is ordinary use of a mount,
    so reading them here would refuse the safe direction as well.

    Fires before mount resolution and cross-mount routing so the refusal
    is the same however the operands span mounts, and before runtime
    placement so a routed command is refused identically. MountRegistry
    seeds it as the first policy (mount-root semantics belong to the
    mount layer), so its exact messages win over user policies by order,
    not by privilege.
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
        elif cmd == "tar":
            # Only -c reads the filesystem; -t and -x match their
            # operands against names inside the archive.
            root = (first_root(ctx.registry, ctx.operands)
                    if is_create_mode(ctx.argv) else None)
            if root is not None:
                return Deny(
                    f"tar: {root.raw_path}: Cannot open: "
                    f"Device or resource busy\n"
                    f"tar: Error is not recoverable: exiting now\n", 2)
        elif cmd == "zip":
            # The first operand is the archive being written, not a
            # source; only what follows it is read.
            root = first_root(ctx.registry, ctx.operands[1:])
            if root is not None:
                return Deny(f"zip: cannot read '{root.raw_path}': "
                            f"Device or resource busy\n")
        elif cmd == "cp":
            # The last operand is the destination, and copying INTO a
            # mount is ordinary; only the sources are refused.
            root = first_root(ctx.registry, ctx.operands[:-1])
            if root is not None:
                return Deny(f"cp: cannot copy '{root.raw_path}': "
                            f"Device or resource busy\n")
        return None
