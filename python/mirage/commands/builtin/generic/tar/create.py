from mirage.commands.builtin.generic.archive.types import Entry, MemberKind
from mirage.commands.builtin.generic.archive.walk import (OTHER_FILESYSTEM,
                                                          DirProbe, StatFn,
                                                          WalkFn, scan_operand)
from mirage.commands.builtin.generic.tar.types import CreateResult, Member
from mirage.ops.types import LinkView, MountView
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.path import respell_one

# Every diagnostic below is GNU tar 1.35's own wording, pinned on
# debian:stable-slim; only the hint line is mirage's, for the reason
# usage.old_option_error gives (mirage's tar serves no --usage).
USAGE_HINT = "Try 'tar --help' for more information."
EMPTY_ARCHIVE = "tar: Cowardly refusing to create an empty archive"
FATAL_TRAILER = "tar: Error is not recoverable: exiting now"
ERROR_TRAILER = "tar: Exiting with failure status due to previous errors"
SELF_DUMP = "archive cannot contain itself; not dumped"
# The exit GNU gives an operand it could not read, and a -C it could not
# enter. Both are fatal for the whole run, not per-operand.
CREATE_ERROR_EXIT = 2


def _refusal(notices: list[str]) -> CreateResult:
    return CreateResult(members=(),
                        notices=tuple(notices),
                        exit_code=CREATE_ERROR_EXIT,
                        write=False)


def excluded(name: str, pattern: str) -> bool:
    """Whether GNU's ``--exclude`` pattern matches this member name.

    GNU's exclusion is unanchored: the pattern is tried against the whole
    name and against every suffix that starts at a path component, so
    ``a.txt``, ``d/a.txt`` and ``sub/b.txt`` all match entries under
    ``d``. Wildcards cross slashes (``*/b.txt`` matches ``d/sub/b.txt``),
    which is tar's default for exclusion patterns. A directory's
    trailing slash is not part of what the pattern sees. Info-ZIP's
    ``-x`` is the anchored counterpart, which is why the two are not
    shared.

    Args:
        name (str): the member name, with or without a trailing slash.
        pattern (str): the raw ``--exclude`` value.
    """
    bare = name.rstrip("/")
    if fnmatch(bare, pattern):
        return True
    cut = bare.find("/")
    while cut != -1:
        if fnmatch(bare[cut + 1:], pattern):
            return True
        cut = bare.find("/", cut + 1)
    return False


def pruned(names: list[str], pattern: str | None) -> list[str]:
    """Drop excluded names and everything beneath an excluded directory.

    GNU does not walk into a directory it excluded, so ``--exclude sub``
    takes ``d/sub/`` and ``d/sub/b.txt`` together. Matching each name in
    isolation would keep the children of a pruned directory.

    Args:
        names (list[str]): member names in walk order.
        pattern (str | None): the raw ``--exclude`` value, or None.
    """
    if pattern is None:
        return names
    kept: list[str] = []
    cut_dirs: list[str] = []
    for name in names:
        if any(name.startswith(cut) for cut in cut_dirs):
            continue
        if excluded(name, pattern):
            if name.endswith("/"):
                cut_dirs.append(name)
            continue
        kept.append(name)
    return kept


def strip_prefix(spelled: str) -> tuple[str, str]:
    """Split a spelled path into the name tar stores and what it drops.

    tar stores no name that could climb out of the directory it is
    extracted into, so it removes everything through the *last* ``..``
    segment: ``x/../y/f3`` is stored as ``y/f3`` and
    ``/data/sub/../file`` as ``file``. Only when the path has no ``..``
    does the leading slash become the thing removed. A ``.`` segment
    escapes nothing and survives, so ``./file`` is stored verbatim.
    Info-ZIP makes the opposite choice and keeps ``..`` in the member
    name, which is why `zip_cmd` does not share this.

    Args:
        spelled (str): the path as the operand spelled it.

    Returns:
        tuple[str, str]: the name to store, and the prefix removed to
        get it (empty when nothing was removed). Each distinct prefix
        earns one notice naming it.
    """
    segments = spelled.split("/")
    last = -1
    for i, segment in enumerate(segments):
        if segment == "..":
            last = i
    if last >= 0:
        rest = "/".join(segments[last + 1:])
        prefix = "/".join(segments[:last + 1])
        return rest, prefix + "/" if rest else prefix
    if spelled.startswith("/"):
        return spelled.lstrip("/"), "/"
    return spelled, ""


def removing_leading(prefix: str) -> str:
    """GNU's notice for a prefix it refused to store.

    Args:
        prefix (str): the prefix `strip_prefix` removed.
    """
    return f"tar: Removing leading `{prefix}' from member names"


def _announce_prefix(prefix: str, dropped: list[str],
                     notices: list[str]) -> None:
    """Announce a removed prefix the first time this run drops it.

    Emitted in place rather than collected and prepended, because GNU
    interleaves these with the per-operand errors in operand order.

    Args:
        prefix (str): the prefix `strip_prefix` removed, or "" for none.
        dropped (list[str]): prefixes already announced; appended to.
        notices (list[str]): the run's diagnostics; appended to in order.
    """
    if not prefix or prefix in dropped:
        return
    dropped.append(prefix)
    notices.append(removing_leading(prefix))


def member_name(spelled: str, kind: MemberKind) -> str:
    """The name tar records for a path spelled as the operand was typed.

    The traversal prefix is dropped (see `strip_prefix`) and a directory
    carries the trailing slash that tells an extractor it holds no
    content. An operand that is all traversal -- ``tar -cf a.tar ..`` --
    leaves nothing to name, and GNU stores that directory as ``./``.

    Args:
        spelled (str): the path as the operand spelled it.
        kind (MemberKind): what the entry is.
    """
    name, _ = strip_prefix(spelled)
    if kind == "dir":
        if not name:
            return "./"
        if not name.endswith("/"):
            return name + "/"
    return name


async def plan_create(
    paths: list[PathSpec],
    *,
    archive: PathSpec,
    exclude: str | None,
    dereference: bool,
    stat: StatFn,
    walk: WalkFn,
    is_dir: DirProbe,
    directories: list[PathSpec] | None = None,
    links: LinkView | None = None,
    mounts: MountView | None = None,
) -> CreateResult:
    """Decide every member of a new archive, before writing any of it.

    One pass per operand, in the order they were typed, each
    contributing itself and then its subtree. GNU walks a directory
    operand rather than refusing it, and mirage now does too; the one
    deliberate divergence is ordering, since GNU emits siblings in
    readdir order (filesystem-dependent) and this sorts them, the same
    choice ``du`` already documents.

    Args:
        paths (list[PathSpec]): the operands, glob-resolved and already
            re-based by any ``-C``.
        archive (PathSpec): the ``-f`` target, so it can be left out of
            itself.
        exclude (str | None): the raw ``--exclude`` value.
        dereference (bool): ``-h``, archive what a symlink points at.
        stat (StatFn): backend stat, raising when nothing is there.
        walk (WalkFn): subtree listing, by find type.
        is_dir (DirProbe): whether a ``-C`` can be entered.
        directories (list[PathSpec] | None): every ``-C`` the operands
            were based on, in order, checked here because GNU chdirs at
            each one before reading anything.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are.
    """
    if not paths:
        return _refusal([EMPTY_ARCHIVE, USAGE_HINT])
    for directory in directories or []:
        # GNU chdirs at each -C in turn, before reading a single
        # operand, so the FIRST one it cannot enter is fatal for the
        # whole run and no members are written. Checking only the last
        # would archive the operands that followed a bad earlier one.
        if not await is_dir(directory):
            return _refusal([
                f"tar: {directory.raw_path}: Cannot open: "
                "No such file or directory", FATAL_TRAILER
            ])
    members: list[Member] = []
    notices: list[str] = []
    dropped: list[str] = []
    exit_code = 0
    for path in paths:
        raw = path.raw_path
        base = path.virtual.rstrip("/") or "/"
        scan = await scan_operand(path,
                                  stat=stat,
                                  walk=walk,
                                  links=links,
                                  mounts=mounts,
                                  dereference=dereference,
                                  recurse=True)
        # GNU announces the prefix it refuses to store before it reports
        # what it could not read, and keeps both in operand order -- a
        # later operand's notice must not jump ahead of an earlier
        # operand's error. The operand's own spelling carries the prefix
        # even when nothing under it can be archived, which is why
        # `tar -cf a.tar sub/../missing` still announces `sub/../`.
        _announce_prefix(strip_prefix(raw)[1], dropped, notices)
        # Each name is then stripped on its own, so one operand can owe
        # two notices: `tar -cf a.tar ..` drops `..` from the directory
        # and `../` from everything under it.
        named: list[tuple[str, Entry]] = []
        for entry in scan.entries:
            spelled = respell_one(entry.name_path, base, raw)
            _announce_prefix(strip_prefix(spelled)[1], dropped, notices)
            named.append((member_name(spelled, entry.kind), entry))
        for problem in scan.problems:
            shown = respell_one(problem.path, base, raw)
            if not problem.fatal:
                notices.append(f"tar: {shown}: {problem.reason}")
                continue
            notices.append(f"tar: {shown}: Cannot stat: {problem.reason}")
            exit_code = CREATE_ERROR_EXIT
        if scan.missing:
            continue
        for crossing in scan.crossings:
            shown = member_name(respell_one(crossing, base, raw), "dir")
            notices.append(f"tar: {shown}: {OTHER_FILESYSTEM}")
        keep = set(pruned([name for name, _ in named], exclude))
        for name, entry in named:
            if name not in keep:
                continue
            read = entry.read
            if read is not None and read.virtual == archive.virtual:
                notices.append(f"tar: {name}: {SELF_DUMP}")
                continue
            members.append(
                Member(name=name,
                       kind=entry.kind,
                       path=entry.read,
                       target=entry.target))
    if exit_code:
        # GNU closes a run that failed an operand with one trailer, after
        # everything it did manage to name.
        notices.append(ERROR_TRAILER)
    return CreateResult(members=tuple(members),
                        notices=tuple(notices),
                        exit_code=exit_code)
