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
from pathlib import Path

from mirage.core.jq import jq_eval, parse_json_path
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _norm(path):
    return "/" + path.strip("/")


def write_to_backend(backend, path, data):
    store = backend.accessor.store
    store.files[_norm(path)] = data


def eval_one(obj: object, expr: str) -> object:
    """Evaluate expr and return its single output.

    jq_eval is arity-preserving, so a program that emits one value still
    comes back as a one-element list. Tests of single-valued programs go
    through here, which asserts the arity instead of assuming it.

    Args:
        obj (object): JSON-like input value.
        expr (str): jq program text.
    """
    outputs = jq_eval(obj, expr.strip())
    assert len(outputs) == 1
    return outputs[0]


def jq_all(backend, path, expression):
    store = backend.accessor.store
    data = parse_json_path(store.files[_norm(path)], path)
    return jq_eval(data, expression.strip())


def jq(backend, path, expression):
    outputs = jq_all(backend, path, expression)
    assert len(outputs) == 1
    return outputs[0]


def mem_ws(files: dict[str, bytes] | None = None) -> Workspace:
    mem = RAMResource()
    if files:
        store = mem.accessor.store
        for path, data in files.items():
            p = _norm(path)
            parts = p.strip("/").split("/")
            current = ""
            for part in parts[:-1]:
                current += "/" + part
                store.dirs.add(current)
            store.files[p] = data
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


def run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.execute(cmd, stdin=stdin))
    return io.stdout, io


async def drain_async(stream):
    return b"".join([chunk async for chunk in stream])


def collect(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    if hasattr(stdout, "__aiter__"):
        return asyncio.run(drain_async(stdout))
    return b"".join(stdout)


SAMPLE_JSONL = (b'{"name": "alice", "age": 30}\n'
                b'{"name": "bob", "age": 25}\n'
                b'{"name": "carol", "age": 35}\n')

DATA_DIR = Path(__file__).resolve().parents[5] / "data"
EXAMPLE_JSON = DATA_DIR / "example.json"
EXAMPLE_JSONL = DATA_DIR / "example.jsonl"
