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
from mirage.commands.spec.help import flag_rows
from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.types import CommandSpec

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


def spec_of(name: str) -> CommandSpec | None:
    """Find the grammar a command parses with, or None for one with none.

    Args:
        name (str): The command.
    """
    if name in SPECS:
        return SPECS[name]
    if name in SHELL_SPECS:
        return SHELL_SPECS[name]
    if name == "search":
        return cli_spec_for(name).spec
    return None


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


def summary(spec: CommandSpec | None) -> str:
    """The first line of a spec's description, as a sentence.

    Args:
        spec (CommandSpec | None): The command's grammar.
    """
    if spec is None or not spec.description:
        return ""
    first = spec.description.strip().split("\n")[0].strip()
    return first if first.endswith(".") else first + "."


def field(names: tuple[str, ...], purpose: str) -> list[str]:
    """Render commands that share flags as one field with its flag tree.

    Args:
        names (tuple[str, ...]): Commands with the same grammar.
        purpose (str): What they do; empty takes the spec's description.
    """
    spec = spec_of(names[0])
    text = purpose.rstrip(".") + "." if purpose else summary(spec)
    lines = [f'<ResponseField name="{", ".join(names)}">']
    if text:
        lines.append(f"  {escape(text)}")
    if spec is None:
        lines.append(f"  Options: {UNSPECIFIED[names[0]]}.")
    else:
        rows = flag_rows(spec)
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


def same_grammar(names: tuple[str, ...]) -> list[tuple[str, ...]]:
    """Group a row's commands by identical flags, keeping their order.

    Args:
        names (tuple[str, ...]): The row's commands.
    """
    groups: list[tuple[str, ...]] = []
    keys: list[object] = []
    for name in names:
        spec = spec_of(name)
        key = (
            (tuple(flag_rows(spec)), summary(spec))
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
    for names, purpose in section.rows:
        for group in same_grammar(names):
            lines += field(group, purpose)
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
