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
import time
from pathlib import Path

from mirage.commands.builtin.generic.jq import FRAME_OUTPUT, read_frames
from mirage.core.jq import InputSource, JqError, read_texts
from mirage.io.stream import yield_bytes
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.commands.builtin.conftest import run_raw as run_raw


def _norm(path):
    return "/" + path.strip("/")


def write_to_backend(backend, path, data):
    store = backend.accessor.store
    store.files[_norm(path)] = data


def jq_eval(obj: object, expr: str) -> list[object]:
    """Every output of a jq program on one value (see jq_texts).

    Args:
        obj (object): JSON-like input value.
        expr (str): jq program text.

    Raises:
        ValueError: jq's refusal of the program, or the error that ended
            the run.
    """
    return jq_texts(json.dumps(obj), expr)


def jq_texts(text: str, expr: str) -> list[object]:
    """Every output of a jq program on one document's JSON text, run to
    its end in mirage-rs's jq_eval, with no input left to read.

    Args:
        text (str): the document, as jq reads it.
        expr (str): jq program text.

    Raises:
        ValueError: jq's refusal of the program, or the error that ended
            the run.
    """
    try:
        stream = open_stream("jq_eval", {"program": expr, "env": "{}"})
    except StreamRefusal as exc:
        raise ValueError(exc.message) from exc
    position = {"filename": None, "line": 0}
    stream.begin(position)
    frames: list[tuple[int, str]] = []
    stop = read_frames(stream.feed(text.encode()), frames)
    stop = read_frames(stream.finish(), frames) or stop
    while True:
        if stream.busy():
            wire = stream.drain()
        elif (asked := stream.request()) is not None:
            if asked[0].get("op") == "now":
                reply = {"kind": "now", "now": time.time()}
            else:
                reply = {"kind": "end", **position}
            wire = stream.respond(reply, b"")
        else:
            break
        stop = read_frames(wire, frames) or stop
    if isinstance(stop, JqError):
        raise ValueError(stop.text)
    return [json.loads(out) for tag, out in frames if tag == FRAME_OUTPUT]


def eval_one(obj: object, expr: str) -> object:
    """Evaluate expr and return its single output.

    jq_eval keeps every output, so a program that emits one value still
    comes back as a one-element list. Tests of single-valued programs go
    through here, which asserts the arity instead of assuming it.

    Args:
        obj (object): JSON-like input value.
        expr (str): jq program text.
    """
    outputs = jq_eval(obj, expr.strip())
    assert len(outputs) == 1
    return outputs[0]


def documents(backend, path):
    """Every document of a file, as jq reads a stream of them.

    Args:
        backend: the mount holding the file.
        path (str): the file.
    """
    store = backend.accessor.store
    source = InputSource(path, yield_bytes(store.files[_norm(path)]))
    texts, failure = asyncio.run(read_texts(source))
    assert failure is None, failure
    return [json.loads(text) for text in texts]


def jq_all(backend, path, expression):
    """Every output of a program run on each document of a file in turn,
    the way jq runs it."""
    return [
        output
        for doc in documents(backend, path)
        for output in jq_eval(doc, expression.strip())
    ]


def jq(backend, path, expression):
    outputs = jq_all(backend, path, expression)
    assert len(outputs) == 1
    return outputs[0]


def jq_slurp_all(backend, path, expression):
    """Every output of a program run once on a file's documents collected
    into one array, the way `jq -s` runs it."""
    return jq_eval(documents(backend, path), expression.strip())


def jq_slurp(backend, path, expression):
    outputs = jq_slurp_all(backend, path, expression)
    assert len(outputs) == 1
    return outputs[0]


def mem_ws(files: dict[str, bytes] | None = None) -> Workspace:
    mem = RAMVFS()
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


SAMPLE_JSONL = (
    b'{"name": "alice", "age": 30}\n'
    b'{"name": "bob", "age": 25}\n'
    b'{"name": "carol", "age": 35}\n'
)

DATA_DIR = Path(__file__).resolve().parents[5] / "data"
EXAMPLE_JSON = DATA_DIR / "example.json"
EXAMPLE_JSONL = DATA_DIR / "example.jsonl"
