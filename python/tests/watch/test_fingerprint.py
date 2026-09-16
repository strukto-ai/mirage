from mirage.watch.fingerprint import stat_fingerprint


def test_stat_fingerprint_joins_the_etag_and_the_size():
    assert stat_fingerprint("etag-1", "2026-01-01T00:00:00", 5) == "etag-1|5"


def test_stat_fingerprint_substitutes_the_stamp_without_an_etag():
    assert stat_fingerprint(None, "2026-01-01T00:00:00",
                            5) == "2026-01-01T00:00:00|5"


def test_stat_fingerprint_handles_missing_fields():
    assert stat_fingerprint(None, None, None) == "|None"


def test_unchanged_etag_with_a_changed_size_moves_the_fingerprint():
    # Probed on Nextcloud 30: its WebDAV ETag comes off an mtime with
    # one-second granularity, so two writes inside the same second
    # answer the SAME etag and the SAME stamp even though the content
    # and its size changed. The size is the only field that moved, and
    # returning the etag alone threw it away.
    before = stat_fingerprint("lazy-etag", "2026-09-15T16:09:51+00:00", 4)
    after = stat_fingerprint("lazy-etag", "2026-09-15T16:09:51+00:00", 11)
    assert before != after


def test_a_stamp_move_alone_is_not_an_update_for_a_versioned_backend():
    # The mirror of the case above, and why the stamp is not folded in
    # beside the etag. S3's single-part ETag and Dropbox's content_hash
    # are content-addressed: rewriting a file with identical bytes
    # leaves them alone while the stamp moves. Reading that idempotent
    # rewrite as an UPDATE would wake every consumer for nothing, and
    # the stamp cannot rescue the case above anyway, since a stamp
    # coarse enough to give two writes one etag gives them one stamp.
    before = stat_fingerprint("sha-1", "2026-09-15T16:09:51+00:00", 4)
    after = stat_fingerprint("sha-1", "2026-09-15T16:30:18+00:00", 4)
    assert before == after


def test_a_zero_size_is_not_confused_with_an_absent_one():
    assert stat_fingerprint("e", "T", 0) != stat_fingerprint("e", "T", None)
