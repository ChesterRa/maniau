// 今の時刻を、家庭の時区の分の精度の時刻にする（命令と見せる物の now）。
import { type DateTime, formatDateTime } from '@maniau/core';

export const nowIn = (timeZone: string, ms: number = Date.now()): DateTime =>
  formatDateTime(Math.floor(ms / 60_000), timeZone);
