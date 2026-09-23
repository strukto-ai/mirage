from mirage.ops.mem0 import OPS


def test_ops_registered():
    names = {(op.name, op.vfs) for op in OPS}
    assert ("readdir", "mem0") in names
    assert ("read", "mem0") in names
    assert ("stat", "mem0") in names
