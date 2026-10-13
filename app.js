/**
 * app.js — PDF Tools by Bhaskar (Native Compression + Raw Assembler)
 *
 * All processing runs entirely in the browser. No data leaves your device.
 *
 * Pipeline per page:
 *   pdf.js renders the page → ImageData (RGBA, 300 dpi equivalent via scale)
 *   → convertPageNormal  OR  convertPageEmbed  (ported from the Go algorithms)
 *   → 1-bit packed rows  OR  8-bit grayscale
 *   → Parallel Web Worker compresses streams via native CompressionStream('deflate')
 *   → Raw PDF Syntax assembler embeds compressed streams (/Filter /FlateDecode)
 *   → Blob URL → <a download> click
 */

(function () {
'use strict';

// ─── pdf.js setup ─────────────────────────────────────────────────────────────
var pdfjsLib = window['pdfjs-dist/build/pdf'];
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ─── Tunables (mirror the Go constants exactly) ────────────────────────────────
// normal.go
var darkMax       = 56;
var lightMin      = 190;
var darkInkAbove  = 100;
var lightInkBelow = 128;
var weakInkBelow  = 175;
var photoFracN    = 0.35;

// yellowish-embed.go
var inkDistEmbed    = 45;   // lowered from 60: blurry camera ink has less contrast
var weakDistEmbed   = 28;   // lowered from 35: proportional to inkDistEmbed
var photoFracE      = 0.35;
var unsharpAlpha    = 1.2;  // Fix 4: pre-sharpen strength (0=off, 1=normal, 1.5=strong)

// shared
var blockSize  = 36;
var renderDPI  = 300;   // target DPI — we achieve this via pdf.js scale factor
var POINTS_PER_INCH = 72;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
var $ = function (id) { return document.getElementById(id); };
var uploadScreen = $('uploadScreen');
var editorScreen = $('editorScreen');
var featuresSection = $('featuresSection');
var fileInput    = $('fileInput');
var dropZone     = $('dropZone');
var fileNameEl   = $('fileName');
var editorTitle  = $('editorTitle');
var pgCountEl    = $('pgCount');
var pagesScroll  = $('pagesScroll');
var countsEl     = $('counts');
var processBtn   = $('processBtn');
var backBtn      = $('backBtn');
var progressEl   = $('progress');
var fillEl       = $('fill');
var stageEl      = $('stage');
var pctEl        = $('pct');
var detailEl     = $('detail');
var clockEl      = $('clock');
var dlBtn        = $('dlBtn');
var statusEl     = $('status');
var workerSelect = $('workerSelect');
var workerWarn   = $('workerWarn');

// ─── Worker-level default (from user agent) + warning toggle ──────────────────
function defaultWorkerLevel() {
  var ua = navigator.userAgent;
  var isApple   = /iPad|iPhone|iPod/.test(ua) ||
                   (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  return isApple ? 4 : isAndroid ? 2 : 3; // Apple, Android, Desktop
}
if (workerSelect) {
  workerSelect.value = String(defaultWorkerLevel());
  if (workerWarn) workerWarn.hidden = workerSelect.value !== '6';
  workerSelect.addEventListener('change', function () {
    if (workerWarn) workerWarn.hidden = workerSelect.value !== '6';
  });
}

// ─── App state ────────────────────────────────────────────────────────────────
var chosenFile  = null;
var pdfDoc      = null;
var pageStates  = [];   // 'normal' | 'embed' | 'remove'  (1-based via index+1)
var busy        = false;
var clockTimer  = null;
var t0          = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className   = cls === 'ok' ? 'status ok' : cls === 'err' ? 'status err' : 'status';
}

function showProgress(stage, pct, detail, working) {
  fillEl.style.width   = pct + '%';
  fillEl.className     = working ? 'fill working' : 'fill';
  stageEl.textContent  = stage;
  pctEl.textContent    = pct + '%';
  detailEl.textContent = detail || '';
}

function startClock() {
  t0 = Date.now();
  clockEl.textContent = '0s';
  clearInterval(clockTimer);
  clockTimer = setInterval(function () {
    clockEl.textContent = Math.round((Date.now() - t0) / 1000) + 's';
  }, 1000);
}

function stopClock() { clearInterval(clockTimer); }

// ─── Native Deflate Compression Helper ─────────────────────────────────────────
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

// ─── Upload / drop ────────────────────────────────────────────────────────────
fileInput.addEventListener('change', function () {
  if (fileInput.files.length) openEditor(fileInput.files[0]);
});
dropZone.addEventListener('dragover', function (e) {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', function () {
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', function (e) {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  var f = e.dataTransfer.files[0];
  if (f && /\.pdf$/i.test(f.name)) openEditor(f);
  else setStatus('Please drop a PDF file.', 'err');
});

backBtn.addEventListener('click', function () {
  stopClock();
  busy = false; pdfDoc = null; pageStates = [];
  pagesScroll.innerHTML = '';
  editorScreen.style.display = 'none';
  uploadScreen.style.display = 'block';
  if (featuresSection && featuresSection.parentNode && uploadScreen.nextSibling !== featuresSection) {
    featuresSection.parentNode.insertBefore(featuresSection, editorScreen);
  }
  fileInput.value = ''; fileNameEl.textContent = '';
  dlBtn.hidden = true; progressEl.hidden = true; setStatus('');
  processBtn.disabled = false;
  processBtn.textContent = 'Process PDF';
});

// ─── Open editor ──────────────────────────────────────────────────────────────
function openEditor(file) {
  chosenFile = file;
  fileNameEl.textContent = file.name;
  uploadScreen.style.display = 'none';
  editorScreen.style.display = 'flex';
  if (featuresSection && featuresSection.parentNode) {
    featuresSection.parentNode.insertBefore(editorScreen, featuresSection);
  }
  editorTitle.textContent = 'Loading…';
  pgCountEl.textContent   = '';
  pagesScroll.innerHTML   = '';
  processBtn.disabled     = true;
  dlBtn.hidden            = true;
  progressEl.hidden       = true;
  setStatus('');

  var reader = new FileReader();
  reader.onerror = function () {
    editorTitle.textContent = 'Error loading PDF';
    setStatus('Could not read file: ' + (reader.error && reader.error.message || 'unknown error'), 'err');
  };
  reader.onload = function (ev) {
    pdfjsLib.getDocument({ data: ev.target.result }).promise.then(function (doc) {
      pdfDoc = doc;
      var n  = doc.numPages;
      pageStates = new Array(n).fill('normal');

      var name = file.name.length > 36 ? file.name.slice(0, 34) + '…' : file.name;
      editorTitle.textContent = name;
      pgCountEl.textContent   = n + (n === 1 ? ' page' : ' pages');
      updateCounts();

      for (var i = 1; i <= n; i++) { pagesScroll.appendChild(makeCard(i)); refreshCard(i); }
      processBtn.disabled = false;
      renderLazy(n);
    }).catch(function (e) {
      editorTitle.textContent = 'Error loading PDF';
      setStatus('Could not open PDF: ' + e.message, 'err');
    });
  };
  reader.readAsArrayBuffer(file);
}

// ─── Page cards ───────────────────────────────────────────────────────────────
function makeCard(p) {
  var card = document.createElement('div');
  card.className = 'page-card';
  card.id = 'card-' + p;

  var thumb = document.createElement('div');
  thumb.className = 'pc-thumb loading';
  thumb.id = 'thumb-' + p;
  var lbl = document.createElement('div');
  lbl.className   = 'pg-label';
  lbl.textContent = 'Page ' + p;
  thumb.appendChild(lbl);

  var opts = document.createElement('div');
  opts.className = 'pc-opts';
  opts.appendChild(makeOpt(p, 'normal', 'opt-normal', 'Normal / PDF image embedded',
    'Black-bg slides, or black/white-bg image pasted in like a pdf'));
  opts.appendChild(makeOpt(p, 'embed', 'opt-embed', 'Warm / yellowish book image',
    'Only for a yellowish, warm-toned photo pasted from a book'));
  opts.appendChild(makeOpt(p, 'remove', 'opt-remove', 'Remove page',
    'Drop this page from the output'));

  card.appendChild(thumb);
  card.appendChild(opts);
  refreshCard(p);
  return card;
}

function makeOpt(pageNum, state, cls, title, sub) {
  var opt = document.createElement('div');
  var _optCls = { 'opt-normal': 'opt opt-normal', 'opt-embed': 'opt opt-embed', 'opt-remove': 'opt opt-remove' };
  opt.className = _optCls[cls] || 'opt';
  opt.innerHTML =
    '<div class="opt-radio"></div>' +
    '<div class="opt-text">' +
      '<div class="opt-title">' + title + '</div>' +
      '<div class="opt-sub">'   + sub   + '</div>' +
    '</div>';
  opt.addEventListener('click', function (e) {
    e.stopPropagation();
    if (busy) return;
    setState(pageNum, state);
  });
  return opt;
}

function setState(pageNum, newState) {
  pageStates[pageNum - 1] = newState;
  refreshCard(pageNum);
  updateCounts();
}

function refreshCard(pageNum) {
  var cur  = pageStates[pageNum - 1];
  var card = $('card-' + pageNum);
  if (!card) return;
  card.classList.toggle('removed', cur === 'remove');
  var opts = card.querySelectorAll('.opt');
  var map  = ['normal', 'embed', 'remove'];
  for (var i = 0; i < opts.length; i++) {
    opts[i].classList.toggle('active', map[i] === cur);
  }
}

function updateCounts() {
  var n = pageStates.length, em = 0, rm = 0;
  for (var i = 0; i < n; i++) {
    if (pageStates[i] === 'embed')  em++;
    if (pageStates[i] === 'remove') rm++;
  }
  countsEl.innerHTML =
    '<strong>' + n + '</strong> pages · ' +
    '<strong style="color:#f5c842">' + em + '</strong> embed · ' +
    '<strong style="color:var(--error)">' + rm + '</strong> remove · ' +
    '<strong>' + (n - rm) + '</strong> will be processed';
}

// ─── Lazy thumbnail rendering ─────────────────────────────────────────────────
var THUMB_SCALE = 0.5;

function renderLazy(total) {
  if (!('IntersectionObserver' in window)) {
    for (var p = 1; p <= total; p++) renderThumb(p);
    return;
  }
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var id = entry.target.id;
      renderThumb(parseInt(id.split('-')[1], 10));
      obs.unobserve(entry.target);
    });
  }, { root: pagesScroll, rootMargin: '300px' });
  for (var p = 1; p <= total; p++) {
    var el = $('thumb-' + p);
    if (el) obs.observe(el);
  }
}

function renderThumb(p) {
  if (!pdfDoc) return;
  pdfDoc.getPage(p).then(function (page) {
    var vp     = page.getViewport({ scale: THUMB_SCALE });
    var canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
      var el = $('thumb-' + p);
      if (!el) return;
      el.classList.remove('loading');
      el.insertBefore(canvas, el.firstChild);
    });
  });
}

// ─── Shared pixel helpers ─────────────────────────────────────────────────────

function minmax(r, g, b) {
  var mx = r > g ? r : g; if (b > mx) mx = b;
  var mn = r < g ? r : g; if (b < mn) mn = b;
  return [mx, mn];
}

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
  var prevRow = new Uint8Array(w);
  var curRow  = new Uint8Array(w);
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

  for (var y = 0; y < h; y++) {
    var base = ((y / blockSize) | 0) * bw;
    var ri   = y * w * 4;
    for (var x = 0; x < w; x++) {
      var r = rgba[ri]; var g = rgba[ri+1]; var b = rgba[ri+2];
      ri += 4;
      var mm = minmax(r, g, b);
      var mx = mm[0], mn = mm[1];
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
  function polAt(px, py) {
    var fx  = (px - half) / blockSize;
    var fy  = (py - half) / blockSize;
    var bx0 = fx | 0;
    var by0 = fy | 0;
    var tx  = fx - bx0;
    var ty  = fy - by0;
    if (tx < 0) tx = 0;
    if (ty < 0) ty = 0;
    var bx1  = bx0 + 1 < bw ? bx0 + 1 : bw - 1;
    var by1  = by0 + 1 < bh ? by0 + 1 : bh - 1;
    var bx0c = bx0 < 0 ? 0 : bx0;
    var by0c = by0 < 0 ? 0 : by0;
    var s00 = polScore[by0c * bw + bx0c];
    var s10 = polScore[by0c * bw + bx1];
    var s01 = polScore[by1  * bw + bx0c];
    var s11 = polScore[by1  * bw + bx1];
    return s00*(1-tx)*(1-ty) + s10*tx*(1-ty) + s01*(1-tx)*ty + s11*tx*ty;
  }

  var mnPlane = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) {
    mnPlane[i] = minmax(rgba[4*i], rgba[4*i+1], rgba[4*i+2])[1];
  }
  smooth121(mnPlane, w, h);

  var state = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i  = y * w + x;
      var ri = i * 4;
      if (polAt(x, y) > 0.5) {
        var mx = minmax(rgba[ri], rgba[ri+1], rgba[ri+2])[0];
        if (mx > darkInkAbove) state[i] = 2;
      } else {
        var sm = mnPlane[i];
        if (sm < lightInkBelow)  state[i] = 2;
        else if (sm < weakInkBelow) state[i] = 1;
      }
    }
  }

  var stack = [];
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
          if (state[yy * w + xx] === 2) { state[i] = 2; stack.push(i); break outer; }
        }
      }
    }
  }
  while (stack.length > 0) {
    var i = stack.pop();
    var x = i % w, y = (i / w) | 0;
    for (var dy = -1; dy <= 1; dy++) {
      var yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        var j = yy * w + xx;
        if (state[j] === 1) { state[j] = 2; stack.push(j); }
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

  // Fix 1: 85th-percentile background estimation.
  // Mean includes ink pixels → background looks darker near text → dist shrinks → ink missed.
  // 85th percentile of per-pixel brightness in a block is almost always background.
  // We collect brightness samples per block, find the 85th-pct threshold, then
  // average the R/G/B of all pixels AT OR ABOVE that threshold as the block background.
  var blockPixelCount = blockSize * blockSize;
  // Collect brightness (max channel) samples per block into a flat array
  var brightBuf = new Uint8Array(nb * blockPixelCount); // worst-case; real blocks may be smaller
  var brightCnt = new Int32Array(nb);
  // Also accumulate R/G/B per block for background averaging
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
      var brv = r > g ? r : g; if (b > brv) brv = b; // max channel = brightness
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
  // Temp sort buffer — reuse a single array
  var sortBuf = new Uint8Array(blockPixelCount);
  for (var i = 0; i < nb; i++) {
    var n = brightCnt[i];
    if (n === 0) continue;
    // Copy brightness values for this block and sort ascending
    var off = i * blockPixelCount;
    for (var k = 0; k < n; k++) sortBuf[k] = brightBuf[off + k];
    // Insertion sort — blocks are small (≤blockSize²=1521 pixels), fast enough
    for (var k = 1; k < n; k++) {
      var kv = sortBuf[k], j = k - 1;
      while (j >= 0 && sortBuf[j] > kv) { sortBuf[j+1] = sortBuf[j]; j--; }
      sortBuf[j+1] = kv;
    }
    // 85th percentile brightness threshold
    var p85idx = (n * 85 / 100) | 0;
    var thresh  = sortBuf[p85idx];
    // Average R/G/B of pixels whose brightness >= thresh (background pixels)
    var sr = 0, sg = 0, sb = 0, sc = 0;
    // Re-scan this block's pixels from rgba
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
      // Fallback to mean if no pixel hit threshold (shouldn't happen)
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
  function bgAt(px, py) {
    var fx = (px - half) / blockSize;
    var fy = (py - half) / blockSize;
    var ix = fx | 0, iy = fy | 0;
    var tx = fx - ix, ty = fy - iy;
    if (tx < 0) tx = 0;
    if (ty < 0) ty = 0;
    var clampX = function (v) { return v < 0 ? 0 : v >= bw ? bw-1 : v; };
    var clampY = function (v) { return v < 0 ? 0 : v >= bh ? bh-1 : v; };
    var i00 = clampY(iy)   * bw + clampX(ix);
    var i10 = clampY(iy)   * bw + clampX(ix+1);
    var i01 = clampY(iy+1) * bw + clampX(ix);
    var i11 = clampY(iy+1) * bw + clampX(ix+1);
    var w00 = (1-tx)*(1-ty), w10 = tx*(1-ty), w01 = (1-tx)*ty, w11 = tx*ty;
    return [
      smR[i00]*w00 + smR[i10]*w10 + smR[i01]*w01 + smR[i11]*w11,
      smG[i00]*w00 + smG[i10]*w10 + smG[i01]*w01 + smG[i11]*w11,
      smB[i00]*w00 + smB[i10]*w10 + smB[i01]*w01 + smB[i11]*w11
    ];
  }

  // Fix 4: unsharp mask on RGBA to boost local contrast before dist computation.
  // For blurry camera images this makes ink stand further from the yellow background.
  // We build a box-blurred copy (3×3), then: sharp = clamp(pixel + alpha*(pixel - blur)).
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
    // Apply: sharp = pixel + alpha*(pixel - blur), clamped to [0,255]
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
  // smooth121 intentionally removed: blurs dist values, breaks thin strokes.
  // The weak-pixel flood-fill below handles isolated noise instead.

  var state = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) {
    if (distPlane[i] >= inkDistEmbed)        state[i] = 2;
    else if (distPlane[i] >= weakDistEmbed)  state[i] = 1;
  }

  var stack = [];
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
          if (state[yy * w + xx] === 2) { state[i] = 2; stack.push(i); break outer; }
        }
      }
    }
  }
  while (stack.length > 0) {
    var i = stack.pop();
    var x = i % w, y = (i / w) | 0;
    for (var dy = -1; dy <= 1; dy++) {
      var yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        var j = yy * w + xx;
        if (state[j] === 1) { state[j] = 2; stack.push(j); }
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

// ─── Render one page to RGBA at 300 dpi equivalent ───────────────────────────
function renderPageRGBA(pageNum) {
  return pdfDoc.getPage(pageNum).then(function (page) {
    var vp0 = page.getViewport({ scale: 1.0 });
    var scale  = renderDPI / 96;
    var vp     = page.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width  = vp.width  | 0;
    canvas.height = vp.height | 0;
    var ctx = canvas.getContext('2d');
    return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
      var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        rgba: imgData.data,
        w:    canvas.width,
        h:    canvas.height,
        ptW:  vp0.width,
        ptH:  vp0.height
      };
    });
  });
}

// ─── Custom Raw PDF Assembler ──────────────────────────────────────────────────
/**
 * pagePromises resolves to an array of { data, compressed, bits, w, h, ptW, ptH }
 * Constructs PDF 1.3 syntax with /FlateDecode streams. Millisecond execution.
 */
async function buildRawPDF(pagePromises) {
  var pages = [];
  for (var i = 0; i < pagePromises.length; i++) {
    pages.push(await pagePromises[i]);
  }

  var buffers = [];
  var offset = 0;
  var xrefs = [];

  function addStr(s) {
    var buf = new TextEncoder().encode(s);
    buffers.push(buf);
    offset += buf.length;
  }

  function addBuf(buf) {
    buffers.push(buf);
    offset += buf.length;
  }

  function startObj(id) {
    xrefs[id] = offset;
    addStr(id + " 0 obj\n");
  }

  // Header
  addStr("%PDF-1.3\n%\xE2\xE3\xCF\xD3\n");

  var n = pages.length;
  var pagesId = 2;

  // Catalog
  startObj(1);
  addStr("<< /Type /Catalog /Pages " + pagesId + " 0 R >>\nendobj\n");

  // Pages Tree
  startObj(pagesId);
  var kids = [];
  for (var i = 0; i < n; i++) kids.push((3 + i * 3) + " 0 R");
  addStr("<< /Type /Pages /Count " + n + " /Kids [" + kids.join(" ") + "] >>\nendobj\n");

  // Loop pages
  for (var i = 0; i < n; i++) {
    var p = pages[i];
    var pageId = 3 + i * 3;
    var contentsId = 4 + i * 3;
    var imageId = 5 + i * 3;

    // Page Dict
    startObj(pageId);
    addStr("<< /Type /Page /Parent " + pagesId + " 0 R /MediaBox [0 0 " + p.ptW.toFixed(2) + " " + p.ptH.toFixed(2) + "] /Contents " + contentsId + " 0 R /Resources << /XObject << /I1 " + imageId + " 0 R >> >> >>\nendobj\n");

    // Content Stream (Draw Image)
    var contentStr = "q " + p.ptW.toFixed(2) + " 0 0 " + p.ptH.toFixed(2) + " 0 0 cm /I1 Do Q\n";
    startObj(contentsId);
    addStr("<< /Length " + contentStr.length + " >>\nstream\n");
    addStr(contentStr);
    addStr("endstream\nendobj\n");

    // Image XObject with FlateDecode support
    startObj(imageId);
    var filterStr = p.compressed ? " /Filter /FlateDecode" : "";
    var imgDict = "<< /Type /XObject /Subtype /Image /Width " + p.w + " /Height " + p.h + " /ColorSpace /DeviceGray /BitsPerComponent " + p.bits + filterStr + " /Length " + p.data.length + " >>\n";
    addStr(imgDict);
    addStr("stream\n");
    addBuf(p.data);
    addStr("\nendstream\nendobj\n");
  }

  // Cross Reference Table
  var xrefOffset = offset;
  addStr("xref\n0 " + xrefs.length + "\n");
  addStr("0000000000 65535 f \r\n");
  for (var i = 1; i < xrefs.length; i++) {
    var offStr = xrefs[i].toString();
    while(offStr.length < 10) offStr = "0" + offStr;
    addStr(offStr + " 00000 n \r\n");
  }

  // Trailer
  addStr("trailer\n<< /Size " + xrefs.length + " /Root 1 0 R >>\n");
  addStr("startxref\n" + xrefOffset + "\n%%EOF\n");

  // Concat memory
  var total = new Uint8Array(offset);
  var cur = 0;
  for (var j = 0; j < buffers.length; j++) {
    total.set(buffers[j], cur);
    cur += buffers[j].length;
  }
  return total;
}

// ─── Worker pool ───────────────────────────────────────────────────────────────
function createWorkerPool(n) {
  try {
    var pool = [];
    for (var i = 0; i < n; i++) pool.push(new Worker('worker.min.js'));
    return pool;
  } catch (e) {
    return null;
  }
}

function terminatePool(pool) {
  if (!pool) return;
  for (var i = 0; i < pool.length; i++) pool[i].terminate();
}

function runPoolPipeline(pool, pageList, onProgress, onPageReady) {
  return new Promise(function (resolve, reject) {
    if (pageList.length === 0) { resolve(); return; }
    var ptDims  = new Array(pageList.length);
    var nextIn  = 0;
    var done    = 0;
    var failed  = false;

    function assignNext(worker) {
      if (failed || nextIn >= pageList.length) return;
      var idx = nextIn++;
      renderPageRGBA(pageList[idx].pageNum).then(function (rendered) {
        if (failed) return;
        ptDims[idx] = { ptW: rendered.ptW, ptH: rendered.ptH };
        worker.postMessage(
          { idx: idx, state: pageList[idx].state, w: rendered.w, h: rendered.h, rgba: rendered.rgba.buffer },
          [rendered.rgba.buffer]
        );
      }).catch(function (err) { if (!failed) { failed = true; reject(err); } });
    }

    pool.forEach(function (worker) {
      worker.onmessage = function (e) {
        var msg = e.data; if (msg.wasmError) { console.error('WASM load failed: ' + msg.wasmError); setStatus('WASM failed: ' + msg.wasmError, 'err'); return; }
        if (failed) return;
        if (!msg.ok) { failed = true; reject(new Error(msg.error)); return; }
        if (onPageReady) {
          var dims = ptDims[msg.idx];
          onPageReady(msg.idx, { data: msg.data, compressed: msg.compressed, bits: msg.bits, w: msg.w, h: msg.h, ptW: dims.ptW, ptH: dims.ptH });
        }
        done++;
        if (onProgress) onProgress(done, pageList.length);
        if (done >= pageList.length) { resolve(); return; }
        assignNext(worker);
      };
      worker.onerror = function (e) {
        if (!failed) { failed = true; reject(e.error || new Error(e.message || 'Worker error')); }
      };
      assignNext(worker);
    });
  });
}

// ─── Process button ───────────────────────────────────────────────────────────
processBtn.addEventListener('click', async function () {
  if (!chosenFile || busy || !pdfDoc) return;
  busy = true;
  processBtn.disabled = true;
  dlBtn.hidden   = true;
  setStatus('');
  progressEl.hidden = false;
  startClock();

  var pageList = [];
  for (var i = 0; i < pageStates.length; i++) {
    if (pageStates[i] !== 'remove') pageList.push({ pageNum: i + 1, state: pageStates[i] });
  }
  var total = pageList.length;

  showProgress('Starting', 0, 'Preparing…', true);

  var workerLevel = (workerSelect && parseInt(workerSelect.value, 10)) || 1;
  var pool = createWorkerPool(workerLevel);

  var pageResolvers = new Array(total);
  var pagePromises  = new Array(total);
  for (var pi = 0; pi < total; pi++) {
    (function (i) {
      pagePromises[i] = new Promise(function (res) { pageResolvers[i] = res; });
    })(pi);
  }

  try {
    if (pool) {
      await runPoolPipeline(pool, pageList,
        function (done) {
          var pct = Math.round(done * 90 / total);
          showProgress('Processing', pct, 'Page ' + done + ' of ' + total, true);
        },
        function (idx, payload) {
          pageResolvers[idx](payload);
        }
      );
      terminatePool(pool);
      pool = null;
    } else {
      // Sequential fallback
      for (var idx = 0; idx < pageList.length; idx++) {
        var entry = pageList[idx];
        var pct   = Math.round(idx * 90 / total);
        showProgress('Processing', pct, 'Page ' + (idx + 1) + ' of ' + total, true);

        await new Promise(function (r) { setTimeout(r, 0); });
        var rendered = await renderPageRGBA(entry.pageNum);

        var result;
        if (entry.state === 'embed') {
          result = convertPageEmbed(rendered.w, rendered.h, rendered.rgba);
        } else {
          result = convertPageNormal(rendered.w, rendered.h, rendered.rgba);
        }
        
        var comp = await compressDeflate(result.data);
        pageResolvers[idx]({ data: comp.data, compressed: comp.compressed, bits: result.bits, w: result.w, h: result.h, ptW: rendered.ptW, ptH: rendered.ptH });
      }
    }

    showProgress('Building PDF', 92, 'Assembling pages…', true);
    await new Promise(function (r) { setTimeout(r, 0); });

    var pdfBytes = await buildRawPDF(pagePromises);

    showProgress('Done', 100, 'Finished in ' + Math.round((Date.now() - t0) / 1000) + 's', false);

    var blob    = new Blob([pdfBytes], { type: 'application/pdf' });
    var blobURL = URL.createObjectURL(blob);
    var outName = chosenFile.name.replace(/\.pdf$/i, '') + '_print.pdf';
    dlBtn.href     = blobURL;
    dlBtn.download = outName;
    dlBtn.hidden   = false;
    setStatus('Ready — tap Download if the file did not save automatically.', 'ok');
    setTimeout(function () { dlBtn.click(); }, 300);

  } catch (err) {
    terminatePool(pool);
    stopClock();
    progressEl.hidden = true;
    setStatus('Error: ' + (err && err.message ? err.message : String(err)), 'err');
    console.error(err);
    processBtn.disabled = false;
    busy = false;
    return;
  }

  stopClock();
  busy = false;
  processBtn.disabled = false;
  processBtn.textContent = 'Process again';
});

})();

