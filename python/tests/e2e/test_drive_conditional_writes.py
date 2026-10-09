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
from dataclasses import dataclass

import pytest
import pytest_asyncio

from mirage import Mount, MountMode, Workspace, WritePolicy
from mirage.errors.types import StaleWriteError
from mirage.vfs.registry import build_vfs
from tests.fixtures.box_api import FakeBox
from tests.fixtures.box_api import serve as serve_box
from tests.fixtures.dropbox_api import FakeDropbox
from tests.fixtures.dropbox_api import serve as serve_dropbox

STALE = "changed since it was read; read it again before writing"
SEED = {"f": b"one\n", "g": b"gee\n", "d/a": b"a\n", "d/b": b"b\n"}
DROPBOX_CONFIG = {"client_id": "i", "client_secret": "s", "refresh_token": "r"}
BOX = pytest.mark.parametrize("drive", ["box"], indirect=True)
DROPBOX = pytest.mark.parametrize("drive", ["dropbox"], indirect=True)


@dataclass
class Drive:
    fake: FakeBox | FakeDropbox
    root: str
    config: dict[str, str]
    move: str
    download: str

    @property
    def box(self) -> FakeBox:
        assert isinstance(self.fake, FakeBox)
        return self.fake

    @property
    def dropbox(self) -> FakeDropbox:
        assert isinstance(self.fake, FakeDropbox)
        return self.fake

    def put(self, key: str, data: bytes) -> None:
        if isinstance(self.fake, FakeBox) and self.fake.read(key) is None:
            self.fake.create(key, data)
        else:
            self.fake.write(key, data)

    def drop(self, key: str) -> None:
        if isinstance(self.fake, FakeBox):
            self.fake.delete(key, "purge")
        else:
            self.fake.delete(key)


@pytest.fixture(params=["box", "dropbox"])
def drive(request: pytest.FixtureRequest) -> Iterator[Drive]:
    if request.param == "box":
        with serve_box(FakeBox(files=dict(SEED))) as box:
            config = {"access_token": "t", "endpoint": box.url}
            yield Drive(box, "/box", config, "update", "content")
    else:
        with serve_dropbox(FakeDropbox(files=dict(SEED))) as dbx:
            config = {**DROPBOX_CONFIG, "endpoint": dbx.url}
            yield Drive(dbx, "/dbx", config, "move", "download")


@pytest_asyncio.fixture
async def workspace(drive: Drive) -> AsyncIterator[Callable[..., Workspace]]:
    built: list[Workspace] = []

    def make(write: WritePolicy = WritePolicy.CONDITIONAL) -> Workspace:
        name = "box" if isinstance(drive.fake, FakeBox) else "dropbox"
        vfs = build_vfs(name, drive.config)
        ws = Workspace(
            {drive.root: Mount(vfs, mode=MountMode.WRITE, write=write)}
        )
        built.append(ws)
        return ws

    yield make
    for ws in built:
        await ws.close()


async def _run(ws: Workspace, line: str) -> tuple[int, str, str]:
    r = await ws.shell(line)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


def _refusal(drive: Drive, verb: str) -> str:
    r = drive.root
    if verb == "cp":
        return f"cp: cannot create regular file '{r}/g': {STALE}\n"
    return f"mv: cannot move '{r}/f' to '{r}/g': '{r}/g' {STALE}\n"


def _fail() -> None:
    raise RuntimeError("injected server error")


@pytest.mark.asyncio
async def test_a_changed_file_is_refused_before_any_upload(drive, workspace):
    ws = workspace()
    await _run(ws, f"cat {drive.root}/f")
    drive.put("f", b"theirs\n")
    uploads = drive.fake.count("upload")
    code, _, err = await _run(ws, f"echo mine > {drive.root}/f")
    assert (code, err) == (1, f"{drive.root}/f: {STALE}\n")
    assert drive.fake.count("upload") == uploads
    assert drive.fake.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_a_write_landing_after_the_lookup_is_refused(drive, workspace):
    ws = workspace()
    await _run(ws, f"cat {drive.root}/f")
    drive.fake.hooks["upload"] = lambda: drive.put("f", b"theirs\n")
    code, _, err = await _run(ws, f"echo mine > {drive.root}/f")
    assert (code, err) == (1, f"{drive.root}/f: {STALE}\n")
    assert drive.fake.read("f") == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["echo x >> {r}/f", "truncate -s 2 {r}/f"],
    ids=["append", "resize"],
)
async def test_a_rewrite_carries_its_own_reads_version(drive, workspace, line):
    ws = workspace()
    drive.fake.hooks["upload"] = lambda: drive.put("f", b"theirs\n")
    code, _, err = await _run(ws, line.format(r=drive.root))
    assert code == 1 and STALE in err
    assert drive.fake.read("f") == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "policy",
    [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL],
    ids=["unconditional", "conditional"],
)
async def test_an_empty_resize_reads_nothing(drive, workspace, policy):
    ws = workspace(policy)
    assert await _run(ws, f"truncate -s 0 {drive.root}/f") == (0, "", "")
    assert drive.fake.count(drive.download) == 0
    assert drive.fake.read("f") == b""


@pytest.mark.asyncio
async def test_a_streamed_ops_read_through_an_outdated_listing_holds_its_bytes(
    drive, workspace
):
    ws = workspace()
    await ws.vfs.readdir(drive.root)
    drive.put("f", b"B\n")
    stream = await ws.vfs.read_stream(f"{drive.root}/f")
    assert b"".join([chunk async for chunk in stream]) == b"B\n"
    drive.put("f", b"C\n")
    with pytest.raises(StaleWriteError):
        await ws.vfs.write(f"{drive.root}/f", b"mine\n")
    assert drive.fake.read("f") == b"C\n"


@pytest.mark.asyncio
async def test_rm_of_an_unread_file_is_pinned_to_its_lookup(drive, workspace):
    ws = workspace()
    drive.fake.hooks["delete"] = lambda: drive.put("f", b"theirs\n")
    code, _, err = await _run(ws, f"rm {drive.root}/f")
    assert (code, err) == (1, f"rm: cannot remove '{drive.root}/f': {STALE}\n")
    assert drive.fake.read("f") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_r_of_an_unchanged_folder_removes_it(drive, workspace):
    drive.put("d/s/x", b"x\n")
    ws = workspace()
    r = drive.root
    assert await _run(ws, f"rm -r {r}/d; ls {r}") == (0, "f\ng\n", "")


@pytest.mark.asyncio
async def test_rm_r_lets_the_lines_next_write_through(drive, workspace):
    ws = workspace()
    r = drive.root
    mkdir = f" mkdir {r}/d;" if isinstance(drive.fake, FakeBox) else ""
    line = f"cat {r}/d/a > /dev/null; rm -r {r}/d;{mkdir} echo x > {r}/d/a"
    assert await _run(ws, line) == (0, "", "")
    assert drive.fake.read("d/a") == b"x\n"


@pytest.mark.asyncio
async def test_rm_r_keeps_a_file_changed_during_the_walk(drive, workspace):
    ws = workspace()
    drive.fake.hooks["delete"] = lambda: drive.put("d/b", b"theirs\n")
    code, _, err = await _run(ws, f"rm -r {drive.root}/d")
    assert (code, err) == (
        1,
        f"rm: cannot remove '{drive.root}/d/b': {STALE}\n",
    )
    assert (drive.fake.read("d/a"), drive.fake.read("d/b")) == (
        None,
        b"theirs\n",
    )


@pytest.mark.asyncio
async def test_rm_r_names_the_first_changed_file_and_keeps_both(
    drive, workspace
):
    ws = workspace()
    r = drive.root
    await _run(ws, f"cat {r}/d/a {r}/d/b")
    drive.put("d/a", b"theirs\n")
    drive.put("d/b", b"theirs\n")
    code, _, err = await _run(ws, f"rm -r {r}/d")
    assert (code, err) == (1, f"rm: cannot remove '{r}/d/a': {STALE}\n")
    code, _, err = await _run(ws, f"echo x > {r}/d/b")
    assert (code, err) == (1, f"{r}/d/b: {STALE}\n")


@pytest.mark.asyncio
async def test_rm_r_stopped_partway_keeps_the_changed_files_version(
    drive, workspace
):
    for key in ("d/a", "d/b"):
        drive.drop(key)
    drive.put("d/s/x", b"x\n")
    drive.put("d/t/y", b"y\n")
    ws = workspace()
    r = drive.root
    await _run(ws, f"cat {r}/d/s/x")
    drive.put("d/s/x", b"theirs\n")
    drive.fake.hooks["delete"] = lambda: drive.put("d/t/late", b"late\n")
    code, _, err = await _run(ws, f"rm -r {r}/d")
    assert code == 1 and "Directory not empty" in err
    code, _, err = await _run(ws, f"echo z > {r}/d/s/x")
    assert (code, err) == (1, f"{r}/d/s/x: {STALE}\n")
    assert drive.fake.read("d/s/x") == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("next_line", [False, True], ids=["line", "next line"])
async def test_rm_r_that_failed_keeps_the_versions_it_never_reached(
    drive, workspace, next_line
):
    def theirs_then_fail() -> None:
        drive.put("d/b", b"theirs\n")
        _fail()

    drive.fake.hooks["delete"] = theirs_then_fail
    ws = workspace()
    r = drive.root
    read = f"cat {r}/d/a {r}/d/b > /dev/null"
    if next_line:
        await _run(ws, read)
        line = f"rm -r {r}/d; echo mine > {r}/d/b"
    else:
        line = f"{read}; rm -r {r}/d; echo mine > {r}/d/b"
    code, _, err = await _run(ws, line)
    assert code == 1
    assert err.endswith(f"{r}/d/b: {STALE}\n")
    assert drive.fake.read("d/b") == b"theirs\n"


@pytest.mark.asyncio
async def test_rm_r_serves_nothing_from_a_folder_already_removed(
    drive, workspace
):
    drive.put("d/s/t/x", b"x\n")
    ws = workspace()
    r = drive.root
    await _run(ws, f"ls {r}/d/s/t; cat {r}/d/s/t/x")
    drive.drop("d/s/t")
    assert (await _run(ws, f"rm -r {r}/d"))[0] == 0
    assert (await _run(ws, f"ls {r}/d/s/t"))[0] != 0
    assert (await _run(ws, f"cat {r}/d/s/t/x"))[0] != 0


@pytest.mark.asyncio
async def test_rm_r_whose_folder_delete_failed_serves_no_stale_listing(
    drive, workspace
):
    for key in ("d/a", "d/b"):
        drive.drop(key)
    drive.put("d/s/e/f", b"f\n")
    ws = workspace()
    r = drive.root
    assert await _run(ws, f"ls {r}/d/s") == (0, "e\n", "")

    def gone_then_fail() -> None:
        drive.drop("d/s/e")
        _fail()

    drive.fake.hooks["delete"] = lambda: drive.fake.hooks.__setitem__(
        "delete", gone_then_fail
    )
    assert (await _run(ws, f"rm -r {r}/d"))[0] == 1
    assert await _run(ws, f"ls {r}/d/s") == (0, "", "")


@pytest.mark.asyncio
async def test_rm_r_whose_delete_landed_but_failed_serves_no_stale_bytes(
    drive, workspace
):
    def gone_then_fail() -> None:
        drive.drop("d/a")
        _fail()

    ws = workspace()
    r = drive.root
    await _run(ws, f"ls {r}/d; cat {r}/d/a")
    drive.fake.hooks["delete"] = gone_then_fail
    assert (await _run(ws, f"rm -r {r}/d"))[0] == 1
    assert (await _run(ws, f"cat {r}/d/a"))[0] != 0


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_changed_during_its_clear_is_refused(
    drive, workspace, verb
):
    ws = workspace()
    r = drive.root
    await _run(ws, f"cat {r}/g")
    drive.fake.hooks["delete"] = lambda: drive.put("g", b"theirs\n")
    assert await _run(ws, f"{verb} {r}/f {r}/g") == (
        1,
        "",
        _refusal(drive, verb),
    )
    assert (drive.fake.read("f"), drive.fake.read("g")) == (
        b"one\n",
        b"theirs\n",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_recreated_after_its_clear_stays_refused(
    drive, workspace, verb
):
    ws = workspace()
    r = drive.root
    await _run(ws, f"cat {r}/g")
    route = "copy" if verb == "cp" else drive.move

    def take_name_after_the_clear() -> None:
        drive.fake.hooks[route] = lambda: drive.put("g", b"new\n")

    drive.fake.hooks["delete"] = take_name_after_the_clear
    for _ in range(2):
        assert await _run(ws, f"{verb} {r}/f {r}/g") == (
            1,
            "",
            _refusal(drive, verb),
        )
        assert drive.fake.count("delete") == 1
    assert drive.fake.read("g") == b"new\n"
    assert await _run(ws, f"echo x > {r}/f") == (0, "", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_a_folder_retook_after_its_clear_keeps_no_version(
    drive, workspace, verb
):
    ws = workspace()
    r = drive.root
    await _run(ws, f"cat {r}/g")
    route = "copy" if verb == "cp" else drive.move

    def fold_after_the_clear() -> None:
        drive.fake.hooks[route] = lambda: drive.put("g/x", b"x\n")

    drive.fake.hooks["delete"] = fold_after_the_clear
    assert await _run(ws, f"{verb} {r}/f {r}/g") == (
        1,
        "",
        _refusal(drive, verb),
    )
    drive.drop("g")
    assert await _run(ws, f"echo y > {r}/g") == (0, "", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_destination_gone_since_its_read_is_refused_once(
    drive, workspace, verb
):
    ws = workspace()
    r = drive.root
    await _run(ws, f"cat {r}/g")
    drive.drop("g")
    assert await _run(ws, f"{verb} {r}/f {r}/g") == (
        1,
        "",
        _refusal(drive, verb),
    )
    assert (drive.fake.read("f"), drive.fake.read("g")) == (b"one\n", None)
    assert await _run(ws, f"{verb} {r}/f {r}/g") == (0, "", "")
    assert drive.fake.read("g") == b"one\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_copy_onto_a_read_file_lets_the_lines_next_write_through(
    drive, workspace, verb
):
    ws = workspace()
    r = drive.root
    line = f"cat {r}/g > /dev/null; {verb} {r}/f {r}/g; echo x > {r}/g"
    assert await _run(ws, line) == (0, "", "")
    assert drive.fake.read("g") == b"x\n"


@pytest.mark.asyncio
async def test_a_copy_onto_a_refused_file_lifts_its_refusal(drive, workspace):
    def theirs() -> None:
        drive.put("g", b"theirs\n")
        drive.fake.hooks["upload"] = lambda: drive.put("g", b"gee\n")

    drive.fake.hooks["upload"] = theirs
    ws = workspace()
    r = drive.root
    line = (
        f"cat {r}/g > /dev/null; echo x > {r}/g; echo y > {r}/y; "
        f"cp {r}/f {r}/g && echo mine > {r}/g"
    )
    assert await _run(ws, line) == (0, "", f"{r}/g: {STALE}\n")
    assert drive.fake.read("g") == b"mine\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("ancestor", [False, True], ids=["file", "ancestor"])
async def test_a_move_lifts_a_kept_version(drive, workspace, ancestor):
    ws = workspace()
    r = drive.root
    key, move = "g", f"mv {r}/g {r}/h"
    if ancestor:
        key, move = "d/a", f"mv {r}/d {r}/e"
        if isinstance(drive.fake, FakeBox):
            move += f"; mkdir {r}/d"
    await _run(ws, f"cat {r}/{key}")
    drive.put(key, b"theirs\n")
    line = f"echo x > {r}/{key}; {move}; echo new > {r}/{key}"
    assert await _run(ws, line) == (0, "", f"{r}/{key}: {STALE}\n")
    assert drive.fake.read(key) == b"new\n"


@pytest.mark.asyncio
@BOX
async def test_a_box_write_sends_as_many_requests_as_a_plain_one(
    drive, workspace
):
    counts = []
    for policy in (WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL):
        ws = workspace(policy)
        await _run(ws, "cat /box/f")
        before = len(drive.box.log)
        await _run(ws, "echo mine > /box/f")
        counts.append(len(drive.box.log) - before)
        drive.put("f", SEED["f"])
    assert counts[0] == counts[1]


@pytest.mark.asyncio
@BOX
async def test_a_box_folder_merge_lets_the_next_write_through(
    drive, workspace
):
    drive.put("e/d/a", b"old\n")
    ws = workspace()
    line = (
        "cat /box/e/d/a >/dev/null; cp -r /box/d /box/e; echo y > /box/e/d/a"
    )
    assert await _run(ws, line) == (0, "", "")
    assert await _run(ws, "echo z > /box/e/d/a") == (0, "", "")
    assert drive.fake.read("e/d/a") == b"z\n"


@pytest.mark.asyncio
@BOX
async def test_a_box_folder_merge_keeps_the_versions_of_files_it_left(
    drive, workspace
):
    drive.put("e/d/a", b"new\n")
    ws = workspace()
    await _run(ws, "cat /box/d/b")
    assert await _run(ws, "cp -r /box/e/d /box") == (0, "", "")
    drive.put("d/b", b"theirs\n")
    code, _, err = await _run(ws, "echo mine > /box/d/b")
    assert (code, err) == (1, f"/box/d/b: {STALE}\n")
    assert drive.fake.read("d/b") == b"theirs\n"


@pytest.mark.asyncio
@BOX
async def test_a_box_folder_copied_whole_lifts_the_lost_marks_beneath_it(
    drive, workspace
):
    drive.put("s/a", b"new\n")

    def theirs() -> None:
        drive.put("d/a", b"theirs\n")
        drive.box.hooks["upload"] = lambda: drive.drop("d")

    drive.box.hooks["upload"] = theirs
    ws = workspace()
    line = (
        "cat /box/d/a > /dev/null; echo x > /box/d/a; echo y > /box/y; "
        "cp -r /box/s /box/d && echo mine > /box/d/a"
    )
    assert await _run(ws, line) == (0, "", f"/box/d/a: {STALE}\n")
    assert drive.fake.read("d/a") == b"mine\n"


@pytest.mark.asyncio
@BOX
async def test_a_box_folder_copy_that_failed_keeps_the_versions_beneath_it(
    drive, workspace
):
    drive.put("s/a", b"new\n")
    drive.box.hooks["upload"] = lambda: drive.drop("d")

    def theirs_then_fail() -> None:
        drive.put("d/a", b"theirs\n")
        _fail()

    drive.box.hooks["copy"] = theirs_then_fail
    ws = workspace()
    line = (
        "cat /box/d/a > /dev/null; echo z > /box/z; "
        "cp -r /box/s /box/d; ls /box/d; echo mine > /box/d/a"
    )
    code, out, err = await _run(ws, line)
    assert (code, out) == (1, "a\n")
    assert err.endswith(f"/box/d/a: {STALE}\n")
    assert drive.fake.read("d/a") == b"theirs\n"


@pytest.mark.asyncio
@BOX
@pytest.mark.parametrize("gone", [True, False], ids=["link gone", "link kept"])
async def test_box_rm_r_deletes_a_web_link_plainly(drive, workspace, gone):
    drive.box.create_link("d/bookmark")
    if gone:
        drive.fake.hooks["delete"] = lambda: drive.drop("d/bookmark")
    ws = workspace()
    assert await _run(ws, "rm -r /box/d; ls /box") == (0, "f\ng\n", "")


@pytest.mark.asyncio
@BOX
async def test_box_rm_r_reports_a_web_link_it_may_not_delete(drive, workspace):
    link = drive.box.create_link("d/bookmark")
    drive.box.forbidden.add(link)
    ws = workspace()
    url = f"{drive.box.url}/2.0/web_links/{link}"
    denied = f"rm: Box DELETE {url} -> 403 " + '{"code": "forbidden"}\n'
    assert await _run(ws, "rm -r /box/d") == (1, "", denied)
    assert await _run(ws, "ls /box") == (0, "d\nf\ng\n", "")


@pytest.mark.asyncio
@BOX
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_box_destination_a_web_link_retook_keeps_no_version(
    drive, workspace, verb
):
    ws = workspace()
    await _run(ws, "cat /box/g")
    route = "copy" if verb == "cp" else "update"

    def link_after_the_clear() -> None:
        drive.fake.hooks[route] = lambda: drive.box.create_link("g")

    drive.fake.hooks["delete"] = link_after_the_clear
    assert await _run(ws, f"{verb} /box/f /box/g") == (
        1,
        "",
        _refusal(drive, verb),
    )
    drive.drop("g")
    assert await _run(ws, "echo y > /box/g") == (0, "", "")


@pytest.mark.asyncio
@BOX
async def test_a_box_resize_holds_the_bytes_it_downloaded(drive, workspace):
    ws = workspace()
    await _run(ws, "cat /box/f")
    drive.fake.hooks["content"] = lambda: drive.put("f", b"theirs\n")
    assert await _run(ws, "truncate -s 3 /box/f") == (0, "", "")
    assert drive.fake.read("f") == b"the"


@pytest.mark.asyncio
@BOX
async def test_a_box_resize_of_a_file_with_no_sha1_goes_out_plain(
    drive, workspace
):
    drive.box.unhashed.add(drive.box.id_of("f"))
    ws = workspace()
    assert await _run(ws, "truncate -s 2 /box/f") == (0, "", "")
    assert drive.fake.read("f") == b"on"


@pytest.mark.asyncio
@BOX
@pytest.mark.parametrize("same_line", [True, False], ids=["line", "next line"])
async def test_a_box_cp_that_changed_nothing_keeps_the_held_version(
    drive, workspace, same_line
):
    ws = workspace()

    def theirs_then_fail() -> None:
        drive.put("g", b"theirs\n")
        _fail()

    drive.fake.hooks["delete"] = theirs_then_fail
    if same_line:
        code, _, err = await _run(
            ws, "cat /box/g >/dev/null; cp /box/f /box/g; echo mine > /box/g"
        )
    else:
        await _run(ws, "cat /box/g")
        await _run(ws, "cp /box/f /box/g")
        code, _, err = await _run(ws, "echo mine > /box/g")
    assert code == 1 and err.endswith(f"/box/g: {STALE}\n")
    assert drive.fake.read("g") == b"theirs\n"


@pytest.mark.asyncio
@BOX
async def test_a_box_cp_whose_delete_landed_but_failed_serves_no_stale_bytes(
    drive, workspace
):
    ws = workspace()
    await _run(ws, "cat /box/g")

    def gone_then_fail() -> None:
        drive.drop("g")
        _fail()

    drive.fake.hooks["delete"] = gone_then_fail
    code, _, _ = await _run(ws, "cp /box/f /box/g")
    assert code == 1
    code, out, _ = await _run(ws, "cat /box/g")
    assert (code, out) == (1, "")


@pytest.mark.asyncio
@DROPBOX
async def test_a_dropbox_held_write_costs_one_lookup_more(drive, workspace):
    counts = []
    for policy in (WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL):
        ws = workspace(policy)
        await _run(ws, "cat /dbx/f")
        before = len(drive.dropbox.log)
        await _run(ws, "echo mine > /dbx/f")
        log = drive.dropbox.log[before:]
        counts.append([name for name, _ in log if name != "token"])
        drive.put("f", SEED["f"])
    assert counts == [["upload", "upload"], ["get_metadata", "upload"] * 2]


@pytest.mark.asyncio
@DROPBOX
@pytest.mark.parametrize("verb, route", [("mv", "move"), ("cp", "copy")])
async def test_a_vanished_source_costs_a_dropbox_destination_nothing(
    drive, workspace, verb, route
):
    ws = workspace()
    await _run(ws, "ls /dbx; cat /dbx/g")
    drive.drop("f")
    code, _, err = await _run(ws, f"{verb} /dbx/f /dbx/g")
    assert code == 1 and "No such file or directory" in err
    assert drive.fake.count(route) == 1
    assert drive.fake.count("delete") == 0
    assert drive.fake.read("g") == b"gee\n"


@pytest.mark.asyncio
@DROPBOX
@pytest.mark.parametrize("verb, route", [("cp", "copy"), ("mv", "move")])
async def test_a_dropbox_destination_a_folder_took_is_refused_with_no_delete(
    drive, workspace, verb, route
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")

    def fold() -> None:
        drive.drop("g")
        drive.put("g/x", b"x\n")

    drive.fake.hooks[route] = fold
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (
        1,
        "",
        _refusal(drive, verb),
    )
    assert drive.fake.count("delete") == 0
    assert (drive.fake.read("f"), drive.fake.read("g/x")) == (
        b"one\n",
        b"x\n",
    )
    drive.drop("g")
    assert await _run(ws, "echo y > /dbx/g") == (0, "", "")


@pytest.mark.asyncio
@DROPBOX
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_a_dropbox_source_gone_before_the_retry_is_named(
    drive, workspace, verb
):
    ws = workspace()
    await _run(ws, "cat /dbx/g")
    drive.fake.hooks["delete"] = lambda: drive.drop("f")
    missing = {
        "cp": "cp: cannot create regular file '/dbx/g'",
        "mv": "mv: cannot move '/dbx/f' to '/dbx/g'",
    }[verb]
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (
        1,
        "",
        f"{missing}: No such file or directory\n",
    )
    assert drive.fake.count("delete") == 1


@pytest.mark.asyncio
@DROPBOX
@pytest.mark.parametrize("verb, route", [("cp", "copy"), ("mv", "move")])
async def test_an_unread_dropbox_destination_retaken_is_refused_once(
    drive, workspace, verb, route
):
    ws = workspace()

    def take_name_after_the_clear() -> None:
        drive.fake.hooks[route] = lambda: drive.put("g", b"new\n")

    drive.fake.hooks["delete"] = take_name_after_the_clear
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (
        1,
        "",
        _refusal(drive, verb),
    )
    assert drive.fake.read("g") == b"new\n"
    assert await _run(ws, f"{verb} /dbx/f /dbx/g") == (0, "", "")
    assert drive.fake.read("g") == b"one\n"
