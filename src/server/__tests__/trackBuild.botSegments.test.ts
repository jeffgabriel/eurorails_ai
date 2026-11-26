import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import { _resetCache } from '../services/MapTopology';
import { planTrackBuild, TrackBuildEdge, TrackBuildPlan } from '../services/trackBuild';
import { getFerryEdges, getMajorCityGroups } from '../../shared/services/majorCityGroups';
import { TrackSegment } from '../../shared/types/GameTypes';

/**
 * Bots build through the same validation as humans (#308). The executor tests
 * mock `PlayerService.buildTrackForPlayer`, so this file checks the other half
 * on the real map: what the bot's segment builder produces is something the
 * server rules accept, and the server never charges more than the bot budgeted.
 */
describe('bot-built segments pass the server build rules', () => {
  beforeEach(() => _resetCache());

  const groups = getMajorCityGroups();
  const BOT_MONEY = 50;

  const toEdges = (segments: TrackSegment[]): TrackBuildEdge[] =>
    segments.map((seg: TrackSegment): TrackBuildEdge => ({
      from: { row: seg.from.row, col: seg.from.col },
      to: { row: seg.to.row, col: seg.to.col },
    }));

  const botCost = (segments: TrackSegment[]): number =>
    segments.reduce((sum: number, seg: TrackSegment): number => sum + seg.cost, 0);

  /** Validate a bot build against the server rules, as the bot's only build this turn. */
  function serverPlan(segments: TrackSegment[], existing: TrackSegment[]): TrackBuildPlan {
    return planTrackBuild({
      edges: toEdges(segments),
      ownSegments: existing,
      otherPlayersSegments: [],
      turnSpent: 0,
      unsettledCost: 0,
      money: BOT_MONEY,
      majorCityStartsThisTurn: [],
    });
  }

  function describeBuild(label: string, segments: TrackSegment[]): string {
    return `${label}: ${segments.map(s => `${s.from.row},${s.from.col}->${s.to.row},${s.to.col}`).join(' ')}`;
  }

  /** Returns a description of what went wrong, or null when the server accepts the build. */
  function check(label: string, segments: TrackSegment[], existing: TrackSegment[]): string | null {
    if (segments.length === 0) return null;
    try {
      const plan = serverPlan(segments, existing);
      if (plan.cost > botCost(segments)) {
        return `${describeBuild(label, segments)} — server charges ${plan.cost}, bot budgeted ${botCost(segments)}`;
      }
      return null;
    } catch (error) {
      return `${describeBuild(label, segments)} — ${(error as Error).message}`;
    }
  }

  it('cold-start builds from every major city, untargeted and targeted', () => {
    const problems: string[] = [];
    let builds = 0;
    for (let i = 0; i < groups.length; i++) {
      const start = groups[i];
      const target = groups[(i + 1) % groups.length].center;
      for (const [label, segments] of [
        [`${start.cityName} untargeted`, computeBuildSegments([start.center], [], 20)],
        [`${start.cityName} -> ${groups[(i + 1) % groups.length].cityName}`,
          computeBuildSegments([start.center], [], 20, 20, undefined, [target])],
      ] as Array<[string, TrackSegment[]]>) {
        if (segments.length > 0) builds++;
        const problem = check(label, segments, []);
        if (problem) problems.push(problem);
      }
    }
    expect(problems).toEqual([]);
    expect(builds).toBeGreaterThan(groups.length);
  });

  it('follow-up builds that extend the bot\'s own track over several turns', () => {
    const problems: string[] = [];
    let followUps = 0;
    for (let i = 0; i < groups.length; i++) {
      const start = groups[i];
      const target = groups[(i + 3) % groups.length].center;
      const existing: TrackSegment[] = [];
      for (let turn = 0; turn < 4; turn++) {
        const segments = computeBuildSegments(
          existing.length === 0 ? [start.center] : [], existing, 20, 20, undefined, [target],
        );
        if (segments.length === 0) break;
        if (turn > 0) followUps++;
        const problem = check(`${start.cityName} turn ${turn + 1}`, segments, existing);
        if (problem) {
          problems.push(problem);
          break;
        }
        // Carry the track forward exactly as the server would store it.
        existing.push(...serverPlan(segments, existing).segments.map(planned => planned.segment));
      }
    }
    expect(problems).toEqual([]);
    expect(followUps).toBeGreaterThan(groups.length);
  });

  it('builds to a ferry port, then on from the far port, paying for the line once', () => {
    const problems: string[] = [];
    let farSideBuilds = 0;
    for (const ferry of getFerryEdges()) {
      for (const [near, far] of [[ferry.pointA, ferry.pointB], [ferry.pointB, ferry.pointA]]) {
        const start = groups.find(group => {
          const toPort = computeBuildSegments([group.center], [], 300, 300, undefined, [near]);
          const last = toPort[toPort.length - 1];
          return last !== undefined && last.to.row === near.row && last.to.col === near.col;
        });
        if (!start) continue;

        // The bot's track to the near port (budget lifted: this is several turns of building).
        const toPort = computeBuildSegments([start.center], [], 300, 300, undefined, [near]);
        const existing = toPort.map(seg => ({ ...seg }));

        // Next turn: build toward a city, starting anywhere on the network — the far port included.
        for (const group of groups.slice(0, 6)) {
          const next = computeBuildSegments([], existing, 20, 20, undefined, [group.center]);
          if (next.length === 0) continue;
          if (next[0].from.row === far.row && next[0].from.col === far.col) farSideBuilds++;
          const problem = check(`${ferry.name} from ${start.cityName} toward ${group.cityName}`, next, existing);
          if (problem) problems.push(problem);
        }

        // Build into the far port itself: the bot has reached the line, so the server charges no ferry.
        const intoFar = computeBuildSegments([], existing, 20, 20, undefined, [far]);
        const last = intoFar[intoFar.length - 1];
        if (last && last.to.row === far.row && last.to.col === far.col) {
          const problem = check(`${ferry.name} into far port`, intoFar, existing);
          if (problem) problems.push(problem);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(farSideBuilds).toBeGreaterThan(0);
  });
});
