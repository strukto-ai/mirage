from dataclasses import dataclass
from typing import Literal, TypeAlias

from mirage.types import PathSpec

# What a member is, which is the whole of what an archive records beyond
# its name: a regular file carries bytes, a directory carries none and
# ends in a slash, a symlink carries its target string instead.
MemberKind: TypeAlias = Literal["file", "dir", "link"]


@dataclass(frozen=True, slots=True)
class Entry:
    """One thing found under an operand, before it is named or filtered.

    ``name_path`` and ``read`` are two different paths whenever a link is
    being followed: the member keeps the link's own name while its bytes
    come from the target.

    Args:
        name_path (str): absolute virtual path the member is named
            after, before it is respelled and stripped.
        kind (MemberKind): file, dir, or link.
        target (str): a symlink's target, verbatim as stored.
        read (PathSpec | None): where a file's bytes come from.
    """

    name_path: str
    kind: MemberKind
    target: str = ""
    read: PathSpec | None = None


@dataclass(frozen=True, slots=True)
class Problem:
    """One thing the scan could not archive, in the order it was met.

    Args:
        path (str): the absolute virtual path it happened at.
        reason (str): why, empty when ``fatal`` says the path could not
            be stat'd at all and each archiver has its own wording.
        fatal (bool): whether the path was unreachable rather than
            merely skipped, which is what decides the exit code.
    """

    path: str
    reason: str = ""
    fatal: bool = False


@dataclass(frozen=True, slots=True)
class Scan:
    """What one operand contributed, in virtual path space.

    Nothing here is named yet: naming is where the two archive formats
    part company (tar warns about a leading slash, zip strips it in
    silence and can junk the path entirely), so the scan reports paths
    and the caller spells them.

    Args:
        entries (tuple[Entry, ...]): the operand and its descendants.
        crossings (tuple[str, ...]): virtual path of each descendant
            mount whose contents the walk refused to cross into.
        problems (tuple[Problem, ...]): what was skipped and why, in
            walk order.
        missing (bool): whether the operand itself was unreachable, in
            which case it contributed no entries.
    """

    entries: tuple[Entry, ...] = ()
    crossings: tuple[str, ...] = ()
    problems: tuple[Problem, ...] = ()
    missing: bool = False
