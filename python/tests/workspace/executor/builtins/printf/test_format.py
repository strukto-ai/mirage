import asyncio

import pytest

from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import open_stream
from mirage.workspace.executor.builtins.printf.format import run_printf

pytestmark = pytest.mark.asyncio

_OCTAL_PINS = [
    ("\\0003", "00 33", "03"),
    ("\\0", "00", "00"),
    ("\\00", "00", "00"),
    ("\\000", "00", "00"),
    ("\\0000", "00 30", "00"),
    ("\\08", "00 38", "00 38"),
    ("\\101", "41", "41"),
    ("\\1011", "41 31", "41 31"),
    ("\\0101", "08 31", "41"),
    ("\\400", "00", "00"),
    ("\\0400", "20 30", "00"),
]

_UNICODE_PINS = [
    ("\\uD800", "ed a0 80"),
    ("\\uDC80", "ed b2 80"),
    ("\\uDFFF", "ed bf bf"),
    ("\\uD83D\\uDE00", "ed a0 bd ed b8 80"),
    ("\\U00110000", "f4 90 80 80"),
    ("\\U0010FFFF", "f4 8f bf bf"),
    ("\\U7FFFFFFF", "fd bf bf bf bf bf"),
    ("\\U80000000", ""),
    ("\\UFFFFFFFF", ""),
    ("x\\UFFFFFFFFy", "78 79"),
    ("a\\u0000b", "61 00 62"),
    ("\\uDC80\\xff", "ed b2 80 ff"),
]


@pytest.mark.parametrize("escape,format_hex,argument_hex", _OCTAL_PINS)
async def test_octal_byte_grammars(escape, format_hex, argument_hex):
    assert await run_printf(escape, []) == (
        bytes.fromhex(format_hex),
        b"",
        0,
        False,
    )
    assert await run_printf("%b", [escape]) == (
        bytes.fromhex(argument_hex),
        b"",
        0,
        False,
    )


@pytest.mark.parametrize("escape,expected", _UNICODE_PINS)
async def test_unicode_escapes_preserve_raw_bytes(escape, expected):
    for fmt, args in [(escape, []), ("%b", [escape])]:
        assert await run_printf(fmt, args) == (
            bytes.fromhex(expected),
            b"",
            0,
            False,
        )


@pytest.mark.parametrize("program", [False, True])
async def test_signed_special_values_and_hex_carry(program):
    assert await run_printf(
        "%+.1f|%+.1a|%.0a|%.1a|%.0f",
        ["nan", "-nan", "0x1.ffp0", "0x1.ffp0", "-0"],
        program,
    ) == (b"+nan|-nan|0x2p+0|0x2.0p+0|-0", b"", 0, False)


async def test_argument_stop_retains_diagnostics_and_resets_status():
    assert await run_printf("%d%b%d", ["bad", "x\\cy", "unread"]) == (
        b"0x",
        b"bash: printf: bad: invalid number\n",
        0,
        True,
    )


async def test_format_stop_retains_failure():
    assert await run_printf("%d\\c%d", ["bad", "unread"]) == (
        b"0",
        b"bash: printf: bad: invalid number\n",
        1,
        True,
    )


async def test_long_arguments_cross_host_chunks_without_losing_bytes():
    raw = "a" * 4095 + "𐂀" + "\udcff" + "b" * 17000
    out, err, status, stopped = await run_printf("%s", [raw])
    assert out == raw.encode("utf-8", "surrogateescape")
    assert (err, status, stopped) == (b"", 0, False)


async def test_large_width_and_precision_are_cancellable():
    for fmt in ["%2147483647s", "%.2147483647f", "%.2147483647d"]:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(run_printf(fmt, ["1"]), timeout=0.03)
    assert await run_printf("%s", ["after"]) == (b"after", b"", 0, False)


async def test_cancels_a_preloaded_numeric_scan(monkeypatch):
    monkeypatch.setattr("mirage.io.yield_budget.YIELD_INTERVAL", 0)
    stream = open_stream("printf", {"mode": "builtin", "argument_count": 1})
    stream.feed_input(0, b"%d")
    stream.end_input(0)
    raw = b"0" * (1024 * 1024) + b"7"
    for at in range(0, len(raw), 16384):
        stream.feed_input(1, raw[at : at + 16384])
    stream.end_input(1)
    assert stream.finish() == b""

    async def drain():
        budget = YieldBudget()
        while stream.busy():
            stream.drain()
            await budget.run()

    pending = asyncio.create_task(drain())
    await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert stream.busy()
