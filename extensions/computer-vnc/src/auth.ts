import { createCipheriv } from 'node:crypto';

/** RFC 6143 §7.2.2: DES challenge response, password truncated/padded to 8 bytes.
 * VNC's DES key bits are reversed within each byte. Repeated-key EDE3 is DES,
 * using Node's supported cipher without enabling OpenSSL's legacy provider. */
export function vncResponse(challenge: Buffer, password: string): Buffer {
  if (challenge.length !== 16 || [...password].some(c => c.codePointAt(0)! > 255)) throw new Error('Unsupported VNC password encoding');
  const key = Buffer.alloc(8);
  const bytes = Buffer.from(password, 'latin1');
  for (let i = 0; i < Math.min(8, bytes.length); i++) {
    let value = bytes[i], reversed = 0;
    for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (value & 1); value >>= 1; }
    key[i] = reversed;
  }
  const triple = Buffer.concat([key, key, key]);
  try {
    const cipher = createCipheriv('des-ede3', triple, null); cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(challenge), cipher.final()]);
  } catch { throw new Error('VNC authentication cipher unavailable'); }
  finally { key.fill(0); bytes.fill(0); triple.fill(0); }
}
