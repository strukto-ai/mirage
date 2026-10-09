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
from tests.fixtures.box_api import FakeBox, serve

STALE = "changed since it was read; read it again before writing"
SEED = {"f": b"one\n", "g": b"gee\n", "d/a": b"a\n", "d/b": b"b\n"}


@pytest.fixture
def box() -> Iterator[FakeBox]:
    with serve(FakeBox(files=dict(SEED))) as fake:
        yield fake


@pytest_asyncio.fixture
async def workspace(
    box: FakeBox,
) -> AsyncIterator[Callable[..., Workspace]]:
    built: list[Workspace] = []

    def make(write: WritePolicy = WritePolicy.CONDITIONAL) -> Workspace:
        vfs = build_vfs("box", {"access_token": "t", "endpoint": box.url})
        ws = Workspace({"/box": Mount(vfs, mode=MountMode.WRITE, write=write)})
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
        return f"cp: cannot create regular file '/box/g': {STALE}\n"
    return f"mv: cannot move '/box/f' to '/box/g': '/box/g' {STALE}\n"


@pytest.mark.asyncio
async def test_a_changed_file_is_refused_before_any_upload(box, workspace):
    ws = workspace()
    await _run(ws, "cat /box/f")
    box.write("f", b"theirs\n")
    uploads = box.count("upload")
    code, _, err = await _run(ws, "echo mine > /box/f")
    assert (code, err) == (1, f"/box/f: {STALE}\n")
    assert box.count("upload") == uploads
    assert box.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_a_write_landing_after_the_lookup_is_refused_by_box(
    box, workspace
):
    ws = workspace()
    await _run(ws, "cat /box/f")
    box.hooks["upload"] = lambda: box.write("f", b"theirs\n")
    code, _, err = await _run(ws, "echo mine > /box/f")
    assert (code, err) == (1, f"/box/f: {STALE}\n")
    assert box.read("f") == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["echo x >> /box/f", "truncate -s 2 /box/f"],
    ids=["append", "truncate"],
)
async def test_a_rewrite_carries_its_own_reads_version(box, workspace, line):
    ws = workspace()
    box.hooks["upload"] = lambda: box.write("f", b"theirs\n")
    code, _, err = await _run(ws, line)
    assert code == 1 and STALE in err
    assert box.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_of_a_changed_file_is_refused_and_keeps_it(box, workspace):
    ws = workspace()
    await _run(ws, "cat /box/f")
    box.write("f", b"theirs\n")
    code, _, err = await _run(ws, "rm /box/f")
    assert (code, err) == (1, f"rm: cannot remove '/box/f': {STALE}\n")
    assert box.count("delete") == 0
    assert box.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_of_an_unread_file_is_pinned_to_its_lookup(box, workspace):
    ws = workspace()
    box.hooks["delete"] = lambda: box.write("f", b"theirs\n")
    code, _, err = await _run(ws, "rm /box/f")
    assert (code, err) == (1, f"rm: cannot remove '/box/f': {STALE}\n")
    assert box.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_r_of_an_unchanged_folder_removes_it(box, workspace):
    box.create("d/s/x", b"x\n")
    ws = workspace()
    assert await _run(ws, "rm -r /box/d; ls /box") == (0, "f\ng\n", "")


@pytest.mark.asyncio
async def test_cp_onto_a_changed_destination_is_refused(box, workspace):
    ws = workspace()
    await _run(ws, "cat /box/g")
    box.write("g", b"theirs\n")
    code, _, err = await _run(ws, "cp /box/f /box/g")
    assert (code, err) == (1, _refusal("cp"))
    assert box.read("g") == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("verb, route", [("mv", "update"), ("cp", "copy")])
async def test_a_destination_recreated_after_its_clear_stays_refused(
    box, workspace, verb, route
):
    ws = workspace()
    await _run(ws, "cat /box/g")
    box.hooks[route] = lambda: box.create("g", b"new\n")
    code, _, err = await _run(ws, f"{verb} /box/f /box/g")
    assert (code, err) == (1, _refusal(verb))
    assert box.count("delete") == 1
    code, _, err = await _run(ws, f"{verb} /box/f /box/g")
    assert (code, err) == (1, _refusal(verb))
    assert box.count("delete") == 1
    assert box.read("g") == b"new\n"
    assert await _run(ws, "echo x > /box/f") == (0, "", "")


@pytest.mark.asyncio
async def test_a_conditional_write_sends_as_many_requests_as_a_plain_one(
    box, workspace
):
    counts = []
    for policy in (WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL):
        ws = workspace(policy)
        await _run(ws, "cat /box/f")
        before = len(box.log)
        await _run(ws, "echo mine > /box/f")
        counts.append(len(box.log) - before)
        box.write("f", SEED["f"])
    assert counts[0] == counts[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_gone_since_its_read_is_refused_once(
    box, workspace, verb
):
    ws = workspace()
    await _run(ws, "cat /box/g")
    box.delete("g", "purge")
    code, _, err = await _run(ws, f"{verb} /box/f /box/g")
    assert (code, err) == (1, _refusal(verb))
    assert (box.read("f"), box.read("g")) == (b"one\n", None)
    assert await _run(ws, f"{verb} /box/f /box/g") == (0, "", "")
    assert box.read("g") == b"one\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_copy_onto_a_read_file_lets_the_lines_next_write_through(
    box, workspace, verb
):
    ws = workspace()
    line = f"cat /box/g > /dev/null; {verb} /box/f /box/g; echo x > /box/g"
    assert await _run(ws, line) == (0, "", "")
    assert box.read("g") == b"x\n"


@pytest.mark.asyncio
async def test_rm_r_lets_the_lines_next_write_through(box, workspace):
    ws = workspace()
    line = (
        "cat /box/d/a >/dev/null; rm -r /box/d; mkdir /box/d; "
        "echo x > /box/d/a"
    )
    assert await _run(ws, line) == (0, "", "")
    assert box.read("d/a") == b"x\n"


@pytest.mark.asyncio
async def test_a_folder_merge_lets_the_next_write_through(box, workspace):
    box.create("e/d/a", b"old\n")
    ws = workspace()
    line = (
        "cat /box/e/d/a >/dev/null; cp -r /box/d /box/e; echo y > /box/e/d/a"
    )
    assert await _run(ws, line) == (0, "", "")
    assert await _run(ws, "echo z > /box/e/d/a") == (0, "", "")
    assert box.read("e/d/a") == b"z\n"


@pytest.mark.asyncio
async def test_rm_r_removes_a_folder_holding_a_web_link(box, workspace):
    box.create_link("d/bookmark")
    ws = workspace()
    assert await _run(ws, "rm -r /box/d; ls /box") == (0, "f\ng\n", "")


@pytest.mark.asyncio
async def test_rm_r_stopped_partway_keeps_the_changed_files_version(
    box, workspace
):
    for key in ("d/a", "d/b"):
        box.delete(key, "purge")
    box.create("d/s/x", b"x\n")
    box.create("d/t/y", b"y\n")
    ws = workspace()
    await _run(ws, "cat /box/d/s/x")
    box.write("d/s/x", b"theirs\n")
    box.hooks["delete"] = lambda: box.create("d/t/late", b"late\n")
    code, _, err = await _run(ws, "rm -r /box/d")
    assert code == 1 and "Directory not empty" in err
    code, _, err = await _run(ws, "echo z > /box/d/s/x")
    assert (code, err) == (1, f"/box/d/s/x: {STALE}\n")
    assert box.read("d/s/x") == b"theirs\n"


@pytest.mark.asyncio
async def test_resizing_holds_the_bytes_it_downloaded(box, workspace):
    ws = workspace()
    await _run(ws, "cat /box/f")
    box.hooks["content"] = lambda: box.write("f", b"theirs\n")
    assert await _run(ws, "truncate -s 3 /box/f") == (0, "", "")
    assert box.read("f") == b"the"


@pytest.mark.asyncio
async def test_rm_r_keeps_a_file_changed_during_the_walk(box, workspace):
    ws = workspace()
    box.hooks["delete"] = lambda: box.write("d/b", b"theirs\n")
    code, _, err = await _run(ws, "rm -r /box/d")
    assert (code, err) == (1, f"rm: cannot remove '/box/d/b': {STALE}\n")
    assert (box.read("d/a"), box.read("d/b")) == (None, b"theirs\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_changed_during_its_clear_is_refused(
    box, workspace, verb
):
    ws = workspace()
    await _run(ws, "cat /box/g")
    box.hooks["delete"] = lambda: box.write("g", b"theirs\n")
    code, _, err = await _run(ws, f"{verb} /box/f /box/g")
    assert (code, err) == (1, _refusal(verb))
    assert (box.read("f"), box.read("g")) == (b"one\n", b"theirs\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, key",
    [
        ("mv /box/g /box/h", "g"),
        ("mv /box/d /box/e; mkdir /box/d", "d/a"),
    ],
    ids=["mv away", "mv of an ancestor"],
)
async def test_a_move_lifts_a_kept_version(box, workspace, line, key):
    ws = workspace()
    await _run(ws, f"cat /box/{key}")
    box.write(key, b"theirs\n")
    line = f"echo x > /box/{key}; {line}; echo new > /box/{key}"
    assert await _run(ws, line) == (0, "", f"/box/{key}: {STALE}\n")
    assert box.read(key) == b"new\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "policy, downloads",
    [(WritePolicy.UNCONDITIONAL, 1), (WritePolicy.CONDITIONAL, 0)],
    ids=["unconditional", "conditional"],
)
async def test_an_empty_resize_reads_only_where_writes_go_plain(
    box, workspace, policy, downloads
):
    ws = workspace(policy)
    assert await _run(ws, "truncate -s 0 /box/f") == (0, "", "")
    assert box.count("content") == downloads
    assert box.read("f") == b""


@pytest.mark.asyncio
async def test_rm_r_skips_a_web_link_already_gone(box, workspace):
    box.create_link("d/bookmark")
    box.hooks["delete"] = lambda: box.delete("d/bookmark", "purge")
    ws = workspace()
    assert await _run(ws, "rm -r /box/d; ls /box") == (0, "f\ng\n", "")


@pytest.mark.asyncio
async def test_rm_r_reports_a_web_link_it_may_not_delete(box, workspace):
    link = box.create_link("d/bookmark")
    box.forbidden.add(link)
    ws = workspace()
    denied = (
        f"{box.url}/2.0/web_links/{link} -> 403 " + '{"code": "forbidden"}'
    )
    assert await _run(ws, "rm -r /box/d") == (
        1,
        "",
        f"rm: Box DELETE {denied}\n",
    )
    assert await _run(ws, "ls /box") == (0, "d\nf\ng\n", "")


@pytest.mark.asyncio
async def test_rm_r_names_the_first_changed_file_and_keeps_both(
    box, workspace
):
    ws = workspace()
    await _run(ws, "cat /box/d/a /box/d/b")
    box.write("d/a", b"theirs\n")
    box.write("d/b", b"theirs\n")
    code, _, err = await _run(ws, "rm -r /box/d")
    assert (code, err) == (1, f"rm: cannot remove '/box/d/a': {STALE}\n")
    code, _, err = await _run(ws, "echo x > /box/d/b")
    assert (code, err) == (1, f"/box/d/b: {STALE}\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("taker", ["folder", "web link"])
@pytest.mark.parametrize("verb, route", [("cp", "copy"), ("mv", "update")])
async def test_a_destination_a_non_file_retook_after_its_clear_keeps_no_version(
    box, workspace, verb, route, taker
):
    ws = workspace()
    await _run(ws, "cat /box/g")

    def take() -> None:
        if taker == "folder":
            box.create("g/x", b"x\n")
        else:
            box.create_link("g")

    def fold_after_the_clear() -> None:
        box.hooks[route] = take

    box.hooks["delete"] = fold_after_the_clear
    assert await _run(ws, f"{verb} /box/f /box/g") == (1, "", _refusal(verb))
    box.delete("g", "purge")
    assert await _run(ws, "echo y > /box/g") == (0, "", "")


@pytest.mark.asyncio
async def test_resizing_a_file_box_keeps_no_sha1_for_goes_out_plain(
    box, workspace
):
    box.unhashed.add(box.id_of("f"))
    ws = workspace()
    assert await _run(ws, "truncate -s 2 /box/f") == (0, "", "")
    assert box.read("f") == b"on"


def _fail() -> None:
    raise RuntimeError("injected server error")


@pytest.mark.asyncio
@pytest.mark.parametrize("same_line", [True, False], ids=["line", "next line"])
async def test_a_cp_that_changed_nothing_keeps_the_held_version(
    box, workspace, same_line
):
    ws = workspace()

    def theirs_then_fail() -> None:
        box.write("g", b"theirs\n")
        _fail()

    box.hooks["delete"] = theirs_then_fail
    if same_line:
        code, _, err = await _run(
            ws, "cat /box/g >/dev/null; cp /box/f /box/g; echo mine > /box/g"
        )
    else:
        await _run(ws, "cat /box/g")
        await _run(ws, "cp /box/f /box/g")
        code, _, err = await _run(ws, "echo mine > /box/g")
    assert code == 1 and err.endswith(f"/box/g: {STALE}\n")
    assert box.read("g") == b"theirs\n"


@pytest.mark.asyncio
async def test_a_folder_merge_keeps_the_versions_of_files_it_left(
    box, workspace
):
    box.create("e/d/a", b"new\n")
    ws = workspace()
    await _run(ws, "cat /box/d/b")
    assert await _run(ws, "cp -r /box/e/d /box") == (0, "", "")
    box.write("d/b", b"theirs\n")
    code, _, err = await _run(ws, "echo mine > /box/d/b")
    assert (code, err) == (1, f"/box/d/b: {STALE}\n")
    assert box.read("d/b") == b"theirs\n"


@pytest.mark.asyncio
async def test_a_cp_whose_delete_landed_but_failed_serves_no_stale_bytes(
    box, workspace
):
    ws = workspace()
    await _run(ws, "cat /box/g")

    def gone_then_fail() -> None:
        box.delete("g", "purge")
        _fail()

    box.hooks["delete"] = gone_then_fail
    code, _, _ = await _run(ws, "cp /box/f /box/g")
    assert code == 1
    code, out, _ = await _run(ws, "cat /box/g")
    assert (code, out) == (1, "")
