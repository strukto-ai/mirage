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

import pytest

from mirage.core.jq import is_streamable_jsonl_expr
from mirage.core.ram.read import read_bytes
from mirage.observe.context import start_recording, stop_recording
from mirage.resource.disk.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

from .conftest import (SAMPLE_JSONL, collect, jq, mem_ws, run_raw,
                       write_to_backend)


class TestJqJsonl:

    def test_jsonl_file_dot(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq(backend, "/tmp/data.jsonl", ".")
        assert isinstance(result, list)
        assert len(result) == 3
        assert result[0]["name"] == "alice"

    def test_jsonl_file_length(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq(backend, "/tmp/data.jsonl", "length")
        assert result == 3

    def test_jsonl_file_select(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq(backend, "/tmp/data.jsonl", ".[] | select(.age > 28)")
        assert len(result) == 2
        assert result[0]["name"] == "alice"
        assert result[1]["name"] == "carol"

    def test_jsonl_file_map(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq(backend, "/tmp/data.jsonl", "map(.name)")
        assert result == ["alice", "bob", "carol"]

    def test_jsonl_file_iteration(self, backend):
        write_to_backend(backend, "/tmp/data.jsonl", SAMPLE_JSONL)
        result = jq(backend, "/tmp/data.jsonl", ".[] | .name")
        assert result == ["alice", "bob", "carol"]

    def test_ndjson_extension(self, backend):
        write_to_backend(backend, "/tmp/data.ndjson", SAMPLE_JSONL)
        result = jq(backend, "/tmp/data.ndjson", "length")
        assert result == 3

    def test_json_extension_not_jsonl(self, backend):
        write_to_backend(backend, "/tmp/data.json", SAMPLE_JSONL)
        with pytest.raises(json.JSONDecodeError):
            jq(backend, "/tmp/data.json", ".")

    def test_jsonl_stdin_fallback(self):
        ws = mem_ws()
        stdout, _ = run_raw(ws, "jq length", stdin=SAMPLE_JSONL)
        result = json.loads(collect(stdout))
        assert result == 3

    def test_json_stdin_unchanged(self):
        ws = mem_ws()
        stdout, _ = run_raw(ws, "jq .name", stdin=b'{"name": "stdin-json"}')
        result = json.loads(collect(stdout))
        assert result == "stdin-json"

    def test_jsonl_memory_backend(self):
        ws = mem_ws({"/data.jsonl": SAMPLE_JSONL})
        stdout, _ = run_raw(ws, "jq '.[] | .name' /data/data.jsonl")
        raw = collect(stdout).decode()
        result = [
            json.loads(line) for line in raw.strip().splitlines()
            if line.strip()
        ]
        assert result == ["alice", "bob", "carol"]

    def test_jsonl_disk_backend(self, tmp_path):
        (tmp_path / "data.jsonl").write_bytes(SAMPLE_JSONL)
        disk = DiskResource(str(tmp_path))
        ws = Workspace(
            {"/disk": (disk, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )
        stdout, _ = run_raw(ws, "jq length /disk/data.jsonl")
        raw = collect(stdout).decode().strip()
        results = [json.loads(line) for line in raw.splitlines() if line]
        assert results == [2, 2, 2]


class TestJqStreamableDetection:

    def test_array_iter_is_streamable(self):
        assert is_streamable_jsonl_expr(".[]") is True

    def test_array_iter_pipe_is_streamable(self):
        assert is_streamable_jsonl_expr(".[] | .name") is True

    def test_array_iter_select_is_streamable(self):
        assert is_streamable_jsonl_expr('.[] | select(.x > 1)') is True

    def test_length_not_streamable(self):
        assert is_streamable_jsonl_expr("length") is False

    def test_map_not_streamable(self):
        assert is_streamable_jsonl_expr("map(.x)") is False

    def test_sort_not_streamable(self):
        assert is_streamable_jsonl_expr("sort") is False

    def test_dot_not_streamable(self):
        assert is_streamable_jsonl_expr(".") is False

    def test_first_not_streamable(self):
        assert is_streamable_jsonl_expr("first") is False


class TestJqStreamingVerification:

    def _make_large_jsonl(self, n: int = 100) -> bytes:
        lines = []
        for i_ln in range(n):
            lines.append(json.dumps({"id": i_ln, "name": f"item-{i_ln}"}))
        return ("\n".join(lines) + "\n").encode()

    def _ws_with_jsonl(self, data: bytes) -> Workspace:
        mem = RAMResource()
        mem.accessor.store.files["/data.jsonl"] = data
        return Workspace(
            {"/m": (mem, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )

    def test_jsonl_streaming_produces_correct_output(self):
        data = self._make_large_jsonl(50)
        ws = self._ws_with_jsonl(data)
        stdout, _ = run_raw(ws, "jq '.[] | .name' /m/data.jsonl")
        raw = collect(stdout).decode()
        lines = [x for x in raw.strip().splitlines() if x.strip()]
        assert len(lines) == 50
        assert '"item-0"' in lines[0]
        assert '"item-49"' in lines[-1]

    def test_jsonl_non_streamable_reads_full(self):
        data = self._make_large_jsonl(100)
        mem = RAMResource()
        mem.accessor.store.files["/data.jsonl"] = data
        records = start_recording()
        accessor = mem.accessor
        asyncio.run(read_bytes(accessor, "/data.jsonl"))
        stop_recording()
        assert len(records) == 1
        assert records[0].bytes == len(data)

    def test_json_always_reads_full(self):
        data = json.dumps({"a": 1}).encode()
        mem = RAMResource()
        mem.accessor.store.files["/f.json"] = data
        records = start_recording()
        accessor = mem.accessor
        asyncio.run(read_bytes(accessor, "/f.json"))
        stop_recording()
        assert len(records) == 1
        assert records[0].bytes == len(data)

    def test_jsonl_select_streaming_correct(self):
        data = self._make_large_jsonl(100)
        ws = self._ws_with_jsonl(data)
        stdout, _ = run_raw(ws, "jq '.[] | select(.id > 95)' /m/data.jsonl")
        raw = collect(stdout).decode()
        lines = [json.loads(x) for x in raw.strip().splitlines() if x.strip()]
        assert len(lines) == 4
        assert all(item["id"] > 95 for item in lines)

    def test_disk_jsonl_streaming(self, tmp_path):
        data = self._make_large_jsonl(50)
        (tmp_path / "data.jsonl").write_bytes(data)
        disk = DiskResource(str(tmp_path))
        ws = Workspace(
            {"/d": (disk, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )
        stdout, _ = run_raw(ws, "jq '.[] | .id' /d/data.jsonl")
        raw = collect(stdout).decode()
        lines = [x for x in raw.strip().splitlines() if x.strip()]
        assert len(lines) == 50


class TestJqPlanDryRun:

    def _plan_ws(self, filename: str, data: bytes) -> Workspace:
        mem = RAMResource()
        mem.accessor.store.files["/" + filename] = data
        return Workspace(
            {"/m": (mem, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )

    def test_plan_json_full_read(self):
        data = json.dumps({"a": 1, "b": 2}).encode()
        ws = self._plan_ws("f.json", data)
        result = asyncio.run(ws.execute("jq .a /m/f.json", provision=True))
        assert result.network_read_high == len(data)
        assert result.network_read_low == len(data)

    def test_plan_jsonl_streamable_range(self):
        lines = [json.dumps({"x": i}) for i in range(100)]
        data = ("\n".join(lines) + "\n").encode()
        ws = self._plan_ws("data.jsonl", data)
        result = asyncio.run(
            ws.execute("jq '.[] | .x' /m/data.jsonl", provision=True))
        assert result.network_read_low == 0
        assert result.network_read_high == len(data)

    def test_plan_jsonl_non_streamable_full(self):
        lines = [json.dumps({"x": i}) for i in range(100)]
        data = ("\n".join(lines) + "\n").encode()
        ws = self._plan_ws("data.jsonl", data)
        result = asyncio.run(
            ws.execute("jq length /m/data.jsonl", provision=True))
        assert result.network_read_low == len(data)
        assert result.network_read_high == len(data)
