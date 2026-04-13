import * as fs from 'fs';
import * as path from 'path';
import {
  EventCard,
  EventCardType,
  EventEffectConfig,
  RawEventCard,
  StrikeEffect,
  DerailmentEffect,
  SnowEffect,
  FloodEffect,
  ExcessProfitTaxEffect,
} from '../EventCard';
import { TerrainType } from '../GameTypes';
import { CardDrawResult } from '../CardDrawResult';

describe('EventCard types', () => {
  describe('EventCardType enum', () => {
    it('should have exactly 5 values', () => {
      const values = Object.values(EventCardType);
      expect(values).toHaveLength(5);
    });

    it('should have expected string values', () => {
      expect(EventCardType.Strike).toBe('Strike');
      expect(EventCardType.Derailment).toBe('Derailment');
      expect(EventCardType.Snow).toBe('Snow');
      expect(EventCardType.Flood).toBe('Flood');
      expect(EventCardType.ExcessProfitTax).toBe('ExcessProfitTax');
    });
  });

  describe('EventEffectConfig discriminated union narrowing', () => {
    it('should narrow to StrikeEffect on Strike type', () => {
      const effect: EventEffectConfig = {
        type: EventCardType.Strike,
        variant: 'coastal',
        coastalRadius: 3,
      };

      // TypeScript type narrowing via switch
      switch (effect.type) {
        case EventCardType.Strike: {
          const strike: StrikeEffect = effect; // must narrow correctly
          expect(strike.variant).toBe('coastal');
          expect(strike.coastalRadius).toBe(3);
          break;
        }
        default:
          fail('Should have narrowed to Strike');
      }
    });

    it('should narrow to DerailmentEffect on Derailment type', () => {
      const effect: EventEffectConfig = {
        type: EventCardType.Derailment,
        cities: ['Paris', 'Berlin'],
        radius: 3,
      };

      switch (effect.type) {
        case EventCardType.Derailment: {
          const derail: DerailmentEffect = effect;
          expect(derail.cities).toEqual(['Paris', 'Berlin']);
          expect(derail.radius).toBe(3);
          break;
        }
        default:
          fail('Should have narrowed to Derailment');
      }
    });

    it('should narrow to SnowEffect on Snow type', () => {
      const effect: EventEffectConfig = {
        type: EventCardType.Snow,
        centerCity: 'Munchen',
        radius: 4,
        blockedTerrain: [TerrainType.Mountain],
      };

      switch (effect.type) {
        case EventCardType.Snow: {
          const snow: SnowEffect = effect;
          expect(snow.centerCity).toBe('Munchen');
          expect(snow.radius).toBe(4);
          expect(snow.blockedTerrain).toContain(TerrainType.Mountain);
          break;
        }
        default:
          fail('Should have narrowed to Snow');
      }
    });

    it('should narrow to FloodEffect on Flood type', () => {
      const effect: EventEffectConfig = {
        type: EventCardType.Flood,
        river: 'Rhein',
      };

      switch (effect.type) {
        case EventCardType.Flood: {
          const flood: FloodEffect = effect;
          expect(flood.river).toBe('Rhein');
          break;
        }
        default:
          fail('Should have narrowed to Flood');
      }
    });

    it('should narrow to ExcessProfitTaxEffect on ExcessProfitTax type', () => {
      const effect: EventEffectConfig = {
        type: EventCardType.ExcessProfitTax,
        brackets: [
          { threshold: 200, tax: 50 },
          { threshold: 0, tax: 0 },
        ],
      };

      switch (effect.type) {
        case EventCardType.ExcessProfitTax: {
          const tax: ExcessProfitTaxEffect = effect;
          expect(tax.brackets).toHaveLength(2);
          expect(tax.brackets[0].threshold).toBe(200);
          break;
        }
        default:
          fail('Should have narrowed to ExcessProfitTax');
      }
    });

    it('should be exhaustive — switch covers all 5 types', () => {
      const effects: EventEffectConfig[] = [
        { type: EventCardType.Strike, variant: 'rail' },
        { type: EventCardType.Derailment, cities: ['Paris'], radius: 3 },
        { type: EventCardType.Snow, centerCity: 'Torino', radius: 6, blockedTerrain: [TerrainType.Alpine] },
        { type: EventCardType.Flood, river: 'Elbe' },
        { type: EventCardType.ExcessProfitTax, brackets: [] },
      ];

      let covered = 0;
      for (const effect of effects) {
        switch (effect.type) {
          case EventCardType.Strike:
          case EventCardType.Derailment:
          case EventCardType.Snow:
          case EventCardType.Flood:
          case EventCardType.ExcessProfitTax:
            covered++;
            break;
        }
      }
      expect(covered).toBe(5);
    });
  });

  describe('CardDrawResult discriminated union', () => {
    it('should narrow to DemandCard on demand type', () => {
      const result: CardDrawResult = {
        type: 'demand',
        card: { id: 1, demands: [{ city: 'Berlin', resource: 'Cattle' as any, payment: 17 }, { city: 'Paris', resource: 'Beer' as any, payment: 23 }, { city: 'London', resource: 'Coal' as any, payment: 15 }] },
      };

      expect(result.type).toBe('demand');
      if (result.type === 'demand') {
        expect(result.card.id).toBe(1);
      }
    });

    it('should narrow to EventCard on event type', () => {
      const eventCard: EventCard = {
        id: 131,
        type: EventCardType.Snow,
        title: 'Snow!',
        description: 'Test',
        effectConfig: {
          type: EventCardType.Snow,
          centerCity: 'Munchen',
          radius: 4,
          blockedTerrain: [TerrainType.Mountain],
        },
      };

      const result: CardDrawResult = { type: 'event', card: eventCard };
      expect(result.type).toBe('event');
      if (result.type === 'event') {
        expect(result.card.id).toBe(131);
        expect(result.card.type).toBe(EventCardType.Snow);
      }
    });
  });
});

describe('event_cards.json configuration', () => {
  const EVENT_CARDS_PATH = path.join(process.cwd(), 'configuration', 'event_cards.json');

  let rawCards: RawEventCard[];

  beforeAll(() => {
    const jsonContent = fs.readFileSync(EVENT_CARDS_PATH, 'utf-8');
    rawCards = JSON.parse(jsonContent) as RawEventCard[];
  });

  it('should load exactly 20 event cards', () => {
    expect(rawCards).toHaveLength(20);
  });

  it('should have sequential IDs from 121 to 140', () => {
    const ids = rawCards.map((c) => c.id).sort((a, b) => a - b);
    const expected = Array.from({ length: 20 }, (_, i) => 121 + i);
    expect(ids).toEqual(expected);
  });

  it('should have 3 Strike cards (#121, #122, #123)', () => {
    const strikes = rawCards.filter((c) => c.type === EventCardType.Strike);
    expect(strikes).toHaveLength(3);
    const strikeIds = strikes.map((c) => c.id).sort((a, b) => a - b);
    expect(strikeIds).toEqual([121, 122, 123]);
  });

  it('should have 1 ExcessProfitTax card (#124)', () => {
    const taxCards = rawCards.filter((c) => c.type === EventCardType.ExcessProfitTax);
    expect(taxCards).toHaveLength(1);
    expect(taxCards[0].id).toBe(124);
  });

  it('should have 5 Derailment cards (#125-#129)', () => {
    const derailments = rawCards.filter((c) => c.type === EventCardType.Derailment);
    expect(derailments).toHaveLength(5);
    const ids = derailments.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual([125, 126, 127, 128, 129]);
  });

  it('should have 3 Snow cards (#130-#132)', () => {
    const snowCards = rawCards.filter((c) => c.type === EventCardType.Snow);
    expect(snowCards).toHaveLength(3);
    const ids = snowCards.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual([130, 131, 132]);
  });

  it('should have 8 Flood cards (#133-#140)', () => {
    const floodCards = rawCards.filter((c) => c.type === EventCardType.Flood);
    expect(floodCards).toHaveLength(8);
    const ids = floodCards.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual([133, 134, 135, 136, 137, 138, 139, 140]);
  });

  it('should have correct Snow card configurations per rulebook', () => {
    const card130 = rawCards.find((c) => c.id === 130)!;
    const card131 = rawCards.find((c) => c.id === 131)!;
    const card132 = rawCards.find((c) => c.id === 132)!;

    expect(card130.effectConfig).toMatchObject({
      type: EventCardType.Snow,
      centerCity: 'Torino',
      radius: 6,
      blockedTerrain: [TerrainType.Alpine],
    });
    expect(card131.effectConfig).toMatchObject({
      type: EventCardType.Snow,
      centerCity: 'Munchen',
      radius: 4,
      blockedTerrain: [TerrainType.Mountain],
    });
    expect(card132.effectConfig).toMatchObject({
      type: EventCardType.Snow,
      centerCity: 'Praha',
      radius: 4,
      blockedTerrain: [TerrainType.Mountain],
    });
  });

  it('should have correct coastal Strike configurations with radius 3 for #121 and #122', () => {
    const card121 = rawCards.find((c) => c.id === 121)!;
    const card122 = rawCards.find((c) => c.id === 122)!;

    expect(card121.effectConfig).toMatchObject({
      type: EventCardType.Strike,
      variant: 'coastal',
      coastalRadius: 3,
    });
    expect(card122.effectConfig).toMatchObject({
      type: EventCardType.Strike,
      variant: 'coastal',
      coastalRadius: 3,
    });
  });

  it('should have correct rail Strike configuration for #123', () => {
    const card123 = rawCards.find((c) => c.id === 123)!;

    expect(card123.effectConfig).toMatchObject({
      type: EventCardType.Strike,
      variant: 'rail',
      affectsDrawingPlayerOnly: true,
    });
  });

  it('should have valid Flood card river names matching rivers.json', () => {
    // Load rivers.json to validate names
    const riversPath = path.join(process.cwd(), 'configuration', 'rivers.json');
    const rivers: Array<{ Name: string }> = JSON.parse(fs.readFileSync(riversPath, 'utf-8'));
    const validRiverNames = new Set(rivers.map((r) => r.Name));

    const floodCards = rawCards.filter((c) => c.type === EventCardType.Flood);
    for (const card of floodCards) {
      const effect = card.effectConfig as FloodEffect;
      expect(validRiverNames.has(effect.river)).toBe(true);
    }
  });

  it('should have 8 distinct rivers in Flood cards', () => {
    const floodCards = rawCards.filter((c) => c.type === EventCardType.Flood);
    const rivers = new Set(floodCards.map((c) => (c.effectConfig as FloodEffect).river));
    expect(rivers.size).toBe(8);
  });

  it('should have all cards with non-empty title and description', () => {
    for (const card of rawCards) {
      expect(card.title).toBeTruthy();
      expect(card.description).toBeTruthy();
    }
  });

  it('should have ExcessProfitTax card with tax brackets', () => {
    const taxCard = rawCards.find((c) => c.type === EventCardType.ExcessProfitTax)!;
    const effect = taxCard.effectConfig as ExcessProfitTaxEffect;
    expect(effect.brackets).toBeDefined();
    expect(effect.brackets.length).toBeGreaterThan(0);
    // Verify bracket structure
    for (const bracket of effect.brackets) {
      expect(typeof bracket.threshold).toBe('number');
      expect(typeof bracket.tax).toBe('number');
    }
  });

  it('should have all Derailment cards with cities array and radius 3', () => {
    const derailments = rawCards.filter((c) => c.type === EventCardType.Derailment);
    for (const card of derailments) {
      const effect = card.effectConfig as DerailmentEffect;
      expect(effect.cities).toBeDefined();
      expect(effect.cities.length).toBeGreaterThan(0);
      expect(effect.radius).toBe(3);
    }
  });
});
