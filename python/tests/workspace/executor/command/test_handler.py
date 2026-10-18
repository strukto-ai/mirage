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

import pytest

from mirage.commands.errors import PartialOutputError, UsageError
from mirage.errors.fs import enoent
from mirage.io import IOResult
from mirage.io.errors import PipeClosed
from mirage.io.types import materialize
from mirage.types import PathSpec, Producer
from mirage.workspace.executor.command.handler import (
    cli_voice,
    mount_voice,
    run_handler,
)

PRODUCER = Producer(command="cat", prefixes=("/data/",))
MOUNT = mount_voice("cat", [])
LEAF = cli_voice("gh")
TYPED = mount_voice("cat", [PathSpec.from_str_path("notes.md", cwd="/data")])

pytestmark = pytest.mark.asyncio


async def _answer(stdout):
    return stdout, IOResult()


async def _raise(error):
    raise error


async def _stream(*chunks, error=None):
    for chunk in chunks:
        yield chunk
    if error is not None:
        raise error


def _run(body, voice=LEAF, **kwargs):
    return run_handler(body, "x", None, PRODUCER, voice, **kwargs)


class Drops:
    def __init__(self):
        self.count = 0

    async def __call__(self):
        self.count += 1


@pytest.mark.parametrize(
    "error,voice,code,stderr",
    [
        (UsageError("bad", 2), LEAF, 2, b"bad\n"),
        (RuntimeError("boom"), LEAF, 1, b"gh: boom\n"),
        (
            enoent("/data/notes.md"),
            TYPED,
            1,
            b"cat: notes.md: No such file or directory\n",
        ),
    ],
)
async def test_a_failure_drops_and_is_worded_in_the_callers_voice(
    error, voice, code, stderr
):
    drops = Drops()
    out, io = await _run(_raise(error), voice, drop=drops)
    assert (out, io.exit_code, io.stderr, io.producer) == (
        None,
        code,
        stderr,
        None,
    )
    assert drops.count == 1


async def test_a_closed_pipe_from_a_mount_reaches_the_executor_after_the_drop():
    drops = Drops()
    with pytest.raises(PipeClosed):
        await _run(_raise(PipeClosed()), MOUNT, drop=drops)
    assert drops.count == 1


@pytest.mark.parametrize(
    "lazy,frame,early",
    [
        (True, True, False),
        (True, False, False),
        (True, True, True),
        (False, True, False),
    ],
    ids=["framed", "unframed", "closed", "bytes"],
)
async def test_a_write_drops_once_answered_and_again_once_its_stream_ends(
    lazy, frame, early
):
    drops = Drops()
    stdout = _stream(b"a\n", b"b\n") if lazy else b"a\nb\n"
    out, _ = await _run(_answer(stdout), drop=drops, frame=frame)
    assert drops.count == 1
    if early:
        assert await anext(out) == b"a\n"
        await out.aclose()
    else:
        assert await materialize(out) == b"a\nb\n"
    assert drops.count == (2 if lazy else 1)


@pytest.mark.parametrize(
    "voice,error,stdout,stderr",
    [
        (MOUNT, RuntimeError("lost"), b"a\n", b"cat: lost\n"),
        (LEAF, PartialOutputError("cut", b"b\n"), b"a\nb\n", b"gh: cut\n"),
    ],
)
async def test_an_answer_carries_the_producer_and_words_a_deferred_failure(
    voice, error, stdout, stderr
):
    out, io = await _run(_answer(_stream(b"a\n", error=error)), voice)
    assert io.producer is PRODUCER
    assert await materialize(out) == stdout
    assert (io.exit_code, io.stderr) == (1, stderr)
