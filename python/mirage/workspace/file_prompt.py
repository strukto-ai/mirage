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

from collections.abc import Mapping

from mirage.commands.cli.skill import skill_for
from mirage.types import MountMode
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.mount import MountEntry

HELP_HINT = (
    "Tip: run `man` to list every available command grouped by resource, "
    "`man <cmd>` for a single entry, and `<cmd> --help` for flag details.")

CLI_SECTION_HEADER = (
    "Installed CLIs (act on a service by name; the mounts above are how "
    "you find its ids):")


def _cli_description(head: str, install: CLIInstall) -> str:
    """The description for one installed CLI's row.

    The skill's frontmatter description when the spec ships one,
    respelled for the head this install answers to, else the spec's
    own description, else a placeholder.

    Args:
        head (str): the installed head word.
        install (CLIInstall): the installation to describe.
    """
    skill = skill_for(install.spec, head)
    if skill is not None:
        return skill.description
    return install.spec.description or "(no description)"


def _cli_section(clis: Mapping[str, CLIInstall]) -> str:
    """The "Installed CLIs" section, empty string when nothing is installed.

    Args:
        clis (Mapping[str, CLIInstall]): installs keyed by head word.
    """
    if not clis:
        return ""
    lines = [CLI_SECTION_HEADER]
    for head in sorted(clis):
        desc = _cli_description(head, clis[head])
        if not desc.endswith("."):
            desc += "."
        lines.append(f"- {head} — {desc} Guide: man {head}")
    return "\n".join(lines)


def build_file_prompt(mounts: list[MountEntry],
                      clis: Mapping[str, CLIInstall]) -> str:
    parts: list[str] = [HELP_HINT]
    for m in mounts:
        prompt = m.resource.PROMPT
        if not prompt:
            continue
        prefix = m.prefix.rstrip("/") or "/"
        section = prompt.format(prefix=prefix)
        if m.mode != MountMode.READ and m.resource.WRITE_PROMPT:
            section += "\n" + m.resource.WRITE_PROMPT.replace(
                "{prefix}", prefix)
        parts.append(section)
    cli_section = _cli_section(clis)
    if cli_section:
        parts.append(cli_section)
    return "\n\n".join(parts)
