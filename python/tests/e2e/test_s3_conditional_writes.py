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
import os
from collections.abc import AsyncIterator, Callable

import pytest
import pytest_asyncio

from mirage import Mount, MountMode, Workspace, WritePolicy
from mirage.errors.types import StaleWriteError
from mirage.fuse.core import MountCore
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
PUT, COPY = "put_object", "copy_object"


def etag(data: bytes) -> str:
    return '"' + hashlib.md5(data).hexdigest() + '"'


@pytest.fixture
def fake():
    session = MultiBucketSession({"b": dict(SEED)})
    with patch_s3_session(session):
        yield session._client


def _workspace(
    write: WritePolicy = WritePolicy.CONDITIONAL,
    mode: MountMode = MountMode.WRITE,
    **mounts: VFSMount,
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
    return Workspace(table, mode=mode)


@pytest_asyncio.fixture
async def workspaces(fake) -> AsyncIterator[Callable[..., Workspace]]:
    built: list[Workspace] = []

    def make(*args: WritePolicy | MountMode, **mounts: VFSMount) -> Workspace:
        ws = _workspace(*args, **mounts)
        built.append(ws)
        return ws

    yield make
    for ws in built:
        await ws.close()


def _minio_vfs() -> MinIOVFS:
    return MinIOVFS(
        MinIOConfig(
            bucket="b",
            endpoint_url="http://127.0.0.1:9000",
            access_key_id="k",
            secret_access_key="s",
        )
    )


def _minio_mount() -> Mount:
    return Mount(_minio_vfs(), mode=MountMode.WRITE, write="conditional")


def _mutations(
    client: MultiBucketS3Client,
) -> list[tuple[str, dict[str, str]]]:
    return [e for e in client.ledger if e[0] in MUTATIONS]


def _sent(client: MultiBucketS3Client, op: str) -> list[dict[str, str]]:
    return [params for name, params in _mutations(client) if name == op]


def _network_down() -> None:
    raise ConnectionError("network down")


async def _run(ws: Workspace, line: str) -> tuple[int, str, str]:
    r = await ws.shell(line)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


def _theirs(fake: MultiBucketS3Client, key: str = "f") -> None:
    fake.buckets["b"][key] = b"theirs\n"


def _restore_f(fake: MultiBucketS3Client) -> None:
    fake.buckets["b"]["f"] = SEED["f"]


# ── where the version comes from ───────────────────────────────────────

ONE, GEE = {"IfMatch": etag(SEED["f"])}, {"IfMatch": etag(SEED["g"])}

VERSION_SOURCES = [
    (
        "redirect",
        ("echo a > /s3/new",),
        "echo b > /s3/new",
        PUT,
        [{"IfMatch": etag(b"a\n")}],
    ),
    (
        "sed",
        ("sed -i s/one/ONE/ /s3/f",),
        "echo x > /s3/f",
        PUT,
        [{"IfMatch": etag(b"ONE\n")}],
    ),
    ("grep", ("grep o /s3/f",), "echo z > /s3/f", PUT, [ONE]),
    ("head", ("head -n1 /s3/f",), "echo z > /s3/f", PUT, [ONE]),
    ("wc", ("wc -l /s3/f",), "echo z > /s3/f", PUT, [ONE]),
    (
        "append",
        ("echo a >> /s3/f",),
        "echo z > /s3/f",
        PUT,
        [{"IfMatch": etag(b"one\na\n")}],
    ),
    (
        "truncate",
        ("truncate -s 2 /s3/f",),
        "echo z > /s3/f",
        PUT,
        [{"IfMatch": etag(b"on")}],
    ),
    (
        "cross-cp",
        ("echo hi > /ram/x; cp /ram/x /s3/y",),
        "echo z > /s3/y",
        PUT,
        [{"IfMatch": etag(b"hi\n")}],
    ),
    ("removed", ("cat /s3/f", "rm /s3/f"), "echo x > /s3/f", PUT, [{}]),
    ("unread-tee", (), "echo y | tee /s3/g", PUT, [{}]),
    ("unread-cross-cp", (), "echo r > /ram/r; cp /ram/r /s3/g", PUT, [{}]),
    ("unread-cp", (), "cp /s3/f /s3/g", COPY, [{}]),
    ("rm-on-line", (), "cat /s3/f; rm /s3/f; echo x > /s3/f", PUT, [{}]),
    ("mv-on-line", (), "cat /s3/g; mv /s3/g /s3/h; echo y > /s3/g", PUT, [{}]),
    (
        "rm-r-on-line",
        (),
        "cat /s3/d/a; rm -r /s3/d; echo x > /s3/d/a",
        PUT,
        [{}],
    ),
    ("rm-r", ("cat /s3/d/a; rm -r /s3/d",), "echo x > /s3/d/a", PUT, [{}]),
    (
        "dir-mv",
        ("cat /s3/d/a; mv /s3/d /s3/e",),
        "echo x > /s3/d/a",
        PUT,
        [{}],
    ),
    (
        "dir-mv-copies",
        (),
        "mv /s3/d /s3/e",
        COPY,
        [
            {"CopySourceIfMatch": etag(SEED["d/a"])},
            {"CopySourceIfMatch": etag(SEED["d/b"])},
        ],
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, line, op, sent",
    [row[1:] for row in VERSION_SOURCES],
    ids=[row[0] for row in VERSION_SOURCES],
)
async def test_a_write_carries_the_version_mirage_holds(
    fake, workspaces, setup, line, op, sent
):
    ws = workspaces()
    for prior in setup:
        assert (await _run(ws, prior))[0] == 0, prior
    fake.ledger.clear()
    code, _, err = await _run(ws, line)
    assert (code, err) == (0, "")
    assert _sent(fake, op) == sent


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "read, call, key, args, sent",
    [
        (True, "write", "f", (b"x\n",), [ONE]),
        (False, "write", "g", (b"y\n",), [{}]),
        (False, "append", "g", (b"x\n",), [GEE]),
        (False, "pwrite", "g", (b"G", 0), [GEE]),
    ],
)
async def test_the_ops_api_writes_with_the_version_it_holds(
    fake, workspaces, read, call, key, args, sent
):
    ws = workspaces()
    if read:
        await ws.vfs.read(f"/s3/{key}")
    fake.ledger.clear()
    await getattr(ws.vfs, call)(f"/s3/{key}", *args)
    assert _sent(fake, PUT) == sent


@pytest.mark.asyncio
async def test_a_script_opening_a_read_file_to_write_carries_the_version(
    fake, workspaces
):
    ws = workspaces(WritePolicy.CONDITIONAL, MountMode.EXEC)
    await _run(ws, "cat /s3/f")
    _theirs(fake)
    code, _, _ = await _run(
        ws, "python3 -c \"open('/s3/f', 'w').write('mine')\""
    )
    assert code != 0
    assert fake.buckets["b"]["f"] == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, line",
    [
        ("cat /s3/f", "cp /s3/g /s3/f"),
        ("cat /s3/f", "mv /s3/g /s3/f"),
        ("grep one /s3/f", "echo x > /s3/f"),
    ],
)
async def test_a_file_deleted_since_it_was_read_is_refused_then_free(
    fake, workspaces, setup, line
):
    # Gone, so no newer bytes to protect: no version is kept, the retry goes plain.
    ws = workspaces()
    await _run(ws, setup)
    del fake.buckets["b"]["f"]
    code, _, err = await _run(ws, line)
    assert (code, STALE in err) == (1, True)
    assert "f" not in fake.buckets["b"]
    assert (await _run(ws, line))[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call, arg",
    [
        ("shell", "truncate -s 5 /s3/f"),
        ("shell", "echo x >> /s3/f"),
        ("append", b"x\n"),
        ("append", b""),
        ("pwrite", b"G"),
        ("pwrite", b""),
    ],
)
async def test_an_op_finding_a_read_file_gone_refuses_before_writing(
    fake, workspaces, call, arg
):
    # A restore of the old bytes lands between the op's own read and its write.
    ws = workspaces()
    if call == "shell":
        await _run(ws, "cat /s3/f")
    else:
        await ws.vfs.read("/s3/f")
    del fake.buckets["b"]["f"]
    fake.ledger.clear()
    fake.before(PUT, lambda: _restore_f(fake))
    if call == "shell":
        code, _, err = await _run(ws, arg)
        assert (code, STALE in err) == (1, True), err
    else:
        with pytest.raises(StaleWriteError):
            if call == "append":
                await ws.vfs.append("/s3/f", arg)
            else:
                await ws.vfs.pwrite("/s3/f", arg, 0)
    assert _mutations(fake) == []
    assert "f" not in fake.buckets["b"]


# ── the condition per op, loss side ────────────────────────────────────

LOSS = [
    # (name, setup, line, key changed, when, command prefix, exit)
    ("sort", "cat /s3/f", "sort -o /s3/f /s3/f", "f", "after", "sort: ", 2),
    (
        "sed",
        None,
        "sed -i s/one/ONE/ /s3/f",
        "f",
        PUT,
        "sed: couldn't edit /s3/f: ",
        4,
    ),
    ("cp", "cat /s3/f", "cp /s3/g /s3/f", "f", "after", "cp: ", 1),
    ("mv-dst", "cat /s3/f", "mv /s3/g /s3/f", "f", "after", "mv: ", 1),
    ("append", None, "echo x >> /s3/f", "f", PUT, "/s3/f: ", 1),
    ("truncate", None, "truncate -s 1 /s3/f", "f", PUT, "truncate: ", 1),
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
    ("mv-src-copy", None, "mv /s3/g /s3/new", "g", COPY, "mv: ", 1),
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
    fake, workspaces, name, setup, line, key, when, prefix, exit_code
):
    ws = workspaces()
    if setup is not None:
        await _run(ws, setup)
    if when == "after":
        _theirs(fake, key)
    else:
        fake.before(when, lambda: _theirs(fake, key))
    code, _, err = await _run(ws, line)
    assert code == exit_code, err
    assert STALE in err and err.startswith(prefix), err
    assert fake.buckets["b"][key] == b"theirs\n"
    # Only a move whose copy landed before its delete lost keeps the copy.
    kept = SEED["g"] if name == "mv-src-delete" else None
    assert fake.buckets["b"].get("new") == kept
    fake.ledger.clear()
    code, out, _ = await _run(ws, f"cat /s3/{key}")
    assert (code, out) == (0, "theirs\n")
    assert [e[0] for e in fake.ledger].count("get_object") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, when, changed, line, gone, stderr",
    [
        (
            None,
            "delete_objects",
            "d/b",
            "rm -r /s3/d",
            "d/a",
            f"rm: cannot remove '/s3/d/b': {STALE}\n",
        ),
        ("cat /s3/d/a", "after", "d/a", "rm -r /s3/d", "d/b", None),
        ("cat /s3/d/a", "after", "d/a", "mv /s3/d /s3/e", "d/b", None),
        (None, "delete_objects", "d/b", "mv /s3/d /s3/e", "d/a", None),
        (None, COPY, "d/a", "mv /s3/d /s3/e", "e/a", None),
    ],
)
async def test_a_directory_op_keeps_and_names_a_changed_file(
    fake, workspaces, setup, when, changed, line, gone, stderr
):
    ws = workspaces()
    if setup is not None:
        await _run(ws, setup)
    if when == "after":
        _theirs(fake, changed)
    else:
        fake.before(when, lambda: _theirs(fake, changed))
    code, _, err = await _run(ws, line)
    assert (code, STALE in err, f"'/s3/{changed}'" in err) == (1, True, True)
    if stderr is not None:
        assert err == stderr
    assert fake.buckets["b"][changed] == b"theirs\n"
    assert fake.buckets["b"].get(gone) is None


@pytest.mark.asyncio
async def test_a_landed_move_still_guards_the_file_it_made(fake, workspaces):
    # GNU's mv will not overwrite a target this mv made with its second source.
    fake.buckets["b"]["x/g"] = b"ex\n"
    fake.buckets["b"]["y/g"] = b"why\n"
    fake.buckets["b"]["t/k"] = b"k\n"
    ws = workspaces()
    fake.before("delete_object", lambda: _theirs(fake, "x/g"))
    code, _, err = await _run(ws, "mv /s3/x/g /s3/y/g /s3/t/")
    assert code == 1
    assert err == (
        f"mv: cannot remove '/s3/x/g': {STALE}\n"
        "mv: will not overwrite just-created '/s3/t/g' with '/s3/y/g'\n"
    )
    assert fake.buckets["b"]["t/g"] == b"ex\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "lines, op, final, after",
    [
        (
            ("cat /s3/f; cat /s3/f; echo x > /s3/f",),
            PUT,
            "cat /s3/f; echo y > /s3/f",
            b"y\n",
        ),
        (
            ("mv /s3/g /s3/f", "mv /s3/g /s3/f"),
            COPY,
            "cat /s3/f > /dev/null; mv /s3/g /s3/f",
            SEED["g"],
        ),
        (
            ("cp /s3/g /s3/f", "cp /s3/g /s3/f"),
            COPY,
            "cat /s3/f > /dev/null; cp /s3/g /s3/f",
            SEED["g"],
        ),
        (
            ("rm /s3/f", "rm /s3/f"),
            "delete_object",
            "cat /s3/f > /dev/null; rm /s3/f",
            None,
        ),
    ],
    ids=["reread from cache", "mv onto", "cp onto", "rm"],
)
async def test_a_refused_write_stays_refused_until_a_read(
    fake, workspaces, lines, op, final, after
):
    # The refusal keeps the version it lost on; a retry sends it again.
    ws = workspaces()
    await _run(ws, "cat /s3/f")
    _theirs(fake)
    fake.ledger.clear()
    for line in lines:
        code, _, err = await _run(ws, line)
        assert code == 1 and STALE in err, (line, err)
    assert fake.buckets["b"]["f"] == b"theirs\n"
    assert fake.buckets["b"]["g"] == SEED["g"]
    sent = _sent(fake, op)
    assert sent and all(p.get("IfMatch") == ONE["IfMatch"] for p in sent)
    assert (await _run(ws, final))[0] == 0
    assert fake.buckets["b"].get("f") == after


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, hook, key, refused, line",
    [
        (
            "cat /s3/f",
            ("copy_object", ("g",)),
            "f",
            "mv /s3/g /s3/f",
            "echo z > /s3/f",
        ),
        (
            "",
            ("put_object", ("f",)),
            "f",
            "cat /s3/f; echo x > /s3/f",
            "echo z > /s3/f",
        ),
        (
            "cat /s3/d/a /s3/d/b",
            ("delete_objects", ("d/a", "d/b")),
            "d/b",
            "rm -r /s3/d",
            "echo z > /s3/d/b",
        ),
        (
            "cat /s3/d/a /s3/d/b",
            ("copy_object", ("d/a", "d/b")),
            "d/b",
            "mv /s3/d /s3/e",
            "echo z > /s3/d/b",
        ),
        (
            "",
            ("delete_object", ("f",)),
            "f",
            "mv /s3/f /s3/g",
            "echo z > /s3/f",
        ),
        (
            "cat /s3/f /s3/g",
            ("copy_object", ("g",)),
            "f",
            "mv /s3/f /s3/g",
            "echo z > /s3/f",
        ),
    ],
    ids=[
        "mv source, untouched destination",
        "same line",
        "rm -r, every lost key",
        "dir mv, every lost key",
        "mv unread source, removal lost",
        "mv destination, untouched source",
    ],
)
async def test_a_refusal_keeps_every_version_it_was_measured_on(
    fake, workspaces, setup, hook, key, refused, line
):
    # Every changed path keeps its version, so a write over newer bytes is refused.
    ws = workspaces()
    if setup:
        await _run(ws, setup)
    op, changed = hook
    fake.before(op, lambda: [_theirs(fake, k) for k in changed] and None)
    code, _, err = await _run(ws, refused)
    assert code == 1 and STALE in err, err
    fake.buckets["b"][key] = b"newest\n"
    code, _, err = await _run(ws, line)
    assert code == 1 and STALE in err, err
    assert fake.buckets["b"][key] == b"newest\n"


@pytest.mark.asyncio
async def test_a_directory_rename_holds_each_destination_key_it_read(
    fake, workspaces
):
    ws = workspaces()
    fake.buckets["b"]["e/a"] = b"ea\n"
    await _run(ws, "cat /s3/e/a")
    _theirs(fake, "e/a")
    with pytest.raises(StaleWriteError):
        await ws.vfs.rename("/s3/d", "/s3/e")
    assert fake.buckets["b"]["e/a"] == b"theirs\n"
    assert fake.buckets["b"]["d/a"] == b"a\n"


@pytest.mark.asyncio
async def test_an_ops_call_after_a_refusal_is_refused_again(fake, workspaces):
    # Outside a line the kept version lives only in the cache.
    ws = workspaces()
    await ws.vfs.read("/s3/f")
    _theirs(fake)
    for _ in range(2):
        with pytest.raises(StaleWriteError):
            await ws.vfs.write("/s3/f", b"x\n")
    assert fake.buckets["b"]["f"] == b"theirs\n"


@pytest.mark.asyncio
async def test_a_recursive_remove_reports_a_key_the_store_refuses(
    fake, workspaces
):
    # DeleteObjects answers 200 and names a refused key in its body.
    ws = workspaces()
    fake.undeletable.add("d/a")
    code, _, err = await _run(ws, "rm -r /s3/d")
    assert (code, "Permission denied" in err) == (1, True), err
    assert fake.buckets["b"]["d/a"] == b"a\n"


@pytest.mark.asyncio
async def test_a_kernel_mount_write_carries_the_version(fake, workspaces):
    # FUSE writes through MountCore; a stale truncating open is refused.
    ws = workspaces()
    core = MountCore(ws.vfs)
    assert core.read("/s3/d/a", 100, 0, None) == SEED["d/a"]
    fake.ledger.clear()
    fh = core.open("/s3/d/a", os.O_WRONLY | os.O_TRUNC)
    core.write("/s3/d/a", b"A\n", 0, fh)
    core.release(fh)
    assert fake.buckets["b"]["d/a"] == b"A\n"
    assert _sent(fake, PUT) == [
        {"IfMatch": etag(SEED["d/a"])},
        {"IfMatch": etag(b"")},
    ]
    assert core.read("/s3/f", 100, 0, None) == SEED["f"]
    _theirs(fake)
    with pytest.raises(StaleWriteError):
        core.open("/s3/f", os.O_WRONLY | os.O_TRUNC)
    assert fake.buckets["b"]["f"] == b"theirs\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, line",
    [
        ("cat /s3/f", "echo x | tee /s3/f"),
        ("cat /s3/f", "cp /s3/g /s3/f"),
        ("cat /s3/f", "rm /s3/f"),
        (None, "echo x >> /s3/f"),
        (None, "truncate -s 1 /s3/f"),
        (None, "rm /s3/f"),
        (None, "mv /s3/g /s3/new"),
        (None, "rm -r /s3/d"),
        ("cat /s3/f", "sed -i s/one/two/ /s3/f"),
        ("cat /s3/g", "echo a > /ram/x; cp /ram/x /s3/g"),
        (
            "cat /s3/x; echo a > /ram/x",
            "cd /ram && tar -cf /ram/t.tar x && tar -xf /ram/t.tar -C /s3",
        ),
        ("cat /s3/cpr", "echo p > /ram/p; cp -r /ram/p /s3/cpr"),
        (
            "cat /s3/part.aa /s3/part.ab",
            "printf 'a\\nb\\n' | split -l 1 - /s3/part.",
        ),
    ],
)
async def test_a_current_write_lands_with_its_condition(
    fake, workspaces, setup, line
):
    # The tripwire fails any mutation sent without a condition.
    for key in ("x", "part.aa", "part.ab", "cpr"):
        fake.buckets["b"][key] = b"seed\n"
    ws = workspaces()
    fake.tripwire = True
    if setup is not None:
        await _run(ws, setup)
    code, _, err = await _run(ws, line)
    assert (code, err) == (0, "")


@pytest.mark.asyncio
async def test_an_unconditional_mount_sends_no_condition(fake, workspaces):
    ws = workspaces(WritePolicy.UNCONDITIONAL)
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
    # Nor does it keep a version without bytes.
    assert (await _run(ws, "grep x /s3/g"))[0] == 1
    assert await ws._cache.fingerprint("/s3/g") is None


@pytest.mark.asyncio
async def test_the_condition_follows_the_mount_written_to(fake, workspaces):
    ws = workspaces(
        **{
            "/u": Mount(
                S3VFS(S3Config(bucket="u", region="us-east-1")),
                mode=MountMode.WRITE,
            )
        }
    )
    await _run(ws, "cat /s3/f")
    fake.ledger.clear()
    assert (await _run(ws, "cp /s3/f /u/f"))[0] == 0
    assert (await _run(ws, "sort -o /u/g /s3/f"))[0] == 0
    assert all(p == {} for _, p in _mutations(fake))
    fake.ledger.clear()
    assert (await _run(ws, "cat /u/f; cp /u/f /s3/f"))[0] == 0
    assert _mutations(fake) == [(PUT, ONE)]


# ── minio: per-op refusal ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_refused_move_out_leaves_the_destination_in_place(
    fake, workspaces
):
    # Refused before anything moves: no backup renames the destination aside.
    ws = workspaces(**{"/m": _minio_mount()})
    await _run(ws, "echo mine > /ram/f")
    code, _, err = await _run(ws, "mv -b /m/f /ram/f")
    assert code == 1 and "Operation not supported" in err, err
    assert (await _run(ws, "cat /ram/f"))[1] == "mine\n"
    assert (await _run(ws, "ls /ram"))[1] == "f\n"
    assert _mutations(fake) == []


@pytest.mark.asyncio
async def test_a_move_holding_a_nested_minio_mount_is_refused_up_front(
    fake, workspaces
):
    # Else the walk copies the nested mount, its deletes are refused, half moved.
    ws = workspaces(
        **{"/other": (RAMVFS(), MountMode.WRITE), "/ram/d/m": _minio_mount()}
    )
    await _run(ws, "mkdir -p /ram/d; echo a > /ram/d/a")
    code, _, err = await _run(ws, "mv /ram/d /other/d")
    assert code == 1 and "Operation not supported" in err, err
    assert (await _run(ws, "cat /ram/d/a"))[1] == "a\n"
    assert (await _run(ws, "ls /other"))[1] == ""
    assert _mutations(fake) == []


@pytest.mark.asyncio
async def test_a_move_out_of_a_mount_nested_in_minio_goes_through(
    fake, workspaces
):
    # The source's own mount deletes it; the minio mount above is untouched.
    ws = workspaces(
        **{
            "/data": _minio_mount(),
            "/data/scratch": (RAMVFS(), MountMode.WRITE),
            "/other": (RAMVFS(), MountMode.WRITE),
        }
    )
    await _run(ws, "echo a > /data/scratch/a")
    code, _, err = await _run(ws, "mv /data/scratch/a /other/a")
    assert code == 0, err
    assert (await _run(ws, "cat /other/a"))[1] == "a\n"
    assert _mutations(fake) == []


@pytest.mark.asyncio
async def test_a_conditional_rm_r_deletes_page_by_page(fake, workspaces):
    # As the unconditional rm -r: memory stays one page, not the whole prefix.
    for name in ("c", "d", "e"):
        fake.buckets["b"][f"d/{name}"] = name.encode()
    fake.page_size = 2
    ws = workspaces()
    assert (await _run(ws, "rm -r /s3/d"))[0] == 0
    assert not [k for k in fake.buckets["b"] if k.startswith("d/")]
    assert len(_sent(fake, "delete_objects")) == 3


@pytest.mark.asyncio
async def test_a_conditional_dir_mv_copies_everything_before_deleting(
    fake, workspaces
):
    # As GNU mv across devices: a copy failing on a later page leaves the source.
    for name in ("c", "d", "e"):
        fake.buckets["b"][f"d/{name}"] = name.encode()
    before = {k: v for k, v in fake.buckets["b"].items() if k.startswith("d/")}
    fake.page_size = 2
    for hook in (lambda: None, lambda: None, lambda: None, _network_down):
        fake.before(COPY, hook)
    ws = workspaces()
    assert (await _run(ws, "mv /s3/d /s3/e"))[0] == 1
    after = {k: v for k, v in fake.buckets["b"].items() if k.startswith("d/")}
    assert after == before
    assert _sent(fake, "delete_objects") == []


# ── costs: a condition is a header, never a request ─────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /s3/f; echo x > /s3/f",
        "echo x >> /s3/g",
        "truncate -s 1 /s3/g",
        "cp /s3/g /s3/h",
        "mv /s3/g /s3/i",
        "rm /s3/f",
        "rm -r /s3/d",
    ],
)
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
