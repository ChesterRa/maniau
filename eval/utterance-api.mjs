import { createHash, randomUUID } from 'node:crypto';
import { estimateCost } from './lib.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

function usageOf(usage) {
  if (!usage) return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (Number.isFinite(usage[key])) result[key] = usage[key];
  }
  if (['global', 'us'].includes(usage.inference_geo)) result.inference_geo = usage.inference_geo;
  if (['standard', 'fast'].includes(usage.speed)) result.speed = usage.speed;
  return result;
}

/** 読み取り関数が実際に発行した各リクエストの始まりと結果を記録する。 */
export function instrumentUtteranceClient(client, { ledger, pricing = null }) {
  return {
    messages: {
      async parse(params, ...rest) {
        const requestId = randomUUID();
        const common = { request_id: requestId };
        await ledger({
          ...common,
          event: 'request_started',
          requested_model: params.model,
          max_tokens: params.max_tokens,
          effort: params.output_config?.effort ?? 'model_default',
          prompt_sha256: hash(params.system),
          format_sha256: hash(params.output_config?.format),
        });
        let response;
        try {
          response = await client.messages.parse(params, ...rest);
        } catch (error) {
          // エラー本文には原文や秘密が入る可能性があるため保存しない。
          await ledger({
            ...common,
            event: 'request_finished',
            outcome: Number.isInteger(error?.status) ? 'api_error' : 'network_or_client_error',
            http_status: Number.isInteger(error?.status) ? error.status : null,
            usage: null,
            cost_usd: null,
          });
          throw error;
        }
        const usage = usageOf(response.usage);
        const applicablePricing = pricing?.model === params.model && pricing?.model === response.model && usage?.inference_geo === 'global' && usage?.speed === 'standard'
          ? pricing : null;
        await ledger({
          ...common,
          event: 'request_finished',
          outcome: 'response',
          actual_model: response.model ?? null,
          provider_request_id: response._request_id ?? null,
          stop_reason: response.stop_reason ?? null,
          usage,
          cost_usd: estimateCost(usage, applicablePricing),
        });
        return response;
      },
    },
  };
}
