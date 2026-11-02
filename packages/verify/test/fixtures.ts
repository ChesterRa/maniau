import { Household, PlanResult } from '@maniau/core';

export const household = () =>
  Household.parse({
    id: 'household-1',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      { id: 'a', kind: 'adult', name: '親A' },
      { id: 'b', kind: 'adult', name: '親B' },
      { id: 'helper', kind: 'helper', name: '頼める人' },
    ],
    places: [
      { id: 'home', kind: 'home', name: '家' },
      { id: 'station', kind: 'station', name: '駅' },
      {
        id: 'store',
        kind: 'store',
        name: '店',
        nearStationId: 'station',
        walkFromStationMin: 5,
        goods: ['clothing'],
        hours: {
          source: 'family',
          periods: Array.from({ length: 7 }, (_, day) => ({
            weekday: day + 1,
            open: '12:15',
            close: '13:00',
          })),
        },
      },
    ],
    routines: ['a', 'b'].flatMap((memberId) =>
      Array.from({ length: 7 }, (_, day) => ({
        memberId,
        weekday: day + 1,
        segments: [
          { start: '08:00', end: '12:00', kind: 'home', placeId: 'home' },
          { start: '12:00', end: '13:00', kind: 'away', placeId: 'station' },
          { start: '13:00', end: '22:00', kind: 'home', placeId: 'home' },
        ],
      })),
    ),
    careOptions: ['one', 'two'].map((id) => ({
      id,
      kind: 'askHelper',
      titleKey: `option.${id}`,
      deadline: { type: 'daysBefore', days: 3, at: '21:00' },
      steps: [{ id: 'step', titleKey: 'task.step', durationMin: 30, segments: ['home'] }],
      cost: {},
      cancellable: true,
    })),
  });

export const task = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  titleKey: `task.${key}`,
  basis: { itemIds: [] },
  durationMin: 30,
  segments: ['home'],
  assigneeId: 'a',
  start: '2026-12-07T10:00+09:00',
  end: '2026-12-07T10:30+09:00',
  commitment: 'proposed',
  live: true,
  ...overrides,
});

export const plan = (overrides: Record<string, unknown> = {}) =>
  PlanResult.parse({
    householdId: 'household-1',
    now: '2026-12-01T09:00+09:00',
    throughSeq: 0,
    requirements: [],
    arrangements: [],
    tasks: [],
    requests: [],
    questions: [],
    notifications: [],
    ...overrides,
  });

export const event = (seq: number, body: Record<string, unknown>) => ({
  id: `event-${seq}`,
  householdId: 'household-1',
  seq,
  version: 1,
  occurredAt: '2026-11-30T10:00+09:00',
  recordedAt: '2026-11-30T10:00+09:00',
  actorId: 'a',
  ...body,
});

export const requirement = (overrides: Record<string, unknown> = {}) => ({
  key: 'requirement',
  kind: 'childCare',
  what: '子の居場所',
  nature: 'required',
  basis: { itemIds: [] },
  live: true,
  ...overrides,
});

export const arrangement = (overrides: Record<string, unknown> = {}) => ({
  key: 'arrangement',
  requirementKey: 'requirement',
  kind: 'childCare',
  start: '2026-12-07T08:10+09:00',
  end: '2026-12-07T18:15+09:00',
  status: 'decidable',
  options: [],
  live: true,
  ...overrides,
});

export const option = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  arrangementKey: 'arrangement',
  templateId: key,
  titleKey: `option.${key}`,
  deadlineCertainty: 'undetermined',
  expired: false,
  cost: {},
  taskKeys: [],
  ...overrides,
});
