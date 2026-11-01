//! Save to cloud, the small versions (planetCompute/ways2SaveMoneyOnStorageAndViews.txt items 6, 7, 9): from a PNG the
//! program makes three WebP files and sends them with the original in one multipart request (POST /api/uploads):
//!   f   full size, WebP quality 85 (shown when zoomed)
//!   p   small: longest side at most 1280, quality 80 (what the shared page and link previews show)
//!   pt  p with the "Made with planetCompute.ai" tag in the bottom-right corner (what other sites get when they embed it)
//!   meta  {width, height, model_name} for the page
//! The original stays the download; the site keeps showing the WebP if the original is ever deleted to save space.

const TAG_PNG: &[u8] = include_bytes!("made_with_tag.png");
pub const SMALL_SIDE: u32 = 1280;

/// An RGBA picture.
pub struct Rgba {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

/// Decode an 8-bit PNG (grey, grey+alpha, RGB, RGBA or palette) to RGBA.
pub fn decode_png(bytes: &[u8]) -> Result<Rgba, String> {
    let mut d = png::Decoder::new(std::io::Cursor::new(bytes));
    d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = d.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; r.output_buffer_size().ok_or("picture too large")?];
    let info = r.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width, info.height);
    let n = (w * h) as usize;
    let px = match info.color_type {
        png::ColorType::Rgba => buf[..n * 4].to_vec(),
        png::ColorType::Rgb => buf[..n * 3].chunks(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf[..n * 2].chunks(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
        png::ColorType::Grayscale => buf[..n].iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("palette picture not expanded".into()),
    };
    Ok(Rgba { w, h, px })
}

/// Smaller by averaging every source pixel that falls in each new pixel (sharp, no ringing).
pub fn shrink(s: &Rgba, w: u32, h: u32) -> Rgba {
    let mut px = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        let (y0, y1) = ((y as u64 * s.h as u64 / h as u64) as u32, (((y + 1) as u64 * s.h as u64).div_ceil(h as u64)) as u32);
        for x in 0..w {
            let (x0, x1) = ((x as u64 * s.w as u64 / w as u64) as u32, (((x + 1) as u64 * s.w as u64).div_ceil(w as u64)) as u32);
            let mut acc = [0u64; 4];
            for sy in y0..y1.min(s.h) {
                for sx in x0..x1.min(s.w) {
                    let i = ((sy * s.w + sx) * 4) as usize;
                    for c in 0..4 {
                        acc[c] += s.px[i + c] as u64;
                    }
                }
            }
            let n = ((y1.min(s.h) - y0) * (x1.min(s.w) - x0)).max(1) as u64;
            let o = ((y * w + x) * 4) as usize;
            for c in 0..4 {
                px[o + c] = ((acc[c] + n / 2) / n) as u8;
            }
        }
    }
    Rgba { w, h, px }
}

/// Any size, by the nearest neighbours weighted (for the tag, which is made larger or smaller).
fn scale(s: &Rgba, w: u32, h: u32) -> Rgba {
    if w <= s.w && h <= s.h {
        return shrink(s, w, h);
    }
    let mut px = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        let fy = ((y as f32 + 0.5) * s.h as f32 / h as f32 - 0.5).clamp(0.0, (s.h - 1) as f32);
        let (y0, ty) = (fy.floor() as u32, fy.fract());
        let y1 = (y0 + 1).min(s.h - 1);
        for x in 0..w {
            let fx = ((x as f32 + 0.5) * s.w as f32 / w as f32 - 0.5).clamp(0.0, (s.w - 1) as f32);
            let (x0, tx) = (fx.floor() as u32, fx.fract());
            let x1 = (x0 + 1).min(s.w - 1);
            let at = |xx: u32, yy: u32, c: usize| s.px[((yy * s.w + xx) * 4) as usize + c] as f32;
            for c in 0..4 {
                let top = at(x0, y0, c) * (1.0 - tx) + at(x1, y0, c) * tx;
                let bot = at(x0, y1, c) * (1.0 - tx) + at(x1, y1, c) * tx;
                px[((y * w + x) * 4) as usize + c] = (top * (1.0 - ty) + bot * ty).round() as u8;
            }
        }
    }
    Rgba { w, h, px }
}

/// The tag in the bottom-right corner: about a third of the width, 2.5% from the edges.
pub fn add_tag(p: &mut Rgba) -> Result<(), String> {
    let t = decode_png(TAG_PNG)?;
    let tw = ((p.w as f32 * 0.36) as u32).clamp(120.min(p.w), p.w);
    let th = (t.h as u64 * tw as u64 / t.w as u64).max(1) as u32;
    if th >= p.h {
        return Ok(());
    }
    let t = scale(&t, tw, th);
    let m = (p.w.min(p.h) as f32 * 0.025) as u32;
    let (ox, oy) = (p.w.saturating_sub(tw + m), p.h.saturating_sub(th + m));
    for y in 0..th {
        for x in 0..tw {
            let s = ((y * tw + x) * 4) as usize;
            let a = t.px[s + 3] as u32;
            if a == 0 {
                continue;
            }
            let d = (((oy + y) * p.w + ox + x) * 4) as usize;
            for c in 0..3 {
                p.px[d + c] = ((t.px[s + c] as u32 * a + p.px[d + c] as u32 * (255 - a) + 127) / 255) as u8;
            }
        }
    }
    Ok(())
}

pub fn webp(p: &Rgba, quality: f32) -> Vec<u8> {
    webp::Encoder::from_rgba(&p.px, p.w, p.h).encode(quality).to_vec()
}

/// The three WebP files of a PNG and its size: (full, small, small with the tag, width, height).
pub fn versions(png_bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>, u32, u32), String> {
    let full = decode_png(png_bytes)?;
    let f = webp(&full, 85.0);
    let k = SMALL_SIDE as f64 / full.w.max(full.h) as f64;
    let small = if k < 1.0 { shrink(&full, ((full.w as f64 * k).round() as u32).max(1), ((full.h as f64 * k).round() as u32).max(1)) } else { Rgba { w: full.w, h: full.h, px: full.px.clone() } };
    let p = webp(&small, 80.0);
    let mut tagged = small;
    add_tag(&mut tagged)?;
    let pt = webp(&tagged, 80.0);
    Ok((f, p, pt, full.w, full.h))
}

/// A multipart/form-data body: (field, file name or "", content type, bytes) -> (content type header, body).
pub fn multipart(parts: &[(&str, &str, &str, &[u8])]) -> (String, Vec<u8>) {
    let boundary = format!("----planetCompute{}", uuid::Uuid::new_v4().simple());
    let mut b = Vec::new();
    for (field, file, ty, data) in parts {
        b.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"").as_bytes());
        if !file.is_empty() {
            b.extend_from_slice(format!("; filename=\"{file}\"").as_bytes());
        }
        b.extend_from_slice(format!("\r\nContent-Type: {ty}\r\n\r\n").as_bytes());
        b.extend_from_slice(data);
        b.extend_from_slice(b"\r\n");
    }
    b.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), b)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png_of(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, w, h);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            let mut wr = e.write_header().unwrap();
            // a gradient with fine noise, as generated pictures have (a smooth gradient alone is tiny as PNG)
            let mut seed = 0x2545_f491u32;
            let mut noise = move || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; (seed % 48) as u32 };
            let px: Vec<u8> = (0..w * h).flat_map(|i| [((i % w * 200 / w) + noise()) as u8, ((i / w * 200 / h) + noise()) as u8, (90 + noise()) as u8]).collect();
            wr.write_image_data(&px).unwrap();
        }
        out
    }
    fn is_webp(b: &[u8]) -> bool {
        b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP"
    }
    #[test]
    fn three_webp_versions_of_an_instagram_picture() {
        let png = png_of(1080, 1350);
        let (f, p, pt, w, h) = versions(&png).unwrap();
        assert_eq!((w, h), (1080, 1350));
        assert!(is_webp(&f) && is_webp(&p) && is_webp(&pt));
        assert!(f.len() < png.len(), "WebP {} is not smaller than the PNG {}", f.len(), png.len());
        assert_ne!(p, pt, "the tag changed nothing");
        let small = webp::Decoder::new(&p).decode().unwrap();
        assert_eq!((small.width(), small.height()), (1024, 1280));
    }
    #[test]
    fn a_small_picture_keeps_its_size() {
        let (_, p, _, w, h) = versions(&png_of(512, 512)).unwrap();
        let d = webp::Decoder::new(&p).decode().unwrap();
        assert_eq!((w, h, d.width(), d.height()), (512, 512, 512, 512));
    }
    #[test]
    fn shrink_averages() {
        let s = Rgba { w: 2, h: 1, px: vec![0, 0, 0, 255, 200, 100, 50, 255] };
        assert_eq!(shrink(&s, 1, 1).px, vec![100, 50, 25, 255]);
    }
    #[test]
    fn the_tag_goes_bottom_right() {
        let mut p = Rgba { w: 800, h: 600, px: vec![255; 800 * 600 * 4] };
        add_tag(&mut p).unwrap();
        let at = |x: u32, y: u32| p.px[((y * 800 + x) * 4) as usize];
        assert_eq!(at(10, 10), 255, "top-left untouched");
        assert!(at(800 - 40, 600 - 30) < 255, "bottom-right darkened by the tag");
    }
    #[test]
    fn multipart_body() {
        let (ct, b) = multipart(&[("file", "a.png", "image/png", b"PNG"), ("meta", "", "application/json", b"{}")]);
        let bd = ct.split("boundary=").nth(1).unwrap();
        let s = String::from_utf8_lossy(&b);
        assert!(s.starts_with(&format!("--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\nPNG\r\n")));
        assert!(s.contains("name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{}\r\n") && s.ends_with(&format!("--{bd}--\r\n")));
    }
}
