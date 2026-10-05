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
import json

from mirage.core.ram.read import read
from mirage.observe.context import RecordingScope
from mirage.types import MountMode, PathSpec
from mirage.vfs.disk.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

from .conftest import (
    SAMPLE_JSONL,
    collect,
    jq_all,
    jq_slurp,
    jq_slurp_all,
    mem_ws,
    run_raw,
    write_to_backend,
)


class TestJqJsonl:
    """A JSON Lines file is a stream of documents: the program runs on each
    line unchanged, as jq runs it, and `-s` collects the lines into one
    array."""

    def test_jsonl_file_dot(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq_all(backend, "/tmp/data.jsonl", ".")
        assert [row["name"] for row in result] == ["alice", "bob", "carol"]

    def test_jsonl_file_length_is_each_lines_own(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        assert jq_all(backend, "/tmp/data.jsonl", "length") == [2, 2, 2]
        assert jq_slurp(backend, "/tmp/data.jsonl", "length") == 3

    def test_jsonl_file_select(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq_all(backend, "/tmp/data.jsonl", "select(.age > 28)")
        assert [row["name"] for row in result] == ["alice", "carol"]
        slurped = jq_slurp_all(
            backend, "/tmp/data.jsonl", ".[] | select(.age > 28)"
        )
        assert slurped == result

    def test_jsonl_file_map_over_the_slurped_lines(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq_slurp(backend, "/tmp/data.jsonl", "map(.name)")
        assert result == ["alice", "bob", "carol"]

    def test_jsonl_iteration_walks_each_lines_values(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        assert jq_all(backend, "/tmp/data.jsonl", ".[]") == [
            "alice",
            30,
            "bob",
            25,
            "carol",
            35,
        ]
        assert jq_all(backend, "/tmp/data.jsonl", ".name") == [
            "alice",
            "bob",
            "carol",
        ]

    def test_ndjson_extension(self, backend):
        write_to_backend(backend, "/tmp/data.ndjson", SAMPLE_JSONL)
        assert jq_all(backend, "/tmp/data.ndjson", "length") == [2, 2, 2]

    def test_the_extension_does_not_decide_how_a_file_reads(self, backend):
        write_to_backend(backend, "/tmp/data.json", SAMPLE_JSONL)
        assert jq_all(backend, "/tmp/data.json", "length") == [2, 2, 2]

    def test_jsonl_stdin_is_a_value_stream(self):
        # jq applies the program to each document on stdin, so `length` is
        # each object's own key count, not the number of documents. Verified
        # against the jq binary: three 2-key objects print "2" three times.
        ws = mem_ws()
        stdout, _ = run_raw(ws, "jq length", stdin=SAMPLE_JSONL)
        lines = collect(stdout).decode().strip().splitlines()
        assert [json.loads(line) for line in lines] == [2, 2, 2]

    def test_json_stdin_unchanged(self):
        ws = mem_ws()
        stdout, _ = run_raw(ws, "jq .name", stdin=b'{"name": "stdin-json"}')
        result = json.loads(collect(stdout))
        assert result == "stdin-json"

    def test_jsonl_memory_backend(self):
        ws = mem_ws({"/data.jsonl": SAMPLE_JSONL})
        stdout, _ = run_raw(ws, "jq -c '.[]' /data/data.jsonl")
        assert collect(stdout) == b'"alice"\n30\n"bob"\n25\n"carol"\n35\n'
        stdout, _ = run_raw(ws, "jq '.name' /data/data.jsonl")
        assert collect(stdout) == b'"alice"\n"bob"\n"carol"\n'

    def test_jsonl_errors_per_line_and_goes_on(self):
        ws = mem_ws({"/data.jsonl": SAMPLE_JSONL})
        stdout, io = run_raw(ws, "jq '.[] | .name' /data/data.jsonl")
        assert collect(stdout) == b""
        assert io.exit_code == 5
        stderr = asyncio.run(io.stderr_str())
        assert stderr.splitlines() == [
            "jq: error (at /data/data.jsonl:1): Cannot index string with "
            'string ("name")',
            "jq: error (at /data/data.jsonl:2): Cannot index string with "
            'string ("name")',
            "jq: error (at /data/data.jsonl:3): Cannot index string with "
            'string ("name")',
        ]

    def test_jsonl_disk_backend(self, tmp_path):
        (tmp_path / "data.jsonl").write_bytes(SAMPLE_JSONL)
        disk = DiskVFS(str(tmp_path))
        ws = Workspace(
            {"/disk": (disk, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )
        stdout, _ = run_raw(ws, "jq length /disk/data.jsonl")
        raw = collect(stdout).decode().strip()
        results = [json.loads(line) for line in raw.splitlines() if line]
        assert results == [2, 2, 2]


class TestJqStreamingVerification:
    def _make_large_jsonl(self, n: int = 100) -> bytes:
        lines = []
        for i_ln in range(n):
            lines.append(json.dumps({"id": i_ln, "name": f"item-{i_ln}"}))
        return ("\n".join(lines) + "\n").encode()

    def _ws_with_jsonl(self, data: bytes) -> Workspace:
        mem = RAMVFS()
        mem.accessor.store.files["/data.jsonl"] = data
        return Workspace(
            {"/m": (mem, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )

    def test_jsonl_streaming_produces_correct_output(self):
        data = self._make_large_jsonl(50)
        ws = self._ws_with_jsonl(data)
        stdout, _ = run_raw(ws, "jq '.name' /m/data.jsonl")
        raw = collect(stdout).decode()
        lines = [x for x in raw.strip().splitlines() if x.strip()]
        assert len(lines) == 50
        assert '"item-0"' in lines[0]
        assert '"item-49"' in lines[-1]

    def test_jsonl_non_streamable_reads_full(self):
        data = self._make_large_jsonl(100)
        mem = RAMVFS()
        mem.accessor.store.files["/data.jsonl"] = data
        scope = RecordingScope()
        records = scope.records
        accessor = mem.accessor
        asyncio.run(read(accessor, PathSpec.from_str_path("/data.jsonl")))
        scope.close()
        assert len(records) == 1
        assert records[0].bytes == len(data)

    def test_json_always_reads_full(self):
        data = json.dumps({"a": 1}).encode()
        mem = RAMVFS()
        mem.accessor.store.files["/f.json"] = data
        scope = RecordingScope()
        records = scope.records
        accessor = mem.accessor
        asyncio.run(read(accessor, PathSpec.from_str_path("/f.json")))
        scope.close()
        assert len(records) == 1
        assert records[0].bytes == len(data)

    def test_jsonl_select_streaming_correct(self):
        data = self._make_large_jsonl(100)
        ws = self._ws_with_jsonl(data)
        # -c so each surviving document is one line; the streaming path
        # pretty-prints by default, like jq itself.
        stdout, _ = run_raw(ws, "jq -c 'select(.id > 95)' /m/data.jsonl")
        raw = collect(stdout).decode()
        lines = [json.loads(x) for x in raw.strip().splitlines() if x.strip()]
        assert len(lines) == 4
        assert all(item["id"] > 95 for item in lines)

    def test_jsonl_streaming_pretty_prints_by_default(self):
        data = self._make_large_jsonl(3)
        ws = self._ws_with_jsonl(data)
        stdout, _ = run_raw(ws, "jq 'select(.id > 0)' /m/data.jsonl")
        raw = collect(stdout).decode()
        assert raw.startswith("{\n  ")
        assert raw.count("\n}\n") == 2

    def test_disk_jsonl_streaming(self, tmp_path):
        data = self._make_large_jsonl(50)
        (tmp_path / "data.jsonl").write_bytes(data)
        disk = DiskVFS(str(tmp_path))
        ws = Workspace(
            {"/d": (disk, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )
        stdout, _ = run_raw(ws, "jq '.id' /d/data.jsonl")
        raw = collect(stdout).decode()
        lines = [x for x in raw.strip().splitlines() if x.strip()]
        assert len(lines) == 50
