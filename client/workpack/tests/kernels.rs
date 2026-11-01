// docs/TESTING.md test 63 (kernel conformance), parts 1-3.
use workpack::kernels::*;

#[test]
fn matmul_matches_naive_on_200_shapes() {
    let mut g = Rng64::new(63);
    let mut shapes: Vec<(usize, usize, usize)> = (0..200).map(|_| (1 + g.below(67) as usize, 1 + g.below(301) as usize, 1 + g.below(71) as usize)).collect();
    shapes.extend([(1, 1, 1), (4, 16, 4), (5, 17, 3), (3, 4096, 5), (2, 4095, 7), (64, 64, 64)]);
    for (s, &(m, k, n)) in shapes.iter().enumerate() {
        let (a, bt) = vector_inputs(s as u32 + 1, m, k, n);
        let mut c = vec![0i32; m * n];
        matmul_i8(&a, &bt, m, k, n, &mut c);
        assert_eq!(c, matmul_i8_naive(&a, &bt, m, k, n), "shape {m}x{k}x{n}");
    }
}

#[test]
fn matmul_extremes_are_exact() {
    for &(va, vb) in &[(-128i8, -128i8), (127, 127), (-128, 127)] {
        let (m, k, n) = (3, 4096, 5);
        let (a, bt) = (vec![va; m * k], vec![vb; n * k]);
        let mut c = vec![0i32; m * n];
        matmul_i8(&a, &bt, m, k, n, &mut c);
        assert!(c.iter().all(|&x| x as i64 == va as i64 * vb as i64 * k as i64));
    }
}

#[test]
fn freivalds_accepts_correct_and_catches_every_single_change() {
    let (m, k, n) = (37, 129, 41);
    let (a, bt) = vector_inputs(2026, m, k, n);
    let mut c = vec![0i32; m * n];
    matmul_i8(&a, &bt, m, k, n, &mut c);
    let mut rng = Rng64::new(1);
    assert!(freivalds(&a, &bt, m, k, n, &c, &mut rng, 2));
    let mut g = Rng64::new(2);
    for t in 0..1000 {
        let mut bad = c.clone();
        let p = g.below((m * n) as u64) as usize;
        bad[p] = match t % 4 {
            0 => bad[p].wrapping_add(1),
            1 => bad[p].wrapping_sub(1),
            2 => bad[p].wrapping_neg().wrapping_sub(1),
            _ => g.next_u64() as i32,
        };
        if bad[p] == c[p] {
            bad[p] ^= 1;
        }
        assert!(!freivalds(&a, &bt, m, k, n, &bad, &mut rng, 2), "missed a change at {p}");
    }
    assert!(!freivalds(&a, &bt, m, k, n, &vec![0; m * n], &mut rng, 2));
    assert!(!freivalds(&a, &bt, m, k, n, &c[1..], &mut rng, 2), "wrong length must fail");
}

#[test]
fn mc_pi_and_lease_seed_unchanged() {
    // the values the website's cpuChunkHits / leaseSeed give (worker.js), fixed so the program keeps agreeing
    assert_eq!(lease_seed(0, 0), 1);
    let s = lease_seed(12345, 7);
    assert_eq!(s, lease_seed(12345, 7));
    assert!(mc_pi(s, 1000) > 700 && mc_pi(s, 1000) < 860);
}

#[test]
fn conformance_vectors() {
    // printed so the program (--workpack-check) and the page's kernel (scripts/test_workpack_vectors.mjs) can be
    // compared with them; the expected hashes are pinned in EXPECTED once known
    for &(seed, m, k, n) in VECTORS.iter() {
        let h = vector_hash(seed, m, k, n);
        let (a, bt) = vector_inputs(seed, m, k, n);
        assert_eq!(h, sha256_i32(&matmul_i8_naive(&a, &bt, m, k, n)));
        println!("VECTOR {seed} {m}x{k}x{n} {h}");
    }
}

#[test]
fn pinned_vectors_match() {
    // tests/vectors.txt: the hashes every implementation must give (the program's --workpack-check and the page's
    // kernel are compared with the same file)
    let pinned = include_str!("vectors.txt");
    let mut n = 0;
    for l in pinned.lines() {
        let p: Vec<&str> = l.split_whitespace().collect();
        let seed: u32 = p[1].parse().unwrap();
        let d: Vec<usize> = p[2].split('x').map(|x| x.parse().unwrap()).collect();
        assert_eq!(vector_hash(seed, d[0], d[1], d[2]), p[3], "vector {l}");
        n += 1;
    }
    assert_eq!(n, VECTORS.len());
}

#[test]
fn speed() {
    let (m, k, n) = (256, 1024, 256);
    let (a, bt) = vector_inputs(7, m, k, n);
    let mut c = vec![0i32; m * n];
    let t = std::time::Instant::now();
    let mut reps = 0u32;
    while t.elapsed().as_millis() < 1000 {
        matmul_i8(&a, &bt, m, k, n, &mut c);
        reps += 1;
    }
    let gops = 2.0 * (m * k * n) as f64 * reps as f64 / t.elapsed().as_secs_f64() / 1e9;
    println!("SPEED matmul_i8 {m}x{k}x{n} one core: {gops:.2} GOP/s");
}
