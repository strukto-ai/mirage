import pytest

from mirage.commands.errors import UsageError
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
