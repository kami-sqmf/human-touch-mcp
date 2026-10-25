//! Bounded line framing; oversized frames are drained without allocating them.
use std::io::{self, BufRead};
pub const MAX_LINE: usize = 2 * 1024 * 1024;
pub enum Line {
    Data(Vec<u8>),
    TooLong,
    Eof,
}
pub fn read_line<R: BufRead>(reader: &mut R) -> io::Result<Line> {
    let mut data = Vec::new();
    let mut oversized = false;
    let mut seen = false;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(if oversized {
                Line::TooLong
            } else if seen {
                Line::Data(data)
            } else {
                Line::Eof
            });
        }
        seen = true;
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(bytes.len(), |index| index + 1);
        let payload = newline.map_or(count, |index| index);
        if !oversized {
            if data.len().saturating_add(payload) > MAX_LINE {
                data.clear();
                oversized = true;
            } else {
                data.extend_from_slice(&bytes[..payload]);
            }
        }
        reader.consume(count);
        if newline.is_some() {
            if data.last() == Some(&b'\r') {
                data.pop();
            }
            return Ok(if oversized {
                Line::TooLong
            } else {
                Line::Data(data)
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_frames_are_drained_and_next_request_is_preserved() {
        let mut input = vec![b'x'; MAX_LINE + 1];
        input.extend_from_slice(b"\n{\"id\":3,\"command\":\"ping\"}\r\n");
        let mut reader = io::BufReader::with_capacity(17, input.as_slice());
        assert!(matches!(read_line(&mut reader).unwrap(), Line::TooLong));
        match read_line(&mut reader).unwrap() {
            Line::Data(bytes) => assert_eq!(bytes, b"{\"id\":3,\"command\":\"ping\"}"),
            _ => panic!("Next request lost"),
        }
        assert!(matches!(read_line(&mut reader).unwrap(), Line::Eof));
    }
}
