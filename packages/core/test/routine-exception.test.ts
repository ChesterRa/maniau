// その日だけの一日（routineExceptions）の形と区間：ふだんの曜日の一日より先に使い、ふだんの一日と同じ決まりで
// 確かめる。前の記録（例外の欄が無い家の情報）は、空として読む。
import { describe, expect, it } from 'vitest';
import { Household, type RoutineSegment, validateHousehold } from '../src';
import { noAdultAtHome, slotsOn } from '../src/engine';
import { household } from './fixtures/demo';

const home = (start: string, end: string): RoutineSegment => ({
  start,
  end,
  kind: 'home',
  placeId: 'home',
  viaStationIds: [],
});
const withDay = (segments: RoutineSegment[], memberId = 'b', date = '2026-12-07') =>
  Household.parse({ ...household, routineExceptions: [{ memberId, date, segments }] });

describe('その日だけの一日', () => {
  it('前の記録（欄が無い）は空として読む', () => {
    const { routineExceptions: _ignored, ...old } = household;
    expect(Household.parse(old).routineExceptions).toEqual([]);
  });

  it('その日だけ、ふだんの曜日の一日の代わりに使う', () => {
    const h = withDay([home('06:30', '22:30')]);
    expect(slotsOn(h, 'b', '2026-12-07').map((s) => s.kind)).toEqual(['home']);
    expect(slotsOn(h, 'b', '2026-12-14').map((s) => s.kind)).toContain('work');
    expect(slotsOn(household, 'b', '2026-12-07').map((s) => s.kind)).toContain('work');
  });

  it('大人のどちらかがその日ずっと家にいれば、子の居場所の手配が要る時間は無い', () => {
    expect(noAdultAtHome(household, '2026-12-07').length).toBeGreaterThan(0);
    expect(noAdultAtHome(withDay([home('06:30', '22:30')]), '2026-12-07')).toEqual([]);
  });

  it('ふだんの一日と同じ決まりで確かめ、同じ人・同じ日は一つだけ', () => {
    const overlap = withDay([home('06:30', '12:00'), home('11:00', '22:30')]);
    expect(validateHousehold(overlap).map((i) => i.problem)).toContain('overlap');
    const stranger = withDay([home('06:30', '22:30')], 'nobody');
    expect(validateHousehold(stranger)).toContainEqual(
      expect.objectContaining({ path: 'routineExceptions.0.memberId', problem: 'unknownRef' }),
    );
    const one = withDay([home('06:30', '22:30')]);
    const twice = {
      ...one,
      routineExceptions: [...one.routineExceptions, ...one.routineExceptions],
    };
    expect(validateHousehold(twice)).toContainEqual(
      expect.objectContaining({ path: 'routineExceptions.1', problem: 'duplicateId' }),
    );
    expect(() => withDay([])).toThrow();
  });
});
