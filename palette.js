/* palette.js — pull a visualizer theme out of a track's COVER ART.

   WHY THIS EXISTS
   All four engines are the app's look, not the user's. Nobody posts their own single
   branded as somebody else's world, and the cheapest way to fix that is not a fifth
   engine -- it is the palette, because the palette multiplies across all four at once.
   tools/analyze_images.py already proved the extraction offline; this is that idea made
   to run in the browser, on the artwork the user is actually going to post with.

   PURE FUNCTION OF PIXELS. No DOM, no canvas, no Image. Takes RGBA bytes and returns a
   theme, so the same code that eva.html feeds a canvas from can be driven in Node against
   images whose answer is known by construction. Classic script (assigns self.CoverPalette),
   not an ES module, so a <script> tag and Node's eval both work with no build step --
   same shape as analysis.js.

   THE HARD PART IS NOT QUANTISATION, IT IS SELECTION.
   Cover art is mostly dark backgrounds, neutrals and skin. "The two most common colours"
   returns muddy browns, and a muddy theme does not read as "matches my cover", it reads
   as broken. So pixels are weighted by CHROMA, not by coverage: a small vivid mark counts
   for more than a large dead grey, and near-black and near-white -- which have no hue to
   contribute -- fall out on their own rather than needing a special case.

   AND THE OUTPUT HAS TO LAND WHERE THE SHADERS EXPECT.
   Measured across the five built-in themes: every c1 has a max component of exactly 1.00,
   saturation >= 0.65 and luma 0.40..0.845; every c2 is deep, luma 0.133..0.349 and
   saturation >= 0.87. Those are not stylistic preferences, they are the input range the
   engines were tuned against -- brightness is the recurring failure mode in this repo and
   the nebula in particular multiplies per-element brightness by its overlap count. A pale
   cover handed through raw would white the frame out. So the extracted HUE is kept and
   everything else is re-shaped into those bands.
*/
(function (root) {
  'use strict';

  var HUE_BINS   = 36;     // 10 degrees each
  var MIN_V      = 0.06;   // discard near-black: no hue to contribute
  var MIN_CHROMA = 0.05;   // discard neutrals for the same reason
  var MIN_SEP    = 60;     // degrees c2 must sit from c1 -- the engines carry their
                           // contrast in c1-vs-c2, so two near-identical hues read as
                           // a one-colour theme, which is worse than the built-ins
  var SYNTH_SEP  = 150;    // near-complement, when the artwork really is one hue
  // measured from the built-in THEMES; see the header
  var C1 = { lo: 0.40, hi: 0.845, minSat: 0.65 };
  var C2 = { lo: 0.133, hi: 0.349, minSat: 0.85 };

  function luma(c){ return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]; }

  function hsv2rgb(h, s, v){
    h = ((h % 360) + 360) % 360;
    var c = v*s, x = c*(1 - Math.abs(((h/60) % 2) - 1)), m = v - c, r, g, b;
    if      (h <  60){ r=c; g=x; b=0; }
    else if (h < 120){ r=x; g=c; b=0; }
    else if (h < 180){ r=0; g=c; b=x; }
    else if (h < 240){ r=0; g=x; b=c; }
    else if (h < 300){ r=x; g=0; b=c; }
    else             { r=c; g=0; b=x; }
    return [r+m, g+m, b+m];
  }

  // Re-shape a hue into the band the shaders were tuned against. Scaling DOWN is enough
  // for bright hues; a dark hue (blue's luma at full saturation is 0.072) cannot be
  // scaled up without exceeding 1.0, so it is lifted toward white instead -- bounded by
  // the saturation floor, which is exactly what Pattern Blue does by hand.
  function shape(hue, band){
    var rgb = hsv2rgb(hue, 1, 1), L = luma(rgb), i;
    if (L > band.hi){
      var k = band.hi / L;
      for (i=0;i<3;i++) rgb[i] *= k;
    } else if (L < band.lo){
      var t = Math.min((band.lo - L) / (1 - L), 1 - band.minSat);
      for (i=0;i<3;i++) rgb[i] = rgb[i]*(1-t) + t;
    }
    for (i=0;i<3;i++) rgb[i] = Math.max(0, Math.min(1, rgb[i]));
    return rgb;
  }

  function hex(c){
    var s = '#', i, v;
    for (i=0;i<3;i++){
      v = Math.max(0, Math.min(255, Math.round(c[i]*255))).toString(16);
      s += v.length < 2 ? '0'+v : v;
    }
    return s;
  }

  function circDist(a, b){
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* extract(rgba, w, h, [opts]) -> theme | null
     rgba: Uint8ClampedArray/Uint8Array/Array of RGBA bytes, length >= w*h*4.
     Returns { c1, c2, hud, info } or null when the artwork carries no usable colour
     (a pure greyscale sleeve genuinely has no palette -- say so rather than invent one). */
  function extract(rgba, w, h, opts){
    opts = opts || {};
    if (!rgba || !w || !h) return null;
    // cap the work at ~40k samples: a 3000x3000 sleeve is 9M pixels and the answer does
    // not improve past a few tens of thousands
    var want = opts.samples || 40000;
    var step = Math.max(1, Math.floor(Math.sqrt((w*h) / want)));

    var wt = new Float64Array(HUE_BINS);   // chroma-weighted hue histogram
    var hx = new Float64Array(HUE_BINS);   // circular mean accumulators, so the winning
    var hy = new Float64Array(HUE_BINS);   // hue is not quantised to the bin centre
    var total = 0, counted = 0, seen = 0;

    for (var y=0; y<h; y+=step){
      for (var x=0; x<w; x+=step){
        var i = (y*w + x)*4;
        var a = rgba[i+3] / 255;
        if (a <= 0.02) continue;           // transparent pixels are not artwork
        seen++;
        var r = rgba[i]/255, g = rgba[i+1]/255, b = rgba[i+2]/255;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b), ch = mx - mn;
        if (mx < MIN_V || ch < MIN_CHROMA) continue;

        var hu;
        if (mx === r)      hu = 60*(((g-b)/ch) % 6);
        else if (mx === g) hu = 60*(((b-r)/ch) + 2);
        else               hu = 60*(((r-g)/ch) + 4);
        if (hu < 0) hu += 360;

        // CHROMA, not coverage. This is the whole selection rule: a vivid mark outvotes
        // a large dead grey, and the dark/pale majority of a sleeve drops out on its own.
        var weight = ch * a;
        var bin = Math.floor(hu/10) % HUE_BINS;
        wt[bin] += weight;
        var rad = hu * Math.PI/180;
        hx[bin] += Math.cos(rad)*weight;
        hy[bin] += Math.sin(rad)*weight;
        total += weight; counted++;
      }
    }
    if (!seen || total <= 0) return null;
    // A sleeve that is genuinely greyscale has no palette to take. Inventing one would be
    // worse than leaving the user's chosen theme alone, so this is an honest null.
    // The threshold is deliberately LOW. A truly greyscale image scores 0 here, not 1%,
    // so there is no need to sit near the top of the range -- and a dark sleeve with one
    // small colour accent is a common design that a 2% gate rejected outright. That is
    // the same case the chroma weighting above exists to catch, so a coverage gate must
    // not throw it away before the weighting ever gets to see it.
    if (counted / seen < (opts.minColoured || 0.004)) return null;

    // Smooth circularly before picking. A strong colour routinely straddles a bin edge,
    // and un-smoothed the winner is then decided by which side of 10 degrees it fell on.
    var sm = new Float64Array(HUE_BINS), j;
    for (j=0;j<HUE_BINS;j++){
      sm[j] = wt[(j-1+HUE_BINS)%HUE_BINS]*0.25 + wt[j]*0.5 + wt[(j+1)%HUE_BINS]*0.25;
    }
    var binHue = function(k){
      var m = Math.atan2(hy[k], hx[k]) * 180/Math.PI;
      return wt[k] > 0 ? ((m % 360) + 360) % 360 : k*10 + 5;
    };

    var i1 = 0;
    for (j=1;j<HUE_BINS;j++) if (sm[j] > sm[i1]) i1 = j;
    var h1 = binHue(i1);

    // c2 is the strongest hue far enough from c1 to actually read as contrast.
    var i2 = -1;
    for (j=0;j<HUE_BINS;j++){
      if (circDist(binHue(j), h1) < MIN_SEP) continue;
      if (i2 < 0 || sm[j] > sm[i2]) i2 = j;
    }
    // A monochrome sleeve is a real and common case (one duotone, one wash of colour).
    // Rather than return a one-colour theme -- which every engine would render flat,
    // since they all carry their structure in the c1/c2 split -- synthesise the second
    // hue near c1's complement, which is what every built-in theme does by hand.
    var synth = i2 < 0 || sm[i2] < sm[i1]*(opts.minSecond || 0.06);
    var h2 = synth ? h1 + SYNTH_SEP : binHue(i2);

    var c1 = shape(h1, C1), c2 = shape(h2, C2);
    return {
      c1: c1, c2: c2, hud: hex(c1),
      info: {
        hue1: Math.round(((h1 % 360) + 360) % 360),
        hue2: Math.round(((h2 % 360) + 360) % 360),   // h2 may be h1+150 and overrun 360
        sep: Math.round(circDist(h1, h2)),
        synthesised: synth,
        coloured: +(counted/seen).toFixed(4),   // fraction of samples carrying any hue
        luma1: +luma(c1).toFixed(3), luma2: +luma(c2).toFixed(3)
      }
    };
  }

  root.CoverPalette = { extract: extract, shape: shape, hsv2rgb: hsv2rgb, luma: luma,
                        hex: hex, BANDS: { c1: C1, c2: C2 } };
})(typeof self !== 'undefined' ? self : this);
