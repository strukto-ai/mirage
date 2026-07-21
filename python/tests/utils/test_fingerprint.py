from mirage.utils.fingerprint import stat_fingerprint


def test_stat_fingerprint_prefers_etag():
    assert stat_fingerprint("etag-1", "2026-01-01T00:00:00", 5) == "etag-1"


def test_stat_fingerprint_falls_back_to_mtime_size():
    assert stat_fingerprint(None, "2026-01-01T00:00:00",
                            5) == "2026-01-01T00:00:00|5"


def test_stat_fingerprint_handles_missing_fields():
    assert stat_fingerprint(None, None, None) == "|None"
