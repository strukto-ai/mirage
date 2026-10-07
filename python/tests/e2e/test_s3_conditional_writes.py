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

import hashlib

import pytest

from mirage import Mount, MountMode, Workspace, WritePolicy
from mirage.errors.types import StaleWriteError
from mirage.observe.record import RecordIndex
from mirage.vfs.minio import MinIOConfig, MinIOVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace.workspace.types import VFSMount
from tests.e2e.s3_mock import (
    MUTATIONS,
    MultiBucketS3Client,
    MultiBucketSession,
    patch_s3_session,
)

STALE = "changed since it was read; read it again before writing"
SEED = {"f": b"one\n", "g": b"gee\n", "d/a": b"a\n", "d/b": b"b\n"}


def etag(data: bytes) -> str:
    return '"' + hashlib.md5(data).hexdigest() + '"'


@pytest.fixture
def fake():
    session = MultiBucketSession({"b": dict(SEED)})
    with patch_s3_session(session):
        yield session._client


def _workspace(
    write: WritePolicy = WritePolicy.CONDITIONAL, **mounts: VFSMount
) -> Workspace:
    table: dict[str, VFSMount] = {
        "/s3": Mount(
            S3VFS(S3Config(bucket="b", region="us-east-1")),
            mode=MountMode.WRITE,
            write=write,
        ),
        "/ram": (RAMVFS(), MountMode.WRITE),
    }
    table.update(mounts)
    return Workspace(table, mode=MountMode.WRITE)


def _minio_workspace() -> Workspace:
    minio = MinIOVFS(
        MinIOConfig(
            bucket="b",
            endpoint_url="http://127.0.0.1:9000",
            access_key_id="k",
            secret_access_key="s",
        )
    )
    return _workspace(
        **{"/m": Mount(minio, mode=MountMode.WRITE, write="conditional")}
    )


def _mutations(
    client: MultiBucketS3Client,
) -> list[tuple[str, dict[str, str]]]:
    return [e for e in client.ledger if e[0] in MUTATIONS]


async def _run(ws: Workspace, line: str) -> tuple[int, str, str]:
    r = await ws.shell(line)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


def _theirs(fake: MultiBucketS3Client, key: str = "f") -> None:
    fake.buckets["b"][key] = b"theirs\n"


# ── where the version comes from ───────────────────────────────────────


@pytest.mark.asyncio
async def test_a_read_gives_the_next_write_its_version(fake):
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        fake.ledger.clear()
        code, _, err = await _run(ws, "echo x > /s3/f")
        assert (code, err) == (0, "")
        assert _mutations(fake) == [
            ("put_object", {"IfMatch": etag(SEED["f"])})
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_redirect_write_gives_the_next_write_its_version(fake):
    # The redirect keeps the PUT's ETag as a version without bytes, so
    # rewriting a file the agent itself wrote is not refused for want of a
    # read.
    ws = _workspace()
    try:
        await _run(ws, "echo a > /s3/new")
        fake.ledger.clear()
        code, _, err = await _run(ws, "echo b > /s3/new")
        assert (code, err) == (0, "")
        assert _mutations(fake) == [("put_object", {"IfMatch": etag(b"a\n")})]
        assert fake.buckets["b"]["new"] == b"b\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_in_place_edit_leaves_the_new_version(fake):
    ws = _workspace()
    try:
        await _run(ws, "sed -i s/one/ONE/ /s3/f")
        fake.ledger.clear()
        code, _, _ = await _run(ws, "echo x > /s3/f")
        assert code == 0
        assert _mutations(fake) == [
            ("put_object", {"IfMatch": etag(b"ONE\n")})
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_removed_file_is_recreated_only_if_still_absent(fake):
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        await _run(ws, "rm /s3/f")
        fake.ledger.clear()
        await _run(ws, "echo x > /s3/f")
        assert _mutations(fake) == [("put_object", {"IfNoneMatch": "*"})]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["cat /s3/f; echo x > /s3/f", "cat /s3/f; cat /s3/f; echo x > /s3/f"],
)
async def test_the_read_a_refusal_asks_for_fetches_the_new_file(fake, line):
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        _theirs(fake)
        code, _, err = await _run(ws, line)
        assert (code, STALE in err) == (1, True)
        assert await _run(ws, "cat /s3/f") == (0, "theirs\n", "")
        assert (await _run(ws, "echo y > /s3/f"))[0] == 0
        assert fake.buckets["b"]["f"] == b"y\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("read", [False, True])
async def test_a_script_opening_a_file_to_write_carries_the_version(
    fake, read
):
    # open(..., "w") truncates first; an empty truncate replaces the whole
    # file, so it carries what the agent saw, never the bytes it would
    # have to read for itself.
    ws = Workspace(
        {
            "/s3": Mount(
                S3VFS(S3Config(bucket="b", region="us-east-1")),
                mode=MountMode.WRITE,
                write=WritePolicy.CONDITIONAL,
            )
        },
        mode=MountMode.EXEC,
    )
    try:
        if read:
            await _run(ws, "cat /s3/f")
        _theirs(fake)
        code, _, _ = await _run(
            ws, "python3 -c \"open('/s3/f', 'w').write('mine')\""
        )
        assert code != 0
        assert fake.buckets["b"]["f"] == b"theirs\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, key, seen",
    [
        ("grep o /s3/f", "f", b"one\n"),
        ("head -n1 /s3/f", "f", b"one\n"),
        ("wc -l /s3/f", "f", b"one\n"),
        ("echo a >> /s3/f", "f", b"one\na\n"),
        ("truncate -s 2 /s3/f", "f", b"on"),
        ("echo hi > /ram/x; cp /ram/x /s3/y", "y", b"hi\n"),
    ],
)
async def test_a_line_that_keeps_no_bytes_still_leaves_its_version(
    fake, setup, key, seen
):
    ws = _workspace()
    try:
        assert (await _run(ws, setup))[0] == 0
        fake.ledger.clear()
        assert await _run(ws, f"echo z > /s3/{key}") == (0, "", "")
        assert _mutations(fake) == [("put_object", {"IfMatch": etag(seen)})]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["echo x > /s3/f", "cp /s3/g /s3/f"])
async def test_a_file_deleted_since_it_was_read_is_refused_then_free(
    fake, line
):
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        del fake.buckets["b"]["f"]
        code, _, err = await _run(ws, line)
        assert (code, STALE in err) == (1, True)
        assert "f" not in fake.buckets["b"]
        assert (await _run(ws, line))[0] == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["truncate -s 5 /s3/f", "echo x >> /s3/f"])
async def test_an_op_finding_a_read_file_gone_refuses_before_writing(
    fake, line
):
    # Its own read found nothing, but the agent read the file: that view
    # is stale, as for a plain `>`. Sending the old version instead would
    # let a restore of those bytes be overwritten from an empty file.
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        del fake.buckets["b"]["f"]
        fake.ledger.clear()
        # A restore of the old bytes between this op's read and its write.
        fake.before(
            "put_object",
            lambda: fake.buckets["b"].__setitem__("f", SEED["f"]) or None,
        )
        code, _, err = await _run(ws, line)
        assert (code, STALE in err) == (1, True), err
        assert _mutations(fake) == []
        assert "f" not in fake.buckets["b"]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call, data",
    [("append", b"x\n"), ("append", b""), ("pwrite", b"G"), ("pwrite", b"")],
)
async def test_an_ops_call_finding_a_read_file_gone_refuses_before_writing(
    fake, call, data
):
    # The same rule through the ops API, which runs the generic append and
    # pwrite; an empty one stats instead of reading.
    ws = _workspace()
    try:
        await ws.vfs.read("/s3/f")
        del fake.buckets["b"]["f"]
        fake.ledger.clear()
        fake.before(
            "put_object",
            lambda: fake.buckets["b"].__setitem__("f", SEED["f"]) or None,
        )
        with pytest.raises(StaleWriteError):
            if call == "append":
                await ws.vfs.append("/s3/f", data)
            else:
                await ws.vfs.pwrite("/s3/f", data, 0)
        assert _mutations(fake) == []
        assert "f" not in fake.buckets["b"]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "lines",
    [
        ("cat /s3/d/a; rm -r /s3/d; echo x > /s3/d/a",),
        ("cat /s3/d/a; rm -r /s3/d", "echo x > /s3/d/a"),
        ("cat /s3/d/a; mv /s3/d /s3/e", "echo x > /s3/d/a"),
    ],
)
async def test_a_file_gone_with_its_directory_is_created_again(fake, lines):
    ws = _workspace()
    try:
        for line in lines:
            code, _, err = await _run(ws, line)
            assert (code, err) == (0, ""), line
        assert fake.buckets["b"]["d/a"] == b"x\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_ops_api_reads_and_writes_with_a_version(fake):
    ws = _workspace()
    try:
        await ws.vfs.read("/s3/f")
        fake.ledger.clear()
        await ws.vfs.write("/s3/f", b"x\n")
        assert _mutations(fake) == [
            ("put_object", {"IfMatch": etag(SEED["f"])})
        ]
        # An existing file never read through mirage has no version, so the
        # write asks for create-only and the store refuses it.
        with pytest.raises(StaleWriteError):
            await ws.vfs.write("/s3/g", b"y\n")
        assert fake.buckets["b"]["g"] == SEED["g"]
    finally:
        await ws.close()


# ── the condition per op, loss side ────────────────────────────────────

LOSS = [
    # (name, setup, line, key changed, when, command prefix, exit)
    ("redirect", "cat /s3/f", "echo x > /s3/f", "f", "after", "", 1),
    ("tee", "cat /s3/f", "echo x | tee /s3/f", "f", "after", "tee: ", 1),
    ("sort", "cat /s3/f", "sort -o /s3/f /s3/f", "f", "after", "sort: ", 2),
    (
        "sed",
        None,
        "sed -i s/one/ONE/ /s3/f",
        "f",
        "put_object",
        "sed: couldn't edit /s3/f: ",
        4,
    ),
    ("cp", "cat /s3/f", "cp /s3/g /s3/f", "f", "after", "cp: ", 1),
    ("mv-dst", "cat /s3/f", "mv /s3/g /s3/f", "f", "after", "mv: ", 1),
    ("rm", "cat /s3/f", "rm /s3/f", "f", "after", "rm: ", 1),
    (
        "cross-cp",
        "cat /s3/f; echo r > /ram/r",
        "cp /ram/r /s3/f",
        "f",
        "after",
        "cp: ",
        1,
    ),
    ("append", None, "echo x >> /s3/f", "f", "put_object", "", 1),
    (
        "truncate",
        None,
        "truncate -s 1 /s3/f",
        "f",
        "put_object",
        "truncate: ",
        1,
    ),
    (
        "truncate-0",
        "cat /s3/f",
        "truncate -s 0 /s3/f",
        "f",
        "after",
        "truncate: ",
        1,
    ),
    ("rm-unread", None, "rm /s3/f", "f", "delete_object", "rm: ", 1),
    ("mv-src-copy", None, "mv /s3/g /s3/new", "g", "copy_object", "mv: ", 1),
    ("mv-src-read", "cat /s3/g", "mv /s3/g /s3/new", "g", "after", "mv: ", 1),
    (
        "mv-src-delete",
        None,
        "mv /s3/g /s3/new",
        "g",
        "delete_object",
        "mv: cannot remove '/s3/g': ",
        1,
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name, setup, line, key, when, prefix, exit_code",
    LOSS,
    ids=[c[0] for c in LOSS],
)
async def test_a_stale_write_is_refused_and_leaves_the_object(
    fake, name, setup, line, key, when, prefix, exit_code
):
    ws = _workspace()
    try:
        if setup is not None:
            await _run(ws, setup)
        if when == "after":
            _theirs(fake, key)
        else:
            # Another writer lands between the op's own read and its write.
            fake.before(when, lambda: _theirs(fake, key))
        code, _, err = await _run(ws, line)
        assert code == exit_code, err
        assert STALE in err and err.startswith(prefix), err
        assert fake.buckets["b"][key] == b"theirs\n"
        if name in ("mv-src-copy", "mv-src-read"):
            assert "new" not in fake.buckets["b"]
        # The refusal dropped the cached copy, so the next read fetches.
        fake.ledger.clear()
        code, out, _ = await _run(ws, f"cat /s3/{key}")
        assert (code, out) == (0, "theirs\n")
        assert [e[0] for e in fake.ledger].count("get_object") == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_recursive_remove_keeps_and_reports_a_changed_file(fake):
    ws = _workspace()
    try:
        fake.before("delete_objects", lambda: _theirs(fake, "d/b"))
        code, _, err = await _run(ws, "rm -r /s3/d")
        assert code == 1
        # mirage's rm names the operand it was given; GNU names the file
        # inside it. The changed file is kept either way.
        assert err == f"rm: cannot remove '/s3/d': {STALE}\n"
        assert fake.buckets["b"].get("d/a") is None
        assert fake.buckets["b"]["d/b"] == b"theirs\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["rm -r /s3/d", "mv /s3/d /s3/e"])
async def test_a_directory_op_keeps_a_file_changed_since_it_was_read(
    fake, line
):
    # The listing's ETag is the file as changed; the version the agent read
    # is what the change is measured against.
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/d/a")
        _theirs(fake, "d/a")
        code, _, err = await _run(ws, line)
        assert (code, STALE in err) == (1, True)
        assert fake.buckets["b"]["d/a"] == b"theirs\n"
        assert fake.buckets["b"].get("d/b") is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_move_whose_source_changed_after_its_copy_cannot_remove(fake):
    # The copy landed; only the source's delete lost. GNU's mv across
    # devices (coreutils 9.7) reports a failed unlink as "cannot remove"
    # and keeps the copy.
    ws = _workspace()
    try:
        fake.before("delete_object", lambda: _theirs(fake, "g"))
        code, _, err = await _run(ws, "mv /s3/g /s3/new")
        assert (code, err) == (1, f"mv: cannot remove '/s3/g': {STALE}\n")
        assert fake.buckets["b"]["new"] == b"gee\n"
        assert fake.buckets["b"]["g"] == b"theirs\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_landed_move_still_guards_the_file_it_made(fake):
    # The copy of the first source landed though its delete lost, so the
    # target is a file this mv made; GNU's mv will not overwrite it with the
    # second source.
    fake.buckets["b"]["x/g"] = b"ex\n"
    fake.buckets["b"]["y/g"] = b"why\n"
    fake.buckets["b"]["t/k"] = b"k\n"
    ws = _workspace()
    try:
        fake.before("delete_object", lambda: _theirs(fake, "x/g"))
        code, _, err = await _run(ws, "mv /s3/x/g /s3/y/g /s3/t/")
        assert code == 1
        assert err == (
            f"mv: cannot remove '/s3/x/g': {STALE}\n"
            "mv: will not overwrite just-created '/s3/t/g' with '/s3/y/g'\n"
        )
        assert fake.buckets["b"]["t/g"] == b"ex\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_lost_write_keeps_no_version_for_the_next_line(fake):
    # grep saw a version; the write after it lost to a delete. Kept, that
    # version would make the next write's If-Match miss a file now gone.
    ws = _workspace()
    try:
        fake.before("put_object", lambda: fake.buckets["b"].pop("f") and None)
        code, _, err = await _run(ws, "grep one /s3/f; echo x > /s3/f")
        assert code == 1 and STALE in err, err
        assert await ws._cache.fingerprint("/s3/f") is None
        assert await _run(ws, "echo y > /s3/f") == (0, "", "")
        assert fake.buckets["b"]["f"] == b"y\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_refusal_lifts_once_the_line_reads_the_file_again(fake):
    # The refusal says to read the file again; doing so on the same line
    # gives the next write that read's version.
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        _theirs(fake)
        code, out, _ = await _run(
            ws, "echo x > /s3/f; cat /s3/f; echo y > /s3/f"
        )
        assert (code, out) == (0, "theirs\n")
        assert fake.buckets["b"]["f"] == b"y\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_directory_move_never_overwrites_a_file_made_at_its_target(
    fake,
):
    ws = _workspace()
    try:
        fake.before(
            "copy_object",
            lambda: fake.buckets["b"].__setitem__("e/a", b"theirs\n"),
        )
        code, _, err = await _run(ws, "mv /s3/d /s3/e")
        assert (code, STALE in err) == (1, True)
        assert fake.buckets["b"]["e/a"] == b"theirs\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_directory_move_reports_a_source_changed_before_its_delete(
    fake,
):
    ws = _workspace()
    try:
        fake.before("delete_objects", lambda: _theirs(fake, "d/b"))
        code, _, err = await _run(ws, "mv /s3/d /s3/e")
        assert (code, STALE in err) == (1, True)
        assert fake.buckets["b"]["d/b"] == b"theirs\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /s3/f; rm /s3/f; echo x > /s3/f",
        "cat /s3/g; mv /s3/g /s3/h; echo y > /s3/g",
    ],
)
async def test_a_file_removed_earlier_on_the_line_is_created_again(fake, line):
    ws = _workspace()
    try:
        code, _, err = await _run(ws, line)
        assert (code, err) == (0, "")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("call", ["append", "pwrite"])
async def test_the_ops_api_writes_back_with_its_own_read(fake, call):
    # An append or a write at an offset reads the file itself first, so a
    # file never read through mirage still has the version it writes on.
    ws = _workspace()
    try:
        fake.ledger.clear()
        if call == "append":
            await ws.vfs.append("/s3/g", b"x\n")
        else:
            await ws.vfs.pwrite("/s3/g", b"G", 0)
        assert _mutations(fake) == [
            ("put_object", {"IfMatch": etag(SEED["g"])})
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_write_loop_indexes_its_line_a_few_times(fake, monkeypatch):
    # Each write looks its version up in the line's one index, absorbing
    # only the records since the last lookup; building one per write made
    # a loop over one file quadratic.
    built: list[int] = []
    real = RecordIndex.__init__

    def counted(self, records):
        built.append(len(records))
        real(self, records)

    monkeypatch.setattr(RecordIndex, "__init__", counted)
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        built.clear()
        line = "for i in $(seq 50); do echo $i > /s3/f; done"
        assert (await _run(ws, line))[0] == 0
        assert len(built) < 10, built
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "write", [WritePolicy.CONDITIONAL, WritePolicy.UNCONDITIONAL]
)
async def test_a_recursive_remove_reports_a_key_the_store_refuses(fake, write):
    # DeleteObjects answers 200 and names a refused key in its body.
    ws = _workspace(write)
    try:
        fake.undeletable.add("d/a")
        code, _, err = await _run(ws, "rm -r /s3/d")
        assert (code, "Permission denied" in err) == (1, True), err
        assert fake.buckets["b"]["d/a"] == b"a\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_directory_move_keeps_a_changed_file_where_it_was(fake):
    ws = _workspace()
    try:
        fake.before("copy_object", lambda: _theirs(fake, "d/a"))
        code, _, err = await _run(ws, "mv /s3/d /s3/e")
        assert code == 1 and STALE in err, err
        assert fake.buckets["b"]["d/a"] == b"theirs\n"
        assert fake.buckets["b"].get("e/a") is None
    finally:
        await ws.close()


WIN = [
    ("cat /s3/f", "echo x > /s3/f"),
    ("cat /s3/f", "echo x | tee /s3/f"),
    ("cat /s3/f", "cp /s3/g /s3/f"),
    ("cat /s3/f", "rm /s3/f"),
    (None, "echo x >> /s3/f"),
    (None, "truncate -s 1 /s3/f"),
    (None, "rm /s3/f"),
    (None, "mv /s3/g /s3/new"),
    (None, "rm -r /s3/d"),
    (None, "echo x > /s3/new"),
    (None, "mkdir /s3/e"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("setup, line", WIN, ids=[w[1] for w in WIN])
async def test_a_current_write_lands_with_its_condition(fake, setup, line):
    # Including files never read: the ops that read for themselves (>>,
    # truncate) or look first (rm, mv) do not need a prior cat. The
    # tripwire fails any mutation sent without a condition.
    ws = _workspace()
    try:
        fake.tripwire = True
        if setup is not None:
            await _run(ws, setup)
        code, _, err = await _run(ws, line)
        assert (code, err) == (0, "")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "echo y > /s3/g",
        "echo y | tee /s3/g",
        "cp /s3/f /s3/g",
        "truncate -s 0 /s3/g",
    ],
)
async def test_an_existing_file_never_read_is_not_overwritten(fake, line):
    ws = _workspace()
    try:
        code, _, err = await _run(ws, line)
        assert code == 1 and STALE in err, err
        assert fake.buckets["b"]["g"] == SEED["g"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_unconditional_mount_sends_no_condition(fake):
    ws = _workspace(write=WritePolicy.UNCONDITIONAL)
    try:
        for line in (
            "cat /s3/f",
            "echo x > /s3/f",
            "echo x >> /s3/f",
            "cp /s3/g /s3/h",
            "mv /s3/h /s3/i",
            "rm /s3/i",
            "rm -r /s3/d",
        ):
            assert (await _run(ws, line))[0] == 0, line
        assert all(params == {} for _, params in _mutations(fake))
        # Nor does it keep a version without bytes, which only a
        # conditional write would send.
        assert (await _run(ws, "grep x /s3/g"))[0] == 1
        assert await ws._cache.fingerprint("/s3/g") is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_condition_follows_the_mount_written_to(fake):
    # Two S3 mounts, one conditional: a line reading one and writing the
    # other carries the condition only on writes to the conditional one.
    ws = _workspace(
        **{
            "/u": Mount(
                S3VFS(S3Config(bucket="u", region="us-east-1")),
                mode=MountMode.WRITE,
            )
        }
    )
    try:
        await _run(ws, "cat /s3/f")
        fake.ledger.clear()
        assert (await _run(ws, "cp /s3/f /u/f"))[0] == 0
        assert (await _run(ws, "sort -o /u/g /s3/f"))[0] == 0
        assert all(p == {} for _, p in _mutations(fake))
        fake.ledger.clear()
        assert (await _run(ws, "cat /u/f; cp /u/f /s3/f"))[0] == 0
        assert _mutations(fake) == [
            ("put_object", {"IfMatch": etag(SEED["f"])})
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_namespace_writes_never_reach_the_store(fake):
    ws = _workspace()
    try:
        for line in ("chmod 600 /s3/f", "ln -s /s3/f /s3/link"):
            assert (await _run(ws, line))[0] == 0, line
        assert _mutations(fake) == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_auth_failure_keeps_its_own_words(fake):
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")

        def deny() -> None:
            exc = Exception("AccessDenied")
            exc.response = {
                "Error": {"Code": "AccessDenied"},
                "ResponseMetadata": {"HTTPStatusCode": 403},
            }
            raise exc

        fake.before("put_object", deny)
        code, _, err = await _run(ws, "echo x > /s3/f")
        assert code == 1 and STALE not in err, err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_write_route_nobody_listed_still_carries_a_condition(fake):
    # The tripwire fails any unconditioned mutation, so a command writing
    # through a path the policy never reached is caught here.
    ws = _workspace()
    try:
        fake.tripwire = True
        for line in (
            "cat /s3/f; sed -i s/one/two/ /s3/f",
            "echo a > /ram/x; cp /ram/x /s3/new1",
            "printf 'a\\nb\\n' | split -l 1 - /s3/part.",
            "cd /ram && tar -cf /ram/t.tar x && tar -xf /ram/t.tar -C /s3",
            "echo p > /ram/p; cp -r /ram/p /s3/cpr",
            "echo /s3/new2 | xargs touch",
        ):
            code, _, err = await _run(ws, line)
            assert code == 0, (line, err)
    finally:
        await ws.close()


# ── minio: per-op refusal ───────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cp /m/g /m/f",
        "mv /m/g /m/h",
        "rm /m/g",
        "rm -r /m/d",
        "mv /m/g /ram/g",
        "find /m -name g -delete",
    ],
)
async def test_minio_refuses_what_it_cannot_condition_before_sending(
    fake, line
):
    ws = _minio_workspace()
    try:
        await _run(ws, "cat /m/f; cat /m/g")
        fake.ledger.clear()
        code, _, err = await _run(ws, line)
        assert code == 1 and "Operation not supported" in err, err
        assert _mutations(fake) == []
        assert fake.buckets["b"]["g"] == SEED["g"]
        # Refused before anything moved: a mv out copies nothing either.
        assert (await _run(ws, "cat /ram/g"))[0] == 1
        # A plain overwrite is protected, so it is allowed.
        assert (await _run(ws, "echo x > /m/f"))[0] == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("verb", ["cp", "mv"])
async def test_minio_takes_a_file_from_another_mount(fake, verb):
    # Into MinIO from elsewhere is a write, which MinIO does condition.
    ws = _minio_workspace()
    try:
        line = f"echo r > /ram/r; {verb} /ram/r /m/new"
        assert await _run(ws, line) == (0, "", "")
        assert fake.buckets["b"]["new"] == b"r\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", ["-b", "--backup=numbered", "-S .bak -b"])
async def test_a_refused_move_out_leaves_the_destination_in_place(fake, flags):
    # Refused before anything moves: no backup renames the destination
    # aside first.
    ws = _minio_workspace()
    try:
        await _run(ws, "echo mine > /ram/f")
        code, _, err = await _run(ws, f"mv {flags} /m/f /ram/f")
        assert code == 1 and "Operation not supported" in err, err
        assert (await _run(ws, "cat /ram/f"))[1] == "mine\n"
        assert (await _run(ws, "ls /ram"))[1] == "f\n"
        assert _mutations(fake) == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_move_holding_a_nested_minio_mount_is_refused_up_front(fake):
    # The walk would copy the nested mount too and then find its deletes
    # refused, leaving the tree half moved.
    minio = MinIOVFS(
        MinIOConfig(
            bucket="b",
            endpoint_url="http://127.0.0.1:9000",
            access_key_id="k",
            secret_access_key="s",
        )
    )
    ws = _workspace(
        **{
            "/other": (RAMVFS(), MountMode.WRITE),
            "/ram/d/m": Mount(
                minio, mode=MountMode.WRITE, write="conditional"
            ),
        }
    )
    try:
        await _run(ws, "mkdir -p /ram/d; echo a > /ram/d/a")
        code, _, err = await _run(ws, "mv /ram/d /other/d")
        assert code == 1 and "Operation not supported" in err, err
        assert (await _run(ws, "cat /ram/d/a"))[1] == "a\n"
        assert (await _run(ws, "ls /other"))[1] == ""
        assert _mutations(fake) == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_move_out_of_a_mount_nested_in_minio_goes_through(fake):
    # The source's own mount deletes it; the minio mount above is untouched.
    minio = MinIOVFS(
        MinIOConfig(
            bucket="b",
            endpoint_url="http://127.0.0.1:9000",
            access_key_id="k",
            secret_access_key="s",
        )
    )
    ws = _workspace(
        **{
            "/data": Mount(minio, mode=MountMode.WRITE, write="conditional"),
            "/data/scratch": (RAMVFS(), MountMode.WRITE),
            "/other": (RAMVFS(), MountMode.WRITE),
        }
    )
    try:
        await _run(ws, "echo a > /data/scratch/a")
        code, _, err = await _run(ws, "mv /data/scratch/a /other/a")
        assert code == 0, err
        assert (await _run(ws, "cat /other/a"))[1] == "a\n"
        assert _mutations(fake) == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_conditional_rm_r_deletes_page_by_page(fake):
    # As the unconditional rm -r does: memory stays one page, not the
    # whole prefix.
    for name in ("c", "d", "e"):
        fake.buckets["b"][f"d/{name}"] = name.encode()
    fake.page_size = 2
    ws = _workspace()
    try:
        assert (await _run(ws, "rm -r /s3/d"))[0] == 0
        assert not [k for k in fake.buckets["b"] if k.startswith("d/")]
        deletes = [op for op, _ in _mutations(fake) if op == "delete_objects"]
        assert len(deletes) == 3
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_conditional_dir_mv_copies_everything_before_deleting(fake):
    # As GNU mv across devices: a copy failing on a later page leaves the
    # source whole.
    for name in ("c", "d", "e"):
        fake.buckets["b"][f"d/{name}"] = name.encode()
    before = {k: v for k, v in fake.buckets["b"].items() if k.startswith("d/")}
    fake.page_size = 2

    def fail() -> None:
        raise ConnectionError("network down")

    for hook in (lambda: None, lambda: None, lambda: None, fail):
        fake.before("copy_object", hook)
    ws = _workspace()
    try:
        assert (await _run(ws, "mv /s3/d /s3/e"))[0] == 1
        after = {
            k: v for k, v in fake.buckets["b"].items() if k.startswith("d/")
        }
        assert after == before
        assert "delete_objects" not in [op for op, _ in _mutations(fake)]
    finally:
        await ws.close()


# ── costs: a condition is a header, never a request ─────────────────────

COST_LINES = [
    "cat /s3/f; echo x > /s3/f",
    "echo x >> /s3/g",
    "truncate -s 1 /s3/g",
    "cp /s3/g /s3/h",
    "mv /s3/g /s3/i",
    "rm /s3/f",
    "rm -r /s3/d",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line", COST_LINES)
async def test_a_conditional_line_sends_the_same_requests(line):
    ops = {}
    for policy in (WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL):
        session = MultiBucketSession({"b": dict(SEED)})
        with patch_s3_session(session):
            ws = _workspace(write=policy)
            try:
                code, _, err = await _run(ws, line)
                assert code == 0, (policy, err)
                ops[policy] = [e[0] for e in session._client.ledger]
            finally:
                await ws.close()
    assert ops[WritePolicy.CONDITIONAL] == ops[WritePolicy.UNCONDITIONAL]


@pytest.mark.asyncio
async def test_a_refused_tee_does_not_cache_its_bytes(fake):
    ws = _workspace()
    try:
        await _run(ws, "cat /s3/f")
        _theirs(fake)
        await _run(ws, "echo mine | tee /s3/f")
        fake.ledger.clear()
        assert (await _run(ws, "cat /s3/f"))[1] == "theirs\n"
        assert [e[0] for e in fake.ledger].count("get_object") == 1
    finally:
        await ws.close()
