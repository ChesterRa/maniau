// お知らせの写真・PDF を、書き起こしに送る形にする。写真は長い辺を MAX_EDGE までに縮めて JPEG にし（小さい字を
// 残しつつ、送る量を抑える）、PDF はそのまま送る。写真は端末の中で縮め、このアプリのサーバーへ一度だけ送る。
// サーバーは残さず、Anthropic へ、入力の量の見積もりと書き起こしのために送る。
export const MAX_EDGE = 2576;
export const MAX_PDF_BYTES = 4 * 1024 * 1024;

export type Uploadable = { mediaType: 'image/jpeg' | 'application/pdf'; data: string };
export type NotUploadable = 'tooLarge' | 'unsupported' | 'unreadable';

/** 長い辺を max までに縮めた大きさ（大きくはしない）。 */
export function scaledSize(width: number, height: number, max = MAX_EDGE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** 送る形にする。失敗しても投げずに理由を返す（画面が準備の途中で止まらないように）。 */
export async function toUploadable(file: File): Promise<Uploadable | NotUploadable> {
  const pdf = file.type === 'application/pdf';
  if (!pdf && !file.type.startsWith('image/')) return 'unsupported';
  if (pdf && file.size > MAX_PDF_BYTES) return 'tooLarge';
  // 選べても読めないファイルがある（端末に無く、雲の上にだけある物など）。先に一度だけ読み、形式の誤りと分ける。
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return 'unreadable';
  }
  if (pdf) return { mediaType: 'application/pdf', data: base64Of(bytes) };
  try {
    const jpeg = await shrunkJpeg(new Blob([bytes], { type: file.type }));
    return jpeg ? { mediaType: 'image/jpeg', data: base64Of(jpeg) } : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/** 端末で開けない形式（開けない・描けない）なら undefined か、例外。 */
async function shrunkJpeg(source: Blob): Promise<Uint8Array | undefined> {
  // img で開く（写真の向きの情報に従って回る）。
  const url = URL.createObjectURL(source);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('写真を開けない'));
      img.src = url;
    });
    const { width, height } = scaledSize(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
