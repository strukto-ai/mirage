---
name: ascii-diagram
description: >-
  Produce ASCII/text diagrams (boxes, flow charts, tree/lane layouts) that stay
  aligned in every monospace font by restricting them to 7-bit ASCII and verifying
  alignment with a machine checker instead of hand-counting. Use this whenever you
  are about to draw or edit an ASCII diagram, text diagram, or box diagram, when
  asked to "draw this in ascii", and especially whenever a diagram is misaligned,
  a row is shifted, or the alignment is off by one column. Reach for it even when the
  user does not say "ASCII" — any monospace box/arrow/tree art benefits.
---

# ASCII diagram alignment

## Why diagrams drift by one column

You count Unicode **code points**; a terminal counts **display cells**. Characters
in the Unicode "East Asian Width: Ambiguous" class render as 1 cell in Western
fonts but 2 cells in CJK-capable fonts (common for e.g. Vietnamese, Chinese,
Japanese, Korean users). A single such character on one row shifts everything
after it one column right, so that row no longer lines up with the rows above and
below — even though it looked perfect to you.

Frequent culprits: circled digits `①②③`, check/cross marks, middle dot, ellipsis,
arrows, and even the box-drawing characters themselves (`─│┌┐└┘┴┬├┤`).

The fix is not "count more carefully". You cannot hand-count display width
reliably, and the reader's font is unknown. The fix is: **emit only 7-bit ASCII
(every character 0x20..0x7E, all guaranteed 1 cell wide) and verify with a script
before you show the diagram.**

## Substitution table

Replace every non-ASCII character before emitting. Apply these:

| From        | To          |
|-------------|-------------|
| `①` `②` `③` | `(1)` `(2)` `(3)` |
| `✓`         | `OK`        |
| `✗`         | `X`         |
| `…`         | `...`       |
| `·`         | `-`         |
| `→`         | `->`        |
| `─`         | `-`         |
| `│`         | `\|`        |
| `┌ ┐ └ ┘ ┴ ┬ ├ ┤` | `+` |
| `▲`         | `^`         |
| `▼`         | `v`         |

A substitution can change a token's width (`①` is 1 code point, `(1)` is 3), so
re-pad the surrounding rows so connectors still share a column, then verify.

## Workflow

Never eyeball alignment. Always:

1. Write the diagram to a temp file (e.g. `/tmp/diagram.txt`).
2. Run the checker (below). It reports every offending character or misaligned
   connector with its line and column.
3. Fix what it reports and re-run until it prints `OK`.
4. Only then emit the diagram.

## Checker

`check_diagram.py` is stdlib-only. From this skill's directory:

```bash
# ASCII purity (default): fails on any char outside 0x20..0x7E, reporting line + col
python3 check_diagram.py /tmp/diagram.txt

# Box: additionally assert every non-blank row has the same width (flush right edge)
python3 check_diagram.py /tmp/diagram.txt --box

# Vertical connectors: assert every | ^ v + lands on one of the given columns
python3 check_diagram.py /tmp/diagram.txt --connectors 11
python3 check_diagram.py /tmp/diagram.txt --connectors 4,11,18
```

Exit code is 0 on pass, 1 on any failure, so it drops straight into a
write -> check -> fix loop. Read a file, or `-` for stdin.

### Fallback: when Unicode is unavoidable

If the diagram genuinely must keep a Unicode character, pass `--wcwidth`. It stops
enforcing ASCII and instead measures each row's **display width** with
`wcwidth.wcswidth` (so `--box` and `--connectors` compare rendered cells, not code
points). This needs the third-party `wcwidth` package (`pip install wcwidth`) and
is the fallback, not the default: ASCII is still the only thing that renders the
same for every reader, in every font.

## Worked example

The real failure that motivated this skill: a lane separator `│` meant to sit in
one column across three rows, with an annotation on the middle row.

Before (`examples/before.txt`) — looks aligned to a code-point counter, but the
`①` draws as 2 cells in a CJK font, so the middle `│` renders one column right of
the others:

```
           │
① writes   │
           │
```

```
$ python3 check_diagram.py examples/before.txt --connectors 11
FAIL: examples/before.txt
  [ascii] line 1 col 11: '│' U+2502 BOX DRAWINGS LIGHT VERTICAL is not 7-bit ASCII
  [ascii] line 2 col 0: '①' U+2460 CIRCLED DIGIT ONE is not 7-bit ASCII
  [ascii] line 2 col 11: '│' U+2502 BOX DRAWINGS LIGHT VERTICAL is not 7-bit ASCII
  [ascii] line 3 col 11: '│' U+2502 BOX DRAWINGS LIGHT VERTICAL is not 7-bit ASCII
```

After (`examples/after.txt`) — `①` -> `(1)`, `│` -> `|`, rows re-padded so every
`|` lands on column 11:

```
           |
(1) writes |
           |
```

```
$ python3 check_diagram.py examples/after.txt --connectors 11
OK: examples/after.txt (3 lines)
```
