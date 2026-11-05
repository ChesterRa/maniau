// 候補と答えを事象から独立にたどる。計画エンジンやその数えの関数は使わない。
import type { CandidateState, DomainEvent, Household, NeedWhen, PlanResult } from '@maniau/core';
import type { FactState } from './facts';
import type { History } from './history';
import { aboutMatches, sameValue } from './need-proof';
import type { Collector } from './report';
import { instantMinute } from './time';
import { checkCandidateUnavailable, fixedFamilyCoverBusy } from './unavailable-evidence';

type Candidate = Extract<DomainEvent, { type: 'needCandidatesSet' }>['candidates'][number];
type Person = Extract<DomainEvent, { type: 'needPeopleSet' }>['people'][number];
type Answer = Extract<DomainEvent, { type: 'availabilityRecorded' }>;
type Choice = Extract<DomainEvent, { type: 'candidateChosen' }>;
type Value = 'yes' | 'maybe' | 'no' | 'conflict';
type Link = { id: string; revoked: boolean };
export type NeedWhenWindow = Pick<Candidate, 'date' | 'startTime' | 'endTime'>;

interface Evidence {
  candidates: Candidate[];
  retired: Set<string>;
  people?: Person[];
  required: string[];
  minCount: number;
  since: Map<string, number>;
  answers: Answer[];
  links: Map<string, Link>;
  choice?: Choice;
  inUse: boolean;
  useUncertain: boolean;
  pendingRevs?: Map<string, number>;
}

const empty = (): Evidence => ({
  candidates: [],
  retired: new Set(),
  required: [],
  minCount: 0,
  since: new Map(),
  answers: [],
  links: new Map(),
  inUse: false,
  useUncertain: false,
});
const setEqual = (a: readonly string[], b: readonly string[]) =>
  a.length === new Set(a).size &&
  b.length === new Set(b).size &&
  a.length === b.length &&
  a.every((value) => b.includes(value));

/** その出所の最後の記録だけを使う。撤回はその出所だけを外す。 */
function answerOf(e: Evidence, candidate: Candidate, personId: string) {
  const since = e.since.get(personId);
  if (since === undefined) return undefined;
  const records = e.answers.filter(
    (a) =>
      a.seq > since &&
      a.personId === personId &&
      a.candidateId === candidate.id &&
      a.rev === candidate.rev,
  );
  const sources = (['self', 'link', 'family'] as const).flatMap((source) => {
    const last = records.findLast((a) => a.source === source);
    return !last || last.answer === 'withdrawn' ? [] : [last];
  });
  if (sources.length === 0) return undefined;
  const values = new Set(sources.map((a) => a.answer));
  return { value: (values.size === 1 ? sources[0]?.answer : 'conflict') as Value, sources };
}

/** 未定を 0 にしない。左右する人は、その人以外の必要者を満たせる場合にだけ数える。 */
export function independentAvailability(
  people: readonly string[],
  required: readonly string[],
  minCount: number,
  values: ReadonlyMap<string, 'yes' | 'no' | 'unknown'>,
) {
  const value = (id: string) => values.get(id) ?? 'unknown';
  const yes = people.filter((id) => value(id) === 'yes').length;
  const unknown = people.filter((id) => value(id) === 'unknown');
  const possible = yes + unknown.length;
  const requiredNo = required.filter((id) => value(id) === 'no');
  const requiredOpen = required.filter((id) => value(id) === 'unknown');
  const condition =
    requiredNo.length || possible < minCount
      ? 'cannot'
      : yes >= minCount && requiredOpen.length === 0
        ? 'meets'
        : 'open';
  const pivotal =
    requiredNo.length || possible < minCount
      ? []
      : unknown.filter((id) => required.includes(id) || yes + requiredOpen.length < minCount);
  return { yes, possible, requiredNo, requiredOpen, condition, pivotal };
}

/** 控えに入れる事実を作る。JSON の欄の順番やエンジンの要約関数は使わない。 */
function basisOf(e: Evidence, candidate: Candidate) {
  const people = (e.people ?? []).map((p) => p.id).sort();
  return {
    people,
    required: [...e.required].sort(),
    minCount: e.minCount,
    answers: people.flatMap((id) => {
      const answer = answerOf(e, candidate, id);
      if (!answer) return [];
      const sources = answer.sources
        .map((s) => [s.source, s.answer, s.note ?? null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'));
      return [[id, answer.value, sources]];
    }),
  };
}

function parseBasis(basis: string): unknown {
  try {
    return JSON.parse(basis) as unknown;
  } catch {
    return undefined;
  }
}

/** 表示されたやり方と勧めを、家族の選びと表示の内部整合に照らす。置けることや最後の証明は別。 */
function checkWaysAndRecommendation(
  itemId: string,
  candidates: readonly CandidateState[],
  recommended: NeedWhen['recommended'],
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const item = facts.items.get(itemId);
  const selection = history.events.findLast(
    (event) => event.type === 'needWaysSet' && event.itemId === itemId,
  );
  const selected = selection?.type === 'needWaysSet' ? selection.wayIds : [];
  const selectedWays = selected.map((id) => household.ways.find((way) => way.id === id));
  const basis =
    item && selection?.type === 'needWaysSet' && selectedWays.every((w) => w !== undefined)
      ? aboutMatches(
          selection.about,
          item,
          selectedWays.filter((w) => w !== undefined),
        )
      : undefined;
  let unproved = false;
  for (const candidate of candidates) {
    if (
      new Set(candidate.ways.map((w) => w.wayId)).size !== candidate.ways.length ||
      candidate.ways.some((w) => !selected.includes(w.wayId)) ||
      (selection?.type === 'needWaysSet' &&
        basis === true &&
        !setEqual(
          candidate.ways.map((w) => w.wayId),
          selected,
        ))
    )
      report.violation(
        'need_when_way_mismatch',
        candidate.id,
        '表示したやり方が家族の選びと違う。',
      );
    if (candidate.ways.length && basis === false)
      report.violation(
        'need_when_way_mismatch',
        candidate.id,
        '前の内容へのやり方の選びを今の内容に当てている。',
      );
    else if (candidate.ways.length && basis === undefined) unproved = true;
    for (const shown of candidate.ways) {
      const way = household.ways.find((w) => w.id === shown.wayId);
      if (!way) {
        unproved = true;
        continue;
      }
      const unknownCost = (way.cost.unknown?.length ?? 0) > 0;
      if (unknownCost && !shown.costUnknown)
        report.violation(
          'need_when_cost_mismatch',
          candidate.id,
          '分からない代償を既知としている。',
        );
      const unconfirmedHours = way.steps.some((step) => {
        const place = household.places.find((p) => p.id === step.placeId);
        return (
          place &&
          place.kind !== 'home' &&
          (!place.hours ||
            place.hours.source === 'googlePlaces' ||
            place.hours.periods.some((period) => period.open === period.close))
        );
      });
      const unused = (way.resourceIds ?? []).some((id) =>
        household.resources.some((resource) => resource.id === id && resource.use === 'notUsed'),
      );
      const unfinished = (way.requires ?? []).some((id) => {
        const preparation = household.preparations.find((entry) => entry.id === id);
        if (preparation?.state !== 'done' || preparation.appliesTo.kind === 'unknown') return true;
        if (preparation.validUntil && preparation.validUntil < candidate.date) return true;
        if (preparation.appliesTo.kind === 'members') {
          const person = item?.interpretation.forMemberId;
          if (!person || !preparation.appliesTo.memberIds.includes(person)) return true;
        }
        return false;
      });
      if (
        shown.usable &&
        (!shown.decisionDeadline ||
          shown.deadlineCertainty !== 'estimate' ||
          shown.reasons.length > 0 ||
          unconfirmedHours ||
          unused ||
          unfinished ||
          (shown.decisionDeadline &&
            instantMinute(shown.decisionDeadline) < instantMinute(plan.now)) ||
          household.stoppedWayIds?.includes(shown.wayId))
      )
        report.violation(
          'need_when_usable_mismatch',
          candidate.id,
          '期限・理由・停止と、使えるとの表示が食い違う。',
        );
      // 窓での実際の置き方・営業時間・行程・最後の時刻は、この表示だけでは証明できない。
      if (shown.usable) unproved = true;
    }
    const usable = candidate.ways.filter((w) => w.usable && w.decisionDeadline);
    if (selection?.type !== 'needWaysSet' || (basis === true && selected.length === 0)) {
      if (!setEqual(candidate.flags, ['waysUndecided']))
        report.violation('need_when_flags_mismatch', candidate.id, 'やり方を選ぶ前の印が違う。');
    } else if (basis === true) {
      const expected = usable.length === 0 ? ['noUsableWay'] : [];
      if (!setEqual(candidate.flags, expected))
        report.violation(
          'need_when_flags_mismatch',
          candidate.id,
          '使えると示せるやり方の印が表示と違う。',
        );
    }
    const last = usable.reduce<number | undefined>((value, w) => {
      const minute = instantMinute(w.decisionDeadline as string);
      return value === undefined ? minute : Math.max(value, minute);
    }, undefined);
    if (
      (last === undefined) !== (candidate.decisionDeadline === undefined) ||
      (last !== undefined &&
        candidate.decisionDeadline &&
        instantMinute(candidate.decisionDeadline) !== last)
    )
      report.violation(
        'need_when_deadline_mismatch',
        candidate.id,
        '表示した決め時と使えるやり方の決め時が違う。',
      );
  }
  if (recommended) {
    const meets = candidates.filter((c) => c.condition === 'meets');
    const usable = meets.filter((c) => c.ways.some((w) => w.usable && w.decisionDeadline));
    const selectedCandidate = usable.find((c) => c.id === recommended.candidateId);
    let justified =
      !!selectedCandidate &&
      recommended.meetsCount === meets.length &&
      recommended.usableCount === usable.length;
    if (recommended.reason === 'onlyUsable') {
      justified &&=
        usable.length === 1 && !selectedCandidate?.ways.some((w) => w.usable && w.costUnknown);
    } else {
      const onlyWays = usable.map((c) => c.ways.filter((w) => w.usable && w.decisionDeadline));
      justified &&=
        usable.length > 1 &&
        onlyWays.every((ways) => ways.length === 1 && !ways[0]?.costUnknown) &&
        new Set(onlyWays.map((ways) => ways[0]?.wayId)).size === 1;
      if (justified && selectedCandidate) {
        const selectedWay = selectedCandidate.ways.find((w) => w.usable && w.decisionDeadline);
        justified &&=
          !!selectedWay &&
          usable.every((other) => {
            if (other.id === selectedCandidate.id) return true;
            const otherWay = other.ways.find((w) => w.usable && w.decisionDeadline);
            if (!otherWay?.decisionDeadline || !selectedWay?.decisionDeadline) return false;
            const left = instantMinute(selectedWay.decisionDeadline),
              right = instantMinute(otherWay.decisionDeadline);
            return (
              selectedCandidate.yes >= other.yes &&
              left >= right &&
              (selectedCandidate.yes > other.yes || left > right)
            );
          });
      }
    }
    if (!justified)
      report.violation(
        'need_when_recommendation_mismatch',
        itemId,
        '勧めが表示した人数・やり方・代償・決め時に合わない。',
      );
  }
  if (unproved)
    report.undetermined(
      'need_when_way_unverified',
      itemId,
      '候補ごとの置き方・営業時間・行程と最後の機会を、この検証だけでは確かめられない。',
    );
}

/** 事象の後に得られた窓と回答を、計画からでなく事象から組む。 */
function collect(history: History, report: Collector) {
  const items = new Map<string, Evidence>();
  let household: Household | undefined;
  const meanings = new Map<string, Record<string, unknown>>();
  const usedLinks = new Set<string>();
  const optionItems = new Map<string, string>();
  let sawLinkAnswer = false;
  const get = (id: string) => {
    const existing = items.get(id);
    if (existing) return existing;
    const value = empty();
    items.set(id, value);
    return value;
  };
  const taskItems = (taskKey: string, basisIds: readonly string[]) => {
    const found = new Set(
      [...optionItems].filter(([key]) => taskKey.startsWith(`task:${key}:`)).map(([, id]) => id),
    );
    for (const id of basisIds) if (items.has(id)) found.add(id);
    if (found.size === 0)
      for (const id of items.keys())
        if (taskKey.startsWith(`task:opt:arr:need:${id}:`)) found.add(id);
    return found;
  };
  for (const event of history.events) {
    if (event.type === 'householdSet') {
      household = event.household;
      continue;
    }
    if (event.type === 'itemsStated') {
      for (const item of event.items)
        if (item.kind === 'need') {
          // 候補を持つ前の旧い用件も覚え、後から候補が足された時に先の引受けをたどる。
          get(item.id);
          meanings.set(item.id, {
            what: item.interpretation.what ?? item.written,
            place: item.interpretation.place,
            forMemberId: item.interpretation.forMemberId,
            holdNeeded: item.interpretation.holdNeeded,
          });
        }
      continue;
    }
    if (event.type === 'optionChosen') {
      for (const id of items.keys()) {
        const arrangement = `arr:need:${id}`;
        if (
          event.arrangementKey === arrangement &&
          event.optionKey.startsWith(`opt:${arrangement}:`)
        )
          optionItems.set(event.optionKey, id);
      }
      continue;
    }
    if (
      event.type === 'commitmentChanged' &&
      (event.action === 'accept' || event.action === 'done') &&
      event.actorId === event.assigneeId
    ) {
      const matches = taskItems(event.taskKey, event.basisItemIds ?? []);
      if (matches.size === 1) get([...matches][0] as string).inUse = true;
      else if (matches.size > 1) {
        for (const id of matches) get(id).useUncertain = true;
        report.undetermined(
          'need_when_use_unverified',
          event.id,
          '引受けがどの用件に結び付くか確かめられない。',
        );
      }
      continue;
    }
    if (event.type === 'externalRequestSent') {
      const matches = taskItems(event.taskKey, event.snapshot?.basis.itemIds ?? []);
      if (matches.size === 1) get([...matches][0] as string).inUse = true;
      else if (matches.size > 1) {
        for (const id of matches) get(id).useUncertain = true;
        report.undetermined(
          'need_when_use_unverified',
          event.id,
          '依頼がどの用件に結び付くか確かめられない。',
        );
      }
      continue;
    }
    if (event.type === 'itemCorrected' && meanings.has(event.itemId)) {
      const e = items.get(event.itemId);
      const before = meanings.get(event.itemId) as Record<string, unknown>;
      const after = { ...before };
      for (const key of ['what', 'place', 'forMemberId', 'holdNeeded'] as const) {
        const value = event.interpretation[key];
        if (value !== undefined) after[key] = value === null ? undefined : value;
      }
      if (e?.candidates.length) {
        if (['shape', 'date', 'startTime', 'endTime'].some((key) => key in event.interpretation))
          report.violation(
            'need_when_correction_invalid',
            event.id,
            '候補を持つ用件の日や形を直接直している。',
          );
        if (!sameValue(before, after)) {
          if (e.inUse)
            report.violation(
              'need_when_decision_in_use',
              event.id,
              '依頼または引受け後に用件の中身を変えている。',
            );
          e.pendingRevs = new Map(e.candidates.map((c) => [c.id, c.rev]));
        }
      }
      meanings.set(event.itemId, after);
      continue;
    }
    if (
      ![
        'needCandidatesSet',
        'needPeopleSet',
        'availabilityRecorded',
        'answerLinkIssued',
        'answerLinkRevoked',
        'candidateChosen',
      ].includes(event.type)
    )
      continue;
    if (!('itemId' in event)) continue;
    const e = get(event.itemId);
    if (event.type !== 'availabilityRecorded' || event.source !== 'link') {
      const member = household?.members.find((m) => m.id === event.actorId);
      if (!household) {
        report.undetermined(
          'need_when_actor_unverified',
          event.id,
          'その時の成員を確かめられない。',
        );
        continue;
      }
      if (member?.kind !== 'adult' || !member.active) {
        report.violation('need_when_actor_invalid', event.id, '有効な大人でない人の記録。');
        continue;
      }
    }
    if (event.type === 'needCandidatesSet') {
      if (e.inUse && e.candidates.length === 0 && event.candidates.length > 0)
        report.violation(
          'need_when_decision_in_use',
          event.id,
          '依頼または引受けを済ませた窓の用件に、初めて日付の候補を足している。',
        );
      const ids = event.candidates.map((c) => c.id);
      const invalid =
        new Set(ids).size !== ids.length ||
        event.candidates.some((c) => {
          const prior = e.candidates.find((p) => p.id === c.id);
          if (c.startTime >= c.endTime || (!prior && e.retired.has(c.id))) return true;
          if (!prior) return false;
          const changed =
            prior.date !== c.date || prior.startTime !== c.startTime || prior.endTime !== c.endTime;
          const beforeCorrection = e.pendingRevs?.get(c.id);
          return (
            c.rev < prior.rev ||
            (changed && c.rev <= prior.rev) ||
            (beforeCorrection !== undefined && c.rev <= beforeCorrection) ||
            (!!e.choice && e.inUse && c.id === e.choice.candidateId && c.rev !== e.choice.rev)
          );
        });
      if (e.choice && e.inUse && !ids.includes(e.choice.candidateId)) {
        report.violation(
          'need_when_decision_in_use',
          event.id,
          '依頼または引受け後に決めた候補を消している。',
        );
        continue;
      }
      if (invalid) {
        report.violation('need_when_candidates_invalid', event.id, '候補の識別・代・時刻が不正。');
        continue;
      }
      for (const old of e.candidates) if (!ids.includes(old.id)) e.retired.add(old.id);
      e.candidates = event.candidates;
      e.pendingRevs = undefined;
    } else if (event.type === 'needPeopleSet') {
      const ids = event.people.map((p) => p.id);
      const invalid =
        new Set(ids).size !== ids.length ||
        new Set(event.required).size !== event.required.length ||
        event.required.some((id) => !ids.includes(id)) ||
        event.minCount > ids.length ||
        event.people.some((p) =>
          p.kind === 'guest'
            ? !p.name || household?.members.some((m) => m.id === p.id)
            : !household?.members.some(
                (m) => m.id === p.id && (m.kind === 'adult' || m.kind === 'helper') && m.active,
              ),
        );
      if (invalid) {
        report.violation('need_when_people_invalid', event.id, '名簿・必要な人・人数が不正。');
        continue;
      }
      const since = new Map<string, number>();
      for (const person of event.people) since.set(person.id, e.since.get(person.id) ?? event.seq);
      for (const person of e.people ?? [])
        if (!ids.includes(person.id)) {
          const link = e.links.get(person.id);
          if (link) link.revoked = true;
        }
      e.people = event.people;
      e.required = event.required;
      e.minCount = event.minCount;
      e.since = since;
    } else if (event.type === 'answerLinkIssued') {
      if (!e.people?.some((p) => p.id === event.personId) || usedLinks.has(event.linkId)) {
        report.violation(
          'need_when_link_invalid',
          event.id,
          '名簿の外へのリンクか、リンク ID の再使用。',
        );
        continue;
      }
      usedLinks.add(event.linkId);
      e.links.set(event.personId, { id: event.linkId, revoked: false });
    } else if (event.type === 'answerLinkRevoked') {
      const link = e.links.get(event.personId);
      if (link?.id === event.linkId) link.revoked = true;
    } else if (event.type === 'availabilityRecorded') {
      const candidate = e.candidates.find((c) => c.id === event.candidateId);
      const member = household?.members.find((m) => m.id === event.actorId);
      const link = e.links.get(event.personId);
      const sourceValid =
        event.source === 'link'
          ? event.actorId === 'link' && !!link && !link.revoked && link.id === event.linkId
          : member?.kind === 'adult' &&
            member.active &&
            (event.source === 'self'
              ? event.actorId === event.personId
              : event.actorId !== event.personId);
      if (
        !sourceValid ||
        e.pendingRevs ||
        !candidate ||
        candidate.rev !== event.rev ||
        !e.people?.some((p) => p.id === event.personId)
      ) {
        report.violation(
          'need_when_answer_invalid',
          event.id,
          'その時の候補・名簿・出所に合わない答え。',
        );
        continue;
      }
      if (event.source === 'link') sawLinkAnswer = true;
      e.answers.push(event);
    } else if (event.type === 'candidateChosen') {
      const candidate = e.candidates.find((c) => c.id === event.candidateId && c.rev === event.rev);
      if (
        e.choice &&
        e.inUse &&
        (e.choice.candidateId !== event.candidateId || e.choice.rev !== event.rev)
      ) {
        report.violation(
          'need_when_decision_in_use',
          event.id,
          '依頼または引受け後に別の候補を決めている。',
        );
        continue;
      }
      if (e.pendingRevs || !candidate) {
        report.violation(
          'need_when_choice_basis_invalid',
          event.id,
          '決めた候補・代・その時の根拠が合わない。',
        );
        continue;
      }
      if (!e.people) {
        const parsed = parseBasis(event.basis);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          report.violation('need_when_choice_basis_invalid', event.id, '決定の控えの形が不正。');
          continue;
        }
        report.undetermined(
          'need_when_basis_unverified',
          event.id,
          '名簿がまだ無く、答えの条件を確かめられない。',
        );
      } else if (!sameValue(parseBasis(event.basis), basisOf(e, candidate))) {
        report.violation(
          'need_when_choice_basis_invalid',
          event.id,
          '決めた時の答えの控えが記録と違う。',
        );
        continue;
      }
      e.choice = event;
    }
  }
  for (const [id, e] of items)
    if (e.pendingRevs)
      report.undetermined(
        'need_when_revision_unverified',
        id,
        '用件の直しと候補の代の同じ命令を確かめられない。',
      );
  if (sawLinkAnswer)
    report.undetermined(
      'need_when_link_auth_unverified',
      'events',
      'リンクの記録は照らせるが、鍵の提示や実在の本人は事象だけでは証明できない。',
    );
  return items;
}

/** 事象の根拠と計画に出した候補・数・回答を照合する。 */
export function checkNeedWhen(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): ReadonlyMap<string, NeedWhenWindow> {
  const windows = new Map<string, NeedWhenWindow>();
  const relevant = history.events.some((e) =>
    [
      'needCandidatesSet',
      'needPeopleSet',
      'availabilityRecorded',
      'answerLinkIssued',
      'answerLinkRevoked',
      'candidateChosen',
    ].includes(e.type),
  );
  if (!relevant && !plan.requirements.some((r) => r.when)) return windows;
  if (!history.complete) {
    report.undetermined(
      'need_when_history_unverified',
      'events',
      '候補と答えの事象列がそろわない。',
    );
    return windows;
  }
  const evidence = collect(history, report);
  for (const [id, e] of evidence) {
    const item = facts.items.get(id);
    const choice = e.choice;
    const candidate =
      choice && e.candidates.find((c) => c.id === choice.candidateId && c.rev === choice.rev);
    if (
      candidate &&
      !e.pendingRevs &&
      item?.kind === 'need' &&
      item.interpretation.shape === 'window' &&
      facts.active.get(id) === true &&
      !facts.staleItems.has(id)
    )
      windows.set(id, {
        date: candidate.date,
        startTime: candidate.startTime,
        endTime: candidate.endTime,
      });
  }
  for (const requirement of plan.requirements) {
    if (!requirement.when) {
      const id = requirement.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
      if (
        requirement.kind === 'need' &&
        requirement.live &&
        id &&
        evidence.get(id)?.candidates.length &&
        facts.active.get(id) === true &&
        !facts.staleItems.has(id)
      )
        report.violation('need_when_missing', requirement.key, '記録された候補の表が無い。');
      continue;
    }
    if (requirement.kind !== 'need' || requirement.basis.itemIds.length !== 1) {
      report.violation(
        'need_when_requirement_invalid',
        requirement.key,
        '候補を窓のすること以外に出している。',
      );
      continue;
    }
    const itemId = requirement.basis.itemIds[0] as string;
    const item = facts.items.get(itemId);
    const e = evidence.get(itemId);
    if (
      item?.kind === 'need' &&
      item.interpretation.shape === 'window' &&
      e?.candidates.length &&
      !e.people &&
      facts.active.get(itemId) === true &&
      !facts.staleItems.has(itemId)
    ) {
      if (requirement.when.candidates.some((candidate) => candidate.unavailable !== undefined))
        report.violation(
          'need_when_unavailable_mismatch',
          requirement.key,
          '名簿が無いのに相手の手が離せない時間を出している。',
        );
      if (
        requirement.when.recommended ||
        requirement.when.people.length > 0 ||
        requirement.when.required.length > 0 ||
        requirement.when.minCount !== 0 ||
        requirement.when.answers.length > 0 ||
        requirement.when.links.length > 0 ||
        requirement.when.candidates.some(
          (c) =>
            c.condition !== 'open' ||
            c.yes !== 0 ||
            c.possible !== 0 ||
            c.requiredNo.length > 0 ||
            c.requiredOpen.length > 0 ||
            c.pivotal.length > 0,
        )
      )
        report.violation(
          'need_when_no_roster_claim',
          requirement.key,
          '名簿が無いのに答えの条件や勧めを決めている。',
        );
      const selected =
        !e.pendingRevs &&
        e.choice &&
        e.candidates.find((c) => c.id === e.choice?.candidateId && c.rev === e.choice.rev);
      const arrangements = plan.arrangements.filter(
        (a) => a.live && a.requirementKey === requirement.key && a.kind === 'need',
      );
      if (
        (!selected && (requirement.when.chosen || arrangements.length > 0)) ||
        (selected &&
          (!requirement.when.chosen ||
            requirement.when.chosen.candidateId !== selected.id ||
            requirement.when.chosen.rev !== selected.rev))
      )
        report.violation(
          'need_when_choice_mismatch',
          requirement.key,
          '名簿の有無にかかわらず、決定の記録と表示・手配が違う。',
        );
      if (selected) {
        const start = Date.parse(`${selected.date}T${selected.startTime}:00+09:00`) / 60_000;
        const end = Date.parse(`${selected.date}T${selected.endTime}:00+09:00`) / 60_000;
        if (
          arrangements.some((a) => instantMinute(a.start) !== start || instantMinute(a.end) !== end)
        )
          report.violation(
            'need_when_window_mismatch',
            requirement.key,
            '手配の窓が決めた候補と違う。',
          );
      }
      if (!e.useUncertain && requirement.when.inUse !== e.inUse)
        report.violation(
          'need_when_in_use_mismatch',
          requirement.key,
          '依頼や引受けの記録と表示が違う。',
        );
      report.undetermined(
        'need_when_evidence_unverified',
        requirement.key,
        '名簿と人数をまだ確かめられない。',
      );
      continue;
    }
    if (
      item?.kind !== 'need' ||
      item.interpretation.shape !== 'window' ||
      !e?.people ||
      !e.candidates.length ||
      facts.active.get(itemId) !== true ||
      facts.staleItems.has(itemId)
    ) {
      report.undetermined(
        'need_when_evidence_unverified',
        requirement.key,
        '事項・候補・名簿を確かめられない。',
      );
      continue;
    }
    const when = requirement.when;
    if (e.useUncertain && !e.inUse)
      report.undetermined(
        'need_when_use_unverified',
        requirement.key,
        '依頼や引受けがこの用件の物か確かめられない。',
      );
    else if (when.inUse !== e.inUse)
      report.violation(
        'need_when_in_use_mismatch',
        requirement.key,
        '依頼や引受けの記録と、日を替えられるかの表示が違う。',
      );
    const sortedPeople = (people: readonly Person[]) =>
      [...people].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (
      !sameValue(sortedPeople(when.people), sortedPeople(e.people)) ||
      !setEqual(when.required, e.required) ||
      when.minCount !== e.minCount
    )
      report.violation(
        'need_when_people_mismatch',
        requirement.key,
        '表示した名簿または数え方が記録と違う。',
      );
    if (
      !setEqual(
        when.candidates.map((c) => c.id),
        e.candidates.map((c) => c.id),
      )
    )
      report.violation(
        'need_when_candidates_mismatch',
        requirement.key,
        '表示した候補が記録と違う。',
      );
    const expectedAnswers: {
      personId: string;
      candidateId: string;
      value: Value;
      sources: unknown[];
    }[] = [];
    for (const candidate of e.candidates) {
      const actual = when.candidates.find((c) => c.id === candidate.id);
      if (!actual) continue;
      const unavailable = household.unavailable ?? [];
      const shown = actual.unavailable;
      if (unavailable.length > 0 || shown !== undefined) {
        const result = checkCandidateUnavailable(
          household,
          e.people,
          candidate,
          unavailable,
          shown,
        );
        if (result === 'mismatch')
          report.violation(
            'need_when_unavailable_mismatch',
            candidate.id,
            '候補と手が離せない時間の重なりが家庭の記録と違う。',
          );
        else if (result === 'undetermined')
          report.undetermined(
            'need_when_unavailable_unverified',
            candidate.id,
            '名簿または手が離せない時間を照らせない。',
          );
      }
      // 候補の窓の受け持ちで担当が固定され、明示の占用が重なる場合だけ、使えるという表示を独立に断る。
      // やり方の選びが今の内容の物と照らせなければ、推量しない（その検査は別に未判定を残す）。
      if (unavailable.length > 0 && item.interpretation.holdNeeded !== false) {
        const selection = history.events.findLast(
          (event) => event.type === 'needWaysSet' && event.itemId === itemId,
        );
        const selected = selection?.type === 'needWaysSet' ? selection.wayIds : [];
        const selectedWays = selected.flatMap((id) => {
          const way = household.ways.find((entry) => entry.id === id);
          return way ? [way] : [];
        });
        const matches =
          selection?.type === 'needWaysSet' &&
          selectedWays.length === selected.length &&
          aboutMatches(selection.about, item, selectedWays) === true;
        if (matches) {
          for (const displayed of actual.ways) {
            const way = selectedWays.find((entry) => entry.id === displayed.wayId);
            if (!way) continue;
            const cover = fixedFamilyCoverBusy(way, candidate, unavailable);
            if (
              cover === 'blocked' &&
              (displayed.usable || !displayed.reasons.includes('coverGaps'))
            )
              report.violation(
                'need_when_busy_way_mismatch',
                candidate.id,
                '受け持つ人の記録と候補の窓が重なるのに、受け持ちの不足が無い。',
              );
            else if (cover === 'undetermined')
              report.undetermined(
                'need_when_busy_way_unverified',
                candidate.id,
                '受け持つ人の手が離せない時間を照らせない。',
              );
          }
        }
      }
      const start = Date.parse(`${candidate.date}T${candidate.startTime}:00+09:00`) / 60_000;
      const end = Date.parse(`${candidate.date}T${candidate.endTime}:00+09:00`) / 60_000;
      if (
        actual.rev !== candidate.rev ||
        actual.date !== candidate.date ||
        instantMinute(actual.start) !== start ||
        instantMinute(actual.end) !== end
      )
        report.violation(
          'need_when_candidates_mismatch',
          candidate.id,
          '候補の代または時刻が記録と違う。',
        );
      const values = new Map<string, 'yes' | 'no' | 'unknown'>();
      for (const person of e.people) {
        const answer = answerOf(e, candidate, person.id);
        if (!answer) continue;
        values.set(
          person.id,
          answer.value === 'yes' ? 'yes' : answer.value === 'no' ? 'no' : 'unknown',
        );
        expectedAnswers.push({
          personId: person.id,
          candidateId: candidate.id,
          value: answer.value,
          sources: answer.sources.map((a) => ({
            source: a.source,
            answer: a.answer,
            by: a.actorId,
            at: a.occurredAt,
            seq: a.seq,
            ...(a.note === undefined ? {} : { note: a.note }),
          })),
        });
      }
      const count = independentAvailability(
        e.people.map((p) => p.id),
        e.required,
        e.minCount,
        values,
      );
      if (
        actual.yes !== count.yes ||
        actual.possible !== count.possible ||
        actual.condition !== count.condition ||
        !setEqual(actual.requiredNo, count.requiredNo) ||
        !setEqual(actual.requiredOpen, count.requiredOpen) ||
        !setEqual(actual.pivotal, count.pivotal)
      )
        report.violation(
          'need_when_count_mismatch',
          candidate.id,
          '人数・答えの条件・左右する人が事象からの数えと違う。',
        );
    }
    const sortAnswers = (arr: typeof expectedAnswers) =>
      [...arr]
        .map((a) => ({
          ...a,
          sources: [...a.sources].sort((x, y) =>
            JSON.stringify(x).localeCompare(JSON.stringify(y), 'en'),
          ),
        }))
        .sort((a, b) =>
          `${a.candidateId}\0${a.personId}`.localeCompare(`${b.candidateId}\0${b.personId}`, 'en'),
        );
    if (!sameValue(sortAnswers(when.answers), sortAnswers(expectedAnswers)))
      report.violation(
        'need_when_answers_mismatch',
        requirement.key,
        '表示した答え・出所・条件が記録と違う。',
      );
    if (
      !setEqual(
        when.links.map((link) => link.personId),
        e.people.map((p) => p.id),
      )
    )
      report.violation(
        'need_when_link_mismatch',
        requirement.key,
        'リンクの状態を出す相手が名簿と違う。',
      );
    for (const link of when.links) {
      const recorded = e.links.get(link.personId);
      const expected =
        e.people.some((p) => p.id === link.personId) && !!recorded && !recorded.revoked;
      if (link.active !== expected)
        report.violation(
          'need_when_link_mismatch',
          link.personId,
          'リンクの有効・失効の表示が記録と違う。',
        );
    }
    const chosen =
      e.choice &&
      e.candidates.find((c) => c.id === e.choice?.candidateId && c.rev === e.choice.rev);
    if (!chosen && when.chosen)
      report.violation(
        'need_when_choice_mismatch',
        requirement.key,
        '今の候補に対する決定の記録が無い。',
      );
    const arrangements = plan.arrangements.filter(
      (a) => a.live && a.requirementKey === requirement.key && a.kind === 'need',
    );
    if (!chosen && arrangements.length > 0)
      report.violation(
        'need_when_choice_mismatch',
        requirement.key,
        '候補を決める前に窓の手配がある。',
      );
    if (chosen && e.choice) {
      const before = parseBasis(e.choice.basis) as Record<string, unknown>;
      const now = basisOf(e, chosen);
      const changes = [
        ...(!sameValue(before.people, now.people) ? ['people'] : []),
        ...(!sameValue(before.required, now.required) || before.minCount !== now.minCount
          ? ['rule']
          : []),
        ...(!sameValue(before.answers, now.answers) ? ['answers'] : []),
      ];
      if (
        !when.chosen ||
        when.chosen.candidateId !== chosen.id ||
        when.chosen.rev !== chosen.rev ||
        when.chosen.stale !== changes.length > 0 ||
        !setEqual(when.chosen.changes, changes)
      )
        report.violation(
          'need_when_choice_mismatch',
          requirement.key,
          '決めた候補または確かめ待ちが記録と違う。',
        );
      const start = Date.parse(`${chosen.date}T${chosen.startTime}:00+09:00`) / 60_000;
      const end = Date.parse(`${chosen.date}T${chosen.endTime}:00+09:00`) / 60_000;
      if (
        arrangements.some((a) => instantMinute(a.start) !== start || instantMinute(a.end) !== end)
      )
        report.violation(
          'need_when_window_mismatch',
          requirement.key,
          '手配の窓が決めた候補と違う。',
        );
    }
    checkWaysAndRecommendation(
      itemId,
      when.candidates,
      when.recommended,
      household,
      plan,
      facts,
      history,
      report,
    );
  }
  return windows;
}
