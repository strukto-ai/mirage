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


import pytest

from mirage.commands.cli.builtin.himalaya import HIMALAYA
from mirage.commands.cli.specs import cli_spec_for
from mirage.policy import Deny
from mirage.policy.base import Policy
from mirage.policy.types import CommandContext
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

SETUP = (
    "mkdir -p /workspace/outbox",
    "ln -s /slack/export.csv /workspace/outbox/x.csv",
    "ln -s /slack /workspace/outbox/s",
    "cd /workspace/outbox",
)

Row = tuple[str, str, str | None, str | None]


async def _seen(line: str) -> CommandContext:
    seen: list[CommandContext] = []

    class Capture(Policy):
        def pre_command(self, ctx: CommandContext) -> Deny | None:
            if ctx.command in ("cd", "mkdir", "ln"):
                return None
            seen.append(ctx)
            return Deny("captured")

    ws = Workspace(
        {"/workspace": RAMVFS(), "/slack": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[Capture()],
    )
    try:
        for name in ("git", "pdfinfo", "office"):
            ws.register_cli(name, cli_spec_for(name))
        ws.register_cli(
            "himalaya",
            HIMALAYA,
            {
                "imap_host": "h",
                "smtp_host": "h",
                "username": "u",
                "password": "p",
            },
        )
        for step in SETUP:
            await ws.shell(step)
        await ws.shell(line)
        return seen[-1]
    finally:
        await ws.close()


def _rows(ctx: CommandContext) -> tuple[Row, ...]:
    return tuple(
        (w.text, w.kind.value, w.option, w.path.virtual if w.path else None)
        for w in ctx.words[1:]
    )


LINES = [
    (
        "cat a.txt a.txt",
        ["/workspace/outbox/a.txt", "/workspace/outbox/a.txt"],
        (
            ("a.txt", "operand", None, "/workspace/outbox/a.txt"),
            ("a.txt", "operand", None, "/workspace/outbox/a.txt"),
        ),
    ),
    (
        "sort -o out.txt in.txt",
        ["/workspace/outbox/out.txt", "/workspace/outbox/in.txt"],
        (
            ("-o", "option", None, None),
            ("out.txt", "value", "-o", "/workspace/outbox/out.txt"),
            ("in.txt", "operand", None, "/workspace/outbox/in.txt"),
        ),
    ),
    (
        "grep -f a.txt -f b.txt x y.txt",
        [
            "/workspace/outbox/a.txt",
            "/workspace/outbox/b.txt",
            "/workspace/outbox/x",
            "/workspace/outbox/y.txt",
        ],
        (
            ("-f", "option", None, None),
            ("a.txt", "value", "-f", "/workspace/outbox/a.txt"),
            ("-f", "option", None, None),
            ("b.txt", "value", "-f", "/workspace/outbox/b.txt"),
            ("x", "operand", None, "/workspace/outbox/x"),
            ("y.txt", "operand", None, "/workspace/outbox/y.txt"),
        ),
    ),
    (
        "grep --file=a.txt pat b.txt",
        [
            "/workspace/outbox/pat",
            "/workspace/outbox/b.txt",
            "/workspace/outbox/a.txt",
        ],
        (
            ("--file=a.txt", "option", "--file", "/workspace/outbox/a.txt"),
            ("pat", "operand", None, "/workspace/outbox/pat"),
            ("b.txt", "operand", None, "/workspace/outbox/b.txt"),
        ),
    ),
    (
        "grep --file= x",
        ["/workspace/outbox/x"],
        (
            ("--file=", "option", None, None),
            ("x", "operand", None, "/workspace/outbox/x"),
        ),
    ),
    (
        "zgrep -f - x",
        ["/workspace/outbox/-", "/workspace/outbox/x"],
        (
            ("-f", "option", None, None),
            ("-", "value", "-f", "/workspace/outbox/-"),
            ("x", "operand", None, "/workspace/outbox/x"),
        ),
    ),
    (
        "tar -C /slack -cf x.tar a.txt",
        ["/slack", "/workspace/outbox/x.tar", "/slack/a.txt"],
        (
            ("-C", "option", None, None),
            ("/slack", "value", "-C", "/slack"),
            ("-cf", "option", None, None),
            ("x.tar", "value", "-cf", "/workspace/outbox/x.tar"),
            ("a.txt", "operand", None, "/slack/a.txt"),
        ),
    ),
    (
        "tar -C a -Cb -cf o.tar f",
        [
            "/workspace/outbox/a",
            "/workspace/outbox/o.tar",
            "/workspace/outbox/a/b/f",
            "/workspace/outbox/a/b",
        ],
        (
            ("-C", "option", None, None),
            ("a", "value", "-C", "/workspace/outbox/a"),
            ("-Cb", "option", "-C", "/workspace/outbox/a/b"),
            ("-cf", "option", None, None),
            ("o.tar", "value", "-cf", "/workspace/outbox/o.tar"),
            ("f", "operand", None, "/workspace/outbox/a/b/f"),
        ),
    ),
    (
        "ls",
        ["/workspace/outbox"],
        (),
    ),
    (
        "cat x.csv",
        ["/workspace/outbox/x.csv", "/slack/export.csv"],
        (("x.csv", "operand", None, "/workspace/outbox/x.csv"),),
    ),
    (
        "cat s/../x.csv",
        ["/workspace/outbox/x.csv", "/x.csv"],
        (("s/../x.csv", "operand", None, "/workspace/outbox/x.csv"),),
    ),
    (
        "cat a.txt > out.txt",
        ["/workspace/outbox/a.txt", "/workspace/outbox/out.txt"],
        (
            ("a.txt", "operand", None, "/workspace/outbox/a.txt"),
            ("out.txt", "redirect", None, "/workspace/outbox/out.txt"),
        ),
    ),
    (
        "himalaya message reply 1 --attach rel.csv /slack/zz",
        ["/slack/zz", "/workspace/outbox/rel.csv"],
        (
            ("message", "subcommand", None, None),
            ("reply", "subcommand", None, None),
            ("1", "operand", None, None),
            ("--attach", "option", None, None),
            ("rel.csv", "value", "--attach", "/workspace/outbox/rel.csv"),
            ("/slack/zz", "operand", None, "/slack/zz"),
        ),
    ),
    (
        "himalaya message reply 1 --attach=all.csv",
        ["/workspace/outbox/all.csv"],
        (
            ("message", "subcommand", None, None),
            ("reply", "subcommand", None, None),
            ("1", "operand", None, None),
            (
                "--attach=all.csv",
                "option",
                "--attach",
                "/workspace/outbox/all.csv",
            ),
        ),
    ),
    (
        "himalaya message reply 1 --attach x.csv",
        ["/workspace/outbox/x.csv", "/slack/export.csv"],
        (
            ("message", "subcommand", None, None),
            ("reply", "subcommand", None, None),
            ("1", "operand", None, None),
            ("--attach", "option", None, None),
            ("x.csv", "value", "--attach", "/workspace/outbox/x.csv"),
        ),
    ),
    (
        "himalaya message reply 1 --attach s/../x.csv",
        ["/workspace/outbox/x.csv", "/x.csv"],
        (
            ("message", "subcommand", None, None),
            ("reply", "subcommand", None, None),
            ("1", "operand", None, None),
            ("--attach", "option", None, None),
            ("s/../x.csv", "value", "--attach", "/workspace/outbox/x.csv"),
        ),
    ),
    (
        "git -C ../../slack log",
        ["/slack"],
        (
            ("-C", "option", None, None),
            ("../../slack", "value", "-C", "/slack"),
            ("log", "subcommand", None, None),
        ),
    ),
    (
        "git -C a -Cb log",
        ["/workspace/outbox/a/b", "/workspace/outbox/a"],
        (
            ("-C", "option", None, None),
            ("a", "value", "-C", "/workspace/outbox/a"),
            ("-Cb", "option", "-C", "/workspace/outbox/a/b"),
            ("log", "subcommand", None, None),
        ),
    ),
    (
        "git -C -x log",
        ["/workspace/outbox/-x"],
        (
            ("-C", "option", None, None),
            ("-x", "value", "-C", "/workspace/outbox/-x"),
            ("log", "subcommand", None, None),
        ),
    ),
    (
        "pdfinfo rel.pdf",
        ["/workspace/outbox/rel.pdf"],
        (("rel.pdf", "operand", None, "/workspace/outbox/rel.pdf"),),
    ),
    (
        "pdfinfo -",
        [],
        (("-", "operand", None, None),),
    ),
    (
        "office get f.docx /",
        ["/", "/workspace/outbox/f.docx"],
        (
            ("get", "subcommand", None, None),
            ("f.docx", "operand", None, "/workspace/outbox/f.docx"),
            ("/", "operand", None, "/"),
        ),
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line, paths, words", LINES)
async def test_a_policy_reads_each_word_and_the_paths_the_line_reaches(
    line: str, paths: list[str], words: tuple[Row, ...]
) -> None:
    ctx = await _seen(line)
    assert [p.virtual for p in ctx.paths] == paths
    assert _rows(ctx) == words


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [row[0] for row in LINES])
async def test_every_path_a_word_names_is_in_paths(line: str) -> None:
    ctx = await _seen(line)
    named = {w.path.virtual for w in ctx.words if w.path is not None}
    assert named <= {p.virtual for p in ctx.paths}
