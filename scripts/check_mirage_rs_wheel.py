import asyncio
import json
import sys

from mirage import MountMode, Workspace, _rs
from mirage.types import JsonValue
from mirage.vfs.ram import RAMVFS

# Each stream runs once through the native module of an installed mirage-ai
# wheel, on the platform it was built for, with an answer no platform
# changes, so a wheel that imports but computes wrong fails before it is
# published.
WHOLE_KEY: dict[str, JsonValue] = {
    "start_field": 1,
    "start_char": 1,
    "start_skip": False,
    "end_field": None,
    "end_char": None,
    "end_skip": False,
    "mods": {
        name: False
        for name in (
            "numeric",
            "general_numeric",
            "human",
            "version",
            "month",
            "fold",
            "reverse",
            "dictionary",
            "ignore_nonprinting",
            "random",
        )
    },
}
COMPARE: dict[str, JsonValue] = {
    "keys": [WHOLE_KEY],
    "field_sep": None,
    "reverse": False,
    "unique": False,
    "stable": False,
}


def stream(kind: str, config: dict[str, JsonValue]) -> _rs.Stream:
    return _rs.Stream(kind, json.dumps(config).encode())


def settle(s: _rs.Stream, produced: bytes) -> bytes:
    while s.busy():
        produced += s.drain()
    return produced


def run(kind: str, config: dict[str, JsonValue], *chunks: bytes) -> bytes:
    s = stream(kind, config)
    out = b"".join(settle(s, s.feed(chunk)) for chunk in chunks)
    return settle(s, out + s.finish())


async def pipeline() -> tuple[int, bytes]:
    """A shell pipeline through the installed package, its sort, base64 and
    wc each a native stream."""
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    out = await ws.shell(
        "printf 'b\\na\\n' | sort | base64 | base64 -d | wc -l"
    )
    return out.exit_code, await out.materialize_stdout()


def main() -> None:
    checks = {
        "base64 encode": (
            run("base64", {"mode": "encode", "wrap": 76}, b"hel", b"lo"),
            b"aGVsbG8=\n",
        ),
        "base64 decode": (
            run(
                "base64",
                {"mode": "decode", "ignore_garbage": False},
                b"aGVs",
                b"bG8=",
            ),
            b"hello",
        ),
        "md5": (
            run("digest", {"algorithm": "md5"}, b"hel", b"lo"),
            b"5d41402abc4b2a76b9719d911017c592",
        ),
        "sha256": (
            run("digest", {"algorithm": "sha256"}, b"hello"),
            b"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        ),
        "wc": (
            run(
                "wc",
                {
                    "lines": True,
                    "words": True,
                    "bytes": True,
                    "chars": True,
                    "max_line_length": True,
                },
                "a b\nc 中\n".encode(),
            ).split(),
            [b"2", b"4", b"10", b"8", b"4"],
        ),
        "sort": (
            run(
                "sort",
                {
                    "mode": "sort",
                    "compare": COMPARE,
                    "zero_terminated": False,
                    "run_bytes": 8 << 20,
                },
                b"b\n\xff\nc\na",
            ),
            b"a\nb\nc\n\xff\n",
        ),
    }
    rg = stream(
        "rg",
        {
            "pattern": "(?P<word>x)",
            "replace": "<${word}>",
            "only_matching": True,
            "byte_offsets": True,
        },
    )
    rg.begin(b'{"name":"f","label":null,"binary_mode":"text"}')
    rg_output = settle(rg, rg.feed("éx\n".encode()))
    rg_output = settle(rg, rg_output + rg.finish())
    checks["rg capture replacement"] = (rg_output, b"2:<x>\n")
    progress = json.loads(rg.metadata())
    checks["rg progress"] = ([progress["selected"]], [True])
    preview = stream(
        "rg", {"pattern": ".", "max_columns": 2, "max_columns_preview": True}
    )
    preview.begin(b'{"name":"f","label":null,"binary_mode":"text"}')
    preview_output = settle(preview, preview.feed("é👩‍💻x\n".encode()))
    checks["rg grapheme preview"] = (
        settle(preview, preview_output + preview.finish()),
        "é👩‍💻 [... omitted end of long line]\n".encode(),
    )
    checks["bc exact arithmetic"] = (
        run(
            "bc",
            {"math_mode": False, "line_length": "0"},
            b"9007199254740993+1\nscale=3;",
            b"1/7\n",
        ),
        b"9007199254740994\n.142\n",
    )
    checks["bc math"] = (
        run("bc", {"math_mode": True}, b"sqrt(2)\n"),
        b"1.41421356237309504880\n",
    )
    bc = stream("bc", {"math_mode": False})
    recovered = settle(bc, bc.feed(b"1/0\n2+2\n"))
    recovered = settle(bc, recovered + bc.finish())
    checks["bc recovery"] = (
        (recovered, bc.status(), bc.take_stderr()),
        (
            b"4\n",
            0,
            b"Runtime error (func=(main), adr=3): Divide by zero\n",
        ),
    )
    merge = stream(
        "sort",
        {
            "mode": "merge",
            "compare": COMPARE,
            "zero_terminated": False,
            "inputs": 2,
        },
    )
    merged = settle(merge, merge.feed_input(0, b"a\nc\n"))
    merged = settle(merge, merged + merge.feed_input(1, b"b\nd\n"))
    while (index := merge.wants()) is not None:
        merged = settle(merge, merged + merge.end_input(index))
    checks["merge"] = (settle(merge, merged + merge.finish()), b"a\nb\nc\nd\n")

    for mode in ("builtin", "program"):
        printf = stream("printf", {"mode": mode, "argument_count": 5})
        for index, value in enumerate(
            (b"%+.1f|%+.1a|%s|%d%b", b"nan", b"-nan", b"\xff", b"bad", b"\\c")
        ):
            for byte in value:
                printf.feed_input(index, bytes([byte]))
            printf.end_input(index)
        checks[f"printf {mode} output"] = (
            settle(printf, printf.finish()),
            b"+nan|-nan|\xff|0",
        )
        checks[f"printf {mode} diagnostic"] = (
            printf.take_stderr(),
            b"printf: 'bad': expected a numeric value\n"
            if mode == "program"
            else b"bash: printf: bad: invalid number\n",
        )
        checks[f"printf {mode} stop"] = (
            (printf.status(), printf.done()),
            (0, True),
        )
    checks["pipeline"] = (asyncio.run(pipeline()), (0, b"2\n"))

    failed = [name for name, (got, want) in checks.items() if got != want]
    for name, (got, want) in checks.items():
        status = "FAIL" if name in failed else "ok"
        print(
            f"{status:4} {name}"
            + (f": {got!r} != {want!r}" if name in failed else "")
        )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
