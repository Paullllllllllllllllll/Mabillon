"""Image helpers for reading historical pages, for Mabillon's python tool.

The current page is in the environment variable MABILLON_PAGE (the previous and next
pages in MABILLON_PREVIOUS_PAGE and MABILLON_NEXT_PAGE), and in source/pages.json. Boxes are (x, y, w, h) as
fractions of the page, origin top-left, like the view tool's box; pixel boxes are
(left, top, right, bottom). Images saved with show() appear in the tool result.

Example:
    import pagetools as pt
    img = pt.page()
    pt.show(pt.line_strips(img, (0.05, 0.40, 0.9, 0.15), scale=2.5), "lines")
"""

import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

try:
    import cv2
except ImportError:  # OpenCV is optional; the numpy fallbacks below cover its uses
    cv2 = None

Image.MAX_IMAGE_PIXELS = 200_000_000
SHOW_DIR = Path("scratch/show")


def page_path(which: str = "current") -> str:
    """Path of a page image: which = "current", "previous" or "next"."""
    variable = {
        "current": "MABILLON_PAGE",
        "previous": "MABILLON_PREVIOUS_PAGE",
        "next": "MABILLON_NEXT_PAGE",
    }[which]
    path = os.environ.get(variable)
    listing = Path("source/pages.json")
    if not path and listing.exists():
        path = json.loads(listing.read_text(encoding="utf-8")).get(which)
    if not path:
        raise ValueError(f"no {which} page")
    return path


def page(which: str = "current") -> Image.Image:
    """The page as an RGB image: which = "current", "previous" or "next"."""
    return Image.open(page_path(which)).convert("RGB")


def to_px(img: Image.Image, box) -> tuple[int, int, int, int]:
    """A fractional box (x, y, w, h) as a pixel box (left, top, right, bottom)."""
    x, y, w, h = box
    left = max(0, round(x * img.width))
    top = max(0, round(y * img.height))
    right = min(img.width, round((x + w) * img.width))
    bottom = min(img.height, round((y + h) * img.height))
    return left, top, max(right, left + 1), max(bottom, top + 1)


def crop(img: Image.Image, box=None, px=None) -> Image.Image:
    """Crop by fractional box (x, y, w, h) or by pixel box px=(left, top, right, bottom)."""
    if px is None:
        px = to_px(img, box) if box is not None else (0, 0, img.width, img.height)
    return img.crop(tuple(int(v) for v in px))


def zoom(img: Image.Image, factor: float) -> Image.Image:
    """Resize by factor with Lanczos (enlarging small type helps the eye and the model)."""
    size = (max(1, round(img.width * factor)), max(1, round(img.height * factor)))
    return img.resize(size, Image.Resampling.LANCZOS)


def gray(img: Image.Image) -> np.ndarray:
    """Grayscale as a float array in [0, 255]."""
    return np.asarray(img.convert("L"), dtype=np.float32)


def from_array(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def enhance(
    img: Image.Image,
    autocontrast: float = 1.0,
    gamma: float = 1.0,
    sharpen: bool = False,
    clahe: bool = False,
    flatten: int = 0,
) -> Image.Image:
    """Make faint or uneven text clearer.

    autocontrast: percent of darkest and lightest pixels clipped (0 = off).
    gamma: above 1 darkens mid-tones (faint ink), below 1 lightens them.
    flatten: radius in px of background removal (divides by a blurred copy; about 3x the
    stroke height removes stains and show-through), 0 = off.
    clahe: local contrast equalization (OpenCV only).
    """
    g = gray(img)
    if flatten:
        background = np.asarray(
            from_array(g).filter(ImageFilter.GaussianBlur(flatten)), dtype=np.float32
        )
        g = np.clip(g / np.maximum(background, 1) * 255, 0, 255)
    out = from_array(g)
    if clahe and cv2 is not None:
        out = Image.fromarray(
            cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(np.asarray(out))
        )
    if autocontrast:
        out = ImageOps.autocontrast(out, cutoff=autocontrast)
    if gamma != 1.0:
        lut = [round(255 * (i / 255) ** gamma) for i in range(256)]
        out = out.point(lut)
    if sharpen:
        out = out.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=2))
    return out


def binarize(
    img: Image.Image, method: str = "sauvola", window: int = 41, k: float = 0.2
):
    """Black text on white: method "otsu" (global) or "sauvola" (local, for uneven paper)."""
    g = gray(img)
    if method == "otsu":
        hist = np.bincount(g.astype(np.uint8).ravel(), minlength=256).astype(np.float64)
        total = g.size
        cum = np.cumsum(hist)
        cum_mean = np.cumsum(hist * np.arange(256))
        between = (cum_mean[-1] * cum - cum_mean * total) ** 2 / np.maximum(
            cum * (total - cum), 1
        )
        threshold = int(np.argmax(between))
        return from_array(np.where(g > threshold, 255, 0))
    window += 1 - window % 2
    pad = window // 2
    padded = np.pad(g, pad + 1, mode="edge").astype(np.float64)
    integral = padded.cumsum(0).cumsum(1)
    integral_sq = (padded**2).cumsum(0).cumsum(1)

    def box_sum(table):
        h, w = g.shape
        a = table[window : window + h, window : window + w]
        b = table[0:h, window : window + w]
        c = table[window : window + h, 0:w]
        d = table[0:h, 0:w]
        return a - b - c + d

    n = window * window
    mean = box_sum(integral) / n
    std = np.sqrt(np.maximum(box_sum(integral_sq) / n - mean**2, 0))
    threshold = mean * (1 + k * (std / 128 - 1))
    return from_array(np.where(g > threshold, 255, 0))


def ink(img: Image.Image) -> np.ndarray:
    """Ink mask (True where dark), from an Otsu binarization."""
    return np.asarray(binarize(img, "otsu")) < 128


def text_ink(img: Image.Image) -> np.ndarray:
    """Ink mask without table rules and solid dark areas (scan borders, blots), so that
    projection profiles see letters only."""
    mask = ink(img)
    h, w = mask.shape
    if cv2 is not None:
        m = mask.astype(np.uint8)
        horizontal = cv2.morphologyEx(
            m,
            cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_RECT, (max(40, w // 12), 1)),
        )
        vertical = cv2.morphologyEx(
            m,
            cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(40, h // 12))),
        )
        side = max(15, min(h, w) // 60)
        solid = cv2.morphologyEx(
            m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (side, side))
        )
        solid = cv2.dilate(solid, np.ones((5, 5), np.uint8))
        return mask & ~(
            horizontal.astype(bool) | vertical.astype(bool) | solid.astype(bool)
        )
    mask = mask.copy()
    mask[mask.mean(1) > 0.5, :] = False
    mask[:, mask.mean(0) > 0.5] = False
    return mask


def skew_angle(img: Image.Image, limit: float = 3.0, step: float = 0.1) -> float:
    """Text skew in degrees (rotate by the negative to straighten): the angle whose
    horizontal projection profile is sharpest."""
    small = img if img.width <= 1600 else zoom(img, 1600 / img.width)
    mask = from_array(ink(small) * 255.0)
    best, best_score = 0.0, -1.0
    for angle in np.arange(-limit, limit + step / 2, step):
        rotated = np.asarray(mask.rotate(float(angle), fillcolor=0)) > 0
        profile = rotated.sum(1).astype(np.float64)
        score = float(np.sum(np.diff(profile) ** 2))
        if score > best_score:
            best, best_score = float(angle), score
    return -best


def deskew(img: Image.Image, angle: float | None = None) -> Image.Image:
    """Straighten the text (angle from skew_angle unless given)."""
    if angle is None:
        angle = skew_angle(img)
    return img.rotate(-angle, resample=Image.Resampling.BICUBIC, fillcolor="white")


def _runs(profile: np.ndarray, threshold: float, min_gap: int, min_size: int):
    on = profile > threshold
    runs, start, gap = [], None, 0
    for i, value in enumerate(on):
        if value:
            if start is None:
                start = i
            gap = 0
            end = i
        elif start is not None:
            gap += 1
            if gap > min_gap:
                if end - start + 1 >= min_size:
                    runs.append((start, end + 1))
                start = None
    if start is not None and end - start + 1 >= min_size:
        runs.append((start, end + 1))
    return runs


def _split_tall(runs, profile: np.ndarray):
    """Split runs much taller than the median line (touching lines) at the weakest row."""
    if len(runs) < 3:
        return runs
    height = float(np.median([end - start for start, end in runs]))
    smooth = np.convolve(profile, np.ones(5) / 5, mode="same")
    out, todo = [], list(runs)
    while todo:
        start, end = todo.pop(0)
        if end - start <= 1.6 * height:
            out.append((start, end))
            continue
        lo, hi = start + int(0.6 * height), end - int(0.6 * height)
        cut = lo + int(np.argmin(smooth[lo:hi]))
        todo[:0] = [(start, cut), (cut, end)]
    return out


def find_lines(img: Image.Image, box=None, min_gap: int | None = None, pad: int = 4):
    """Text lines in a region as pixel boxes of the page (left, top, right, bottom),
    from the horizontal projection profile of the ink. Lines that touch merge; split
    them with a smaller box or check the result with show_boxes()."""
    left, top, right, bottom = (
        to_px(img, box) if box is not None else (0, 0, img.width, img.height)
    )
    mask = text_ink(img.crop((left, top, right, bottom)))
    profile = mask.sum(1).astype(np.float64)
    if min_gap is None:
        min_gap = 2
    # Relative to the profile: borders and specks add a constant floor to every row.
    floor, peak = np.percentile(profile, 5), np.percentile(profile, 90)
    threshold = max(2.0, floor + 0.12 * (peak - floor))
    runs = _split_tall(_runs(profile, threshold, min_gap, min_size=6), profile)
    lines = []
    for start, end in runs:
        cols = np.where(mask[start:end].any(0))[0]
        if cols.size == 0:
            continue
        lines.append(
            (
                left + max(0, int(cols[0]) - pad),
                top + max(0, start - pad),
                left + min(right - left, int(cols[-1]) + 1 + pad),
                top + min(bottom - top, end + pad),
            )
        )
    return lines


def find_columns(img: Image.Image, box=None, min_gap: int | None = None):
    """Text columns of a region as pixel boxes, from the vertical projection profile."""
    left, top, right, bottom = (
        to_px(img, box) if box is not None else (0, 0, img.width, img.height)
    )
    mask = text_ink(img.crop((left, top, right, bottom)))
    profile = mask.sum(0).astype(np.float64)
    if min_gap is None:
        min_gap = max(8, (right - left) // 60)
    runs = _runs(
        profile, max(1.0, 0.01 * (bottom - top)), min_gap, min_size=(right - left) // 50
    )
    return [(left + a, top, left + b, bottom) for a, b in runs]


def _font(size: int):
    for name in ("arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def label(img: Image.Image, text: str, height: int = 28) -> Image.Image:
    """The image with a caption bar above it."""
    out = Image.new("RGB", (img.width, img.height + height), "white")
    out.paste(img.convert("RGB"), (0, height))
    ImageDraw.Draw(out).text((4, 2), text, fill=(200, 0, 60), font=_font(height - 8))
    return out


def stack(images, gap: int = 8, vertical: bool = True) -> Image.Image:
    """Images one below the other (or side by side), on white."""
    images = [im.convert("RGB") for im in images]
    if vertical:
        width = max(im.width for im in images)
        height = sum(im.height for im in images) + gap * (len(images) - 1)
    else:
        width = sum(im.width for im in images) + gap * (len(images) - 1)
        height = max(im.height for im in images)
    out = Image.new("RGB", (width, height), "white")
    offset = 0
    for im in images:
        out.paste(im, (0, offset) if vertical else (offset, 0))
        offset += (im.height if vertical else im.width) + gap
    return out


def line_strips(
    img: Image.Image,
    box=None,
    scale: float = 2.0,
    lines=None,
    first: int = 1,
    enhance_args: dict | None = None,
) -> Image.Image:
    """One image of the region's text lines, each enlarged and captioned with its number
    and pixel position, for reading a dense passage line by line. Pass lines (from
    find_lines) to choose them; first numbers the captions."""
    if lines is None:
        lines = find_lines(img, box)
    strips = []
    for number, px in enumerate(lines, start=first):
        strip = img.crop(px)
        if enhance_args:
            strip = enhance(strip, **enhance_args)
        strips.append(label(zoom(strip, scale), f"line {number}  y={px[1]}-{px[3]}"))
    if not strips:
        raise ValueError("no lines found in the region")
    return stack(strips)


def bands(
    img: Image.Image, box=None, n: int = 4, overlap: float = 0.12, scale: float = 1.0
):
    """The region cut into n full-width horizontal bands that overlap by `overlap` of a
    band, top to bottom, for reading a whole page or column systematically. Returns
    the band images (show each, at most four per call)."""
    left, top, right, bottom = (
        to_px(img, box) if box is not None else (0, 0, img.width, img.height)
    )
    step = (bottom - top) / n
    pad = int(step * overlap)
    out = []
    for i in range(n):
        y0 = max(top, int(top + i * step) - pad)
        y1 = min(bottom, int(top + (i + 1) * step) + pad)
        band = zoom(img.crop((left, y0, right, y1)), scale)
        out.append(label(band, f"band {i + 1}/{n}  y={y0}-{y1}"))
    return out


def row_strips(img: Image.Image, columns, rows, scale: float = 3.0) -> Image.Image:
    """Table reading aid: for each row (pixel span (top, bottom)), the cells of the given
    columns (pixel spans (left, right)) side by side, enlarged and captioned with the
    row number, so values can be read row by row without slipping a line."""
    strips = []
    for number, (top, bottom) in enumerate(rows, start=1):
        cells = [
            zoom(img.crop((left, top, right, bottom)), scale) for left, right in columns
        ]
        strips.append(
            label(
                stack(cells, gap=24, vertical=False), f"row {number}  y={top}-{bottom}"
            )
        )
    return stack(strips)


def compare(img: Image.Image, boxes, scale: float = 4.0, labels=None) -> Image.Image:
    """Small regions side by side at the same magnification, to compare letter forms or
    numerals: boxes are fractional (x, y, w, h) or pixel boxes given as dicts {"px": ...}."""
    tiles = []
    for i, box in enumerate(boxes):
        part = crop(img, px=box["px"]) if isinstance(box, dict) else crop(img, box)
        text = labels[i] if labels else str(i + 1)
        tiles.append(label(zoom(part, scale), text))
    return stack(tiles, gap=16, vertical=False)


def show_boxes(
    img: Image.Image, boxes, scale: float = 1.0, width: int = 3
) -> Image.Image:
    """The page (or a crop) with numbered pixel boxes drawn on it, to check find_lines or
    find_columns."""
    out = img.convert("RGB").copy()
    draw = ImageDraw.Draw(out)
    font = _font(max(14, out.height // 120))
    for number, (left, top, right, bottom) in enumerate(boxes, start=1):
        draw.rectangle((left, top, right, bottom), outline=(255, 0, 90), width=width)
        draw.text((left + 2, top + 1), str(number), fill=(255, 0, 90), font=font)
    return zoom(out, scale) if scale != 1 else out


def grid(img: Image.Image, step: int = 200) -> Image.Image:
    """The image with a pixel grid and labels every `step` px."""
    out = img.convert("RGB").copy()
    draw = ImageDraw.Draw(out)
    font = _font(max(12, step // 8))
    for x in range(step, out.width, step):
        draw.line((x, 0, x, out.height), fill=(255, 0, 90), width=1)
        draw.text((x + 2, 2), str(x), fill=(255, 0, 90), font=font)
    for y in range(step, out.height, step):
        draw.line((0, y, out.width, y), fill=(255, 0, 90), width=1)
        draw.text((2, y + 2), str(y), fill=(255, 0, 90), font=font)
    return out


def show(img: Image.Image, name: str = "view") -> Path:
    """Save the image to scratch/show/<name>.png; it appears in the tool result."""
    SHOW_DIR.mkdir(parents=True, exist_ok=True)
    path = SHOW_DIR / f"{name}.png"
    img.save(path)
    print(f"shown: {path} ({img.width}x{img.height} px)")
    return path


def help() -> None:
    """Print the functions of this module with their first docstring line."""
    import inspect

    for name, obj in globals().items():
        if (
            inspect.isfunction(obj)
            and obj.__module__ == __name__
            and not name.startswith("_")
        ):
            doc = (obj.__doc__ or "").strip().splitlines()
            print(f"{name}{inspect.signature(obj)}: {doc[0] if doc else ''}")
