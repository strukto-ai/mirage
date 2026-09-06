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
from mirage.policy.match import pattern_matches
from mirage.shell.constants import SHOPT_DEFAULTS
from mirage.types import MountMode
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.lookup import cli_tree_visible, verb_visible
from mirage.workspace.mount import MountEntry
from mirage.workspace.session import Session

HELP_HINT = (
    "Tip: run `man` to list every available command grouped by resource, "
    "`man <cmd>` for a single entry, and `<cmd> --help` for flag details.")

CLI_SECTION_HEADER = (
    "Installed CLIs (choose the intended account; mounts and CLI installs "
    "are independent):")


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


def _help_allowed(tokens: tuple[str, ...], session: Session) -> bool:
    """Match the whole help line, not just a visible head-word prefix.

    Args:
        tokens (tuple[str, ...]): the concrete help command's words.
        session (Session): the session reading the prompt.
    """
    if (session.shopts.get("expand_aliases", SHOPT_DEFAULTS["expand_aliases"])
            and tokens[0] in session.aliases):
        return False
    rules = session.commands
    return rules is None or rules.allow is None or any(
        pattern_matches(pattern, tokens) for pattern in rules.allow)


def _cli_section(clis: Mapping[str, CLIInstall],
                 session: Session | None) -> str:
    """The "Installed CLIs" section, empty when no installs are visible.

    Args:
        clis (Mapping[str, CLIInstall]): installs keyed by head word.
        session (Session | None): the default session, absent until hydrated.
    """
    if not clis or session is None:
        return ""
    lines = [CLI_SECTION_HEADER]
    for head in sorted(clis):
        if not verb_visible(head, (), session):
            continue
        full_tree = cli_tree_visible(head, clis[head].spec, session)
        desc = (_cli_description(head, clis[head])
                if full_tree else "CLI with a restricted command set")
        if not desc.endswith("."):
            desc += "."
        guide = ""
        if _help_allowed(("man", head), session):
            guide = f" Guide: man {head}"
        elif (full_tree and head not in session.functions and _help_allowed(
            (head, "--help"), session)):
            guide = f" Guide: {head} --help"
        lines.append(f"- {head} — {desc}{guide}")
    return "\n".join(lines) if len(lines) > 1 else ""


def build_file_prompt(mounts: list[MountEntry], clis: Mapping[str, CLIInstall],
                      session: Session | None) -> str:
    parts: list[str] = []
    if session is not None:
        parts.append(HELP_HINT if _help_allowed(("man", ), session) else
                     "Tip: run `<cmd> --help` for flag details.")
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
    cli_section = _cli_section(clis, session)
    if cli_section:
        parts.append(cli_section)
    return "\n\n".join(parts)
