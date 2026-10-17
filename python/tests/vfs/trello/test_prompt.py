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

from mirage.commands.cli.builtin.trello import TRELLO
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.types import CommandSpec
from mirage.vfs.trello.prompt import PROMPT, WRITE_PROMPT


def _verbs(
    node: CommandSpec = TRELLO.spec, path: tuple[str, ...] = ()
) -> dict[str, CommandSpec]:
    here = (*path, node.name)
    if not node.subcommands:
        return {" ".join(here): node}
    verbs: dict[str, CommandSpec] = {}
    for child in node.subcommands:
        verbs.update(_verbs(child, here))
    return verbs


def _usage_lines(text: str) -> list[str]:
    """Each command line a prompt teaches, continuation lines joined."""
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.split("#")[0].strip()
        if stripped.startswith("trello "):
            lines.append(stripped)
        elif lines and stripped.startswith(("[", "--")):
            lines[-1] += " " + stripped
    return lines


def _unmatched(line: str, verbs: dict[str, CommandSpec]) -> list[str]:
    tokens = line.replace("[", " ").replace("]", " ").split()
    name = next(
        (
            " ".join(tokens[:k])
            for k in (3, 4)
            if " ".join(tokens[:k]) in verbs
        ),
        None,
    )
    if name is None:
        return [f"{line!r} names no trello command"]
    spec = verbs[name]
    longs = {option.names[-1] for option in compile_spec(spec).options}
    takes_operands = compile_spec(spec).rest is not None or bool(
        compile_spec(spec).positional
    )
    problems = []
    rest = tokens[len(name.split()) :]
    i = 0
    while i < len(rest):
        token = rest[i]
        if token.startswith("--"):
            if token not in longs:
                problems.append(f"{name}: {token} is not an option")
            takes_value = i + 1 < len(rest) and not rest[i + 1].startswith(
                "--"
            )
            i += 2 if takes_value else 1
            continue
        if not takes_operands:
            problems.append(f"{name}: takes no operand, taught {token}")
        i += 1
    return problems


def test_every_taught_command_line_parses_against_the_cli():
    """The prompts show the CLI's verbs by example, so each line must
    name a trello command and only options its spec declares; the write
    verbs take every id as a flag, never a path operand."""
    verbs = _verbs()
    lines = _usage_lines(PROMPT + "\n" + WRITE_PROMPT)
    assert lines
    problems = [
        problem for line in lines for problem in _unmatched(line, verbs)
    ]
    assert problems == []


def test_the_prompts_point_at_the_cli():
    assert "trello --help" in PROMPT
    assert "trello card create" in WRITE_PROMPT
    assert "trello card comment" in WRITE_PROMPT
    assert "trello --help" in WRITE_PROMPT
