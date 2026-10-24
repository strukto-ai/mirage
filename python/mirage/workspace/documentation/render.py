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


from collections.abc import Iterator, Sequence
from dataclasses import replace

from mirage.commands.builtin.general import COMMANDS as GENERAL_COMMANDS
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.commands.cli.walk import node_help, owns_argv
from mirage.commands.spec.standard import standard_request
from mirage.commands.spec.types import CommandSpec, UsageStyle
from mirage.context import effective_path_mode
from mirage.policy.match.decide import decide
from mirage.policy.match.pattern import pattern_reaches, split_pattern
from mirage.policy.types import CommandContext, Outcome
from mirage.types import MountMode, PathSpec
from mirage.utils.hidden import is_glob, path_visible
from mirage.workspace.documentation.constants import (
    ASKS,
    CHANGES,
    INTRO,
    READS,
    REFUSED,
    WALKS,
)
from mirage.workspace.documentation.types import Change
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.node.admission import unlisted_service
from mirage.workspace.session.session import SessionState

SHARED = frozenset(c.name for c in (*GENERIC_COMMANDS, *GENERAL_COMMANDS))
SEARCHES = ("grep -r", "rg")
FINDS = ("grep", "rg")


def listed(
    registry: MountRegistry, session: SessionState
) -> Iterator[tuple[MountEntry, str, MountMode]]:
    """The mounts the documents describe, each with its prefix and the
    mode in force there: every one the session sees but mirage's own.

    Args:
        registry (MountRegistry): the workspace's live mount registry.
        session (SessionState): the session bound by the caller.
    """
    for mount in sorted(registry.visible_mounts(), key=lambda m: m.prefix):
        prefix = mount.prefix.rstrip("/") or "/"
        if (
            prefix in {"/dev", "/usr/bin", "/.bash_history"}
            or mount.vfs.name in {"dev", "history", "bin", "document"}
            or not path_visible(session.visibility, prefix)
        ):
            continue
        yield (
            mount,
            prefix,
            effective_path_mode(prefix, mount.prefix, mount.mode),
        )


def allowed(
    session: SessionState,
    cwd: str,
    words: Sequence[str],
    inside: bool = False,
    registry: MountRegistry | None = None,
) -> bool:
    """Whether the session's profile lets a line of ``words`` run in
    ``cwd``: the documents name nothing the profile refuses.

    Args:
        session (SessionState): the session the documents are for.
        cwd (str): where the line would run.
        words (Sequence[str]): the command and its words; empty for a
            redirection, which no rule names.
        inside (bool): whether the line names a file under ``cwd``, so
            that a rule written for paths there speaks; a CLI names none.
        registry (MountRegistry | None): the CLIs, so that a CLI reaching
            a service is refused as execution refuses it under a profile
            that hides paths; None for a file command.
    """
    if not words:
        return True
    paths = (
        (PathSpec.from_str_path(cwd.rstrip("/") + "/<file>"),)
        if inside
        else ()
    )
    ctx = CommandContext(
        command=words[0], paths=paths, argv=tuple(words[1:]), cwd=cwd
    )
    if registry is not None and unlisted_service(ctx, registry, session):
        return False
    return decide(ctx, session.commands).outcome is not Outcome.DENY


def forms(
    session: SessionState, words: Sequence[str], spec: CommandSpec | None
) -> list[tuple[str, ...]]:
    """The lines that stand for ``words`` under the session's profile:
    the words as they stand, and followed by what each longer pattern in
    its allow list adds (``rm -f`` where the list holds only that),
    unless ``spec`` answers that line with ``--help`` or ``--version``.

    Args:
        session (SessionState): the session the document is for.
        words (Sequence[str]): the command and its words.
        spec (CommandSpec | None): the command's grammar; None to count
            every form.
    """
    found = [tuple(words)]
    rules = session.commands
    if words and rules is not None and rules.allow is not None:
        for pattern in rules.allow:
            form = (*words, *split_pattern(pattern)[len(words) :])
            if (
                len(form) > len(words)
                and pattern_reaches(pattern, words)
                and standard_request(words[0], spec, list(form[1:])) is None
            ):
                found.append(form)
    return found


def runnable(
    session: SessionState,
    mount: MountEntry,
    path: str,
    words: Sequence[str],
    claimed: Sequence[tuple[str, ...]] = (),
) -> bool:
    """Whether the profile lets some line of ``words`` do its work on a
    file under ``path``.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount holding ``path``.
        path (str): the path described.
        words (Sequence[str]): the command and its words.
        claimed (Sequence[tuple[str, ...]]): longer commands answered on
            their own, so a form starting with one does not count here.
    """
    spec = mount.spec_for(words[0]) if words else None
    return any(
        allowed(session, path, form, True)
        for form in forms(session, words, spec)
        if not any(form[: len(k)] == k for k in claimed)
    )


def admitted(
    session: SessionState, mount: MountEntry, path: str, change: Change
) -> bool:
    """Whether the profile lets ``change`` run at ``path``. A longer form
    another change names (``tee -a`` for ``tee``) counts for that change
    alone, since it runs on that change's ops.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount holding ``path``.
        path (str): the path described.
        change (Change): the change.
    """
    size = len(change.command)
    claimed = [
        other.command
        for other in CHANGES
        if len(other.command) > size and other.command[:size] == change.command
    ]
    return runnable(session, mount, path, change.command, claimed)


def uses(
    session: SessionState, mount: MountEntry, path: str, name: str
) -> tuple[bool, bool]:
    """Whether the profile lets the mount's own command ``name`` run at
    ``path`` without changing files, and whether it lets it change them.
    A command tree answers leaf by leaf, each by its own ``write``.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount holding ``path``.
        path (str): the path described.
        name (str): the command.
    """
    tree = mount.cli_for(name)
    if tree is None:
        ok = runnable(session, mount, path, (name,))
        writes = mount.may_write(name)
        return ok and not writes, ok and writes
    leaves = [
        (
            handler.write,
            runnable(session, mount, path, (name, *verbs.split())),
        )
        for verbs, handler in tree.handlers.items()
        if handler.fn is not None
    ]
    return (
        any(ok and not write for write, ok in leaves),
        any(ok and write for write, ok in leaves),
    )


def writers(session: SessionState, mount: MountEntry, path: str) -> list[str]:
    """The mount's own commands that the profile lets change files at
    ``path``.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount holding ``path``.
        path (str): the path described.
    """
    return [
        name
        for name in sorted(set(mount.commands()) - SHARED)
        if uses(session, mount, path, name)[1]
    ]


def works(mount: MountEntry, change: Change) -> bool:
    return any(all(mount.answers(op) for op in ops) for ops in change.needs)


def code(text: str) -> str:
    return "`" + text.replace("|", "\\|") + "`"


def listing(items: Sequence[str]) -> str:
    if len(items) < 2:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def agree(items: Sequence[str], verb: str) -> str:
    return verb if len(items) > 1 else verb + "s"


def fenced(text: str, info: str) -> str:
    """``text`` in a code fence longer than any fence line inside it.

    Args:
        text (str): the block's content.
        info (str): the fence's info string.
    """
    fence = "`" * max(
        3,
        max(
            (len(s) for s in text.split("\n") if s and set(s) == {"`"}),
            default=0,
        )
        + 1,
    )
    return f"{fence}{info}\n{text}\n{fence}"


def table(head: tuple[str, str], rows: Sequence[tuple[str, str]]) -> str:
    lines = [f"| {head[0]} | {head[1]} |", "| --- | --- |"]
    lines.extend(f"| {path} | {text} |" for path, text in rows)
    return "\n".join(lines)


def granted(
    session: SessionState, mount: MountEntry, path: str, mode: MountMode
) -> MountMode:
    """The mode VFS.md states for ``path``: ``read`` where a write mode
    lets no command the profile allows change a file there, neither a
    Unix one nor one of the mount's own.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount holding ``path``.
        path (str): the path described.
        mode (MountMode): the mode in force at ``path``.
    """
    if (
        mode == MountMode.WRITE
        and not writers(session, mount, path)
        and not any(
            works(mount, c)
            for c in CHANGES
            if admitted(session, mount, path, c)
        )
    ):
        return MountMode.READ
    return mode


def supported(
    session: SessionState, mount: MountEntry, path: str, mode: MountMode
) -> str:
    """What one path supports, as VFS.md states it.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount holding ``path``.
        path (str): the path described.
        mode (MountMode): the mode VFS.md states for it.
    """

    def runs(words: Sequence[str]) -> bool:
        return runnable(session, mount, path, words)

    reads = [code(c) for c in READS if runs((c,))]
    changes = [c for c in CHANGES if admitted(session, mount, path, c)]
    working = [
        c.label for c in changes if mode != MountMode.READ and works(mount, c)
    ]
    unrestricted = len(reads) == len(READS) and len(changes) == len(CHANGES)
    if unrestricted and working and 2 * len(working) > len(changes):
        parts = ["Almost all Unix commands."]
    else:
        text = "Commands that read files"
        if reads:
            text += f" ({', '.join(reads)} and the rest)"
        if working:
            text += f", and {listing(working)}"
        parts = [text + "."]
    name = code(mount.vfs.name)
    word = ("-w",) if mount.vfs.whole_word_search else ()
    searches = [code(c) for c in SEARCHES if runs((*c.split(), *word))]
    if searches and mount.answers("files_containing"):
        word_text = " with `-w`" if word else ""
        parts.append(
            f"{listing(searches)}{word_text} {agree(searches, 'use')} "
            f"{name} search."
        )
    finds = [code(c) for c in FINDS if runs((c,))]
    if finds and mount.answers("lines_containing"):
        parts.append(
            f"{listing(finds)} {agree(finds, 'ask')} {name} for the "
            "matching lines."
        )
    asks = [
        code(command)
        for op, command in ASKS
        if mount.answers(op) and runs(command.split())
    ]
    if asks:
        parts.append(
            f"{listing(asks)} {agree(asks, 'ask')} {name} instead of "
            "reading a file."
        )

    def offered(name: str) -> bool:
        reads, writes = uses(session, mount, path, name)
        return reads or (writes and mode != MountMode.READ)

    own = [
        code(n) for n in sorted(set(mount.commands()) - SHARED) if offered(n)
    ]
    if own:
        parts.append(f"Also {listing(own)}.")
    return " ".join(parts)


def limitations(
    session: SessionState, mount: MountEntry, path: str, mode: MountMode
) -> str:
    """Where one path differs from a local filesystem.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount holding ``path``.
        path (str): the path described.
        mode (MountMode): the mode VFS.md states for it.
    """

    def runs(words: Sequence[str]) -> bool:
        return runnable(session, mount, path, words)

    parts: list[str] = []
    if mode == MountMode.READ:
        parts.append("Read only: no command changes files.")
    else:
        changes = [c for c in CHANGES if admitted(session, mount, path, c)]
        missing = [c.label for c in changes if not works(mount, c)]
        if missing and len(missing) == len(changes):
            parts.append("No Unix command changes files.")
        elif missing:
            parts.append(f"Not supported: {', '.join(missing)}.")
    vfs = mount.vfs
    word = ("-w",) if vfs.whole_word_search else ()
    searches = [code(c) for c in SEARCHES if runs((*c.split(), *word))]
    if searches and mount.answers("files_containing"):
        reads = f"{listing(searches)} {agree(searches, 'read')}"
        if vfs.whole_word_search:
            parts.append(f"Without `-w`, {reads} every file.")
        if vfs.searchable is not None:
            globs = listing([code(g) for g in vfs.searchable])
            parts.append(
                f"{code(vfs.name)} search covers only {globs}; "
                f"{reads} every other file."
            )
    if vfs.walk_limit >= 0:
        limit = vfs.walk_limit
        walks = [code(c) for c in WALKS if runs(c.split())]
        refused = [code(c) for c in REFUSED if runs(c.split())]
        text = (
            f"{listing(walks)} {agree(walks, 'stop')} after {limit} files; "
            "a glob matching more"
            if walks
            else f"A glob matching more than {limit} files"
        )
        text += (
            f", {listing(refused)} are refused" if refused else " is refused"
        )
        parts.append(text + ".")
    return " ".join(parts) or "None."


def vfs_md(registry: MountRegistry, session: SessionState) -> str:
    """Describe the current namespace without enumerating backend data:
    each path, its layout, and the Unix commands it supports.

    Args:
        registry (MountRegistry): the workspace's live mount registry.
        session (SessionState): the session bound by the caller.
    """
    paths: list[tuple[str, str]] = []
    layouts: list[str] = []
    commands: list[tuple[str, str]] = []
    limits: list[tuple[str, str]] = []
    vis = session.visibility
    for mount, prefix, mode in listed(registry, session):
        shown = granted(session, mount, prefix, mode)
        paths.append((code(prefix), f"{code(mount.vfs.name)}, {shown.value}"))
        commands.append(
            (code(prefix), supported(session, mount, prefix, shown))
        )
        limits.append(
            (code(prefix), limitations(session, mount, prefix, shown))
        )
        # Backend prose is not a permission document. Under a restricted
        # view it can advertise hidden paths or verbs, so describe only
        # structured facts rather than interpolate unrestricted guidance.
        if (
            vis.paths is None
            and vis.shown is None
            and session.commands is None
            and mode == mount.mode
            and mount.vfs.vfs_md.strip()
        ):
            layout = (
                mount.vfs.vfs_md.replace("{prefix}", prefix)
                .strip("\n")
                .rstrip()
            )
            layouts.append(
                f"## {code(prefix)} layout\n\n{fenced(layout, 'text')}"
            )
        if vis.shown is not None:
            for entry in vis.shown.entries:
                if (
                    entry.mode is None
                    or is_glob(entry.path)
                    or not path_visible(vis, entry.path)
                ):
                    continue
                if registry.try_mount_for(entry.path) is mount:
                    effective = granted(
                        session,
                        mount,
                        entry.path,
                        effective_path_mode(
                            entry.path, mount.prefix, mount.mode
                        ),
                    )
                    at = code(entry.path)
                    paths.append(
                        (at, f"{code(mount.vfs.name)}, {effective.value}")
                    )
                    commands.append(
                        (
                            at,
                            supported(session, mount, entry.path, effective),
                        )
                    )
                    limits.append(
                        (
                            at,
                            limitations(session, mount, entry.path, effective),
                        )
                    )
    parts = [
        "---\nname: workspace-filesystem\ndescription: The virtual "
        "filesystem layout of this workspace.\n---",
        "# Virtual Filesystem",
        INTRO,
    ]
    if not paths:
        parts.append("No paths are visible.")
    else:
        parts.append(table(("Path", "Description"), paths))
        parts.extend(layouts)
        parts.extend(
            [
                "## Supported Unix Commands for VFS",
                "Unix commands work on each path as on a local filesystem, "
                "as far as the path supports them:",
                table(("Path", "Supported"), commands),
                "## Limitations of Unix Commands for VFS",
                "Where a path differs from a local filesystem:",
                table(("Path", "Limitations"), limits),
            ]
        )
    parts.append(
        "Run `man` to list every command, and `man <cmd>` or "
        "`<cmd> --help` for one command's usage."
    )
    return "\n\n".join(parts) + "\n"


def cli_pages(
    head: str,
    node: CommandSpec,
    style: UsageStyle,
    session: SessionState,
    registry: MountRegistry,
    path: tuple[str, ...] = (),
) -> list[str]:
    """The help pages of one CLI node and its descendants the profile
    allows. A node gets a page when the profile allows it or leads to a
    descendant it allows, so a group's own options stay documented; a
    page lists only the children leading to an allowed one. A leaf
    counts a longer form its allow list names (``gws gmail read --id``).

    Args:
        head (str): the CLI's installed name.
        node (CommandSpec): the node.
        style (UsageStyle): the CLI's help layout.
        session (SessionState): the session the skill is for.
        registry (MountRegistry): the workspace's live CLI registry.
        path (tuple[str, ...]): the verbs from the root to ``node``.
    """
    children = [
        (
            child,
            cli_pages(
                head, child, style, session, registry, (*path, child.name)
            ),
        )
        for child in node.subcommands
    ]
    pages: list[str] = []
    words = (head, *path)
    kept = tuple(child for child, found in children if found)
    if kept or any(
        allowed(session, session.cwd, form, registry=registry)
        for form in (forms(session, words, None) if not children else [words])
    ):
        name = " ".join(words)
        help_text = node_help(
            name, replace(node, subcommands=kept), style
        ).rstrip()
        pages.append(f"## `{name}`\n\n{fenced(help_text, 'text')}")
    for _, found in children:
        pages.extend(found)
    return pages


def skill_md(registry: MountRegistry, session: SessionState) -> str:
    """Render the skill: the registered CLIs the session's profile lets
    it run, from their specs.

    Args:
        registry (MountRegistry): the workspace's live CLI registry.
        session (SessionState): the session the skill is for.
    """
    parts = [
        "---\nname: workspace-commands\ndescription: The CLIs registered "
        "in this workspace and how to call them.\n---",
        "# Available commands",
    ]
    pages: list[str] = []
    for head, install in sorted(registry.clis.items().items()):
        found = cli_pages(
            head,
            install.cli.spec,
            install.cli.spec.usage_style,
            session,
            registry,
        )
        pages.extend(found)
        if found and owns_argv(install.cli):
            pages.append(
                "This program parses its own arguments; "
                "only its registered description is available here."
            )
    if pages:
        parts.append(
            "These commands are registered with this shell; "
            "`<cmd> --help` shows each one's usage."
        )
        parts.extend(pages)
    else:
        parts.append("No CLIs are registered.")
    return "\n\n".join(parts) + "\n"
