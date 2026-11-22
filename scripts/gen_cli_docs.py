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
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from mirage.commands.cli.specs import BUILTIN_CLI_SPECS, cli_spec_for
from mirage.commands.cli.types import CLI
from mirage.commands.spec.types import CommandSpec

ROOT = Path(__file__).resolve().parent.parent
START = "{/* BEGIN GENERATED CLI COMMANDS */}"
END = "{/* END GENERATED CLI COMMANDS */}"
LICENSE_START = "{/* BEGIN GENERATED CLI LICENSE */}"
LICENSE_END = "{/* END GENERATED CLI LICENSE */}"
REPO = "https://github.com/strukto-ai/mirage/blob/main"
SECTIONS = ["Supported commands", "Usage", "Behavior"]


@dataclass(frozen=True)
class Project:
    """One project a CLI follows, adapts or depends on.

    Args:
        name (str): The project, as a Markdown link.
        role (str): What Mirage takes from it.
        license (str): Its license, as Markdown.
        notice (str | None): The stem of the copy under licenses/third_party/
            when Mirage adapts its code.
        internal (bool): Adapted for an internal detail, so the page names it
            under the table instead of giving it a row.
    """

    name: str
    role: str
    license: str
    notice: str | None = None
    internal: bool = False


@dataclass(frozen=True)
class Licensing:
    """The licensing facts of one bundled CLI.

    Args:
        upstream (str): The overview catalog's cell.
        projects (tuple[Project, ...]): Rows above Mirage's own.
    """

    upstream: str
    projects: tuple[Project, ...] = ()


MIRAGE = Project(
    "[Mirage](https://github.com/strukto-ai/mirage)",
    "Command implementation",
    f"[Apache-2.0]({REPO}/LICENSE)",
)
OPENCLAW = Project(
    "[OpenClaw](https://github.com/openclaw/openclaw)",
    "Action names",
    "[MIT](https://github.com/openclaw/openclaw/blob/main/LICENSE)",
)
POPPLER = Project(
    "[poppler](https://poppler.freedesktop.org)",
    "Command-line behavior reference; Mirage copies none of its code",
    "GPL",
)
PDF_OXIDE = Project(
    "[pdf_oxide](https://github.com/yfedoseev/pdf_oxide)",
    "PDF reader dependency",
    "MIT or Apache-2.0",
)
SERVICE_API = "None; calls the service API"
BEHAVIOR_ONLY = "GPL, behavior reference only"
LICENSES = {
    "ast-grep": Licensing(
        "MIT",
        (
            Project(
                "[ast-grep](https://github.com/ast-grep/ast-grep) 0.51.3",
                "Rust search, rule and outline engine",
                "MIT",
                "ast-grep",
            ),
        ),
    ),
    "airtable": Licensing(SERVICE_API),
    "discord": Licensing("MIT (OpenClaw)", (OPENCLAW,)),
    "gh": Licensing(
        "MIT",
        (
            Project(
                "[GitHub CLI](https://github.com/cli/cli) 2.85.0",
                "Upstream CLI; its commands, output and API calls are adapted",
                "MIT",
                "gh",
            ),
            Project(
                "[go-gh](https://github.com/cli/go-gh) 2.13.0",
                "`--template` and `--jq` handling adapted",
                "MIT",
                "go-gh",
                internal=True,
            ),
            Project(
                "[Go](https://github.com/golang/go) 1.25.5",
                "HTTP reason phrases and template execution adapted",
                "BSD-3-Clause",
                "go",
                internal=True,
            ),
            Project(
                "[gojq](https://github.com/itchyny/gojq) 0.12.17",
                "jq builtin errors adapted",
                "MIT",
                "gojq",
                internal=True,
            ),
            Project(
                "[Cobra](https://github.com/spf13/cobra) 1.10.2",
                "Unknown-command refusals adapted",
                "Apache-2.0",
                "cobra",
                internal=True,
            ),
            Project(
                "[pflag](https://github.com/spf13/pflag) 1.0.10",
                "Option table and option-error wording adapted",
                "BSD-3-Clause",
                "pflag",
                internal=True,
            ),
        ),
    ),
    "git": Licensing(
        BEHAVIOR_ONLY,
        (
            Project(
                "[Git](https://github.com/git/git)",
                "Behavior reference only; Mirage does not run Git",
                "[GPL-2.0](https://github.com/git/git/blob/master/COPYING)",
            ),
            Project(
                "[Dulwich](https://github.com/jelmer/dulwich)",
                "Python Git library, used under Apache-2.0; TypeScript ports "
                "its rename score",
                "Apache-2.0 or GPL-2.0-or-later",
                "dulwich",
            ),
            Project(
                "[isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)",
                "TypeScript Git library",
                "[MIT](https://github.com/isomorphic-git/isomorphic-git/blob/main/LICENSE.md)",
            ),
        ),
    ),
    "gws": Licensing(
        "Apache-2.0",
        (
            Project(
                "[gws](https://github.com/googleworkspace/cli)",
                "Upstream CLI",
                "[Apache-2.0](https://github.com/googleworkspace/cli/blob/main/LICENSE)",
            ),
        ),
    ),
    "hf": Licensing(
        "Apache-2.0",
        (
            Project(
                "[huggingface_hub](https://github.com/huggingface/huggingface_hub)"
                " 1.16.4",
                "Upstream CLI; its repository file filters are adapted",
                "Apache-2.0",
                "huggingface_hub",
            ),
        ),
    ),
    "himalaya": Licensing(
        "MIT or Apache-2.0",
        (
            Project(
                "[Himalaya](https://github.com/pimalaya/himalaya)",
                "Upstream CLI",
                "[MIT](https://github.com/pimalaya/himalaya/blob/master/LICENSE-MIT)"
                " or "
                "[Apache-2.0](https://github.com/pimalaya/himalaya/blob/master/LICENSE-APACHE)",
            ),
        ),
    ),
    "linear": Licensing(
        "ISC",
        (
            Project(
                "[schpet/linear-cli](https://github.com/schpet/linear-cli) 3.1.0",
                "Command reference; its issue relation handling is adapted",
                "ISC",
                "schpet-linear-cli",
            ),
        ),
    ),
    "ntn": Licensing(
        "MIT",
        (
            Project(
                "[ntn](https://www.npmjs.com/package/ntn) 0.21.9",
                "Upstream CLI the conformance suite pins",
                "[MIT](https://www.npmjs.com/package/ntn/v/0.21.9)",
            ),
        ),
    ),
    "office": Licensing(
        "Apache-2.0",
        (
            Project(
                "[OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) 1.0.161",
                "Upstream CLI; its paths, properties, output and messages are adapted",
                "Apache-2.0",
                "officecli",
            ),
        ),
    ),
    "pdfinfo": Licensing(BEHAVIOR_ONLY, (POPPLER, PDF_OXIDE)),
    "pdftotext": Licensing(BEHAVIOR_ONLY, (POPPLER, PDF_OXIDE)),
    "search": Licensing("None; Mirage's own command"),
    "slack": Licensing("MIT (OpenClaw)", (OPENCLAW,)),
    "trello": Licensing(SERVICE_API),
}
SUMMARIES = {
    "airtable": (
        "Query bases and tables; read, create, update and delete records; "
        "add comments"
    ),
    "ast-grep": "Search and rewrite code, scan YAML rules and outline symbols",
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
    "office": (
        "Create and edit Excel workbooks, Word documents and PowerPoint "
        "decks with OfficeCLI paths"
    ),
    "pdfinfo": (
        "Print a PDF's metadata, page count, page sizes, encryption and "
        "version"
    ),
    "pdftotext": (
        "Extract a PDF's text in reading order, by layout or in drawing "
        "order, page by page"
    ),
    "search": (
        "Rank the records of Dify, Chroma, mem0, Qdrant and LanceDB mounts "
        "for a query"
    ),
    "slack": (
        "Read and send messages; manage reactions and pins; find members "
        "and search"
    ),
    "trello": (
        "Read boards, lists, labels and cards; create, update, move, "
        "assign, label and comment on cards"
    ),
}
UNLISTED = frozenset({"search"})
GROUPS = (
    ("Files", ("office", "pdftotext", "pdfinfo")),
    ("Developer", ("ast-grep", "gh", "git", "hf")),
    ("Chat", ("slack", "discord", "himalaya")),
    ("Productivity", ("gws", "ntn", "linear", "trello", "airtable")),
)
CORE_BARREL = ROOT / "typescript/packages/core/src/index.ts"
CORE_SPECS = ROOT / "typescript/packages/core/src/commands/cli/specs.ts"
CORE_CLIS = ROOT / "typescript/packages/core/src/clis"
IMG_STYLE = (
    "{{ display: 'inline', width: '1em', height: '1em', "
    "margin: '0 0.4em 0 0', verticalAlign: '-0.125em' }}"
)


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
        (
            f"Run `{spec.name} <command> --help` for the supported flags and operands."
            if spec.subcommands
            else f"Run `{spec.name} --help` for the supported flags and operands."
        ),
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


def license_cell(project: Project) -> str:
    """Link an adapted project's license to the copy Mirage ships.

    Args:
        project (Project): One row of a CLI's licensing.
    """
    if project.notice is None:
        return project.license
    path = ROOT / "licenses/third_party" / f"{project.notice}.txt"
    if not path.is_file():
        raise FileNotFoundError(path)
    return f"[{project.license}]({REPO}/licenses/third_party/{project.notice}.txt)"


def license_block(name: str) -> str:
    """Render a reference page's license table.

    Args:
        name (str): The bundled CLI.
    """
    rows = [
        LICENSE_START,
        "## License",
        "",
        "| Project | Role in Mirage | License |",
        "| --- | --- | --- |",
    ]
    internal = []
    for project in (*LICENSES[name].projects, MIRAGE):
        cell = license_cell(project)
        if project.internal:
            internal.append(
                re.sub(r"\[([^\]]+)\]\([^)]+\).*", r"\1", project.name)
            )
        else:
            rows.append(f"| {project.name} | {project.role} | {cell} |")
    if internal:
        names = ", ".join(internal[:-1]) + f" and {internal[-1]}"
        rows += [
            "",
            f"Adapted code from {names} keeps its license in "
            f"[`licenses/third_party/`]({REPO.replace('/blob/', '/tree/')}"
            "/licenses/third_party).",
        ]
    rows += [
        "",
        "See [compatibility and licenses]"
        "(/home/setup/clis#compatibility-and-licenses).",
    ]
    return "\n".join([*rows, LICENSE_END])


def logo(name: str) -> str:
    """Render a CLI's sidebar icon inline, as the VFS overview does.

    Args:
        name (str): The bundled CLI, whose home setup page names the icon.
    """
    page = (ROOT / "docs/home/setup/cli" / f"{name}.mdx").read_text()
    found = re.search(r"^icon: (\S+)$", page, re.M)
    if found is None:
        raise SystemExit(f"docs/home/setup/cli/{name}.mdx has no icon")
    icon = found.group(1)
    if icon.startswith("/"):
        return f'<img noZoom src="{icon}" alt="" style={IMG_STYLE} />'
    return f'<Icon icon="{icon}" size={{14}} /> '


def exported(source: Path, pattern: str) -> frozenset[str]:
    """Name the bundled CLIs whose constants a TypeScript source lists.

    Args:
        source (Path): The TypeScript file to read.
        pattern (str): A regex whose first group holds comma-separated names.
    """
    found = re.findall(pattern, source.read_text(), re.M | re.S)
    names = {word.strip() for group in found for word in group.split(",")}
    return frozenset(
        name
        for name in BUILTIN_CLI_SPECS
        if name.upper().replace("-", "_") in names
    )


def installed_clis() -> frozenset[str]:
    """Name the CLIs a host installs through core's ``clis/`` entries.

    The browser and Cloudflare packages re-export each entry, so a page or
    a Worker that imports one carries that CLI.
    """
    return frozenset().union(
        *(
            exported(entry, r"^export \{([^}]*)\}$")
            for entry in sorted(CORE_CLIS.glob("*.ts"))
        )
    )


def browser_clis() -> frozenset[str]:
    """Name the CLIs core's barrel exports, which the browser package re-exports."""
    return (
        exported(CORE_BARREL, r"^export \{([^}]*)\} from") | installed_clis()
    )


def cloudflare_clis() -> frozenset[str]:
    """Name the CLIs in core's spec table, which a Workers app builds."""
    seeded = exported(
        CORE_SPECS,
        r"^const CLI_SPECS = new Map<string, CLI>\(\s*\[([^\]]*)\]",
    )
    return seeded | installed_clis()


def catalog(language: str) -> str:
    """Render the listed CLI inventory for an overview page.

    Args:
        language (str): The documentation section containing the links.
    """
    listed = set(BUILTIN_CLI_SPECS) - UNLISTED
    grouped = [name for _, names in GROUPS for name in names]
    if sorted(grouped) != sorted(listed):
        raise SystemExit(
            f"Group every listed CLI once: {listed ^ set(grouped)}"
        )
    if language == "home/setup":
        browser, cloudflare = browser_clis(), cloudflare_clis()
        rows = [START]
        for title, names in GROUPS:
            rows += [
                *([""] if len(rows) > 1 else []),
                f"### {title}",
                "",
                "| CLI | Supported operations | Commands | Python | Node.js "
                "| Browser | Cloudflare |",
                "| --- | --- | :-: | :-: | :-: | :-: | :-: |",
            ]
            for name in names:
                count = sum(1 for _ in commands(cli_spec_for(name).spec))
                web = "✓" if name in browser else ""
                edge = "✓" if name in cloudflare else ""
                rows.append(
                    f"| {logo(name)}[{name}](/home/setup/cli/{name}) "
                    f"| {SUMMARIES[name]} | {count} | ✓ | ✓ | {web} | {edge} |"
                )
        return "\n".join([*rows, END])
    rows = [
        START,
        "| Program | Supported operations | Commands | Upstream license |",
        "| --- | --- | --- | --- |",
    ]
    for name in sorted(listed):
        count = sum(1 for _ in commands(cli_spec_for(name).spec))
        upstream = LICENSES[name].upstream
        upstream = f"[{upstream}](/{language}/cli/{name}#license)"
        rows.append(
            f"| {logo(name)}[{name}](/{language}/cli/{name}) "
            f"| {SUMMARIES[name]} | {count} | {upstream} |"
        )
    return "\n".join([*rows, END])


def replace_block(
    text: str, block: str, start_marker: str, end_marker: str
) -> str:
    """Replace exactly one generated block, refusing missing markers.

    Args:
        text (str): The existing page.
        block (str): The newly rendered block, markers included.
        start_marker (str): The line opening the block.
        end_marker (str): The line closing the block.
    """
    if text.count(start_marker) != 1 or text.count(end_marker) != 1:
        raise ValueError(f"expected one {start_marker} block")
    start = text.index(start_marker)
    end = text.index(end_marker, start) + len(end_marker)
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
    if set(LICENSES) != set(BUILTIN_CLI_SPECS):
        raise SystemExit("Update CLI licensing for the registered programs")
    commands_block = (START, END)
    license = (LICENSE_START, LICENSE_END)
    pages: dict[Path, list[tuple[str, tuple[str, str]]]] = {}
    for language in ("python", "typescript"):
        directory = ROOT / "docs" / language / "cli"
        documented = {p.stem for p in directory.glob("*.mdx")} - {
            "index",
            "new",
            "new-reference",
            "mcp",
        }
        listed = set(BUILTIN_CLI_SPECS) - UNLISTED
        if documented != listed:
            raise SystemExit(
                f"{language} CLI pages disagree with the registry: "
                f"{documented ^ listed}"
            )
        pages[directory / "index.mdx"] = [(catalog(language), commands_block)]
    pages[ROOT / "docs/home/setup/clis.mdx"] = [
        (catalog("home/setup"), commands_block)
    ]
    for name in sorted(set(BUILTIN_CLI_SPECS) - UNLISTED):
        reference_page = (
            f"import Reference from '/snippets/cli/{name}.mdx'",
            "<Reference />",
        )
        license_page = (
            f"import License from '/snippets/cli/license/{name}.mdx'",
            "<License />",
        )
        expected = {
            ROOT / "docs/python/cli" / f"{name}.mdx": (
                reference_page,
                license_page,
            ),
            ROOT / "docs/typescript/cli" / f"{name}.mdx": (
                reference_page,
                license_page,
            ),
            ROOT / "docs/home/setup/cli" / f"{name}.mdx": (license_page,),
        }
        for page, snippets in expected.items():
            text = page.read_text()
            for line in (line for snippet in snippets for line in snippet):
                if line not in text:
                    raise SystemExit(f"{page.relative_to(ROOT)} lacks {line}")
        pages[ROOT / "docs/snippets/cli" / f"{name}.mdx"] = [
            (reference(cli_spec_for(name)), commands_block)
        ]
        pages[ROOT / "docs/snippets/cli/license" / f"{name}.mdx"] = [
            (license_block(name), license)
        ]
    stale = []
    for path, blocks in pages.items():
        text = path.read_text()
        updated = text
        for block, (start_marker, end_marker) in blocks:
            updated = replace_block(updated, block, start_marker, end_marker)
        if text != updated:
            stale.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.write_text(updated)
    for name in sorted(set(BUILTIN_CLI_SPECS) - UNLISTED):
        snippet = ROOT / "docs/snippets/cli" / f"{name}.mdx"
        found = re.findall(r"^## (.+)$", snippet.read_text(), re.M)
        if found != SECTIONS:
            raise SystemExit(
                f"{snippet.relative_to(ROOT)} has sections {found}; "
                f"a CLI reference has {SECTIONS}"
            )
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
