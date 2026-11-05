"""
Fix Figma SVG exports where an image is used as a fill through a <pattern>.

Some programs (e.g. Adobe Illustrator) drop the image in that form. This
rewrites each such fill as a clip path around a plain <image>, which all
common SVG readers handle.

Usage:  python3 fix_figma_svg.py input.svg [output.svg]
Default output: input-fixed.svg (the original is never modified).
"""
import re
import sys
import os
from xml.etree import ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"
XLINK = "http://www.w3.org/1999/xlink"


def _mul(M, N):
    """Multiply two 2D affine matrices given as (a, b, c, d, e, f)."""
    return (
        M[0] * N[0] + M[2] * N[1],
        M[1] * N[0] + M[3] * N[1],
        M[0] * N[2] + M[2] * N[3],
        M[1] * N[2] + M[3] * N[3],
        M[0] * N[4] + M[2] * N[5] + M[4],
        M[1] * N[4] + M[3] * N[5] + M[5],
    )


def parse_transform(s):
    """Return the affine matrix (a, b, c, d, e, f) for a transform list.

    Supports translate, scale and matrix, in the order they are written.
    """
    M = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s or ""):
        v = [float(x) for x in re.split(r"[ ,]+", args.strip()) if x]
        if name == "translate":
            N = (1.0, 0.0, 0.0, 1.0, v[0], v[1] if len(v) > 1 else 0.0)
        elif name == "scale":
            N = (v[0], 0.0, 0.0, v[1] if len(v) > 1 else v[0], 0.0, 0.0)
        elif name == "matrix":
            N = tuple(v)
        else:
            raise ValueError(f"unsupported transform: {name}")
        M = _mul(M, N)
    return M


def path_bbox(d):
    tokens = re.findall(r"[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?", d)
    pts, cur, i, cmd = [], (0.0, 0.0), 0, None

    def num():
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    while i < len(tokens):
        if tokens[i] in ("M", "L", "C", "Z"):
            cmd = tokens[i]
            i += 1
            if cmd == "Z":
                continue
        if cmd in ("M", "L"):
            cur = (num(), num())
            pts.append(cur)
        elif cmd == "C":
            p1 = (num(), num())
            p2 = (num(), num())
            p3 = (num(), num())
            p0 = cur
            for k in range(1, 101):
                t = k / 100
                mt = 1 - t
                pts.append((
                    mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0],
                    mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1],
                ))
            cur = p3
        else:
            raise ValueError("unsupported path command in shape")
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def get_attr(tag, name):
    m = re.search(r'\s' + re.escape(name) + r'="([^"]*)"', tag)
    return m.group(1) if m else None


def convert_masks(text):
    """Turn masks made of one opaque shape into clip paths.

    Illustrator turns a mask into a transparency mask based on colour, which
    greys out whatever it covers. A clip path of the same shape keeps the
    content in full colour. Returns (text, clip_defs, converted_mask_ids).
    """
    clip_defs, done = [], []
    for mm in list(re.finditer(r"<mask\b([^>]*)>\s*<(path|rect)\b([^>]*?)/>\s*</mask>", text, re.S)):
        mask_attrs, shape_tag, shape_attrs = mm.group(1), mm.group(2), mm.group(3)
        mid = get_attr("<mask" + mask_attrs, "id")
        if not mid:
            continue
        fill = (get_attr("<x" + shape_attrs, "fill") or "").lower()
        style = (get_attr("<mask" + mask_attrs, "style") or "").replace(" ", "")
        alpha = "mask-type:alpha" in style
        white = fill in ("white", "#fff", "#ffffff")
        if fill == "none" or not (alpha or white):
            continue
        if re.search(r"\s(opacity|fill-opacity|style)=", shape_attrs):
            continue
        users = re.findall(r"<[^>]*\smask=\"url\(#" + re.escape(mid) + r"\)\"[^>]*>", text)
        if not users or any("clip-path=" in u for u in users):
            continue
        cid = "fix-mask-" + re.sub(r"[^A-Za-z0-9_-]", "_", mid)
        keep = re.sub(r"\s(id|fill|stroke|opacity|fill-opacity)=\"[^\"]*\"", "", shape_attrs)
        clip_defs.append(f'<clipPath id="{cid}"><{shape_tag}{keep}/></clipPath>')
        text = re.sub(r"(<[^>]*?)\smask=\"url\(#" + re.escape(mid) + r"\)\"",
                      lambda k: k.group(1) + f' clip-path="url(#{cid})"', text)
        done.append(mid)
    return text, clip_defs, done


def convert(text):
    text, mask_clips, mask_ids = convert_masks(text)
    # 1. Map pattern id -> (use href id, use transform) and image id -> (w, h, href)
    patterns = {}
    for pm in re.finditer(r"<pattern\b[^>]*>(.*?)</pattern>", text, re.S):
        ptag = pm.group(0)
        pid = get_attr(ptag, "id")
        use = re.search(r"<use\b[^>]*/>", pm.group(1))
        if not use:
            continue
        href = get_attr(use.group(0), "xlink:href") or get_attr(use.group(0), "href")
        tr = get_attr(use.group(0), "transform")
        if href and href.startswith("#"):
            patterns[pid] = (href[1:], tr)

    images = {}
    for im in re.finditer(r"<image\b[^>]*/>", text):
        tag = im.group(0)
        iid = get_attr(tag, "id")
        if iid:
            images[iid] = (
                float(get_attr(tag, "width")),
                float(get_attr(tag, "height")),
                get_attr(tag, "xlink:href") or get_attr(tag, "href"),
            )

    converted = 0
    clips = []

    def replace_shape(m):
        nonlocal converted
        tag = m.group(0)
        fill = get_attr(tag, "fill")
        fm = re.match(r"url\(#([^)]+)\)$", fill or "")
        if not fm or fm.group(1) not in patterns:
            return tag
        pid = fm.group(1)
        image_id, use_tr = patterns[pid]
        if image_id not in images:
            return tag
        img_w, img_h, href = images[image_id]
        a, b, c, d, tx, ty = parse_transform(use_tr)
        if b or c or a <= 0 or d <= 0:
            raise ValueError("rotated, skewed or flipped images are not supported")
        sx, sy = a, d

        if tag.startswith("<path"):
            d = get_attr(tag, "d")
            x0, y0, w, h = path_bbox(d)
            shape_svg = f'<path d="{d}"/>'
        elif tag.startswith("<rect"):
            x0 = float(get_attr(tag, "x") or 0)
            y0 = float(get_attr(tag, "y") or 0)
            w = float(get_attr(tag, "width"))
            h = float(get_attr(tag, "height"))
            shape_svg = f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}"/>'
        else:
            return tag

        ix = x0 + tx * w
        iy = y0 + ty * h
        iw = img_w * sx * w
        ih = img_h * sy * h
        cid = f"clip{len(clips)}"
        clips.append(f'<clipPath id="{cid}">{shape_svg}</clipPath>')
        converted += 1
        return (
            f'<g clip-path="url(#{cid})">'
            f'<image x="{ix:.4f}" y="{iy:.4f}" width="{iw:.4f}" height="{ih:.4f}" '
            f'preserveAspectRatio="none" xlink:href="{href}"/></g>'
        )

    body = re.sub(r"<(?:path|rect)\b[^>]*/>", replace_shape, text)

    if converted == 0:
        raise SystemExit("No image-pattern fills found; nothing to change.")

    # Remove each pattern and image only if nothing else still uses it.
    # Other <defs> (e.g. a clip path used by an outer group) are left alone.
    for pid, (image_id, _) in patterns.items():
        if not re.search(r"url\(#" + re.escape(pid) + r"\)", body):
            body = re.sub(r"<pattern\b[^>]*id=\"" + re.escape(pid) + r"\".*?</pattern>", "", body, flags=re.S)
            if not re.search(r"#" + re.escape(image_id) + r"\b", body):
                body = re.sub(r"<image\b[^>]*id=\"" + re.escape(image_id) + r"\"[^>]*/>", "", body)
    body = re.sub(r"<defs>\s*</defs>", "", body)

    # Remove converted masks that nothing uses any more
    for mid in mask_ids:
        if not re.search(r"url\(#" + re.escape(mid) + r"\)", body):
            body = re.sub(r"<mask\b[^>]*id=\"" + re.escape(mid) + r"\"[^>]*>.*?</mask>", "", body, flags=re.S)

    # Add our clip paths in a new <defs> right after the opening <svg> tag
    defs = "<defs>" + "".join(clips + mask_clips) + "</defs>"
    body = re.sub(r"(<svg\b[^>]*>)", lambda m: m.group(1) + defs, body, count=1)
    return body, converted


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0] + "-fixed.svg"
    text = open(src, encoding="utf-8").read()
    fixed, n = convert(text)
    ET.fromstring(fixed.encode("utf-8"))  # confirm the result is valid XML
    open(out, "w", encoding="utf-8").write(fixed)
    print(f"converted {n} image fill(s) -> {out}")


if __name__ == "__main__":
    main()
