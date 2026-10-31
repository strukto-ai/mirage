import pytest

from mirage.commands.errors import UsageError
from mirage.commands.spec.constants import PARSE_KEPT_CHARS
from mirage.rs import scan as rs_scan
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan, scanned


def test_scan_reads_each_value_typed():
    values = scan("cmp", [("ignore_initial", "1K:2"), ("bytes", "0x10")])
    assert values == {"limit": 16, "skip": [1024, 2]}


def test_a_refusal_keeps_its_bytes_and_status():
    with pytest.raises(StreamRefusal) as caught:
        scan("cmp", [("bytes", "1é")])
    assert caught.value.status == 2
    result = refused(caught.value)
    assert (result.exit_code, result.stderr) == (
        2,
        "cmp: invalid --bytes value '1é'\n"
        "cmp: Try 'cmp --help' for more information.\n".encode(),
    )


def test_scanned_raises_a_refusal_as_the_usage_error_it_is():
    with pytest.raises(UsageError) as caught:
        scanned("grep", [("after_context", "é")])
    assert (str(caught.value), caught.value.exit_code) == (
        "grep: é: invalid context length argument",
        2,
    )
    assert scanned("grep", [("max_count", "-1")])["max_count"] is None


def test_a_readers_change_to_a_kept_scan_stays_its_own():
    first = scan("cmp", [("ignore_initial", "3K:4")])
    first["skip"] = []
    assert scan("cmp", [("ignore_initial", "3K:4")]) == {
        "limit": None,
        "skip": [3072, 4],
    }


def test_a_kept_refusal_refuses_every_reader():
    for _ in range(2):
        with pytest.raises(StreamRefusal) as caught:
            scan("cmp", [("bytes", "2é")])
        result = refused(caught.value)
        assert (result.exit_code, result.stderr) == (
            2,
            "cmp: invalid --bytes value '2é'\n"
            "cmp: Try 'cmp --help' for more information.\n".encode(),
        )


def test_a_long_run_of_switches_is_not_kept(monkeypatch):
    monkeypatch.setattr(rs_scan, "_SCANS", {})
    switches = [("recursive", "")] * PARSE_KEPT_CHARS
    scan("grep", switches)
    scan("grep", switches[:1])
    assert list(rs_scan._SCANS["grep"]) == [(("recursive", ""),)]


def test_a_kept_refusal_holds_no_traceback(monkeypatch):
    monkeypatch.setattr(rs_scan, "_SCANS", {})
    with pytest.raises(StreamRefusal):
        scan("cmp", [("bytes", "2é")])
    kept = rs_scan._SCANS["cmp"][(("bytes", "2é"),)]
    assert isinstance(kept, StreamRefusal)
    assert kept.__traceback__ is None
