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

from mirage.commands.cli.constants import SKILLED_CLIS
from mirage.commands.cli.generated.skills_data import SKILLS
from mirage.commands.cli.types import Skill

_QUOTES = ('"', "'")


def _unquote(value: str) -> str:
    """Strip one layer of matching surrounding quotes, if present.

    Args:
        value (str): a raw frontmatter scalar value, already stripped
            of surrounding whitespace.
    """
    if (len(value) >= 2 and value[0] in _QUOTES and value[-1] == value[0]):
        return value[1:-1]
    return value


def parse_skill(text: str) -> Skill:
    """Read an agentskills.io SKILL.md: YAML-ish frontmatter plus body.

    Hand-rolled on purpose: neither this package nor its TypeScript
    twin depends on a YAML library, so the two must agree on exactly
    the same reading of the frontmatter. Only top-level ``key: value``
    lines are read; nested lines (indented, or part of a multi-line
    value) are ignored, and only ``name``/``description`` are kept.

    Args:
        text (str): the whole SKILL.md file, verbatim.
    """
    if not text.startswith("---\n"):
        raise ValueError("SKILL.md must start with a '---' frontmatter "
                         "fence")
    lines = text.split("\n")
    close_at = next((i for i in range(1, len(lines)) if lines[i] == "---"),
                    None)
    if close_at is None:
        raise ValueError("SKILL.md frontmatter is unterminated (no "
                         "closing '---' line)")
    name: str | None = None
    description: str | None = None
    for line in lines[1:close_at]:
        if not line or line[0] in (" ", "\t"):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            continue
        key = key.strip()
        value = _unquote(value.strip())
        if key == "name":
            name = value
        elif key == "description":
            description = value
    if not name:
        raise ValueError("SKILL.md frontmatter is missing 'name'")
    if not description:
        raise ValueError("SKILL.md frontmatter is missing 'description'")
    body = "\n".join(lines[close_at + 1:]).strip()
    return Skill(name=name, description=description, body=body, text=text)


def skill_for(name: str) -> Skill | None:
    """The parsed skill for a CLI spec name, None when it ships none.

    Keyed by the SPEC name (``install.spec.name``), never the
    installed head word, so two installs of one spec share one skill.
    Only ``SKILLED_CLIS`` answer: the generated map also carries the
    plugin's own skills (``mirage-filesystem``), and a user spec that
    happens to share such a name must not inherit one.

    Args:
        name (str): a ``CLISpec.name``.
    """
    if name not in SKILLED_CLIS:
        return None
    text = SKILLS.get(name)
    if text is None:
        return None
    return parse_skill(text)
