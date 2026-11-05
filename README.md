# SVG Image Fixer

Some Figma SVG exports lose their images when opened in Illustrator, Sketch and similar tools. The image sits inside a shape through a pattern, and those tools drop it.

This repo has two ways to fix an export. Both write a new copy and leave the original alone.

## Browser tool (for designers)

Open `index.html` in Chrome or Safari, choose one or more SVG files, and download the fixed copy. Nothing is installed and nothing is uploaded; the file is processed in the browser.

## Command line (for developers)

```bash
python3 fix_figma_svg.py path/to/export.svg
```

This writes `export-fixed.svg` next to the original. Requires Python 3 only.

## What is covered

- Rectangles and paths filled with an image pattern, with any offset and scale.
- Shapes with a stroke keep the outline.

## What is not covered

- Ellipses, grouped masks and rotated or flipped images. Those are left as they were and listed in the results.
- Figma files whose image fills use some other structure. Check the result in Illustrator before relying on it.
