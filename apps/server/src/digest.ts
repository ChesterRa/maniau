// 鍵の順によらない JSON と、その sha256（中身のハッシュ・命令の要約に使う）。要約は中身を含まないが、
// 値の少ない命令（はい・いいえ等）は推し量れるので、敏感な付随情報として扱う（02-foundation §6.1）。
import { createHash } from 'node:crypto';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 鍵を並べ替えた JSON（undefined の欄は無い物として扱う）。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Of = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
