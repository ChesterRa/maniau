// 写真・PDF を送る形にする：縮める大きさ、PDF の大きさの上限、読めないファイル、写真でも PDF でもない物。
import { describe, expect, it } from 'vitest';
import { MAX_EDGE, MAX_PDF_BYTES, scaledSize, toUploadable } from '../src/photo';

describe('写真・PDF を送る形にする', () => {
  it('長い辺だけを上限に合わせて縮め、縦横の比を保つ（小さい物は大きくしない）', () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: MAX_EDGE, height: 1932 });
    expect(scaledSize(3024, 4032)).toEqual({ width: 1932, height: MAX_EDGE });
    expect(scaledSize(1200, 900)).toEqual({ width: 1200, height: 900 });
  });

  it('PDF はそのまま送り、大きすぎる物は送らない', async () => {
    const small = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'a.pdf', {
      type: 'application/pdf',
    });
    expect(await toUploadable(small)).toEqual({ mediaType: 'application/pdf', data: 'JVBERg==' });
    const big = new File([new Uint8Array(MAX_PDF_BYTES + 1)], 'b.pdf', { type: 'application/pdf' });
    expect(await toUploadable(big)).toBe('tooLarge');
  });

  it('選べても読めないファイルは、投げずに読めないと返す（写真も PDF も）', async () => {
    for (const [name, type] of [
      ['c.pdf', 'application/pdf'],
      ['d.jpg', 'image/jpeg'],
    ]) {
      const gone = new File([new Uint8Array([0x25])], name, { type });
      Object.defineProperty(gone, 'arrayBuffer', {
        value: () => Promise.reject(new DOMException('gone', 'NotReadableError')),
      });
      expect(await toUploadable(gone)).toBe('unreadable');
    }
  });

  it('写真でも PDF でもない物は送らない', async () => {
    const text = new File(['hello'], 'a.txt', { type: 'text/plain' });
    expect(await toUploadable(text)).toBe('unsupported');
  });
});
