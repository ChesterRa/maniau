// Postgres の表（02-foundation §6.1）。家庭に属する表は household_id を持ち、参照は
// (household_id, id) の組で結ぶ。ログインの身元（identities）だけは家庭に属さない。
// 敏感な中身は payloads にだけ置き、events には許した欄と中身の ID だけを置く（§6.2）。
// 知らせ・仕事・写真などの表は、それを使う段（直す順 7）で足す。
import {
  boolean,
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
