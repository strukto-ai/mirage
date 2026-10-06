from mirage.shell.parse.parse import parse_program


def test_diagnostics_name_original_utf8_bytes_after_recovery():
    line = "echo é💡; value=x 2>/dev/null; fi"
    program = parse_program(line)
    try:
        diagnostic = program.diagnostics[0]
        assert diagnostic.offending == "fi"
        span = diagnostic.span
        assert line.encode()[span.start : span.end] == b"fi"
        assert program.root.text == line.encode()
    finally:
        program.release()
