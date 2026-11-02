// Cloudflare Access の身元（01-model §11「身元」、02-foundation §6.1）。Access が前で許した要求には、
// 署名付きのトークン（Cf-Access-Jwt-Assertion の見出し）が付く。サーバーは毎回の要求で、署名・対象
// （aud）・発行元（iss）・期限を確かめる。トークンの無い要求と、確かめられない要求は断る（Access を
// 通らずに直接届いた要求も、ここで止まる）。
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

export const ACCESS_HEADER = 'cf-access-jwt-assertion';

export interface AccessConfig {
  /** 例：https://<チーム>.cloudflareaccess.com（トークンの発行元。末尾の / は付けない）。 */
  teamDomain: string;
  /** Access のアプリの AUD タグ。 */
  audience: string;
}

/** 確かめた身元。発行元と、その中の ID で一意。メールは、最初に成員と結ぶ時だけ使う。 */
export interface AccessIdentity {
  issuer: string;
  subject: string;
  email?: string;
}

export type AccessVerifier = (token: string | undefined) => Promise<AccessIdentity | undefined>;

/** keys を渡さなければ、Access の公開鍵の一覧を取りに行く（jose が控え、鍵の替わりにも追う）。 */
export function accessVerifier(config: AccessConfig, keys?: JWTVerifyGetKey): AccessVerifier {
  const issuer = config.teamDomain.replace(/\/+$/, '');
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (token) => {
    if (!token) return undefined;
    try {
      // 期限（exp）の無いトークンは受けない（毎回、期限まで確かめる）。
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub'],
      });
      // サービスのトークン（人でない）は sub が空。家族の成員に結ばない。
      if (typeof payload.sub !== 'string' || payload.sub === '') return undefined;
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      return { issuer, subject: payload.sub, ...(email ? { email } : {}) };
    } catch {
      return undefined;
    }
  };
}
