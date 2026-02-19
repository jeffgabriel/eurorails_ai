/**
 * GameStateSerializer - Bridges structured game state and LLM-readable prompts.
 *
 * Design principles (from technical-spec.md Section 5):
 * 1. Pre-compute everything numerical. The LLM picks strategy; never calculates.
 * 2. Use city names, not coordinates. "Lyon" not "row 32 col 24".
 * 3. Include decision-relevant context only. No DB IDs, pixel positions, raw hex data.
 * 4. Scale information to skill level. Easy = simplified. Hard = full intelligence.
 */

import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  BotMemoryState,
  BotSkillLevel,
  TrackSegment,
  TrainType,
  TRAIN_PROPERTIES,
  OpponentSnapshot,
} from '../../../shared/types/GameTypes';
import { loadGridPoints, GridPointData } from './MapTopology';
import { getMajorCityGroups } from '../../../shared/services/majorCityGroups';
import { OptionGenerator, DemandChain } from './OptionGenerator';

/** Maximum options shown per skill level */
const MAX_OPTIONS: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 4,
  [BotSkillLevel.Medium]: 8,
  [BotSkillLevel.Hard]: Infinity,
};

export class GameStateSerializer {
  /**
   * Serialize the full game state into an LLM user prompt.
   *
   * Follows the template from prompt-catalog.md Section 3:
   * - YOUR STATUS block
   * - YOUR DEMAND CARDS block
   * - OPPONENTS block (Medium/Hard only)
   * - MOVEMENT OPTIONS block
   * - BUILD OPTIONS block
   */
  static serialize(
    snapshot: WorldSnapshot,
    moveOptions: FeasibleOption[],
    buildOptions: FeasibleOption[],
    memory: BotMemoryState,
    skillLevel: BotSkillLevel,
  ): string {
    const lines: string[] = [];

    const phase = GameStateSerializer.getGamePhase(snapshot.turnNumber);
    lines.push(`TURN ${snapshot.turnNumber} \u2014 GAME PHASE: ${phase}`);
    lines.push('');

    if (snapshot.gameStatus !== 'active') {
      lines.push('INITIAL BUILD PHASE: You have 2 build turns before your train is placed.');
      lines.push('Choose a starting direction that:');
      lines.push('- Serves MULTIPLE demand chains (not just the single highest-paying one)');
      lines.push('- Starts from a CENTRAL hub (Ruhr, Berlin, Paris, Holland) for maximum future flexibility');
      lines.push('- Builds toward your best pickup city to enable your first delivery quickly');
      lines.push('Movement options are empty during initial build — focus entirely on build direction.');
      lines.push('');
    }

    // YOUR STATUS
    lines.push(...GameStateSerializer.buildStatusSection(snapshot, memory));
    lines.push('');

    // GEOGRAPHY
    lines.push(...GameStateSerializer.buildGeographySection(snapshot));
    lines.push('');

    // DEMAND CHAIN ANALYSIS
    const rankedChains = OptionGenerator.getRankedChains(snapshot, memory);
    lines.push(...GameStateSerializer.buildChainAnalysisSection(rankedChains, snapshot));
    lines.push('');

    // YOUR DEMAND CARDS
    lines.push(...GameStateSerializer.buildDemandSection(snapshot));
    lines.push('');

    // OPPONENTS (Medium/Hard only)
    if (skillLevel !== BotSkillLevel.Easy && snapshot.opponents && snapshot.opponents.length > 0) {
      lines.push(...GameStateSerializer.buildOpponentSection(snapshot.opponents, skillLevel));
      lines.push('');
    }

    // MOVEMENT OPTIONS
    const maxOpts = MAX_OPTIONS[skillLevel];
    const feasibleMoves = moveOptions.filter(o => o.feasible);
    const cappedMoves = feasibleMoves.slice(0, maxOpts);
    lines.push('MOVEMENT OPTIONS (pick one by moveOption index, or -1 to stay):');
    if (cappedMoves.length === 0) {
      lines.push('No movement options available. Use -1 to skip.');
    } else {
      for (let i = 0; i < cappedMoves.length; i++) {
        lines.push(GameStateSerializer.describeMoveOption(cappedMoves[i], i, snapshot));
      }
    }
    lines.push('');

    // BUILD OPTIONS — presented in original order (matching the index that
    // LLMStrategyBrain maps back to feasibleBuilds). Neutral ordering was
    // causing a critical index mismatch: LLM saw alphabetical indices but
    // the engine resolved against the original unsorted array.
    const feasibleBuilds = buildOptions.filter(o => o.feasible);
    const cappedBuilds = feasibleBuilds.slice(0, maxOpts);
    lines.push('BUILD OPTIONS (pick one by buildOption index):');
    for (let i = 0; i < cappedBuilds.length; i++) {
      lines.push(GameStateSerializer.describeBuildOption(cappedBuilds[i], i, snapshot, rankedChains, memory));
    }

    return lines.join('\n');
  }

  /**
   * Serialize a plan selection prompt for the LLM.
   * Shows ranked demand chains and asks the LLM to pick ONE chain to pursue.
   * Simpler than the full options prompt — LLM picks strategy, not individual moves.
   */
  static serializePlanSelectionPrompt(
    snapshot: WorldSnapshot,
    memory: BotMemoryState,
    skillLevel: BotSkillLevel,
  ): string {
    const lines: string[] = [];

    lines.push(`TURN ${snapshot.turnNumber} — PLAN SELECTION`);
    lines.push('');

    // YOUR STATUS
    lines.push(...GameStateSerializer.buildStatusSection(snapshot, memory));
    lines.push('');

    // RANKED CHAINS
    const rankedChains = OptionGenerator.getRankedChains(snapshot, memory);
    const top5 = rankedChains.slice(0, 5);

    lines.push('AVAILABLE DELIVERY CHAINS (ranked by achievability):');
    lines.push('Pick ONE chain to commit to. You will execute it over multiple turns.');
    lines.push('');

    for (let i = 0; i < top5.length; i++) {
      const c = top5[i];
      const pickup = c.hasLoad ? '(already carrying)' : c.pickupCity;
      const costStr = c.estimatedBuildCost > 0
        ? `~${Math.round(c.estimatedBuildCost)}M build cost`
        : 'no build needed';
      const turnsStr = c.estimatedTotalTurns ? `~${c.estimatedTotalTurns} turns` : '';
      const feasStr = c.budgetFeasibility === 'tight' ? ' [TIGHT BUDGET]'
        : c.budgetFeasibility === 'unachievable' ? ' [UNAFFORDABLE]' : '';
      const sharedStr = c.sharedChainCount && c.sharedChainCount > 0
        ? ` Shared track with ${c.sharedChainCount} other demand${c.sharedChainCount > 1 ? 's' : ''}.`
        : '';

      lines.push(`[${i}] ${c.loadType}: ${pickup} → ${c.deliveryCity} — ${c.payment}M payout`);
      lines.push(`    ${costStr}, ${turnsStr}${feasStr}${sharedStr}`);
    }

    if (top5.length === 0) {
      lines.push('No viable delivery chains available.');
    }

    lines.push('');
    lines.push('Pick the chain index that maximizes income-per-turn while staying within budget.');

    return lines.join('\n');
  }

  /**
   * Minimal serialization for retry fallback.
   * Max 4 options, no opponents, no memory details.
   */
  static serializeMinimal(
    snapshot: WorldSnapshot,
    moveOptions: FeasibleOption[],
    buildOptions: FeasibleOption[],
  ): string {
    const lines: string[] = [];

    lines.push(`TURN ${snapshot.turnNumber}`);
    lines.push('');

    const position = GameStateSerializer.resolvePositionName(snapshot);
    const trainType = snapshot.bot.trainType as TrainType;
    const props = TRAIN_PROPERTIES[trainType];
    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${snapshot.bot.money}M ECU`);
    lines.push(`- Train: ${GameStateSerializer.formatTrainType(trainType)} (speed ${props?.speed ?? 9}, capacity ${props?.capacity ?? 2})`);
    lines.push(`- Position: ${position}`);
    lines.push(`- Loads: ${snapshot.bot.loads.length > 0 ? snapshot.bot.loads.join(', ') : 'empty'}`);
    lines.push('');

    // Demand cards (simplified)
    lines.push('YOUR DEMAND CARDS:');
    for (let i = 0; i < snapshot.bot.resolvedDemands.length; i++) {
      const rd = snapshot.bot.resolvedDemands[i];
      const demandStrs = rd.demands.map(d => {
        const sourceCities = GameStateSerializer.getSourceCities(d.loadType, snapshot.loadAvailability);
        const pickup = sourceCities.length > 0 ? ` [pickup: ${sourceCities.join(', ')}]` : '';
        return `${d.loadType}${pickup} \u2192 ${d.city} (${d.payment}M)`;
      });
      lines.push(`Card ${i + 1}: ${demandStrs.join(' | ')}`);
    }
    lines.push('');

    // Movement options (max 4)
    const feasibleMoves = moveOptions.filter(o => o.feasible).slice(0, 4);
    lines.push('MOVEMENT OPTIONS (pick one by moveOption index, or -1 to stay):');
    if (feasibleMoves.length === 0) {
      lines.push('No movement options available. Use -1 to skip.');
    } else {
      for (let i = 0; i < feasibleMoves.length; i++) {
        lines.push(GameStateSerializer.describeMoveOption(feasibleMoves[i], i, snapshot));
      }
    }
    lines.push('');

    // Build options (max 4)
    const feasibleBuilds = buildOptions.filter(o => o.feasible).slice(0, 4);
    lines.push('BUILD OPTIONS (pick one by buildOption index):');
    for (let i = 0; i < feasibleBuilds.length; i++) {
      lines.push(GameStateSerializer.describeBuildOption(feasibleBuilds[i], i, snapshot));
    }

    return lines.join('\n');
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private static buildStatusSection(snapshot: WorldSnapshot, memory: BotMemoryState): string[] {
    const lines: string[] = [];
    const position = GameStateSerializer.resolvePositionName(snapshot);
    const trainType = snapshot.bot.trainType as TrainType;
    const props = TRAIN_PROPERTIES[trainType];
    const speed = props?.speed ?? 9;
    const capacity = props?.capacity ?? 2;

    const connectedCities = GameStateSerializer.getConnectedCityNames(snapshot);
    const trackSummary = GameStateSerializer.summarizeTrackNetwork(snapshot);
    const memorySummary = GameStateSerializer.summarizeMemory(memory);

    lines.push('YOUR STATUS:');
    lines.push(`- Cash: ${snapshot.bot.money}M ECU`);
    lines.push(`- Train: ${GameStateSerializer.formatTrainType(trainType)} (speed ${speed}, capacity ${capacity})`);
    lines.push(`- Position: ${position}`);
    lines.push(`- Loads on train: ${snapshot.bot.loads.length > 0 ? snapshot.bot.loads.join(', ') : 'empty'}`);
    lines.push(`- Connected major cities: ${snapshot.bot.connectedMajorCityCount}/8${connectedCities ? ` (${connectedCities})` : ''}`);
    lines.push(`- Track network: ${trackSummary}`);
    lines.push(`- Memory: ${memorySummary}`);

    return lines;
  }

  /**
   * Build a geography context section showing major city regions and current track reach.
   */
  private static buildGeographySection(snapshot: WorldSnapshot): string[] {
    const lines: string[] = [];
    const connectedCities = GameStateSerializer.getConnectedCityNames(snapshot);

    lines.push('GEOGRAPHY (major cities and centrality):');
    lines.push('Central Europe (best starting area): Berlin, Ruhr, Paris, Holland');
    lines.push('Southern Europe: Milano, Madrid');
    lines.push('Eastern Europe: Wien, Istanbul');
    lines.push(`Your track currently reaches: ${connectedCities || 'no track built'}`);
    lines.push('Tip: Central hubs give access to more demand targets and reusable track corridors.');

    return lines;
  }

  /**
   * Build a demand chain analysis section showing ranked chains with feasibility and overlap.
   */
  private static buildChainAnalysisSection(chains: DemandChain[], snapshot: WorldSnapshot): string[] {
    if (chains.length === 0) return [];

    const lines: string[] = [];
    lines.push(`DEMAND CHAIN ANALYSIS (your ${snapshot.bot.resolvedDemands.length * 3} demands ranked by achievability):`);

    const achievable = chains.filter(c => c.budgetFeasibility !== 'unachievable');
    const unachievable = chains.filter(c => c.budgetFeasibility === 'unachievable');

    if (achievable.length > 0) {
      lines.push('Best chains:');
      for (let i = 0; i < Math.min(achievable.length, 5); i++) {
        const c = achievable[i];
        const pickup = c.hasLoad ? '(carrying)' : `${c.pickupCity}`;
        const costStr = c.estimatedBuildCost > 0
          ? `build cost ~${Math.round(c.estimatedBuildCost)}M`
          : 'no build needed';
        const turnsStr = c.estimatedTotalTurns ? `${c.estimatedTotalTurns} turns` : '';
        const feasStr = c.budgetFeasibility === 'tight' ? ' TIGHT BUDGET.' : '';
        const sharedStr = c.sharedChainCount && c.sharedChainCount > 0
          ? ` SHARED — serves ${c.sharedChainCount} other demand${c.sharedChainCount > 1 ? 's' : ''} nearby.`
          : ' Dead-end — no other demands nearby.';
        lines.push(`${i + 1}. ${c.loadType}@${pickup} → ${c.deliveryCity} (${c.payment}M) — ${costStr}, ${turnsStr}.${feasStr}${sharedStr}`);
      }
    }

    if (unachievable.length > 0) {
      lines.push('Unachievable with current budget:');
      for (const c of unachievable.slice(0, 3)) {
        const pickup = c.hasLoad ? '(carrying)' : `${c.pickupCity}`;
        lines.push(`- ${c.loadType}@${pickup} → ${c.deliveryCity} (${c.payment}M) — needs ~${Math.round(c.estimatedBuildCost)}M track, you have ${snapshot.bot.money}M.`);
      }
    }

    return lines;
  }

  private static buildDemandSection(snapshot: WorldSnapshot): string[] {
    const lines: string[] = [];
    lines.push('YOUR DEMAND CARDS:');

    for (let i = 0; i < snapshot.bot.resolvedDemands.length; i++) {
      const rd = snapshot.bot.resolvedDemands[i];
      const demandStrs = rd.demands.map(d => {
        const hasLoad = snapshot.bot.loads.includes(d.loadType);
        const annotation = hasLoad ? ', ON TRAIN' : '';
        const sourceCities = GameStateSerializer.getSourceCities(d.loadType, snapshot.loadAvailability);
        const pickup = sourceCities.length > 0 ? ` [pickup: ${sourceCities.join(', ')}]` : '';
        return `${d.loadType}${pickup} \u2192 ${d.city} (${d.payment}M${annotation})`;
      });
      lines.push(`Card ${i + 1}: ${demandStrs.join(' | ')}`);
    }

    return lines;
  }

  private static buildOpponentSection(opponents: OpponentSnapshot[], skillLevel: BotSkillLevel): string[] {
    const lines: string[] = [];
    lines.push('OPPONENTS:');

    for (const opp of opponents) {
      const position = GameStateSerializer.resolveOpponentPosition(opp);

      if (skillLevel === BotSkillLevel.Medium) {
        // Medium: position + cash only
        lines.push(`- ${opp.playerId.slice(0, 8)}: ${opp.money}M, at ${position}`);
      } else {
        // Hard: full competitive intelligence
        const trainLabel = GameStateSerializer.formatTrainType(opp.trainType as TrainType);
        const loads = opp.loads.length > 0 ? `, carrying ${opp.loads.join(', ')}` : '';
        const track = opp.trackSummary ? `. Track covers ${opp.trackSummary}` : '';
        lines.push(`- ${opp.playerId.slice(0, 8)}: ${opp.money}M, ${trainLabel}, at ${position}${loads}${track}.`);
      }
    }

    return lines;
  }

  /**
   * Resolve the bot's position to a city name or descriptive string.
   * Never exposes raw coordinates to the LLM.
   */
  private static resolvePositionName(snapshot: WorldSnapshot): string {
    if (!snapshot.bot.position) return 'not placed';

    const grid = loadGridPoints();
    const key = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
    const point = grid.get(key);

    if (point?.name) return point.name;

    // Not at a named city - find nearest city
    return GameStateSerializer.findNearestCityDescription(
      snapshot.bot.position.row,
      snapshot.bot.position.col,
      grid,
    );
  }

  /**
   * Resolve an opponent's position to a city name.
   */
  private static resolveOpponentPosition(opp: OpponentSnapshot): string {
    if (!opp.position) return 'not placed';

    const grid = loadGridPoints();
    const key = `${opp.position.row},${opp.position.col}`;
    const point = grid.get(key);

    if (point?.name) return point.name;

    return GameStateSerializer.findNearestCityDescription(
      opp.position.row,
      opp.position.col,
      grid,
    );
  }

  /**
   * Find the nearest named city and describe position relative to it.
   * Returns "near X" or "in transit" if no city is reasonably close.
   */
  private static findNearestCityDescription(
    row: number,
    col: number,
    grid: Map<string, GridPointData>,
  ): string {
    let nearestName: string | null = null;
    let nearestDist = Infinity;

    for (const [, point] of grid) {
      if (!point.name) continue;
      const dist = Math.sqrt((point.row - row) ** 2 + (point.col - col) ** 2);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestName = point.name;
      }
    }

    if (nearestName && nearestDist <= 5) {
      return `near ${nearestName}`;
    }

    return 'in transit';
  }

  /**
   * Get names of major cities connected by the bot's track network.
   */
  private static getConnectedCityNames(snapshot: WorldSnapshot): string {
    if (snapshot.bot.existingSegments.length === 0) return '';

    const groups = getMajorCityGroups();
    const onNetwork = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      onNetwork.add(`${seg.from.row},${seg.from.col}`);
      onNetwork.add(`${seg.to.row},${seg.to.col}`);
    }

    const connectedNames: string[] = [];
    for (const group of groups) {
      const allMileposts = [group.center, ...group.outposts];
      for (const mp of allMileposts) {
        if (onNetwork.has(`${mp.row},${mp.col}`)) {
          connectedNames.push(group.cityName);
          break;
        }
      }
    }

    return connectedNames.join(', ');
  }

  /**
   * Summarize the track network as a human-readable string.
   * Identifies corridors between named cities instead of dumping raw segments.
   */
  private static summarizeTrackNetwork(snapshot: WorldSnapshot): string {
    const segments = snapshot.bot.existingSegments;
    if (segments.length === 0) return 'no track built';

    const grid = loadGridPoints();

    // Find all named cities/points on the network
    const onNetwork = new Set<string>();
    for (const seg of segments) {
      onNetwork.add(`${seg.from.row},${seg.from.col}`);
      onNetwork.add(`${seg.to.row},${seg.to.col}`);
    }

    const namedPoints: string[] = [];
    for (const key of onNetwork) {
      const point = grid.get(key);
      if (point?.name && !namedPoints.includes(point.name)) {
        namedPoints.push(point.name);
      }
    }

    const mileposts = onNetwork.size;

    if (namedPoints.length === 0) {
      return `${mileposts} mileposts (no named cities reached)`;
    }

    // Build corridors: pairs of named cities that are linked through the network
    const corridors = GameStateSerializer.identifyCorridors(segments, grid);

    if (corridors.length > 0) {
      return `${mileposts} mileposts covering ${corridors.join(', ')}`;
    }

    return `${mileposts} mileposts near ${namedPoints.slice(0, 4).join(', ')}`;
  }

  /**
   * Identify corridors (city-to-city connections) in the track network.
   * Returns an array like ["Paris\u2013Lyon", "Lyon\u2013Milano"].
   */
  private static identifyCorridors(
    segments: TrackSegment[],
    grid: Map<string, GridPointData>,
  ): string[] {
    // Build adjacency from track segments
    const adj = new Map<string, Set<string>>();
    const addEdge = (a: string, b: string) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    };
    for (const seg of segments) {
      const fk = `${seg.from.row},${seg.from.col}`;
      const tk = `${seg.to.row},${seg.to.col}`;
      addEdge(fk, tk);
    }

    // Find all named nodes
    const namedNodes = new Map<string, string>(); // key -> name
    for (const key of adj.keys()) {
      const point = grid.get(key);
      if (point?.name) {
        namedNodes.set(key, point.name);
      }
    }

    // BFS between each pair of named nodes to find connected pairs
    const corridors: string[] = [];
    const seen = new Set<string>();
    const namedKeys = [...namedNodes.keys()];

    for (let i = 0; i < namedKeys.length; i++) {
      // BFS from this named node, find directly connected named nodes
      // (no other named node in between)
      const start = namedKeys[i];
      const visited = new Set<string>([start]);
      let frontier = [start];

      while (frontier.length > 0) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const neighbor of (adj.get(cur) ?? [])) {
            if (visited.has(neighbor)) continue;
            visited.add(neighbor);
            if (namedNodes.has(neighbor)) {
              // Found a directly connected named node
              const nameA = namedNodes.get(start)!;
              const nameB = namedNodes.get(neighbor)!;
              const pairKey = [nameA, nameB].sort().join('|');
              if (!seen.has(pairKey)) {
                seen.add(pairKey);
                corridors.push(`${nameA}\u2013${nameB}`);
              }
              // Don't BFS through named nodes (they are corridor endpoints)
            } else {
              next.push(neighbor);
            }
          }
        }
        frontier = next;
      }
    }

    // Cap at 6 corridors to keep the prompt concise
    return corridors.slice(0, 6);
  }

  /**
   * Summarize bot memory state for the prompt.
   */
  private static summarizeMemory(memory: BotMemoryState): string {
    const parts: string[] = [];

    if (memory.currentBuildTarget) {
      parts.push(`Building toward ${memory.currentBuildTarget} for ${memory.turnsOnTarget} turns`);
    } else {
      parts.push('No current build target');
    }

    parts.push(`${memory.deliveryCount} deliveries, ${memory.totalEarnings}M earned`);

    return parts.join('. ') + '.';
  }

  /**
   * Describe a movement option for the LLM prompt.
   */
  private static describeMoveOption(
    option: FeasibleOption,
    index: number,
    snapshot: WorldSnapshot,
  ): string {
    const parts: string[] = [];
    parts.push(`[M${index}]`);

    switch (option.action) {
      case AIActionType.MoveTrain: {
        const target = option.targetCity ?? 'unknown';
        const mileposts = option.mileposts ?? 0;
        parts.push(`MOVE: to ${target} (${mileposts} mileposts).`);
        if (option.estimatedCost && option.estimatedCost > 0) {
          parts.push(`Track fee: ${option.estimatedCost}M.`);
        } else {
          parts.push('No fee.');
        }
        // Annotate if this move enables a delivery — specify which load and demand card
        if (option.payment && option.payment > 0) {
          const match = GameStateSerializer.findDeliveryMatch(target, snapshot);
          if (match) {
            parts.push(`Delivers ${match.loadType} (card ${match.cardIndex}) for ${option.payment}M.`);
          } else {
            parts.push(`Delivery worth ${option.payment}M.`);
          }
        }
        break;
      }
      case AIActionType.PickupLoad: {
        parts.push(`PICKUP: ${option.loadType} at ${option.targetCity}.`);
        if (option.payment) {
          parts.push(`For delivery worth ${option.payment}M.`);
        }
        break;
      }
      case AIActionType.DeliverLoad: {
        parts.push(`DELIVER: ${option.loadType} at ${option.targetCity} for ${option.payment}M.`);
        break;
      }
      case AIActionType.DropLoad: {
        parts.push(`DROP: ${option.loadType} at ${option.targetCity}. No payout.`);
        break;
      }
      default:
        parts.push(`${option.action}: ${option.reason}`);
    }

    return parts.join(' ');
  }

  /**
   * Resolve the origin (start point) of a build option to a city name.
   * Uses segments[0].from to find where the build branches off existing track.
   */
  private static resolveBuildOrigin(segments: TrackSegment[]): string | null {
    if (!segments || segments.length === 0) return null;
    const from = segments[0].from;
    const grid = loadGridPoints();
    const key = `${from.row},${from.col}`;
    const point = grid.get(key);
    if (point?.name) return point.name;
    const desc = GameStateSerializer.findNearestCityDescription(from.row, from.col, grid);
    return desc === 'in transit' ? null : desc;
  }

  /**
   * Describe a build option for the LLM prompt.
   */
  private static describeBuildOption(
    option: FeasibleOption,
    index: number,
    snapshot: WorldSnapshot,
    chains?: DemandChain[],
    memory?: BotMemoryState,
  ): string {
    const parts: string[] = [];
    parts.push(`[B${index}]`);

    switch (option.action) {
      case AIActionType.BuildTrack: {
        const target = option.targetCity ?? 'extend track';
        const cost = option.estimatedCost ?? 0;
        const segCount = option.segments?.length ?? 0;
        const origin = option.segments
          ? GameStateSerializer.resolveBuildOrigin(option.segments) : null;
        const originStr = origin ? ` from ${origin}` : '';

        let spurTag = '';
        if (memory?.currentBuildTarget && origin) {
          if (target === memory.currentBuildTarget) {
            spurTag = ' [CONTINUES current build]';
          } else {
            spurTag = ' [NEW SPUR]';
          }
        }

        parts.push(`BUILD:${originStr} toward ${target} (${segCount} segments, ${cost}M).${spurTag}`);
        if (option.payment) {
          parts.push(`Enables ${option.payment}M delivery.`);
        }
        if (option.chainScore) {
          const score = option.chainScore.toFixed(1);
          parts.push(`Chain value: ${score}M/turn.`);
        }
        // Reuse annotation: how many other demand chains this build direction serves
        if (chains && target) {
          const matchingChain = chains.find(c =>
            c.deliveryCity === target || c.pickupCity === target,
          );
          if (matchingChain?.sharedChainCount && matchingChain.sharedChainCount > 0) {
            parts.push(`Also serves ${matchingChain.sharedChainCount} other demand${matchingChain.sharedChainCount > 1 ? 's' : ''}. REUSABLE.`);
          } else {
            parts.push('Dead-end — no other demands nearby.');
          }
        }
        break;
      }
      case AIActionType.UpgradeTrain: {
        const targetTrain = option.targetTrainType
          ? GameStateSerializer.formatTrainType(option.targetTrainType)
          : 'better train';
        const targetProps = option.targetTrainType
          ? TRAIN_PROPERTIES[option.targetTrainType]
          : null;
        const kind = option.upgradeKind === 'crossgrade' ? 'CROSSGRADE' : 'UPGRADE';
        parts.push(`${kind}: ${targetTrain}`);
        if (targetProps) {
          parts.push(`(speed ${targetProps.speed}, capacity ${targetProps.capacity})`);
        }
        parts.push(`for ${option.estimatedCost ?? 20}M. No build this turn.`);
        break;
      }
      case AIActionType.DiscardHand: {
        parts.push('DISCARD: Draw 3 new demand cards. Ends turn immediately.');
        break;
      }
      case AIActionType.PassTurn: {
        parts.push('PASS: Do nothing.');
        break;
      }
      default:
        parts.push(`${option.action}: ${option.reason}`);
    }

    return parts.join(' ');
  }

  /**
   * Invert loadAvailability to find which cities produce a given load type.
   */
  private static getSourceCities(loadType: string, loadAvailability: Record<string, string[]>): string[] {
    const cities: string[] = [];
    for (const [city, loads] of Object.entries(loadAvailability)) {
      if (loads.includes(loadType)) {
        cities.push(city);
      }
    }
    return cities;
  }

  /**
   * Find which load on the bot's train matches a demand card for the given city.
   */
  private static findDeliveryMatch(
    targetCity: string,
    snapshot: WorldSnapshot,
  ): { loadType: string; cardIndex: number } | null {
    for (let i = 0; i < snapshot.bot.resolvedDemands.length; i++) {
      const rd = snapshot.bot.resolvedDemands[i];
      for (const d of rd.demands) {
        if (d.city === targetCity && snapshot.bot.loads.includes(d.loadType)) {
          return { loadType: d.loadType, cardIndex: i + 1 };
        }
      }
    }
    return null;
  }

  /**
   * Determine the game phase from the turn number.
   */
  private static getGamePhase(turnNumber: number): string {
    if (turnNumber <= 10) return 'Early Game';
    if (turnNumber <= 30) return 'Mid Game';
    if (turnNumber <= 50) return 'Late Game';
    return 'End Game';
  }

  /**
   * Format a TrainType enum value as a human-readable label.
   */
  private static formatTrainType(trainType: TrainType | string): string {
    switch (trainType) {
      case TrainType.Freight: return 'Freight';
      case TrainType.FastFreight: return 'Fast Freight';
      case TrainType.HeavyFreight: return 'Heavy Freight';
      case TrainType.Superfreight: return 'Superfreight';
      default: return String(trainType);
    }
  }
}
