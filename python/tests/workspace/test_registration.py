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

from mirage import MountMode, Workspace
from mirage.commands.config import Command, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.io.types import IOResult
from mirage.vfs.ram import RAMVFS


@pytest.fixture
def ws():
    return Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)


@pytest.fixture
def ws_two_mounts():
    return Workspace(
        {
            "/a": RAMVFS(),
            "/b": RAMVFS(),
        },
        mode=MountMode.WRITE,
    )


def test_ws_mounts_returns_all(ws):
    mounts = ws.mounts()
    prefixes = [m.prefix for m in mounts]
    assert "/data/" in prefixes


def test_ws_mount_by_prefix(ws):
    m = ws.mount("/data/")
    assert m.prefix == "/data/"


def test_commands_introspection(ws):
    m = ws.mount("/data/")
    cmds = m.commands()
    assert isinstance(cmds, dict)
    assert cmds["cat"] == []


def test_the_mount_answers_its_vfs_functions(ws):
    m = ws.mount("/data/")
    assert m.answers("read")
    assert m.answers("stat")


def test_register_commands_adds_command(ws):
    @command("test_custom", vfs="ram", spec=SPECS["cat"])
    async def custom(accessor, paths, *texts, **kw):
        return b"custom", IOResult()

    m = ws.mount("/data/")
    assert "test_custom" not in m.commands()
    m.register_commands([custom])
    assert "test_custom" in m.commands()


def test_register_commands_adds_registered_command(ws):
    @command("test_custom", vfs="ram", spec=SPECS["cat"])
    async def custom(accessor, paths, *texts, **kw):
        return b"custom", IOResult()

    m = ws.mount("/data/")
    m.register_commands(custom._registered_commands)
    assert "test_custom" in m.commands()


def test_register_adds_a_filetype_variant(ws):
    # mirage ships no filetype renderers, so register one to prove the
    # extension point still works.
    m = ws.mount("/data/")

    async def demo_cat(store, paths, *texts, **kwargs):
        return b"demo", IOResult()

    m.register(
        Command(
            "cat", spec=SPECS["cat"], vfs="ram", filetype=".demo", fn=demo_cat
        )
    )
    assert m.commands()["cat"] == [".demo"]


@pytest.mark.asyncio
async def test_register_commands_replaces_a_command(ws):
    m = ws.mount("/data/")

    @command("cat", vfs="ram", spec=SPECS["cat"])
    async def custom_cat(accessor, paths, *texts, **kw):
        return b"custom cat output", IOResult()

    m.register_commands([custom_cat])
    assert "cat" in m.commands()
    await ws.shell("echo hello | tee /data/hello.txt")
    result = await ws.shell("cat /data/hello.txt")
    assert result.exit_code == 0
    assert b"custom cat output" in result.stdout


def test_register_commands_isolated_per_mount(ws_two_mounts):
    @command("only_on_a", vfs="ram", spec=SPECS["cat"])
    async def only_a(accessor, paths, *texts, **kw):
        return b"a", IOResult()

    ws_two_mounts.mount("/a/").register_commands([only_a])
    assert "only_on_a" in ws_two_mounts.mount("/a/").commands()
    assert "only_on_a" not in ws_two_mounts.mount("/b/").commands()


def test_register_commands_wrong_vfs_raises(ws):
    @command("s3_only", vfs="s3", spec=SPECS["cat"])
    async def s3_cmd(accessor, paths, *texts, **kw):
        return b"s3", IOResult()

    m = ws.mount("/data/")
    with pytest.raises(ValueError, match=r"'s3'"):
        m.register_commands([s3_cmd])


def test_register_commands_multi_vfs_filters_to_matching(ws):
    @command("multi", vfs=["ram", "s3"], spec=SPECS["cat"])
    async def multi(accessor, paths, *texts, **kw):
        return b"multi", IOResult()

    m = ws.mount("/data/")
    m.register_commands([multi])
    assert "multi" in m.commands()


async def custom_command(accessor, paths, *texts, **kw):
    return b"custom\n", IOResult()


# The per-program refusal voices and codes (grep's 2, diff's prefixed
# hint, CPython's and curl's wording, tar's old-option 2) describe the
# real program, so a command a mount registers under its name is refused
# like the control `mycmd`.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name", ["grep", "diff", "python3", "curl", "tar", "mycmd"]
)
async def test_a_borrowed_builtin_name_is_refused_like_a_custom_command(
    ws, name
):
    spec = CommandSpec(
        arguments=(
            Argument("-k"),
            Argument("--quiet", action="store_true"),
            Argument("--max", type="float"),
            Argument("rest", nargs="*"),
        ),
        old_option_style=True,
    )
    ws.mount("/data/").register(
        Command(name, spec=spec, vfs=None, filetype=None, fn=custom_command)
    )
    ok = await ws.shell(f"cd /data && {name} -k a x")
    assert (ok.exit_code, ok.stdout) == (0, b"custom\n")
    for words, line in (
        ("--bogus x", "unrecognized option '--bogus'"),
        ("-k", "option requires an argument -- 'k'"),
        ("--quiet=x", "option '--quiet' doesn't allow an argument"),
        ("--max=z", "invalid float value: 'z' for '--max'"),
        ("k", "Old option 'k' requires an argument."),
    ):
        refused = await ws.shell(f"cd /data && {name} {words}")
        assert (refused.exit_code, refused.stderr) == (
            1,
            f"{name}: {line}\nTry '{name} --help' for more information.\n".encode(),
        ), words


async def echo_command(accessor, paths, texts, ctx):
    return f"{[p.virtual for p in paths]} {texts}\n".encode(), IOResult()


# The steps that read a line with the builtin's grammar before routing
# (find's expression, the implied `.`, the program file, a path flag's
# mount, the help page) belong to the builtin, so a command a mount
# registers under its name runs as the control `mycmd` does.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "find --mode=a x",
        "rg x",
        "grep -f a x",
        "sort -o /b/out x",
        "grep --help",
    ],
)
async def test_a_borrowed_builtin_name_routes_like_a_custom_command(
    ws_two_mounts, line
):
    name, words = line.split(" ", 1)
    spec = CommandSpec(
        arguments=(
            Argument("--mode"),
            Argument("-f"),
            Argument("-o"),
            Argument("rest", nargs="*"),
        )
    )
    for registered in (name, "mycmd"):
        ws_two_mounts.mount("/a/").register(
            Command(
                registered, spec=spec, vfs=None, filetype=None, fn=echo_command
            )
        )
    borrowed = await ws_two_mounts.shell(f"cd /a && {line}")
    control = await ws_two_mounts.shell(f"cd /a && mycmd {words}")
    assert (borrowed.exit_code, borrowed.stdout, borrowed.stderr or b"") == (
        control.exit_code,
        control.stdout,
        (control.stderr or b"").replace(b"mycmd", name.encode()),
    )


# The mount a line runs on is picked by the words in operand slots that
# were classified as paths, read by position: never a file an option
# reads, even one an operand repeats, nor a word the cwd's spec left as
# text. /a borrows grep (text operands), find and rg (path operands);
# the builtin rg reads `/a/patterns` and a lone `/b/input` as its pattern,
# a text slot, so those lines run on /a, where a path on /b is refused
# rather than handed to /a's rg.
SPAN = (
    b"rg: paths span multiple mounts (/a/, /b/), cross-mount not supported\n"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, code, stdout, stderr",
    [
        ("cd /b && grep -f /a/patterns /b/input", 0, b"hi\n", b""),
        (
            "cd /b && grep -f /a/patterns /b/input /a/patterns",
            0,
            b"/b/input:hi\n['/a/patterns'] []\n",
            b"",
        ),
        ("cd /a && grep hi /b/input", 0, b"[] ['hi', '/b/input']\n", b""),
        ("cd /a && rg /a/patterns /b/input", 0, b"/a/patterns\n", b""),
        ("cd /a && rg /b/input", 1, b"", SPAN),
        ("cd /a && rg /b/input /a/patterns", 1, b"", SPAN),
        ("cd /a && find //b/input -print0", 0, b"//b/input\x00", b""),
    ],
)
async def test_a_borrowed_name_and_the_builtin_keep_their_own_lines(
    ws_two_mounts, line, code, stdout, stderr
):
    for name, kind in (("grep", "str"), ("find", "path"), ("rg", "path")):
        ws_two_mounts.mount("/a/").register(
            Command(
                name,
                spec=CommandSpec(
                    arguments=(Argument("rest", nargs="*", type=kind),)
                ),
                vfs=None,
                filetype=None,
                fn=echo_command,
            )
        )
    await ws_two_mounts.shell(
        "echo hi > /a/patterns; printf 'hi\\n/a/patterns\\n' > /b/input"
    )
    result = await ws_two_mounts.shell(line)
    assert (
        result.exit_code,
        result.stdout or b"",
        result.stderr or b"",
    ) == (code, stdout, stderr)
