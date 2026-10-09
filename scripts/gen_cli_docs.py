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
from collections.abc import Iterator
from pathlib import Path

from mirage.commands.cli.specs import BUILTIN_CLI_SPECS, cli_spec_for
from mirage.commands.cli.types import CLI
from mirage.commands.spec.types import CommandSpec

ROOT = Path(__file__).resolve().parent.parent
START = "{/* BEGIN GENERATED CLI COMMANDS */}"
END = "{/* END GENERATED CLI COMMANDS */}"
SUMMARIES = {
    "airtable": (
        "Query bases and tables; read, create, update and delete records; "
        "add comments"
    ),
    "discord": (
        "Read and send messages; edit, react, create threads and polls; "
        "inspect guilds"
    ),
    "gh": (
        "Manage repositories, issues, pull requests, releases and "
        "Actions; call GitHub APIs"
    ),
    "git": (
        "Inspect history, stage and commit files, manage branches and "
        "tags, clone and fetch"
    ),
    "gws": "Call Drive, Sheets, Docs, Slides, Calendar, Forms and Gmail APIs",
    "hf": (
        "Download and upload Hub files; create repositories; manage tags "
        "and delete files"
    ),
    "himalaya": "List and search mail; read, compose, reply, forward and send messages",
    "linear": "Query teams, issues, projects and documents; update issues and comments",
    "ntn": "Read and edit Markdown pages, query data sources and call Notion APIs",
    "slack": (
        "Read and send messages; manage reactions and pins; find members "
        "and search"
    ),
}


def commands(
    node: CommandSpec, parents: tuple[str, ...] = ()
) -> Iterator[tuple[str, str, tuple[str, ...]]]:
    """Walk the same program tree that supplies each CLI's help.

    Args:
        node (CommandSpec): The current command or group.
        parents (tuple[str, ...]): Canonical words preceding this node.
    """
    path = (*parents, node.name)
    if not node.subcommands:
        yield " ".join(path), node.description or "", node.aliases
    for child in node.subcommands:
        yield from commands(child, path)


def cell(text: str) -> str:
    """Escape spec text for a Markdown table in MDX.

    Args:
        text (str): A command's help text.
    """
    return (
        " ".join(text.split())
        .replace("|", "\\|")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("{", "&#123;")
        .replace("}", "&#125;")
    )


def reference(cli: CLI) -> str:
    """Render the supported handlers, including aliases, from a live spec.

    Args:
        cli (CLI): The registered program and its grammar.
    """
    spec = cli.spec
    rows = [
        START,
        "## Supported commands",
        "",
        f"Run `{spec.name} <command> --help` for the supported flags and operands.",
        "This list is generated from Mirage's registered command tree.",
        "",
        "| Command | Description |",
        "| --- | --- |",
    ]
    for name, description, aliases in commands(spec):
        suffix = (
            ". Aliases: " + ", ".join(f"`{a}`" for a in aliases) + "."
            if aliases
            else ""
        )
        rows.append(f"| `{name}` | {cell(description.rstrip('.') + suffix)} |")
    return "\n".join([*rows, END])


def catalog(language: str) -> str:
    """Render the complete bundled CLI inventory for an overview page.

    Args:
        language (str): The documentation section containing the links.
    """
    rows = [
        START,
        "| Program | Supported operations | Commands |",
        "| --- | --- | --- |",
    ]
    for name in sorted(BUILTIN_CLI_SPECS):
        spec = cli_spec_for(name)
        count = sum(1 for _ in commands(spec.spec))
        rows.append(
            f"| [{name}](/{language}/cli/{name}) | {SUMMARIES[name]} | {count} |"
        )
    return "\n".join([*rows, END])


def replace_block(text: str, block: str) -> str:
    """Replace exactly one generated block, refusing missing markers.

    Args:
        text (str): The existing page.
        block (str): The newly rendered reference.
    """
    if text.count(START) != 1 or text.count(END) != 1:
        raise ValueError("expected one generated CLI commands block")
    start = text.index(START)
    end = text.index(END, start) + len(END)
    return text[:start] + block + text[end:]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate CLI references from CommandSpec trees"
    )
    parser.add_argument(
        "--check", action="store_true", help="Fail on stale documentation"
    )
    args = parser.parse_args()
    if set(SUMMARIES) != set(BUILTIN_CLI_SPECS):
        raise SystemExit(
            "Update CLI overview summaries for the registered programs"
        )
    pages: dict[Path, str] = {}
    for language in ("python", "typescript"):
        directory = ROOT / "docs" / language / "cli"
        documented = {p.stem for p in directory.glob("*.mdx")} - {
            "index",
            "custom",
        }
        if documented != set(BUILTIN_CLI_SPECS):
            raise SystemExit(
                f"{language} CLI pages disagree with the registry: "
                f"{documented ^ set(BUILTIN_CLI_SPECS)}"
            )
        pages[directory / "index.mdx"] = catalog(language)
        for name in sorted(BUILTIN_CLI_SPECS):
            pages[directory / f"{name}.mdx"] = reference(cli_spec_for(name))
    pages[ROOT / "docs/home/setup/clis.mdx"] = catalog("home/setup")
    stale = []
    for path, block in pages.items():
        text = path.read_text()
        updated = replace_block(text, block)
        if text != updated:
            stale.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.write_text(updated)
    if args.check and stale:
        raise SystemExit(
            "Stale CLI docs; run python/.venv/bin/python scripts/gen_cli_docs.py:\n"
            + "\n".join(stale)
        )
    print(
        f"CLI docs {'checked' if args.check else 'generated'}: "
        f"{len(pages)} pages, {len(BUILTIN_CLI_SPECS)} programs"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
