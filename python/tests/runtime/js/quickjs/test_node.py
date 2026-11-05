import json
import pathlib

from mirage.runtime.js.quickjs.node import NODE_SHIM, node_preamble

REPO = pathlib.Path(__file__).resolve().parents[5]
QUICKJS = pathlib.Path("runtime") / "js" / "quickjs" / "shim.js"


def test_the_two_shim_copies_are_byte_identical():
    """One guest program, two copies: the two must never drift.

    Each package ships its own copy, so a fix landed in one and forgotten
    in the other would give the same script two behaviors depending on
    the host.
    """
    py = (REPO / "python" / "mirage" / QUICKJS).read_bytes()
    ts = (
        REPO / "typescript" / "packages" / "core" / "src" / QUICKJS
    ).read_bytes()
    assert py == ts
    assert NODE_SHIM.encode() == py


def test_the_preamble_calls_the_shim_with_argv_and_the_script():
    preamble = node_preamble(["node", "/data/a.js", "x"], "/data/a.js")
    assert preamble == (
        f"std.evalScript({json.dumps(NODE_SHIM)})"
        '(["node", "/data/a.js", "x"], "/data/a.js");'
    )
    assert node_preamble(["node"], None).endswith('(["node"], null);')
