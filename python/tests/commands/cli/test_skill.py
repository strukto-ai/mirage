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

import pathlib
import re
import shlex

import pytest

import mirage.commands.cli.builtin  # noqa: F401  registers builtin specs
from mirage.commands.cli.constants import SKILLED_CLIS
from mirage.commands.cli.generated.skills_data import SKILLS
from mirage.commands.cli.skill import parse_skill, skill_for
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.cli.walk import walk
from mirage.workspace.executor.command.cli import parse_spec_for
from mirage.workspace.executor.command.flags import option_error, parse_flags

REPO = pathlib.Path(__file__).resolve().parents[4]
SKILLS_DIR = REPO / "plugins/mirage/skills"

BASH_FENCE = re.compile(r"```bash\n(.*?)```", re.DOTALL)

HAPPY_TEXT = """\
---
name: widget
description: Do widget things.
---

# Widget

Body text.
"""


def test_parse_skill_happy_path():
    skill = parse_skill(HAPPY_TEXT)
    assert skill.name == "widget"
    assert skill.description == "Do widget things."
    assert skill.body == "# Widget\n\nBody text."
    assert skill.text == HAPPY_TEXT


def test_parse_skill_quoted_values():
    text = ('---\n'
            'name: "widget"\n'
            "description: 'Do widget things.'\n"
            '---\n'
            'Body.\n')
    skill = parse_skill(text)
    assert skill.name == "widget"
    assert skill.description == "Do widget things."
    assert skill.body == "Body."


def test_parse_skill_missing_frontmatter_fence():
    with pytest.raises(ValueError):
        parse_skill("# Widget\n\nNo frontmatter here.\n")


def test_parse_skill_unterminated_frontmatter():
    with pytest.raises(ValueError):
        parse_skill("---\nname: widget\ndescription: Do widget things.\n")


def test_parse_skill_missing_description():
    with pytest.raises(ValueError):
        parse_skill("---\nname: widget\n---\nBody.\n")


def test_parse_skill_missing_name():
    with pytest.raises(ValueError):
        parse_skill("---\ndescription: Do widget things.\n---\nBody.\n")


def test_parse_skill_empty_description():
    with pytest.raises(ValueError):
        parse_skill('---\nname: widget\ndescription: ""\n---\nBody.\n')


def test_skill_for_returns_none_for_git():
    assert skill_for("git") is None


def test_skill_for_ignores_a_plugin_skill_that_is_not_a_cli():
    # The generated map carries the plugin's own skill too; a user spec
    # named after it must not inherit unrelated instructions.
    assert "mirage-filesystem" in SKILLS
    assert skill_for("mirage-filesystem") is None


@pytest.mark.parametrize("name", sorted(SKILLED_CLIS))
def test_skilled_cli_has_a_matching_skill(name):
    skill = skill_for(name)
    assert skill is not None, f"{name!r} has no skill on disk yet"
    assert skill.name == name
    assert len(skill.description) <= 1024


@pytest.mark.parametrize("name", sorted(SKILLED_CLIS))
def test_skill_examples_dry_parse_against_the_real_tree(name):
    skill = skill_for(name)
    assert skill is not None, f"{name!r} has no skill on disk yet"
    spec = cli_spec_for(name)
    examples = []
    for block in BASH_FENCE.findall(skill.body):
        for line in block.split("\n"):
            stripped = line.strip()
            if stripped.startswith(f"{name} "):
                examples.append(stripped)
    assert examples, f"skill for {name!r} has no runnable {name!r} example"
    for line in examples:
        first, _, _rest = line.partition("|")
        argv = shlex.split(first)[1:]
        result = walk(name, spec, argv)
        assert result.leaf is not None, (
            f"{line!r} did not resolve to a leaf: "
            f"{result.output.decode(errors='replace')}")
        leaf = result.leaf
        prog = " ".join((name, ) + result.path)
        parse_spec, _mirage_help = parse_spec_for(leaf)
        parsed = parse_flags(list(result.argv), parse_spec, prog, "/")
        refusal = option_error(prog, parsed)
        assert refusal is None, f"{line!r} does not parse: {refusal}"
