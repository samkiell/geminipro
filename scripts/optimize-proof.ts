// Resizes and compresses the proof screenshots in assets/proof/ for Telegram:
//
//   pnpm proof:optimize
//
// At most 1280px wide, JPEG, under 1 MB each, at most 10. It never changes what an image shows:
// blur personal details yourself before adding a screenshot (see assets/proof/README.md).

import { readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DIR = fileURLToPath(new URL('../assets/proof', import.meta.url));
const MAX_WIDTH = 1280;
const MAX_BYTES = 1_000_000;
const MAX_FILES = 10;

const print = (line: string) => process.stdout.write(`${line}\n`);
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

const files = (await readdir(DIR)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
if (files.length === 0) print('no images in assets/proof/ yet.');
if (files.length > MAX_FILES) print(`warning: ${files.length} images, but an album holds ${MAX_FILES}. only the first ${MAX_FILES} by name are sent.`);

for (const file of files) {
  const source = join(DIR, file);
  const before = (await stat(source)).size;
  const target = join(DIR, `${file.slice(0, -extname(file).length)}.jpg`);
  const temp = `${target}.tmp`;
  // Lower the quality step by step until it fits; the size never goes above the original.
  let quality = 82;
  let size = Infinity;
  while (quality >= 50) {
    const info = await sharp(source)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toFile(temp);
    size = info.size;
    if (size <= MAX_BYTES) break;
    quality -= 8;
  }
  if (target !== source) await rm(source);
  await rename(temp, target);
  print(`${file} -> ${target.slice(DIR.length + 1)}: ${kb(before)} -> ${kb(size)}${size > MAX_BYTES ? ' (still over 1 MB, crop it)' : ''}`);
}
