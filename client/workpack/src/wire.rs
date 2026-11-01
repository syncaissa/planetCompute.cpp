//! The binary messages between a SherpaHub and its devices (docs/SHERPAHUB.md section 4). Little-endian, one
//! WebSocket binary message each. Decoding checks every length against what the message declares BEFORE allocating,
//! so a lying or truncated message is refused, never trusted.

use crate::kernels::{FREIVALDS_MAX, KERNEL_MATMUL_I8};
use sha2::{Digest, Sha256};

pub const MAGIC: u32 = 0x5057_4350; // "PCWP"
pub const VERSION: u8 = 1;
pub const MAX_MESSAGE: usize = 64 << 20;
pub const MAX_UNITS: usize = 255;

pub const KIND_PACK: u8 = 1;
pub const KIND_RESULT: u8 = 2;
pub const KIND_NEED: u8 = 3;
pub const KIND_BLOCK: u8 = 4;

pub type BlockId = [u8; 16];

/// A block's id: the first 16 bytes of SHA-256 of its bytes.
pub fn block_id(bytes: &[u8]) -> BlockId {
    let d = Sha256::digest(bytes);
    let mut id = [0u8; 16];
    id.copy_from_slice(&d[..16]);
    id
}

/// One matmul_i8 unit of a pack: C (m x n) = A block (m x k) x B, with B as the BT block (n x k).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitSpec {
    pub unit: u32,
    pub m: u32,
    pub k: u32,
    pub n: u32,
    pub a: BlockId,
    pub bt: BlockId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pack {
    pub job: u64,
    pub pack: u64,
    pub epoch: u32,
    pub kernel: u8,
    pub units: Vec<UnitSpec>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitOut {
    pub unit: u32,
    pub m: u32,
    pub n: u32,
    pub c: Vec<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultMsg {
    pub job: u64,
    pub pack: u64,
    pub epoch: u32,
    pub compute_ms: u32,
    pub units: Vec<UnitOut>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Need {
    pub job: u64,
    pub pack: u64,
    pub epoch: u32,
    pub blocks: Vec<BlockId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub id: BlockId,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Msg {
    Pack(Pack),
    Result(ResultMsg),
    Need(Need),
    Block(Block),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    TooShort,
    TooLong,
    BadMagic,
    BadVersion,
    BadKind,
    BadKernel,
    BadCount,
    BadSize,
    Trailing,
}

struct W(Vec<u8>);
impl W {
    fn header(kind: u8, cap: usize) -> W {
        let mut v = Vec::with_capacity(cap);
        v.extend_from_slice(&MAGIC.to_le_bytes());
        v.push(kind);
        v.push(VERSION);
        v.extend_from_slice(&0u16.to_le_bytes());
        W(v)
    }
    fn u8(&mut self, x: u8) {
        self.0.push(x);
    }
    fn u16(&mut self, x: u16) {
        self.0.extend_from_slice(&x.to_le_bytes());
    }
    fn u32(&mut self, x: u32) {
        self.0.extend_from_slice(&x.to_le_bytes());
    }
    fn u64(&mut self, x: u64) {
        self.0.extend_from_slice(&x.to_le_bytes());
    }
    fn bytes(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
}

/// Encode a message. RESULT tiles are written as raw little-endian i32 in one pass.
pub fn encode(m: &Msg) -> Vec<u8> {
    match m {
        Msg::Pack(p) => {
            let mut w = W::header(KIND_PACK, 32 + p.units.len() * 48);
            w.u64(p.job);
            w.u64(p.pack);
            w.u32(p.epoch);
            w.u8(p.kernel);
            w.u8(p.units.len() as u8);
            w.u16(0);
            for u in &p.units {
                w.u32(u.unit);
                w.u32(u.m);
                w.u32(u.k);
                w.u32(u.n);
                w.bytes(&u.a);
                w.bytes(&u.bt);
            }
            w.0
        }
        Msg::Result(r) => {
            let cells: usize = r.units.iter().map(|u| u.c.len()).sum();
            let mut w = W::header(KIND_RESULT, 32 + r.units.len() * 12 + cells * 4);
            w.u64(r.job);
            w.u64(r.pack);
            w.u32(r.epoch);
            w.u32(r.compute_ms);
            w.u8(r.units.len() as u8);
            w.u8(0);
            w.u16(0);
            for u in &r.units {
                w.u32(u.unit);
                w.u32(u.m);
                w.u32(u.n);
                for x in &u.c {
                    w.0.extend_from_slice(&x.to_le_bytes());
                }
            }
            w.0
        }
        Msg::Need(n) => {
            let mut w = W::header(KIND_NEED, 32 + n.blocks.len() * 16);
            w.u64(n.job);
            w.u64(n.pack);
            w.u32(n.epoch);
            w.u32(n.blocks.len() as u32);
            for b in &n.blocks {
                w.bytes(b);
            }
            w.0
        }
        Msg::Block(b) => {
            let mut w = W::header(KIND_BLOCK, 28 + b.bytes.len());
            w.bytes(&b.id);
            w.u32(b.bytes.len() as u32);
            w.bytes(&b.bytes);
            w.0
        }
    }
}

struct R<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        if self.b.len() - self.p < n {
            return Err(WireError::TooShort);
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn left(&self) -> usize {
        self.b.len() - self.p
    }
    fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, WireError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, WireError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, WireError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn id(&mut self) -> Result<BlockId, WireError> {
        Ok(self.take(16)?.try_into().unwrap())
    }
}

/// Decode one message, refusing anything that does not add up exactly (no trailing bytes either).
pub fn decode(b: &[u8]) -> Result<Msg, WireError> {
    if b.len() > MAX_MESSAGE {
        return Err(WireError::TooLong);
    }
    let mut r = R { b, p: 0 };
    if r.u32()? != MAGIC {
        return Err(WireError::BadMagic);
    }
    let kind = r.u8()?;
    if r.u8()? != VERSION {
        return Err(WireError::BadVersion);
    }
    let _flags = r.u16()?;
    let m = match kind {
        KIND_PACK => {
            let (job, pack, epoch, kernel, count) = (r.u64()?, r.u64()?, r.u32()?, r.u8()?, r.u8()? as usize);
            r.u16()?;
            if kernel != KERNEL_MATMUL_I8 {
                return Err(WireError::BadKernel);
            }
            if count == 0 || count * 48 != r.left() {
                return Err(WireError::BadCount);
            }
            let mut units = Vec::with_capacity(count);
            for _ in 0..count {
                let u = UnitSpec { unit: r.u32()?, m: r.u32()?, k: r.u32()?, n: r.u32()?, a: r.id()?, bt: r.id()? };
                let (m, k, n) = (u.m as usize, u.k as usize, u.n as usize);
                if m == 0 || n == 0 || k == 0 || m > FREIVALDS_MAX || n > FREIVALDS_MAX || k > FREIVALDS_MAX {
                    return Err(WireError::BadSize);
                }
                units.push(u);
            }
            Msg::Pack(Pack { job, pack, epoch, kernel, units })
        }
        KIND_RESULT => {
            let (job, pack, epoch, compute_ms, count) = (r.u64()?, r.u64()?, r.u32()?, r.u32()?, r.u8()? as usize);
            r.u8()?;
            r.u16()?;
            if count == 0 {
                return Err(WireError::BadCount);
            }
            let mut units = Vec::with_capacity(count);
            for _ in 0..count {
                let (unit, m, n) = (r.u32()?, r.u32()?, r.u32()?);
                let cells = (m as usize).checked_mul(n as usize).ok_or(WireError::BadSize)?;
                if m == 0 || n == 0 || m as usize > FREIVALDS_MAX || n as usize > FREIVALDS_MAX || cells * 4 > r.left() {
                    return Err(WireError::BadSize);
                }
                let raw = r.take(cells * 4)?;
                let c = raw.chunks_exact(4).map(|x| i32::from_le_bytes(x.try_into().unwrap())).collect();
                units.push(UnitOut { unit, m, n, c });
            }
            Msg::Result(ResultMsg { job, pack, epoch, compute_ms, units })
        }
        KIND_NEED => {
            let (job, pack, epoch, count) = (r.u64()?, r.u64()?, r.u32()?, r.u32()? as usize);
            if count == 0 || count > 2 * MAX_UNITS || count * 16 != r.left() {
                return Err(WireError::BadCount);
            }
            let mut blocks = Vec::with_capacity(count);
            for _ in 0..count {
                blocks.push(r.id()?);
            }
            Msg::Need(Need { job, pack, epoch, blocks })
        }
        KIND_BLOCK => {
            let id = r.id()?;
            let len = r.u32()? as usize;
            if len == 0 || len != r.left() {
                return Err(WireError::BadSize);
            }
            Msg::Block(Block { id, bytes: r.take(len)?.to_vec() })
        }
        _ => return Err(WireError::BadKind),
    };
    if r.left() != 0 {
        return Err(WireError::Trailing);
    }
    Ok(m)
}
