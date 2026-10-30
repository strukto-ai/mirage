import pytest

from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan


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
