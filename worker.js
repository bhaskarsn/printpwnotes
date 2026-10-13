'use strict';

// ─── WASM loader ──────────────────────────────────────────────────────────────
// Loads convert.wasm once per worker at startup.
// wasmReady resolves to the bound exports, or null if load fails (JS fallback).
var wasmExports = null;
var wasmReady = (function () {
  var wbuf = null;
  return fetch('convert.wasm')
    .then(function (r) {
      if (!r.ok) throw new Error('fetch failed: HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then(function (buf) {
      wbuf = buf;
      return WebAssembly.instantiate(buf, {});
    })
    .then(function (result) {
      wasmExports = result.instance.exports;
      var init = wasmExports._initialize || wasmExports.__wasm_call_ctors;
      if (typeof init === 'function') init();
    })
    .catch(function (err) {
      wasmExports = null; /* JS fallback */
      var info = String(err && err.message || err);
      try {
        if (wbuf) {
          var imps = WebAssembly.Module.imports(new WebAssembly.Module(wbuf))
            .map(function (i) { return i.module + '.' + i.name; });
          info += ' | module imports: ' + imps.join(', ');
        }
      } catch (e2) {}
      try { postMessage({ wasmError: info }); } catch (e3) {}
    });
})();

// ─── Constants ────────────────────────────────────────────────────────────────
var darkMax       = 56;
var lightMin      = 190;
var darkInkAbove  = 100;
var lightInkBelow = 128;
var weakInkBelow  = 175;
var photoFracN    = 0.35;

var inkDistEmbed  = 45;
var weakDistEmbed = 28;
var photoFracE    = 0.35;
var unsharpAlpha  = 1.2;

var blockSize     = 39;

// ─── Shared pixel helpers ─────────────────────────────────────────────────────
function minmax(r, g, b) {
  var mx = r > g ? r : g; if (b > mx) mx = b;
  var mn = r < g ? r : g; if (b < mn) mn = b;
  return [mx, mn];
}

// Row buffers reused across smooth121 calls — reallocated only when width changes.
var _smooth121PrevRow = null;
var _smooth121CurRow  = null;
var _smooth121LastW   = 0;

function smooth121(p, w, h) {
  for (var y = 0; y < h; y++) {
    var base = y * w;
    var prev = p[base];
    for (var x = 0; x < w; x++) {
      var cur = p[base + x];
      var nx  = x + 1 < w ? x + 1 : w - 1;
      p[base + x] = (prev + 2 * cur + p[base + nx] + 2) >> 2;
      prev = cur;
    }
  }
  if (w !== _smooth121LastW) {
    _smooth121PrevRow = new Uint8Array(w);
    _smooth121CurRow  = new Uint8Array(w);
    _smooth121LastW   = w;
  }
  var prevRow = _smooth121PrevRow;
  var curRow  = _smooth121CurRow;
  prevRow.set(p.subarray(0, w));
  for (var y = 0; y < h; y++) {
    curRow.set(p.subarray(y * w, y * w + w));
    var ny = y + 1 < h ? y + 1 : h - 1;
    var nextRow = p.subarray(ny * w, ny * w + w);
    var out     = p.subarray(y * w,  y * w  + w);
    for (var x = 0; x < w; x++) {
      out[x] = (prevRow[x] + 2 * curRow[x] + nextRow[x] + 2) >> 2;
    }
    var tmp = prevRow; prevRow = curRow; curRow = tmp;
  }
}

function grayPage(w, h, rgba) {
  var n = w * h;
  var g = new Uint8Array(n);
  var sum = 0;
  for (var i = 0; i < n; i++) {
    var v = (rgba[4*i]*299 + rgba[4*i+1]*587 + rgba[4*i+2]*114) / 1000 | 0;
    g[i] = v;
    sum += v;
  }
  if (sum / n < 110) {
    for (var i = 0; i < n; i++) g[i] = 255 - g[i];
  }
  return { bits: 8, data: g, w: w, h: h };
}

// ─── convertPageNormal (port of normal.go) ────────────────────────────────────
function convertPageNormal(w, h, rgba) {
  var bw = (w + blockSize - 1) / blockSize | 0;
  var bh = (h + blockSize - 1) / blockSize | 0;
  var dark  = new Int32Array(bw * bh);
  var light = new Int32Array(bw * bh);
  var mid   = 0;

  var xb = new Int32Array(w);
  for (var x = 0; x < w; x++) xb[x] = (x / blockSize) | 0;

  // mnPlane is only needed if we don't early-exit to grayPage below, but
  // computing it here (same r/g/b already in registers) costs nothing extra
  // and saves a full second w*h pass later, versus recomputing min() again.
  var mnPlane = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    var base = ((y / blockSize) | 0) * bw;
    var ri   = y * w * 4;
    var rowOff = y * w;
    for (var x = 0; x < w; x++) {
      var r = rgba[ri]; var g = rgba[ri+1]; var b = rgba[ri+2];
      ri += 4;
      var mx = r > g ? r : g; if (b > mx) mx = b;
      var mn = r < g ? r : g; if (b < mn) mn = b;
      mnPlane[rowOff + x] = mn;
      if (mx <= darkMax) {
        dark[base + xb[x]]++;
      } else if (mn >= lightMin) {
        light[base + xb[x]]++;
      } else {
        mid++;
      }
    }
  }

  if (mid > photoFracN * w * h) return grayPage(w, h, rgba);

  var totD = 0, totL = 0;
  for (var i = 0; i < bw * bh; i++) { totD += dark[i]; totL += light[i]; }
  var defaultDark = totD >= totL;

  var polScore = new Float32Array(bw * bh);
  for (var by = 0; by < bh; by++) {
    for (var bx = 0; bx < bw; bx++) {
      var d = 0, l = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var yy = by + dy;
        if (yy < 0 || yy >= bh) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = bx + dx;
          if (xx < 0 || xx >= bw) continue;
          d += dark[yy * bw + xx];
          l += light[yy * bw + xx];
        }
      }
      if (d + l === 0) {
        polScore[by * bw + bx] = defaultDark ? 1.0 : 0.0;
      } else {
        polScore[by * bw + bx] = d / (d + l);
      }
    }
  }

  var half = blockSize / 2.0;

  smooth121(mnPlane, w, h);

  // Single pass: compute polarity inline and set state immediately.
  // Eliminates the separate polMask array and a full w*h read/write pass.
  var state = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    var fy   = (y - half) / blockSize;
    var by0  = fy | 0;
    var ty   = fy - by0; if (ty < 0) ty = 0;
    var by1  = by0 + 1 < bh ? by0 + 1 : bh - 1;
    var by0c = by0 < 0 ? 0 : by0;
    for (var x = 0; x < w; x++) {
      var i  = y * w + x;
      var fx   = (x - half) / blockSize;
      var bx0  = fx | 0;
      var tx   = fx - bx0; if (tx < 0) tx = 0;
      var bx1  = bx0 + 1 < bw ? bx0 + 1 : bw - 1;
      var bx0c = bx0 < 0 ? 0 : bx0;
      var s00 = polScore[by0c * bw + bx0c];
      var s10 = polScore[by0c * bw + bx1];
      var s01 = polScore[by1  * bw + bx0c];
      var s11 = polScore[by1  * bw + bx1];
      var s   = s00*(1-tx)*(1-ty) + s10*tx*(1-ty) + s01*(1-tx)*ty + s11*tx*ty;
      var ri  = i * 4;
      if (s > 0.5) {
        var r1 = rgba[ri], g1 = rgba[ri+1], b1 = rgba[ri+2];
        var mx = r1 > g1 ? r1 : g1; if (b1 > mx) mx = b1;
        if (mx > darkInkAbove) state[i] = 2;
      } else {
        var sm = mnPlane[i];
        if (sm < lightInkBelow)  state[i] = 2;
        else if (sm < weakInkBelow) state[i] = 1;
      }
    }
  }

  // Typed-array BFS queue — avoids JS array resize/GC overhead of push/pop.
  var queue = new Int32Array(w * h);
  var qHead = 0, qTail = 0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = y * w + x;
      if (state[i] !== 1) continue;
      outer: for (var dy = -1; dy <= 1; dy++) {
        var yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (state[yy * w + xx] === 2) { state[i] = 2; queue[qTail++] = i; break outer; }
        }
      }
    }
  }
  while (qHead < qTail) {
    var i = queue[qHead++];
    var x = i % w, y = (i / w) | 0;
    for (var dy = -1; dy <= 1; dy++) {
      var yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        var j = yy * w + xx;
        if (state[j] === 1) { state[j] = 2; queue[qTail++] = j; }
      }
    }
  }

  var rowBytes = (w + 7) >> 3;
  var raw = new Uint8Array(rowBytes * h);
  for (var i = 0; i < raw.length; i++) raw[i] = 0xFF;
  for (var y = 0; y < h; y++) {
    var base = y * rowBytes;
    for (var x = 0; x < w; x++) {
      if (state[y * w + x] === 2) {
        raw[base + (x >> 3)] &= ~(0x80 >> (x & 7));
      }
    }
  }
  return { bits: 1, data: raw, w: w, h: h };
}

// ─── convertPageEmbed (port of yellowish-embed.go) ───────────────────────────
function convertPageEmbed(w, h, rgba) {
  var bw = (w + blockSize - 1) / blockSize | 0;
  var bh = (h + blockSize - 1) / blockSize | 0;
  var nb = bw * bh;

  var xb = new Int32Array(w);
  for (var x = 0; x < w; x++) xb[x] = (x / blockSize) | 0;

  var blockPixelCount = blockSize * blockSize;
  var brightBuf = new Uint8Array(nb * blockPixelCount);
  var brightCnt = new Int32Array(nb);
  var sumR = new Float64Array(nb);
  var sumG = new Float64Array(nb);
  var sumB = new Float64Array(nb);
  var cnt  = new Int32Array(nb);

  for (var y = 0; y < h; y++) {
    var base = ((y / blockSize) | 0) * bw;
    var ri   = y * w * 4;
    for (var x = 0; x < w; x++) {
      var bi  = base + xb[x];
      var r   = rgba[ri], g = rgba[ri+1], b = rgba[ri+2];
      var brv = r > g ? r : g; if (b > brv) brv = b;
      var slot = brightCnt[bi];
      if (slot < blockPixelCount) {
        brightBuf[bi * blockPixelCount + slot] = brv;
        brightCnt[bi]++;
      }
      sumR[bi] += r; sumG[bi] += g; sumB[bi] += b; cnt[bi]++;
      ri += 4;
    }
  }

  var bgR = new Float32Array(nb);
  var bgG = new Float32Array(nb);
  var bgB = new Float32Array(nb);
  var sortBuf = new Uint8Array(blockPixelCount);
  // Quickselect: finds the value that WOULD sit at index `idx` in a full sort,
  // without doing the full sort. Returns the exact same value as the old
  // insertion-sort-then-index approach, just without the O(n^2) cost.
  function quickselect(a, n, idx) {
    var lo = 0, hi = n - 1;
    while (lo < hi) {
      var pivot = a[(lo + hi) >> 1];
      var ii = lo, jj = hi;
      while (ii <= jj) {
        while (a[ii] < pivot) ii++;
        while (a[jj] > pivot) jj--;
        if (ii <= jj) { var t = a[ii]; a[ii] = a[jj]; a[jj] = t; ii++; jj--; }
      }
      if (idx <= jj) hi = jj;
      else if (idx >= ii) lo = ii;
      else break;
    }
    return a[idx];
  }
  for (var i = 0; i < nb; i++) {
    var n = brightCnt[i];
    if (n === 0) continue;
    var off = i * blockPixelCount;
    for (var k = 0; k < n; k++) sortBuf[k] = brightBuf[off + k];
    var p85idx = (n * 85 / 100) | 0;
    var thresh  = quickselect(sortBuf, n, p85idx);
    var sr = 0, sg = 0, sb = 0, sc = 0;
    var by0 = ((i / bw) | 0) * blockSize;
    var bx0 = (i % bw) * blockSize;
    var byEnd = by0 + blockSize < h ? by0 + blockSize : h;
    var bxEnd = bx0 + blockSize < w ? bx0 + blockSize : w;
    for (var py = by0; py < byEnd; py++) {
      var pri = (py * w + bx0) * 4;
      for (var px = bx0; px < bxEnd; px++) {
        var pr = rgba[pri], pg = rgba[pri+1], pb = rgba[pri+2];
        var pbr = pr > pg ? pr : pg; if (pb > pbr) pbr = pb;
        if (pbr >= thresh) { sr += pr; sg += pg; sb += pb; sc++; }
        pri += 4;
      }
    }
    if (sc > 0) {
      bgR[i] = sr / sc; bgG[i] = sg / sc; bgB[i] = sb / sc;
    } else {
      bgR[i] = sumR[i] / cnt[i]; bgG[i] = sumG[i] / cnt[i]; bgB[i] = sumB[i] / cnt[i];
    }
  }

  var smR = new Float32Array(nb);
  var smG = new Float32Array(nb);
  var smB = new Float32Array(nb);
  for (var by = 0; by < bh; by++) {
    for (var bx = 0; bx < bw; bx++) {
      var sr = 0, sg = 0, sb = 0, wt = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var yy = by + dy;
        if (yy < 0 || yy >= bh) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = bx + dx;
          if (xx < 0 || xx >= bw) continue;
          var idx = yy * bw + xx;
          sr += bgR[idx]; sg += bgG[idx]; sb += bgB[idx]; wt++;
        }
      }
      var i = by * bw + bx;
      smR[i] = sr / wt; smG[i] = sg / wt; smB[i] = sb / wt;
    }
  }

  var half = blockSize / 2.0;
  function clampX(v) { return v < 0 ? 0 : v >= bw ? bw-1 : v; }
  function clampY(v) { return v < 0 ? 0 : v >= bh ? bh-1 : v; }
  var bgOut = new Float64Array(3);
  function bgAt(px, py) {
    var fx = (px - half) / blockSize;
    var fy = (py - half) / blockSize;
    var ix = fx | 0, iy = fy | 0;
    var tx = fx - ix, ty = fy - iy;
    if (tx < 0) tx = 0;
    if (ty < 0) ty = 0;
    var i00 = clampY(iy)   * bw + clampX(ix);
    var i10 = clampY(iy)   * bw + clampX(ix+1);
    var i01 = clampY(iy+1) * bw + clampX(ix);
    var i11 = clampY(iy+1) * bw + clampX(ix+1);
    var w00 = (1-tx)*(1-ty), w10 = tx*(1-ty), w01 = (1-tx)*ty, w11 = tx*ty;
    bgOut[0] = smR[i00]*w00 + smR[i10]*w10 + smR[i01]*w01 + smR[i11]*w11;
    bgOut[1] = smG[i00]*w00 + smG[i10]*w10 + smG[i01]*w01 + smG[i11]*w11;
    bgOut[2] = smB[i00]*w00 + smB[i10]*w10 + smB[i01]*w01 + smB[i11]*w11;
    return bgOut;
  }

  if (unsharpAlpha > 0) {
    var blurR = new Uint8Array(w * h);
    var blurG = new Uint8Array(w * h);
    var blurB = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sr = 0, sg = 0, sb2 = 0, wt = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= w) continue;
            var ri2 = (yy * w + xx) * 4;
            sr += rgba[ri2]; sg += rgba[ri2+1]; sb2 += rgba[ri2+2]; wt++;
          }
        }
        var idx2 = y * w + x;
        blurR[idx2] = (sr / wt) | 0;
        blurG[idx2] = (sg / wt) | 0;
        blurB[idx2] = (sb2 / wt) | 0;
      }
    }
    for (var i = 0; i < w * h; i++) {
      var ri2 = i * 4;
      var rv = rgba[ri2]   + unsharpAlpha * (rgba[ri2]   - blurR[i]) | 0;
      var gv = rgba[ri2+1] + unsharpAlpha * (rgba[ri2+1] - blurG[i]) | 0;
      var bv = rgba[ri2+2] + unsharpAlpha * (rgba[ri2+2] - blurB[i]) | 0;
      rgba[ri2]   = rv < 0 ? 0 : rv > 255 ? 255 : rv;
      rgba[ri2+1] = gv < 0 ? 0 : gv > 255 ? 255 : gv;
      rgba[ri2+2] = bv < 0 ? 0 : bv > 255 ? 255 : bv;
    }
  }

  var distPlane = new Uint8Array(w * h);
  var mid = 0;
  for (var y = 0; y < h; y++) {
    var ri = y * w * 4;
    for (var x = 0; x < w; x++) {
      var bg  = bgAt(x, y);
      var dr  = Math.abs(rgba[ri]   - bg[0]);
      var dg  = Math.abs(rgba[ri+1] - bg[1]);
      var db  = Math.abs(rgba[ri+2] - bg[2]);
      ri += 4;
      var dist = dr > dg ? dr : dg; if (db > dist) dist = db;
      if (dist > 255) dist = 255;
      distPlane[y * w + x] = dist;
      if (dist >= inkDistEmbed) mid++;
    }
  }
  if (mid > photoFracE * w * h) return grayPage(w, h, rgba);

  var state = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) {
    if (distPlane[i] >= inkDistEmbed)        state[i] = 2;
    else if (distPlane[i] >= weakDistEmbed)  state[i] = 1;
  }

  // Typed-array BFS queue — avoids JS array resize/GC overhead of push/pop.
  var queue = new Int32Array(w * h);
  var qHead = 0, qTail = 0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = y * w + x;
      if (state[i] !== 1) continue;
      outer: for (var dy = -1; dy <= 1; dy++) {
        var yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (state[yy * w + xx] === 2) { state[i] = 2; queue[qTail++] = i; break outer; }
        }
      }
    }
  }
  while (qHead < qTail) {
    var i = queue[qHead++];
    var x = i % w, y = (i / w) | 0;
    for (var dy = -1; dy <= 1; dy++) {
      var yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        var j = yy * w + xx;
        if (state[j] === 1) { state[j] = 2; queue[qTail++] = j; }
      }
    }
  }

  var rowBytes = (w + 7) >> 3;
  var raw = new Uint8Array(rowBytes * h);
  for (var i = 0; i < raw.length; i++) raw[i] = 0xFF;
  for (var y = 0; y < h; y++) {
    var base = y * rowBytes;
    for (var x = 0; x < w; x++) {
      if (state[y * w + x] === 2) {
        raw[base + (x >> 3)] &= ~(0x80 >> (x & 7));
      }
    }
  }
  return { bits: 1, data: raw, w: w, h: h };
}

// ─── Native Deflate Compression ───────────────────────────────────────────────
async function compressDeflate(data) {
  if (typeof CompressionStream === 'undefined') return { data: data, compressed: false };
  try {
    var cs = new CompressionStream('deflate');
    var writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    var reader = cs.readable.getReader();
    var chunks = [];
    var totalLen = 0;
    while (true) {
      var res = await reader.read();
      if (res.done) break;
      chunks.push(res.value);
      totalLen += res.value.length;
    }
    var out = new Uint8Array(totalLen);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return { data: out, compressed: true };
  } catch (e) {
    return { data: data, compressed: false };
  }
}

// ─── WASM-accelerated convertPageNormal (falls back to JS on any error) ───────
function wasmConvertNormal(w, h, rgba) {
  var ex = wasmExports;
  if (!ex) return convertPageNormal(w, h, rgba);   // WASM not loaded → JS

  var rgbaLen = w * h * 4;
  var rawLen  = ex.raw_size(w, h);

  var rgbaPtr = ex.alloc_buf(rgbaLen);
  var rawPtr  = ex.alloc_buf(rawLen);
  if (!rgbaPtr || !rawPtr) {
    if (rgbaPtr) ex.free_buf(rgbaPtr);
    if (rawPtr)  ex.free_buf(rawPtr);
    return convertPageNormal(w, h, rgba);           // alloc failed → JS
  }

  // Copy rgba into WASM linear memory
  var mem = new Uint8Array(ex.memory.buffer);
  mem.set(rgba, rgbaPtr);

  var ok = ex.convert_normal(rgbaPtr, rawPtr, w, h);

  if (ok === 0) {
    // Photo page — C returned early, run grayPage in JS
    ex.free_buf(rgbaPtr);
    ex.free_buf(rawPtr);
    return grayPage(w, h, rgba);
  }

  if (ok < 0) {
    // Alloc failed inside WASM (memory too small) — fall back to JS
    ex.free_buf(rgbaPtr);
    ex.free_buf(rawPtr);
    return convertPageNormal(w, h, rgba);
  }

  // Copy raw output out of WASM memory before freeing
  // (slice makes a copy so freeing rawPtr is safe)
  var raw = new Uint8Array(ex.memory.buffer, rawPtr, rawLen).slice();

  ex.free_buf(rgbaPtr);
  ex.free_buf(rawPtr);

  return { bits: 1, data: raw, w: w, h: h };
}

// ─── Message handler ──────────────────────────────────────────────────────────
onmessage = async function (e) {
  var d = e.data;
  try {
    await wasmReady;   // no-op after first page; ensures WASM loaded before use
    var rgba = new Uint8ClampedArray(d.rgba);
    var result = d.state === 'embed'
      ? convertPageEmbed(d.w, d.h, rgba)
      : wasmConvertNormal(d.w, d.h, rgba);
    var comp = await compressDeflate(result.data);
    var transfer = [comp.data.buffer];
    postMessage({ ok: true, idx: d.idx, data: comp.data, compressed: comp.compressed, bits: result.bits, w: result.w, h: result.h }, transfer);
  } catch (err) {
    postMessage({ ok: false, idx: d.idx, error: String(err && err.message || err) });
  }
};
