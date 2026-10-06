from mirage.workspace.frame import ExecutionFrame


def test_a_fork_starts_empty_and_shares_nothing():
    frame = ExecutionFrame(["warning"], cmdsub_seq=3, cmdsub_status=1)
    child = frame.fork()
    child.diagnostics.append("child")
    child.cmdsub_seq += 1
    assert child.diagnostics == ["child"]
    assert (child.cmdsub_seq, child.cmdsub_status) == (1, 0)
    assert frame == ExecutionFrame(["warning"], cmdsub_seq=3, cmdsub_status=1)
