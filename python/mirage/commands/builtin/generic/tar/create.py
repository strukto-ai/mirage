from mirage.commands.builtin.generic.archive.types import MemberKind
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
LEADING_SLASH = "tar: Removing leading `/' from member names"
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


def member_name(spelled: str, kind: MemberKind) -> str:
    """The name tar records for a path spelled as the operand was typed.

    A leading slash is stripped (tar refuses to store absolute names, and
    says so once per run), and a directory carries the trailing slash
    that tells an extractor it holds no content.

    Args:
        spelled (str): the path as the operand spelled it.
        kind (MemberKind): what the entry is.
    """
    name = spelled.lstrip("/")
    if kind == "dir" and name and not name.endswith("/"):
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
    absolute_seen = False
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
        # Every descendant is spelled under the operand's own base, so
        # the operand alone decides whether this run stored an absolute
        # name and owes GNU's one-per-run warning.
        absolute_seen = absolute_seen or raw.startswith("/")
        named = [(member_name(respell_one(entry.name_path, base, raw),
                              entry.kind), entry) for entry in scan.entries]
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
    if absolute_seen:
        notices.insert(0, LEADING_SLASH)
    if exit_code:
        # GNU closes a run that failed an operand with one trailer, after
        # everything it did manage to name.
        notices.append(ERROR_TRAILER)
    return CreateResult(members=tuple(members),
                        notices=tuple(notices),
                        exit_code=exit_code)
