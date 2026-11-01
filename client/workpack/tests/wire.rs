// docs/TESTING.md test 63 part 1: the wire format round-trips, and every truncated, oversized or lying message is
// refused without a panic.
use workpack::kernels::Rng64;
use workpack::wire::*;

fn samples() -> Vec<Msg> {
    let id = |x: u8| [x; 16];
    vec![
        Msg::Pack(Pack { job: 9, pack: 1 << 40, epoch: 3, kernel: 2, units: vec![UnitSpec { unit: 5, m: 64, k: 128, n: 63, a: id(1), bt: id(2) }, UnitSpec { unit: 6, m: 1, k: 1, n: 1, a: id(3), bt: id(4) }] }),
        Msg::Result(ResultMsg { job: 9, pack: 7, epoch: 3, compute_ms: 12, units: vec![UnitOut { unit: 5, m: 2, n: 3, c: vec![1, -2, 3, i32::MIN, i32::MAX, 0] }] }),
        Msg::Need(Need { job: 9, pack: 7, epoch: 3, blocks: vec![id(1), id(9)] }),
        Msg::Block(Block { id: block_id(b"hello"), bytes: b"hello".to_vec() }),
    ]
}

#[test]
fn round_trip() {
    for m in samples() {
        assert_eq!(decode(&encode(&m)).unwrap(), m);
    }
}

#[test]
fn every_truncation_and_extension_is_refused() {
    for m in samples() {
        let b = encode(&m);
        for cut in 0..b.len() {
            assert!(decode(&b[..cut]).is_err(), "accepted a message cut at {cut}");
        }
        let mut longer = b.clone();
        longer.push(0);
        assert!(decode(&longer).is_err());
    }
}

#[test]
fn lying_lengths_and_fields_are_refused() {
    let b = encode(&samples()[1]); // RESULT
    let mut big = b.clone();
    big[40..44].copy_from_slice(&u32::MAX.to_le_bytes()); // m of the first unit (header 8, job 8, pack 8, epoch 4, ms 4, count 4, unit 4)
    assert!(decode(&big).is_err());
    let mut kernel = encode(&samples()[0]);
    kernel[28] = 9;
    assert_eq!(decode(&kernel), Err(WireError::BadKernel));
    let mut magic = b.clone();
    magic[0] ^= 1;
    assert_eq!(decode(&magic), Err(WireError::BadMagic));
    let mut ver = b.clone();
    ver[5] = 2;
    assert_eq!(decode(&ver), Err(WireError::BadVersion));
    let mut blk = encode(&samples()[3]);
    let n = blk.len();
    blk[24..28].copy_from_slice(&((n as u32) * 2).to_le_bytes());
    assert!(decode(&blk).is_err());
}

#[test]
fn random_bytes_never_panic() {
    let mut g = Rng64::new(64);
    let base: Vec<Vec<u8>> = samples().iter().map(encode).collect();
    for t in 0..20_000 {
        let mut b = base[t % base.len()].clone();
        for _ in 0..1 + g.below(4) {
            let p = g.below(b.len() as u64) as usize;
            b[p] = g.next_u64() as u8;
        }
        let _ = decode(&b);
        let junk: Vec<u8> = (0..g.below(80)).map(|_| g.next_u64() as u8).collect();
        let _ = decode(&junk);
    }
}
