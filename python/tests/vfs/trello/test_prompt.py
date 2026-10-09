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

from mirage.commands.builtin.trello import COMMANDS
from mirage.commands.config import Command
from mirage.commands.spec.compile import compile_spec
from mirage.vfs.trello.prompt import PROMPT, WRITE_PROMPT


def _verbs() -> dict[str, Command]:
    return {
        rc.name: rc
        for fn in COMMANDS
        for rc in getattr(fn, "_registered_commands", [])
        if rc.name.startswith("trello ")
    }


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


def _unmatched(line: str, verbs: dict[str, Command]) -> list[str]:
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
        return [f"{line!r} names no registered command"]
    spec = verbs[name].spec
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


def test_every_taught_command_line_parses_against_its_spec():
    """The prompts are how an agent learns the verbs, so each line must
    name a registered command and only options its spec declares; the
    write verbs take every id as a flag, never a path operand."""
    verbs = _verbs()
    problems = [
        problem
        for line in _usage_lines(PROMPT + "\n" + WRITE_PROMPT)
        for problem in _unmatched(line, verbs)
    ]
    assert problems == []


def test_the_prompts_teach_every_verb():
    taught = {
        " ".join(line.split()[:4])
        if " ".join(line.split()[:4]) in _verbs()
        else " ".join(line.split()[:3])
        for line in _usage_lines(PROMPT + "\n" + WRITE_PROMPT)
    }
    assert taught == set(_verbs())
