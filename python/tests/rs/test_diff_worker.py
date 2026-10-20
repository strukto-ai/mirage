from dataclasses import asdict

import pytest

from mirage.rs import diff_worker
from mirage.rs.diff_types import DiffOptions
from mirage.rs.errors import StreamRefusal


@pytest.fixture(autouse=True)
def closed_pair():
    diff_worker.drop_pair()
    try:
        yield
    finally:
        diff_worker.drop_pair()


def test_indexed_inputs_preserve_bytes_and_drain_bounded_output():
    old, new = b"\xff" * 40000, b"\xfe" * 40000
    diff_worker.open_pair(asdict(DiffOptions()))
    assert diff_worker.feed(0, old[:20000]) == b""
    assert diff_worker.feed(0, old[20000:]) == b""
    assert diff_worker.end(0) == b""
    assert diff_worker.feed(1, new) == b""
    assert diff_worker.end(1) == b""
    first, busy = diff_worker.drain()
    assert len(first) == 65536 and busy
    last, busy = diff_worker.drain()
    assert 0 < len(last) <= 65536 and not busy
    assert first + last == (
        b"1c1\n< "
        + old
        + b"\n\\ No newline at end of file\n---\n> "
        + new
        + b"\n\\ No newline at end of file\n"
    )
    assert diff_worker.drain() == (b"", False)
    assert diff_worker.inspect_pair() == ("different", 1, b"")


def test_open_pair_requires_drop_and_reuse_starts_empty():
    diff_worker.open_pair(asdict(DiffOptions(ignore_case=True)))
    diff_worker.feed(0, b"A\n")
    diff_worker.end(0)
    diff_worker.feed(1, b"a\n")
    diff_worker.end(1)
    assert diff_worker.drain() == (b"", False)
    assert diff_worker.inspect_pair() == ("equal", 0, b"")
    with pytest.raises(RuntimeError, match="previous diff pair is still open"):
        diff_worker.open_pair(asdict(DiffOptions()))
    diff_worker.drop_pair()
    diff_worker.open_pair(asdict(DiffOptions()))
    diff_worker.end(0)
    diff_worker.end(1)
    assert diff_worker.drain() == (b"", False)
    assert diff_worker.inspect_pair() == ("equal", 0, b"")


def test_refused_config_leaves_worker_ready_for_a_valid_pair():
    with pytest.raises(StreamRefusal, match="a count cannot be negative"):
        diff_worker.open_pair(asdict(DiffOptions(context=-1)))
    diff_worker.open_pair(asdict(DiffOptions()))
    diff_worker.end(0)
    diff_worker.end(1)
    assert diff_worker.inspect_pair() == ("equal", 0, b"")


@pytest.mark.parametrize("index", [0, 2])
def test_ended_or_unknown_inputs_refuse_without_partial_output(index):
    diff_worker.open_pair(asdict(DiffOptions()))
    diff_worker.end(0)
    with pytest.raises(StreamRefusal, match="invalid or ended input") as exc:
        diff_worker.feed(index, b"late\n")
    assert exc.value.output == b""
    with pytest.raises(StreamRefusal, match="invalid or ended input"):
        diff_worker.end(index)


def test_equal_incomplete_ed_inputs_report_trouble_and_consume_diagnostics():
    diff_worker.open_pair(asdict(DiffOptions(mode="ed")))
    for index in (0, 1):
        diff_worker.feed(index, b"same")
        diff_worker.end(index)
    assert diff_worker.drain() == (b"", False)
    assert diff_worker.inspect_pair() == (
        "equal",
        2,
        b"diff: a: No newline at end of file\n\n"
        b"diff: b: No newline at end of file\n\n",
    )
    assert diff_worker.inspect_pair() == ("equal", 2, b"")
