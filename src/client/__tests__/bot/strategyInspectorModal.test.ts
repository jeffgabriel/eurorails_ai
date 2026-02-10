import * as React from 'react';
import { act } from 'react';
import * as ReactDOM from 'react-dom/client';
import { StrategyInspectorModal } from '../../lobby/components/bot/StrategyInspectorModal';
import type { StrategyAudit, ScoredOption, InfeasibleOption } from '../../../server/ai/types';
import { TrainType } from '../../../shared/types/GameTypes';
import { AIActionType } from '../../../server/ai/types';

// Radix Dialog uses portals; render into document.body
function renderToContainer(element: React.ReactElement): { container: HTMLDivElement; root: ReactDOM.Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function cleanup(container: HTMLDivElement, root: ReactDOM.Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function makeScoredOption(overrides: Partial<ScoredOption> = {}): ScoredOption {
  return {
    type: AIActionType.DeliverLoad,
    description: 'Deliver Wine to Vienna',
    feasible: true,
    params: { type: AIActionType.PassTurn },
    score: 87,
    rationale: 'Highest income per milepost',
    ...overrides,
  };
}

function makeRejectedOption(overrides: Partial<InfeasibleOption> = {}): InfeasibleOption {
  return {
    type: AIActionType.PickupAndDeliver,
    description: 'Pickup Steel in Birmingham',
    feasible: false,
    reason: 'All 3 Steel loads on other trains',
    ...overrides,
  };
}

function makeAudit(overrides: Partial<StrategyAudit> = {}): StrategyAudit {
  return {
    turnNumber: 14,
    archetypeName: 'Freight Optimizer',
    skillLevel: 'hard',
    snapshotHash: 'a3f8c2',
    currentPlan: 'Delivering Wine from Bordeaux to Vienna for 48M ECU.',
    archetypeRationale: 'I prioritize load combinations that share routes.',
    feasibleOptions: [
      makeScoredOption({ score: 87, description: 'Deliver Wine to Vienna' }),
      makeScoredOption({ score: 64, description: 'Pickup Coal in Essen' }),
      makeScoredOption({ score: 52, description: 'Build track: Zurich to Milan' }),
    ],
    rejectedOptions: [
      makeRejectedOption({ description: 'Deliver Machinery to London', reason: 'No track to London' }),
      makeRejectedOption({ description: 'Pickup Steel in Birmingham', reason: 'All loads on trains' }),
    ],
    selectedPlan: [
      makeScoredOption({ score: 87, description: 'Deliver Wine to Vienna' }),
    ],
    executionResult: { success: true, actionsExecuted: 1, durationMs: 1200 },
    botStatus: {
      cash: 127,
      trainType: TrainType.Freight,
      loads: ['Wine'],
      majorCitiesConnected: 3,
    },
    durationMs: 1200,
    ...overrides,
  };
}

describe('StrategyInspectorModal', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;

  afterEach(() => {
    if (container && root) cleanup(container, root);
  });

  it('should render "no data" message when audit is null', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: null,
      }),
    );
    container = result.container;
    root = result.root;

    const body = document.body;
    expect(body.textContent).toContain('No strategy data available');
  });

  it('should render archetype name in header', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
        botName: 'Bot Alpha',
      }),
    );
    container = result.container;
    root = result.root;

    // Bot name should appear in dialog title
    const body = document.body;
    expect(body.textContent).toContain('Bot Alpha');
  });

  it('should display skill level badge', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit({ skillLevel: 'hard' }),
      }),
    );
    container = result.container;
    root = result.root;

    const badge = document.querySelector('[data-slot="skill-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('Hard');
  });

  it('should render archetype philosophy quote', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit({ archetypeName: 'Freight Optimizer' }),
      }),
    );
    container = result.container;
    root = result.root;

    const body = document.body;
    expect(body.textContent).toContain('every milepost should earn money');
  });

  it('should display current plan section', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit({ currentPlan: 'Delivering Wine from Bordeaux to Vienna for 48M ECU.' }),
      }),
    );
    container = result.container;
    root = result.root;

    const planSection = document.querySelector('[data-slot="current-plan"]');
    expect(planSection).not.toBeNull();
    expect(planSection?.textContent).toContain('Delivering Wine from Bordeaux');
  });

  it('should display archetype rationale in current plan', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit({ archetypeRationale: 'I prioritize load combinations that share routes.' }),
      }),
    );
    container = result.container;
    root = result.root;

    const body = document.body;
    expect(body.textContent).toContain('load combinations that share routes');
  });

  it('should render options table with ranked options', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    const optionRows = document.querySelectorAll('[data-slot="option-row"]');
    expect(optionRows.length).toBe(3);
  });

  it('should show checkmark for top-ranked option', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    const firstOption = document.querySelector('[data-slot="option-row"]');
    expect(firstOption?.textContent).toContain('\u2705');
  });

  it('should display score values for options', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    const body = document.body;
    expect(body.textContent).toContain('87');
    expect(body.textContent).toContain('64');
    expect(body.textContent).toContain('52');
  });

  it('should render ScoreBar in options table', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    const scoreBars = document.querySelectorAll('[data-slot="score-bar"]');
    expect(scoreBars.length).toBe(3); // One per feasible option
  });

  it('should render rejected options section collapsed initially', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    const toggle = document.querySelector('[data-slot="rejected-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    // Rejected rows should not be visible
    const rejectedRows = document.querySelectorAll('[data-slot="rejected-row"]');
    expect(rejectedRows.length).toBe(0);
  });

  it('should expand rejected options on click', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    const toggle = document.querySelector('[data-slot="rejected-toggle"]') as HTMLButtonElement;
    act(() => {
      toggle.click();
    });

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rejectedRows = document.querySelectorAll('[data-slot="rejected-row"]');
    expect(rejectedRows.length).toBe(2);
  });

  it('should display rejection reasons', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    // Expand rejected section
    const toggle = document.querySelector('[data-slot="rejected-toggle"]') as HTMLButtonElement;
    act(() => {
      toggle.click();
    });

    const body = document.body;
    expect(body.textContent).toContain('No track to London');
    expect(body.textContent).toContain('All loads on trains');
  });

  it('should display bot status summary', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit(),
      }),
    );
    container = result.container;
    root = result.root;

    const statusSection = document.querySelector('[data-slot="bot-status"]');
    expect(statusSection).not.toBeNull();
    expect(statusSection?.textContent).toContain('127M ECU');
    expect(statusSection?.textContent).toContain('Freight');
    expect(statusSection?.textContent).toContain('Wine');
    expect(statusSection?.textContent).toContain('3'); // major cities
  });

  it('should display turn number and think time', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit({ turnNumber: 14, durationMs: 1200 }),
      }),
    );
    container = result.container;
    root = result.root;

    const statusSection = document.querySelector('[data-slot="bot-status"]');
    expect(statusSection?.textContent).toContain('14');
    expect(statusSection?.textContent).toContain('1.2s');
  });

  it('should show "No feasible options" message when list is empty', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit({ feasibleOptions: [] }),
      }),
    );
    container = result.container;
    root = result.root;

    const optionsTable = document.querySelector('[data-slot="options-table"]');
    expect(optionsTable?.textContent).toContain('No feasible options');
  });

  it('should not render rejected section when no rejected options', () => {
    const result = renderToContainer(
      React.createElement(StrategyInspectorModal, {
        open: true,
        onOpenChange: jest.fn(),
        audit: makeAudit({ rejectedOptions: [] }),
      }),
    );
    container = result.container;
    root = result.root;

    const toggle = document.querySelector('[data-slot="rejected-toggle"]');
    expect(toggle).toBeNull();
  });
});
