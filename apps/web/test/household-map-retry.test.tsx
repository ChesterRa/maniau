// @vitest-environment happy-dom
// 地図の表示に一度失敗しても、「場所を読み直す」で同じ画面に戻れる（地図は代役）。

import { Household } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { HouseholdMapCard } from '../src/household-map';
import i18n from '../src/i18n';
import type { Ctx } from '../src/screens';
import { step } from './fake-fetch';

it('地図の一時的な表示失敗は、場所を読み直すと回復する', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let attempts = 0;
  (window as unknown as { google: unknown }).google = {
    maps: {
      Map: class {
        constructor(element: HTMLElement) {
          attempts++;
          if (attempts === 1) throw new Error('map unavailable');
          element.dataset.ready = 'yes';
        }
        fitBounds() {}
        panTo() {}
      },
      LatLngBounds: class {
        extend() {}
      },
      marker: {
        AdvancedMarkerElement: class {
          map: unknown;
          constructor(options: { map: unknown }) {
            this.map = options.map;
          }
          addEventListener() {}
        },
      },
    },
  };
  const household = Household.parse({
    id: 'trial-own',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      { id: 'a1', kind: 'adult', name: '大人A' },
      { id: 'c1', kind: 'child', name: '子H' },
    ],
    places: [{ id: 'home', kind: 'home', name: '家', googlePlaceId: 'g-fixture' }],
    routines: [],
    careOptions: [],
  });
  const place = household.places[0];
  if (!place) throw new Error('場所が無い');
  const ctx = {
    lang: 'ja',
    t: i18n.getFixedT('ja'),
    household,
    maps: {
      key: 'fake-key',
      walk: async () => undefined,
      householdMap: async () => ({
        status: 'ok',
        map: {
          points: [
            {
              id: place.id,
              googlePlaceId: 'g-fixture',
              location: { latitude: 35, longitude: 139 },
            },
          ],
          failed: [],
          omitted: [],
        },
      }),
    },
  } as unknown as Ctx;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  try {
    await step(() => root.render(<HouseholdMapCard ctx={ctx} />));
    await step(() => button('地図を開く')?.click());
    expect(host.textContent).toContain('地図を表示できませんでした');
    expect(attempts).toBe(1);
    await step(() => button('場所を読み直す')?.click());
    expect(attempts).toBe(2);
    expect(host.textContent).not.toContain('地図を表示できませんでした');
    expect(host.querySelector('[data-ready="yes"]')).not.toBeNull();
  } finally {
    await step(() => root.unmount());
    host.remove();
  }
});
