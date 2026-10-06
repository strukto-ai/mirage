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

from mirage.commands.builtin.generic.tar.mode import is_create_mode
from mirage.commands.spec.compile import expand_table_long
from mirage.commands.spec.long_options import GNU_LONG_OPTIONS
from mirage.policy.base import Policy
from mirage.policy.types import (
    Action,
    CommandContext,
    Deny,
    DenyScope,
    MountRootQuery,
)
from mirage.types import PathSpec

LN_VALUED_SHORTS = "tS"
LN_VALUED_LONGS = frozenset({"--target-directory", "--suffix"})


def ln_flag_present(argv: tuple[str, ...], letter: str, long: str) -> bool:
    """Whether ln's raw argv carries one short flag or its long spelling.

    The scan is option-aware so an operand cannot pose as a flag: it
    stops at ``--``, skips the value of a valued option (``-t DIR``,
    ``-S SUF``, their long forms), and inside a cluster stops at the
    first valued letter, whose remainder is its attached value
    (``-SfooT`` carries no ``-T``).

    Args:
        argv (tuple[str, ...]): raw argv after the command name.
        letter (str): the short flag letter.
        long (str): the long spelling, with its dashes.
    """
    skip = False
    for tok in argv:
        if skip:
            skip = False
            continue
        if not isinstance(tok, str):
            continue
        if tok == "--":
            return False
        if tok == long:
            return True
        if tok.startswith("--"):
            skip = tok in LN_VALUED_LONGS
            continue
        if not tok.startswith("-") or len(tok) < 2:
            continue
        for pos, ch in enumerate(tok[1:], 1):
            if ch == letter:
                return True
            if ch in LN_VALUED_SHORTS:
                skip = pos == len(tok) - 1
                break
    return False


def has_symlink_flag(argv: tuple[str, ...]) -> bool:
    """Spot ln's -s/--symbolic by raw token scan.

    Same reason as :func:`has_parents_flag`: the policy fires before
    flag parsing, and GNU words the refusal by link kind ("failed to
    create symbolic link" vs "failed to create link").

    Args:
        argv (tuple[str, ...]): raw argv after the command name.
    """
    return ln_flag_present(argv, "s", "--symbolic")


def has_no_target_flag(argv: tuple[str, ...]) -> bool:
    """Spot ln's -T/--no-target-directory by raw token scan.

    Args:
        argv (tuple[str, ...]): raw argv after the command name.
    """
    return ln_flag_present(argv, "T", "--no-target-directory")


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
        if isinstance(tok, str) and (
            tok == "-p"
            or tok == "--parents"
            or (
                tok.startswith("-")
                and "p" in tok[1:]
                and not tok.startswith("--")
            )
        ):
            return True
    return False


def rm_options(argv: tuple[str, ...]) -> tuple[bool, bool, bool]:
    """What an rm line asks of a directory operand, by raw token scan.

    Recurse (-r, -R), remove an empty one (-d), and keep ``/`` out of a
    recursive removal, which is the default; the last of
    --preserve-root and --no-preserve-root wins. A long word is read
    against rm's whole table, so an abbreviation counts too.

    Args:
        argv (tuple[str, ...]): raw argv after the command name.
    """
    recursive = empty_dir = False
    preserve = True
    for tok in argv:
        if not isinstance(tok, str) or tok == "-":
            continue
        if tok == "--":
            break
        if tok.startswith("--"):
            name = expand_table_long(
                GNU_LONG_OPTIONS["rm"], tok.split("=", 1)[0]
            )
            if name == ("--recursive",):
                recursive = True
            elif name == ("--dir",):
                empty_dir = True
            elif name in (("--preserve-root",), ("--no-preserve-root",)):
                preserve = name == ("--preserve-root",)
            continue
        if tok.startswith("-"):
            recursive = recursive or "r" in tok or "R" in tok
            empty_dir = empty_dir or "d" in tok
    return recursive, empty_dir, preserve


def fts_name(raw: str) -> str:
    """An operand as fts hands it back: two or more trailing slashes
    trimmed to one, so ``///`` reads ``/`` while ``//`` stays.

    Args:
        raw (str): the operand as typed.
    """
    end = len(raw)
    if end > 2 and raw.endswith("/"):
        while end > 1 and raw[end - 2] == "/":
            end -= 1
    return raw[:end]


def rm_root_refusal(
    path: PathSpec, recursive: bool, empty_dir: bool, preserve: bool
) -> str:
    """rm's refusal of a mount root, in GNU rm's order and words.

    A recursive ``.`` or ``..`` is skipped before anything is looked
    at, a directory without -r or -d is not removed at all, and a
    recursive ``/`` meets the root failsafe; only what is left reaches
    the mountpoint and is busy.

    Args:
        path (PathSpec): the operand naming a mount root.
        recursive (bool): -r or -R.
        empty_dir (bool): -d.
        preserve (bool): the root failsafe is on.
    """
    raw = path.raw_path
    if recursive and raw.rstrip("/").rsplit("/", 1)[-1] in (".", ".."):
        return f"refusing to remove '.' or '..' directory: skipping '{raw}'"
    if not recursive and not empty_dir:
        return f"cannot remove '{raw}': Is a directory"
    if recursive and preserve and not path.virtual.strip("/"):
        shown = fts_name(raw)
        named = "'/'" if shown == "/" else f"'{shown}' (same as '/')"
        return (
            f"it is dangerous to operate recursively on {named}\n"
            "rm: use --no-preserve-root to override this failsafe"
        )
    return f"cannot remove '{raw}': Device or resource busy"


def names_root(query: MountRootQuery, path: PathSpec) -> bool:
    """Whether an operand names a mount root.

    An operand the kernel walk refused (``walk_error``) names nothing,
    whatever its ``virtual`` reads as: the empty name simplifies to the
    working directory, which can be a mount root, and the command
    reports it ENOENT rather than busy.

    Args:
        query (MountRootQuery): the mount-root oracle.
        path (PathSpec): the operand.
    """
    return path.walk_error is None and query.is_mount_root(path.virtual)


def first_root(
    query: MountRootQuery, paths: Sequence[PathSpec]
) -> PathSpec | None:
    """The first of these paths that is a mount root, if any.

    Args:
        query (MountRootQuery): the mount-root oracle.
        paths (Sequence[PathSpec]): paths to test, in operand order.
    """
    for path in paths:
        if names_root(query, path):
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
        if cmd == "rm":
            root = first_root(ctx.registry, ctx.paths)
            if root is not None:
                return Deny(
                    rm_root_refusal(root, *rm_options(ctx.argv)),
                    DenyScope.OPERAND,
                )
        elif cmd == "rmdir":
            for p in ctx.paths:
                if names_root(ctx.registry, p):
                    return Deny(
                        f"failed to remove '{p.virtual}': "
                        f"Device or resource busy",
                        DenyScope.OPERAND,
                    )
        elif cmd == "mv":
            # The source is a slot, so it is read off the positionals:
            # `mv -t /mnt f` moves INTO a mount root, which is ordinary.
            if ctx.operands and names_root(ctx.registry, ctx.operands[0]):
                dst = ctx.paths[1].virtual if len(ctx.paths) > 1 else "?"
                return Deny(
                    f"cannot move '{ctx.operands[0].virtual}' to '{dst}': "
                    f"Device or resource busy",
                    DenyScope.OPERAND,
                )
        elif cmd == "mkdir":
            # GNU mkdir -p makes "already exists" a no-op.
            if has_parents_flag(ctx.argv):
                return None
            for p in ctx.paths:
                if names_root(ctx.registry, p):
                    return Deny(
                        f"cannot create directory '{p.virtual}': File exists",
                        DenyScope.OPERAND,
                    )
        elif cmd == "touch":
            # Positionals only: `-r REF` is read, never touched.
            for p in ctx.operands:
                if names_root(ctx.registry, p):
                    return Deny(
                        f"cannot touch '{p.virtual}': Is a directory",
                        DenyScope.OPERAND,
                    )
        elif cmd == "ln":
            # A mount root is refused only as the link NAME. Without -T
            # a directory operand is the directory to link into, GNU's
            # rule, and creating inside a mount is ordinary.
            if has_no_target_flag(ctx.argv) and names_root(
                ctx.registry, ctx.paths[-1]
            ):
                kind = (
                    "symbolic link" if has_symlink_flag(ctx.argv) else "link"
                )
                return Deny(
                    f"failed to create {kind} "
                    f"'{ctx.paths[-1].virtual}': File exists",
                    DenyScope.OPERAND,
                )
        elif cmd == "tar":
            # Only -c reads the filesystem; -t and -x match their
            # operands against names inside the archive.
            root = (
                first_root(ctx.registry, ctx.operands)
                if is_create_mode(ctx.argv)
                else None
            )
            if root is not None:
                return Deny(
                    f"{root.raw_path}: Cannot open: "
                    f"Device or resource busy\n"
                    f"tar: Error is not recoverable: exiting now",
                    DenyScope.OPERAND,
                )
        elif cmd == "zip":
            # The first operand is the archive being written, not a
            # source; only what follows it is read.
            root = first_root(ctx.registry, ctx.operands[1:])
            if root is not None:
                return Deny(
                    f"cannot read '{root.raw_path}': Device or resource busy",
                    DenyScope.OPERAND,
                )
        elif cmd == "cp":
            # The last operand is the destination, and copying INTO a
            # mount is ordinary; only the sources are refused.
            root = first_root(ctx.registry, ctx.operands[:-1])
            if root is not None:
                return Deny(
                    f"cannot copy '{root.raw_path}': Device or resource busy",
                    DenyScope.OPERAND,
                )
        return None
