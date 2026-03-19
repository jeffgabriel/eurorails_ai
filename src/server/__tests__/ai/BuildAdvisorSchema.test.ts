import { BUILD_ADVISOR_SCHEMA } from '../../services/ai/schemas';
import Ajv from 'ajv';

const ajv = new Ajv();
const validate = ajv.compile(BUILD_ADVISOR_SCHEMA);

describe('BUILD_ADVISOR_SCHEMA', () => {
  it('should accept a valid build action', () => {
    const data = {
      action: 'build',
      target: 'Paris',
      waypoints: [[10, 20], [11, 21]],
      reasoning: 'Building toward Paris for delivery',
    };
    expect(validate(data)).toBe(true);
  });

  it('should accept a valid replan action with newRoute', () => {
    const data = {
      action: 'replan',
      target: 'Berlin',
      waypoints: [[5, 10]],
      newRoute: [
        { action: 'pickup', load: 'Steel', city: 'Ruhr' },
        { action: 'deliver', load: 'Steel', city: 'Berlin', demandCardId: 42, payment: 15 },
      ],
      reasoning: 'Replanning to more profitable route',
    };
    expect(validate(data)).toBe(true);
  });

  it('should accept a valid buildAlternative action with alternativeBuild', () => {
    const data = {
      action: 'buildAlternative',
      target: 'Roma',
      waypoints: [[20, 30]],
      alternativeBuild: {
        target: 'Milano',
        waypoints: [[18, 28], [19, 29]],
      },
      reasoning: 'Alternative build toward Milano is cheaper',
    };
    expect(validate(data)).toBe(true);
  });

  it('should accept a valid useOpponentTrack action', () => {
    const data = {
      action: 'useOpponentTrack',
      target: 'London',
      waypoints: [],
      reasoning: 'Opponent track reaches London, cheaper to use',
    };
    expect(validate(data)).toBe(true);
  });

  it('should reject missing required fields', () => {
    const data = {
      action: 'build',
      target: 'Paris',
      // missing waypoints and reasoning
    };
    expect(validate(data)).toBe(false);
  });

  it('should reject invalid action type', () => {
    const data = {
      action: 'skip',
      target: 'Paris',
      waypoints: [],
      reasoning: 'Skipping',
    };
    expect(validate(data)).toBe(false);
  });

  it('should reject waypoints with wrong tuple size', () => {
    const data = {
      action: 'build',
      target: 'Paris',
      waypoints: [[10, 20, 30]], // 3 elements, should be 2
      reasoning: 'Bad waypoint',
    };
    expect(validate(data)).toBe(false);
  });

  it('should reject newRoute with missing required fields', () => {
    const data = {
      action: 'replan',
      target: 'Berlin',
      waypoints: [],
      newRoute: [
        { action: 'pickup' }, // missing load and city
      ],
      reasoning: 'Bad route',
    };
    expect(validate(data)).toBe(false);
  });

  it('should reject alternativeBuild with missing target', () => {
    const data = {
      action: 'buildAlternative',
      target: 'Roma',
      waypoints: [],
      alternativeBuild: {
        waypoints: [[1, 2]],
        // missing target
      },
      reasoning: 'Bad alternative',
    };
    expect(validate(data)).toBe(false);
  });
});
