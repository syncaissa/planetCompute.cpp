//! Kernels: the maths of a WorkPack. Every function here gives bit-identical results on every machine, so a result
//! can be compared exactly (docs/SHERPAHUB.md section 3).

use sha2::{Digest, Sha256};

/// Kernel ids in the wire format.
pub const KERNEL_MC_PI: u8 = 1;
pub const KERNEL_MATMUL_I8: u8 = 2;

/// Largest inner dimension of `matmul_i8`: |sum| <= 127 * 128 * k must stay below 2^31.
pub const K_MAX: usize = 131_071;

/// xorshift32: the inputs of tests and synthetic jobs. Seed 0 becomes 0x9E3779B9 (xorshift never leaves 0).
/// The browser reproduces it with `x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0`.
#[derive(Clone, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(if seed == 0 { 0x9E37_79B9 } else { seed })
    }
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// One int8: the top byte of the next value.
    #[inline]
    pub fn next_i8(&mut self) -> i8 {
        (self.next_u32() >> 24) as u8 as i8
    }
    pub fn fill_i8(&mut self, v: &mut [i8]) {
        for x in v {
            *x = self.next_i8();
        }
    }
}

/// splitmix64: the SherpaHub's private randomness (Freivalds vectors). Devices never see it.
#[derive(Clone, Debug)]
pub struct Rng64(u64);

impl Rng64 {
    pub fn new(seed: u64) -> Self {
        Rng64(seed)
    }
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, n) (n > 0), without modulo bias that matters here.
    #[inline]
    pub fn below(&mut self, n: u64) -> u64 {
        ((self.next_u64() >> 32) * n) >> 32
    }
    /// Uniform float in [0, 1).
    #[inline]
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// pc_mc_pi(seed, n): hits inside the quarter circle among n xorshift32 points (= the website's cpuChunkHits and the
/// console's 133-byte WebAssembly module). Kernel 1. Here seed 0 stays 0, exactly as the WebAssembly module does.
pub fn mc_pi(seed: u32, n: u32) -> u32 {
    let (mut x, mut c) = (seed, 0u32);
    for _ in 0..n {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        let (u, v) = (x & 0x7fff, (x >> 15) & 0x7fff);
        if u * u + v * v < 0x4000_0000 {
            c += 1;
        }
    }
    c
}

/// The seed of pack i of a benchmark lease (= leaseSeed in worker.js): murmur3's finaliser of base + i x golden ratio.
pub fn lease_seed(base: u32, i: u32) -> u32 {
    let mut h = base.wrapping_add(i.wrapping_mul(0x9e37_79b9));
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    if h == 0 {
        1
    } else {
        h
    }
}

const LANES: usize = 16;

// Explicit SIMD for the 16-byte steps, on the instruction sets every 64-bit CPU of its kind has (no CPU-specific
// build): SSE2 on x86_64 (pmaddwd: i16 x i16 -> pair-summed i32, the same as WebAssembly's i32x4.dot_i16x8_s) and
// NEON on aarch64 (vmull_s8 -> i16, vpadalq_s16 -> pair-summed into i32). All exact integer maths: the results are
// bit-identical to the plain loops below (tests: naive comparison on 206 shapes + pinned vectors on all builds).
#[cfg(target_arch = "x86_64")]
mod simd {
    use std::arch::x86_64::*;

    #[inline(always)]
    unsafe fn widen(x: __m128i) -> (__m128i, __m128i) {
        // sign-extend i8 -> i16 with SSE2 only: duplicate each byte into a 16-bit lane, then shift right arithmetic
        (_mm_srai_epi16(_mm_unpacklo_epi8(x, x), 8), _mm_srai_epi16(_mm_unpackhi_epi8(x, x), 8))
    }
    #[inline(always)]
    unsafe fn step(acc: __m128i, xl: __m128i, xh: __m128i, y: __m128i) -> __m128i {
        let (yl, yh) = widen(y);
        _mm_add_epi32(acc, _mm_add_epi32(_mm_madd_epi16(xl, yl), _mm_madd_epi16(xh, yh)))
    }
    #[inline(always)]
    unsafe fn hsum(v: __m128i) -> i32 {
        let mut o = [0i32; 4];
        _mm_storeu_si128(o.as_mut_ptr() as *mut __m128i, v);
        o[0].wrapping_add(o[1]).wrapping_add(o[2]).wrapping_add(o[3])
    }
    /// Sums of the first `full` (a multiple of 16) products of a with b0..b3.
    /// SAFETY: every slice holds at least `full` bytes (checked by the caller).
    #[inline]
    pub unsafe fn dot1x4(a: &[i8], b: [&[i8]; 4], full: usize) -> [i32; 4] {
        let (mut s0, mut s1, mut s2, mut s3) = (_mm_setzero_si128(), _mm_setzero_si128(), _mm_setzero_si128(), _mm_setzero_si128());
        let mut t = 0;
        while t < full {
            let (xl, xh) = widen(_mm_loadu_si128(a.as_ptr().add(t) as *const __m128i));
            s0 = step(s0, xl, xh, _mm_loadu_si128(b[0].as_ptr().add(t) as *const __m128i));
            s1 = step(s1, xl, xh, _mm_loadu_si128(b[1].as_ptr().add(t) as *const __m128i));
            s2 = step(s2, xl, xh, _mm_loadu_si128(b[2].as_ptr().add(t) as *const __m128i));
            s3 = step(s3, xl, xh, _mm_loadu_si128(b[3].as_ptr().add(t) as *const __m128i));
            t += 16;
        }
        [hsum(s0), hsum(s1), hsum(s2), hsum(s3)]
    }
    #[inline]
    pub unsafe fn dot1(a: &[i8], b: &[i8], full: usize) -> i32 {
        let mut s = _mm_setzero_si128();
        let mut t = 0;
        while t < full {
            let (xl, xh) = widen(_mm_loadu_si128(a.as_ptr().add(t) as *const __m128i));
            s = step(s, xl, xh, _mm_loadu_si128(b.as_ptr().add(t) as *const __m128i));
            t += 16;
        }
        hsum(s)
    }
}

#[cfg(target_arch = "aarch64")]
mod simd {
    use std::arch::aarch64::*;

    #[inline(always)]
    unsafe fn step(acc: int32x4_t, x: int8x16_t, y: int8x16_t) -> int32x4_t {
        let acc = vpadalq_s16(acc, vmull_s8(vget_low_s8(x), vget_low_s8(y)));
        vpadalq_s16(acc, vmull_high_s8(x, y))
    }
    /// SAFETY: every slice holds at least `full` bytes (checked by the caller).
    #[inline]
    pub unsafe fn dot1x4(a: &[i8], b: [&[i8]; 4], full: usize) -> [i32; 4] {
        let (mut s0, mut s1, mut s2, mut s3) = (vdupq_n_s32(0), vdupq_n_s32(0), vdupq_n_s32(0), vdupq_n_s32(0));
        let mut t = 0;
        while t < full {
            let x = vld1q_s8(a.as_ptr().add(t));
            s0 = step(s0, x, vld1q_s8(b[0].as_ptr().add(t)));
            s1 = step(s1, x, vld1q_s8(b[1].as_ptr().add(t)));
            s2 = step(s2, x, vld1q_s8(b[2].as_ptr().add(t)));
            s3 = step(s3, x, vld1q_s8(b[3].as_ptr().add(t)));
            t += 16;
        }
        [vaddvq_s32(s0), vaddvq_s32(s1), vaddvq_s32(s2), vaddvq_s32(s3)]
    }
    #[inline]
    pub unsafe fn dot1(a: &[i8], b: &[i8], full: usize) -> i32 {
        let mut s = vdupq_n_s32(0);
        let mut t = 0;
        while t < full {
            s = step(s, vld1q_s8(a.as_ptr().add(t)), vld1q_s8(b.as_ptr().add(t)));
            t += 16;
        }
        vaddvq_s32(s)
    }
}

/// Other CPUs: the same 16-byte steps in plain Rust (the compiler vectorises what it can).
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
mod simd {
    pub unsafe fn dot1x4(a: &[i8], b: [&[i8]; 4], full: usize) -> [i32; 4] {
        let mut r = [0i32; 4];
        for (q, bq) in b.iter().enumerate() {
            r[q] = dot1(a, bq, full);
        }
        r
    }
    pub unsafe fn dot1(a: &[i8], b: &[i8], full: usize) -> i32 {
        let mut s = [0i32; super::LANES];
        let mut t = 0;
        while t < full {
            for l in 0..super::LANES {
                s[l] += a[t + l] as i32 * b[t + l] as i32;
            }
            t += super::LANES;
        }
        s.iter().sum()
    }
}

/// Four dot products of one row of A against four rows of BT at once (A's row is read once).
#[inline]
fn dot1x4(a: &[i8], b0: &[i8], b1: &[i8], b2: &[i8], b3: &[i8]) -> [i32; 4] {
    let k = a.len();
    let full = k - k % LANES;
    debug_assert!(b0.len() == k && b1.len() == k && b2.len() == k && b3.len() == k);
    // SAFETY: all five slices are exactly k >= full bytes long (matmul_i8 cuts them from checked lengths)
    let mut r = unsafe { simd::dot1x4(a, [b0, b1, b2, b3], full) };
    for t in full..k {
        let xa = a[t] as i32;
        r[0] += xa * b0[t] as i32;
        r[1] += xa * b1[t] as i32;
        r[2] += xa * b2[t] as i32;
        r[3] += xa * b3[t] as i32;
    }
    r
}

#[inline]
fn dot1(a: &[i8], b: &[i8]) -> i32 {
    let k = a.len();
    let full = k - k % LANES;
    debug_assert!(b.len() == k);
    // SAFETY: both slices are exactly k >= full bytes long
    let mut r = unsafe { simd::dot1(a, b, full) };
    for t in full..k {
        r += a[t] as i32 * b[t] as i32;
    }
    r
}

/// Kernel 2: C (m x n, i32, row-major) = A (m x k, i8, row-major) x B, where B is given TRANSPOSED as BT (n x k, i8,
/// row-major) so every dot product reads two contiguous rows. Exact: i32 accumulation, k <= [`K_MAX`].
/// Panics if a length does not match (callers check lengths once, when a message is decoded).
pub fn matmul_i8(a: &[i8], bt: &[i8], m: usize, k: usize, n: usize, c: &mut [i32]) {
    assert!(k <= K_MAX && a.len() == m * k && bt.len() == n * k && c.len() == m * n, "matmul_i8: bad sizes");
    if k == 0 {
        c.fill(0);
        return;
    }
    let n4 = n - n % 4;
    for i in 0..m {
        let ar = &a[i * k..(i + 1) * k];
        let cr = &mut c[i * n..(i + 1) * n];
        let mut j = 0;
        while j < n4 {
            let r = dot1x4(ar, &bt[j * k..(j + 1) * k], &bt[(j + 1) * k..(j + 2) * k], &bt[(j + 2) * k..(j + 3) * k], &bt[(j + 3) * k..(j + 4) * k]);
            cr[j..j + 4].copy_from_slice(&r);
            j += 4;
        }
        for j in n4..n {
            cr[j] = dot1(ar, &bt[j * k..(j + 1) * k]);
        }
    }
}

/// The plain triple loop: the reference the tests compare [`matmul_i8`] against.
pub fn matmul_i8_naive(a: &[i8], bt: &[i8], m: usize, k: usize, n: usize) -> Vec<i32> {
    let mut c = vec![0i32; m * n];
    for i in 0..m {
        for j in 0..n {
            let mut s = 0i64;
            for t in 0..k {
                s += a[i * k + t] as i64 * bt[j * k + t] as i64;
            }
            c[i * n + j] = s as i32;
        }
    }
    c
}

/// Largest tile side the Freivalds check accepts (i64 stays exact: |lhs| <= k * n * 2^29, |rhs| <= n * 2^46).
pub const FREIVALDS_MAX: usize = 4096;

/// Freivalds' check that C = A x B (B given as BT), `rounds` times with fresh random vectors r in [-2^15, 2^15):
/// y = B r (k values), then A y == C r (m values), all in i64. Cost O(nk + mk + mn) instead of O(mnk). A wrong C
/// passes one round with probability at most 2^-16. Used by the SherpaHub on every returned unit.
pub fn freivalds(a: &[i8], bt: &[i8], m: usize, k: usize, n: usize, c: &[i32], rng: &mut Rng64, rounds: u32) -> bool {
    if a.len() != m * k || bt.len() != n * k || c.len() != m * n || k > FREIVALDS_MAX || n > FREIVALDS_MAX {
        return false;
    }
    let mut r = vec![0i64; n];
    let mut y = vec![0i64; k];
    for _ in 0..rounds {
        for x in r.iter_mut() {
            *x = (rng.next_u64() & 0xffff) as i64 - 32768;
        }
        y.fill(0);
        for j in 0..n {
            let (rj, row) = (r[j], &bt[j * k..(j + 1) * k]);
            for t in 0..k {
                y[t] += row[t] as i64 * rj;
            }
        }
        for i in 0..m {
            let ar = &a[i * k..(i + 1) * k];
            let lhs: i64 = ar.iter().zip(&y).map(|(&x, &yy)| x as i64 * yy).sum();
            let cr = &c[i * n..(i + 1) * n];
            let rhs: i64 = cr.iter().zip(&r).map(|(&x, &rr)| x as i64 * rr).sum();
            if lhs != rhs {
                return false;
            }
        }
    }
    true
}

/// The conformance cases (docs/TESTING.md test 63): (seed, m, k, n). Odd sizes on purpose (edges of the 4-wide and
/// 16-lane loops), k up to 4096.
pub const VECTORS: [(u32, usize, usize, usize); 6] = [(1, 1, 1, 1), (7, 4, 16, 4), (42, 17, 33, 9), (1234, 64, 64, 64), (99, 3, 4096, 5), (2026, 61, 301, 67)];

/// The inputs of a conformance case: A from Rng(seed), BT from Rng(seed ^ 0xA5A5A5A5).
pub fn vector_inputs(seed: u32, m: usize, k: usize, n: usize) -> (Vec<i8>, Vec<i8>) {
    let (mut a, mut bt) = (vec![0i8; m * k], vec![0i8; n * k]);
    Rng::new(seed).fill_i8(&mut a);
    Rng::new(seed ^ 0xA5A5_A5A5).fill_i8(&mut bt);
    (a, bt)
}

/// SHA-256 (hex) of C's little-endian bytes for a conformance case: the same on every machine.
pub fn vector_hash(seed: u32, m: usize, k: usize, n: usize) -> String {
    let (a, bt) = vector_inputs(seed, m, k, n);
    let mut c = vec![0i32; m * n];
    matmul_i8(&a, &bt, m, k, n, &mut c);
    sha256_i32(&c)
}

pub fn sha256_i32(c: &[i32]) -> String {
    let mut h = Sha256::new();
    for x in c {
        h.update(x.to_le_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
