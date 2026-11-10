import asyncio
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.objects import Commit, ObjectID, Tag
from dulwich.refs import DictRefsContainer
from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.constants import GIT_DIR
from mirage.commands.cli.builtin.git.discover import in_git_dir, is_bare
from mirage.commands.cli.builtin.git.errors import (
    AbbrevModeError,
    AmbiguousArgumentError,
    ConfigUsageError,
    GitError,
    NoSuchPathError,
    NotAWorkTreeError,
    SelectorError,
    SingleRevisionError,
    UnknownSubcommandError,
    UnrecognizedArgumentError,
    UsageError,
)
from mirage.commands.cli.builtin.git.format import abbrev_width
from mirage.commands.cli.builtin.git.history import (
    LogFlags,
    in_print_order,
    parse_flags,
    ref_commits,
    walk_ends,
    walk_operands,
    walked,
)
from mirage.commands.cli.builtin.git.io import (
    exists,
    read_file,
    read_optional,
)
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.pathspec import absolute_operand
from mirage.commands.cli.builtin.git.ref_fields import (
    shorten_ref,
)
from mirage.commands.cli.builtin.git.ref_list import (
    ref_table,
    resolve_ref,
    unique_abbreviations,
)
from mirage.commands.cli.builtin.git.refs import (
    load_refs,
    resolve_symbolic,
    valid_branch_name,
    valid_ref_name,
)
from mirage.commands.cli.builtin.git.repo import Repo, config_bool
from mirage.commands.cli.builtin.git.revparse import (
    NEGATION,
    RANGE,
    SELECTOR_OPEN,
    expand_selector,
    merge_bases,
    range_ends,
    refs_named,
    resolve_commit,
    resolve_object,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    MARKER,
    check_operands,
    check_switches,
    escaped,
    fatal,
    lone_help,
    multivar,
    offending,
    option_operand,
    start_point,
    verb_usage,
)
from mirage.commands.cli.constants import (
    GIT_LONG_OPTIONS,
)
from mirage.commands.cli.refusal import (
    git_option_refusal,
    git_usage,
    leaf_refusal,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import (
    Argument,
    CommandSpec,
    FlagValue,
    UsageStyle,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.version import __version__
from mirage.workspace.files import Files

SHOW_TOPLEVEL = "--show-toplevel"
HEAD_REF = "HEAD"
ALL_REFS = "--all"
GLOB_OPTION = "--glob"
EXCLUDE_OPTION = "--exclude"
REF_NAMESPACES = {
    "--branches": "refs/heads/",
    "--tags": "refs/tags/",
    "--remotes": "refs/remotes/",
}
GLOB_CHARS = "?*["
PATH_ABSOLUTE = "absolute"
PATH_RELATIVE = "relative"
OBJECT_FORMAT_MODES = ("storage", "input", "output")
PARENT_SUFFIX = "^"
SYMBOLIC_AS_TYPED = "as-typed"
SYMBOLIC_FULL = "full"
SYMBOLIC_ABBREVIATED = "abbreviated"
# Paths a linked worktree reads from the repository it was cut from.
SHARED_PATHS = frozenset(
    (
        "branches",
        "common",
        "config",
        "hooks",
        "info",
        "logs",
        "lost-found",
        "objects",
        "packed-refs",
        "refs",
        "remotes",
        "rr-cache",
        "shallow",
        "svn",
        "worktrees",
    )
)
PER_WORKTREE_PATHS = (
    "config.worktree",
    "info/sparse-checkout",
    "logs/HEAD",
    "logs/refs/bisect",
    "logs/refs/rewritten",
    "logs/refs/worktree",
    "refs/bisect",
    "refs/rewritten",
    "refs/worktree",
)
# Real rev-parse options this build does not have; printing one back
# would read as though the option had done its work.
UNBUILT_REV_PARSE_OPTIONS = frozenset(
    (
        "--after",
        "--before",
        "--disambiguate",
        "--exclude-hidden",
        "--flags",
        "--keep-dashdash",
        "--local-env-vars",
        "--no-flags",
        "--no-revs",
        "--parseopt",
        "--prefix",
        "--resolve-git-dir",
        "--revs-only",
        "--shared-index-path",
        "--show-superproject-working-tree",
        "--since",
        "--sq",
        "--sq-quote",
        "--stop-at-non-option",
        "--stuck-long",
        "--until",
    )
)
GET_URL = CommandSpec(
    arguments=(
        Argument(
            "--push",
            action="store_true",
            help="query push URLs rather than fetch URLs",
        ),
        Argument("--all", action="store_true", help="return all URLs"),
        Argument("--no-push", action="store_true"),
        Argument("--no-all", action="store_true"),
        Argument("name"),
        Argument("texts", nargs="*", metavar=""),
    )
)


@dataclass(frozen=True, slots=True)
class _RevParsePlace:
    """Where a ``rev-parse`` line runs.

    Args:
        location (RepoLocation): where the repository was found.
        start (str): the directory the line runs in.
        top (str): the work tree's path, ending in a slash.
        bare (bool): whether the repository has no work tree.
        in_git_dir (bool): whether the line runs in the git directory.
        in_work_tree (bool): whether the line runs in the work tree.
        prefix (str): the way from the work tree's top down to the line.
    """

    location: RepoLocation
    start: str
    top: str
    bare: bool
    in_git_dir: bool
    in_work_tree: bool
    prefix: str


@dataclass(slots=True)
class _RevParseOutput:
    """What a ``rev-parse`` line has printed and the modes it is in.

    Args:
        vfs (Files): the session's files.
        repo (BaseRepo): the opened repository.
        location (RepoLocation): where it was found.
        place (_RevParsePlace): where the line runs.
        table (DictRefsContainer): every ref, as ``load_refs`` reads them.
        refs (dict[str, str]): every ref under ``refs/`` and its id.
        warn (bool): ``core.warnAmbiguousRefs``.
        strict (bool): how strictly ``--abbrev-ref`` shortens.
        quiet (bool): whether ``-q`` is on the line.
        verify (bool): whether the line is down to one revision.
        symbolic (str): how a revision prints; empty for by id.
        negated (bool): whether ``--not`` is in force.
        width (int | None): the digits ``--short`` keeps.
        path_format (str | None): the ``--path-format`` in force.
        default (str | None): the ``--default`` revision.
        excludes (list[str]): the ``--exclude`` patterns waiting.
        files_only (bool): whether a word has been read as a file.
        shown (bool): whether any revision has been printed.
        rows (list[bytes]): the lines printed so far.
        counted (list[bytes]): the lines ``--verify`` is holding.
        errors (list[bytes]): the error lines so far.
        refused (GitError | None): why the last word named no revision.
    """

    vfs: Files
    repo: BaseRepo
    location: RepoLocation
    place: _RevParsePlace
    table: DictRefsContainer
    refs: dict[str, str]
    warn: bool
    strict: bool
    quiet: bool
    verify: bool = False
    symbolic: str = ""
    negated: bool = False
    width: int | None = None
    path_format: str | None = None
    default: str | None = None
    excludes: list[str] = field(default_factory=list)
    files_only: bool = False
    shown: bool = False
    rows: list[bytes] = field(default_factory=list)
    counted: list[bytes] = field(default_factory=list)
    errors: list[bytes] = field(default_factory=list)
    refused: GitError | None = None


async def repo_config(ctx: Context, fl: FlagView) -> ConfigFile:
    _, location = await opened(ctx, fl)
    assert ctx.vfs is not None
    return ConfigFile.from_file(
        BytesIO(await read_file(ctx.vfs, location.commondir.join("config")))
    )


async def remote(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    if texts and texts[0] == "get-url":
        return await remote_get_url(texts, ctx)
    check_operands(ctx, texts)
    if texts:
        raise UnknownSubcommandError(texts[0], verb_usage(ctx))
    cfg = await repo_config(ctx, fl)
    lines = []
    for section in sorted(cfg.sections()):
        if len(section) != 2 or section[0] != b"remote":
            continue
        name = section[1].decode()
        if not fl.as_bool("verbose"):
            lines.append(name)
            continue
        urls, push = remote_urls(cfg, name)
        if urls:
            lines.append(f"{name}\t{urls[0]} (fetch)")
        lines.extend(f"{name}\t{url} (push)" for url in push)
    return ("".join(f"{line}\n" for line in lines).encode(), IOResult())


def rewrite_url(url: str, rules: list[tuple[str, str]]) -> str:
    """Apply the longest matching URL prefix once, as Git does.

    Args:
        url (str): configured URL.
        rules (list[tuple[str, str]]): prefix and replacement pairs in config order.
    """
    matches = [
        (prefix, base) for prefix, base in rules if url.startswith(prefix)
    ]
    if not matches:
        return url
    prefix, base = max(matches, key=lambda rule: len(rule[0]))
    return base + url[len(prefix) :]


def url_rules(
    cfg: ConfigFile,
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Each ``insteadOf`` and ``pushInsteadOf`` prefix with its base.

    Args:
        cfg (ConfigFile): repository configuration.
    """
    rules: list[tuple[str, str]] = []
    push_rules: list[tuple[str, str]] = []
    for section in cfg.sections():
        if len(section) == 2 and section[0] == b"url":
            base = section[1].decode()
            rules.extend(
                (value.decode(), base)
                for value in multivar(cfg, section, b"insteadof")
            )
            push_rules.extend(
                (value.decode(), base)
                for value in multivar(cfg, section, b"pushinsteadof")
            )
    return rules, push_rules


def remote_urls(cfg: ConfigFile, name: str) -> tuple[list[str], list[str]]:
    """Fetch and push URLs, with Git's longest-prefix config rewrites.

    Args:
        cfg (ConfigFile): repository configuration.
        name (str): remote subsection name.
    """
    section: tuple[bytes, ...] = (b"remote", name.encode())
    urls = [value.decode() for value in multivar(cfg, section, b"url")]
    push = [value.decode() for value in multivar(cfg, section, b"pushurl")]
    if not urls and push:
        urls = [name]
    rules, push_rules = url_rules(cfg)
    fetch = [rewrite_url(url, rules) for url in urls]
    if push:
        push = [rewrite_url(url, rules) for url in push]
    else:
        push = [
            rewrite_url(url, push_rules)
            for url in urls
            if any(url.startswith(prefix) for prefix, _ in push_rules)
        ] or fetch
    return fetch, push


async def remote_get_url(
    texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Read the get-url remainder through the shared option parser.

    Args:
        texts (list[str]): the remote operands, ``get-url`` first.
        ctx (Context): the line's context, with its verbatim remainder.
    """
    parsed = parse_command(
        GET_URL,
        list(texts[1:]),
        ctx.cwd.virtual,
        abbreviations=GIT_LONG_OPTIONS["remote get-url"],
    )
    if parsed.option_error_kinds:
        stderr, code, stdout = leaf_refusal(
            UsageStyle.GIT, b"", parsed, "remote get-url", GET_URL
        )
        return stdout, IOResult(exit_code=code, stderr=stderr)
    names = tuple(word for word, _ in parsed.args)
    bad = offending(names, escaped(ctx.argv), frozenset())
    if bad is not None:
        raise UsageError(*git_option_refusal(bad, "remote get-url", GET_URL))
    if len(names) != 1:
        raise UsageError("", git_usage("remote get-url", GET_URL))
    fl = FlagView(parse_to_kwargs(parsed), GET_URL)
    cfg = await repo_config(ctx, FlagView(ctx.flags))
    name = names[0]
    urls, push = remote_urls(cfg, name)
    if not urls:
        return None, IOResult(
            exit_code=2,
            stderr=f"error: No such remote '{name}'\n".encode(),
        )
    selected = (
        push if fl.typed_order("push", "no_push")[-1:] == ["push"] else urls
    )
    if fl.typed_order("all", "no_all")[-1:] != ["all"]:
        selected = selected[:1]
    return "".join(f"{url}\n" for url in selected).encode(), IOResult()


def _merge_base_commits(
    repo: BaseRepo, revisions: tuple[str, ...]
) -> list[Commit]:
    commits = []
    for revision in revisions:
        try:
            commits.append(resolve_commit(repo, revision))
        except AmbiguousArgumentError as exc:
            raise GitError(f"Not a valid object name {revision}") from exc
    return commits


def _merge_base_ids(
    repo: BaseRepo, revisions: tuple[str, ...]
) -> tuple[bytes, list[bytes]]:
    commits = _merge_base_commits(repo, revisions)
    return commits[0].id, [c.id for c in merge_bases(repo, *commits)]


def _octopus(repo: BaseRepo, revisions: tuple[str, ...]) -> list[bytes]:
    """The best common ancestors of every commit named.

    Args:
        repo (BaseRepo): the opened repository.
        revisions (tuple[str, ...]): the commits.
    """
    commits = _merge_base_commits(repo, revisions)
    found = commits[:1]
    for other in commits[1:]:
        seen: dict[bytes, Commit] = {}
        for commit in found:
            for base in merge_bases(repo, commit, other):
                seen.setdefault(base.id, base)
        found = list(seen.values())
    return [commit.id for commit in found]


def _independent(repo: BaseRepo, revisions: tuple[str, ...]) -> list[bytes]:
    """The commits no other named commit reaches, newest first.

    Args:
        repo (BaseRepo): the opened repository.
        revisions (tuple[str, ...]): the commits.
    """
    named = {c.id: c for c in _merge_base_commits(repo, revisions)}
    kept = [
        commit
        for commit in named.values()
        if not any(
            other.id != commit.id
            and commit.id in {b.id for b in merge_bases(repo, commit, other)}
            for other in named.values()
        )
    ]
    kept.sort(key=lambda commit: commit.commit_time, reverse=True)
    return [commit.id for commit in kept]


def _valid_refname(name: str, onelevel: bool, pattern: bool) -> bool:
    """Whether a whole ref name passes ``check-ref-format``.

    Args:
        name (str): the name.
        onelevel (bool): whether one component is enough.
        pattern (bool): whether a single ``*`` may stand in it.
    """
    if name == "@" or (not onelevel and "/" not in name):
        return False
    if pattern and name.count("*") == 1:
        name = name.replace("*", "x")
    return valid_ref_name(name)


def _normalized(name: str) -> str:
    parts = [part for part in name.split("/") if part]
    return "/".join(parts) + ("/" if name.endswith("/") and parts else "")


async def check_ref_format(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Answer whether a name is a well-formed ref, by exit status.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the name.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    verb = ctx.argv.index("check-ref-format") + 1
    words = list(ctx.argv[verb:])
    usage = UsageError("", verb_usage(ctx))
    if words[:1] == ["--branch"]:
        if len(words) != 2:
            raise usage
        return await _check_branch(ctx, fl, words[1])
    normalize = False
    onelevel = False
    pattern = False
    names = []
    for word in words:
        if word in ("--normalize", "--print"):
            normalize = True
        elif word == "--allow-onelevel":
            onelevel = True
        elif word == "--no-allow-onelevel":
            onelevel = False
        elif word == "--refspec-pattern":
            pattern = True
        elif word.startswith("-"):
            raise usage
        else:
            names.append(word)
    if len(names) != 1:
        raise usage
    name = _normalized(names[0]) if normalize else names[0]
    if not _valid_refname(name, onelevel, pattern):
        return None, IOResult(exit_code=1)
    return (f"{name}\n".encode() if normalize else None), IOResult()


async def _check_branch(
    ctx: Context, fl: FlagView, name: str
) -> tuple[ByteSource | None, IOResult]:
    """``check-ref-format --branch``: print the branch name a word gives.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        name (str): the word as typed.

    Raises:
        GitError: it names no valid branch.
    """
    resolved = name
    if name.startswith(SELECTOR_OPEN):
        try:
            repo, _ = await opened(ctx, fl)
            resolved = await asyncio.to_thread(
                expand_selector, repo, name, name
            )
        except GitError as exc:
            raise GitError(f"'{name}' is not a valid branch name") from exc
    if not valid_branch_name(resolved):
        raise GitError(f"'{name}' is not a valid branch name")
    return f"{resolved}\n".encode(), IOResult()


async def merge_base(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    check_switches(ctx, texts)
    repo, _ = await opened(ctx, fl)
    ancestor = fl.as_bool("is_ancestor")
    all_bases = fl.as_bool("all")
    octopus = fl.as_bool("octopus")
    independent = fl.as_bool("independent")
    if octopus and independent:
        raise ConfigUsageError(
            "options '--independent' and '--octopus' cannot be used together"
        )
    if octopus or independent:
        if not texts:
            return None, IOResult(exit_code=1)
        finder = _octopus if octopus else _independent
        found = await asyncio.to_thread(finder, repo, tuple(texts))
        shown = found if independent or all_bases else found[:1]
        return b"".join(oid + b"\n" for oid in shown), IOResult(
            exit_code=0 if found else 1
        )
    if ancestor and all_bases:
        raise GitError(
            "options '--is-ancestor' and '--all' cannot be used together"
        )
    if ancestor and len(texts) != 2:
        raise GitError("--is-ancestor takes exactly two commits")
    if len(texts) < 2:
        raise UsageError("", verb_usage(ctx))
    one, bases = await asyncio.to_thread(_merge_base_ids, repo, tuple(texts))
    if ancestor:
        return None, IOResult(exit_code=0 if one in bases else 1)
    return b"".join(
        oid + b"\n" for oid in (bases if all_bases else bases[:1])
    ), IOResult(exit_code=0 if bases else 1)


def _peeled(repo: BaseRepo, oid: str) -> str | None:
    """What an annotated tag finally points at, None for anything else.

    Args:
        repo (BaseRepo): the opened repository.
        oid (str): the ref's object id.
    """
    obj = repo.object_store[ObjectID(oid.encode())]
    if not isinstance(obj, Tag):
        return None
    while isinstance(obj, Tag):
        obj = repo.object_store[obj.object[1]]
    return obj.id.decode()


def _show_ref_lines(
    repo: BaseRepo, names: list[str], fl: FlagView
) -> list[str]:
    """Every row the named refs print.

    Args:
        repo (BaseRepo): the opened repository.
        names (list[str]): the refs, in order, each resolving.
        fl (FlagView): parsed flags.
    """
    table = ref_table(repo)
    dereference = fl.as_bool("dereference")
    digits = fl.raw("hash")
    only_id = digits is not None
    wanted = digits if isinstance(digits, str) else fl.raw("abbrev")
    width = None if wanted is None else abbrev_width(wanted, abbrev_for(repo))
    rows: list[tuple[str, str]] = []
    for name in names:
        oid, _ = resolve_ref(table, name)
        assert oid is not None
        rows.append((oid, name))
        if dereference:
            peeled = _peeled(repo, oid)
            if peeled is not None:
                rows.append((peeled, f"{name}^{{}}"))
    lengths = (
        {}
        if width is None
        else unique_abbreviations(repo, {oid: width for oid, _ in rows})
    )
    lines = []
    for oid, name in rows:
        shown = oid[: lengths.get(oid, len(oid))]
        lines.append(f"{shown}\n" if only_id else f"{shown} {name}\n")
    return lines


def _show_ref_names(
    repo: BaseRepo, patterns: tuple[str, ...], fl: FlagView
) -> list[str]:
    """The refs a listing names: under ``refs/``, in sorted order.

    Args:
        repo (BaseRepo): the opened repository.
        patterns (tuple[str, ...]): whole names or trailing components.
        fl (FlagView): parsed flags.
    """
    table = ref_table(repo)
    heads = fl.as_bool("heads") or fl.as_bool("branches")
    tags = fl.as_bool("tags")
    names = [
        name
        for name in sorted(table)
        if name.startswith("refs/")
        and (
            not (heads or tags)
            or (heads and name.startswith("refs/heads/"))
            or (tags and name.startswith("refs/tags/"))
        )
        and (
            not patterns
            or any(name == p or name.endswith("/" + p) for p in patterns)
        )
        and resolve_ref(table, name)[0] is not None
    ]
    if fl.as_bool("head") and resolve_ref(table, HEAD_REF)[0] is not None:
        names.insert(0, HEAD_REF)
    return names


async def show_ref(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """List references, or test named ones with ``--verify`` and ``--exists``.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the patterns or whole names.
        ctx (Context): the line's context.
    """
    check_switches(ctx, texts)
    fl = FlagView(ctx.flags)
    repo, _ = await opened(ctx, fl)
    table = await asyncio.to_thread(ref_table, repo)
    if fl.as_bool("exists"):
        if not texts:
            raise GitError("--exists requires a reference")
        if len(texts) > 1:
            raise GitError("--exists requires exactly one reference")
        if resolve_ref(table, texts[0])[0] is None:
            return None, IOResult(
                exit_code=2, stderr=b"error: reference does not exist\n"
            )
        return None, IOResult()
    quiet = fl.as_bool("quiet")
    if fl.as_bool("verify"):
        names = []
        for name in texts:
            valid = (name == HEAD_REF or name.startswith("refs/")) and (
                resolve_ref(table, name)[0] is not None
            )
            if not valid:
                if quiet:
                    return None, IOResult(exit_code=1)
                raise GitError(f"'{name}' - not a valid ref")
            names.append(name)
    else:
        names = await asyncio.to_thread(
            _show_ref_names, repo, tuple(texts), fl
        )
    if quiet:
        return None, IOResult(exit_code=0 if names else 1)
    lines = await asyncio.to_thread(_show_ref_lines, repo, names, fl)
    return "".join(lines).encode(), IOResult(exit_code=0 if names else 1)


def _revisions(
    repo: BaseRepo,
    revisions: tuple[str, ...],
    flags: LogFlags,
    dashed: bool = False,
) -> list[bytes]:
    """The lines rev-list prints for its commits: an id each, with
    ``-`` in front of a ``--boundary`` one (git 2.47.3).

    Args:
        repo (BaseRepo): the opened repository.
        revisions (tuple[str, ...]): the revision operands.
        flags (LogFlags): the parsed invocation.
        dashed (bool): whether ``--`` is on the line.
    """
    starts, hidden = walk_ends(repo, revisions, dashed)
    if flags.all_refs:
        starts[:0] = ref_commits(repo)
    walk = walked(repo, starts, flags, tuple(hidden))
    boundary = {commit.id for commit in walk.boundary}
    return [
        (b"-" if commit.id in boundary else b"") + commit.id
        for commit in in_print_order(walk, flags)
    ]


async def rev_list(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    if option_operand(ctx, texts, lone_help(ctx, texts)):
        raise UsageError("", verb_usage(ctx))
    repo, location = await opened(ctx, fl)
    flags = parse_flags(fl)
    revisions, patterns, dashed = await walk_operands(
        ctx, fl, repo, location, texts
    )
    # A line naming only paths has no revision either (git 2.47.3).
    if not revisions and not flags.all_refs:
        raise UsageError("", verb_usage(ctx))
    commits = await asyncio.to_thread(
        _revisions,
        repo,
        revisions,
        replace(flags, pathspecs=patterns),
        dashed,
    )
    return (
        f"{len(commits)}\n".encode()
        if fl.as_bool("count")
        else b"".join(oid + b"\n" for oid in commits)
    ), IOResult()


async def version(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    return f"git version {__version__} (Mirage)\n".encode(), IOResult()


async def _abbreviated(
    vfs: Files,
    gitdir: PathSpec,
    table: DictRefsContainer,
    revision: str,
    strict: bool,
    warn: bool,
    full: bool = False,
) -> tuple[bytes, bytes]:
    """``--abbrev-ref``: the ref a revision names, shortened as git
    shortens it, and the error git prints in its place.

    The name is found by git's rev-parse rules and followed through
    symbolic refs, so HEAD reads as its branch and ``origin/HEAD`` as
    what it points at; then the shortest unambiguous spelling is kept,
    by every other rule under ``strict`` and by the earlier ones
    otherwise. A name two refs answer to prints nothing and an error
    instead, while ``core.warnAmbiguousRefs`` is on; a revision that
    names no ref prints nothing. Pinned against git 2.47.3.

    Args:
        vfs (Files): the session's files.
        gitdir (PathSpec): this checkout's git directory.
        table (DictRefsContainer): every ref, as load_refs reads them.
        revision (str): the revision as typed.
        strict (bool): ``=strict``, or ``core.warnAmbiguousRefs`` when no
            mode is given.
        warn (bool): ``core.warnAmbiguousRefs``.
        full (bool): keep the whole name, for ``--symbolic-full-name``.
    """
    known = frozenset(ref.decode(errors="replace") for ref in table.allkeys())
    named = refs_named(known, revision)
    if warn and len(named) > 1:
        return b"", f"error: refname '{revision}' is ambiguous\n".encode()
    if not named:
        return b"", b""
    found = await resolve_symbolic(vfs, gitdir, table, named[0], True)
    if found is None:
        return b"", b""
    shown = found.name if full else shorten_ref(found.name, known, strict)
    return f"{shown}\n".encode(), b""


def _abbrev_strict(mode: FlagValue, warn: bool) -> bool:
    """How strictly ``--abbrev-ref`` shortens.

    ``strict`` against every other rule, ``loose`` against the earlier
    ones, and with no mode as ``core.warnAmbiguousRefs`` says.

    Args:
        mode (FlagValue): the option's value, True when it has none.
        warn (bool): ``core.warnAmbiguousRefs``.

    Raises:
        AbbrevModeError: any other mode.
    """
    if mode == "strict":
        return True
    if mode == "loose":
        return False
    if isinstance(mode, str):
        raise AbbrevModeError(mode)
    return warn


def _relative(target: str, start: str) -> str:
    """The way from one directory to a path; a directory at or above the
    start ends in a slash, as ``--path-format=relative`` prints it.

    Args:
        target (str): the absolute virtual path to reach.
        start (str): the absolute virtual directory to reach it from.
    """
    to = [part for part in target.split("/") if part]
    at = [part for part in start.split("/") if part]
    shared = 0
    while shared < min(len(to), len(at)) and to[shared] == at[shared]:
        shared += 1
    ups = "../" * (len(at) - shared)
    rest = "/".join(to[shared:])
    return ups + rest if rest else ups or "./"


def _git_path_base(location: RepoLocation, path: str) -> PathSpec:
    """Which git directory holds ``path``: a linked worktree shares most
    of the repository's, as gitrepository-layout(5) lists.

    Args:
        location (RepoLocation): where the repository was found.
        path (str): the path below the git directory.
    """
    top = path.split("/", 1)[0]
    private = any(
        path == name or path.startswith(name + "/")
        for name in PER_WORKTREE_PATHS
    )
    return (
        location.commondir
        if top in SHARED_PATHS and not private
        else location.gitdir
    )


async def _place_of(
    vfs: Files, location: RepoLocation, start: str
) -> _RevParsePlace:
    """Where a rev-parse line runs.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): where the repository was found.
        start (str): the directory the line runs in.
    """
    in_git = in_git_dir(start, location)
    bare = await is_bare(vfs, location)
    top = (
        "/"
        if location.worktree.virtual == "/"
        else location.worktree.virtual + "/"
    )
    in_work_tree = (
        not in_git
        and not bare
        and (start == location.worktree.virtual or start.startswith(top))
    )
    prefix = (
        start[len(top) :] + "/"
        if in_work_tree and start != location.worktree.virtual
        else ""
    )
    return _RevParsePlace(
        location=location,
        start=start,
        top=top,
        bare=bare,
        in_git_dir=in_git,
        in_work_tree=in_work_tree,
        prefix=prefix,
    )


def _beside(place: _RevParsePlace, base: str, tail: str = "") -> str:
    """How a git directory path reads by default: bare at the directory
    itself, through ``.git`` from inside the work tree, absolute otherwise.

    Args:
        place (_RevParsePlace): where the line runs.
        base (str): the absolute git directory.
        tail (str): the path below it, empty for the directory itself.
    """
    if place.start == base:
        return tail or "."
    if place.in_work_tree and base == place.top + GIT_DIR:
        ups = "../" * place.prefix.count("/")
        return f"{ups}{GIT_DIR}/{tail}" if tail else ups + GIT_DIR
    return f"{base}/{tail}" if tail else base


def _formatted(
    place: _RevParsePlace, form: str | None, default: str, path: str
) -> str:
    """A path as the ``--path-format`` in force prints it.

    Args:
        place (_RevParsePlace): where the line runs.
        form (str | None): ``absolute``, ``relative`` or None for default.
        default (str): the option's own spelling when no format is set.
        path (str): the absolute virtual path.
    """
    if form == PATH_ABSOLUTE:
        return path
    if form == PATH_RELATIVE:
        return _relative(path, place.start)
    return default


async def _place_answer(
    vfs: Files, place: _RevParsePlace, word: str, form: str | None
) -> bytes | None:
    """The line a word that reports where git runs prints, None for any
    other word. ``--show-cdup`` prints nothing where no work tree holds
    the line, and the work tree's own path from outside it.

    Args:
        vfs (Files): the session's files.
        place (_RevParsePlace): where the line runs.
        word (str): the word as typed.
        form (str | None): the ``--path-format`` in force.
    """
    location = place.location
    gitdir = location.gitdir.virtual
    common = location.commondir.virtual
    match word:
        case "--show-toplevel":
            top = location.worktree.virtual
            return f"{_formatted(place, form, top, top)}\n".encode()
        case "--git-dir":
            first = place.start == location.worktree.virtual
            default = (
                _beside(place, gitdir)
                if first or place.start == gitdir
                else gitdir
            )
            shown = _formatted(place, form, default, gitdir)
            return f"{shown}\n".encode()
        case "--git-common-dir":
            shown = _formatted(place, form, _beside(place, common), common)
            return f"{shown}\n".encode()
        case "--absolute-git-dir":
            return f"{gitdir}\n".encode()
        case "--show-prefix":
            return f"{place.prefix}\n".encode()
        case "--show-cdup":
            if place.in_git_dir or place.bare:
                return b""
            if not place.in_work_tree:
                return f"{location.worktree.virtual}\n".encode()
            return f"{'../' * place.prefix.count('/')}\n".encode()
        case "--is-inside-work-tree":
            return f"{str(place.in_work_tree).lower()}\n".encode()
        case "--is-inside-git-dir":
            return f"{str(place.in_git_dir).lower()}\n".encode()
        case "--is-bare-repository":
            return f"{str(place.bare).lower()}\n".encode()
        case "--is-shallow-repository":
            shallow = await read_optional(
                vfs, location.commondir.join("shallow")
            )
            return f"{str(shallow is not None).lower()}\n".encode()
        case "--show-ref-format":
            return b"files\n"
        case _:
            return None


def _ref_set(
    table: dict[str, str], word: str, excludes: list[str]
) -> list[tuple[str, str]] | None:
    """The refs a word that lists them selects, each as its spelling and
    id, None for any other word. A pattern with no glob character means
    everything under it, and ``--exclude`` reads the names the listing
    itself reads: short under a namespace, whole under ``--all``.

    Args:
        table (dict[str, str]): every ref's name and id.
        word (str): the word as typed.
        excludes (list[str]): the ``--exclude`` patterns before it.
    """
    name, has_value, value = word.partition("=")
    namespace = REF_NAMESPACES.get(name)
    if word == ALL_REFS:
        prefix, pattern = "", "refs/*"
    elif namespace is not None:
        prefix, pattern = namespace, namespace + "*"
        if has_value:
            pattern = _implied_glob(namespace + value, value)
    elif name == GLOB_OPTION and has_value:
        full = value if value.startswith("refs/") else "refs/" + value
        prefix, pattern = "", _implied_glob(full, value)
    else:
        return None
    chosen = []
    for ref in sorted(table):
        if not fnmatch(ref, pattern):
            continue
        spelled = ref[len(prefix) :]
        if not any(fnmatch(spelled, pat) for pat in excludes):
            chosen.append((spelled, table[ref]))
    return chosen


def _implied_glob(full: str, value: str) -> str:
    if any(char in value for char in GLOB_CHARS):
        return full
    return f"{full}*" if full.endswith("/") else f"{full}/*"


async def _named_line(
    out: _RevParseOutput, spelled: str, sign: str
) -> tuple[bytes, bytes]:
    """The line ``--symbolic-full-name`` or ``--abbrev-ref`` prints.

    Args:
        out (_RevParseOutput): the line's printing state.
        spelled (str): the revision as typed.
        sign (str): ``^`` for a hidden revision, else empty.
    """
    name = await asyncio.to_thread(expand_selector, out.repo, spelled, spelled)
    line, error = await _abbreviated(
        out.vfs,
        out.location.gitdir,
        out.table,
        name,
        out.strict,
        out.warn,
        out.symbolic == SYMBOLIC_FULL,
    )
    return (sign.encode() + line if line else b""), error


async def _show(
    out: _RevParseOutput, spelled: str | None, oid: str, hidden: bool
) -> bytes:
    """Print one revision in the mode the line is in at this word.

    Args:
        out (_RevParseOutput): the line's printing state.
        spelled (str | None): how it was written, None for one with no
            name (a merge base), which every mode prints by id.
        oid (str): the object's id.
        hidden (bool): whether it is a ``^`` revision.
    """
    out.shown = True
    sign = "^" if hidden != out.negated else ""
    if spelled is not None and out.symbolic == SYMBOLIC_AS_TYPED:
        return f"{sign}{spelled}\n".encode()
    if spelled is not None and out.symbolic:
        line, error = await _named_line(out, spelled, sign)
        if error:
            repo = out.repo
            if (
                out.quiet
                or not isinstance(repo, Repo)
                or repo.ambiguous is None
            ):
                out.errors.append(error)
            else:
                repo.ambiguous.append(error.decode())
        return line
    if out.width is None:
        return f"{sign}{oid}\n".encode()
    unique = await asyncio.to_thread(
        unique_abbreviations, out.repo, {oid: out.width}
    )
    return f"{sign}{oid[: unique[oid]]}\n".encode()


def _parent_suffix(word: str) -> tuple[str, str] | None:
    """Split ``A^@``, ``A^!``, ``A^-`` or ``A^-n`` into the commit and
    what follows its caret, None for anything else.

    Args:
        word (str): the word as typed.
    """
    at = word.rfind(PARENT_SUFFIX)
    if at <= 0:
        return None
    tail = word[at + 1 :]
    if tail in ("@", "!", "-") or (
        tail.startswith("-") and tail[1:].isdigit() and int(tail[1:]) > 0
    ):
        return word[:at], tail
    return None


def _parent_rows(
    repo: BaseRepo, word: str, base: str, tail: str
) -> list[tuple[str, str, bool]]:
    """The revisions a parent shorthand expands to.

    Args:
        repo (BaseRepo): the opened repository.
        word (str): the whole word, named when it does not resolve.
        base (str): the commit it starts from.
        tail (str): what follows the caret.

    Raises:
        AmbiguousArgumentError: the commit or the parent does not exist.
    """
    try:
        commit = resolve_commit(repo, base)
    except AmbiguousArgumentError as exc:
        raise AmbiguousArgumentError(word) from exc
    parents = [parent.decode() for parent in commit.parents]
    numbered = [(f"{base}^{at + 1}", oid) for at, oid in enumerate(parents)]
    if tail == "@":
        return [(name, oid, False) for name, oid in numbered]
    head = (base, commit.id.decode(), False)
    if tail == "!":
        return [head, *((name, oid, True) for name, oid in numbered)]
    index = int(tail[1:]) if len(tail) > 1 else 1
    if index > len(numbered):
        raise AmbiguousArgumentError(word)
    return [head, (*numbered[index - 1], True)]


_RevRow = tuple[str | None, str, bool]


def _revision_rows(repo: BaseRepo, word: str) -> list[_RevRow] | None:
    """What a range, a negation or a parent shorthand expands to, None
    for a word that is a single revision.

    Args:
        repo (BaseRepo): the opened repository.
        word (str): the word as typed.

    Raises:
        AmbiguousArgumentError: the word names no such thing.
    """
    ends = None if word == RANGE else range_ends(word)
    if ends is not None:
        left, right, symmetric = ends
        try:
            old = resolve_commit(repo, left)
            new = resolve_commit(repo, right)
        except AmbiguousArgumentError as exc:
            raise AmbiguousArgumentError(word) from exc
        rows: list[_RevRow] = [(right, new.id.decode(), False)]
        if not symmetric:
            return [*rows, (left, old.id.decode(), True)]
        rows.append((left, old.id.decode(), False))
        rows.extend(
            (None, base.id.decode(), True)
            for base in merge_bases(repo, old, new)
        )
        return rows
    parent = _parent_suffix(word)
    if parent is not None:
        return list(_parent_rows(repo, word, *parent))
    if word.startswith(NEGATION) and len(word) > len(NEGATION):
        name = word[len(NEGATION) :]
        try:
            found = resolve_object(repo, name)
        except AmbiguousArgumentError as exc:
            raise AmbiguousArgumentError(word) from exc
        return [(name, found.id.decode(), True)]
    return None


async def _show_revision(out: _RevParseOutput, word: str) -> bool:
    """Print a revision word, False when it names none.

    Under ``--verify`` a single revision waits for the end of the line,
    while what expands to several prints where it stands.

    Args:
        out (_RevParseOutput): the line's printing state.
        word (str): the word as typed.
    """
    try:
        rows = await asyncio.to_thread(_revision_rows, out.repo, word)
        if rows is None:
            found = await asyncio.to_thread(resolve_object, out.repo, word)
            line = await _show(out, word, found.id.decode(), False)
            if out.verify:
                out.counted.append(line)
            else:
                out.rows.append(line)
            return True
    except SelectorError:
        raise
    except GitError as exc:
        out.refused = exc
        return False
    expanded = [
        await _show(out, spelled, oid, hidden) for spelled, oid, hidden in rows
    ]
    if out.verify and len(rows) == 1 and word.startswith(NEGATION):
        out.counted.extend(expanded)
    else:
        out.rows.extend(expanded)
    return True


async def _rev_parse_word(
    out: _RevParseOutput, word: str, words: Iterator[str]
) -> GitError | None:
    """Act on one word of a rev-parse line, in the line's order.

    Returns what stops the line, if anything.

    Args:
        out (_RevParseOutput): the line's printing state.
        word (str): the word as typed.
        words (Iterator[str]): the words after it, for the ones that
            take the next word as their value.
    """
    name, has_value, value = word.partition("=")
    if word == "--verify":
        out.verify = True
    elif word in ("-q", "--quiet"):
        out.quiet = True
    elif name == "--short":
        out.verify = True
        out.width = abbrev_width(
            value if has_value else True, abbrev_for(out.repo)
        )
    elif word in ("--symbolic", "--symbolic-full-name"):
        if out.symbolic != SYMBOLIC_ABBREVIATED:
            out.symbolic = (
                SYMBOLIC_AS_TYPED if word == "--symbolic" else SYMBOLIC_FULL
            )
    elif name == "--abbrev-ref":
        out.symbolic = SYMBOLIC_ABBREVIATED
        out.strict = _abbrev_strict(value if has_value else True, out.warn)
    elif word == "--not":
        out.negated = not out.negated
    elif name == EXCLUDE_OPTION and has_value:
        out.excludes.append(value)
    elif name == "--path-format":
        if not has_value:
            raise GitError("--path-format requires an argument")
        if value not in (PATH_ABSOLUTE, PATH_RELATIVE):
            raise GitError(f"unknown argument to --path-format: {value}")
        out.path_format = value
    elif word in ("--git-path", "--default"):
        following = next(words, None)
        if following is None:
            raise GitError(f"{word} requires an argument")
        if word == "--default":
            out.default = following
        else:
            base = _git_path_base(out.place.location, following).virtual
            path = f"{base}/{following}"
            shown = _formatted(
                out.place,
                out.path_format,
                _beside(out.place, base, following),
                path,
            )
            out.rows.append(f"{shown}\n".encode())
    elif name == "--show-object-format":
        if has_value and value not in OBJECT_FORMAT_MODES:
            raise GitError(f"unknown mode for --show-object-format: {value}")
        out.rows.append(b"sha1\n")
    else:
        return await _rev_parse_operand(out, word, name)
    return None


async def _rev_parse_operand(
    out: _RevParseOutput, word: str, name: str
) -> GitError | None:
    """Act on a word that is not one of the line's modes: a report, a
    ref listing, an option of no meaning here, a revision or a file.

    Args:
        out (_RevParseOutput): the line's printing state.
        word (str): the word as typed.
        name (str): the word up to any ``=``.
    """
    answer = await _place_answer(out.vfs, out.place, word, out.path_format)
    if answer is not None:
        out.rows.append(answer)
        return None
    chosen = _ref_set(out.refs, word, out.excludes)
    if chosen is not None:
        out.excludes = []
        for spelled, oid in chosen:
            out.rows.append(await _show(out, spelled, oid, False))
        return None
    if name in UNBUILT_REV_PARSE_OPTIONS:
        raise UnrecognizedArgumentError(word)
    if word.startswith("-"):
        if not out.verify:
            out.rows.append(f"{word}\n".encode())
        return None
    if not out.files_only and await _show_revision(out, word):
        return None
    if out.verify:
        raise SingleRevisionError()
    if word and await _exists_from(out, word):
        out.files_only = True
        out.rows.append(f"{word}\n".encode())
        return None
    out.rows.append(f"{word}\n".encode())
    return NoSuchPathError(word) if out.files_only else out.refused


async def _exists_from(out: _RevParseOutput, word: str) -> bool:
    return await exists(
        out.vfs,
        PathSpec.from_str_path(absolute_operand(out.place.start, word)),
    )


def _ref_ids(repo: BaseRepo) -> dict[str, str]:
    table = ref_table(repo)
    named = (
        (name, resolve_ref(table, name)[0])
        for name in table
        if name.startswith("refs/")
    )
    return {name: oid for name, oid in named if oid is not None}


async def rev_parse(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Answer each word of the line in the order it is written.

    Each revision's object id, and the answers to the options that report
    where the line runs. A mode set by one word applies to the words after
    it. A dashed word that means nothing here is printed back. With
    ``--verify`` (or ``--short``, which implies it) there must be exactly
    one revision, printed after everything else, and ``-q`` turns the
    refusal into a bare exit 1.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the operands.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    out: _RevParseOutput | None = None
    try:
        option_operand(ctx, texts, lone_help(ctx, texts))
        verb = ctx.argv.index("rev-parse") if "rev-parse" in ctx.argv else -1
        line = ctx.argv[verb + 1 :]
        end = line.index(MARKER) if MARKER in line else len(line)
        mode = fl.raw("abbrev_ref")
        if isinstance(mode, str):
            _abbrev_strict(mode, True)
        toplevel = SHOW_TOPLEVEL in line[:end]
        repo, location = await opened(ctx, fl, work_tree=toplevel)
        assert ctx.vfs is not None
        start = start_point(fl).virtual
        if toplevel and in_git_dir(start, location):
            raise NotAWorkTreeError()
        warn = await config_bool(
            ctx.vfs, location, b"core", b"warnambiguousrefs", True
        )
        out = _RevParseOutput(
            vfs=ctx.vfs,
            repo=repo,
            location=location,
            place=await _place_of(ctx.vfs, location, start),
            table=await load_refs(
                ctx.vfs, location.gitdir, location.commondir
            ),
            refs=await asyncio.to_thread(_ref_ids, repo),
            warn=warn,
            strict=warn,
            quiet=fl.as_bool("quiet"),
        )
        stopped = await _rev_parse_words(out, iter(line))
        if stopped is not None:
            _, refused = fatal(stopped)
            return b"".join(out.rows), refused
        if out.default is not None and not out.shown:
            await _show_revision(out, out.default)
        if out.verify:
            if len(out.counted) != 1:
                raise SingleRevisionError()
            out.rows.extend(out.counted)
        return b"".join(out.rows), IOResult(
            stderr=b"".join(out.errors) or None
        )
    except SingleRevisionError as exc:
        done = None if out is None else b"".join(out.rows) or None
        if out is not None and out.quiet:
            return done, IOResult(exit_code=1)
        _, refused = fatal(exc)
        return done, refused
    except GitError as exc:
        if out is None:
            raise
        done = b"".join(out.rows) or None
        if out.quiet and out.verify:
            return done, IOResult(exit_code=1)
        _, refused = fatal(exc)
        return done, refused
    finally:
        if (
            out is not None
            and out.quiet
            and isinstance(out.repo, Repo)
            and out.repo.ambiguous
        ):
            out.repo.ambiguous.clear()


async def _rev_parse_words(
    out: _RevParseOutput, words: Iterator[str]
) -> GitError | None:
    """Walk the line; after ``--`` the rest is printed as it stands,
    unless ``--verify`` has made the line about one revision.

    Args:
        out (_RevParseOutput): the line's printing state.
        words (Iterator[str]): the words after the verb.
    """
    for word in words:
        if word == MARKER:
            if not out.verify:
                out.rows.extend(f"{w}\n".encode() for w in (word, *words))
            return None
        stopped = await _rev_parse_word(out, word, words)
        if stopped is not None:
            return stopped
    return None
