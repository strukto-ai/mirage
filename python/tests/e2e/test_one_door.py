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

from contextvars import ContextVar
from typing import Any

import pytest

from mirage.commands.builtin.generic.crossmount.detect import strategy_for
from mirage.commands.builtin.generic.crossmount.types import Strategy
from mirage.commands.builtin.generic_bind import generic
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import Context, command
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.io.types import IOResult
from mirage.types import MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.view.types import SessionView
from mirage.workspace import Workspace
from mirage.workspace.dispatcher.dispatcher import Dispatcher
from mirage.workspace.files import Files
from mirage.workspace.mount.registry import GENERAL_COMMANDS

DISPATCHED: ContextVar[bool] = ContextVar("dispatched", default=False)


# A **kwargs function is handed the mount's index too, which RAMVFS's refuse.
def _traced(name: str) -> Any:
    async def call(self, *args, index=None, **kwargs):
        self._note(name)
        return await getattr(self.ram, name)(*args, **kwargs)

    return call


class Toy(BaseVFS):
    """A plug-in VFS handing only the calls a shell needs to RAM, each
    recorded with whether the dispatcher was handing it over."""

    name = "toy"
    read = _traced("read")
    readdir = _traced("readdir")
    stat = _traced("stat")
    write = _traced("write")
    mkdir = _traced("mkdir")
    unlink = _traced("unlink")
    rmdir = _traced("rmdir")
    rename = _traced("rename")
    truncate = _traced("truncate")
    setattr = _traced("setattr")

    def __init__(self, **kwargs: Any) -> None:
        self.ram = RAMVFS()
        super().__init__(accessor=self.ram.accessor, **kwargs)
        self.calls: list[tuple[str, bool]] = []

    def _note(self, name: str) -> None:
        self.calls.append((name, DISPATCHED.get()))


@pytest.fixture
def dispatched(monkeypatch: pytest.MonkeyPatch) -> None:
    entry = Dispatcher.dispatch

    async def marked(self: Dispatcher, *args: Any, **kwargs: Any) -> Any:
        token = DISPATCHED.set(True)
        try:
            return await entry(self, *args, **kwargs)
        finally:
            DISPATCHED.reset(token)

    monkeypatch.setattr(Dispatcher, "dispatch", marked)


async def _run(ws: Workspace, line: str, **kw: Any) -> tuple[int, str, str]:
    io = await ws.shell(line, **kw)
    return io.exit_code, await io.stdout_str(), await io.stderr_str()


SEED = (
    "mkdir -p /t/dir/sub /t/empty"
    " && printf 'alpha\\nbeta\\ngamma\\n' > /t/a.txt"
    " && printf 'beta\\ndelta\\n' > /t/b.txt"
    " && printf 'charlie\\n' > /t/dir/c.txt"
    " && printf 'delta\\n' > /t/dir/sub/d.txt"
    " && printf '3\\n1\\n2\\n' > /t/nums.txt"
    " && printf 'apple\\nbanana\\ncherry\\n' > /t/sorted.txt"
    " && printf '1,a\\n2,b\\n' > /t/left.csv"
    " && printf '1,x\\n2,y\\n' > /t/right.csv"
    " && printf 'a b\\nb c\\n' > /t/deps.txt"
    " && printf '{\"k\": [1, 2]}\\n' > /t/data.json"
    " && printf -- '--- a.txt\\n+++ a.txt\\n@@ -1,3 +1,3 @@\\n alpha\\n-beta\\n"
    "+BETA\\n gamma\\n' > /t/a.patch"
    " && ln -s a.txt /t/link.txt"
)
ROWS: dict[str, str] = {
    **{
        name: f"{name} /t/a.txt"
        for name in (
            "b2sum base64 expand fmt md5 md5sum nl rev sha1sum sha224sum"
            " sha256sum sha384sum sha512sum strings tac unexpand uniq wc xxd"
        ).split()
    },
    "awk": "awk '{print $1}' /t/a.txt",
    "basename": "basename /t/dir/c.txt",
    "bc": "bc /t/nums.txt",
    "cat": "cat /t/a.txt /t/link.txt",
    "cmp": "cmp /t/a.txt /t/a.txt",
    "column": "column -t -s, /t/left.csv",
    "comm": "comm /t/sorted.txt /t/sorted.txt",
    "cp": "cp -r /t/dir /t/copy && cp /t/link.txt /t/copied.txt",
    "csplit": "csplit -f /t/piece /t/a.txt 2",
    "cut": "cut -c1-3 /t/a.txt",
    "diff": "diff /t/a.txt /t/a.txt",
    "dirname": "dirname /t/dir/c.txt",
    "du": "du -a /t/dir",
    "file": "file /t/a.txt /t/data.json /t/dir",
    "find": "find /t -name '*.txt'",
    "fold": "fold -w 3 /t/a.txt",
    "grep": "grep -rn beta /t",
    "gunzip": "gzip -k /t/b.txt && gunzip -f /t/b.txt.gz",
    "gzip": "gzip -k /t/a.txt",
    "head": "head -n 2 /t/a.txt",
    "iconv": "iconv -f utf-8 -t ascii /t/a.txt",
    "join": "join -t, /t/left.csv /t/right.csv",
    "jq": "jq .k /t/data.json",
    "look": "look ban /t/sorted.txt",
    "ls": "ls -laR /t",
    "mkdir": "mkdir -p /t/new/deep",
    "mktemp": "mktemp -p /t",
    "mv": "mv /t/b.txt /t/dir/moved.txt",
    "numfmt": "numfmt --to=iec < /t/nums.txt",
    "od": "od -c /t/a.txt",
    "paste": "paste /t/a.txt /t/b.txt",
    "patch": "patch /t/a.txt /t/a.patch",
    "readlink": "readlink /t/link.txt",
    "realpath": "realpath /t/link.txt",
    "rg": "rg -n beta /t",
    "rm": "rm -r /t/b.txt /t/dir",
    "rmdir": "rmdir /t/empty",
    "sed": "sed -i s/beta/BETA/ /t/a.txt",
    "shuf": "shuf -o /t/shuffled.txt /t/a.txt",
    "sort": "sort -o /t/out.txt /t/nums.txt",
    "split": "split -l 1 /t/a.txt /t/part.",
    "stat": "stat /t/a.txt /t/dir",
    "tail": "tail -n 1 /t/a.txt",
    "tar": "tar -cf /t/x.tar -C /t dir && tar -tf /t/x.tar"
    " && mkdir /t/out && tar -xf /t/x.tar -C /t/out",
    "tee": "echo hi | tee /t/tee.txt",
    "touch": "touch /t/a.txt /t/touched.txt",
    "tr": "tr a-z A-Z < /t/a.txt",
    "tree": "tree /t",
    "truncate": "truncate -s 2 /t/a.txt",
    "tsort": "tsort /t/deps.txt",
    "unlink": "unlink /t/b.txt",
    "unzip": "zip -r /t/x.zip /t/dir && unzip -o -d /t/unzipped /t/x.zip",
    "zcat": "gzip -k /t/a.txt && zcat /t/a.txt.gz",
    "zgrep": "gzip -k /t/a.txt && zgrep beta /t/a.txt.gz",
    "zip": "zip -r /t/x.zip /t/dir",
    "python3": "python3 -c 'print(open(\"/t/a.txt\").read())'",
}
# Answered above the VFS: by string, by the namespace's links, by the index.
ABOVE = {"basename", "dirname", "readlink", "realpath", "stat"}
SKIP = {
    "reaches the network": "curl wget",
    "reads no file": "date expr getconf hostname id seq uname",
    "the same command as python3": "python",
    "a runtime the Python host does not ship": "js node",
}
# Lines across two mounts, at least one per strategy.
CROSS: dict[str, str] = {
    "cat": "cat /t/a.txt /u/a.txt",
    "head": "head -n 1 /t/a.txt /u/a.txt",
    "rm": "rm /t/b.txt /u/b.txt",
    "find": "find /t /u -name a.txt",
    "du": "du -s /t /u",
    "grep": "grep -r beta /t /u",
    "sort": "sort /t/nums.txt /u/a.txt",
    "wc": "wc /t/a.txt /u/a.txt",
    "awk": "awk '{print FILENAME}' /t/a.txt /u/a.txt",
    "cp": "cp -r /t/dir /u/copy && cp /u/a.txt /t/from_u.txt",
    "mv": "mv /t/b.txt /u/moved.txt",
    "tee": "echo hi | tee /t/tee.txt /u/tee.txt",
    "ls": "ls -lR /t /u",
    "sed": "sed -n 1p /t/a.txt /u/a.txt",
    "tar": "tar -cf /u/x.tar /t/dir /u/a.txt",
}


def test_the_rows_cover_every_builtin_and_every_cross_mount_strategy():
    skipped = set(" ".join(SKIP.values()).split())
    names = {c.name for c in (*GENERIC_COMMANDS, *GENERAL_COMMANDS)}
    assert not set(ROWS) & skipped
    assert names == set(ROWS) | skipped
    assert {strategy_for(name) for name in CROSS} == set(Strategy)


TRACES = {k: (v, ["/t/"]) for k, v in ROWS.items()} | {
    f"{k}-across": (v, ["/t/", "/u/"]) for k, v in CROSS.items()
}


@pytest.mark.asyncio
@pytest.mark.parametrize("name", TRACES)
async def test_a_builtin_reaches_its_files_only_through_the_dispatcher(
    dispatched: None, name: str
):
    line, prefixes = TRACES[name]
    toys = [Toy() for _ in prefixes]
    ws = Workspace(dict(zip(prefixes, toys)), mode=MountMode.EXEC)
    try:
        for prefix in prefixes:
            seeded = await ws.shell(SEED.replace("/t/", prefix))
            assert seeded.exit_code == 0, await seeded.stderr_str()
        for toy in toys:
            toy.calls.clear()
        io = await ws.shell(line)
        await io.materialize_stdout()
        assert io.exit_code == 0, await io.stderr_str()
    finally:
        await ws.close()
    assert [bool(toy.calls) for toy in toys] == [name not in ABOVE] * len(toys)
    assert [c for toy in toys for c, inside in toy.calls if not inside] == []


@pytest.mark.asyncio
async def test_the_trace_sees_a_call_past_the_dispatcher(dispatched: None):
    toy = Toy()

    @command("peek", vfs=None, spec=CommandSpec())
    async def peek(accessor, paths, texts, ctx):
        return await toy.read(PathSpec.from_str_path("/a.txt")), IOResult()

    ws = Workspace({"/t/": toy}, mode=MountMode.WRITE)
    try:
        await ws.shell(SEED)
        ws.mount("/t/").register_commands([peek])
        toy.calls.clear()
        io = await ws.shell("peek; cat /t/a.txt")
        assert await io.stdout_str() == "alpha\nbeta\ngamma\n" * 2
    finally:
        await ws.close()
    assert toy.calls == [("read", False), ("read", True)]


DEFAULT_GREP = generic("grep")


@command("grep", vfs="toy", spec=DEFAULT_GREP.spec)
async def _toy_grep(accessor, paths, texts, ctx):
    if FlagView(ctx.flags, ctx.spec).as_bool("count"):
        return await DEFAULT_GREP.fn(accessor, paths, texts, ctx)
    body = b"".join([await ctx.vfs.read(path) for path in paths]).decode()
    hits = [f"toy> {line}\n" for line in body.splitlines() if texts[0] in line]
    return "".join(hits).encode(), IOResult()


@pytest.mark.asyncio
async def test_a_replacement_hands_the_builtin_what_it_does_not_answer():
    ws = Workspace({"/t/": Toy(commands=[_toy_grep])}, mode=MountMode.WRITE)
    try:
        assert (await ws.shell(SEED)).exit_code == 0
        counted = await _run(ws, "cd /t && grep -c beta a.txt b.txt dir/c.txt")
        mine = await _run(ws, "cd /t && grep beta a.txt")
    finally:
        await ws.close()
    assert counted == (0, "a.txt:1\nb.txt:1\ndir/c.txt:0\n", "")
    assert mine == (0, "toy> beta\n", "")


# Lines whose output names a time or a random name, compared without it.
STEADY = {
    "ls": "ls -aR /t",
    "mktemp": "mktemp -p /t > /dev/null && ls /t | wc -l && rm /t/tmp.*",
    "shuf": "shuf -o /t/shuffled.txt /t/a.txt"
    " && sort -o /t/shuffled.txt /t/shuffled.txt && cat /t/shuffled.txt",
    "stat": "stat -c '%n %s %F' /t/a.txt /t/dir",
}
# What a line leaves behind: every entry by name and size, and every file's
# bytes but an archive's, which carry times.
STATE = (
    "find /t -printf '%p %y %s\\n' | sort"
    " && find /t -type f ! -name '*.gz' ! -name '*.tar' ! -name '*.zip'"
    " | sort | xargs md5sum"
)


async def _outcome(
    vfs: BaseVFS, line: str
) -> tuple[tuple[int, str, str], tuple[int, str, str]]:
    ws = Workspace({"/t/": vfs}, mode=MountMode.WRITE)
    try:
        assert (await ws.shell(SEED)).exit_code == 0
        return await _run(ws, line), await _run(ws, STATE)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ROWS)
async def test_a_plug_in_vfs_answers_as_ram_does(name: str):
    line = STEADY.get(name, ROWS[name])
    assert await _outcome(Toy(), line) == await _outcome(RAMVFS(), line)


SEEN: list[tuple[str, Context]] = []
FILE = (Argument("file", type="path"),)


def _show(kind: str) -> Any:
    async def show(accessor, paths, texts, ctx):
        SEEN.append((kind, ctx))
        return await ctx.vfs.read(paths[0]), IOResult()

    return show


PEEK = command("peek", vfs=None, spec=CommandSpec(arguments=FILE))(
    _show("command")
)
NOTES = CLI(
    spec=CommandSpec(
        name="notes", subcommands=(CommandSpec(name="show", arguments=FILE),)
    ),
    handlers={"show": CLIHandler(fn=_show("tree"))},
)
PAGE = CLI(
    spec=CommandSpec(name="page", arguments=FILE),
    handlers={"": CLIHandler(fn=_show("installed"))},
)


KINDS = {
    "command": "peek /n/a.txt",
    "tree": "notes show /n/a.txt",
    "installed": "page /n/a.txt",
}


@pytest.mark.asyncio
async def test_a_command_a_tree_and_a_cli_get_one_context():
    SEEN.clear()
    ws = Workspace({"/n/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert (await ws.shell("printf 'first\\n' > /n/a.txt")).exit_code == 0
        ws.mount("/n/").register_commands([PEEK, NOTES])
        ws.register_cli("page", PAGE)
        ws.create_session("one")
        for line in KINDS.values():
            ran = await _run(ws, line, session_id="one")
            assert ran == (0, "first\n", ""), line
    finally:
        await ws.close()
    assert [kind for kind, _ in SEEN] == list(KINDS)
    shapes = {(type(c), type(c.vfs), type(c.session)) for _, c in SEEN}
    assert shapes == {(Context, Files, SessionView)}
    assert all(c.session.session_id == "one" and c.shell for _, c in SEEN)
