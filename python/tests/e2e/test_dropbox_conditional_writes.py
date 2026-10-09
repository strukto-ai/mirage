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

from collections.abc import AsyncIterator, Callable, Iterator

import pytest
import pytest_asyncio

from mirage import Mount, MountMode, Workspace, WritePolicy
from mirage.vfs.registry import build_vfs
from tests.fixtures.dropbox_api import FakeDropbox, serve

STALE = "changed since it was read; read it again before writing"
SEED = {"f": b"one\n", "g": b"gee\n", "d/a": b"a\n", "d/b": b"b\n"}
CONFIG = {"client_id": "i", "client_secret": "s", "refresh_token": "r"}


@pytest.fixture
def dropbox() -> Iterator[FakeDropbox]:
    with serve(FakeDropbox(files=dict(SEED))) as fake:
        yield fake


@pytest_asyncio.fixture
async def workspace(
    dropbox: FakeDropbox,
) -> AsyncIterator[Callable[..., Workspace]]:
    built: list[Workspace] = []

    def make(write: WritePolicy = WritePolicy.CONDITIONAL) -> Workspace:
        vfs = build_vfs("dropbox", {**CONFIG, "endpoint": dropbox.url})
        ws = Workspace({"/dbx": Mount(vfs, mode=MountMode.WRITE, write=write)})
        built.append(ws)
        return ws

    yield make
    for ws in built:
        await ws.close()


async def _run(ws: Workspace, line: str) -> tuple[int, str, str]:
    r = await ws.shell(line)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


def _refusal(verb: str) -> str:
    if verb == "cp":
        return f"cp: cannot create regular file '/dbx/g': {STALE}\n"
    return f"mv: cannot move '/dbx/f' to '/dbx/g': '/dbx/g' {STALE}\n"


@pytest.mark.asyncio
async def test_a_changed_file_is_refused_before_any_upload(dropbox, workspace):
    ws = workspace()
    await _run(ws, "cat /dbx/f")
    dropbox.write("f", b"theirs\n")
    uploads = dropbox.count("upload")
    code, _, err = await _run(ws, "echo mine > /dbx/f")
    assert (code, err) == (1, f"/dbx/f: {STALE}\n")
    assert dropbox.count("upload") == uploads
    assert dropbox.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_a_write_landing_after_the_lookup_is_refused_by_dropbox(
    dropbox, workspace
):
    ws = workspace()
    await _run(ws, "cat /dbx/f")
    dropbox.hooks["upload"] = lambda: dropbox.write("f", b"theirs\n")
    code, _, err = await _run(ws, "echo mine > /dbx/f")
    assert (code, err) == (1, f"/dbx/f: {STALE}\n")
    assert dropbox.read("f") == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["echo x >> /dbx/f", "truncate -s 2 /dbx/f"],
    ids=["append", "truncate"],
)
async def test_a_rewrite_carries_its_own_reads_version(
    dropbox, workspace, line
):
    ws = workspace()
    dropbox.hooks["upload"] = lambda: dropbox.write("f", b"theirs\n")
    code, _, err = await _run(ws, line)
    assert code == 1 and STALE in err
    assert dropbox.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_of_a_changed_file_is_refused_and_keeps_it(
    dropbox, workspace
):
    ws = workspace()
    await _run(ws, "cat /dbx/f")
    dropbox.write("f", b"theirs\n")
    code, _, err = await _run(ws, "rm /dbx/f")
    assert (code, err) == (1, f"rm: cannot remove '/dbx/f': {STALE}\n")
    assert dropbox.count("delete") == 0
    assert dropbox.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_of_an_unread_file_is_pinned_to_its_lookup(
    dropbox, workspace
):
    ws = workspace()
    dropbox.hooks["delete"] = lambda: dropbox.write("f", b"theirs\n")
    code, _, err = await _run(ws, "rm /dbx/f")
    assert (code, err) == (1, f"rm: cannot remove '/dbx/f': {STALE}\n")
    assert dropbox.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_r_of_an_unchanged_folder_removes_it(dropbox, workspace):
    dropbox.write("d/s/x", b"x\n")
    ws = workspace()
    assert await _run(ws, "rm -r /dbx/d; ls /dbx") == (0, "f\ng\n", "")


@pytest.mark.asyncio
async def test_cp_onto_a_changed_destination_is_refused(dropbox, workspace):
    ws = workspace()
    await _run(ws, "cat /dbx/g")
    dropbox.write("g", b"theirs\n")
    assert await _run(ws, "cp /dbx/f /dbx/g") == (1, "", _refusal("cp"))
    assert (dropbox.read("f"), dropbox.read("g")) == (b"one\n", b"theirs\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, route", [("mv", "move"), ("cp", "copy")])
async def test_a_destination_recreated_after_its_clear_stays_refused(
    dropbox, workspace, verb, route
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")

    def take_name_after_the_clear() -> None:
        dropbox.hooks[route] = lambda: dropbox.write("g", b"new\n")

    dropbox.hooks["delete"] = take_name_after_the_clear
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (1, "", _refusal(verb))
    assert dropbox.count("delete") == 1
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (1, "", _refusal(verb))
    assert dropbox.count("delete") == 1
    assert dropbox.read("g") == b"new\n"
    assert await _run(ws, "echo x > /dbx/f") == (0, "", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, route", [("mv", "move"), ("cp", "copy")])
async def test_a_vanished_source_costs_a_read_destination_nothing(
    dropbox, workspace, verb, route
):
    ws = workspace()
    await _run(ws, "ls /dbx; cat /dbx/g")
    dropbox.delete("f")
    code, _, err = await _run(ws, f"{verb} /dbx/f /dbx/g")
    assert code == 1 and "No such file or directory" in err
    assert dropbox.count(route) == 1
    assert dropbox.count("delete") == 0
    assert dropbox.read("g") == b"gee\n"


@pytest.mark.asyncio
async def test_a_held_write_costs_one_lookup_more_than_a_plain_one(
    dropbox, workspace
):
    counts = []
    for policy in (WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL):
        ws = workspace(policy)
        await _run(ws, "cat /dbx/f")
        before = len(dropbox.log)
        await _run(ws, "echo mine > /dbx/f")
        counts.append(
            [name for name, _ in dropbox.log[before:] if name != "token"]
        )
        dropbox.write("f", SEED["f"])
    plain = ["upload", "upload"]
    assert counts == [plain, ["get_metadata", "upload"] * 2]


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_gone_since_its_read_is_refused_once(
    dropbox, workspace, verb
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")
    dropbox.delete("g")
    code, _, err = await _run(ws, f"{verb} /dbx/f /dbx/g")
    assert (code, err) == (1, _refusal(verb))
    assert (dropbox.read("f"), dropbox.read("g")) == (b"one\n", None)
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (0, "", "")
    assert dropbox.read("g") == b"one\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_copy_onto_a_read_file_lets_the_lines_next_write_through(
    dropbox, workspace, verb
):
    ws = workspace()
    line = f"cat /dbx/g > /dev/null; {verb} /dbx/f /dbx/g; echo x > /dbx/g"
    assert await _run(ws, line) == (0, "", "")
    assert dropbox.read("g") == b"x\n"


@pytest.mark.asyncio
async def test_rm_r_stopped_partway_keeps_the_changed_files_version(
    dropbox, workspace
):
    for key in ("d/a", "d/b"):
        dropbox.delete(key)
    dropbox.write("d/s/x", b"x\n")
    dropbox.write("d/t/y", b"y\n")
    ws = workspace()
    await _run(ws, "cat /dbx/d/s/x")
    dropbox.write("d/s/x", b"theirs\n")
    dropbox.hooks["delete"] = lambda: dropbox.write("d/t/late", b"late\n")
    code, _, err = await _run(ws, "rm -r /dbx/d")
    assert code == 1 and "Directory not empty" in err
    code, _, err = await _run(ws, "echo z > /dbx/d/s/x")
    assert (code, err) == (1, f"/dbx/d/s/x: {STALE}\n")
    assert dropbox.read("d/s/x") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_r_keeps_a_file_changed_during_the_walk(dropbox, workspace):
    ws = workspace()
    dropbox.hooks["delete"] = lambda: dropbox.write("d/b", b"theirs\n")
    code, _, err = await _run(ws, "rm -r /dbx/d")
    assert (code, err) == (1, f"rm: cannot remove '/dbx/d/b': {STALE}\n")
    assert (dropbox.read("d/a"), dropbox.read("d/b")) == (None, b"theirs\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_changed_during_its_clear_is_refused(
    dropbox, workspace, verb
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")
    dropbox.hooks["delete"] = lambda: dropbox.write("g", b"theirs\n")
    code, _, err = await _run(ws, f"{verb} /dbx/f /dbx/g")
    assert (code, err) == (1, _refusal(verb))
    assert (dropbox.read("f"), dropbox.read("g")) == (b"one\n", b"theirs\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, key",
    [
        ("mv /dbx/g /dbx/h", "g"),
        ("mv /dbx/d /dbx/e", "d/a"),
    ],
    ids=["mv away", "mv of an ancestor"],
)
async def test_a_move_lifts_a_kept_version(dropbox, workspace, line, key):
    ws = workspace()
    await _run(ws, f"cat /dbx/{key}")
    dropbox.write(key, b"theirs\n")
    line = f"echo x > /dbx/{key}; {line}; echo new > /dbx/{key}"
    assert await _run(ws, line) == (0, "", f"/dbx/{key}: {STALE}\n")
    assert dropbox.read(key) == b"new\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "policy",
    [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL],
    ids=["unconditional", "conditional"],
)
async def test_an_empty_resize_reads_nothing(dropbox, workspace, policy):
    ws = workspace(policy)
    assert await _run(ws, "truncate -s 0 /dbx/f") == (0, "", "")
    assert dropbox.count("download") == 0
    assert dropbox.read("f") == b""


@pytest.mark.asyncio
async def test_a_read_through_an_outdated_listing_holds_its_own_bytes(
    dropbox, workspace
):
    ws = workspace()
    await _run(ws, "ls /dbx")
    dropbox.write("f", b"B\n")
    assert await _run(ws, "cat /dbx/f") == (0, "B\n", "")
    dropbox.write("f", b"C\n")
    code, _, err = await _run(ws, "echo mine > /dbx/f")
    assert (code, err) == (1, f"/dbx/f: {STALE}\n")
    assert dropbox.read("f") == b"C\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, route", [("cp", "copy"), ("mv", "move")])
async def test_a_destination_a_folder_took_is_refused_with_no_delete(
    dropbox, workspace, verb, route
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")

    def fold() -> None:
        dropbox.delete("g")
        dropbox.write("g/x", b"x\n")

    dropbox.hooks[route] = fold
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (1, "", _refusal(verb))
    assert dropbox.count("delete") == 0
    assert (dropbox.read("f"), dropbox.read("g/x")) == (b"one\n", b"x\n")
    dropbox.delete("g")
    assert await _run(ws, "echo y > /dbx/g") == (0, "", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_source_gone_before_the_retry_is_named(
    dropbox, workspace, verb
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")
    dropbox.hooks["delete"] = lambda: dropbox.delete("f")
    missing = {
        "cp": "cp: cannot create regular file '/dbx/g'",
        "mv": "mv: cannot move '/dbx/f' to '/dbx/g'",
    }[verb]
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (
        1,
        "",
        f"{missing}: No such file or directory\n",
    )
    assert dropbox.count("delete") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, route", [("cp", "copy"), ("mv", "move")])
async def test_an_unread_destination_retaken_after_its_clear_is_refused_once(
    dropbox, workspace, verb, route
):
    ws = workspace()

    def take_name_after_the_clear() -> None:
        dropbox.hooks[route] = lambda: dropbox.write("g", b"new\n")

    dropbox.hooks["delete"] = take_name_after_the_clear
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (1, "", _refusal(verb))
    assert dropbox.read("g") == b"new\n"
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (0, "", "")
    assert dropbox.read("g") == b"one\n"


@pytest.mark.asyncio
async def test_rm_r_names_the_first_changed_file_and_keeps_both(
    dropbox, workspace
):
    ws = workspace()
    await _run(ws, "cat /dbx/d/a /dbx/d/b")
    dropbox.write("d/a", b"theirs\n")
    dropbox.write("d/b", b"theirs\n")
    code, _, err = await _run(ws, "rm -r /dbx/d")
    assert (code, err) == (1, f"rm: cannot remove '/dbx/d/a': {STALE}\n")
    code, _, err = await _run(ws, "echo x > /dbx/d/b")
    assert (code, err) == (1, f"/dbx/d/b: {STALE}\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, route", [("cp", "copy"), ("mv", "move")])
async def test_a_destination_a_folder_retook_after_its_clear_keeps_no_version(
    dropbox, workspace, verb, route
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")

    def fold_after_the_clear() -> None:
        dropbox.hooks[route] = lambda: dropbox.write("g/x", b"x\n")

    dropbox.hooks["delete"] = fold_after_the_clear
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (1, "", _refusal(verb))
    dropbox.delete("g")
    assert await _run(ws, "echo y > /dbx/g") == (0, "", "")
