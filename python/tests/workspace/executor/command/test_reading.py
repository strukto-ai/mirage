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
from mirage.types import Follow, MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.reading import line_paths, read_line
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.lookup import line_facts
from mirage.workspace.mount import MountRegistry

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
            ("--file=", "option", "--file", None),
            ("x", "operand", None, "/workspace/outbox/x"),
        ),
    ),
    (
        "zgrep -f - x",
        ["/workspace/outbox/x"],
        (
            ("-f", "option", None, None),
            ("-", "value", "-f", None),
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
        "himalaya message reply 1 --attach rel.csv --body-file /slack/zz",
        ["/workspace/outbox/rel.csv", "/slack/zz"],
        (
            ("message", "subcommand", None, None),
            ("reply", "subcommand", None, None),
            ("1", "operand", None, None),
            ("--attach", "option", None, None),
            ("rel.csv", "value", "--attach", "/workspace/outbox/rel.csv"),
            ("--body-file", "option", None, None),
            ("/slack/zz", "value", "--body-file", "/slack/zz"),
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
        ["/workspace/outbox/a", "/workspace/outbox/a/b"],
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
        ["/workspace/outbox/f.docx"],
        (
            ("get", "subcommand", None, None),
            ("f.docx", "operand", None, "/workspace/outbox/f.docx"),
            ("/", "operand", None, None),
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


def _tokens(
    reg: MountRegistry, name: str, *argv: str
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    reading = read_line(reg, name, list(argv), [], "/")
    return reading.tokens, reading.program


def test_a_tree_reads_its_verb_path_and_keeps_the_rest_raw():
    ws = Workspace(mounts={"/ram": (RAMVFS(), MountMode.WRITE)})
    try:
        ws.register_cli("git", cli_spec_for("git"))
        reg = ws._registry
        # Options before the verb are not the verb; an alias reads as
        # its canonical name; the leaf's own words follow untouched.
        assert _tokens(reg, "git", "-C", "/r", "reset", "--hard", "HEAD") == (
            ("git", "reset", "--hard", "HEAD"),
            ("git", "reset"),
        )
        assert _tokens(reg, "git", "log", "-1") == (
            ("git", "log", "-1"),
            ("git", "log"),
        )
        # A walk the tree refuses (unknown verb, bare head) reads raw.
        assert _tokens(reg, "git", "frobnicate", "x") == (
            ("git", "frobnicate", "x"),
            ("git",),
        )
        assert _tokens(reg, "git") == (("git",), ("git",))
        # Anything else is the name and the raw argv.
        assert _tokens(reg, "rm", "-rf", "/x") == (
            ("rm", "-rf", "/x"),
            ("rm",),
        )
        # A group option's value is never read as a verb, even one
        # that spells one (`-C status`, a directory named status).
        words = read_line(reg, "git", ["-C", "status", "log"], [], "/").words
        assert [(w.text, w.kind.value, w.option) for w in words] == [
            ("-C", "option", None),
            ("status", "value", "-C"),
            ("log", "subcommand", None),
        ]
    finally:
        import asyncio

        asyncio.run(ws.close())


async def _seen_by_policy(line: str, setup: str = "") -> CommandContext:
    seen: list[CommandContext] = []

    class Capture(Policy):
        def pre_command(self, ctx: CommandContext) -> Deny | None:
            if ctx.command in ("cd", "mkdir", "ln", "echo"):
                return None
            seen.append(ctx)
            return Deny("captured")

    ws = Workspace(
        {"/workspace": RAMVFS(), "/slack": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[Capture()],
    )
    try:
        ws.register_cli("git", cli_spec_for("git"))
        ws.register_cli("pdfinfo", cli_spec_for("pdfinfo"))
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
        await ws.shell("mkdir -p /workspace/outbox")
        if setup:
            await ws.shell(setup)
        await ws.shell("cd /workspace/outbox")
        await ws.shell(line)
        return seen[-1]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, text, option",
    [
        (
            "himalaya message reply 1 --attach ../../slack/export.csv",
            "../../slack/export.csv",
            "--attach",
        ),
        (
            "himalaya message reply 1 --attach=../../slack/export.csv",
            "--attach=../../slack/export.csv",
            "--attach",
        ),
        ("git -C ../../slack/export.csv log", "../../slack/export.csv", "-C"),
        ("git -C../../slack/export.csv log", "-C../../slack/export.csv", "-C"),
        ("pdfinfo ../../slack/export.csv", "../../slack/export.csv", None),
        (
            "tar -cf ../../slack/export.csv a.txt",
            "../../slack/export.csv",
            "-cf",
        ),
        (
            "tar -cf../../slack/export.csv a.txt",
            "-cf../../slack/export.csv",
            "-cf",
        ),
        (
            "tar -C ../.. -Cslack/export.csv -cf x.tar a.txt",
            "-Cslack/export.csv",
            "-C",
        ),
        (
            "grep --file=../../slack/export.csv x",
            "--file=../../slack/export.csv",
            "--file",
        ),
        ("grep -f../../slack/export.csv x", "-f../../slack/export.csv", "-f"),
    ],
)
async def test_a_path_word_names_the_path_paths_holds(
    line: str, text: str, option: str | None
):
    ctx = await _seen_by_policy(line)
    word = next(w for w in ctx.words if w.text == text)
    assert (word.option, word.to_dict()["path"]) == (
        option,
        "/slack/export.csv",
    )
    assert "/slack/export.csv" in [p.virtual for p in ctx.paths]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, text",
    [
        ("himalaya message reply 1 --attach x.csv", "x.csv"),
        ("grep --file=x.csv y", "--file=x.csv"),
        ("tar -cf x.csv a.txt", "x.csv"),
    ],
)
async def test_a_policy_sees_the_file_a_linked_option_value_opens(
    line: str, text: str
):
    ctx = await _seen_by_policy(
        line,
        "echo s > /slack/export.csv && "
        "ln -s /slack/export.csv /workspace/outbox/x.csv",
    )
    word = next(w for w in ctx.words if w.text == text)
    assert word.to_dict()["path"] == "/workspace/outbox/x.csv"
    assert "/slack/export.csv" in [p.virtual for p in ctx.paths]


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["grep --file= x", "pdfinfo -"])
async def test_a_dash_or_an_empty_value_names_no_file(line: str):
    ctx = await _seen_by_policy(line)
    virtuals = [p.virtual for p in ctx.paths]
    assert "/workspace/outbox" not in virtuals
    assert "/workspace/outbox/-" not in virtuals


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, words",
    [
        (
            "git for-each-ref --fo x.txt",
            (("--fo", "option", None), ("x.txt", "value", "--fo")),
        ),
        (
            "git reflog --help x.txt",
            (("--help", "option", None), ("x.txt", "operand", None)),
        ),
    ],
)
async def test_a_leaf_word_reads_as_the_run_parses_it(
    line: str, words: tuple[tuple[str, str, str | None], ...]
):
    ctx = await _seen_by_policy(line)
    assert (
        tuple((w.text, w.kind, w.option) for w in ctx.words[-len(words) :])
        == words
    )


@pytest.mark.asyncio
async def test_a_dash_led_group_value_is_a_value():
    ctx = await _seen_by_policy("git -C -x log")
    word = next(w for w in ctx.words if w.text == "-x")
    assert (word.kind.value, word.option) == ("value", "-C")


async def _virtuals(ws: Workspace, name: str, *args: str) -> list[str]:
    words = await classify_parts([name, *args], ws._registry, "/")
    reading = read_line(ws._registry, name, list(args), words[1:], "/")
    follows = line_facts(name, words, "/").follows is not Follow.NONE
    return [
        p.virtual
        for p in line_paths(name, reading, follows, ws._namespace, "/")
    ]


@pytest.mark.asyncio
async def test_line_paths_follow_links_only_for_a_following_command():
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    try:
        await ws.shell(
            "echo top > /data/secret && ln -s /data/secret /data/link"
        )
        # cat opens the target: the typed path first, then what it
        # resolves to; rm and `ls -l` act on the link itself.
        assert await _virtuals(ws, "cat", "/data/link") == [
            "/data/link",
            "/data/secret",
        ]
        assert await _virtuals(ws, "rm", "/data/link") == ["/data/link"]
        assert await _virtuals(ws, "ls", "-l", "/data/link") == ["/data/link"]
        assert await _virtuals(ws, "ls", "/data/link") == [
            "/data/link",
            "/data/secret",
        ]
        # A path that is not a link reads once; no namespace reads typed.
        assert await _virtuals(ws, "cat", "/data/secret") == ["/data/secret"]
        words = await classify_parts(["cat", "/data/link"], ws._registry, "/")
        reading = read_line(
            ws._registry, "cat", ["/data/link"], words[1:], "/"
        )
        assert [
            p.virtual for p in line_paths("cat", reading, True, None, "/")
        ] == ["/data/link"]
    finally:
        await ws.close()
