import zlib from "node:zlib";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A valid PNG whose pixel at (x, y) is pixel(x, y) -> [r, g, b]. */
export function makePng(width, height, pixel = () => [200, 30, 30]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[y * stride + 1 + x * 3] = r;
      raw[y * stride + 2 + x * 3] = g;
      raw[y * stride + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const pngDataUrl = (png) => `data:image/png;base64,${png.toString("base64")}`;

/** Four solid quadrants: top-left red, top-right blue, bottom-left green, bottom-right yellow. */
export function quadrantPng(width = 240, height = 160) {
  return makePng(width, height, (x, y) => {
    const right = x >= width / 2;
    const bottom = y >= height / 2;
    if (!right && !bottom) return [220, 30, 30];
    if (right && !bottom) return [30, 60, 220];
    if (!right && bottom) return [30, 170, 60];
    return [240, 220, 30];
  });
}
