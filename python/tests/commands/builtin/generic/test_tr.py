import asyncio

import pytest

from mirage.commands.builtin.generic.tr import tr_engine, tr_generic
from mirage.io.stream import materialize
from mirage.io.types import IOResult


def _unused_read_stream(_path):
    raise AssertionError("read_stream should not be called for stdin input")


def _output(texts, flags, data):
    engine = tr_engine(texts, flags)
    assert not isinstance(engine, IOResult)
    source, _ = tr_generic(
        engine, [], read_stream=_unused_read_stream, stdin=data
    )
    return source


async def _run(texts, flags, data):
    return await materialize(_output(texts, flags, data))


async def _refusal(texts, flags):
    refused = tr_engine(texts, flags)
    assert isinstance(refused, IOResult)
    return refused.exit_code, (await materialize(refused.stderr)).decode()


@pytest.mark.asyncio
async def test_default_pads_set2_to_set1_length():
    out = await _run(["abcde", "xy"], {}, b"abcde")
    assert out == b"xyyyy"


@pytest.mark.asyncio
async def test_complement_long_form():
    comp = await _run(["0-9", "_"], {"complement": True}, b"abc123")
    assert comp == b"___123"


@pytest.mark.asyncio
async def test_delete_without_squeeze_names_the_second_operand_as_extra():
    assert await _refusal(["a", "b"], {"delete": True}) == (
        1,
        "tr: extra operand 'b'\n"
        "Only one string may be given when deleting without squeezing "
        "repeats.\nTry 'tr --help' for more information.\n",
    )
    assert await _refusal(["a", "b", "c"], {}) == (
        1,
        "tr: extra operand 'c'\nTry 'tr --help' for more information.\n",
    )


@pytest.mark.asyncio
async def test_byte_translation_and_squeeze_are_independent_of_chunk_boundaries():
    data = b"\xff\xff\x80\x80\xc3\xa9"
    for split in range(len(data) + 1):

        async def source():
            yield data[:split]
            yield b""
            yield data[split:]

        out = await _run(
            [r"\377\200", "ab"], {"squeeze_repeats": True}, source()
        )
        assert out == b"ab\xc3\xa9"


@pytest.mark.asyncio
async def test_deleted_only_chunks_keep_the_previous_emitted_byte():
    async def source():
        for chunk in (b"aa", b"___", b"", b"aaa", b"___", b"bbb"):
            yield chunk

    out = await _run(
        ["_", "ab"],
        {"delete": True, "squeeze_repeats": True},
        source(),
    )
    assert out == b"ab"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texts,flags,message",
    [
        (
            ["[:bogus:]"],
            {"delete": True},
            "tr: invalid character class 'bogus'\n",
        ),
        (
            ["a"],
            {},
            "tr: missing operand after 'a'\n"
            "Two strings must be given when translating.\n"
            "Try 'tr --help' for more information.\n",
        ),
        (
            ["a", ""],
            {},
            "tr: when not truncating set1, string2 must be non-empty\n",
        ),
    ],
)
async def test_operand_compilation_refuses_before_source_is_opened(
    texts, flags, message
):
    assert await _refusal(texts, flags) == (1, message)


@pytest.mark.asyncio
async def test_large_input_yields_bounded_output_chunks():
    data = b"x" * (64 * 1024 + 1)
    output = _output(["a", "b"], {}, data)
    parts = [part async for part in output]
    assert b"".join(parts) == data
    assert max(map(len, parts)) <= 16 * 1024


@pytest.mark.asyncio
async def test_early_consumer_closes_input_without_reading_ahead():
    closed = 0

    async def source():
        nonlocal closed
        try:
            yield b"aaa"
            raise AssertionError("input was read beyond the first output")
        finally:
            closed += 1

    output = _output(["a", "b"], {}, source())
    assert await anext(output) == b"bbb"
    await output.aclose()
    assert closed == 1


@pytest.mark.asyncio
async def test_ready_empty_source_can_be_cancelled_and_is_closed():
    closed = False

    async def source():
        nonlocal closed
        try:
            while True:
                yield b""
        finally:
            closed = True

    output = _output(["a", "b"], {}, source())
    task = asyncio.create_task(materialize(output))
    timer = asyncio.get_running_loop().call_later(0.005, task.cancel)
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        timer.cancel()
    assert closed
