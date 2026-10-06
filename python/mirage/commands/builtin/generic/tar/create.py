from mirage.commands.builtin.generic.archive.types import Entry, MemberKind
from mirage.commands.builtin.generic.archive.walk import (
    OTHER_FILESYSTEM,
    DirProbe,
    StatFn,
    WalkFn,
    scan_operand,
)
from mirage.commands.builtin.generic.tar import constants
from mirage.commands.builtin.generic.tar.types import CreateResult, Member
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.ops.types import LinkView, MountView
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.path import respell_one


def _refusal(notices: list[str]) -> CreateResult:
    return CreateResult(
        members=(),
        notices=tuple(notices),
        exit_code=constants.CREATE_ERROR_EXIT,
        write=False,
    )


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
        if fnmatch(bare[cut + 1 :], pattern):
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
        rest = "/".join(segments[last + 1 :])
        prefix = "/".join(segments[: last + 1])
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


def _announce_prefix(
    prefix: str, dropped: list[str], notices: list[str]
) -> None:
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


async def check_directories(
    directories: list[PathSpec], is_dir: DirProbe, stat: StatFn
) -> list[str]:
    """Check each chdir before writing or extracting members.

    Args:
        directories (list[PathSpec]): cumulative -C operands in line order.
        is_dir (DirProbe): directory probe, including implicit directories.
        stat (StatFn): distinguishes a regular file from a missing directory.
    """
    for directory in directories:
        try:
            if directory.walk_error is not None:
                raise walk_refusal(directory)
            if await is_dir(directory):
                continue
            await stat(directory)
            reason = posix_phrase(FsCondition.ENOTDIR)
        except FS_ERRORS as exc:
            reason = fs_strerror(exc) or str(exc)
        return [
            f"tar: {directory.raw_path}: Cannot open: {reason}",
            constants.FATAL_TRAILER,
        ]
    return []


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
    one_file_system: bool = False,
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
        one_file_system (bool): --one-file-system, asked for, so a mount
            left out goes unreported, as in GNU.
    """
    if not paths:
        return _refusal([constants.EMPTY_ARCHIVE, constants.USAGE_HINT])
    directory_errors = await check_directories(directories or [], is_dir, stat)
    if directory_errors:
        return _refusal(directory_errors)
    members: list[Member] = []
    notices: list[str] = []
    dropped: list[str] = []
    exit_code = 0
    for path in paths:
        if path.walk_error is not None:
            # The walk refused the operand before tar ran (the empty
            # name, a link loop), so nothing is there to scan; the prefix
            # it would strip is still announced first, as for any operand
            # it cannot stat.
            if path.raw_path == "":
                notices.append(constants.EMPTY_MEMBER)
            _announce_prefix(
                strip_prefix(path.raw_path.rstrip("/") or path.raw_path)[1],
                dropped,
                notices,
            )
            notices.append(
                f"tar: {path.raw_path}: Cannot stat: "
                f"{fs_strerror(walk_refusal(path))}"
            )
            exit_code = constants.CREATE_ERROR_EXIT
            continue
        # GNU strips a trailing slash off the operand before naming the
        # member, and re-adds one only for a member that really is a
        # directory: `tar -cf a.tar dlink/` stores `dlink`, the symlink,
        # exactly as `tar -cf a.tar dlink` does.
        raw = path.raw_path.rstrip("/") or path.raw_path
        base = path.virtual.rstrip("/") or "/"
        scan = await scan_operand(
            path,
            stat=stat,
            walk=walk,
            links=links,
            mounts=mounts,
            dereference=dereference,
            recurse=True,
        )
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
        named: list[tuple[str, str, Entry]] = []
        for entry in scan.entries:
            spelled = respell_one(entry.name_path, base, raw)
            _announce_prefix(strip_prefix(spelled)[1], dropped, notices)
            named.append((member_name(spelled, entry.kind), spelled, entry))
        for problem in scan.problems:
            shown = respell_one(problem.path, base, raw)
            # A link followed onto another mount is a crossing too, which
            # --one-file-system leaves unreported, as in GNU.
            if one_file_system and problem.reason == OTHER_FILESYSTEM:
                continue
            if problem.unreadable:
                # A directory the walk could not open: GNU names it,
                # keeps its entry, and fails the run.
                notices.append(f"tar: {shown}: Cannot open: {problem.reason}")
                exit_code = constants.CREATE_ERROR_EXIT
                continue
            if not problem.fatal:
                notices.append(f"tar: {shown}: {problem.reason}")
                continue
            notices.append(f"tar: {shown}: Cannot stat: {problem.reason}")
            exit_code = constants.CREATE_ERROR_EXIT
        if scan.missing:
            continue
        for crossing in [] if one_file_system else scan.crossings:
            shown = member_name(respell_one(crossing, base, raw), "dir")
            notices.append(f"tar: {shown}: {OTHER_FILESYSTEM}")
        keep = set(pruned([name for name, _, _ in named], exclude))
        for name, spelled, entry in named:
            if name not in keep:
                continue
            read = entry.read
            if (
                archive.raw_path != "-"
                and read is not None
                and read.virtual == archive.virtual
            ):
                notices.append(f"tar: {name}: {constants.SELF_DUMP}")
                continue
            members.append(
                Member(
                    name=name,
                    kind=entry.kind,
                    path=entry.read,
                    target=entry.target,
                    spelled=spelled,
                )
            )
    if exit_code:
        # GNU closes a run that failed an operand with one trailer, after
        # everything it did manage to name.
        notices.append(constants.ERROR_TRAILER)
    return CreateResult(
        members=tuple(members), notices=tuple(notices), exit_code=exit_code
    )
