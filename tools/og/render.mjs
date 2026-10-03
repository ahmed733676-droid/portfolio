import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const htmlPath = path.join(here, "og.html");
const outPath = path.join(repoRoot, "og.png");

const WIDTH = 1200;
const HEIGHT = 630;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readChunks(png) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(sig)) {
    throw new Error("Screenshot is not a PNG");
  }
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    const expected = zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0;
    if (crc !== expected) throw new Error(`Bad CRC on ${type}`);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function decodePng(png) {
  const chunks = readChunks(png);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr) throw new Error("PNG is missing IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG: bitDepth=${bitDepth} interlace=${interlace}`);
  }
  const channels = { 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);

  const idat = Buffer.concat(
    chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
  );
  const inflated = zlib.inflateSync(idat);
  const stride = width * channels;
  const raw = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const row = y * stride;
    const prev = y === 0 ? null : row - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? raw[row + x - channels] : 0;
      const up = prev === null ? 0 : raw[prev + x];
      const upLeft = prev === null || x < channels ? 0 : raw[prev + x - channels];
      const value = inflated[src++];
      let out = value;
      if (filter === 1) out = value + left;
      else if (filter === 2) out = value + up;
      else if (filter === 3) out = value + Math.floor((left + up) / 2);
      else if (filter === 4) out = value + paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      raw[row + x] = out & 255;
    }
  }
  return { width, height, channels, raw };
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodeRgbPng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    rgb.copy(raw, dest + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function toOpaqueRgb(png) {
  const { width, height, channels, raw } = decodePng(png);
  if (width !== WIDTH || height !== HEIGHT) {
    throw new Error(`Expected ${WIDTH}x${HEIGHT}, got ${width}x${height}`);
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dest = i * 3;
    if (channels === 4 && raw[src + 3] !== 255) {
      const alpha = raw[src + 3] / 255;
      const cream = [0xef, 0xe6, 0xd8];
      for (let c = 0; c < 3; c++) {
        rgb[dest + c] = Math.round(raw[src + c] * alpha + cream[c] * (1 - alpha));
      }
    } else {
      rgb[dest] = raw[src];
      rgb[dest + 1] = raw[src + 1];
      rgb[dest + 2] = raw[src + 2];
    }
  }
  return encodeRgbPng(width, height, rgb);
}

function pixel(rgb, x, y) {
  const i = (y * WIDTH + x) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
}

function near(actual, expected, tolerance = 2) {
  return actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});

try {
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  const fonts = await page.evaluate(async () => {
    await document.fonts.load("500 96px Newsreader", "Corniche Studio");
    await document.fonts.load("400 32px Barlow", "Web pages and short video.");
    await document.fonts.load("400 26px Barlow", "ALEXANDRIA");
    await document.fonts.ready;
    const newsreader = document.fonts.check("500 96px Newsreader");
    const barlow = document.fonts.check("400 32px Barlow");
    const faces = [...document.fonts].map((face) => ({
      family: face.family,
      weight: String(face.weight),
      status: face.status,
    }));
    return { newsreader, barlow, faces };
  });

  const newsreaderLoaded = fonts.faces.some(
    (face) => face.family === "Newsreader" && face.weight === "500" && face.status === "loaded",
  );
  const barlowLoaded = fonts.faces.some(
    (face) => face.family === "Barlow" && face.weight === "400" && face.status === "loaded",
  );
  if (!fonts.newsreader || !fonts.barlow || !newsreaderLoaded || !barlowLoaded) {
    throw new Error(`Required fonts did not load: ${JSON.stringify(fonts)}`);
  }

  const shot = await page.screenshot({
    type: "png",
    omitBackground: false,
    animations: "disabled",
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  });
  const rgbPng = toOpaqueRgb(shot);
  const decoded = decodePng(rgbPng);
  if (decoded.channels !== 3) throw new Error("Output PNG is not RGB");
  const cream = pixel(decoded.raw, 600, 50);
  const bar = pixel(decoded.raw, 5, 300);
  if (!near(cream, [0xef, 0xe6, 0xd8]) || !near(bar, [0xd2, 0x3b, 0x2a])) {
    throw new Error(
      `Unexpected colors cream=${cream.join(",")} bar=${bar.join(",")}`,
    );
  }
  fs.writeFileSync(outPath, rgbPng);
  console.log(`Wrote ${outPath} (${rgbPng.length} bytes)`);
} finally {
  await browser.close();
}
