import { crc32, deflateSync } from 'node:zlib';

/** PNG specification: RGBA8 IHDR, filter method 0, zlib IDAT, CRC per chunk. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (!width || !height || rgba.length !== width * height * 4) throw new Error('Invalid framebuffer for PNG');
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row++) rgba.copy(scanlines, row * (width * 4 + 1) + 1, row * width * 4, (row + 1) * width * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
