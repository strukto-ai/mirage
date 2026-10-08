import asyncio
import posixpath
import re
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.refs import DictRefsContainer
from dulwich.repo import BaseRepo

from mirage.commands.builtin.utils.bre import (
    BreError,
    PosixSyntax,
    translate_ere,
)
from mirage.commands.cli.builtin.git.constants import GIT_DIR
from mirage.commands.cli.builtin.git.discover import is_bare
from mirage.commands.cli.builtin.git.errors import (
    AbbrevModeError,
    GitError,
    NotAWorkTreeError,
    NoWorkspaceError,
    SingleRevisionError,
    UnknownSubcommandError,
    UsageError,
)
from mirage.commands.cli.builtin.git.history import (
    LogFlags,
    parse_flags,
    ref_commits,
    select,
)
from mirage.commands.cli.builtin.git.io import read_file, read_optional
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.ref_fields import shorten_ref
from mirage.commands.cli.builtin.git.ref_list import unique_abbreviations
from mirage.commands.cli.builtin.git.refs import load_refs, resolve_symbolic
from mirage.commands.cli.builtin.git.repo import Repo, config_bool
from mirage.commands.cli.builtin.git.revparse import (
    refs_named,
    resolve_object,
    split_revisions,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    STDERR,
    STDOUT,
    check_operands,
    check_switches,
    escaped,
    fatal,
    multivar,
    offending,
    option_operand,
    start_point,
    verb_usage,
)
from mirage.commands.cli.refusal import (
    HELP_SWITCH,
    git_option_refusal,
    git_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.parser import parse_command, parse_to_kwargs
from mirage.commands.spec.types import CommandSpec, FlagValue, Operand, Option
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.utils.posix import compile_posix_regex
from mirage.version import __version__

SHOW_TOPLEVEL = "--show-toplevel"
# git's own global spells `--git-dir` too, so rev-parse cannot declare it:
# it arrives as an operand, and is answered from there.
GIT_DIR_OPTION = "--git-dir"
MIN_ABBREV = 4
HEX_LENGTH = 40
GET_URL = CommandSpec(
    options=(
        Option(
            long="--push", description="query push URLs rather than fetch URLs"
        ),
        Option(long="--all", description="return all URLs"),
        Option(long="--no-push"),
        Option(long="--no-all"),
    ),
    positional=(Operand(type="str", name="name", required=True),),
    rest=Operand(type="str"),
)


async def repo_config(inv: CLIInvocation[None], fl: FlagView) -> ConfigFile:
    doors = inv.doors or CLIDoors()
    _, location = await opened(fl, doors)
    assert doors.dispatch is not None
    return ConfigFile.from_file(
        BytesIO(
            await read_file(doors.dispatch, location.commondir.join("config"))
        )
    )


async def remote(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    try:
        if inv.texts and inv.texts[0] == "get-url":
            return await remote_get_url(inv)
        check_operands(inv, inv.texts)
        if inv.texts:
            raise UnknownSubcommandError(inv.texts[0], verb_usage(inv))
        cfg = await repo_config(inv, fl)
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
    except GitError as exc:
        return fatal(exc)


def _rewrite_url(url: str, rules: list[tuple[str, str]]) -> str:
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
    if not push:
        push = [
            _rewrite_url(url, push_rules)
            for url in urls
            if any(url.startswith(prefix) for prefix, _ in push_rules)
        ] or urls
    return (
        [_rewrite_url(url, rules) for url in urls],
        [_rewrite_url(url, rules) for url in push],
    )


async def remote_get_url(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Read the get-url remainder through the shared option parser.

    Args:
        inv (CLIInvocation[None]): the remote invocation and its verbatim remainder.
    """
    try:
        parsed = parse_command(
            GET_URL,
            list(inv.texts[1:]),
            inv.cwd.virtual,
            unknown_is_operand=True,
        )
        names = tuple(word for word, _ in parsed.args)
        bad = offending(names, escaped(inv.argv), frozenset())
        if bad is not None:
            raise UsageError(
                *git_option_refusal(bad, "remote get-url", GET_URL)
            )
        if len(names) != 1:
            raise UsageError("", git_usage("remote get-url", GET_URL))
        fl = FlagView(parse_to_kwargs(parsed), GET_URL)
        cfg = await repo_config(inv, FlagView(inv.flags))
        name = names[0]
        urls, push = remote_urls(cfg, name)
        if not urls:
            return None, IOResult(
                exit_code=2,
                stderr=f"error: No such remote '{name}'\n".encode(),
            )
        selected = (
            push
            if fl.typed_order("push", "no_push")[-1:] == ["push"]
            else urls
        )
        if fl.typed_order("all", "no_all")[-1:] != ["all"]:
            selected = selected[:1]
        return "".join(f"{url}\n" for url in selected).encode(), IOResult()
    except GitError as exc:
        return fatal(exc)


async def global_sources(
    inv: CLIInvocation[None], listing: bool
) -> list[tuple[str, ConfigFile]]:
    """The per-user config files ``--global`` reads, in git's order.

    ``$GIT_CONFIG_GLOBAL`` alone when set, else the XDG file then
    ``~/.gitconfig``, each read through the dispatcher from the
    session's own ``HOME`` so the answer is the workspace's and never
    the host's. Only ``--list`` refuses when neither exists.

    Args:
        inv (CLIInvocation[None]): the invocation, for its env and doors.
        listing (bool): ``--list`` was given.
    """
    dispatch = inv.doors.dispatch if inv.doors is not None else None
    if dispatch is None:
        raise NoWorkspaceError()
    home = inv.env.get("HOME", "")
    override = inv.env.get("GIT_CONFIG_GLOBAL")
    if override is None and not home:
        raise GitError("$HOME not set")
    target = override or posixpath.join(home, ".gitconfig")
    xdg = inv.env.get("XDG_CONFIG_HOME") or posixpath.join(home, ".config")
    paths = (
        [target]
        if override is not None
        else [posixpath.join(xdg, "git/config"), target]
    )
    sources = []
    for source in paths:
        data = await read_optional(
            dispatch, PathSpec.from_str_path(source, cwd="/")
        )
        if data is not None:
            sources.append((source, ConfigFile.from_file(BytesIO(data))))
    if not sources and listing:
        raise GitError(
            f"unable to read config file '{target}': No such file or directory"
        )
    return sources


async def config(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    try:
        if fl.as_bool("global"):
            sources = await global_sources(inv, fl.as_bool("list"))
        else:
            doors = inv.doors or CLIDoors()
            _, location = await opened(fl, doors)
            assert doors.dispatch is not None
            path = location.commondir.join("config")
            data = await read_file(doors.dispatch, path)
            source = path.raw_path
            ordinary = (
                location.commondir.virtual
                == location.worktree.virtual + "/.git"
            )
            if (
                ordinary
                and start_point(fl).virtual == location.worktree.virtual
            ):
                source = ".git/config"
            sources = [(source, ConfigFile.from_file(BytesIO(data)))]
        listing = fl.as_bool("list")
        regexp = fl.as_bool("get_regexp")
        origin = fl.as_bool("show_origin")
        if not listing and not inv.texts:
            return None, IOResult(
                exit_code=129, stderr=b"error: wrong number of arguments\n"
            )
        key = inv.texts[0] if inv.texts else ""
        try:
            pattern = (
                compile_posix_regex(
                    translate_ere(config_key(key), PosixSyntax.EXTENDED)[0]
                )
                if regexp
                else None
            )
        except (BreError, re.error):
            return None, IOResult(
                exit_code=6,
                stderr=f"error: invalid key pattern: {key}\n".encode(),
            )
        values = []
        for source, cfg in sources:
            for section in cfg.sections():
                for name, value in cfg.items(section):
                    full = b".".join((*section, name.lower())).decode()
                    if listing or (
                        pattern.search(full)
                        if pattern
                        else full == config_key(key)
                    ):
                        values.append((source, full, value.decode()))
        if not listing and not regexp:
            values = values[-1:]
        lines = [
            (f"file:{source}\t" if origin else "")
            + (name + ("=" if listing else " ") if listing or regexp else "")
            + value
            + "\n"
            for source, name, value in values
        ]
        return "".join(lines).encode(), IOResult(
            exit_code=0 if values or listing else 1
        )

    except GitError as exc:
        return fatal(exc)


def _show_refs(repo: BaseRepo, patterns: tuple[str, ...]) -> bytes:
    return "".join(
        f"{repo.refs[ref].decode()} {ref.decode()}\n"
        for ref in sorted(repo.refs.allkeys())
        if ref.startswith(b"refs/")
        and (
            not patterns
            or any(
                ref.decode() == p or ref.decode().endswith("/" + p)
                for p in patterns
            )
        )
    ).encode()


async def show_ref(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    try:
        check_switches(inv, inv.texts)
        repo, _ = await opened(FlagView(inv.flags), inv.doors or CLIDoors())
        out = await asyncio.to_thread(_show_refs, repo, tuple(inv.texts))
        return out, IOResult(exit_code=0 if out else 1)
    except GitError as exc:
        return fatal(exc)


def _revisions(
    repo: BaseRepo, revisions: tuple[str, ...], flags: LogFlags
) -> list[bytes]:
    starts, hidden = split_revisions(repo, revisions)
    if flags.all_refs:
        starts[:0] = ref_commits(repo)
    return [commit.id for commit in select(repo, starts, flags, tuple(hidden))]


async def rev_list(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    try:
        sole = inv.argv[-2:] == ("rev-list", HELP_SWITCH)
        if option_operand(inv, inv.texts, STDOUT if sole else STDERR):
            raise UsageError("", verb_usage(inv))
        repo, _ = await opened(fl, inv.doors or CLIDoors())
        flags = parse_flags(fl)
        if not inv.texts and not flags.all_refs:
            raise UsageError("", verb_usage(inv))
        commits = await asyncio.to_thread(
            _revisions, repo, tuple(inv.texts), flags
        )
        return (
            f"{len(commits)}\n".encode()
            if fl.as_bool("count")
            else b"".join(oid + b"\n" for oid in commits)
        ), IOResult()
    except GitError as exc:
        return fatal(exc)


async def version(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    return f"git version {__version__} (Mirage)\n".encode(), IOResult()


def config_key(key: str) -> str:
    parts = key.split(".")
    parts[0] = parts[0].lower()
    parts[-1] = parts[-1].lower()
    return ".".join(parts)


async def _abbreviated(
    dispatch: DispatchFn,
    gitdir: PathSpec,
    table: DictRefsContainer,
    revision: str,
    strict: bool,
    warn: bool,
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
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (PathSpec): this checkout's git directory.
        table (DictRefsContainer): every ref, as load_refs reads them.
        revision (str): the revision as typed.
        strict (bool): ``=strict``, or ``core.warnAmbiguousRefs`` when no
            mode is given.
        warn (bool): ``core.warnAmbiguousRefs``.
    """
    known = frozenset(ref.decode(errors="replace") for ref in table.allkeys())
    named = refs_named(known, revision)
    if warn and len(named) > 1:
        return b"", f"error: refname '{revision}' is ambiguous\n".encode()
    if not named:
        return b"", b""
    found = await resolve_symbolic(dispatch, gitdir, table, named[0], True)
    if found is None:
        return b"", b""
    return f"{shorten_ref(found.name, known, strict)}\n".encode(), b""


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


def _in_git_dir(start: str, location: RepoLocation) -> bool:
    return start == location.gitdir.virtual or start.startswith(
        location.gitdir.virtual + "/"
    )


async def _place_answers(
    dispatch: DispatchFn, location: RepoLocation, start: str
) -> dict[str, bytes]:
    """The answers to the options that report where the line runs.

    Pinned against git 2.47: ``--git-dir`` is ``.git`` at the top of a
    work tree, ``.`` inside the git directory itself, and absolute
    elsewhere (a subdirectory, a linked worktree); inside the git
    directory there is no work tree, so ``--show-prefix`` is empty and
    ``--show-toplevel`` is refused.

    Args:
        dispatch (DispatchFn): the workspace dispatcher.
        location (RepoLocation): where the repository was found.
        start (str): the directory the line runs in.
    """
    in_git_dir = _in_git_dir(start, location)
    top = (
        "/"
        if location.worktree.virtual == "/"
        else location.worktree.virtual + "/"
    )
    in_work_tree = (
        not in_git_dir
        and not await is_bare(dispatch, location)
        and (start == location.worktree.virtual or start.startswith(top))
    )
    prefix = (
        start[len(top) :] + "/"
        if in_work_tree and start != location.worktree.virtual
        else ""
    )
    if start == location.gitdir.virtual:
        git_dir = "."
    elif (
        start == location.worktree.virtual
        and location.gitdir.virtual == top + GIT_DIR
    ):
        git_dir = GIT_DIR
    else:
        git_dir = location.gitdir.virtual
    return {
        SHOW_TOPLEVEL: f"{location.worktree.virtual}\n".encode(),
        GIT_DIR_OPTION: f"{git_dir}\n".encode(),
        "--show-prefix": f"{prefix}\n".encode(),
        "--is-inside-work-tree": f"{str(in_work_tree).lower()}\n".encode(),
    }


def _short_width(value: FlagValue, fallback: int) -> int:
    """How many hex digits ``--short`` keeps.

    The repository's own width bare, and otherwise the number given,
    read as strtoul reads it, between git's four and the whole id.

    Args:
        value (FlagValue): the option's value.
        fallback (int): the repository's own width.
    """
    if not isinstance(value, str):
        return fallback
    digits = re.match(r"\s*\d+", value)
    width = int(digits.group()) if digits else 0
    return min(max(width, MIN_ABBREV), HEX_LENGTH)


async def rev_parse(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Resolve revisions supplied to rev-parse.

    Each revision's object id, and the answers to the options that report
    where the line runs, in the order the line gives them. With
    ``--verify`` (or ``--short``, which implies it) there must be exactly
    one revision, printed after everything else, and ``-q`` turns the
    refusal into a bare exit 1.

    Args:
        inv (CLIInvocation[None]): the parsed invocation.
    """
    fl = FlagView(inv.flags)
    quiet = fl.as_bool("quiet")
    repo: BaseRepo | None = None
    try:
        marked = escaped(inv.argv)
        revisions = tuple(
            text
            for text in inv.texts
            if text != GIT_DIR_OPTION or text in marked
        )
        check_operands(inv, revisions)
        verb = inv.argv.index("rev-parse") if "rev-parse" in inv.argv else -1
        words = inv.argv[verb + 1 :]
        end = words.index("--") if "--" in words else -1
        named = words if end == -1 else words[:end]
        toplevel = SHOW_TOPLEVEL in named
        mode = fl.raw("abbrev_ref")
        if isinstance(mode, str):
            _abbrev_strict(mode, True)
        doors = inv.doors or CLIDoors()
        repo, location = await opened(fl, doors, work_tree=toplevel)
        assert doors.dispatch is not None
        start = start_point(fl).virtual
        if toplevel and _in_git_dir(start, location):
            raise NotAWorkTreeError()
        answers = await _place_answers(doors.dispatch, location, start)
        if fl.as_bool("is_shallow_repository"):
            shallow = await read_optional(
                doors.dispatch, location.commondir.join("shallow")
            )
            answers["--is-shallow-repository"] = (
                f"{str(shallow is not None).lower()}\n".encode()
            )
        short = fl.raw("short")
        verify = fl.as_bool("verify") or short is not None
        width = (
            None if short is None else _short_width(short, abbrev_for(repo))
        )
        table = await load_refs(
            doors.dispatch, location.gitdir, location.commondir
        )
        warn = await config_bool(
            doors.dispatch, location, b"core", b"warnambiguousrefs", True
        )
        strict = warn if mode is None else _abbrev_strict(mode, warn)
        shown: list[bytes] = []
        errors: list[bytes] = []
        # What stops the line: git prints what it answered before it,
        # then the revision it could not read as one, then the refusal.
        failed: GitError | None = None
        for revision in revisions:
            try:
                oid = (
                    await asyncio.to_thread(resolve_object, repo, revision)
                ).id
            except GitError as exc:
                if verify:
                    raise SingleRevisionError() from exc
                shown.append(f"{revision}\n".encode())
                failed = exc
                break
            if mode is None:
                hexid = oid.decode()
                length = len(hexid)
                if width is not None:
                    unique = await asyncio.to_thread(
                        unique_abbreviations, repo, {hexid: width}
                    )
                    length = unique[hexid]
                shown.append(f"{hexid[:length]}\n".encode())
                continue
            line, error = await _abbreviated(
                doors.dispatch, location.gitdir, table, revision, strict, warn
            )
            shown.append(line)
            # git prints each name's error right after its warning, so the
            # error joins the warnings' list; -q keeps it while it drops them.
            if not error:
                continue
            if quiet or not isinstance(repo, Repo) or repo.ambiguous is None:
                errors.append(error)
            else:
                repo.ambiguous.append(error.decode())
        if verify and len(shown) != 1:
            raise SingleRevisionError()
        rows: list[bytes] = []
        next_at = 0
        for at, word in enumerate(words):
            if failed is not None and next_at == len(shown):
                break
            ended = end != -1 and at > end
            answer = None if ended else answers.get(word)
            if answer is not None:
                rows.append(answer)
            elif (
                not verify
                and (ended or not word.startswith("-"))
                and next_at < len(shown)
            ):
                rows.append(shown[next_at])
                next_at += 1
        rows.extend(shown[next_at:])
        if failed is not None:
            _, refused = fatal(failed)
            return b"".join(rows), refused
        return b"".join(rows), IOResult(stderr=b"".join(errors) or None)
    except SingleRevisionError as exc:
        if quiet:
            return None, IOResult(exit_code=1)
        return fatal(exc)
    except GitError as exc:
        return fatal(exc)
    finally:
        if quiet and isinstance(repo, Repo) and repo.ambiguous:
            repo.ambiguous.clear()
