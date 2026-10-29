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

import re
from collections.abc import Iterator, Sequence

from mirage.commands.cli.walk import find_child, listed_node
from mirage.commands.spec import SPECS
from mirage.commands.spec.help import (
    argparse_parts,
    flag_rows,
    operand_rows,
    render_help,
    usage_line,
)
from mirage.commands.spec.shell import (
    SHELL_SPECS,
    ShellParse,
    parse_shell_options,
)
from mirage.commands.spec.synopsis import SHELL_SYNOPSES, SYNOPSES
from mirage.commands.spec.types import CommandSpec, UsageStyle
from mirage.shell.bytes import encode_text
from mirage.shell.types import ShellBuiltin
from mirage.version import __version__
from mirage.workspace.executor.builtins.help import (
    env_width,
    fill,
    option_rows,
    paragraphs,
    summary,
)
from mirage.workspace.executor.builtins.man.constants import (
    DEFAULT_WIDTH,
    HINT,
    MANUAL,
    MIN_WIDTH,
    NO_PAGE,
    SECTION,
    SECTION_RE,
    TAG_INDENT,
    TEXT_INDENT,
    WHATIS_WIDTH,
)
from mirage.workspace.executor.builtins.man.types import (
    ManPage,
    ManSection,
)
from mirage.workspace.executor.builtins.shared import result
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup.constants import BASH_BUILTINS, EXEC_WRAPPERS
from mirage.workspace.mount.registry import DEV_PREFIX, MountRegistry
from mirage.workspace.session.session import SessionState

_SHELL_WORDS = frozenset(str(b) for b in ShellBuiltin)

# Builtins whose page is the spec of another name.
_SPEC_OF = {"sh": "bash"}


def _sections(
    synopsis: str,
    description: Sequence[str],
    options: Sequence[tuple[str, str]],
    extra: Sequence[ManSection] = (),
) -> tuple[ManSection, ...]:
    """A page's sections after NAME, leaving out the empty ones.

    Args:
        synopsis (str): how the command is written.
        description (Sequence[str]): the description's paragraphs.
        options (Sequence[tuple[str, str]]): each option and its text.
        extra (Sequence[ManSection]): sections that
            follow the options.
    """
    sections: list[ManSection] = [("SYNOPSIS", (synopsis,))]
    if description:
        sections.append(("DESCRIPTION", tuple(description)))
    if options:
        sections.append(("OPTIONS", tuple(options)))
    sections += [(head, blocks) for head, blocks in extra if blocks]
    return tuple(sections)


def _described(spec: CommandSpec) -> tuple[str, ...]:
    """A spec's DESCRIPTION: what its description says after the summary
    NAME carries, and its epilog; the summary alone when that is all.

    Args:
        spec (CommandSpec): the command or CLI node.
    """
    lead, *text = paragraphs(spec.description) or ("",)
    rest = (*text, *paragraphs(spec.epilog))
    return rest or ((lead,) if lead else ())


def builtin_page(name: str) -> ManPage:
    """The page of a shell builtin, from the spec ``help`` shows it by:
    its epilog is the exit status.

    Args:
        name (str): the builtin.
    """
    spec = SHELL_SPECS[name]
    lead, *text = paragraphs(spec.description)
    status = (("EXIT STATUS", (spec.epilog,)),) if spec.epilog else ()
    return ManPage(
        name=name,
        summary=lead,
        sections=_sections(
            SHELL_SYNOPSES[name], text or (lead,), option_rows(spec), status
        ),
    )


def spec_page(name: str, spec: CommandSpec) -> ManPage:
    """The page of a command, from its spec.

    The synopsis is the program's own first ``--help`` line where mirage
    keeps one, else the line the spec's slots spell.

    Args:
        name (str): the command.
        spec (CommandSpec): its grammar.
    """
    synopsis = SYNOPSES.get(name) or usage_line(
        name, spec, (), spec.usage_style
    ).removeprefix("Usage: ")
    return ManPage(
        name=name,
        summary=summary(spec),
        sections=_sections(
            synopsis,
            _described(spec),
            flag_rows(spec),
            (("OPERANDS", tuple(operand_rows(spec))),),
        ),
    )


def cli_page(
    head: str,
    path: Sequence[str],
    node: CommandSpec,
    style: UsageStyle,
) -> ManPage:
    """The page of one node of an installed CLI, named after its path
    with hyphens (``git-commit``).

    The synopsis, the options and the operands are the ones the node's
    ``--help`` prints, in the root's dialect.

    Args:
        head (str): the installed head word.
        path (Sequence[str]): canonical subcommand names below it.
        node (CommandSpec): the node.
        style (UsageStyle): the root's dialect.
    """
    words = " ".join((head, *path))
    rows = [
        (child.name, child.description or "") for child in node.subcommands
    ]
    listed = listed_node(node, style)
    if style in (UsageStyle.ARGPARSE, UsageStyle.COBRA):
        usage, operands, options = argparse_parts(words, listed, rows)
        synopsis = usage.removeprefix("usage: ")
    else:
        synopsis = usage_line(words, listed, rows, style).removeprefix(
            "Usage: "
        )
        operands, options = operand_rows(listed), flag_rows(listed)
    return ManPage(
        name=words.replace(" ", "-"),
        summary=node.description or "",
        sections=_sections(
            synopsis,
            _described(node),
            options,
            (
                ("OPERANDS", tuple(row for row in operands if row[1])),
                ("COMMANDS", tuple(rows)),
            ),
        ),
    )


def _shell_page(name: str) -> ManPage | None:
    """The page of a shell builtin: bash's from its help, else the spec
    of one that is a program elsewhere (``man``, ``sleep``, ``env``).

    Args:
        name (str): the word.
    """
    if name in SHELL_SYNOPSES and name in BASH_BUILTINS:
        return builtin_page(name)
    spec = SHELL_SPECS.get(name) or SPECS.get(_SPEC_OF.get(name, name))
    if name in _SHELL_WORDS and spec is not None:
        return spec_page(name, spec)
    return None


def _command_page(name: str, registry: MountRegistry) -> ManPage | None:
    """The page of a mounted command, None when no mount registers it.

    A name has one spec however many mounts register it, so the first
    registration is the page. A wrapper no mount registers (``egrep``)
    has the page of the program it runs, as Debian links one to the
    other.

    Args:
        name (str): the word.
        registry (MountRegistry): registry holding the mounts.
    """
    for mount in registry.mounts():
        if mount.prefix == DEV_PREFIX:
            continue
        cmd = mount.resolve_command(name)
        if cmd is not None:
            return spec_page(name, cmd.spec)
    runs = EXEC_WRAPPERS.get(name)
    if runs is not None:
        page = _command_page(runs[0], registry)
        if page is not None:
            return ManPage(name, page.summary, page.sections)
    return None


def _subpage(
    node: CommandSpec, rest: str
) -> tuple[CommandSpec, tuple[str, ...]] | None:
    """The node a hyphenated rest of a page name spells below ``node``.

    Args:
        node (CommandSpec): the node to descend from.
        rest (str): the name after the node's own, without its hyphen.
    """
    for child in node.subcommands:
        for word in (child.name, *child.aliases):
            if rest == word:
                return child, (child.name,)
            if rest.startswith(word + "-"):
                deeper = _subpage(child, rest[len(word) + 1 :])
                if deeper is not None:
                    return deeper[0], (child.name, *deeper[1])
    return None


def _cli_lookup(name: str, registry: MountRegistry) -> ManPage | None:
    """The page an installed CLI has under a name: its head word, or a
    subcommand spelled with hyphens (``git-commit``).

    Args:
        name (str): the page name.
        registry (MountRegistry): registry holding the installs.
    """
    for head, install in registry.clis.items().items():
        spec = install.cli.spec
        if name == head:
            return cli_page(head, (), spec, spec.usage_style)
        if name.startswith(head + "-"):
            found = _subpage(spec, name[len(head) + 1 :])
            if found is not None:
                return cli_page(head, found[1], found[0], spec.usage_style)
    return None


def pages_of(name: str, registry: MountRegistry) -> list[ManPage]:
    """Every page a name has, in the order ``man`` prefers them: an
    installed CLI's, then a builtin's, then a mounted command's.

    Args:
        name (str): the page name.
        registry (MountRegistry): registry holding mounts and installs.
    """
    found = (
        _cli_lookup(name, registry),
        _shell_page(name),
        _command_page(name, registry),
    )
    return [page for page in found if page is not None]


def find_page(name: str, registry: MountRegistry) -> ManPage | None:
    """The page a name opens, the first of ``pages_of``.

    Args:
        name (str): the page name.
        registry (MountRegistry): registry holding mounts and installs.
    """
    pages = pages_of(name, registry)
    return pages[0] if pages else None


def _cli_pages(
    head: str,
    path: tuple[str, ...],
    node: CommandSpec,
    style: UsageStyle,
) -> Iterator[ManPage]:
    """Every page of an installed CLI's tree, the node's first.

    Args:
        head (str): the installed head word.
        path (tuple[str, ...]): the node's path below it.
        node (CommandSpec): the node.
        style (UsageStyle): the root's dialect.
    """
    yield cli_page(head, path, node, style)
    for child in node.subcommands:
        yield from _cli_pages(head, (*path, child.name), child, style)


def _all_pages(registry: MountRegistry) -> list[ManPage]:
    """Every page of the manual, one per name, sorted by name.

    Args:
        registry (MountRegistry): registry holding mounts and installs.
    """
    pages: dict[str, ManPage] = {}
    for head, install in registry.clis.items().items():
        spec = install.cli.spec
        for page in _cli_pages(head, (), spec, spec.usage_style):
            pages.setdefault(page.name, page)
    words = {
        *(name for name in SHELL_SYNOPSES if name in BASH_BUILTINS),
        *_SHELL_WORDS,
    }
    for mount in registry.mounts():
        if mount.prefix != DEV_PREFIX:
            words.update(cmd.name for cmd in mount.all_commands())
    words.update(w for w, (runs, _) in EXEC_WRAPPERS.items() if runs in words)
    for word in words:
        if word not in pages:
            found = find_page(word, registry)
            if found is not None:
                pages[word] = found
    return [pages[name] for name in sorted(pages)]


def _three(left: str, center: str, right: str, length: int) -> str:
    """A header or footer line: one part at each margin, one centered.

    Args:
        left (str): the part at the left margin.
        center (str): the centered part, empty for none.
        right (str): the part at the right margin.
        length (int): the line length.
    """
    line = left
    if center:
        start = max((length - len(center) + 1) // 2, len(line) + 1)
        line = line.ljust(start) + center
    return line.ljust(max(length - len(right), len(line) + 1)) + right


def render_page(page: ManPage, width: int) -> str:
    """A page laid out as man prints it with justification and
    hyphenation off: a header, NAME, each section with its text indented
    and its tags hanging, and a footer.

    Args:
        page (ManPage): the page.
        width (int): the terminal width; lines stop one short of it.
    """
    length = width - 1
    title = f"{page.name.upper()}({SECTION})"
    text = " " * TEXT_INDENT
    tagged = " " * TAG_INDENT
    lines = [_three(title, MANUAL, title, length), ""]
    named = f"{page.name} - {page.summary}" if page.summary else page.name
    sections = (("NAME", (named,)), *page.sections)
    for heading, blocks in sections:
        lines.append(heading)
        for i, block in enumerate(blocks):
            if i:
                lines.append("")
            if isinstance(block, str):
                lines += [
                    text + line for line in fill(block, length - TEXT_INDENT)
                ]
                continue
            tag, does = block
            body = fill(does, length - TAG_INDENT)
            if body and len(tag) < TAG_INDENT - TEXT_INDENT:
                lines.append(
                    text + tag.ljust(TAG_INDENT - TEXT_INDENT) + body[0]
                )
                body = body[1:]
            else:
                lines.append(text + tag)
            lines += [tagged + line for line in body]
        lines.append("")
    lines.append(_three(f"Mirage {__version__}", "", title, length))
    return "\n".join(lines) + "\n"


def _whatis(page: ManPage) -> str:
    """A page's line in ``man -f`` and ``man -k``.

    Args:
        page (ManPage): the page.
    """
    named = f"{page.name} ({SECTION})".ljust(WHATIS_WIDTH)
    return f"{named} - {page.summary or '(unknown subject)'}\n"


def _usage_error(message: str) -> Result:
    """man's refusal of its own command line: the message, then the
    hint, status 1.

    Args:
        message (str): what is wrong, without the newline.
    """
    return result("man", exit_code=1, stderr=f"man: {message}\n{HINT}")


def _refusal(parse: ShellParse) -> str | None:
    """What man says of a command line its options refuse, None when
    they take it.

    Args:
        parse (ShellParse): the scan of man's options.
    """
    if parse.unexpected_value is not None:
        spelled = parse.unexpected_value.partition("=")[0]
        return f"option '{spelled}' doesn't allow an argument"
    if parse.invalid is None:
        return None
    if not parse.invalid.startswith("--"):
        return f"invalid option -- '{parse.invalid}'"
    if parse.candidates:
        listed = " ".join(f"'{name}'" for name in parse.candidates)
        return (
            f"option '{parse.invalid}' is ambiguous; possibilities: {listed}"
        )
    return f"unrecognized option '{parse.invalid}'"


def _lookup(
    pages: list[str], registry: MountRegistry
) -> Iterator[tuple[str, list[ManPage]]]:
    """Each page asked for and every page it opens. Words after an
    installed CLI's head that name its subcommands make one page with
    it, as ``man git commit`` opens git-commit.

    Args:
        pages (list[str]): the page names, in order.
        registry (MountRegistry): registry holding mounts and installs.
    """
    i = 0
    while i < len(pages):
        name = pages[i]
        i += 1
        install = registry.clis.get(name)
        if install is None:
            yield name, pages_of(name, registry)
            continue
        spec = install.cli.spec
        node: CommandSpec = spec
        path: tuple[str, ...] = ()
        while i < len(pages):
            child = find_child(node, pages[i])
            if child is None:
                break
            node, path = child, (*path, child.name)
            i += 1
        if path:
            yield name, [cli_page(name, path, node, spec.usage_style)]
        else:
            yield name, pages_of(name, registry)


async def handle_man(
    args: Sequence[str],
    registry: MountRegistry,
    session: SessionState,
) -> Result:
    """Run ``man``: show the pages asked for, or their summary lines.

    Status 16 when a page is missing, as man-db answers, after the
    pages it did find; 1 for a command line it refuses.

    Args:
        args (Sequence[str]): the words after ``man``.
        registry (MountRegistry): registry holding mounts and installs.
        session (SessionState): the shell session, whose $MANWIDTH or
            $COLUMNS sets the width.
    """
    spec = SHELL_SPECS["man"]
    parse = parse_shell_options(spec, list(args))
    wrong = _refusal(parse)
    if wrong is not None:
        return _usage_error(wrong)
    chosen, pages = parse.flags, parse.operands
    if "?" in chosen:
        page = render_help("man", spec, synopsis=SYNOPSES["man"])
        return result("man", out=encode_text(page))
    if "usage" in chosen:
        line = usage_line("man", spec, (), spec.usage_style, SYNOPSES["man"])
        return result("man", out=encode_text(line + "\n"))
    if "f" in chosen and "k" in chosen:
        return _usage_error("-f -k : incompatible options")
    if "f" in chosen or "k" in chosen:
        return _summaries(pages, registry, "f" in chosen)
    if not pages:
        return result("man", exit_code=1, stderr=NO_PAGE)
    section = ""
    if len(pages) > 1 and SECTION_RE.fullmatch(pages[0]):
        section = pages.pop(0)
    width = env_width(
        session, ("MANWIDTH", "COLUMNS"), MIN_WIDTH, DEFAULT_WIDTH
    )
    out: list[str] = []
    errors: list[str] = []
    for name, found in _lookup(pages, registry):
        if not found or section not in ("", SECTION):
            where = f" in section {section}" if section else ""
            errors.append(f"No manual entry for {name}{where}\n")
            continue
        shown = found if "a" in chosen else found[:1]
        out += [render_page(page, width) for page in shown]
    return result(
        "man",
        out=encode_text("".join(out)) if out else None,
        exit_code=16 if errors else 0,
        stderr="".join(errors) or None,
    )


def _summaries(
    words: list[str], registry: MountRegistry, whatis: bool
) -> Result:
    """``man -f`` (each page's summary line) or ``man -k`` (every page
    whose name or summary the word matches, as a regular expression,
    ignoring case).

    Args:
        words (list[str]): the page names or keywords.
        registry (MountRegistry): registry holding mounts and installs.
        whatis (bool): ``-f`` when True, ``-k`` when False.
    """
    if not words:
        verb = "whatis" if whatis else "apropos"
        return result("man", exit_code=1, stderr=f"{verb} what?\n")
    found: list[ManPage] = []
    errors: list[str] = []
    every = [] if whatis else _all_pages(registry)
    for word in words:
        if whatis:
            page = find_page(word, registry)
            hits = [page] if page is not None else []
        else:
            try:
                pattern = re.compile(word, re.IGNORECASE)
            except re.error:
                pattern = re.compile(re.escape(word), re.IGNORECASE)
            hits = [
                page
                for page in every
                if pattern.search(page.name) or pattern.search(page.summary)
            ]
        if not hits:
            errors.append(f"{word}: nothing appropriate.\n")
        found += [page for page in hits if page not in found]
    if not whatis:
        found.sort(key=lambda page: page.name)
    return result(
        "man",
        out=encode_text("".join(_whatis(page) for page in found)) or None,
        exit_code=0 if found else 16,
        stderr="".join(errors) or None,
    )


async def man_builtin(call: BuiltinCall) -> Result:
    """The ``man`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_man(
        list(call.argv.args), call.registry, call.context.session
    )
