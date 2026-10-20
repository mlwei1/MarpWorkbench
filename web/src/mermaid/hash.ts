/**
 * 同步 SHA-1（UTF-8），用于 `data-mermaid-hash` 与缓存 key。
 *
 * 为什么不用 crypto.subtle：`applyMermaidCacheSync` 是同步 API（画廊缩略图等同步渲染路径），
 * crypto.subtle.digest 是异步的；且 WebCrypto 只在 secure context 可用。自实现一份 ~60 行
 * SHA-1 可让「异步渲染 → 同步复用缓存」使用同一个 hash，行为确定、Node 下也能单测。
 */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  // 补位：0x80 + 0x00… + 64bit 大端长度，总长为 64 的倍数
  const totalLen = (((bytes.length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(totalLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(totalLen - 4, bitLen >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = ((((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('')
}
