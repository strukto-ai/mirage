from dataclasses import dataclass
from typing import Literal, TypeAlias

from mirage.commands.builtin.generic.archive.types import MemberKind
from mirage.types import PathSpec

CompressionSuffix: TypeAlias = Literal["", ":gz", ":bz2", ":xz"]
WriteMode: TypeAlias = Literal["w", "w:gz", "w:bz2", "w:xz"]
ReadMode: TypeAlias = Literal["r", "r:gz", "r:bz2", "r:xz"]


@dataclass(frozen=True, slots=True)
class Member:
    """One entry the create pass decided to put in the archive.

    Choosing every member before writing any of them is what lets an
    exclusion prune a whole subtree and the ordering stay stable; the
    writer is then a straight loop with no policy left in it.

    Args:
        name (str): the archive member name, spelled as the operand was
            typed. A directory carries GNU's trailing slash.
        kind (MemberKind): file, dir, or link.
        path (PathSpec | None): where a file's bytes come from; None for
            a directory or a symlink, neither of which has content.
        target (str): a symlink's target, verbatim as stored; empty for
            every other kind.
    """

    name: str
    kind: MemberKind
    path: PathSpec | None = None
    target: str = ""


@dataclass(frozen=True, slots=True)
class CreateResult:
    """What one ``tar -c`` pass decided, before anything is written.

    Args:
        members (tuple[Member, ...]): the entries to write, in order.
        notices (tuple[str, ...]): stderr lines, each already carrying
            its ``tar: `` prefix and no trailing newline.
        exit_code (int): 0, or 2 when an operand could not be read.
        write (bool): whether to write an archive at all. False for the
            two refusals GNU makes before reading anything (no operands,
            and a ``-C`` it cannot enter), which leave no file behind;
            an operand it merely failed to stat still writes the rest.
    """

    members: tuple[Member, ...]
    notices: tuple[str, ...]
    exit_code: int
    write: bool = True
