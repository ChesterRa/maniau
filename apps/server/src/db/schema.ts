// Postgres の表（02-foundation §6.1）。家庭に属する表は household_id を持ち、参照は
// (household_id, id) の組で結ぶ。ログインの身元（identities）だけは家庭に属さない。
// 敏感な中身は payloads にだけ置き、events には許した欄と中身の ID だけを置く（§6.2）。
// 写真・削除の仕事などの表は、それを使う段で足す。
import {
  bigint,
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** 書き込みを一列に並べる所（§7.3）。デモの家庭は本番の置き場所に置かない。 */
export const households = pgTable('households', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['real', 'test'] }).notNull(),
  status: text('status', { enum: ['active', 'closed'] })
    .notNull()
    .default('active'),
  region: text('region').notNull(),
  timeZone: text('time_zone').notNull(),
  /** 次に使う通し番号（行を押さえた中で進める）。 */
  nextSeq: integer('next_seq').notNull().default(1),
  /** 知らせの仕事が、どの通し番号まで事象を見たか（回を数える続きの位置）。 */
  notifiedThroughSeq: integer('notified_through_seq'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** ログインの身元。発行元の中の ID で一意。メールが同じでも、別の発行元の身元とは結ばない。 */
export const identities = pgTable(
  'identities',
  {
    id: text('id').primaryKey(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('identities_issuer_subject').on(t.issuer, t.subject)],
);

/** 権限の正本。名前などの中身は持たない（家族の情報は payloads）。 */
export const members = pgTable(
  'members',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    id: text('id').notNull(),
    kind: text('kind', { enum: ['adult', 'child', 'helper'] }).notNull(),
    active: boolean('active').notNull().default(true),
    /** 大人だけ。ログインの身元。 */
    identityId: text('identity_id').references(() => identities.id),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.id] }),
    uniqueIndex('members_household_identity').on(t.householdId, t.identityId),
  ],
);

/** 事象（追記だけ）。body は許した欄と中身の ID だけ（§6.2）。 */
export const events = pgTable(
  'events',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    seq: integer('seq').notNull(),
    id: text('id').notNull(),
    type: text('type').notNull(),
    version: integer('version').notNull(),
    occurredAt: text('occurred_at').notNull(),
    recordedAt: text('recorded_at').notNull(),
    actorId: text('actor_id').notNull(),
    opId: text('op_id'),
    /** 書き込みのまとまり（一つのトランザクションで足した事象）の、最初の通し番号。 */
    batch: integer('batch'),
    body: jsonb('body').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.seq] }),
    uniqueIndex('events_household_id').on(t.householdId, t.id),
  ],
);

/** 操作の記録（§7.3 の 4・7）。何も起きなかった操作も一行。要約は敏感な付随情報として扱う。 */
export const operations = pgTable(
  'operations',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    opId: text('op_id').notNull(),
    actorId: text('actor_id').notNull(),
    digest: text('digest').notNull(),
    throughSeq: integer('through_seq').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.opId] })],
);

/** 敏感な中身。sha256 はここに置き、事象には置かない。消した物は本体を空にし、時刻と理由を残す。 */
export const payloads = pgTable(
  'payloads',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    id: text('id').notNull(),
    kind: text('kind').notNull(),
    sha256: text('sha256'),
    body: jsonb('body'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedReason: text('deleted_reason'),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.id] })],
);

/**
 * Push の登録先（§9）。大人ごとに一つ（今週は複数の端末の流れを作らない）。同じ登録先（一台の
 * iPhone）で使う人が替われば、前の人との結び付きを外す。登録した身元を持ち、送る前に、その身元が
 * 今もその大人に結ばれているかを確かめる。登録先の URL と鍵は、知らせを送るためだけに使う。
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    memberId: text('member_id').notNull(),
    identityId: text('identity_id')
      .notNull()
      .references(() => identities.id),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** 知らせの文の言葉（登録した時の画面の言葉。替えたら登録し直す）。 */
    language: text('language', { enum: ['ja', 'en'] }).notNull(),
    /**
     * 登録ごとの版（乱数）。送る直前と、無くなった登録先を消す時に、同じ登録かを比べる（時刻は
     * Postgres とプログラムで精度が違うので、版には使わない）。
     */
    registration: text('registration').notNull(),
    /**
     * 端末が登録を頼んだ時（その端末の時計のミリ秒）。同じ登録先で、後から頼まれた登録が先に済んで
     * いれば、遅れて届いた前の登録で上書きしない（一台の端末で使う人が替わった時）。同じ端末の中の
     * 順にだけ使い、違う端末の時計とは比べない。
     */
    requestedAt: bigint('requested_at', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('push_subscriptions_member').on(t.householdId, t.memberId),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [members.householdId, members.id],
    }),
  ],
);

/**
 * 知らせの意図（運用の表。§5.7）。キーごとに一行で、回を数える。回ごとに、送る待ち（pending）→
 * 送っている（sending、期限付きの引き受け）→ 受け付けられた（sent。事象 notified を足す）・
 * 要らなくなった（dropped）・あきらめた（failed）。中身の文は持たない（送る直前に作り直す）。
 */
export const notificationIntents = pgTable(
  'notification_intents',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    key: text('key').notNull(),
    memberId: text('member_id').notNull(),
    kind: text('kind', {
      enum: ['decisionApproaching', 'question', 'cancellation', 'assignment'],
    }).notNull(),
    until: timestamp('until', { withTimezone: true }),
    /** 何回目か（キーが無い所から出るたびに一つ進む。notified には「キー#回」を残す）。 */
    round: integer('round').notNull().default(1),
    /** 今の計画に出ているか。 */
    present: boolean('present').notNull().default(true),
    state: text('state', { enum: ['pending', 'sending', 'sent', 'dropped', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** 送っている間の引き受けの期限。過ぎたら、もう一度引き受けてよい。 */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /**
     * 引き受けの札（引き受けるごとの乱数）。送った後の状態は、自分の札の行だけを替える（期限の切れた
     * 古い引き受けが、後から引き受けた物の結果を上書きしない）。
     */
    leaseToken: text('lease_token'),
    /** 次に試してよい時刻（失敗の後の間隔）。 */
    notBefore: timestamp('not_before', { withTimezone: true }),
    /** 最後の失敗の種類（HTTP の状態など。中身は置かない）。 */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.key] })],
);
