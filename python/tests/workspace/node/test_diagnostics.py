import pytest

from mirage.shell.parse.scope import ParseScope
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.node.diagnostics import diagnostic_stderr
from mirage.workspace.session.session import SessionState


@pytest.mark.parametrize(
    "line,prefix",
    [
        ("printf x", b"bash: printf: "),
        ("export X=x", b"bash: export: "),
        ("cat f", b"bash: "),
    ],
)
def test_diagnostics_preserve_verbatim_bytes_and_order(line, prefix):
    context = EvaluationContext(SessionState("diagnostic-test"))
    parser = ParseScope()
    try:
        node = parser.parse(line)
        assert diagnostic_stderr(node, context) == b""
        context.frame.diagnostics = [
            b"child warning\n",
            "invalid name",
            b"\xff",
        ]
        assert (
            diagnostic_stderr(node, context)
            == b"child warning\n" + prefix + b"invalid name\n\xff"
        )
    finally:
        parser.release()
