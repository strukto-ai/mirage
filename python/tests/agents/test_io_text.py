from mirage.agents.io_text import decode, io_to_str, with_refusal_bytes
from mirage.io.types import IOResult
from mirage.types import Refusal


def test_decode_none_returns_empty():
    assert decode(None) == ""


def test_decode_bytes():
    assert decode(b"hello") == "hello"


def test_decode_invalid_utf8_replaces():
    assert decode(b"\xff") == "�"


def test_io_to_str_stdout_only():
    assert io_to_str(IOResult(stdout=b"out")) == "out"


def test_io_to_str_stderr_only():
    assert io_to_str(IOResult(stderr=b"err")) == "err"


def test_io_to_str_combines_stdout_and_stderr():
    assert io_to_str(IOResult(stdout=b"out", stderr=b"err")) == "out\nerr"


async def _stream():
    yield b"streamed"


def test_io_to_str_ignores_unmaterialized_stream():
    assert io_to_str(IOResult(stdout=_stream())) == ""


def test_io_to_str_appends_the_refusal_after_stderr():
    io = IOResult(stderr=b"rm: Permission denied\n",
                  exit_code=126,
                  refusal=Refusal(kind="deny",
                                  reason="no deletes",
                                  policy="RulePolicy"))
    assert io_to_str(
        io) == "rm: Permission denied\npolicy denied: no deletes\n"


def test_io_to_str_starts_a_line_for_the_refusal_when_needed():
    pending = Refusal(kind="pending", reason="sign-off", ask_id="a1")
    assert io_to_str(IOResult(
        stdout=b"partial",
        refusal=pending)) == "partial\nrequires approval: sign-off (ask a1)\n"
    assert io_to_str(
        IOResult(refusal=pending)) == "requires approval: sign-off (ask a1)\n"


def test_io_to_str_leaves_an_operand_refusal_alone():
    # An operand-scoped refusal already carries its reason on the
    # stderr line, GNU-style; repeating it would say nothing new.
    io = IOResult(stderr=b"rm: cannot remove 'x': keys\n",
                  exit_code=1,
                  refusal=Refusal(kind="deny",
                                  reason="cannot remove 'x': keys",
                                  policy="RulePolicy",
                                  scope="operand"))
    assert io_to_str(io) == "rm: cannot remove 'x': keys\n"


def test_with_refusal_bytes_appends_after_stderr():
    denied = Refusal(kind="deny", reason="no deletes", policy="RulePolicy")
    assert with_refusal_bytes(
        b"rm: Permission denied\n",
        denied) == b"rm: Permission denied\npolicy denied: no deletes\n"


def test_with_refusal_bytes_starts_a_line_when_needed():
    pending = Refusal(kind="pending", reason="sign-off", ask_id="a1")
    assert with_refusal_bytes(
        b"partial",
        pending) == b"partial\nrequires approval: sign-off (ask a1)\n"
    assert with_refusal_bytes(
        b"", pending) == b"requires approval: sign-off (ask a1)\n"


def test_with_refusal_bytes_leaves_the_bytes_alone_otherwise():
    # No record, or an operand-scoped one whose line already names the
    # reason: the bytes pass through untouched, invalid UTF-8 included.
    assert with_refusal_bytes(b"\xff raw", None) == b"\xff raw"
    operand = Refusal(kind="deny",
                      reason="cannot remove 'x': keys",
                      policy="RulePolicy",
                      scope="operand")
    assert with_refusal_bytes(b"rm: cannot remove 'x': keys\n",
                              operand) == b"rm: cannot remove 'x': keys\n"


def test_with_refusal_describes_an_operand_refusal_whose_line_is_gone():
    # `cat /protected 2>/dev/null`: the GNU line was redirected away, so
    # the record is the only reason left to hand over.
    operand = Refusal(kind="deny",
                      reason="/protected: frozen",
                      policy="Frozen",
                      scope="operand")
    assert io_to_str(IOResult(
        exit_code=1, refusal=operand)) == "policy denied: /protected: frozen\n"
    assert with_refusal_bytes(
        b"", operand) == b"policy denied: /protected: frozen\n"


def test_with_refusal_describes_a_command_refusal_the_output_quotes():
    # `V=secret; printf 'secrets stay put'; echo "$V" 2>/dev/null`: the
    # bare `Permission denied` was redirected away and the earlier
    # output carries the reason by coincidence; a command-scoped record
    # is never already said, so the line is still appended.
    denied = Refusal(kind="deny",
                     reason="secrets stay put",
                     policy="DenySecret")
    assert io_to_str(
        IOResult(stdout=b"secrets stay put", exit_code=126, refusal=denied)
    ) == "secrets stay put\npolicy denied: secrets stay put\n"


def test_with_refusal_describes_an_operand_refusal_the_output_only_quotes():
    operand = Refusal(kind="deny",
                      reason="/protected: frozen",
                      policy="Frozen",
                      scope="operand")
    io = IOResult(stdout=b"note: /protected: frozen for now\n",
                  exit_code=1,
                  refusal=operand)
    assert io_to_str(io) == ("note: /protected: frozen for now\n"
                             "policy denied: /protected: frozen\n")


def test_with_refusal_trusts_the_reason_wherever_the_line_landed():
    # `2>&1` moved the GNU line onto stdout; the text still says why,
    # so nothing is repeated.
    operand = Refusal(kind="deny",
                      reason="/protected: frozen",
                      policy="Frozen",
                      scope="operand")
    io = IOResult(stdout=b"cat: /protected: frozen\n",
                  exit_code=1,
                  refusal=operand)
    assert io_to_str(io) == "cat: /protected: frozen\n"
