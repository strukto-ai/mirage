import json
import sys
from typing import TypeAlias

import mirage_rs

# mirage.types.JsonValue: only mirage-rs is installed where this runs.
JsonValue: TypeAlias = (
    "None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]"
)

# Each stream runs once through an installed mirage-rs wheel, on the
# platform it was built for, with an answer no platform changes, so a wheel
# that imports but computes wrong fails before it is published.
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


def stream(kind: str, config: dict[str, JsonValue]) -> mirage_rs.Stream:
    return mirage_rs.Stream(kind, json.dumps(config).encode())


def settle(s: mirage_rs.Stream, produced: bytes) -> bytes:
    while s.busy():
        produced += s.drain()
    return produced


def run(kind: str, config: dict[str, JsonValue], *chunks: bytes) -> bytes:
    s = stream(kind, config)
    out = b"".join(settle(s, s.feed(chunk)) for chunk in chunks)
    return settle(s, out + s.finish())


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
