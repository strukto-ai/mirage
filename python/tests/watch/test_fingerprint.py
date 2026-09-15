from mirage.watch.fingerprint import stat_fingerprint


def test_stat_fingerprint_composites_all_three_inputs():
    assert stat_fingerprint("etag-1", "2026-01-01T00:00:00",
                            5) == "etag-1|2026-01-01T00:00:00|5"


def test_stat_fingerprint_falls_back_to_mtime_size():
    assert stat_fingerprint(None, "2026-01-01T00:00:00",
                            5) == "|2026-01-01T00:00:00|5"


def test_stat_fingerprint_handles_missing_fields():
    assert stat_fingerprint(None, None, None) == "||None"


def test_unchanged_etag_with_a_changed_size_moves_the_fingerprint():
    before = stat_fingerprint("lazy-etag", "2026-09-15T16:09:51+00:00", 4)
    after = stat_fingerprint("lazy-etag", "2026-09-15T16:09:51+00:00", 11)
    assert before != after


def test_unchanged_etag_with_a_changed_modified_moves_the_fingerprint():
    before = stat_fingerprint("lazy-etag", "2026-09-15T16:09:51+00:00", 4)
    after = stat_fingerprint("lazy-etag", "2026-09-15T16:30:18+00:00", 4)
    assert before != after


def test_a_zero_size_is_not_confused_with_an_absent_one():
    assert stat_fingerprint("e", "T", 0) != stat_fingerprint("e", "T", None)
