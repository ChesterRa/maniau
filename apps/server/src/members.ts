// 身元を家族の成員に結ぶ（02-foundation §6.1）。成員の表が権限の正本で、毎回の要求で引く（外した大人は
// すぐ使えなくなる）。初めての身元は、招きのメール（置き場所の設定。リポジトリと DB に書かない）で、
// まだ身元の無い大人に一度だけ結ぶ。結んだ後は、発行元と中の ID で引き、メールでは引かない。
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { AccessIdentity } from './auth/access';
import { households, identities, members } from './db/schema';
import type { Db } from './db/store';

export interface FamilyMember {
  householdId: string;
  memberId: string;
  /** 結んだ身元（家庭を押さえた中で、今も結ばれているかを確かめ直す）。 */
  identityId: string;
  timeZone: string;
}

/** 招き：メール（小文字）→ 家庭と成員。 */
export type Invitations = ReadonlyMap<string, { householdId: string; memberId: string }>;

/** 置き場所の設定（FAMILY_HOUSEHOLD_ID と ACCESS_INVITES の JSON）から招きを作る。 */
export function invitationsFrom(householdId: string | undefined, json: string | undefined) {
  const result = new Map<string, { householdId: string; memberId: string }>();
  if (!householdId || !json) return result;
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('ACCESS_INVITES の形が違う');
  for (const [email, memberId] of Object.entries(parsed)) {
    if (typeof memberId !== 'string') throw new Error('ACCESS_INVITES の形が違う');
    result.set(email.trim().toLowerCase(), { householdId, memberId });
  }
  return result;
}

/** 結ぼうとした大人に、並んだ別の身元が先に結んだ（このトランザクションは戻す）。 */
class TakenByAnother extends Error {}

/** 身元の成員（使える家庭の、有効な大人だけ）。無ければ undefined（断る）。 */
export async function memberFor(
  db: Db,
  identity: AccessIdentity,
  invitations: Invitations,
): Promise<FamilyMember | undefined> {
  const attempt = async () => {
    try {
      return await lookup(db, identity, invitations);
    } catch (error) {
      if (error instanceof TakenByAnother) return undefined;
      throw error;
    }
  };
  try {
    return await attempt();
  } catch (error) {
    // 同じ身元の初めての要求が二つ並ぶと、片方は一意の決まりで落ちる。結ばれた後なので引き直す。
    if (causeCode(error) === '23505') return attempt();
    throw error;
  }
}

/** Postgres の誤りの符号（drizzle が包んだ時は cause の中）。 */
function causeCode(error: unknown): string | undefined {
  for (let e: unknown = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function lookup(db: Db, identity: AccessIdentity, invitations: Invitations) {
  return db.transaction(async (tx) => {
    const usable = async (householdId: string, memberId: string) => {
      const [row] = await tx
        .select({ member: members, household: households })
        .from(members)
        .innerJoin(households, eq(households.id, members.householdId))
        .where(and(eq(members.householdId, householdId), eq(members.id, memberId)));
      if (row?.member.kind !== 'adult' || !row.member.active) return undefined;
      if (row.household.status !== 'active') return undefined;
      return { row, found: { householdId, memberId, timeZone: row.household.timeZone } };
    };

    const [known] = await tx
      .select()
      .from(identities)
      .where(and(eq(identities.issuer, identity.issuer), eq(identities.subject, identity.subject)));
    if (known) {
      if (known.removedAt) return undefined;
      const [member] = await tx.select().from(members).where(eq(members.identityId, known.id));
      const target = member ? await usable(member.householdId, member.id) : undefined;
      return target ? { ...target.found, identityId: known.id } : undefined;
    }

    // 初めての身元：招きのメールの大人で、まだ身元が無い時だけ結ぶ（別の身元を上書きしない）。
    const invited = identity.email ? invitations.get(identity.email.toLowerCase()) : undefined;
    if (!invited) return undefined;
    const target = await usable(invited.householdId, invited.memberId);
    if (!target || target.row.member.identityId !== null) return undefined;
    const id = randomUUID();
    await tx.insert(identities).values({ id, issuer: identity.issuer, subject: identity.subject });
    const bound = await tx
      .update(members)
      .set({ identityId: id })
      .where(
        and(
          eq(members.householdId, invited.householdId),
          eq(members.id, invited.memberId),
          // 並んだ別の身元が先に結んでいれば、何も変えない（上書きしない）。
          isNull(members.identityId),
        ),
      )
      .returning();
    // 結べなければ、足した身元の行も残さない。
    if (bound.length !== 1) throw new TakenByAnother();
    return { ...target.found, identityId: id };
  });
}
