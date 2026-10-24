use serde::Deserialize;

use crate::records::{Records, Take};
use crate::{Stream, StreamError, parse_config};

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Method {
    None,
    Prepend,
    Append,
    Separate,
    Both,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    count: bool,
    repeated: bool,
    unique: bool,
    #[serde(deserialize_with = "crate::saturating_usize")]
    skip_fields: usize,
    #[serde(deserialize_with = "crate::saturating_usize")]
    skip_chars: usize,
    #[serde(deserialize_with = "crate::saturating_usize_opt")]
    check_chars: Option<usize>,
    ignore_case: bool,
    all_repeated: Option<Method>,
    group: Option<Method>,
    zero_terminated: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Uniq {
        terminator: if config.zero_terminated { 0 } else { b'\n' },
        config,
        records: Records::default(),
        first: None,
        key: Vec::new(),
        count: 0,
        groups: 0,
        repeated_groups: 0,
    }))
}

/// GNU uniq over bytes, in every locale: -f skips runs of blanks and the
/// non-blanks after each, -s and -w count bytes, and -i folds ASCII only.
struct Uniq {
    config: Config,
    terminator: u8,
    records: Records,
    first: Option<Vec<u8>>,
    key: Vec<u8>,
    count: u64,
    groups: u64,
    repeated_groups: u64,
}

impl Uniq {
    fn key(&self, line: &[u8]) -> Vec<u8> {
        let blank = |byte: &u8| *byte == b' ' || *byte == b'\t';
        let mut at = 0;
        for _ in 0..self.config.skip_fields {
            if at >= line.len() {
                break;
            }
            at += line[at..].iter().take_while(|b| blank(b)).count();
            at += line[at..].iter().take_while(|b| !blank(b)).count();
        }
        let rest = &line[at.saturating_add(self.config.skip_chars).min(line.len())..];
        let rest = &rest[..self
            .config
            .check_chars
            .unwrap_or(usize::MAX)
            .min(rest.len())];
        if self.config.ignore_case {
            rest.to_ascii_lowercase()
        } else {
            rest.to_vec()
        }
    }

    fn record(&self, line: &[u8], count: u64, out: &mut Vec<u8>) {
        if self.config.count {
            out.extend_from_slice(format!("{count:>7} ").as_bytes());
        }
        out.extend_from_slice(line);
        out.push(self.terminator);
    }

    fn close_group(&self, out: &mut Vec<u8>) {
        let config = &self.config;
        let Some(first) = &self.first else { return };
        if config.all_repeated.is_none()
            && (config.count || config.unique)
            && !(config.repeated && self.count == 1)
            && !(config.unique && self.count > 1)
        {
            self.record(first, self.count, out);
        }
    }

    fn line(&mut self, line: Vec<u8>, out: &mut Vec<u8>) {
        let key = self.key(&line);
        if self.first.is_none() || key != self.key {
            self.close_group(out);
            self.first = Some(line.clone());
            self.key = key;
            self.count = 0;
            self.groups += 1;
        }
        self.count += 1;
        let config = &self.config;
        let first = self.first.as_deref().unwrap_or_default();
        let repeated_groups = self.repeated_groups;
        if let Some(group) = config.group {
            let before = matches!(group, Method::Prepend | Method::Both) || self.groups > 1;
            if self.count == 1 && before {
                out.push(self.terminator);
            }
            self.record(&line, 1, out);
        } else if let Some(method) = config.all_repeated {
            if self.count == 2 {
                if method == Method::Prepend || (method == Method::Separate && repeated_groups > 0)
                {
                    out.push(self.terminator);
                }
                self.record(first, 1, out);
            }
            if self.count >= 2 {
                self.record(&line, 1, out);
            }
            if self.count == 2 {
                self.repeated_groups += 1;
            }
        } else if !(config.count || config.unique)
            && self.count == if config.repeated { 2 } else { 1 }
        {
            self.record(first, 1, out);
        }
    }

    fn pump(&mut self, out: &mut Vec<u8>) {
        loop {
            match self.records.next(self.terminator) {
                Take::Record(line) => self.line(line, out),
                Take::Wait => return,
                Take::End => {
                    self.close_group(out);
                    if self.first.is_some()
                        && matches!(self.config.group, Some(Method::Append | Method::Both))
                    {
                        out.push(self.terminator);
                    }
                    self.first = None;
                    return;
                }
            }
        }
    }
}

impl Stream for Uniq {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.records.push(input);
        self.pump(out);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.records.ended() {
            self.records.end();
            self.pump(out);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{config, run};

    fn uniq(options: &str, input: &[u8]) -> Vec<u8> {
        let config = config(
            r#"{"count":false,"repeated":false,"unique":false,"skip_fields":0,"skip_chars":0,"check_chars":null,"ignore_case":false,"all_repeated":null,"group":null,"zero_terminated":false}"#,
            options,
        );
        let whole = run("uniq", &config, &[input]);
        for width in [1, 3] {
            let chunks: Vec<&[u8]> = input.chunks(width).collect();
            assert_eq!(run("uniq", &config, &chunks), whole, "width {width}");
        }
        assert!(whole.1.is_none());
        whole.0
    }

    #[test]
    fn keys_count_bytes_and_fold_ascii_only() {
        let folded = uniq(r#"{"ignore_case":true}"#, "é\nÉ\nA\na".as_bytes());
        assert_eq!(folded, "é\nÉ\nA\n".as_bytes());
        let skipped = uniq(r#"{"skip_chars":1}"#, "éa\nèa\n".as_bytes());
        assert_eq!(skipped, "éa\nèa\n".as_bytes());
        let fields = uniq(
            r#"{"skip_fields":1,"skip_chars":2,"check_chars":2}"#,
            b"x  abc\ny  abd\n",
        );
        assert_eq!(fields, b"x  abc\n");
        let blanks = uniq(r#"{"skip_fields":1,"check_chars":2}"#, b"x  abc\ny\tabd\n");
        assert_eq!(blanks, b"x  abc\ny\tabd\n");
    }

    #[test]
    fn counts_groups_and_repeats_follow_gnu_layout() {
        let input = b"a\na\nb\nc\nc\nc";
        assert_eq!(
            uniq(r#"{"count":true}"#, input),
            b"      2 a\n      1 b\n      3 c\n"
        );
        assert_eq!(uniq(r#"{"repeated":true}"#, input), b"a\nc\n");
        assert_eq!(uniq(r#"{"unique":true}"#, input), b"b\n");
        assert_eq!(uniq(r#"{"repeated":true,"unique":true}"#, input), b"");
        assert_eq!(
            uniq(r#"{"all_repeated":"separate"}"#, input),
            b"a\na\n\nc\nc\nc\n"
        );
        assert_eq!(uniq(r#"{"group":"both"}"#, b"a\na\nb"), b"\na\na\n\nb\n\n");
        assert_eq!(uniq(r#"{"group":"both"}"#, b""), b"");
        assert_eq!(uniq(r#"{"zero_terminated":true}"#, b"a\0a\0b"), b"a\0b\0");
    }
}
