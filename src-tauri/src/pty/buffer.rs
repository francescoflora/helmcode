use std::collections::VecDeque;

pub struct RingBuffer {
    data: VecDeque<u8>,
    capacity: usize,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            data: VecDeque::with_capacity(capacity.min(64 * 1024)),
            capacity: capacity.max(1),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.capacity {
            self.data.clear();
            self.data.extend(&bytes[bytes.len() - self.capacity..]);
            return;
        }
        // Evict before extending: a full buffer must not double its allocation
        // just to discard the same bytes immediately afterwards.
        let excess = (self.data.len() + bytes.len()).saturating_sub(self.capacity);
        if excess > 0 {
            self.data.drain(..excess);
        }
        self.data.extend(bytes);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.data.iter().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::RingBuffer;

    #[test]
    fn keeps_only_the_last_bytes() {
        let mut buffer = RingBuffer::new(5);
        buffer.push(b"abc");
        buffer.push(b"def");
        assert_eq!(buffer.snapshot(), b"bcdef");
        buffer.push(b"ghijkl");
        assert_eq!(buffer.snapshot(), b"hijkl");
        assert_eq!(String::from_utf8_lossy(&buffer.snapshot()), "hijkl");
    }

    #[test]
    fn sustained_output_keeps_the_initial_allocation() {
        let mut buffer = RingBuffer::new(64);
        let allocation = buffer.data.capacity();
        for byte in 0..200u8 {
            buffer.push(&[byte; 19]);
            assert!(buffer.data.capacity() <= allocation);
            assert!(buffer.data.len() <= 64);
        }
        assert_eq!(&buffer.snapshot()[45..], &[199; 19]);
        buffer.push(&[42; 4096]);
        assert_eq!(buffer.snapshot(), vec![42; 64]);
        assert!(buffer.data.capacity() <= allocation);
    }

    #[test]
    fn zero_capacity_still_retains_the_last_byte() {
        let mut buffer = RingBuffer::new(0);
        buffer.push(b"abc");
        buffer.push(b"");
        assert_eq!(buffer.snapshot(), b"c");
    }
}
