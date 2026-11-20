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

import asyncio
import logging
import posixpath
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import cast

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.rg_glob import (
    IgnoreSources,
    Overrides,
    Verdict,
    walk_candidate,
)
from mirage.commands.builtin.rg_scan import IgnoreReader, dir_rules, root_stack
from mirage.commands.builtin.utils.links import dispatch_of, mount_view
from mirage.commands.builtin.utils.tree import WalkBudget, before_full_walk
from mirage.commands.cli.builtin.ast_grep.config import AstGrepConfig
from mirage.commands.cli.builtin.ast_grep.engine import process
from mirage.commands.cli.types import CLI, CLIHandler, DefaultCommandRoot
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.context.session_context import current_caller
from mirage.errors.constants import FS_ERRORS
from mirage.io.cooperative import read_prefix
from mirage.io.errors import MemoryExhausted
from mirage.io.memory import check_memory, memory_room
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.view.types import MountView
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)

LANGUAGES = {
    "javascript": "JavaScript",
    "js": "JavaScript",
    "jsx": "JavaScript",
    "py": "Python",
    "python": "Python",
    "ts": "TypeScript",
    "typescript": "TypeScript",
    "tsx": "Tsx",
}
EXTENSIONS = {
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".py3": "Python",
    ".pyi": "Python",
    ".bzl": "Python",
    ".bazel": "Python",
    ".ts": "TypeScript",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    ".tsx": "Tsx",
}
UNBUNDLED_EXTENSIONS = frozenset(
    {
        "bash",
        "bats",
        "cgi",
        "command",
        "env",
        "fcgi",
        "ksh",
        "sh",
        "tmux",
        "tool",
        "zsh",
        "c",
        "h",
        "cc",
        "hpp",
        "cpp",
        "c++",
        "hh",
        "cxx",
        "cu",
        "ino",
        "cs",
        "css",
        "scss",
        "dart",
        "ex",
        "exs",
        "go",
        "hs",
        "hcl",
        "nomad",
        "tf",
        "tfvars",
        "workflow",
        "html",
        "htm",
        "xhtml",
        "java",
        "json",
        "kt",
        "ktm",
        "kts",
        "lua",
        "markdown",
        "md",
        "nix",
        "php",
        "rb",
        "rbw",
        "gemspec",
        "rs",
        "scala",
        "sc",
        "sbt",
        "sol",
        "swift",
        "yaml",
        "yml",
        "zig",
    }
)
_CURRENT_DIR = re.compile(r"^(?:\./)+")


def _extension(path: str) -> str:
    return posixpath.splitext(path)[1][1:]


GLOBS = Argument(
    "--globs", action="append", help="Include or exclude matching paths"
)
PATHS = Argument(
    "paths",
    nargs="*",
    type="path",
    help="Files or directories in the workspace",
)
LANG = Argument("-l", "--lang", help="JavaScript, Python, TypeScript or TSX")
STDIN = Argument(
    "--stdin", action="store_true", help="Read source from standard input"
)
NO_IGNORE = Argument(
    "--no-ignore",
    action="append",
    metavar="FILE_TYPE",
    choices=("hidden", "dot", "exclude", "global", "parent", "vcs"),
    help="Ignore files or hidden entries not to respect",
)
UPDATE = Argument(
    "-U", "--update-all", action="store_true", help="Apply rewrites"
)


class _FilesReader:
    """How an ast-grep walk reads ignore files, each bounded by the
    command's memory.

    Args:
        vfs (Files): the session's files.
        max_memory (int): the most bytes one read may hold.
    """

    def __init__(self, vfs: Files, max_memory: int) -> None:
        self._vfs = vfs
        self._max_memory = max_memory

    async def read(self, path: str) -> bytes | None:
        """A file's bytes, None when no file stands there.

        Args:
            path (str): the file's virtual path.
        """
        file = PathSpec.from_str_path(path)
        if not await self._vfs.is_file(file):
            return None
        return await _read(self._vfs, file, self._max_memory)

    async def names(self, dir_: str) -> frozenset[str] | None:
        """A directory's entry names, None when it cannot be listed.

        Args:
            dir_ (str): the directory's virtual path.
        """
        try:
            entries, _ = await self._vfs.dispatch(
                "readdir", PathSpec.from_str_path(dir_)
            )
        except FS_ERRORS as exc:
            logger.debug("ast-grep: cannot list %s: %s", dir_, exc)
            return None
        return frozenset(
            posixpath.basename(entry.rstrip("/") or entry) for entry in entries
        )


@dataclass(frozen=True)
class _Walk:
    """Which ignore files a walk reads and whether it walks hidden
    entries: ast-grep's defaults with every ``--no-ignore`` value applied.
    ``global`` names git's own config, which no workspace has.

    Args:
        sources (IgnoreSources): the ignore files read.
        hidden (bool): hidden entries are walked.
        reader (IgnoreReader): how the ignore files are read.
    """

    sources: IgnoreSources
    hidden: bool
    reader: IgnoreReader


def _walk_of(off: frozenset[str], vfs: Files, max_memory: int) -> _Walk:
    vcs = "vcs" not in off
    return _Walk(
        IgnoreSources(
            vcs=vcs,
            exclude=vcs and "exclude" not in off,
            dot="dot" not in off,
            custom=None,
            parents="parent" not in off,
            require_git=True,
            bom=True,
        ),
        "hidden" in off,
        _FilesReader(vfs, max_memory),
    )


async def _files(
    vfs: Files,
    root: PathSpec,
    shown: str,
    budget: WalkBudget,
    cwd: PathSpec,
    globs: Overrides,
    walk: _Walk,
) -> AsyncIterator[tuple[PathSpec, str]]:
    if (await vfs.stat(root)).type == FileType.FILE:
        yield root, shown
        return
    pending = [
        (
            root,
            shown,
            await root_stack(root.virtual, walk.sources, walk.reader),
        )
    ]
    while pending:
        path, display, stack = pending.pop()
        stat = await vfs.stat(path, nofollow=path != root)
        is_dir = stat.type == FileType.DIRECTORY
        if path != root:
            verdict = globs.verdict(
                walk_candidate(display, cwd.virtual), is_dir
            )
            if verdict == Verdict.NONE:
                verdict = stack.verdict(path.virtual, is_dir)
            if verdict == Verdict.IGNORE or (
                verdict == Verdict.NONE
                and not walk.hidden
                and posixpath.basename(path.virtual).startswith(".")
            ):
                continue
        if stat.type == FileType.FILE:
            yield path, display
        elif is_dir and budget.opens(path.virtual):
            limit = budget.listing_limit(path.virtual)
            children, _ = await vfs.dispatch(
                "readdir",
                path,
                **({"limit": limit} if limit is not None else {}),
            )
            selected = []
            names: set[str] = set()
            for child in children:
                if not budget.spend(path.virtual):
                    break
                name = posixpath.basename(child.rstrip("/"))
                names.add(name)
                selected.append(
                    (
                        PathSpec.from_str_path(child),
                        posixpath.join(display, name),
                    )
                )
            if not budget.stopped:
                own = await dir_rules(
                    path.virtual, frozenset(names), walk.sources, walk.reader
                )
                below = stack if own is None else stack.within(own)
                pending.extend(
                    (child, shown, below)
                    for child, shown in reversed(selected)
                )
        if budget.stopped:
            raise UsageError(f"ast-grep: {budget.stopped[0]}", 1)


async def _read(
    vfs: Files,
    path: PathSpec | None,
    max_memory: int,
    stdin: ByteSource | None = None,
) -> bytes:
    room = memory_room()
    limit = min(max_memory, room if room is not None else max_memory)
    data = (
        await vfs.read(path, size=limit + 1, raw=True)
        if path is not None
        else await read_prefix(stdin or b"", limit + 1)
    )
    if len(data) > limit:
        raise MemoryExhausted()
    return data


async def _rules(
    fl: FlagView,
    vfs: Files,
    cwd: PathSpec,
    mounts: MountView | None,
    ctx: Context,
    max_memory: int,
) -> tuple[str, PathSpec]:
    rule, inline, config = (
        fl.as_path("rule"),
        fl.as_str("inline_rules"),
        fl.as_path("config"),
    )
    if sum(value is not None for value in (rule, inline, config)) > 1:
        raise UsageError("ast-grep scan: select one rule source")
    if inline is not None:
        return inline, cwd
    if rule is not None:
        return _decode_rule(await _read(vfs, rule, max_memory)), rule.parent
    if config is None:
        folder = cwd
        while not await vfs.exists(folder.join("sgconfig.yml")):
            if folder.virtual == "/":
                raise UsageError("ast-grep scan: no sgconfig.yml found")
            folder = folder.parent
        config = folder.join("sgconfig.yml")
    room = memory_room()
    dirs = await asyncio.to_thread(
        process,
        {"verb": "config"},
        await _read(vfs, config, max_memory),
        room if room is not None else 2**53 - 1,
        max_memory,
    )
    documents = bytearray()
    for name in dirs["values"]:
        root = config.parent.join(name)
        await before_full_walk(dispatch_of(ctx), root, "ast-grep")
        async for path, _ in _files(
            vfs,
            root,
            root.virtual,
            WalkBudget(root, mounts),
            cwd,
            Overrides([], [], False),
            _walk_of(frozenset({"parent"}), vfs, max_memory),
        ):
            if path.virtual.endswith((".yaml", ".yml")):
                data = await _read(vfs, path, max_memory)
                if len(documents) + len(data) + 5 > max_memory:
                    raise MemoryExhausted()
                check_memory(len(documents) + len(data) + 5)
                if documents:
                    documents.extend(b"\n---\n")
                documents.extend(data)
    return _decode_rule(documents), config.parent


def _decode_rule(data: bytes | bytearray) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise UsageError("ast-grep scan: rule is not valid UTF-8") from exc


async def execute(
    accessor: NOOPAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[bytes, IOResult]:
    """Run the selected ast-grep verb over the session's files."""
    if ctx.vfs is None or ctx.spec is None:
        raise RuntimeError("ast-grep needs workspace files")
    max_memory = cast(AstGrepConfig, accessor.config).max_memory
    vfs, verb = ctx.vfs, ctx.spec.name
    fl = FlagView(ctx.flags, ctx.spec)
    command = current_caller().command or "ast-grep"
    if not command.endswith(f" {verb}"):
        command = f"{command} {verb}"
    mounts = mount_view(vfs, crossing=True, command=command)
    stdin = fl.as_bool("stdin")
    selected = fl.as_str("lang")
    language = LANGUAGES.get(selected.lower()) if selected else None
    if selected and language is None:
        raise UsageError(f"ast-grep: unsupported language: {selected}")
    pattern = rewrite = kind = rules = None
    rule_base = ctx.cwd
    files_only = False
    update = verb in ("run", "scan") and fl.as_bool("update_all")
    if update and not any(arg in ("-U", "--update-all") for arg in ctx.argv):
        raise UsageError(
            "ast-grep: use -U or --update-all as a separate option"
        )
    if verb == "run":
        pattern, kind, rewrite = (
            fl.as_str("pattern"),
            fl.as_str("kind"),
            fl.as_str("rewrite"),
        )
        files_only = fl.as_bool("files_with_matches")
        if (pattern is None) == (kind is None):
            raise UsageError(
                "ast-grep run: specify either --pattern or --kind"
            )
        if update and rewrite is None:
            raise UsageError("ast-grep: --update-all requires --rewrite")
        if files_only and rewrite is not None:
            raise UsageError(
                "ast-grep: --files-with-matches conflicts with --rewrite"
            )
    if verb == "scan":
        rules, rule_base = await _rules(
            fl, vfs, ctx.cwd, mounts, ctx, max_memory
        )
        room = memory_room()
        meta = await asyncio.to_thread(
            process,
            {"verb": "rules"},
            rules.encode(),
            room if room is not None else 2**53 - 1,
            max_memory,
        )
        if stdin and language is None and len(meta["values"]) == 1:
            language = meta["values"][0]
    if stdin and (paths or language is None):
        raise UsageError("ast-grep: --stdin requires a language and no paths")
    globs = Overrides(fl.as_list("globs"), [], False)
    walk = _walk_of(frozenset(fl.as_list("no_ignore")), vfs, max_memory)
    roots = paths or [ctx.cwd]
    directory = False
    if not stdin:
        for root in roots:
            if (await vfs.stat(root)).type == FileType.DIRECTORY:
                directory = True
                await before_full_walk(dispatch_of(ctx), root, "ast-grep")
            elif language is None and (ext := _extension(root.virtual)) in (
                UNBUNDLED_EXTENSIONS
            ):
                raise UsageError(f"ast-grep: unsupported language: {ext}")
    options = dict[str, str | bool | None](
        verb=verb,
        pattern=pattern,
        kind=kind,
        rewrite=rewrite,
        rules=rules,
        directory=directory,
        files_only=files_only,
        update=update,
        style=fl.as_str("report_style") if verb == "scan" else None,
        filter=fl.as_str("match") if verb == "outline" else None,
        symbol=fl.as_str("type") if verb == "outline" else None,
        view=fl.as_str("view", "auto") if verb == "outline" else "auto",
        items=fl.as_str("items") if verb == "outline" else None,
        pub_members=verb == "outline" and fl.as_bool("pub_members"),
    )
    out = bytearray()
    matched = errors = applied = 0

    async def visit(
        data: bytes, path: PathSpec | None, shown: str, lang: str
    ) -> None:
        nonlocal matched, errors, applied
        room = memory_room()
        prefix = rule_base.virtual.rstrip("/") + "/"
        rule_path = (
            path.virtual[len(prefix) :]
            if verb == "scan"
            and path is not None
            and path.virtual.startswith(prefix)
            else shown
        )
        result = await asyncio.to_thread(
            process,
            {
                **options,
                "language": lang,
                "path": shown,
                "rule_path": rule_path,
            },
            data,
            (room if room is not None else 2**53 - 1) - len(out),
            max_memory,
        )
        matched += result["count"]
        errors += result["errors"]
        output = result["output"].encode()
        if output:
            if out and verb == "outline":
                out.extend(b"\n")
            check_memory(len(out) + len(output))
            out.extend(output)
        if update and result["updated"] is not None:
            replacement = result["updated"].encode()
            if path is None:
                check_memory(len(out) + len(replacement) + 1)
                out.extend(replacement + b"\n")
            else:
                await vfs.write(path, replacement)
            applied += result["applied"]

    if stdin:
        assert language is not None
        await visit(
            await _read(vfs, None, max_memory, ctx.stdin),
            None,
            "STDIN",
            language,
        )
    else:
        for root in roots:
            shown = (root.raw_path or root.virtual) if paths else ""
            async for path, display in _files(
                vfs,
                root,
                shown,
                WalkBudget(root, mounts),
                ctx.cwd,
                globs,
                walk,
            ):
                lang = (
                    language
                    if path is root and language is not None
                    else EXTENSIONS.get(posixpath.splitext(path.virtual)[1])
                )
                if lang and (language is None or lang == language):
                    data = await _read(vfs, path, max_memory)
                    if not data:
                        continue
                    await visit(
                        data,
                        path,
                        display
                        if verb == "outline"
                        else _CURRENT_DIR.sub("", display),
                        lang,
                    )
    if verb == "outline" and not out:
        out.extend(b"nothing found\n")
    stderr = f"Applied {applied} changes\n" if applied else ""
    if errors:
        stderr += (
            f"Error: {errors} error(s) found in code.\n"
            "Help: Scan succeeded and found error level diagnostics "
            "in the codebase.\n\n"
        )
    check_memory(2 * len(out))
    return bytes(out), IOResult(
        exit_code=int(bool(errors or (verb == "run" and not matched))),
        stderr=stderr.encode(),
    )


AST_GREP = CLI(
    config_model=AstGrepConfig,
    vfs_only=True,
    spec=DefaultCommandRoot(
        name="ast-grep",
        description="Search and rewrite source code by syntax",
        usage_style=UsageStyle.CLAP,
        subcommands=(
            CommandSpec(
                name="run",
                description="Search or rewrite a code pattern",
                arguments=(
                    Argument("-p", "--pattern", help="Code pattern"),
                    Argument(
                        "-k", "--kind", help="Syntax node kind or selector"
                    ),
                    Argument("-r", "--rewrite", help="Replacement pattern"),
                    UPDATE,
                    Argument("--files-with-matches", action="store_true"),
                    LANG,
                    STDIN,
                    NO_IGNORE,
                    GLOBS,
                    PATHS,
                ),
            ),
            CommandSpec(
                name="scan",
                description="Scan with YAML rules",
                arguments=(
                    UPDATE,
                    Argument(
                        "-c",
                        "--config",
                        type="path",
                        help="Workspace project configuration",
                    ),
                    Argument(
                        "-r", "--rule", type="path", help="Workspace rule file"
                    ),
                    Argument("--inline-rules", help="YAML rules"),
                    Argument(
                        "--report-style",
                        choices=("rich", "medium", "short"),
                        help="Diagnostic presentation",
                    ),
                    LANG,
                    STDIN,
                    NO_IGNORE,
                    GLOBS,
                    PATHS,
                ),
            ),
            CommandSpec(
                name="outline",
                description="Outline source symbols",
                arguments=(
                    Argument(
                        "--match", help="Filter top-level items by regex"
                    ),
                    Argument("--type", help="Comma-separated symbol types"),
                    Argument(
                        "--items",
                        choices=(
                            "auto",
                            "structure",
                            "exports",
                            "imports",
                            "all",
                        ),
                        help="Top-level items to include",
                    ),
                    Argument(
                        "--pub-members",
                        action="store_true",
                        help="Show only public members",
                    ),
                    Argument(
                        "--view",
                        choices=(
                            "auto",
                            "names",
                            "signatures",
                            "digest",
                            "expanded",
                        ),
                        help="Outline presentation",
                    ),
                    LANG,
                    STDIN,
                    NO_IGNORE,
                    GLOBS,
                    PATHS,
                ),
            ),
        ),
    ),
    handlers={
        "run": CLIHandler(fn=execute, write_when=("-U", "--update-all")),
        "scan": CLIHandler(fn=execute, write_when=("-U", "--update-all")),
        "outline": CLIHandler(fn=execute),
    },
)
