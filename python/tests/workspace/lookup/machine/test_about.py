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

from mirage import RAMVFS, MountMode, Workspace
from mirage.policy import Deny
from mirage.policy.base import Policy
from mirage.workspace.lookup.constants import LOCALHOST_WORD
from tests.fixtures.machine import ScriptedMachine, failed
from tests.fixtures.machine_files import FakeFiles, out, two


@pytest.mark.asyncio
async def test_a_machine_fact_is_asked_of_the_machine_the_command_is_about():
    a = FakeFiles(programs=("uname",))
    b = FakeFiles({"/srv/k": b"k"}, programs=("uname",))
    first = ScriptedMachine("a", a.answer)
    ws = Workspace(
        {"/srv": "@b", "/data": RAMVFS()},
        mode=MountMode.WRITE,
        machines={"a": first, "b": ScriptedMachine("b", b.answer)},
    )
    await ws.shell("cd /data && uname -m")
    await ws.shell("cd /data && uname -r", machine="b")
    await ws.shell("cd /srv && uname -s")
    assert (a.ran, b.ran) == (["uname -m"], ["uname -r", "uname -s"])
    assert first.cwds == ["/"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_without_the_program_leaves_the_fact_to_mirage():
    a, b = FakeFiles(), FakeFiles()
    ws = two(a, b)
    assert await out(ws, "uname -s") == "Linux\n"
    assert (a.ran, b.ran) == ([], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_request_to_localhost_runs_on_the_machine_it_is_about():
    a, b = FakeFiles(programs=("curl",)), FakeFiles(programs=("curl",))
    ws = two(a, b, mounts={"/data": RAMVFS()})
    await ws.shell("cd /data && curl -s localhost:8000/health")
    await ws.shell("curl -s http://127.0.0.1:8000/x", machine="b")
    assert a.ran == ["curl -s localhost:8000/health"]
    assert b.ran == ["curl -s http://127.0.0.1:8000/x"]
    await ws.close()


class Watched(Policy):
    def __init__(self) -> None:
        self.asked: list[tuple[str, str, int]] = []

    async def pre_network(self, ctx):
        self.asked.append((ctx.command, ctx.address, ctx.port))
        return Deny(reason="watched")


@pytest.mark.asyncio
async def test_under_a_network_policy_mirage_keeps_a_request_to_localhost():
    a, b = FakeFiles(programs=("curl",)), FakeFiles(programs=("curl",))
    watched = Watched()
    ws = two(a, b, policies=[watched])
    done = await ws.shell("curl -s --max-time 2 http://127.0.0.1:8000/x")
    assert done.exit_code == 7
    assert watched.asked == [("curl", "127.0.0.1", 8000)]
    assert (a.ran, b.ran) == ([], [])
    await ws.close()


class Logged(Policy):
    async def post_network(self, ctx):
        return None


class Reads(Policy):
    async def pre_vfs(self, ctx):
        return None


REQUEST = "http://127.0.0.1:1/x"
CLIENTS = ("curl", "wget")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        f"curl -s --max-time 2 {REQUEST}",
        f"cd /srv && curl -s --max-time 2 {REQUEST}",
        "cd /srv && curl -s --max-time 2 http://0.0.0.0:1/x",
        f"cd /srv && wget -q -T 2 -O - {REQUEST}",
    ],
)
@pytest.mark.parametrize(
    "limits", [{"network": False}, {"policies": [Logged()]}]
)
async def test_a_watched_network_keeps_every_request_in_mirage(line, limits):
    a = FakeFiles(programs=CLIENTS)
    b = FakeFiles({"/srv/k": b"k"}, programs=CLIENTS)
    ws = two(a, b, mounts={"/srv": "@b"}, **limits)
    await ws.shell(line)
    assert (a.ran, b.ran) == ([], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_request_runs_where_the_files_it_reads_are_the_machine_s():
    a = FakeFiles(programs=CLIENTS)
    b = FakeFiles({"/srv/k": b"k"}, programs=CLIENTS)
    ws = two(a, b, mounts={"/srv": "@b", "/data": RAMVFS()})
    await ws.shell("echo d > /data/body")
    await ws.shell(f"cd /srv && curl -s -d @k -b jar -w @k {REQUEST}")
    await ws.shell(f"cd /srv && curl -s --data-binary @/data/body {REQUEST}")
    await ws.shell(
        f"cd /srv && curl -s --data-urlencode n@/data/body {REQUEST}"
    )
    await ws.shell(f"cd /srv && curl -s -F f=@k {REQUEST}")
    await ws.shell(f"cd /srv && curl -s -T k {REQUEST}")
    await ws.shell(f"cd /data && curl -s -d @body {REQUEST}")
    assert a.ran == []
    assert b.ran == [f"curl -s -d @k -b jar -w @k {REQUEST}"]
    await ws.close()


@pytest.mark.asyncio
async def test_under_a_file_policy_a_request_reading_a_file_stays_in_mirage():
    a = FakeFiles(programs=CLIENTS)
    b = FakeFiles({"/srv/k": b"k"}, programs=CLIENTS)
    ws = two(a, b, mounts={"/srv": "@b"}, policies=[Reads()])
    await ws.shell(f"cd /srv && curl -s --data-binary @/srv/k {REQUEST}")
    await ws.shell(f"cd /srv && curl -s {REQUEST}")
    assert (a.ran, b.ran) == ([], [f"curl -s {REQUEST}"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_download_lands_in_the_folder_only_its_machine_holds():
    a = FakeFiles(programs=CLIENTS)
    b = FakeFiles({"/srv/k": b"k"}, programs=CLIENTS)
    ws = two(a, b, mounts={"/srv": "@b", "/data": RAMVFS()})
    await ws.shell(f"cd /data && wget -q -T 2 {REQUEST}")
    await ws.shell(f"cd /data && wget -q -T 2 {REQUEST} /srv/out")
    await ws.shell(f"cd /data && wget -q -T 2 -O - {REQUEST}")
    await ws.shell(f"cd /data && wget -q -T 2 --spider {REQUEST}")
    await ws.shell(f"cd /srv && wget -q -T 2 {REQUEST}")
    assert a.ran == [
        f"wget -q -T 2 -O - {REQUEST}",
        f"wget -q -T 2 --spider {REQUEST}",
    ]
    assert b.ran == [f"wget -q -T 2 {REQUEST}"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_fact_from_a_shared_folder_is_asked_of_the_machine_holding_it():
    a = FakeFiles(programs=("uname",))
    b = FakeFiles({"/tmp/only/k": b"k"}, programs=("uname",))
    ws = two(a, b)
    await ws.shell("cd /tmp/only && echo x | uname -s")
    assert (a.ran, b.ran) == ([], ["uname -s"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_new_download_lands_in_the_shared_folder_its_machine_holds():
    a = FakeFiles(programs=CLIENTS)
    b = FakeFiles({"/tmp/only/k": b"k"}, programs=CLIENTS)
    ws = two(a, b)
    await ws.shell(f"cd /tmp/only && wget -q -T 2 {REQUEST}")
    await ws.shell(f"cd /tmp/only && curl -s -o new.txt {REQUEST}")
    await ws.shell(f"cd /tmp/only && curl -s -o /tmp/new.txt {REQUEST}")
    assert a.ran == []
    assert b.ran == [
        f"wget -q -T 2 {REQUEST}",
        f"curl -s -o new.txt {REQUEST}",
    ]
    await ws.close()


def lost_on(path: str, files: FakeFiles):
    """An answer finding no program on ``path``, else ``files``'s.

    Args:
        path (str): the PATH a probe finds nothing on.
        files (FakeFiles): the machine's files.
    """

    def answer(line, data):
        if "command -v" in line and f"PATH={path} " in line:
            return failed(b"")
        return files.answer(line, data)

    return answer


@pytest.mark.asyncio
async def test_a_fact_is_left_to_mirage_where_the_run_s_path_finds_nothing():
    a = FakeFiles(programs=("uname",))
    b = FakeFiles(programs=("uname",))
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", lost_on("/empty", a)),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    assert await out(ws, "PATH=/empty uname -s") == "Linux\n"
    await ws.shell("uname -s")
    assert (a.ran, b.ran) == (["uname -s"], [])
    await ws.close()


@pytest.mark.parametrize(
    ("word", "local"),
    [
        ("localhost", True),
        ("localhost:8000/health", True),
        ("http://LOCALHOST/", True),
        ("https://127.0.0.1:8443/a?b=1", True),
        ("http://[::1]:80/", True),
        ("user@localhost:8000", True),
        ("http://localhost.example.com/", False),
        ("http://localhost@example.com/", False),
        ("localhosts", False),
        ("Host: localhost", False),
        ("example.com", False),
    ],
)
def test_a_word_addressing_its_own_machine_is_told_apart(word, local):
    assert bool(LOCALHOST_WORD.fullmatch(word)) is local
