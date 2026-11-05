const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

// 2D affine matrices as [a, b, c, d, e, f]
function mul(M, N) {
  return [
    M[0] * N[0] + M[2] * N[1],
    M[1] * N[0] + M[3] * N[1],
    M[0] * N[2] + M[2] * N[3],
    M[1] * N[2] + M[3] * N[3],
    M[0] * N[4] + M[2] * N[5] + M[4],
    M[1] * N[4] + M[3] * N[5] + M[5]
  ];
}

function parseTransform(s) {
  let M = [1, 0, 0, 1, 0, 0];
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(s || ""))) {
    const v = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let N;
    if (m[1] === "translate") N = [1, 0, 0, 1, v[0], v[1] || 0];
    else if (m[1] === "scale") N = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0];
    else if (m[1] === "matrix") N = v;
    else throw new Error("transform '" + m[1] + "' is not supported");
    M = mul(M, N);
  }
  return M;
}

// Bounding box [x, y, width, height] of a path made of M, L, H, V, C and Z
function pathBBox(d) {
  const t = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) || [];
  let i = 0, cmd = null, cur = [0, 0], start = [0, 0];
  const pts = [];
  const num = () => {
    if (i >= t.length) throw new Error("path data is incomplete");
    return parseFloat(t[i++]);
  };
  while (i < t.length) {
    if (/^[A-Za-z]$/.test(t[i])) {
      cmd = t[i++];
      if (cmd === "Z") { cur = start.slice(); continue; }
    }
    if (cmd === "M") { cur = [num(), num()]; start = cur; pts.push(cur); cmd = "L"; }
    else if (cmd === "L") { cur = [num(), num()]; pts.push(cur); }
    else if (cmd === "H") { cur = [num(), cur[1]]; pts.push(cur); }
    else if (cmd === "V") { cur = [cur[0], num()]; pts.push(cur); }
    else if (cmd === "C") {
      const p1 = [num(), num()], p2 = [num(), num()], p3 = [num(), num()], p0 = cur;
      for (let k = 1; k <= 100; k++) {
        const s = k / 100, u = 1 - s;
        pts.push([
          u * u * u * p0[0] + 3 * u * u * s * p1[0] + 3 * u * s * s * p2[0] + s * s * s * p3[0],
          u * u * u * p0[1] + 3 * u * u * s * p1[1] + 3 * u * s * s * p2[1] + s * s * s * p3[1]
        ]);
      }
      cur = p3;
    }
    else throw new Error("path command '" + cmd + "' is not supported");
  }
  if (!pts.length) throw new Error("path has no points");
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}

const round = v => Number(v.toFixed(4));

function convertSvg(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("this file is not valid SVG");
  const svg = doc.documentElement;
  if (svg.localName !== "svg") throw new Error("this file is not an SVG drawing");

  // Pattern id -> { element, image id, transform }
  const patterns = new Map();
  for (const p of svg.querySelectorAll("pattern")) {
    const use = p.querySelector("use");
    if (!use) continue;
    const href = use.getAttributeNS(XLINK, "href") || use.getAttribute("href") || "";
    patterns.set(p.getAttribute("id"), {
      element: p,
      imageId: href.replace(/^#/, ""),
      transform: use.getAttribute("transform") || ""
    });
  }

  const images = new Map();
  for (const im of svg.querySelectorAll("image")) {
    if (im.getAttribute("id")) images.set(im.getAttribute("id"), im);
  }

  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = doc.createElementNS(SVG_NS, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  // A mask made of one opaque shape becomes a clip path. Illustrator turns a mask into a
  // transparency mask based on colour, which greys out whatever it covers.
  let maskN = 0;
  const maskIds = [];
  for (const mk of Array.from(svg.querySelectorAll("mask"))) {
    const kids = Array.from(mk.children);
    if (kids.length !== 1 || (kids[0].localName !== "path" && kids[0].localName !== "rect")) continue;
    const child = kids[0];
    const id = mk.getAttribute("id");
    const fill = (child.getAttribute("fill") || "").toLowerCase();
    const alphaMask = /mask-type\s*:\s*alpha/.test(mk.getAttribute("style") || "");
    const whiteFill = fill === "white" || fill === "#fff" || fill === "#ffffff";
    if (!id || fill === "none" || !(alphaMask || whiteFill)) continue;
    if (child.hasAttribute("opacity") || child.hasAttribute("fill-opacity") || child.hasAttribute("style")) continue;
    const users = Array.from(svg.querySelectorAll("[mask]")).filter(e => e.getAttribute("mask") === "url(#" + id + ")");
    if (!users.length || users.some(e => e.hasAttribute("clip-path"))) continue;
    const clipId = "fix-mask-" + (++maskN);
    const clip = doc.createElementNS(SVG_NS, "clipPath");
    clip.setAttribute("id", clipId);
    const shape = child.cloneNode(false);
    for (const attr of ["id", "fill", "stroke", "opacity", "fill-opacity"]) shape.removeAttribute(attr);
    clip.appendChild(shape);
    defs.appendChild(clip);
    for (const e of users) {
      e.removeAttribute("mask");
      e.setAttribute("clip-path", "url(#" + clipId + ")");
    }
    maskIds.push(id);
  }

  let converted = 0;
  const skipped = [];
  let n = 0;

  for (const shape of Array.from(svg.querySelectorAll("path, rect"))) {
    const fill = shape.getAttribute("fill") || "";
    const m = fill.match(/^url\(#(.+)\)$/);
    if (!m) continue;
    const pat = patterns.get(m[1]);
    if (!pat) continue; // a gradient or other fill, not an image pattern

    const label = shape.getAttribute("id") || (shape.localName + " " + (converted + skipped.length + 1));
    try {
      const img = images.get(pat.imageId);
      if (!img) throw new Error("the image it uses is missing from the file");
      if (shape.hasAttribute("clip-path") || shape.hasAttribute("mask") || shape.hasAttribute("filter")) {
        throw new Error("the shape already has a clip, mask or filter");
      }

      const [a, b, c, d, e, f] = parseTransform(pat.transform);
      if (b || c || a <= 0 || d <= 0) throw new Error("rotated, skewed or flipped images are not supported");
      const imgW = parseFloat(img.getAttribute("width"));
      const imgH = parseFloat(img.getAttribute("height"));
      if (!imgW || !imgH) throw new Error("the image has no width or height");

      let x0, y0, w, h;
      if (shape.localName === "rect") {
        x0 = parseFloat(shape.getAttribute("x") || 0);
        y0 = parseFloat(shape.getAttribute("y") || 0);
        w = parseFloat(shape.getAttribute("width"));
        h = parseFloat(shape.getAttribute("height"));
      } else {
        [x0, y0, w, h] = pathBBox(shape.getAttribute("d") || "");
      }

      // Pattern content is measured in the shape's bounding box unless the pattern says otherwise
      const inUserUnits = pat.element.getAttribute("patternContentUnits") === "userSpaceOnUse";
      const left = inUserUnits ? e : x0 + e * w;
      const top = inUserUnits ? f : y0 + f * h;
      const width = inUserUnits ? a * imgW : a * imgW * w;
      const height = inUserUnits ? d * imgH : d * imgH * h;

      const clipId = "fix-clip-" + (++n);
      const clip = doc.createElementNS(SVG_NS, "clipPath");
      clip.setAttribute("id", clipId);
      const clipShape = shape.cloneNode(false);
      for (const attr of ["id", "fill", "stroke", "opacity", "transform", "style"]) clipShape.removeAttribute(attr);
      clip.appendChild(clipShape);
      defs.appendChild(clip);

      // Wrapper keeps the shape's own transform and opacity
      const wrapper = doc.createElementNS(SVG_NS, "g");
      for (const attr of ["transform", "opacity"]) {
        if (shape.hasAttribute(attr)) wrapper.setAttribute(attr, shape.getAttribute(attr));
      }

      const clipped = doc.createElementNS(SVG_NS, "g");
      clipped.setAttribute("clip-path", "url(#" + clipId + ")");
      const image = doc.createElementNS(SVG_NS, "image");
      image.setAttribute("x", round(left));
      image.setAttribute("y", round(top));
      image.setAttribute("width", round(width));
      image.setAttribute("height", round(height));
      image.setAttribute("preserveAspectRatio", "none");
      image.setAttributeNS(XLINK, "xlink:href", img.getAttributeNS(XLINK, "href") || img.getAttribute("href"));
      clipped.appendChild(image);
      wrapper.appendChild(clipped);

      // Keep an outline if the shape had a stroke
      const stroke = shape.getAttribute("stroke");
      if (stroke && stroke !== "none") {
        const outline = shape.cloneNode(false);
        for (const attr of ["id", "fill", "clip-path", "transform", "opacity"]) outline.removeAttribute(attr);
        outline.setAttribute("fill", "none");
        wrapper.appendChild(outline);
      }

      shape.parentNode.replaceChild(wrapper, shape);
      converted++;
    } catch (err) {
      skipped.push({ label, reason: err.message });
    }
  }

  if (converted === 0) {
    return { text: null, converted: 0, skipped };
  }

  // Remove patterns and images that nothing uses any more
  const usesId = (id, skipEl) => {
    const re = new RegExp("#" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])");
    for (const el of svg.querySelectorAll("*")) {
      if (skipEl && (el === skipEl || skipEl.contains(el))) continue;
      for (const attr of el.attributes) if (re.test(attr.value)) return true;
    }
    return false;
  };
  for (const [pid, pat] of patterns) {
    if (!usesId(pid, pat.element)) {
      pat.element.parentNode.removeChild(pat.element);
      if (pat.imageId && images.has(pat.imageId) && !usesId(pat.imageId, null)) {
        const im = images.get(pat.imageId);
        im.parentNode.removeChild(im);
      }
    }
  }
  // Remove masks that were converted and nothing uses any more
  for (const mk of Array.from(svg.querySelectorAll("mask"))) {
    const id = mk.getAttribute("id");
    if (id && maskIds.includes(id) && !usesId(id, mk)) mk.parentNode.removeChild(mk);
  }
  if (!defs.childNodes.length) defs.parentNode.removeChild(defs);

  const outText = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
  if (new DOMParser().parseFromString(outText, "image/svg+xml").getElementsByTagName("parsererror").length) {
    throw new Error("the converted file did not validate");
  }
  return { text: outText, converted, skipped };
}

// ---- page ----
const drop = document.getElementById("drop");
const input = document.getElementById("file");
const results = document.getElementById("results");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ZIP writer (stored, no compression), so all fixed files download as one archive
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const used = new Set();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    let name = f.name;
    for (let i = 2; used.has(name); i++) name = f.name.replace(/\.svg$/i, "") + " (" + i + ").svg";
    used.add(name);
    const nameBytes = enc.encode(name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, f.bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

const fixedFiles = [];
const zipBtn = document.getElementById("zip-all");
const batchStatus = document.getElementById("batch-status");
let pending = 0;

function updateToolbar() {
  const count = results.children.length;
  zipBtn.hidden = fixedFiles.length === 0;
  zipBtn.textContent = "Download all " + fixedFiles.length + " fixed file" + (fixedFiles.length === 1 ? "" : "s") + " (ZIP)";
  batchStatus.textContent = pending
    ? "Fixing " + pending + " file" + (pending === 1 ? "" : "s") + "…"
    : (count ? count + " file" + (count === 1 ? "" : "s") + " processed" : "");
}

async function handleFiles(files) {
  const all = Array.from(files);
  const svgs = all.filter(f => /\.svg$/i.test(f.name) || f.type === "image/svg+xml");
  if (all.length - svgs.length) {
    const note = el("article", "item");
    note.appendChild(el("p", "status none", (all.length - svgs.length) + " file" + (all.length - svgs.length === 1 ? " was" : "s were") + " skipped because " + (all.length - svgs.length === 1 ? "it is" : "they are") + " not SVG."));
    results.appendChild(note);
  }
  pending += svgs.length;
  updateToolbar();
  for (const file of svgs) {
    const card = el("article", "item");
    card.appendChild(el("div", "item-name", file.name));
    results.appendChild(card);
    try {
      const out = convertSvg(await file.text());
      if (out.converted === 0) {
        card.appendChild(el("p", "status none", "No image fills to fix. The file is unchanged."));
      } else {
        const name = file.name.replace(/\.svg$/i, "") + "-fixed.svg";
        const bytes = new TextEncoder().encode(out.text);
        fixedFiles.push({ name, bytes });
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
        card.appendChild(el("p", "status ok", "Fixed " + out.converted + " image" + (out.converted === 1 ? "" : "s") + "."));
        const link = el("a", "btn", "Download fixed SVG");
        link.href = url;
        link.download = name;
        card.appendChild(link);
      }
      if (out.skipped.length) {
        const det = el("details");
        det.appendChild(el("summary", null, out.skipped.length + " shape" + (out.skipped.length === 1 ? "" : "s") + " left as they were"));
        const ul = el("ul");
        for (const s of out.skipped) ul.appendChild(el("li", null, s.label + ": " + s.reason));
        det.appendChild(ul);
        card.appendChild(det);
      }
    } catch (err) {
      card.appendChild(el("p", "status bad", "Could not fix this file: " + err.message));
    } finally {
      pending--;
      updateToolbar();
    }
  }
  input.value = "";
  updateToolbar();
}

zipBtn.addEventListener("click", () => {
  const url = URL.createObjectURL(makeZip(fixedFiles));
  const a = document.createElement("a");
  a.href = url;
  a.download = "svg-fixed-" + new Date().toISOString().slice(0, 10) + ".zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

input.addEventListener("change", () => handleFiles(input.files));
drop.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
});
// Dropping anywhere on the page sends the files to the tool, and stops the browser opening them
drop.addEventListener("dragenter", () => drop.classList.add("over"));
drop.addEventListener("dragover", () => drop.classList.add("over"));
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
updateToolbar();
