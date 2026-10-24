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

from mirage.commands.builtin.general import COMMANDS as GENERAL_COMMANDS
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.commands.cli.walk import node_help, owns_argv
from mirage.commands.spec.types import CommandSpec, UsageStyle
from mirage.context import effective_path_mode
from mirage.policy.match.decide import decide
from mirage.policy.types import CommandContext, Outcome
from mirage.types import MountMode
from mirage.utils.hidden import is_glob, path_visible
from mirage.workspace.documentation.constants import (
    ASKS,
    CHANGES,
    READS,
    REFUSED,
    WALKS,
)
from mirage.workspace.documentation.types import Change
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.session import SessionState

SHARED = frozenset(c.name for c in (*GENERIC_COMMANDS, *GENERAL_COMMANDS))


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


def allowed(session: SessionState, cwd: str, words: Sequence[str]) -> bool:
    """Whether the session's profile lets a line of ``words`` run in
    ``cwd``: the documents name nothing the profile refuses.

    Args:
        session (SessionState): the session the documents are for.
        cwd (str): where the line would run.
        words (Sequence[str]): the command and its words; empty for a
            redirection, which no rule names.
    """
    if not words:
        return True
    ctx = CommandContext(
        command=words[0], paths=(), argv=tuple(words[1:]), cwd=cwd
    )
    return decide(ctx, session.commands).outcome is not Outcome.DENY


def works(mount: MountEntry, change: Change) -> bool:
    return any(all(mount.answers(op) for op in ops) for ops in change.needs)


def code(text: str) -> str:
    return "`" + text.replace("|", "\\|") + "`"


def listing(items: Sequence[str]) -> str:
    if len(items) < 2:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


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


def supported(
    session: SessionState, mount: MountEntry, prefix: str, mode: MountMode
) -> str:
    """What one mount supports, as VFS.md states it.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount.
        prefix (str): its path.
        mode (MountMode): the mode in force at its prefix.
    """
    reads = [code(c) for c in READS if allowed(session, prefix, (c,))]
    changes = [c for c in CHANGES if allowed(session, prefix, c.command)]
    working = [
        c.label for c in changes if mode != MountMode.READ and works(mount, c)
    ]
    if working and 2 * len(working) > len(changes):
        parts = ["Almost all Unix commands."]
    else:
        text = "Commands that read files"
        if reads:
            text += f" ({', '.join(reads)} and the rest)"
        if working:
            text += f", and {listing(working)}"
        parts = [text + "."]
    name = code(mount.vfs.name)
    grep = allowed(session, prefix, ("grep",))
    if grep and mount.answers("files_containing"):
        word = " with `-w`" if mount.vfs.whole_word_search else ""
        parts.append(f"`grep -r` and `rg`{word} use {name} search.")
    if grep and mount.answers("lines_containing"):
        parts.append(f"`grep` and `rg` ask {name} for the matching lines.")
    asks = [
        code(command)
        for op, command in ASKS
        if mount.answers(op) and allowed(session, prefix, command.split())
    ]
    if asks:
        parts.append(f"{listing(asks)} ask {name} instead of reading a file.")
    own = [
        code(n)
        for n in sorted(set(mount.commands()) - SHARED)
        if allowed(session, prefix, (n,))
    ]
    if own:
        parts.append(f"Also {listing(own)}.")
    return " ".join(parts)


def limitations(
    session: SessionState, mount: MountEntry, prefix: str, mode: MountMode
) -> str:
    """Where one mount differs from a local filesystem.

    Args:
        session (SessionState): the session the document is for.
        mount (MountEntry): the mount.
        prefix (str): its path.
        mode (MountMode): the mode in force at its prefix.
    """
    parts: list[str] = []
    if mode == MountMode.READ:
        parts.append("Read only: no command changes files.")
    else:
        changes = [c for c in CHANGES if allowed(session, prefix, c.command)]
        missing = [c.label for c in changes if not works(mount, c)]
        if missing and len(missing) == len(changes):
            parts.append("No command changes files.")
        elif missing:
            parts.append(f"Not supported: {', '.join(missing)}.")
    vfs = mount.vfs
    if allowed(session, prefix, ("grep",)) and mount.answers(
        "files_containing"
    ):
        if vfs.whole_word_search:
            parts.append("Without `-w`, `grep -r` and `rg` read every file.")
        if vfs.searchable is not None:
            globs = listing([code(g) for g in vfs.searchable])
            parts.append(
                f"{code(vfs.name)} search covers only {globs}; "
                "`grep -r` and `rg` read every other file."
            )
    if vfs.full_scan_limit >= 0:
        walks = [code(c) for c in WALKS if allowed(session, prefix, c.split())]
        refused = [
            code(c) for c in REFUSED if allowed(session, prefix, c.split())
        ]
        text = f"{listing(walks)} stop after {vfs.full_scan_limit} files"
        if refused:
            text += f"; a glob matching more, {listing(refused)} are refused"
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
        paths.append((code(prefix), f"{code(mount.vfs.name)}, {mode.value}"))
        commands.append(
            (code(prefix), supported(session, mount, prefix, mode))
        )
        limits.append(
            (code(prefix), limitations(session, mount, prefix, mode))
        )
        # Backend prose is not a permission document. Under a restricted
        # view it can advertise hidden paths or verbs, so describe only
        # structured facts rather than interpolate unrestricted guidance.
        if (
            vis.paths is None
            and vis.shown is None
            and session.commands is None
            and mode == mount.mode
        ):
            texts = [mount.vfs.prompt]
            if mode != MountMode.READ:
                texts.append(mount.vfs.write_prompt)
            layout = "\n\n".join(
                t.replace("{prefix}", prefix).strip("\n").rstrip()
                for t in texts
                if t.strip()
            )
            if layout:
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
                    effective = effective_path_mode(
                        entry.path, mount.prefix, mount.mode
                    )
                    paths.append(
                        (
                            code(entry.path),
                            f"{code(mount.vfs.name)}, {effective.value}",
                        )
                    )
    parts = [
        "---\nname: workspace-filesystem\ndescription: The virtual "
        "filesystem layout of this workspace.\n---",
        "# Virtual Filesystem",
        "You work in a terminal over a virtual filesystem. Read files with "
        "shell commands; access is checked for each operation.",
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
    path: tuple[str, ...] = (),
) -> list[str]:
    name = " ".join((head, *path))
    if not allowed(session, session.cwd, (head, *path)):
        return []
    help_text = node_help(name, node, style).rstrip()
    pages = [f"## `{name}`\n\n{fenced(help_text, 'text')}"]
    for child in node.subcommands:
        pages.extend(
            cli_pages(head, child, style, session, (*path, child.name))
        )
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
            head, install.cli.spec, install.cli.spec.usage_style, session
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
