#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ── Constants (must match worker.js) ────────────────────────────────────── */
#define BLOCK_SIZE      39
#define DARK_MAX        56
#define LIGHT_MIN       190
#define DARK_INK_ABOVE  100
#define LIGHT_INK_BELOW 128
#define WEAK_INK_BELOW  175
#define PHOTO_FRAC_N    0.35f

/* ── Exported WASM functions ─────────────────────────────────────────────── */

/*
 * convert_normal()
 *
 * Full pixel pipeline for convertPageNormal:
 *   1. Compute dark[], light[], mnPlane[], mid count  (one w*h pass)
 *   2. If mid > photoFrac → return 0 (caller falls back to grayPage in JS)
 *   3. Compute polScore[]  (bw*bh neighbourhood sum)
 *   4. smooth121 on mnPlane
 *   5. Bilinear polarity + state assignment  (one w*h pass)
 *   6. BFS flood-fill  (typed queue, pre-allocated)
 *   7. Pack 1bpp into raw[]
 *
 * Parameters
 *   rgba        input  – w*h*4 bytes (R,G,B,A)
 *   raw         output – rowBytes*h bytes, caller must allocate (w+7)/8 * h
 *   w, h        pixel dimensions
 *
 * Returns 1 on success, 0 if page is a photo (caller should use grayPage).
 */
int convert_normal(
    const uint8_t * restrict rgba,
    uint8_t       * restrict raw,
    int w, int h)
{
    int bw = (w + BLOCK_SIZE - 1) / BLOCK_SIZE;
    int bh = (h + BLOCK_SIZE - 1) / BLOCK_SIZE;
    int nb = bw * bh;
    int n  = w * h;

    /* ── Allocate working buffers ─────────────────────────────────────────── */
    int32_t  *dark     = (int32_t  *)calloc(nb, sizeof(int32_t));
    int32_t  *light    = (int32_t  *)calloc(nb, sizeof(int32_t));
    uint8_t  *mnPlane  = (uint8_t  *)malloc(n);
    int32_t  *xb       = (int32_t  *)malloc(w * sizeof(int32_t));
    float    *polScore  = (float   *)malloc(nb * sizeof(float));
    uint8_t  *state    = (uint8_t  *)calloc(n, 1);
    int32_t  *queue    = (int32_t  *)malloc(n * sizeof(int32_t));

    /* If any allocation failed, free everything and signal JS to use fallback */
    if (!dark || !light || !mnPlane || !xb || !polScore || !state || !queue) {
        free(dark); free(light); free(mnPlane); free(xb);
        free(polScore); free(state); free(queue);
        return -1;  /* JS treats any non-1 return as fallback to JS */
    }

    /* ── Pre-compute block x index for each pixel column ─────────────────── */
    for (int x = 0; x < w; x++) xb[x] = x / BLOCK_SIZE;

    /* ── Pass 1: dark[], light[], mnPlane[], mid count ───────────────────── */
    int mid = 0;
    for (int y = 0; y < h; y++) {
        int bbase  = (y / BLOCK_SIZE) * bw;
        int ri     = y * w * 4;
        int rowOff = y * w;
        for (int x = 0; x < w; x++) {
            uint8_t r = rgba[ri],  g = rgba[ri+1], b = rgba[ri+2];
            ri += 4;
            uint8_t mx = r > g ? r : g; if (b > mx) mx = b;
            uint8_t mn = r < g ? r : g; if (b < mn) mn = b;
            mnPlane[rowOff + x] = mn;
            int bi = bbase + xb[x];
            if      (mx <= DARK_MAX)  dark[bi]++;
            else if (mn >= LIGHT_MIN) light[bi]++;
            else                      mid++;
        }
    }

    /* ── Photo check ─────────────────────────────────────────────────────── */
    if (mid > (int)(PHOTO_FRAC_N * (float)n)) {
        free(dark); free(light); free(mnPlane); free(xb);
        free(polScore); free(state); free(queue);
        return 0;   /* caller falls back to grayPage in JS */
    }

    /* ── Compute defaultDark ─────────────────────────────────────────────── */
    int totD = 0, totL = 0;
    for (int i = 0; i < nb; i++) { totD += dark[i]; totL += light[i]; }
    int defaultDark = (totD >= totL) ? 1 : 0;

    /* ── polScore: 3×3 neighbourhood sum per block ───────────────────────── */
    for (int by = 0; by < bh; by++) {
        for (int bx = 0; bx < bw; bx++) {
            int d = 0, l = 0;
            for (int dy = -1; dy <= 1; dy++) {
                int yy = by + dy;
                if (yy < 0 || yy >= bh) continue;
                for (int dx = -1; dx <= 1; dx++) {
                    int xx = bx + dx;
                    if (xx < 0 || xx >= bw) continue;
                    d += dark[yy * bw + xx];
                    l += light[yy * bw + xx];
                }
            }
            if (d + l == 0)
                polScore[by * bw + bx] = defaultDark ? 1.0f : 0.0f;
            else
                polScore[by * bw + bx] = (float)d / (float)(d + l);
        }
    }

    free(dark);
    free(light);

    /* ── smooth121 horizontal pass ───────────────────────────────────────── */
    for (int y = 0; y < h; y++) {
        int base = y * w;
        uint8_t prev = mnPlane[base];
        for (int x = 0; x < w; x++) {
            uint8_t cur = mnPlane[base + x];
            int     nx  = (x + 1 < w) ? x + 1 : w - 1;
            mnPlane[base + x] = (uint8_t)((prev + 2*cur + mnPlane[base + nx] + 2) >> 2);
            prev = cur;
        }
    }

    /* ── smooth121 vertical pass (two row buffers, swapped) ─────────────── */
    uint8_t *prevRow = (uint8_t *)malloc(w);
    uint8_t *curRow  = (uint8_t *)malloc(w);
    memcpy(prevRow, mnPlane, w);
    for (int y = 0; y < h; y++) {
        memcpy(curRow, mnPlane + y * w, w);
        int ny = (y + 1 < h) ? y + 1 : h - 1;
        const uint8_t *nextRow = mnPlane + ny * w;
        uint8_t       *out     = mnPlane + y  * w;
        for (int x = 0; x < w; x++) {
            out[x] = (uint8_t)((prevRow[x] + 2*curRow[x] + nextRow[x] + 2) >> 2);
        }
        /* swap prevRow ↔ curRow */
        uint8_t *tmp = prevRow; prevRow = curRow; curRow = tmp;
    }
    free(prevRow);
    free(curRow);

    /* ── Single pass: bilinear polarity + state assignment ───────────────── */
    float half = BLOCK_SIZE / 2.0f;
    for (int y = 0; y < h; y++) {
        float fy   = (y - half) / BLOCK_SIZE;
        int   by0  = (int)fy;
        float ty   = fy - by0; if (ty < 0.0f) ty = 0.0f;
        int   by1  = (by0 + 1 < bh) ? by0 + 1 : bh - 1;
        int   by0c = (by0 < 0) ? 0 : by0;
        for (int x = 0; x < w; x++) {
            int   i    = y * w + x;
            float fx   = (x - half) / BLOCK_SIZE;
            int   bx0  = (int)fx;
            float tx   = fx - bx0; if (tx < 0.0f) tx = 0.0f;
            int   bx1  = (bx0 + 1 < bw) ? bx0 + 1 : bw - 1;
            int   bx0c = (bx0 < 0) ? 0 : bx0;
            float s00  = polScore[by0c * bw + bx0c];
            float s10  = polScore[by0c * bw + bx1 ];
            float s01  = polScore[by1  * bw + bx0c];
            float s11  = polScore[by1  * bw + bx1 ];
            float s    = s00*(1-tx)*(1-ty) + s10*tx*(1-ty)
                       + s01*(1-tx)*ty     + s11*tx*ty;
            int ri = i * 4;
            if (s > 0.5f) {
                uint8_t r1 = rgba[ri], g1 = rgba[ri+1], b1 = rgba[ri+2];
                uint8_t mx = r1 > g1 ? r1 : g1; if (b1 > mx) mx = b1;
                if (mx > DARK_INK_ABOVE) state[i] = 2;
            } else {
                uint8_t sm = mnPlane[i];
                if      (sm < LIGHT_INK_BELOW) state[i] = 2;
                else if (sm < WEAK_INK_BELOW)  state[i] = 1;
            }
        }
    }

    free(polScore);
    free(xb);
    free(mnPlane);

    /* ── BFS flood-fill: promote weak-ink pixels adjacent to dark ────────── */
    int qHead = 0, qTail = 0;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int i = y * w + x;
            if (state[i] != 1) continue;
            int seeded = 0;
            for (int dy = -1; dy <= 1 && !seeded; dy++) {
                int yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (int dx = -1; dx <= 1 && !seeded; dx++) {
                    int xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    if (state[yy * w + xx] == 2) {
                        state[i] = 2;
                        queue[qTail++] = i;
                        seeded = 1;
                    }
                }
            }
        }
    }
    while (qHead < qTail) {
        int i = queue[qHead++];
        int x = i % w, y = i / w;
        for (int dy = -1; dy <= 1; dy++) {
            int yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (int dx = -1; dx <= 1; dx++) {
                int xx = x + dx;
                if (xx < 0 || xx >= w) continue;
                int j = yy * w + xx;
                if (state[j] == 1) { state[j] = 2; queue[qTail++] = j; }
            }
        }
    }

    free(queue);

    /* ── Pack state into 1bpp (1=white/0xFF default, 0=black ink) ─────────── */
    int rowBytes = (w + 7) >> 3;
    memset(raw, 0xFF, (size_t)rowBytes * h);
    for (int y = 0; y < h; y++) {
        int base = y * rowBytes;
        int rOff = y * w;
        for (int x = 0; x < w; x++) {
            if (state[rOff + x] == 2) {
                raw[base + (x >> 3)] &= ~(0x80 >> (x & 7));
            }
        }
    }

    free(state);
    return 1;
}

/*
 * alloc_buf() / free_buf()
 *
 * JS calls these to allocate/free buffers inside WASM linear memory,
 * so it can pass pointers directly without copying.
 */
uint8_t *alloc_buf(int bytes) {
    return (uint8_t *)malloc(bytes);
}

void free_buf(void *ptr) {
    free(ptr);
}

/*
 * raw_size()
 *
 * Returns the byte size of the 1bpp output buffer for given w, h.
 * JS calls this to know how many bytes to allocate for raw before calling
 * convert_normal().
 */
int raw_size(int w, int h) {
    return ((w + 7) >> 3) * h;
}
