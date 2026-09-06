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

from collections.abc import Sequence
from functools import partial

from mirage.commands.cli.skill import skill_for
from mirage.commands.cli.types import CLISpec
from mirage.commands.cli.walk import find_node, node_help
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandSpec
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.builtins.man.types import ManEntry
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup import (cli_tree_visible, command_visible,
                                     verb_visible)
from mirage.workspace.mount.registry import DEV_PREFIX, MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

# Shell builtins the manual documents through a spec of another name.
_SHELL_BUILTIN_MAN: dict[str, str] = {
    "bash": "bash",
    "sh": "bash",
}


def _described(text: str | None) -> str:
    """A description, or man's placeholder when the spec carries none.

    Args:
        text (str | None): the spec's description.
    """
    return text if text is not None else "(no description)"


def _command_entry(name: str, registry: MountRegistry) -> ManEntry | None:
    """The entry for a mount command, None when no mount registers it.

    A name has one spec however many mounts register it (spec parity
    holds every registration of a name to one spec), so the first
    registration found is the page.

    Args:
        name (str): the word to document.
        registry (MountRegistry): registry holding the mounts.
    """
    for mount in registry.mounts():
        if mount.prefix == DEV_PREFIX:
            continue
        cmd = mount.resolve_command(name)
        if cmd is not None:
            return ManEntry(name=name, spec=cmd.spec)
    return None


def _builtin_entry(name: str) -> ManEntry | None:
    """The entry for a shell builtin the manual documents, else None.

    Args:
        name (str): the word to document.
    """
    spec_key = _SHELL_BUILTIN_MAN.get(name)
    spec = SPECS.get(spec_key) if spec_key is not None else None
    if spec is None:
        return None
    return ManEntry(name=name, spec=spec)


def _command_entries(registry: MountRegistry,
                     session: Session) -> list[ManEntry]:
    """One entry per name registered on any mount that the session can
    see, first registration wins.

    Args:
        registry (MountRegistry): registry holding the mounts.
        session (Session): the session reading the manual.
    """
    seen: dict[str, ManEntry] = {}
    for mount in registry.mounts():
        if mount.prefix == DEV_PREFIX:
            continue
        for cmd in mount.all_commands():
            if cmd.name not in seen and command_visible(cmd.name, session):
                seen[cmd.name] = ManEntry(name=cmd.name, spec=cmd.spec)
    return list(seen.values())


def _cli_entries(registry: MountRegistry, session: Session) -> list[ManEntry]:
    """One entry per installed CLI head word the session can see.

    Args:
        registry (MountRegistry): registry holding the installs.
        session (Session): the session reading the manual.
    """
    return [
        ManEntry(name=name, spec=install.spec)
        for name, install in registry.clis.items().items()
        if command_visible(name, session)
    ]


def _render_options_table(spec: CommandSpec) -> list[str]:
    if not spec.options:
        return []
    lines: list[str] = []
    lines.append("## OPTIONS")
    lines.append("")
    lines.append("| short | long | value | description |")
    lines.append("| ----- | ---- | ----- | ----------- |")
    for opt in spec.options:
        short = opt.short if opt.short is not None else ""
        long = opt.long if opt.long is not None else ""
        desc = opt.description if opt.description is not None else ""
        lines.append(f"| {short} | {long} | {opt.type} | {desc} |")
    return lines


def _render_page(entry: ManEntry) -> str:
    """The page for one entry: title, description, options table.

    Args:
        entry (ManEntry): the word and its spec.
    """
    lines = [f"# {entry.name}", "", _described(entry.spec.description)]
    table = _render_options_table(entry.spec)
    if table:
        lines.append("")
        lines.extend(table)
    return "\n".join(lines) + "\n"


def _render_section(title: str, entries: Sequence[ManEntry]) -> str:
    """One section of the bare listing, empty when there is nothing to list.

    Args:
        title (str): the section heading.
        entries (Sequence[ManEntry]): the words to list, sorted here.
    """
    if not entries:
        return ""
    lines = [f"# {title}", ""]
    for entry in sorted(entries, key=lambda e: e.name):
        desc = _described(entry.spec.description)
        lines.append(f"- {entry.name} \u2014 {desc}")
    return "\n".join(lines)


def _child_visible(head: str, path: tuple[str, ...], session: Session,
                   verb: str) -> bool:
    """Whether the session can see one child of the node being rendered.

    Args:
        head (str): installed head word, as typed.
        path (tuple[str, ...]): canonical verbs down to the node.
        session (Session): the session reading the manual.
        verb (str): the child's canonical name.
    """
    return verb_visible(head, (*path, verb), session)


def _render_cli_entry(head: str, verbs: Sequence[str], spec: CLISpec,
                      session: Session) -> str | None:
    """The page for one node of an installed CLI, None when verbs miss
    or the session cannot see the node they name.

    The page is the node's own ``--help``, rendered by the one renderer
    that serves ``--help`` and the bare-group refusal, so a CLI's manual
    cannot drift from the program. A tree is a manual with sections:
    ``man linear`` lists the verbs and ``man linear issue create`` is
    the page for one leaf.

    The allow list narrows a tree the same way it narrows the bare
    listing, one level down: a profile holding ``linear issue list`` reads
    a manual for that verb and nothing else, because a row it cannot
    run is an advertisement for a 126.

    Args:
        head (str): installed head word, as typed.
        verbs (Sequence[str]): verb words after the head, aliases
            allowed.
        spec (CLISpec): the installed program tree.
        session (Session): the session reading the manual.
    """
    found = find_node(spec, verbs)
    if found is None:
        return None
    node, path = found
    if not verb_visible(head, path, session):
        return None
    # The root's dialect, so a manual page reads exactly like the
    # --help it renders from.
    help_text = node_help(" ".join((head, ) + path),
                          node,
                          spec.usage_style,
                          visible=partial(_child_visible, head, path, session))
    # A skill teaches an invented grammar the flag table cannot: only
    # the head-only page (the program's own manual, not one verb's)
    # leads with it, only when the spec ships one, and only for a
    # session that may run every line it teaches. It is respelled for
    # the installed head, so ``man ntn-prod`` teaches ``ntn-prod`` lines
    # and not another install's.
    if not verbs and cli_tree_visible(head, spec, session):
        skill = skill_for(spec, head)
        if skill is not None:
            return skill.body + "\n\n" + help_text
    return help_text


def _render_man_index(registry: MountRegistry, session: Session) -> str:
    """The bare ``man`` listing, by kind of word: commands, then CLIs.

    Every name registered on any mount is one row however many mounts
    register it, and no row says which: the manual documents words, and
    dispatch by name already picks the mount that serves one. A word the
    session cannot see is not listed, as it is not a command for it.

    Args:
        registry (MountRegistry): registry holding mounts and installs.
        session (Session): the session reading the manual.
    """
    sections = [
        _render_section("commands", _command_entries(registry, session)),
        _render_section("clis", _cli_entries(registry, session)),
    ]
    body = "\n\n".join(s for s in sections if s)
    return body + "\n" if body else ""


def _cli_man(
        install: CLIInstall, verbs: Sequence[str], cmd_str: str,
        registry: MountRegistry,
        session: Session) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """The page (or pages) for an installed head word.

    A CLI may not take a general command's name, but a mount can
    register a custom command under any name, so both pages can exist
    for one word. The CLI goes first: it is the one dispatch would run.

    Args:
        install (CLIInstall): the installed CLI, head word included.
        verbs (Sequence[str]): verb words after the head, aliases
            allowed.
        cmd_str (str): the line, for the execution node.
        registry (MountRegistry): registry holding the mounts.
        session (Session): the session reading the manual.
    """
    head = install.name
    entry = _render_cli_entry(head, verbs, install.spec, session)
    if entry is None:
        typed = " ".join([head, *verbs])
        err = f"man: no entry for {typed}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    sections = [entry]
    command = _command_entry(head, registry) if not verbs else None
    if command is not None:
        sections.append(_render_page(command))
    out = "\n".join(sections).encode()
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)


async def handle_man(
    args: list[str],
    registry: MountRegistry,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        out = _render_man_index(registry, session).encode()
        return out, IOResult(), ExecutionNode(command="man", exit_code=0)
    name = args[0]
    cmd_str = "man " + " ".join(args)
    # Only an installed head word reads the words after it: they are its
    # verb path. Everything else keeps man's older shape and documents
    # args[0]. A word the session cannot see has no page.
    install = registry.clis.get(name)
    if install is not None and command_visible(name, session):
        return _cli_man(install, args[1:], cmd_str, registry, session)
    entry = None
    if command_visible(name, session):
        entry = _command_entry(name, registry) or _builtin_entry(name)
    if entry is None:
        err = f"man: no entry for {name}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=cmd_str,
                                                         exit_code=1,
                                                         stderr=err)
    out = _render_page(entry).encode()
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)


async def man_builtin(call: BuiltinCall) -> Result:
    """The ``man`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_man(list(call.argv.args), call.registry, call.session)
