import json
import pathlib

from mirage.runtime.js.quickjs.node import NODE_SHIM, node_preamble

REPO = pathlib.Path(__file__).resolve().parents[5]
TS_NODE = (
    REPO
    / "typescript"
    / "packages"
    / "core"
    / "src"
    / "runtime"
    / "js"
    / "quickjs"
    / "node.ts"
)


def test_the_shim_is_byte_identical_in_both_languages():
    """One guest program, two copies: the two must never drift.

    Neither language can import the other's file, so each embeds the
    JavaScript; a fix landed in one and forgotten in the other would
    give the same script two behaviors depending on the host.
    """
    text = TS_NODE.read_text(encoding="utf-8")
    start = text.index("String.raw`") + len("String.raw`")
    assert text[start : text.index("`\n", start)] == NODE_SHIM


def test_the_shim_has_no_characters_either_copy_would_read_as_its_own():
    # A backtick or `${` would end or interpolate the TypeScript template,
    # and a triple quote would end the Python string.
    for mark in ("`", "${", '"""'):
        assert mark not in NODE_SHIM


def test_the_preamble_calls_the_shim_with_argv_and_the_script():
    preamble = node_preamble(["node", "/data/a.js", "x"], "/data/a.js")
    assert preamble == (
        f"std.evalScript({json.dumps(NODE_SHIM)})"
        '(["node", "/data/a.js", "x"], "/data/a.js");'
    )
    assert node_preamble(["node"], None).endswith('(["node"], null);')
