import asyncio
import json
from contextlib import aclosing
from pathlib import Path
from time import monotonic

import pytest

from mirage import Workspace
from mirage.commands.builtin.utils.stream_host import StreamHost
from mirage.rs.stream import OpenStream
from mirage.utils.abort import MirageAbortError
from mirage.vfs.ram import RAMVFS

ROOT = Path(__file__).resolve().parents[3]
CASES = [
    {**case, "seed": name == "unix/awk/getline.json"}
    for name in (
        "bash/test/posix.json",
        "unix/awk/redirect.json",
        "unix/awk/getline.json",
    )
    for case in json.loads((ROOT / "integ" / name).read_text())["cases"]
]

# The fixture files the getline cases read, as every integ target seeds them.
FIXTURES = (
    "printf '1\\n2\\n3\\n' > /data/b.txt; "
    "printf '10\\n2\\n30\\n4\\n5\\n' > /data/numbers.txt; "
    "printf 'alice 30 engineer\\nbob 25 designer\\ncarol 40 manager\\n' "
    "> /data/fields.txt"
)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
async def test_shared_shell_cases(case):
    ws = Workspace({"/data": RAMVFS()}, mode="exec")
    try:
        if case["seed"]:
            await ws.shell(FIXTURES)
        result = await ws.shell(case["command"])
        expected = case["expect"]
        assert (
            result.exit_code,
            result.stdout.decode(),
            (result.stderr or b"").decode(),
        ) == (expected["exit"], expected["stdout"], expected["stderr"])
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_awk_dispatches_across_mounts_and_stops_on_write_failure():
    ws = Workspace({"/data": RAMVFS(), "/other": RAMVFS()}, mode="exec")
    try:
        result = await ws.shell(
            "echo hi > /data/in; awk '{print > \"/other/out\"}' /data/in; "
            "cat /other/out"
        )
        assert result.stdout == b"hi\n"
        result = await ws.shell(
            'awk \'BEGIN {print "before"; print "x" > "/data/missing/out"; '
            'print "after" > "/other/after"} END {print "end"}\''
        )
        assert result.exit_code == 2
        assert result.stdout == b"before\n"
        assert b"No such file or directory" in result.stderr
        assert (await ws.shell("test -e /other/after")).exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_awk_file_output_respects_read_only_mount():
    ws = Workspace({"/data": RAMVFS()}, mode="read")
    try:
        result = await ws.shell('awk \'BEGIN {print "x" > "/data/out"}\'')
        assert result.exit_code == 2
        assert (await ws.shell("test -e /data/out")).exit_code == 1
    finally:
        await ws.close()


# mawk 1.3.4 over /m1 and /m2 as two directories: awk keeps every
# operand's name and position when its operands span mounts.
CROSS_MOUNT = [
    (
        "awk '{print x, $0, FILENAME, FNR, NR}' /m1/a x=5 /m2/b",
        0,
        " 1 /m1/a 1 1\n5 2 /m2/b 1 2\n5 3 /m2/b 2 3\n",
        "",
    ),
    (
        "awk 'FNR==1{getline; print FILENAME, $0, NR, FNR}' /m1/a /m2/b",
        0,
        "/m2/b 2 2 1\n",
        "",
    ),
    (
        "awk 'BEGIN{for(i=0;i<ARGC;i++) print i, ARGV[i]}' /m1/a x=1 /m2/b",
        0,
        "0 awk\n1 /m1/a\n2 x=1\n3 /m2/b\n",
        "",
    ),
    (
        "awk '{print FILENAME \":\" $0}' /m1/nonl /m2/c",
        0,
        "/m1/nonl:x\n/m2/c:y\n",
        "",
    ),
    ("awk 'END{print x, NR, FILENAME}' x=3 /m1/a /m2/b", 0, "3 3 /m2/b\n", ""),
    ("awk '{print; nextfile}' /m1/a /m2/b", 0, "1\n2\n", ""),
    (
        "awk '{print}' /m1/a /m2/nope /m2/b",
        2,
        "1\n",
        'awk: cannot open "/m2/nope" (No such file or directory)\n',
    ),
    (
        "printf 'in\\n' | awk '{print FILENAME, $0}' /m1/a - /m2/b",
        0,
        "/m1/a 1\n- in\n/m2/b 2\n/m2/b 3\n",
        "",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("command,code,out,err", CROSS_MOUNT)
async def test_awk_keeps_argv_across_mounts(command, code, out, err):
    ws = Workspace({"/m1": RAMVFS(), "/m2": RAMVFS()}, mode="exec")
    try:
        await ws.shell(
            "printf '1\\n' > /m1/a; printf '2\\n3\\n' > /m2/b; "
            "printf 'x' > /m1/nonl; printf 'y\\n' > /m2/c"
        )
        result = await ws.shell(command)
        assert (
            result.exit_code,
            result.stdout.decode(),
            (result.stderr or b"").decode(),
        ) == (code, out, err)
    finally:
        await ws.close()


INTERRUPT = json.loads((ROOT / "integ/interrupt/awk.json").read_text())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case", INTERRUPT["cases"], ids=lambda case: case["id"]
)
async def test_cancel_during_awk_operation_releases_resources(
    monkeypatch, case
):
    ram = RAMVFS()
    ram.accessor.store.files["/in"] = (
        case.get("prefix", "").encode()
        + case["unit"].encode() * case.get("bytes", INTERRUPT["bytes"])
        + b"\nnext\n"
    )
    ws = Workspace({"/data": ram}, mode="exec")
    stopped = asyncio.Event()
    original_drain = OpenStream.drain
    original_cancel = OpenStream.cancel
    original_input = StreamHost.open_input
    retiring = set()
    retirement_calls = 0
    sources = 0
    opened = 0
    timer = None
    armed = None
    fired = None
    completed = False

    def abort():
        nonlocal fired
        fired = monotonic()
        stopped.set()

    def drain(stream):
        nonlocal retirement_calls, timer, armed, completed
        out = original_drain(stream)
        if stream in retiring:
            retirement_calls += 1
        elif out.startswith(b"ready\n") and timer is None:
            armed = monotonic()
            timer = asyncio.get_running_loop().call_later(0, abort)
        completed |= b"done\n" in out
        return out

    def cancel(stream):
        retiring.add(stream)
        return original_cancel(stream)

    async def source(host, *args, **kwargs):
        nonlocal sources, opened
        sources += 1
        opened += 1
        try:
            async with aclosing(
                original_input(host, *args, **kwargs)
            ) as input_:
                async for part in input_:
                    yield part
        finally:
            sources -= 1

    monkeypatch.setattr(OpenStream, "drain", drain)
    monkeypatch.setattr(OpenStream, "cancel", cancel)
    monkeypatch.setattr(StreamHost, "open_input", source)
    try:
        with pytest.raises(MirageAbortError):
            await asyncio.wait_for(
                ws.shell(f"awk '{case['program']}' /data/in", cancel=stopped),
                10,
            )
        assert armed is not None and fired is not None
        assert fired - armed < 0.75
        assert monotonic() - fired < 3
        assert not completed
        assert opened > 0 and sources == 0
        assert retirement_calls > (1 if case["id"] == "array-cleanup" else 0)
        assert all(not stream.busy() for stream in retiring)
        result = await ws.shell("printf recovered")
        assert result.stdout == b"recovered"
    finally:
        if timer is not None:
            timer.cancel()
        stopped.set()
        await ws.close()
