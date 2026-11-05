use serde::Deserialize;

use crate::{Stream, StreamError, parse_config, strftime::Strftime};

const WORK: usize = 16384;

#[derive(Deserialize)]
#[serde(untagged)]
enum Part {
    Literal {
        #[serde(deserialize_with = "crate::latin1")]
        lit: Vec<u8>,
    },
    Directive {
        dir: char,
    },
    Time {
        time: char,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    parts: Vec<Part>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    #[serde(deserialize_with = "crate::latin1")]
    path: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1")]
    base: Vec<u8>,
    size: u64,
    kind: char,
    target: char,
    mode: Option<u32>,
    #[serde(deserialize_with = "crate::latin1")]
    owner: Vec<u8>,
    #[serde(deserialize_with = "crate::latin1")]
    group: Vec<u8>,
    timestamp: f64,
    #[serde(skip)]
    epoch: i64,
    #[serde(skip)]
    micros: u32,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { parts } = parse_config(config)?;
    Ok(Box::new(Formatter {
        parts,
        row: None,
        time: None,
        part: 0,
        offset: 0,
        value: Vec::new(),
        started: false,
    }))
}

struct Formatter {
    parts: Vec<Part>,
    row: Option<Row>,
    time: Option<Strftime>,
    part: usize,
    offset: usize,
    value: Vec<u8>,
    started: bool,
}

impl Stream for Formatter {
    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        if self.busy() {
            return Err(StreamError::new("find: formatter still has output"));
        }
        let mut row: Row = parse_config(config)?;
        let micros = (row.timestamp * 1_000_000.0).round_ties_even() as i64;
        row.epoch = micros.div_euclid(1_000_000);
        row.micros = micros.rem_euclid(1_000_000) as u32;
        if !"cdlpfU".contains(row.kind)
            || !"cdlpfUN".contains(row.target)
            || row.micros >= 1_000_000
        {
            return Err(StreamError::new("find: invalid row facts"));
        }
        self.time = Some(Strftime::utc(row.epoch, row.micros * 1000)?);
        self.row = Some(row);
        self.part = 0;
        self.offset = 0;
        self.value.clear();
        self.started = false;
        Ok(())
    }

    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.started = true;
        self.drain(out)
    }

    fn busy(&self) -> bool {
        self.started && self.row.is_some() && self.part < self.parts.len()
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let Some(row) = self.row.as_ref() else {
            return Ok(());
        };
        let limit = out.len().saturating_add(WORK);
        let mut steps = 0;
        while self.part < self.parts.len() && out.len() < limit && steps < 64 {
            let part = &self.parts[self.part];
            if self.offset == 0 && !matches!(part, Part::Literal { .. }) {
                self.value = match part {
                    Part::Directive { dir } => directive(*dir, row),
                    Part::Time { time } => time_field(*time, row, self.time.as_ref().unwrap())?,
                    _ => unreachable!(),
                };
            }
            let value = match part {
                Part::Literal { lit } => lit,
                _ => &self.value,
            };
            let end = value.len().min(self.offset + limit - out.len());
            out.extend_from_slice(&value[self.offset..end]);
            self.offset = end;
            if end == value.len() {
                self.part += 1;
                self.offset = 0;
                self.value.clear();
            }
            steps += 1;
        }
        Ok(())
    }
}

fn relative(row: &Row) -> &[u8] {
    if row.path == row.base {
        return &[];
    }
    let base = row.base.strip_suffix(b"/").unwrap_or(&row.base);
    row.path
        .strip_prefix(base)
        .and_then(|rest| rest.strip_prefix(b"/"))
        .unwrap_or(&row.path)
}

fn directive(code: char, row: &Row) -> Vec<u8> {
    let trimmed = &row.path[..row
        .path
        .iter()
        .rposition(|b| *b != b'/')
        .map_or(0, |i| i + 1)];
    match code {
        'p' => row.path.clone(),
        'P' => relative(row).to_vec(),
        'f' => {
            if trimmed.is_empty() {
                b"/".to_vec()
            } else {
                trimmed.rsplit(|b| *b == b'/').next().unwrap().to_vec()
            }
        }
        'h' => {
            if trimmed.is_empty() {
                b"/".to_vec()
            } else {
                match trimmed.iter().rposition(|b| *b == b'/') {
                    None => b".".to_vec(),
                    Some(0) => b"/".to_vec(),
                    Some(i) => trimmed[..i].to_vec(),
                }
            }
        }
        'd' => {
            let rel = relative(row);
            if rel.is_empty() {
                b"0".to_vec()
            } else {
                (rel.iter().filter(|b| **b == b'/').count() + 1)
                    .to_string()
                    .into_bytes()
            }
        }
        's' => row.size.to_string().into_bytes(),
        'y' => vec![row.kind as u8],
        'Y' => vec![row.target as u8],
        'u' | 'U' => row.owner.clone(),
        'g' | 'G' => row.group.clone(),
        'm' => format!("{:o}", mode(row)).into_bytes(),
        'M' => mode_text(row),
        _ => Vec::new(),
    }
}

fn mode(row: &Row) -> u32 {
    row.mode.unwrap_or(match row.kind {
        'd' => 0o755,
        'l' => 0o777,
        'c' => 0o666,
        'p' => 0o600,
        _ => 0o644,
    }) & 0o7777
}

fn mode_text(row: &Row) -> Vec<u8> {
    let mode = mode(row);
    let mut text = vec![if matches!(row.kind, 'U' | 'f') {
        b'-'
    } else {
        row.kind as u8
    }];
    for (shift, special, on, off) in [
        (6, 0o4000, b's', b'S'),
        (3, 0o2000, b's', b'S'),
        (0, 0o1000, b't', b'T'),
    ] {
        text.push(if mode & (4 << shift) != 0 { b'r' } else { b'-' });
        text.push(if mode & (2 << shift) != 0 { b'w' } else { b'-' });
        text.push(match (mode & (1 << shift) != 0, mode & special != 0) {
            (true, true) => on,
            (false, true) => off,
            (true, false) => b'x',
            _ => b'-',
        });
    }
    text
}

fn time_field(code: char, row: &Row, time: &Strftime) -> Result<Vec<u8>, StreamError> {
    let mut out = Vec::new();
    match code {
        '@' => out.extend_from_slice(format!("{}.{:06}0000", row.epoch, row.micros).as_bytes()),
        '+' => {
            time.render(b"%Y-%m-%d+%H:%M:%S", &mut out)?;
            out.extend_from_slice(format!(".{:06}0000", row.micros).as_bytes());
        }
        'S' | 'T' | 'X' => {
            time.render(if code == 'S' { b"%S" } else { b"%T" }, &mut out)?;
            out.extend_from_slice(format!(".{:06}0000", row.micros).as_bytes());
        }
        'Y' | 'G' => time.render(&[b'%', b'-', code as u8], &mut out)?,
        'c' => time.render(b"%a %b %e %T %-Y", &mut out)?,
        _ => time.render(&[b'%', code as u8], &mut out)?,
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn large_literals_and_many_empty_directives_yield_between_steps() {
        let mut parts = vec![json!({"lit": "x".repeat(WORK * 3 + 7)})];
        parts.extend((0..200).map(|_| json!({"dir":"P"})));
        parts.push(json!({"dir":"M"}));
        let mut engine = open(&serde_json::to_vec(&json!({"parts":parts})).unwrap()).unwrap();
        engine.begin(&serde_json::to_vec(&json!({"path":"d","base":"d","size":0,"kind":"p","target":"p","mode":null,"owner":"-","group":"-","timestamp":0})).unwrap()).unwrap();
        let mut piece = Vec::new();
        engine.finish(&mut piece).unwrap();
        let mut out = piece.clone();
        let mut turns = 1;
        while engine.busy() {
            piece.clear();
            engine.drain(&mut piece).unwrap();
            assert!(piece.len() <= WORK);
            out.extend_from_slice(&piece);
            turns += 1;
        }
        assert!(turns >= 7);
        assert_eq!(&out[..WORK * 3 + 7], vec![b'x'; WORK * 3 + 7]);
        assert_eq!(&out[WORK * 3 + 7..], b"prw-------");
    }

    #[test]
    fn rows_reuse_the_format_and_preserve_raw_bytes_and_fractional_times() {
        let mut engine = open(br#"{"parts":[{"dir":"P"},{"lit":"|"},{"dir":"M"},{"lit":"|"},{"time":"+"},{"lit":"|"},{"time":"@"}]}"#).unwrap();
        for path in ["/d/\u{ff}", "/d/z"] {
            engine.begin(&serde_json::to_vec(&json!({"path":path,"base":"/d","size":7,"kind":"f","target":"f","mode":0o4751,"owner":"-","group":"-","timestamp":-0.876544})).unwrap()).unwrap();
            let mut out = Vec::new();
            engine.finish(&mut out).unwrap();
            while engine.busy() {
                engine.drain(&mut out).unwrap();
            }
            let mut want = vec![if path.ends_with('z') { b'z' } else { 255 }];
            want.extend_from_slice(b"|-rwsr-x--x|1969-12-31+23:59:59.1234560000|-1.1234560000");
            assert_eq!(out, want);
        }
    }
}
