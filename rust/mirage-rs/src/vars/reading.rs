//! The session as arithmetic reads it: the store behind the evaluator's
//! questions, `RANDOM` drawing through an evaluation's scratch generator.

use super::*;
use crate::integer::parse_decimal;

/// The session as arithmetic reads it.
pub(super) struct Reading<'s> {
    pub(super) store: &'s mut Store,
    pub(super) draws: Option<&'s mut Draws>,
    /// The error a question raised, which the evaluation stops on.
    pub(super) kept: Option<arith::Error>,
}

impl<'s> Reading<'s> {
    pub(super) fn plain(store: &'s mut Store) -> Self {
        Self {
            store,
            draws: None,
            kept: None,
        }
    }

    pub(super) fn evaluate(
        &mut self,
        text: &[u8],
        added: Option<&[u8]>,
        nounset: bool,
        dynamic: &[String],
        expand: bool,
    ) -> Outcome {
        let request = arith::Request {
            expression: text,
            added,
            nounset,
            elements: true,
            dynamic,
            expand,
        };
        let mut outcome = arith::evaluate(&request, self);
        if let Err(arith::Error::Halt { subscript }) = outcome.value {
            if let Some(mut kept) = self.kept.take() {
                if let arith::Error::Arith {
                    subscript: inner, ..
                } = &mut kept
                {
                    *inner |= subscript;
                }
                outcome.value = Err(kept);
            }
        }
        outcome
    }

    fn keep<T>(&mut self, answer: Result<T, arith::Error>) -> Result<T, Halt> {
        answer.map_err(|error| {
            self.kept = Some(error);
            Halt
        })
    }
}

impl Vars for Reading<'_> {
    fn draw(&mut self, name: &str) -> Result<Option<Vec<u8>>, Halt> {
        if let Some(value) = self.store.dynamic(name) {
            return Ok(Some(value));
        }
        if !self.store.random_special(name) {
            return Ok(None);
        }
        let Some(draws) = self.draws.as_deref_mut() else {
            return Ok(None);
        };
        if draws.seeded.is_none() {
            let value = self.store.next_random();
            return self
                .keep(value)
                .map(|v| v.map(|v| v.to_string().into_bytes()));
        }
        let (state, value) = draw(draws.state, draws.last);
        draws.state = state;
        draws.last = value;
        draws.count += 1;
        Ok(Some(value.to_string().into_bytes()))
    }

    fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, Halt> {
        if let Some(text) = self.store.scalar(name) {
            return Ok(Some(text.to_vec()));
        }
        self.element(name, b"0")
    }

    fn holds_array(&mut self, name: &str) -> Result<bool, Halt> {
        Ok(self.store.array(name).is_some() || self.store.assoc(name).is_some())
    }

    fn assoc(&mut self, name: &str) -> Result<bool, Halt> {
        Ok(self.store.assoc(name).is_some())
    }

    fn resolve(&mut self, name: &str, subscript: &[u8]) -> Result<Vec<u8>, Halt> {
        if self.store.assoc(name).is_some() {
            return Ok(strip_key_quotes(subscript).to_vec());
        }
        let mut index: i64 = parse_decimal(subscript).unwrap_or(0);
        if index < 0 {
            if let Some(array) = self.store.array(name) {
                index = array.back(index);
            } else if self.store.scalar(name).is_some() {
                index += 1;
            }
            if index < 0 {
                let mut expression = name.as_bytes().to_vec();
                expression.push(b'[');
                expression.extend_from_slice(subscript);
                expression.push(b']');
                return self.keep(Err(arith::Error::Arith {
                    reason: "bad array subscript".to_owned(),
                    expression,
                    token: None,
                    subscript: false,
                }));
            }
        }
        Ok(index.to_string().into_bytes())
    }

    fn element(&mut self, name: &str, key: &[u8]) -> Result<Option<Vec<u8>>, Halt> {
        let index: i64 = parse_decimal(key).unwrap_or(0);
        if let Some(array) = self.store.array(name) {
            return Ok(array.get(index).map(<[u8]>::to_vec));
        }
        if let Some(map) = self.store.assoc(name) {
            return Ok(map.get(key).map(<[u8]>::to_vec));
        }
        Ok(self
            .store
            .scalar(name)
            .filter(|_| index == 0)
            .map(<[u8]>::to_vec))
    }

    fn frozen(&mut self, name: &str) -> Result<Option<String>, Halt> {
        Ok(self.store.frozen(name))
    }

    fn wrote(&mut self, name: &str, value: &str) -> Result<(), Halt> {
        if !self.store.random_special(name) {
            return Ok(());
        }
        if let Some(draws) = self.draws.as_deref_mut() {
            draws.seeded = Some(value.to_owned());
            draws.state = value.parse::<i64>().map_or(0, |v| v as u32);
            draws.last = 0;
            draws.count = 0;
        }
        Ok(())
    }
}
