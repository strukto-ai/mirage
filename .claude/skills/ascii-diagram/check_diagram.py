import argparse
import sys
import unicodedata

try:
    from wcwidth import wcswidth
except ImportError:
    wcswidth = None

CONNECTOR_CHARS = "|^v+"


def read_lines(path: str) -> list[str]:
    if path == "-":
        return sys.stdin.read().splitlines()
    with open(path, encoding="utf-8") as handle:
        return handle.read().splitlines()


def display_width(text: str, use_wcwidth: bool) -> int:
    if not use_wcwidth:
        return len(text)
    width = wcswidth(text)
    if width < 0:
        raise ValueError("line contains a non-printable character")
    return width


def check_ascii(lines: list[str]) -> list[str]:
    problems = []
    for row, line in enumerate(lines, start=1):
        for col, ch in enumerate(line):
            code = ord(ch)
            if ch == "\t":
                problems.append(f"line {row} col {col}: tab is not allowed, use spaces")
            elif code < 32 or code > 126:
                name = unicodedata.name(ch, "unknown")
                problems.append(f"line {row} col {col}: {ch!r} U+{code:04X} {name} is not 7-bit ASCII")
    return problems


def check_box(lines: list[str], use_wcwidth: bool) -> list[str]:
    rows = [(row, line) for row, line in enumerate(lines, start=1) if line.strip()]
    if not rows:
        return []
    widths = {row: display_width(line, use_wcwidth) for row, line in rows}
    target = widths[rows[0][0]]
    problems = []
    for row, _line in rows:
        if widths[row] != target:
            problems.append(f"line {row}: width {widths[row]} != {target} (right edge is not flush)")
    return problems


def check_connectors(lines: list[str], columns: list[int], chars: str, use_wcwidth: bool) -> list[str]:
    expected = set(columns)
    problems = []
    for row, line in enumerate(lines, start=1):
        for index, ch in enumerate(line):
            if ch not in chars:
                continue
            col = display_width(line[:index], use_wcwidth)
            if col not in expected:
                problems.append(f"line {row}: {ch!r} lands on column {col}, expected one of {sorted(expected)}")
    return problems


def parse_columns(spec: str) -> list[int]:
    return [int(part) for part in spec.split(",") if part.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify an ASCII diagram aligns in any monospace font.")
    parser.add_argument("file", help="diagram file to check, or - for stdin")
    parser.add_argument("--box", action="store_true", help="assert every non-blank row has the same width")
    parser.add_argument("--connectors", help="comma-separated columns where vertical connectors must land")
    parser.add_argument("--connector-chars", default=CONNECTOR_CHARS, help="characters treated as connectors")
    parser.add_argument("--wcwidth", action="store_true", help="fallback: allow Unicode and measure display width via wcwidth instead of enforcing ASCII")
    args = parser.parse_args()

    lines = read_lines(args.file)
    failures = []

    if args.wcwidth:
        if wcswidth is None:
            print("error: --wcwidth needs the wcwidth package (pip install wcwidth)", file=sys.stderr)
            return 2
    else:
        failures += [f"[ascii] {p}" for p in check_ascii(lines)]

    if args.box:
        failures += [f"[box] {p}" for p in check_box(lines, args.wcwidth)]

    if args.connectors:
        columns = parse_columns(args.connectors)
        problems = check_connectors(lines, columns, args.connector_chars, args.wcwidth)
        failures += [f"[connectors] {p}" for p in problems]

    if failures:
        print(f"FAIL: {args.file}")
        for failure in failures:
            print(f"  {failure}")
        return 1

    print(f"OK: {args.file} ({len(lines)} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
