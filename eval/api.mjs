import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { estimateCost } from './lib.mjs';

function retryDelay(header, attempt) {
  const backoff = 1000 * 2 ** (attempt - 1);
  if (!header) return backoff;
  const seconds = Number(header);
  const fromHeader = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(fromHeader) ? Math.max(backoff, fromHeader) : backoff;
}

export async function callClaude({ payload, number, key, pricing, ledger, fetchImpl = fetch, sleepImpl = sleep }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const requestId = randomUUID();
    await ledger({ event: 'request_started', request_id: requestId, number, attempt });
    let response;
    try {
      response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(600_000),
      });
    } catch {
      await ledger({ event: 'request_finished', request_id: requestId, number, attempt, outcome: 'network_error', cost_usd: null });
      throw new Error('通信が途切れました。課金の有無は不明です。');
    }
    let body;
    try { body = await response.json(); } catch { body = null; }
    const usage = body?.usage ?? null;
    await ledger({
      event: 'request_finished', request_id: requestId, number, attempt,
      outcome: response.ok && body ? 'response' : 'api_error',
      http_status: response.status,
      provider_request_id: response.headers.get('request-id'),
      actual_model: body?.model ?? null,
      stop_reason: body?.stop_reason ?? null,
      usage,
      cost_usd: estimateCost(usage, pricing),
    });
    if (response.ok && body) return body;
    if ([429, 500, 529].includes(response.status) && attempt < 3) {
      const delayMs = retryDelay(response.headers.get('retry-after'), attempt);
      if (delayMs <= 30_000) {
        await ledger({ event: 'retry_scheduled', request_id: requestId, number, attempt, delay_ms: delayMs });
        await sleepImpl(delayMs);
        continue;
      }
    }
    throw new Error(`API の応答を使えませんでした（HTTP ${response.status}）。費用は台帳と請求を照合してください。`);
  }
  throw new Error('API の再試行を完了できませんでした。');
}
