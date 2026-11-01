;; matmul_i8 for browsers: WebAssembly SIMD (docs/SHERPAHUB.md 3.3). Bit-identical to client/workpack kernels.rs.
;; C (m x n, i32, row-major) = A (m x k, i8, row-major) x B, with B given transposed as BT (n x k, i8, row-major).
;; 16 int8 at a time: widened to i16 (exact), multiplied and pair-summed into i32 by i32x4.dot_i16x8_s (exact);
;; one row of A against four rows of BT at once (A is loaded once per 4 dot products). Integer maths only, so every
;; engine (V8, SpiderMonkey, JavaScriptCore) gives the same exact answer. Build: scripts/build_workpack_wasm.mjs.
(module
  (memory (export "mem") 1)

  ;; one 16-byte step of a dot product: acc + dot(lo(x), lo(y)) + dot(hi(x), hi(y))
  (func $step (param $acc v128) (param $x v128) (param $y v128) (result v128)
    (i32x4.add
      (i32x4.add (local.get $acc)
        (i32x4.dot_i16x8_s (i16x8.extend_low_i8x16_s (local.get $x)) (i16x8.extend_low_i8x16_s (local.get $y))))
      (i32x4.dot_i16x8_s (i16x8.extend_high_i8x16_s (local.get $x)) (i16x8.extend_high_i8x16_s (local.get $y)))))

  (func $hsum (param $v v128) (result i32)
    (i32.add
      (i32.add (i32x4.extract_lane 0 (local.get $v)) (i32x4.extract_lane 1 (local.get $v)))
      (i32.add (i32x4.extract_lane 2 (local.get $v)) (i32x4.extract_lane 3 (local.get $v)))))

  ;; scalar tail of a dot product: sum over t in [from, k) of a[t] * b[t]
  (func $tail (param $a i32) (param $b i32) (param $from i32) (param $k i32) (result i32)
    (local $s i32) (local $t i32)
    (local.set $t (local.get $from))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $t) (local.get $k)))
        (local.set $s (i32.add (local.get $s)
          (i32.mul (i32.load8_s (i32.add (local.get $a) (local.get $t))) (i32.load8_s (i32.add (local.get $b) (local.get $t))))))
        (local.set $t (i32.add (local.get $t) (i32.const 1)))
        (br $l)))
    (local.get $s))

  (func $dot1 (param $a i32) (param $b i32) (param $k i32) (result i32)
    (local $acc v128) (local $t i32) (local $full i32)
    (local.set $full (i32.and (local.get $k) (i32.const -16)))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $t) (local.get $full)))
        (local.set $acc (call $step (local.get $acc)
          (v128.load (i32.add (local.get $a) (local.get $t))) (v128.load (i32.add (local.get $b) (local.get $t)))))
        (local.set $t (i32.add (local.get $t) (i32.const 16)))
        (br $l)))
    (i32.add (call $hsum (local.get $acc)) (call $tail (local.get $a) (local.get $b) (local.get $full) (local.get $k))))

  ;; c[0..4] = dot(a, b0..b3), the four rows of BT at b, b + k, b + 2k, b + 3k
  (func $dot4 (param $a i32) (param $b i32) (param $k i32) (param $c i32)
    (local $t i32) (local $full i32) (local $x v128)
    (local $s0 v128) (local $s1 v128) (local $s2 v128) (local $s3 v128)
    (local $b1 i32) (local $b2 i32) (local $b3 i32)
    (local.set $b1 (i32.add (local.get $b) (local.get $k)))
    (local.set $b2 (i32.add (local.get $b1) (local.get $k)))
    (local.set $b3 (i32.add (local.get $b2) (local.get $k)))
    (local.set $full (i32.and (local.get $k) (i32.const -16)))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $t) (local.get $full)))
        (local.set $x (v128.load (i32.add (local.get $a) (local.get $t))))
        (local.set $s0 (call $step (local.get $s0) (local.get $x) (v128.load (i32.add (local.get $b) (local.get $t)))))
        (local.set $s1 (call $step (local.get $s1) (local.get $x) (v128.load (i32.add (local.get $b1) (local.get $t)))))
        (local.set $s2 (call $step (local.get $s2) (local.get $x) (v128.load (i32.add (local.get $b2) (local.get $t)))))
        (local.set $s3 (call $step (local.get $s3) (local.get $x) (v128.load (i32.add (local.get $b3) (local.get $t)))))
        (local.set $t (i32.add (local.get $t) (i32.const 16)))
        (br $l)))
    (i32.store offset=0 (local.get $c)
      (i32.add (call $hsum (local.get $s0)) (call $tail (local.get $a) (local.get $b) (local.get $full) (local.get $k))))
    (i32.store offset=4 (local.get $c)
      (i32.add (call $hsum (local.get $s1)) (call $tail (local.get $a) (local.get $b1) (local.get $full) (local.get $k))))
    (i32.store offset=8 (local.get $c)
      (i32.add (call $hsum (local.get $s2)) (call $tail (local.get $a) (local.get $b2) (local.get $full) (local.get $k))))
    (i32.store offset=12 (local.get $c)
      (i32.add (call $hsum (local.get $s3)) (call $tail (local.get $a) (local.get $b3) (local.get $full) (local.get $k)))))

  ;; matmul(a, bt, c, m, k, n): pointers into memory; C written at c (m * n * 4 bytes)
  (func (export "matmul") (param $a i32) (param $bt i32) (param $c i32) (param $m i32) (param $k i32) (param $n i32)
    (local $i i32) (local $j i32) (local $n4 i32) (local $ar i32) (local $cr i32)
    (local.set $n4 (i32.and (local.get $n) (i32.const -4)))
    (block $rows_done
      (loop $rows
        (br_if $rows_done (i32.ge_u (local.get $i) (local.get $m)))
        (local.set $ar (i32.add (local.get $a) (i32.mul (local.get $i) (local.get $k))))
        (local.set $cr (i32.add (local.get $c) (i32.shl (i32.mul (local.get $i) (local.get $n)) (i32.const 2))))
        (local.set $j (i32.const 0))
        (block $q_done
          (loop $q
            (br_if $q_done (i32.ge_u (local.get $j) (local.get $n4)))
            (call $dot4 (local.get $ar) (i32.add (local.get $bt) (i32.mul (local.get $j) (local.get $k))) (local.get $k)
              (i32.add (local.get $cr) (i32.shl (local.get $j) (i32.const 2))))
            (local.set $j (i32.add (local.get $j) (i32.const 4)))
            (br $q)))
        (block $r_done
          (loop $r
            (br_if $r_done (i32.ge_u (local.get $j) (local.get $n)))
            (i32.store (i32.add (local.get $cr) (i32.shl (local.get $j) (i32.const 2)))
              (call $dot1 (local.get $ar) (i32.add (local.get $bt) (i32.mul (local.get $j) (local.get $k))) (local.get $k)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $r)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $rows))))
)
