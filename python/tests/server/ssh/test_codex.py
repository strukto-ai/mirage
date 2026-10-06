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

import asyncio
import base64
import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncssh
import pytest

from mirage.server.rpc.constants import (
    RPC_INTERNAL_ERROR,
    RPC_INVALID_PARAMS,
    RPC_INVALID_REQUEST,
    RPC_METHOD_NOT_FOUND,
    RPC_NOT_FOUND,
)
from mirage.server.ssh.codex import argv_line, process_env, to_path, to_uri
from mirage.server.ssh.constants import CODEX_RETAINED_OUTPUT, CODEX_SUBSYSTEM
from mirage.server.ssh.errors import CodexRPCError
from tests.server.ssh.conftest import (
    SSHHarness,
    bind_key,
    start_harness,
    stop_harness,
    vault_workspace,
)

TIMEOUT = 10
WALK = {
    "maxDepth": 3,
    "maxDirectories": 10,
    "maxEntries": 100,
    "followDirectorySymlinks": False,
}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


class CodexClient:
    """Codex's side of one codex-exec channel, one request at a time.

    Lines are split here: asyncssh's ``readline`` gives up on a line
    longer than the channel window, and a whole file's reply is longer.

    Args:
        process (asyncssh.SSHClientProcess[str]): the subsystem channel.
    """

    def __init__(self, process: asyncssh.SSHClientProcess[str]) -> None:
        self.process = process
        self.notes: list[dict[str, Any]] = []
        self._id = 0
        self._buffer = ""

    async def receive(self) -> dict[str, Any]:
        while "\n" not in self._buffer:
            data = await asyncio.wait_for(
                self.process.stdout.read(65536), TIMEOUT
            )
            assert data, "the channel closed"
            self._buffer += data
        line, self._buffer = self._buffer.split("\n", 1)
        return json.loads(line)

    def send(self, method: str, params: dict[str, Any] | None = None) -> int:
        self._id += 1
        self.process.stdin.write(
            json.dumps(
                {"id": self._id, "method": method, "params": params or {}}
            )
            + "\n"
        )
        return self._id

    async def response(self, request_id: int) -> dict[str, Any]:
        for note in self.notes:
            if note.get("id") == request_id and "method" not in note:
                self.notes.remove(note)
                return note
        while True:
            message = await self.receive()
            if message.get("id") == request_id and "method" not in message:
                return message
            self.notes.append(message)

    async def call(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return await self.response(self.send(method, params))

    async def result(
        self, method: str, params: dict[str, Any] | None = None
    ) -> Any:
        message = await self.call(method, params)
        assert "error" not in message, message
        return message["result"]

    async def error(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        message = await self.call(method, params)
        assert "error" in message, message
        return message["error"]

    async def note(self, method: str, process_id: str) -> dict[str, Any]:
        while True:
            for note in self.notes:
                params = note.get("params", {})
                if (
                    note["method"] == method
                    and params.get("processId") == process_id
                ):
                    self.notes.remove(note)
                    return params
            self.notes.append(await self.receive())

    async def start(self, process_id: str, script: str, **extra: Any) -> None:
        await self.result(
            "process/start",
            {
                "processId": process_id,
                "argv": ["/bin/bash", "-lc", script],
                "cwd": "file:///",
                "env": {},
                **extra,
            },
        )

    async def run(
        self, process_id: str, script: str, **extra: Any
    ) -> tuple[bytes, bytes, int]:
        await self.start(process_id, script, **extra)
        out, err = b"", b""
        while True:
            params = await self.note_any(process_id)
            if "chunk" in params:
                data = base64.b64decode(params["chunk"])
                if params["stream"] == "stderr":
                    err += data
                else:
                    out += data
            elif "exitCode" in params:
                return out, err, params["exitCode"]

    async def note_any(self, process_id: str) -> dict[str, Any]:
        while True:
            for note in self.notes:
                params = note.get("params", {})
                if params.get("processId") == process_id:
                    self.notes.remove(note)
                    return params
            self.notes.append(await self.receive())


@asynccontextmanager
async def codex(
    harness: SSHHarness, key: asyncssh.SSHKey | None = None
) -> AsyncIterator[CodexClient]:
    async with harness.connect(key=key) as conn:
        process = await conn.create_process(subsystem=CODEX_SUBSYSTEM)
        client = CodexClient(process)
        await client.result(
            "initialize", {"clientName": "test", "resumeSessionId": None}
        )
        process.stdin.write(json.dumps({"method": "initialized"}) + "\n")
        try:
            yield client
        finally:
            process.stdin.write_eof()
            await asyncio.wait_for(process.wait_closed(), TIMEOUT)


@pytest.mark.parametrize(
    ("uri", "path"),
    [
        ("file:///", "/"),
        ("file:///a/b/../c", "/a/c"),
        ("file:///a%20b", "/a b"),
        ("file:////twice", "/twice"),
    ],
)
def test_a_file_uri_is_a_normal_workspace_path(uri, path):
    assert to_path(uri) == path


@pytest.mark.parametrize("uri", ["/no/scheme", "http://x/y", "file:rel", 3])
def test_anything_but_an_absolute_file_uri_is_refused(uri):
    with pytest.raises(CodexRPCError) as info:
        to_path(uri)
    assert info.value.code == RPC_INVALID_PARAMS


def test_a_path_goes_back_out_quoted():
    assert to_uri("/a b/c") == "file:///a%20b/c"


@pytest.mark.parametrize(
    ("argv", "line"),
    [
        (["/usr/bin/bash", "-lc", "ls | wc -l"], "ls | wc -l"),
        (["sh", "-c", "echo hi"], "echo hi"),
        (["grep", "-n", "a b", "/f"], "grep -n 'a b' /f"),
        (["bash", "-c", "echo $1", "sh", "x"], "bash -c 'echo $1' sh x"),
    ],
)
def test_a_shell_script_runs_as_the_line(argv, line):
    assert argv_line(argv) == line


def test_env_lands_over_the_policy_set():
    params = {
        "env": {"A": "env", "C": "env"},
        "envPolicy": {"inherit": "all", "set": {"A": "set", "B": "set"}},
    }
    assert process_env(params) == {"A": "env", "B": "set", "C": "env"}


@pytest.mark.asyncio
async def test_initialize_names_the_session_and_its_shell(ssh):
    async with codex(ssh) as client:
        info = await client.result("environment/info")
    assert info == {
        "shell": {"name": "bash", "path": "/bin/bash"},
        "cwd": "file:///",
        "capabilities": {},
    }


@pytest.mark.asyncio
async def test_files_round_trip_and_the_shell_sees_them(ssh):
    async with codex(ssh) as client:
        await client.result(
            "fs/createDirectory", {"path": "file:///notes", "recursive": True}
        )
        await client.result(
            "fs/writeFile",
            {"path": "file:///notes/a.txt", "dataBase64": b64(b"hello\n")},
        )
        read = await client.result(
            "fs/readFile", {"path": "file:///notes/a.txt"}
        )
        out, _, code = await client.run("p1", "cat /notes/a.txt")
        meta = await client.result(
            "fs/getMetadata", {"path": "file:///notes/a.txt"}
        )
    assert base64.b64decode(read["dataBase64"]) == b"hello\n"
    assert (out, code) == (b"hello\n", 0)
    assert meta["isFile"] and not meta["isDirectory"]
    assert not meta["isSymlink"] and meta["size"] == 6


@pytest.mark.asyncio
async def test_a_file_larger_than_the_ssh_window_crosses_whole(ssh):
    data = bytes(range(256)) * (3 * 1024 * 4)
    async with codex(ssh) as client:
        await client.result(
            "fs/writeFile", {"path": "file:///big", "dataBase64": b64(data)}
        )
        read = await client.result("fs/readFile", {"path": "file:///big"})
    assert base64.b64decode(read["dataBase64"]) == data


@pytest.mark.asyncio
async def test_missing_paths_are_not_found(ssh):
    async with codex(ssh) as client:
        errors = [
            await client.error(method, {"path": "file:///nope"})
            for method in (
                "fs/getMetadata",
                "fs/readFile",
                "fs/readDirectory",
                "fs/canonicalize",
            )
        ]
        removed = await client.error(
            "fs/remove",
            {"path": "file:///nope", "recursive": False, "force": False},
        )
        forced = await client.result(
            "fs/remove",
            {"path": "file:///nope", "recursive": False, "force": True},
        )
    for error in [*errors, removed]:
        assert error["code"] == RPC_NOT_FOUND
        assert error["message"] == "No such file or directory"
    assert forced == {}


@pytest.mark.asyncio
async def test_file_errors_answer_as_the_exec_server_does(ssh):
    async with codex(ssh) as client:
        await client.run("seed", "mkdir -p /d/full && echo x > /d/full/f")
        not_file = await client.error("fs/readFile", {"path": "file:///d"})
        no_parent = await client.error(
            "fs/writeFile", {"path": "file:///new/f", "dataBase64": b64(b"x")}
        )
        exists = await client.error(
            "fs/createDirectory", {"path": "file:///d", "recursive": False}
        )
        mkdir_no_parent = await client.error(
            "fs/createDirectory", {"path": "file:///a/b", "recursive": False}
        )
        copy_tree = await client.error(
            "fs/copy",
            {
                "sourcePath": "file:///d",
                "destinationPath": "file:///e",
                "recursive": False,
            },
        )
        not_empty = await client.error(
            "fs/remove",
            {"path": "file:///d/full", "recursive": False, "force": False},
        )
    assert not_file == {
        "code": RPC_INVALID_REQUEST,
        "message": "path `/d` is not a file",
    }
    assert no_parent["code"] == RPC_NOT_FOUND
    assert exists == {"code": RPC_INTERNAL_ERROR, "message": "File exists"}
    assert mkdir_no_parent["code"] == RPC_NOT_FOUND
    assert copy_tree["code"] == RPC_INVALID_REQUEST
    assert "recursive: true" in copy_tree["message"]
    assert not_empty == {
        "code": RPC_INTERNAL_ERROR,
        "message": "Directory not empty",
    }


@pytest.mark.asyncio
async def test_trees_copy_and_remove_recursively(ssh):
    async with codex(ssh) as client:
        await client.run("seed", "mkdir -p /src/in && echo y > /src/in/f")
        await client.result(
            "fs/copy",
            {
                "sourcePath": "file:///src",
                "destinationPath": "file:///dst",
                "recursive": True,
            },
        )
        await client.result(
            "fs/remove",
            {"path": "file:///src", "recursive": True, "force": False},
        )
        out, _, _ = await client.run(
            "check", "cat /dst/in/f; test -e /src || echo gone"
        )
    assert out == b"y\ngone\n"


@pytest.mark.asyncio
async def test_a_directory_lists_each_entry_by_kind(ssh):
    async with codex(ssh) as client:
        await client.run("seed", "mkdir -p /w/sub && echo a > /w/a.txt")
        listing = await client.result(
            "fs/readDirectory", {"path": "file:///w"}
        )
        canonical = await client.result(
            "fs/canonicalize", {"path": "file:///w/sub/../a.txt"}
        )
    entries = sorted(listing["entries"], key=lambda e: e["fileName"])
    assert entries == [
        {"fileName": "a.txt", "isDirectory": False, "isFile": True},
        {"fileName": "sub", "isDirectory": True, "isFile": False},
    ]
    assert canonical == {"path": "file:///w/a.txt"}


@pytest.mark.asyncio
async def test_walk_goes_breadth_first_within_its_limits(ssh):
    async with codex(ssh) as client:
        await client.run(
            "seed",
            "mkdir -p /w/sub/deep && echo > /w/a.txt && "
            "echo > /w/sub/b.txt && echo > /w/sub/deep/c.txt",
        )

        async def walk(**options: Any) -> dict[str, Any]:
            return await client.result(
                "fs/walk",
                {"path": "file:///w", "options": {**WALK, **options}},
            )

        shallow = await walk(maxDepth=0)
        one = await walk(maxDepth=1)
        capped = await walk(maxEntries=1)
        rooted = await walk(maxDirectories=1)
        of_file = await client.result(
            "fs/walk", {"path": "file:///w/a.txt", "options": WALK}
        )
        zero = await client.error(
            "fs/walk",
            {"path": "file:///w", "options": {**WALK, "maxEntries": 0}},
        )

    def paths(result: dict[str, Any]) -> list[str]:
        return [e["path"].removeprefix("file:///w") for e in result["entries"]]

    assert paths(shallow) == ["/a.txt", "/sub"]
    assert paths(one) == ["/a.txt", "/sub", "/sub/b.txt", "/sub/deep"]
    assert shallow["truncated"] is False and shallow["errors"] == []
    assert (paths(capped), capped["truncated"]) == (["/a.txt"], True)
    assert (paths(rooted), rooted["truncated"]) == (["/a.txt", "/sub"], True)
    assert of_file == {"entries": [], "errors": [], "truncated": False}
    assert zero["code"] == RPC_INVALID_REQUEST


@pytest.mark.asyncio
async def test_a_handle_reads_a_file_in_blocks(ssh):
    async with codex(ssh) as client:
        await client.result(
            "fs/writeFile",
            {"path": "file:///f", "dataBase64": b64(b"hello\nworld\n")},
        )
        await client.result("fs/open", {"path": "file:///f", "handleId": "h"})
        again = await client.error(
            "fs/open", {"path": "file:///f", "handleId": "h"}
        )
        first = await client.result(
            "fs/readBlock", {"handleId": "h", "offset": 0, "len": 5}
        )
        last = await client.result(
            "fs/readBlock", {"handleId": "h", "offset": 10, "len": 50}
        )
        await client.result("fs/close", {"handleId": "h"})
        await client.result("fs/close", {"handleId": "h"})
        gone = await client.error(
            "fs/readBlock", {"handleId": "h", "offset": 0, "len": 1}
        )
    assert again["code"] == RPC_INVALID_REQUEST
    assert (base64.b64decode(first["chunk"]), first["eof"]) == (
        b"hello",
        False,
    )
    assert (base64.b64decode(last["chunk"]), last["eof"]) == (b"d\n", True)
    assert gone["code"] == RPC_NOT_FOUND


@pytest.mark.asyncio
async def test_a_process_streams_its_output_then_exits(ssh):
    async with codex(ssh) as client:
        await client.start("p", "echo out; echo err >&2; exit 3")
        out = await client.note("process/output", "p")
        err = await client.note("process/output", "p")
        exited = await client.note("process/exited", "p")
        closed = await client.note("process/closed", "p")
        read = await client.result(
            "process/read", {"processId": "p", "afterSeq": 0}
        )
        after = await client.result(
            "process/read", {"processId": "p", "afterSeq": 2}
        )
        stopped = await client.result("process/terminate", {"processId": "p"})
    assert (out["seq"], out["stream"]) == (1, "stdout")
    assert base64.b64decode(out["chunk"]) == b"out\n"
    assert (err["seq"], err["stream"]) == (2, "stderr")
    assert exited == {
        "processId": "p",
        "seq": 3,
        "exitCode": 3,
        "sandboxDenied": False,
    }
    assert closed == {"processId": "p", "seq": 4}
    assert [c["seq"] for c in read["chunks"]] == [1, 2]
    assert read["nextSeq"] == 5 and read["exited"] and read["closed"]
    assert read["exitCode"] == 3 and after["chunks"] == []
    assert stopped == {"running": False}


@pytest.mark.asyncio
async def test_a_terminal_process_reports_one_stream(ssh):
    async with codex(ssh) as client:
        out, err, code = await client.run("t", "echo a; echo b >&2", tty=True)
        streams = {n["params"].get("stream") for n in client.notes}
    assert (out, err, code) == (b"a\nb\n", b"", 0)
    assert streams <= {None, "pty"}


@pytest.mark.asyncio
async def test_a_process_runs_in_its_cwd_with_its_env(ssh):
    async with codex(ssh) as client:
        await client.run("seed", "mkdir -p /work")
        out, _, _ = await client.run(
            "p", "pwd; echo $FOO", cwd="file:///work", env={"FOO": "bar"}
        )
        home, _, _ = await client.run("q", "pwd; echo ${FOO:-unset}")
    assert out == b"/work\nbar\n"
    assert home == b"/\nunset\n"


@pytest.mark.asyncio
async def test_a_piped_process_reads_what_codex_writes(ssh):
    async with codex(ssh) as client:
        await client.start("p", "read x; echo got:$x", pipeStdin=True)
        status = await client.result(
            "process/write",
            {"processId": "p", "writeId": "w1", "chunk": b64(b"hi\n")},
        )
        out = await client.note("process/output", "p")
        closed = await client.run("q", "cat")
        refused = await client.result(
            "process/write",
            {"processId": "q", "writeId": "w2", "chunk": b64(b"x")},
        )
        unknown = await client.result(
            "process/write",
            {"processId": "nope", "writeId": "w3", "chunk": ""},
        )
    assert status == {"status": "accepted"}
    assert base64.b64decode(out["chunk"]) == b"got:hi\n"
    assert closed == (b"", b"", 0)
    assert refused == {"status": "stdinClosed"}
    assert unknown == {"status": "unknownProcess"}


@pytest.mark.asyncio
async def test_interrupt_and_terminate_stop_a_process(ssh):
    async with codex(ssh) as client:
        await client.start("i", "sleep 30")
        bad = await client.error(
            "process/signal", {"processId": "i", "signal": "kill"}
        )
        await client.result(
            "process/signal", {"processId": "i", "signal": "interrupt"}
        )
        interrupted = await client.note("process/exited", "i")
        await client.start("t", "sleep 30")
        running = await client.result("process/terminate", {"processId": "t"})
        terminated = await client.note("process/exited", "t")
        await client.start("c", "sleep 30", tty=True)
        await client.result(
            "process/write",
            {"processId": "c", "writeId": "w", "chunk": b64(b"\x03")},
        )
        ctrl_c = await client.note("process/exited", "c")
    assert bad["code"] == RPC_INVALID_PARAMS
    assert interrupted["exitCode"] == 130
    assert running == {"running": True}
    assert terminated["exitCode"] == -1
    assert ctrl_c["exitCode"] == 130


@pytest.mark.asyncio
async def test_a_waiting_read_does_not_hold_up_a_signal(ssh):
    async with codex(ssh) as client:
        await client.start("s", "sleep 30")
        read_id = client.send(
            "process/read", {"processId": "s", "afterSeq": 0, "waitMs": 20000}
        )
        started = time.monotonic()
        await client.result(
            "process/signal", {"processId": "s", "signal": "interrupt"}
        )
        read = await client.response(read_id)
        waited = time.monotonic() - started
    assert waited < 10
    assert read["result"]["exited"] and read["result"]["exitCode"] == 130


@pytest.mark.asyncio
async def test_a_terminated_process_is_forgotten(ssh):
    async with codex(ssh) as client:
        await client.run("p", "echo once")
        await client.note("process/closed", "p")
        await client.result("process/terminate", {"processId": "p"})
        gone = await client.error("process/read", {"processId": "p"})
        again, _, _ = await client.run("p", "echo twice")
        await client.start("t", "sleep 30")
        await client.result("process/terminate", {"processId": "t"})
        await client.note("process/closed", "t")
        stopped = await client.error("process/read", {"processId": "t"})
    assert gone["code"] == RPC_INVALID_REQUEST
    assert again == b"twice\n"
    assert stopped["code"] == RPC_INVALID_REQUEST


@pytest.mark.asyncio
async def test_output_kept_for_reads_is_bounded(ssh):
    async with codex(ssh) as client:
        out, _, code = await client.run("big", "seq 1 300000")
        read = await client.result("process/read", {"processId": "big"})
    kept = sum(len(base64.b64decode(c["chunk"])) for c in read["chunks"])
    assert code == 0 and len(out) > CODEX_RETAINED_OUTPUT
    assert out.endswith(b"299999\n300000\n")
    assert kept <= CODEX_RETAINED_OUTPUT


@pytest.mark.asyncio
async def test_process_ids_are_checked(ssh):
    async with codex(ssh) as client:
        await client.run("p", "true")
        dup = await client.error(
            "process/start",
            {"processId": "p", "argv": ["true"], "cwd": "file:///", "env": {}},
        )
        unknown = await client.error("process/read", {"processId": "nope"})
        gone = await client.result("process/terminate", {"processId": "nope"})
    assert dup == {
        "code": RPC_INVALID_REQUEST,
        "message": "process p already exists",
    }
    assert unknown == {
        "code": RPC_INVALID_REQUEST,
        "message": "unknown process id nope",
    }
    assert gone == {"running": False}


@pytest.mark.asyncio
async def test_unknown_methods_and_bad_params_are_refused(ssh):
    async with codex(ssh) as client:
        unknown = await client.error("http/request")
        missing = await client.error("fs/getMetadata")
        relative = await client.error("fs/getMetadata", {"path": "/x"})
        client.process.stdin.write("{nope\n")
        parse = await client.receive()
    assert unknown["code"] == RPC_METHOD_NOT_FOUND
    assert missing == {
        "code": RPC_INVALID_PARAMS,
        "message": "missing field `path`",
    }
    assert relative["code"] == RPC_INVALID_PARAMS
    assert parse["id"] is None and parse["error"]["code"] == -32700


@pytest.mark.asyncio
async def test_commands_land_in_history(ssh):
    async with codex(ssh) as client:
        await client.run("p", "echo from-codex")
        await client.result(
            "fs/writeFile", {"path": "file:///quiet", "dataBase64": b64(b"x")}
        )
        out, _, _ = await client.run("h", "cat /.bash_history")
    assert b"echo from-codex" in out
    assert b"quiet" not in out


@pytest.mark.asyncio
async def test_a_read_only_mount_refuses_writes(ssh_readonly):
    async with codex(ssh_readonly) as client:
        error = await client.error(
            "fs/writeFile", {"path": "file:///nope", "dataBase64": b64(b"x")}
        )
    assert error["code"] == RPC_INTERNAL_ERROR


@pytest.mark.asyncio
async def test_codex_runs_under_the_key_profile(tmp_path):
    harness = await start_harness(tmp_path, await vault_workspace())
    guarded = bind_key(harness, 'mirage-profile="guarded"')
    try:
        async with codex(harness) as client:
            opened = await client.result(
                "fs/readFile", {"path": "file:///vault/secret"}
            )
        async with codex(harness, key=guarded) as client:
            refused = await client.error(
                "fs/readFile", {"path": "file:///vault/secret"}
            )
            _, err, code = await client.run("p", "cat /vault/secret")
    finally:
        await stop_harness(harness)
    assert base64.b64decode(opened["dataBase64"]) == b"token\n"
    assert refused["code"] == RPC_INTERNAL_ERROR
    assert code != 0 and err


@pytest.mark.asyncio
async def test_the_session_is_closed_on_exit(ssh):
    async with codex(ssh) as client:
        await client.run("p", "true")
    await asyncio.sleep(0.2)
    ids = [s.session_id for s in ssh.entry.runner.ws.list_sessions()]
    assert not [sid for sid in ids if sid.startswith("ssh_")]


@pytest.mark.asyncio
async def test_an_unknown_workspace_is_refused(ssh):
    async with ssh.connect(username="nope") as conn:
        process = await conn.create_process(subsystem=CODEX_SUBSYSTEM)
        await asyncio.wait_for(process.wait_closed(), TIMEOUT)
        err = await process.stderr.read()
    assert process.exit_status == 1
    assert "no such workspace: nope" in err


@pytest.mark.asyncio
async def test_other_subsystems_are_still_refused(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process(subsystem="netconf")
        await asyncio.wait_for(process.wait_closed(), TIMEOUT)
        err = await process.stderr.read()
    assert process.exit_status == 1
    assert "unsupported subsystem: netconf" in err
