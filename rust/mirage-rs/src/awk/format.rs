use std::collections::VecDeque;

use crate::printf::number::Rendered;
use crate::regex::Step;

use super::value::{FloatSpec, MAX_LEN, NumberScan, Text, Value, fixed_number, render_int, to_int};
use super::vm::no_memory;

enum Piece {
    Bytes(Text, usize, usize),
    Repeat(u8, usize),
}

pub(super) struct Output {
    pieces: VecDeque<Piece>,
    len: usize,
    limit: usize,
}

impl Default for Output {
    fn default() -> Self {
        Self {
            pieces: VecDeque::new(),
            len: 0,
            limit: MAX_LEN,
        }
    }
}

impl Output {
    pub(super) fn len(&self) -> usize {
        self.len
    }

    fn push(&mut self, piece: Piece) -> Result<(), Vec<u8>> {
        let len = match &piece {
            Piece::Bytes(_, start, end) => end - start,
            Piece::Repeat(_, count) => *count,
        };
        if self.len.saturating_add(len) > self.limit {
            return Err(no_memory());
        }
        self.len += len;
        if len > 0 {
            self.pieces.push_back(piece);
        }
        Ok(())
    }

    pub(super) fn text(&mut self, text: Text) -> Result<(), Vec<u8>> {
        let end = text.len();
        self.push(Piece::Bytes(text, 0, end))
    }

    fn range(&mut self, text: &Text, start: usize, end: usize) -> Result<(), Vec<u8>> {
        self.push(Piece::Bytes(text.clone(), start, end))
    }

    fn repeat(&mut self, byte: u8, count: usize) -> Result<(), Vec<u8>> {
        self.push(Piece::Repeat(byte, count))
    }

    fn padded(
        &mut self,
        prefix: Text,
        mut body: Output,
        spec: &Spec,
        allow_zero: bool,
    ) -> Result<(), Vec<u8>> {
        let gap = spec.width.saturating_sub(prefix.len() + body.len);
        let left = spec.flags[0];
        let zero = allow_zero && spec.flags[4] && !left;
        if !left && !zero {
            self.repeat(b' ', gap)?;
        }
        self.text(prefix)?;
        if zero {
            self.repeat(b'0', gap)?;
        }
        while let Some(piece) = body.pieces.pop_front() {
            self.push(piece)?;
        }
        if left {
            self.repeat(b' ', gap)?;
        }
        Ok(())
    }

    fn rendered(&mut self, rendered: Rendered, spec: &Spec) -> Result<(), Vec<u8>> {
        let mut body = Output {
            limit: self.limit,
            ..Output::default()
        };
        body.text(rendered.body.into())?;
        body.repeat(
            b'0',
            usize::try_from(rendered.zero_tail).unwrap_or(usize::MAX),
        )?;
        body.text(rendered.suffix.into())?;
        self.padded(rendered.prefix.into(), body, spec, rendered.allow_zero)
    }

    pub(super) fn retire(&mut self, work: &mut u64) -> bool {
        while *work > 0 {
            if self.pieces.pop_front().is_none() {
                self.len = 0;
                return true;
            }
            *work = work.saturating_sub(16);
        }
        false
    }

    pub(super) fn copy(&mut self, out: &mut Vec<u8>, work: &mut u64) -> bool {
        while *work > 0 {
            let Some(piece) = self.pieces.front_mut() else {
                return true;
            };
            let available = usize::try_from(*work).unwrap_or(usize::MAX);
            let (count, done) = match piece {
                Piece::Bytes(text, start, end) => {
                    let count = (*end - *start).min(available);
                    out.extend_from_slice(&text[*start..*start + count]);
                    *start += count;
                    (count, start == end)
                }
                Piece::Repeat(byte, remaining) => {
                    let count = (*remaining).min(available);
                    out.resize(out.len() + count, *byte);
                    *remaining -= count;
                    (count, *remaining == 0)
                }
            };
            *work -= count as u64;
            self.len -= count;
            if done {
                self.pieces.pop_front();
            }
        }
        self.pieces.is_empty()
    }
}

#[derive(Default)]
struct Spec {
    start: usize,
    flags: [bool; 5],
    width_start: usize,
    width_end: usize,
    width: usize,
    width_star: bool,
    precision_start: usize,
    precision: Option<usize>,
    precision_star: bool,
}

#[derive(Default)]
enum Scan {
    #[default]
    Literal,
    Flags(Spec),
    Width(Spec),
    Precision(Spec),
    Conversion(Spec),
    Error,
}

enum NumberPhase {
    Start,
    Flags,
    Width,
    Precision,
    Conversion,
}

pub(super) struct NumberText {
    value: f64,
    format: Text,
    phase: NumberPhase,
    at: usize,
    spec: Spec,
    output: Option<Output>,
    bytes: Vec<u8>,
}

impl NumberText {
    pub(super) fn new(value: f64, format: Text) -> Self {
        Self {
            value,
            format,
            phase: NumberPhase::Start,
            at: 0,
            spec: Spec::default(),
            output: None,
            bytes: Vec::new(),
        }
    }

    fn render(&mut self, conv: u8) -> Result<(), Vec<u8>> {
        let flags: Vec<u8> = b"-+ #0"
            .iter()
            .zip(self.spec.flags)
            .filter_map(|(&flag, present)| present.then_some(flag))
            .collect();
        let rendered = FloatSpec {
            flags: &flags,
            width: self.spec.width,
            precision: self.spec.precision.or(Some(6)),
            conv,
        }
        .rendered(self.value);
        let len = self
            .spec
            .width
            .max(usize::try_from(rendered.byte_len()).unwrap_or(usize::MAX));
        let mut output = Output {
            limit: len,
            ..Output::default()
        };
        output.rendered(rendered, &self.spec)?;
        self.bytes = Vec::with_capacity(len);
        self.output = Some(output);
        Ok(())
    }

    fn fallback(&mut self) -> Result<(), Vec<u8>> {
        self.spec = Spec::default();
        self.render(b'g')
    }

    pub(super) fn step(&mut self, work: &mut u64) -> Result<Step<Text>, Vec<u8>> {
        while *work > 0 {
            if let Some(output) = &mut self.output {
                return Ok(if output.copy(&mut self.bytes, work) {
                    Step::Done(std::mem::take(&mut self.bytes).into())
                } else {
                    Step::Paused
                });
            }
            *work -= 1;
            match self.phase {
                NumberPhase::Start => {
                    if let Some(text) = fixed_number(self.value) {
                        self.bytes = Vec::with_capacity(text.len());
                        let mut output = Output::default();
                        output.text(text.into())?;
                        self.output = Some(output);
                        continue;
                    }
                    if self.format.first() != Some(&b'%') {
                        self.fallback()?;
                    } else {
                        self.at = 1;
                        self.phase = NumberPhase::Flags;
                    }
                }
                NumberPhase::Flags => {
                    if let Some(flag) = self
                        .format
                        .get(self.at)
                        .and_then(|byte| b"-+ #0".iter().position(|flag| byte == flag))
                    {
                        self.spec.flags[flag] = true;
                        self.at += 1;
                    } else {
                        self.phase = NumberPhase::Width;
                    }
                }
                NumberPhase::Width => {
                    if let Some(byte @ b'0'..=b'9') = self.format.get(self.at) {
                        self.spec.width = self
                            .spec
                            .width
                            .saturating_mul(10)
                            .saturating_add((byte - b'0') as usize);
                        self.at += 1;
                        if self.spec.width > MAX_LEN {
                            self.fallback()?;
                        }
                    } else if self.format.get(self.at) == Some(&b'.') {
                        self.spec.precision = Some(0);
                        self.at += 1;
                        self.phase = NumberPhase::Precision;
                    } else {
                        self.phase = NumberPhase::Conversion;
                    }
                }
                NumberPhase::Precision => {
                    if let Some(byte @ b'0'..=b'9') = self.format.get(self.at) {
                        let precision = self
                            .spec
                            .precision
                            .unwrap()
                            .saturating_mul(10)
                            .saturating_add((byte - b'0') as usize);
                        self.spec.precision = Some(precision);
                        self.at += 1;
                        if precision > MAX_LEN {
                            self.fallback()?;
                        }
                    } else {
                        self.phase = NumberPhase::Conversion;
                    }
                }
                NumberPhase::Conversion => {
                    if self.at + 1 == self.format.len() && b"eEfFgG".contains(&self.format[self.at])
                    {
                        self.render(self.format[self.at])?;
                    } else {
                        self.fallback()?;
                    }
                }
            }
        }
        Ok(Step::Paused)
    }
}

pub(super) struct Formatter {
    text: Option<NumberText>,
    number: Option<NumberScan>,
    format: Text,
    args: std::vec::IntoIter<Value>,
    convfmt: Text,
    at: usize,
    literal: usize,
    scan: Scan,
    output: Output,
    error: Option<(Output, Vec<u8>)>,
}

impl Formatter {
    pub(super) fn new(format: Text, args: Vec<Value>, convfmt: Text) -> Self {
        Self {
            format,
            text: None,
            number: None,
            args: args.into_iter(),
            convfmt,
            at: 0,
            literal: 0,
            scan: Scan::Literal,
            output: Output::default(),
            error: None,
        }
    }

    pub(super) fn retire(&mut self, work: &mut u64) -> bool {
        if !self.output.retire(work) {
            return false;
        }
        if let Some((output, _)) = &mut self.error {
            if !output.retire(work) {
                return false;
            }
        }
        while *work > 0 {
            if self.args.next().is_none() {
                return true;
            }
            *work = work.saturating_sub(16);
        }
        false
    }

    fn take(&mut self) -> Option<Value> {
        let arg = self.args.next();
        if arg.is_none() {
            self.scan = Scan::Error;
        }
        arg
    }

    fn conversion(&mut self, mut spec: Spec, conv: u8) -> Result<(), Vec<u8>> {
        let mut width_text = None;
        let mut precision_text = None;
        let mut negative_width = false;
        if spec.width_star {
            let Some(arg) = self.take() else {
                return Ok(());
            };
            let width = to_int(arg.num());
            negative_width = width < 0;
            spec.flags[0] |= negative_width;
            spec.width = usize::try_from(width.unsigned_abs()).unwrap_or(usize::MAX);
            width_text = Some(width.unsigned_abs().to_string().into_bytes());
        }
        if spec.precision_star {
            let Some(arg) = self.take() else {
                return Ok(());
            };
            let precision = to_int(arg.num());
            spec.precision =
                (precision >= 0).then(|| usize::try_from(precision).unwrap_or(usize::MAX));
            precision_text = Some(if precision >= 0 {
                format!(".{precision}").into_bytes()
            } else {
                Vec::new()
            });
        }
        if !b"csdiouxXeEfFgGaA".contains(&conv) {
            self.output
                .range(&self.format, spec.start, spec.width_start)?;
            if negative_width {
                self.output.repeat(b'-', 1)?;
            }
            if let Some(width) = width_text {
                self.output.text(width.into())?;
            } else {
                self.output
                    .range(&self.format, spec.width_start, spec.width_end)?;
            }
            if let Some(precision) = precision_text {
                self.output.text(precision.into())?;
            } else {
                self.output
                    .range(&self.format, spec.precision_start, self.at)?;
            }
            return self.output.repeat(conv, 1);
        }
        let Some(arg) = self.take() else {
            return Ok(());
        };
        if spec.width > MAX_LEN || (conv != b's' && spec.precision.is_some_and(|p| p > MAX_LEN)) {
            return Err(no_memory());
        }
        if matches!(conv, b'c' | b's') {
            let body = match (conv, arg) {
                (b'c', Value::Num(n)) => vec![(to_int(n) & 0xff) as u8].into(),
                (_, other) => other.into_text(),
            };
            let end = if conv == b'c' {
                body.len().min(1)
            } else {
                body.len().min(spec.precision.unwrap_or(usize::MAX))
            };
            let mut field = Output::default();
            field.push(Piece::Bytes(body, 0, end))?;
            return self.output.padded(Text::default(), field, &spec, false);
        }
        let flags: Vec<u8> = b"-+ #0"
            .iter()
            .zip(spec.flags)
            .filter_map(|(&flag, present)| present.then_some(flag))
            .collect();
        let rendered = if b"diouxX".contains(&conv) {
            render_int(arg.num(), conv, &flags, spec.precision)
        } else {
            FloatSpec {
                flags: &flags,
                width: spec.width,
                precision: spec.precision,
                conv: match conv {
                    b'a' => b'g',
                    b'A' => b'G',
                    other => other,
                },
            }
            .rendered(arg.num())
        };
        self.output.rendered(rendered, &spec)
    }

    pub(super) fn step(&mut self, work: &mut u64) -> Result<Step<Output>, Vec<u8>> {
        while *work > 0 {
            if let Scan::Conversion(spec) = &self.scan {
                if let Some(&conv) = self.format.get(self.at) {
                    let count = usize::from(spec.width_star)
                        + usize::from(spec.precision_star)
                        + usize::from(b"diouxXeEfFgGaA".contains(&conv));
                    for arg in self.args.as_slice().iter().take(count) {
                        if !arg.prepare_number(&mut self.number, work) {
                            return Ok(Step::Paused);
                        }
                    }
                    if conv == b's' && spec.width <= MAX_LEN {
                        let at = usize::from(spec.width_star) + usize::from(spec.precision_star);
                        if let Some(arg @ Value::Num(_)) = self.args.as_mut_slice().get_mut(at) {
                            let value = arg.num();
                            let text = self.text.get_or_insert_with(|| {
                                NumberText::new(value, self.convfmt.clone())
                            });
                            match text.step(work)? {
                                Step::Paused => return Ok(Step::Paused),
                                Step::Done(text) => {
                                    *arg = Value::Str(text);
                                    self.text = None;
                                }
                            }
                        }
                    }
                }
                if *work == 0 {
                    return Ok(Step::Paused);
                }
            }
            *work -= 1;
            match std::mem::take(&mut self.scan) {
                Scan::Literal => {
                    if self.at == self.format.len() {
                        self.output.range(&self.format, self.literal, self.at)?;
                        return Ok(Step::Done(std::mem::take(&mut self.output)));
                    }
                    if self.format[self.at] == b'%' {
                        self.output.range(&self.format, self.literal, self.at)?;
                        if self.format.get(self.at + 1) == Some(&b'%') {
                            self.output.repeat(b'%', 1)?;
                            self.at += 2;
                            self.literal = self.at;
                        } else {
                            self.scan = Scan::Flags(Spec {
                                start: self.at,
                                ..Spec::default()
                            });
                            self.at += 1;
                        }
                    } else {
                        self.at += 1;
                    }
                }
                Scan::Flags(mut spec) => {
                    if let Some(flag) = self
                        .format
                        .get(self.at)
                        .and_then(|byte| b"-+ #0".iter().position(|flag| byte == flag))
                    {
                        spec.flags[flag] = true;
                        self.at += 1;
                        self.scan = Scan::Flags(spec);
                    } else {
                        spec.width_start = self.at;
                        self.scan = Scan::Width(spec);
                    }
                }
                Scan::Width(mut spec) => {
                    if self.format.get(self.at) == Some(&b'*') && self.at == spec.width_start {
                        spec.width_star = true;
                        self.at += 1;
                    } else if let Some(byte @ b'0'..=b'9') = self.format.get(self.at) {
                        spec.width = spec
                            .width
                            .saturating_mul(10)
                            .saturating_add((byte - b'0') as usize);
                        self.at += 1;
                        self.scan = Scan::Width(spec);
                        continue;
                    }
                    spec.width_end = self.at;
                    spec.precision_start = self.at;
                    if self.format.get(self.at) == Some(&b'.') {
                        spec.precision = Some(0);
                        self.at += 1;
                        self.scan = Scan::Precision(spec);
                    } else {
                        self.scan = Scan::Conversion(spec);
                    }
                }
                Scan::Precision(mut spec) => {
                    if self.format.get(self.at) == Some(&b'*')
                        && self.at == spec.precision_start + 1
                    {
                        spec.precision_star = true;
                        self.at += 1;
                    } else if let Some(byte @ b'0'..=b'9') = self.format.get(self.at) {
                        spec.precision = Some(
                            spec.precision
                                .unwrap()
                                .saturating_mul(10)
                                .saturating_add((byte - b'0') as usize),
                        );
                        self.at += 1;
                        self.scan = Scan::Precision(spec);
                        continue;
                    }
                    self.scan = Scan::Conversion(spec);
                }
                Scan::Conversion(spec) => {
                    let Some(&conv) = self.format.get(self.at) else {
                        self.output.repeat(b'%', 1)?;
                        return Ok(Step::Done(std::mem::take(&mut self.output)));
                    };
                    self.conversion(spec, conv)?;
                    self.at += 1;
                    self.literal = self.at;
                }
                Scan::Error => {
                    if self.error.is_none() {
                        let mut output = Output::default();
                        output.text(
                            b"awk: not enough arguments to satisfy format string '"
                                .to_vec()
                                .into(),
                        )?;
                        output.text(self.format.clone())?;
                        output.repeat(b'\'', 1)?;
                        self.error = Some((output, Vec::new()));
                    }
                    let (output, bytes) = self.error.as_mut().unwrap();
                    if output.copy(bytes, work) {
                        return Err(std::mem::take(bytes));
                    }
                    self.scan = Scan::Error;
                }
            }
        }
        Ok(Step::Paused)
    }
}

pub(super) struct Print {
    text: Option<NumberText>,
    args: std::vec::IntoIter<Value>,
    ofmt: Text,
    ofs: Text,
    ors: Text,
    first: bool,
    output: Output,
}

impl Print {
    pub(super) fn retire(&mut self, work: &mut u64) -> bool {
        if !self.output.retire(work) {
            return false;
        }
        while *work > 0 {
            if self.args.next().is_none() {
                return true;
            }
            *work = work.saturating_sub(16);
        }
        false
    }

    pub(super) fn new(args: Vec<Value>, ofmt: Text, ofs: Text, ors: Text) -> Self {
        Self {
            args: args.into_iter(),
            text: None,
            ofmt,
            ofs,
            ors,
            first: true,
            output: Output::default(),
        }
    }

    pub(super) fn step(&mut self, work: &mut u64) -> Result<Step<Output>, Vec<u8>> {
        while *work > 0 {
            if let Some(text) = &mut self.text {
                match text.step(work)? {
                    Step::Paused => return Ok(Step::Paused),
                    Step::Done(text) => {
                        self.output.text(text)?;
                        self.text = None;
                    }
                }
                continue;
            }
            *work = work.saturating_sub(16);
            let Some(arg) = self.args.next() else {
                self.output.text(self.ors.clone())?;
                return Ok(Step::Done(std::mem::take(&mut self.output)));
            };
            if !self.first {
                self.output.text(self.ofs.clone())?;
            }
            self.first = false;
            match arg {
                Value::Num(value) => self.text = Some(NumberText::new(value, self.ofmt.clone())),
                other => self.output.text(other.into_text())?,
            }
        }
        Ok(Step::Paused)
    }
}

#[cfg(test)]
mod tests {
    use super::super::value::string;
    use super::*;

    fn format(fmt: &[u8], args: Vec<Value>, budget: u64) -> (Result<Vec<u8>, Vec<u8>>, usize) {
        let mut task = Formatter::new(fmt.to_vec().into(), args, b"%.6g".to_vec().into());
        let mut turns = 0;
        loop {
            turns += 1;
            assert!(turns < 1_000_000);
            let mut work = budget;
            match task.step(&mut work) {
                Err(error) => return (Err(error), turns),
                Ok(Step::Paused) => {}
                Ok(Step::Done(mut output)) => {
                    let mut bytes = Vec::with_capacity(output.len());
                    while !output.copy(&mut bytes, &mut { budget }) {
                        turns += 1;
                        assert!(turns < 1_000_000);
                    }
                    return (Ok(bytes), turns);
                }
            }
        }
    }

    #[test]
    fn control_formats_resume_and_match_scalar_conversion() {
        let mut formats: Vec<Vec<u8>> = [
            "",
            "%",
            "literal",
            "prefix%f",
            "%f suffix",
            "%s",
            "%d",
            "%*f",
            "%.*g",
            "%g",
            "%G",
            "%e",
            "%E",
            "%f",
            "%F",
            "%.g",
            "%.0g",
            "%.2f",
            "%12.3e",
            "%+012.4f",
            "%#012.3g",
            "%-012.3g",
            "%--++  ##00012.4G",
            "%999999999999f",
        ]
        .into_iter()
        .map(|format| format.as_bytes().to_vec())
        .collect();
        formats.push(format!("%{}f", "+".repeat(8193)).into_bytes());
        formats.push(format!("%.{}f", "0".repeat(8193)).into_bytes());
        formats.push(b"%8193.2f".to_vec());
        formats.push(b"%.8193f".to_vec());
        for format in formats {
            for value in [
                0.0,
                -0.0,
                17.0,
                1.25,
                -1.25,
                1e23,
                1e-24,
                f64::MAX,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NAN,
            ] {
                let expected = super::super::value::format_num(value, &format);
                for budget in [1, 2, 7, 20000] {
                    let mut task = NumberText::new(value, format.clone().into());
                    let mut turns = 0;
                    let actual = loop {
                        turns += 1;
                        assert!(turns < format.len() + expected.len() + 32);
                        let mut work = budget;
                        if let Step::Done(text) = task.step(&mut work).unwrap() {
                            break text;
                        }
                        assert_eq!(work, 0);
                    };
                    assert_eq!(
                        actual.as_slice(),
                        expected,
                        "value {value}, format size {}, budget {budget}",
                        format.len()
                    );
                }
            }
        }
    }

    #[test]
    fn conversion_boundaries_preserve_flags_stars_and_unknown_conversions() {
        for budget in [1, 2, 7, 20000] {
            for (fmt, args, expected) in [
                ("%05d", vec![Value::Num(-42.0)], "-0042"),
                ("%05d", vec![Value::Num(42.0)], "00042"),
                ("%-05d", vec![Value::Num(42.0)], "42   "),
                ("%#08x", vec![Value::Num(31.0)], "0x00001f"),
                ("%0.5d", vec![Value::Num(-42.0)], "-00042"),
                (
                    "%*.*s",
                    vec![Value::Num(-5.0), Value::Num(2.0), string(b"hello".to_vec())],
                    "he   ",
                ),
                ("%*.*z", vec![Value::Num(-5.0), Value::Num(-1.0)], "%-5z"),
                ("%--0002.03z", vec![], "%--0002.03z"),
                ("a%%b%*", vec![], "a%b%"),
                (
                    "%c|%.0s",
                    vec![Value::Num(65.0), string(b"hi".to_vec())],
                    "A|",
                ),
                ("%.5f", vec![Value::Num(1.25)], "1.25000"),
            ] {
                assert_eq!(
                    format(fmt.as_bytes(), args, budget).0,
                    Ok(expected.as_bytes().to_vec()),
                    "{fmt}, budget {budget}"
                );
            }
        }
    }

    #[test]
    fn long_literals_flags_precision_and_padding_resume() {
        let size = 131073;
        for (fmt, args, expected) in [
            ("x".repeat(size), vec![], vec![b'x'; size]),
            (
                format!("%{}d", "-".repeat(size)),
                vec![Value::Num(7.0)],
                b"7".to_vec(),
            ),
            (
                format!("%.{}s", "0".repeat(size)),
                vec![string(vec![b'a'; size])],
                Vec::new(),
            ),
            (
                format!("%{size}s"),
                vec![string(Vec::new())],
                vec![b' '; size],
            ),
            (
                format!("%.{size}d"),
                vec![Value::Num(0.0)],
                vec![b'0'; size],
            ),
            (
                "%s".to_owned(),
                vec![string(vec![b'a'; size])],
                vec![b'a'; size],
            ),
        ] {
            let (actual, turns) = format(fmt.as_bytes(), args, 4096);
            assert_eq!(actual, Ok(expected));
            assert!(turns > 30);
        }
        let fmt = format!("{}%s", "x".repeat(size));
        let (error, turns) = format(fmt.as_bytes(), vec![], 4096);
        let expected = format!("awk: not enough arguments to satisfy format string '{fmt}'");
        assert_eq!(error, Err(expected.into_bytes()));
        assert!(turns > 60);
    }
}
