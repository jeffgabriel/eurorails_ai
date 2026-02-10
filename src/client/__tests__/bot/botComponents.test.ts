import * as React from 'react';
import { act } from 'react';
import * as ReactDOM from 'react-dom/client';
import { BotIcon } from '../../lobby/components/bot/BotIcon';
import { ArchetypeBadge } from '../../lobby/components/bot/ArchetypeBadge';
import { BrainIcon } from '../../lobby/components/bot/BrainIcon';
import { ScoreBar } from '../../lobby/components/bot/ScoreBar';
import {
  getArchetypeColors,
  getArchetypeAbbreviation,
  ARCHETYPE_COLORS,
  ARCHETYPE_ABBREVIATIONS,
} from '../../lobby/components/bot/archetypeColors';
import type { ArchetypeId } from '../../../server/ai/types';

// Helper to render a React element into a DOM container
function renderToContainer(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  act(() => {
    root.render(element);
  });
  return container;
}

function cleanup(container: HTMLDivElement): void {
  const root = ReactDOM.createRoot(container);
  act(() => {
    root.unmount();
  });
  container.remove();
}

const ALL_ARCHETYPES: ArchetypeId[] = [
  'backbone_builder',
  'freight_optimizer',
  'trunk_sprinter',
  'continental_connector',
  'opportunist',
];

describe('archetypeColors', () => {
  it('should define colors for all archetypes', () => {
    for (const id of ALL_ARCHETYPES) {
      const colors = getArchetypeColors(id);
      expect(colors).toBeDefined();
      expect(colors.bg).toBeTruthy();
      expect(colors.text).toBeTruthy();
      expect(colors.border).toBeTruthy();
      expect(colors.fill).toBeTruthy();
    }
  });

  it('should define abbreviations for all archetypes', () => {
    for (const id of ALL_ARCHETYPES) {
      const abbr = getArchetypeAbbreviation(id);
      expect(abbr).toBeTruthy();
      expect(abbr.length).toBeLessThanOrEqual(2);
    }
  });

  it('should have unique abbreviations', () => {
    const abbrs = ALL_ARCHETYPES.map(getArchetypeAbbreviation);
    expect(new Set(abbrs).size).toBe(abbrs.length);
  });

  it('should have unique color schemes per archetype', () => {
    const fills = ALL_ARCHETYPES.map((id) => getArchetypeColors(id).fill);
    expect(new Set(fills).size).toBe(fills.length);
  });
});

describe('BotIcon', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container) cleanup(container);
  });

  it('should render an SVG element', () => {
    container = renderToContainer(React.createElement(BotIcon));
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('should have aria-label for accessibility', () => {
    container = renderToContainer(React.createElement(BotIcon));
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-label')).toBe('Bot player');
  });
});

describe('ArchetypeBadge', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container) cleanup(container);
  });

  it('should render the archetype abbreviation', () => {
    container = renderToContainer(
      React.createElement(ArchetypeBadge, { archetype: 'backbone_builder' }),
    );
    const badge = container.querySelector('[data-slot="archetype-badge"]');
    expect(badge?.textContent).toBe('BB');
  });

  it('should render different abbreviations for each archetype', () => {
    for (const id of ALL_ARCHETYPES) {
      const c = renderToContainer(
        React.createElement(ArchetypeBadge, { archetype: id }),
      );
      const badge = c.querySelector('[data-slot="archetype-badge"]');
      expect(badge?.textContent).toBe(getArchetypeAbbreviation(id));
      cleanup(c);
    }
  });
});

describe('BrainIcon', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container) cleanup(container);
  });

  it('should render a button element', () => {
    const onClick = jest.fn();
    container = renderToContainer(
      React.createElement(BrainIcon, { onClick }),
    );
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
  });

  it('should call onClick when clicked', () => {
    const onClick = jest.fn();
    container = renderToContainer(
      React.createElement(BrainIcon, { onClick }),
    );
    const button = container.querySelector('button')!;
    act(() => {
      button.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('should have aria-label for accessibility', () => {
    const onClick = jest.fn();
    container = renderToContainer(
      React.createElement(BrainIcon, { onClick }),
    );
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('View bot strategy');
  });

  it('should apply animate-pulse class when isPulsing is true', () => {
    const onClick = jest.fn();
    container = renderToContainer(
      React.createElement(BrainIcon, { onClick, isPulsing: true }),
    );
    const button = container.querySelector('button')!;
    expect(button.className).toContain('animate-pulse');
  });

  it('should not apply animate-pulse class when isPulsing is false', () => {
    const onClick = jest.fn();
    container = renderToContainer(
      React.createElement(BrainIcon, { onClick, isPulsing: false }),
    );
    const button = container.querySelector('button')!;
    expect(button.className).not.toContain('animate-pulse');
  });
});

describe('ScoreBar', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container) cleanup(container);
  });

  it('should render with role="meter"', () => {
    container = renderToContainer(
      React.createElement(ScoreBar, { score: 50 }),
    );
    const meter = container.querySelector('[role="meter"]');
    expect(meter).not.toBeNull();
  });

  it('should have correct ARIA attributes', () => {
    container = renderToContainer(
      React.createElement(ScoreBar, { score: 75, maxScore: 100 }),
    );
    const meter = container.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('75');
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    expect(meter.getAttribute('aria-label')).toBe('Score: 75 of 100');
  });

  it('should render bar width proportional to score', () => {
    container = renderToContainer(
      React.createElement(ScoreBar, { score: 60, maxScore: 100 }),
    );
    const bar = container.querySelector('[data-slot="score-bar"] > div') as HTMLDivElement;
    expect(bar?.style.width).toBe('60%');
  });

  it('should clamp bar width to 100%', () => {
    container = renderToContainer(
      React.createElement(ScoreBar, { score: 150, maxScore: 100 }),
    );
    const bar = container.querySelector('[data-slot="score-bar"] > div') as HTMLDivElement;
    expect(bar?.style.width).toBe('100%');
  });

  it('should handle zero maxScore gracefully', () => {
    container = renderToContainer(
      React.createElement(ScoreBar, { score: 50, maxScore: 0 }),
    );
    const bar = container.querySelector('[data-slot="score-bar"] > div') as HTMLDivElement;
    expect(bar?.style.width).toBe('0%');
  });

  it('should clamp negative scores to 0%', () => {
    container = renderToContainer(
      React.createElement(ScoreBar, { score: -10, maxScore: 100 }),
    );
    const bar = container.querySelector('[data-slot="score-bar"] > div') as HTMLDivElement;
    expect(bar?.style.width).toBe('0%');
  });
});
