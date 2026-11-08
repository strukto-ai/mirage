//! A parameter's value: the specials, the positionals, and element 0
//! of a name that holds an array.

use super::{Chunk, Expander, Host, ifs_joiner, splat};

use crate::integer::parse_decimal;
use crate::interp::Signal;
use crate::interp::parameter::starts_name;
use crate::interp::write::Fault;
use crate::vars::RANDOM;

impl<H: Host> Expander<'_, H> {
    /// A parameter's value where nothing splits. `strict` is `set -u`'s
    /// refusal of an unset name or positional; the defaulting operators
    /// pass false. The specials never refuse.
    pub(super) fn lookup(&mut self, name: &[u8], strict: bool) -> Result<Vec<u8>, Fault> {
        let nounset = strict && self.shell.option("nounset");
        let params = self.shell.params();
        match name {
            b"@" => return Ok(params.join(&b' ')),
            b"*" => {
                return Ok(params.join(ifs_joiner(self.shell.ifs(), self.shell.utf8()).as_slice()));
            }
            b"#" => return Ok(params.len().to_string().into_bytes()),
            b"?" => return Ok(self.shell.status.to_string().into_bytes()),
            b"$" => return Ok(self.shell.pid.to_string().into_bytes()),
            b"-" => return Ok(self.shell.flags()),
            b"!" => {
                return Ok(self
                    .shell
                    .last_job
                    .map(|job| job.to_string().into_bytes())
                    .unwrap_or_default());
            }
            _ => {}
        }
        if name.iter().all(u8::is_ascii_digit) && !name.is_empty() {
            let index: usize = parse_decimal(name).unwrap_or(usize::MAX);
            if index == 0 {
                return Ok(self.shell.argv0.clone());
            }
            if let Some(param) = params.get(index - 1) {
                return Ok(param.clone());
            }
            if nounset {
                return Err(Signal::unbound(
                    self.shell.vars.voice(),
                    &String::from_utf8_lossy(name),
                )
                .into());
            }
            return Ok(Vec::new());
        }
        let name = String::from_utf8_lossy(name).into_owned();
        if name == RANDOM {
            if let Some(value) = self.shell.vars.next_random().map_err(Fault::Arith)? {
                return Ok(value.to_string().into_bytes());
            }
        }
        match self.shell.zero(&name) {
            Some(value) => Ok(value),
            None if nounset => Err(Signal::unbound(self.shell.vars.voice(), &name).into()),
            None => Ok(Vec::new()),
        }
    }

    /// One `$name` as pieces: `$@` is one field per positional parameter,
    /// quoted or not, and so is an unquoted `$*`; inside double quotes `$*`
    /// is the parameters joined on IFS's first character.
    pub(super) fn parameter_chunks(
        &mut self,
        name: &[u8],
        quoted: bool,
    ) -> Result<Vec<Chunk>, Fault> {
        if name != b"@" && name != b"*" {
            let positional = name.iter().all(u8::is_ascii_digit) && name != b"0";
            if positional && self.shell.option("nounset") && !self.positional_set(name) {
                let spelled = format!("${}", String::from_utf8_lossy(name));
                return Err(Signal::unbound(self.shell.vars.voice(), &spelled).into());
            }
            return Ok(vec![Chunk::value(self.lookup(name, true)?, quoted)]);
        }
        let params = self.shell.params().to_vec();
        let joiner = if name == b"@" {
            b" ".to_vec()
        } else {
            ifs_joiner(self.shell.ifs(), self.shell.utf8())
        };
        if name == b"*" && quoted {
            return Ok(vec![Chunk::value(params.join(joiner.as_slice()), true)]);
        }
        Ok(splat(&params, &joiner, quoted))
    }

    /// A plain name's or a positional's value when it holds one: element
    /// 0 of an array, a map's key `0`, a positional the count reaches, a
    /// special that is not empty. An array named `RANDOM` is read, not
    /// drawn from.
    pub(super) fn held(&mut self, name: &[u8]) -> Result<Option<Vec<u8>>, Fault> {
        if !starts_name(name.first()) {
            let value = self.lookup(name, false)?;
            return Ok((!value.is_empty() || self.positional_set(name)).then_some(value));
        }
        let var = String::from_utf8_lossy(name).into_owned();
        let array = self.shell.indexed(&var).is_some() || self.shell.vars.assoc(&var).is_some();
        if var == RANDOM && !array {
            if let Some(drawn) = self.shell.vars.next_random().map_err(Fault::Arith)? {
                return Ok(Some(drawn.to_string().into_bytes()));
            }
        }
        Ok(self.shell.zero(&var))
    }

    /// Whether a name holds a value, read without drawing `$RANDOM`.
    pub(super) fn holds(&self, var: &str) -> bool {
        var == RANDOM || self.shell.zero(var).is_some()
    }

    /// Whether `name` is a positional parameter the count reaches, set
    /// even when empty (`set -- ""` sets `$1`).
    pub(super) fn positional_set(&self, name: &[u8]) -> bool {
        if name.is_empty() || !name.iter().all(u8::is_ascii_digit) {
            return false;
        }
        let index: usize = parse_decimal(name).unwrap_or(usize::MAX);
        index == 0 || index <= self.shell.params().len()
    }
}
