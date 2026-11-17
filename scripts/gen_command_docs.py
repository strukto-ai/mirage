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

import argparse
from dataclasses import dataclass
from pathlib import Path

from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.types import Argument, CommandSpec

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "docs/home/core"
PAGES = {
    "tools": CORE / "tools.mdx",
    "data": CORE / "data.mdx",
    "network": CORE / "network.mdx",
    "shell": CORE / "shell.mdx",
}
UNSPECIFIED = {
    "env": "`-i`, `-u NAME`, `NAME=VALUE`",
    "printenv": "`NAME`",
    "whoami": "No options",
    "sh": "The options of `bash`",
    "which": "`-a`",
}

# Forms a spec cannot hold: find's actions take a program ending in `;`
# or `+`, which the expression parser reads before the spec.
EXTRA_FLAGS = {
    "find": (
        (
            "-exec <command> ;",
            "Run a command on each path, `{}` standing for it.",
        ),
        ("-exec <command> {} +", "Run a command once on many paths."),
        ("-execdir <command> ;", "Run a command from each path's directory."),
        ("-execdir <command> {} +", "Run a command once per directory."),
    ),
}
# Where a spec's help, written for the upstream program, promises more
# than Mirage does.
NOTES = {
    "mount": (
        "Mounting is refused, as for an unprivileged user: mounts come from "
        "the configuration. `-t` filters the list"
    ),
}
FLAG_HELP = {
    ("curl", "-F"): (
        "Send one URL-encoded text field; a repeated `-F` keeps the last, and "
        "multipart uploads are unsupported."
    ),
}

Row = tuple[str, str]
GrammarKey = tuple[tuple[Row, ...], str] | str


@dataclass(frozen=True)
class Section:
    """One generated block: a page's group of commands.

    Args:
        page (str): The key of the page in PAGES.
        title (str): The group's heading, which names its block.
        rows (tuple[tuple[tuple[str, ...], str], ...]): Each row's command
            names and the purpose they share; an empty purpose takes the
            spec's description.
    """

    page: str
    title: str
    rows: tuple[tuple[tuple[str, ...], str], ...]


SECTIONS = (
    Section(
        "tools",
        "Files and directories",
        (
            (("ls",), "List entries"),
            (
                ("dir", "vdir"),
                "`ls` in columns or in long format, with names escaped",
            ),
            (("stat",), "Show metadata"),
            (("tree",), "Show a directory tree"),
            (("du",), "Count file and directory bytes"),
            (("df",), "Show mount capacity, when available"),
            (("mount",), "List configured mounts"),
            (("file",), "Identify content type"),
            (("mkdir",), "Create directories"),
            (("touch",), "Create files or update timestamps"),
            (("cp",), "Copy files or directories, including across mounts"),
            (("mv",), "Move or rename entries"),
            (("rm",), "Remove entries"),
            (("rmdir",), "Remove empty directories"),
            (("unlink",), "Remove one entry"),
            (("truncate",), "Resize a file"),
            (("mktemp",), "Create a temporary file or directory"),
            (("ln",), "Create a symbolic link or copy a file's bytes"),
            (("link",), "Copy a file's bytes to a new name"),
            (("pathchk",), "Check that names are valid or portable"),
            (("readlink",), "Read a link or resolve its target"),
            (("realpath",), "Resolve a path"),
            (("basename",), "Remove a directory prefix or suffix"),
            (("dirname",), "Print the parent path"),
            (("chmod",), "Set permission metadata"),
            (("chown", "chgrp"), "Set owner or group metadata"),
            (("getfattr",), "Read extended attributes"),
            (("setfattr",), "Set or remove an extended attribute"),
        ),
    ),
    Section(
        "tools",
        "Search and compare",
        (
            (("find",), "Select paths and run actions"),
            (("grep",), "Search lines"),
            (("rg",), "Search recursively with path filters"),
            (("search",), "Search through a backend's search capability"),
            (("diff",), "Compare text files or directory trees"),
            (("cmp",), "Compare bytes"),
            (("patch",), "Apply a patch"),
            (("look",), "Find lines with a prefix"),
        ),
    ),
    Section(
        "tools",
        "Text processing",
        (
            (("cat",), "Read and concatenate files"),
            (("head",), "Read the beginning"),
            (("tail",), "Read the end or follow changes"),
            (("wc",), "Count lines, words, bytes, or characters"),
            (("sort",), "Order lines"),
            (("uniq",), "Filter adjacent repeated lines"),
            (("cut",), "Select fields, bytes, or characters"),
            (("tr",), "Translate, delete, or squeeze characters"),
            (("sed",), "Edit a text stream"),
            (("awk",), "Process records and fields"),
            (("tee",), "Copy stdin to stdout and files"),
            (("paste",), "Combine lines into columns"),
            (("join",), "Join sorted files on a field"),
            (("comm",), "Compare sorted lines"),
            (("split",), "Split input into files"),
            (("csplit",), "Split at line numbers or patterns"),
            (("nl",), "Number lines"),
            (("tac",), "Reverse record order"),
            (("rev",), "Reverse characters in each line"),
            (("column",), "Arrange text into columns"),
            (("fold",), "Wrap long lines"),
            (("fmt",), "Reflow paragraphs"),
            (("expand", "unexpand"), "Convert tabs and spaces"),
            (("strings",), "Extract printable strings"),
            (("seq",), "Generate a number sequence"),
            (("shuf",), "Shuffle or sample lines"),
            (("tsort",), "Sort dependency pairs"),
            (("colrm",), "Remove columns from each line"),
            (("envsubst",), "Fill environment variables into text"),
            (("yes",), "Repeat a line until the reader stops"),
            (("numfmt",), "Convert numeric units"),
        ),
    ),
    Section(
        "tools",
        "Running commands and inspecting the environment",
        (
            (("xargs",), "Build commands from input"),
            (("timeout",), "Limit a command's running time"),
            (
                ("nohup", "nice", "stdbuf", "setsid"),
                "Run a command with no change to how it runs here",
            ),
            (("sleep",), "Wait for a duration"),
            (
                ("env", "printenv"),
                "Run with environment changes or print exported variables",
            ),
            (("date",), "Format a date or time"),
            (
                ("uname", "hostname", "arch", "hostid", "nproc"),
                "Report system or host information",
            ),
            (
                ("id", "whoami", "groups", "logname", "users", "who"),
                "Report identity: the session's profile is its user and group, "
                "and nobody logs in",
            ),
            (
                ("tty", "sync"),
                "Report that there is no terminal, or check that files exist",
            ),
            (("getconf",), "Query configuration values"),
        ),
    ),
    Section(
        "data",
        "JSON and calculations",
        (
            (("jq",), "Query and transform a stream of JSON values"),
            (("bc",), "Evaluate numeric expressions"),
            (("expr",), "Evaluate integer and string expressions"),
        ),
    ),
    Section(
        "data",
        "Encoding and checksums",
        (
            (("base64",), "Encode or decode Base64"),
            (("iconv",), "Convert character encodings"),
            (("xxd",), "Create or reverse a hex dump"),
            (("od",), "Dump bytes in a chosen format"),
            (("md5",), "Print an MD5 digest"),
            (
                (
                    "md5sum",
                    "sha1sum",
                    "sha224sum",
                    "sha256sum",
                    "sha384sum",
                    "sha512sum",
                    "b2sum",
                ),
                "Generate or verify checksums",
            ),
        ),
    ),
    Section(
        "data",
        "Archives and compression",
        (
            (("tar",), "Create, extract, or list archives"),
            (("zip",), "Create ZIP archives"),
            (("unzip",), "Extract, inspect, or test ZIP archives"),
            (("gzip",), "Compress or decompress gzip data"),
            (("gunzip",), "Decompress or test gzip data"),
            (("zcat",), "Read compressed content to stdout"),
            (("zcmp", "zdiff"), "Compare compressed files"),
            (("xz", "unxz"), "Compress, decompress, or test `.xz` data"),
            (
                ("bzip2", "bunzip2"),
                "Compress, decompress, or test `.bz2` data",
            ),
            (("zgrep",), "Search compressed content"),
        ),
    ),
    Section(
        "network",
        "HTTP",
        (
            (("curl",), "Send an HTTP request"),
            (("wget",), "Download a URL or check its response"),
        ),
    ),
    Section(
        "shell",
        "Builtins",
        (
            (("cd", "pwd", "umask"), ""),
            (
                ("export", "unset", "declare", "typeset", "local", "readonly"),
                "",
            ),
            (("set", "shopt"), ""),
            (("echo", "printf", "read", "mapfile", "readarray"), ""),
            (("source", ".", "eval", "bash", "sh", "exec"), ""),
            (("alias", "unalias", "getopts", "shift", "let", "trap"), ""),
            (("exit", "true", "false", ":", "test", "time"), ""),
            (("command", "type", "which", "help", "man", "history"), ""),
            (("jobs", "wait", "kill", "disown"), ""),
        ),
    ),
)


def spec_of(name: str, builtin: bool = False) -> CommandSpec | None:
    """Find the grammar a command parses with, or None for one with none.

    Args:
        name (str): The command.
        builtin (bool): Prefer the shell builtin's grammar, which a name
            such as `printf` or `echo` runs as in a line.
    """
    tables = (SHELL_SPECS, SPECS) if builtin else (SPECS, SHELL_SPECS)
    for table in tables:
        if name in table:
            return table[name]
    if name == "search":
        return cli_spec_for(name).spec
    return None


def value_name(opt: Argument) -> str:
    """The placeholder of an option's value.

    Args:
        opt (Argument): The value-taking option.
    """
    if opt.metavar is not None:
        return opt.metavar
    return "path" if opt.type == "path" else "text"


def label(opt: Argument) -> str:
    """An option's spellings as they are typed: an optional value attached
    with `=` (long) or directly (short), or not at all where the short form
    takes none.

    Args:
        opt (Argument): The option.
    """
    if opt.action in ("store_true", "count"):
        return ", ".join(opt.names)
    value = f"<{value_name(opt)}>"
    if opt.nargs == "?":
        spelled = []
        for name in opt.names:
            if name.startswith("--"):
                spelled.append(f"{name}[={value}]")
            elif opt.short_value:
                spelled.append(f"{name}[{value}]")
            else:
                spelled.append(name)
        return ", ".join(spelled)
    if opt.value_types:
        return f"{', '.join(opt.names)} <name> {value}"
    count = opt.nargs if isinstance(opt.nargs, int) else 1
    return ", ".join(opt.names) + f" {value}" * count


def rows_of(name: str, spec: CommandSpec) -> list[Row]:
    """A command's flags as (spelling, help), with the forms its spec
    cannot hold and the help Mirage's behavior corrects.

    Args:
        name (str): The command.
        spec (CommandSpec): Its grammar.
    """
    rows = [
        (
            label(opt),
            sentence(FLAG_HELP.get((name, opt.names[0]), opt.help or "")),
        )
        for opt in compile_spec(spec).options
    ]
    return rows + list(EXTRA_FLAGS.get(name, ()))


def escape(text: str) -> str:
    """Make help text safe as MDX body text.

    Args:
        text (str): One line of help.
    """
    return (
        " ".join(text.split())
        .replace("{", "&#123;")
        .replace("}", "&#125;")
        .replace("<", "&lt;")
    )


def sentence(text: str) -> str:
    """One help line as a sentence: capitalized, with a final period.

    Args:
        text (str): The help, as a spec words it.
    """
    text = text.strip()
    if not text:
        return text
    text = text[0].upper() + text[1:]
    return text if text.endswith((".", "?", "!")) else text + "."


def summary(spec: CommandSpec | None) -> str:
    """The first line of a spec's description, as a sentence.

    Args:
        spec (CommandSpec | None): The command's grammar.
    """
    if spec is None or not spec.description:
        return ""
    first = spec.description.strip().split("\n")[0].strip()
    return first if first.endswith(".") else first + "."


def field(
    names: tuple[str, ...], purpose: str, builtin: bool = False
) -> list[str]:
    """Render commands that share flags as one field with its flag tree.

    Args:
        names (tuple[str, ...]): Commands with the same grammar.
        purpose (str): What they do; empty takes the spec's description.
        builtin (bool): Whether they are documented as shell builtins.
    """
    spec = spec_of(names[0], builtin)
    text = purpose.rstrip(".") + "." if purpose else summary(spec)
    if names[0] in NOTES:
        text = f"{text} {NOTES[names[0]]}."
    lines = [f'<ResponseField name="{", ".join(names)}">']
    if text:
        lines.append(f"  {escape(text)}")
    if spec is None:
        lines.append(f"  Options: {UNSPECIFIED[names[0]]}.")
    else:
        rows = rows_of(names[0], spec)
        if rows:
            label = "1 flag" if len(rows) == 1 else f"{len(rows)} flags"
            lines.append(f'  <Expandable title="{label}">')
            for flag, help_text in rows:
                spelling = flag.replace('"', "&quot;")
                if help_text:
                    lines.append(f'    <ResponseField name="{spelling}">')
                    lines.append(f"      {escape(help_text)}")
                    lines.append("    </ResponseField>")
                else:
                    lines.append(f'    <ResponseField name="{spelling}" />')
            lines.append("  </Expandable>")
    lines.append("</ResponseField>")
    return lines


def same_grammar(
    names: tuple[str, ...], builtin: bool = False
) -> list[tuple[str, ...]]:
    """Group a row's commands by identical flags, keeping their order.

    Args:
        names (tuple[str, ...]): The row's commands.
        builtin (bool): Whether they are documented as shell builtins.
    """
    groups: list[tuple[str, ...]] = []
    keys: list[GrammarKey] = []
    for name in names:
        spec = spec_of(name, builtin)
        key: GrammarKey = (
            (tuple(rows_of(name, spec)), summary(spec))
            if spec is not None
            else name
        )
        if key in keys:
            index = keys.index(key)
            groups[index] = (*groups[index], name)
        else:
            keys.append(key)
            groups.append((name,))
    return groups


def block(section: Section) -> str:
    """Render one section's generated block, markers included.

    Args:
        section (Section): The group to render.
    """
    start, end = markers(section)
    lines = [start]
    builtin = section.page == "shell"
    for names, purpose in section.rows:
        for group in same_grammar(names, builtin):
            lines += field(group, purpose, builtin)
    return "\n".join([*lines, end])


def markers(section: Section) -> tuple[str, str]:
    """The comment lines that bound a section's block.

    Args:
        section (Section): The group.
    """
    return (
        f"{{/* BEGIN GENERATED COMMANDS: {section.title} */}}",
        f"{{/* END GENERATED COMMANDS: {section.title} */}}",
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate the shell command references from CommandSpec"
    )
    parser.add_argument(
        "--check", action="store_true", help="Fail on stale documentation"
    )
    args = parser.parse_args()
    stale = []
    for key, path in PAGES.items():
        text = path.read_text()
        updated = text
        for section in (s for s in SECTIONS if s.page == key):
            start, end = markers(section)
            if updated.count(start) != 1 or updated.count(end) != 1:
                raise SystemExit(
                    f"{path.relative_to(ROOT)} needs one {start} block"
                )
            i = updated.index(start)
            j = updated.index(end, i) + len(end)
            updated = updated[:i] + block(section) + updated[j:]
        if updated != text:
            stale.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.write_text(updated)
    if args.check and stale:
        raise SystemExit(
            "Stale command docs; run python/.venv/bin/python "
            "scripts/gen_command_docs.py:\n" + "\n".join(stale)
        )
    print(f"Command docs {'checked' if args.check else 'generated'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
