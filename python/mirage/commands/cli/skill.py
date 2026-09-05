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
from dataclasses import replace

from mirage.commands.cli.constants import SKILLED_CLIS
from mirage.commands.cli.generated.skills_data import SKILLS
from mirage.commands.cli.specs import builtin_spec_for
from mirage.commands.cli.types import CLISpec, Skill

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


def _respell(text: str, name: str, head: str) -> str:
    """``text`` with every mention of the program ``name`` spelled ``head``.

    A mention is the bare word: not a piece of a longer identifier, a
    path segment or a dotted name, so ``ntn`` in ``ntn-prod``,
    ``/ntn`` or ``foo.ntn`` is left alone. Every skill names its program
    only in the lowercase head word (the product is capitalized in
    prose), which is what makes a plain word match safe.

    Args:
        text (str): skill prose or body, as written for ``name``.
        name (str): the program's own name, the spec name.
        head (str): the word the install answers to.
    """
    pattern = re.compile(r"(^|[^\w/.-])" + re.escape(name) + r"(?![\w-])",
                         re.MULTILINE)
    return pattern.sub(lambda m: m.group(1) + head, text)


def skill_for(spec: CLISpec, head: str | None = None) -> Skill | None:
    """The parsed skill for a bundled CLI spec, None when it ships none.

    Bound to the bundled spec itself, never just its name or installed
    head word, so a custom tree with the same name cannot inherit an
    unrelated guide. Two installs of one builtin still share one skill.
    Only ``SKILLED_CLIS`` answer: the generated map also carries the
    plugin's own skills (``mirage-filesystem``), and a user spec that
    happens to share such a name must not inherit one.

    A skill is written for the program's own name, and an install may
    answer to another word (``ntn-prod`` beside ``ntn``). Given that
    ``head``, the description and body are respelled for it, so the
    lines the manual teaches are the lines this install runs and not
    another account's; ``name`` and ``text`` stay the file's.

    Args:
        spec (CLISpec): the installed program tree.
        head (str | None): the installed head word; None or the spec
            name itself leaves the skill as written.
    """
    name = spec.name
    if name not in SKILLED_CLIS or builtin_spec_for(name) is not spec:
        return None
    text = SKILLS.get(name)
    if text is None:
        return None
    skill = parse_skill(text)
    if head is None or head == skill.name:
        return skill
    return replace(skill,
                   description=_respell(skill.description, skill.name, head),
                   body=_respell(skill.body, skill.name, head))
