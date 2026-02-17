/**
 * Scorer — Ranks feasible options by strategic value for the AI bot.
 *
 * Applies a weighted scoring system considering terrain cost, segment count,
 * and bot archetype preferences. Returns options sorted highest score first.
 */

import {
  FeasibleOption,
  WorldSnapshot,
  BotConfig,
  BotArchetype,
  AIActionType,
  TerrainType,
  TrainType,
  TRAIN_PROPERTIES,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { loadGridPoints } from './MapTopology';
import { DemandDeckService } from '../demandDeckService';

/** Base score for building track (encourages building over passing) */
const BUILD_BASE_SCORE = 10;

/** Bonus per new segment built — kept low so it doesn't override chain intelligence.
 *  Old value (3) caused the bot to prefer distant targets with more segments
 *  over nearby completable chains. */
const SEGMENT_BONUS = 1;

/** Bonus for reaching a named city */
const CITY_REACH_BONUS = 5;

/** Extra bonus for BuilderFirst archetype per segment */
const BUILDER_FIRST_SEGMENT_BONUS = 2;

/** PassTurn default score */
const PASS_TURN_SCORE = 0;

/** Base score for delivering a load (highest priority — immediate income) */
const DELIVER_BASE_SCORE = 100;

/** Multiplier for delivery payment in score */
const DELIVER_PAYMENT_FACTOR = 2;

/** Base score for picking up a load */
const PICKUP_BASE_SCORE = 50;

/** Multiplier for best matching demand payment when picking up */
const PICKUP_PAYMENT_FACTOR = 0.5;

/** Base score for moving train (higher than building to prefer delivery) */
const MOVE_BASE_SCORE = 15;

/** Bonus per ECU of demand payoff (scaled down) */
const PAYOFF_BONUS_FACTOR = 0.5;

/** Maximum distance score — closer destinations score higher */
const MOVE_DISTANCE_MAX_BONUS = 12;

/** Bonus factor for pickup opportunity at target city (load matches a demand card) */
const PICKUP_OPPORTUNITY_FACTOR = 0.3;

/** Multiplier for chainScore (payment/distance) in build scoring.
 *  chainScore ~0.3-2.0 → bonus ~6-40.  Ensures short cheap chains
 *  (Antwerpen→London, score=1.04, bonus=20.8) beat long expensive chains
 *  (Fish Aberdeen→Krakow, score=0.80, bonus=16) even when the expensive
 *  chain builds more segments. */
const CHAIN_SCORE_FACTOR = 20;

export class Scorer {
  /**
   * Score and sort options by strategic value, highest first.
   * Only feasible options receive meaningful scores; infeasible options
   * get -Infinity so they sort to the bottom.
   * @param options All feasible/infeasible options to score
   * @param snapshot Current game state
   * @param botConfig Bot archetype/skill configuration (affects scoring weights)
   * @param botMemory Optional bot memory for game-phase-aware scoring (upgrade timing, discard decisions)
   */
  static score(
    options: FeasibleOption[],
    snapshot: WorldSnapshot,
    botConfig: BotConfig | null,
    botMemory?: BotMemoryState,
  ): FeasibleOption[] {
    for (const option of options) {
      if (!option.feasible) {
        option.score = -Infinity;
        continue;
      }

      switch (option.action) {
        case AIActionType.BuildTrack:
          option.score = Scorer.calculateBuildTrackScore(option, snapshot, botConfig);
          break;
        case AIActionType.MoveTrain:
          option.score = Scorer.calculateMoveScore(option, snapshot);
          break;
        case AIActionType.DeliverLoad:
          option.score = Scorer.calculateDeliveryScore(option);
          break;
        case AIActionType.PickupLoad:
          option.score = Scorer.calculatePickupScore(option, snapshot);
          break;
        case AIActionType.DropLoad:
          option.score = Scorer.calculateDropScore(option, snapshot);
          break;
        case AIActionType.UpgradeTrain:
          option.score = Scorer.calculateUpgradeScore(option, snapshot, botMemory);
          break;
        case AIActionType.DiscardHand:
          option.score = Scorer.calculateDiscardScore(snapshot, botMemory);
          break;
        case AIActionType.PassTurn:
          option.score = Scorer.calculatePassTurnScore();
          break;
        default:
          option.score = 0;
      }
    }

    return options.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private static calculateBuildTrackScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
    botConfig: BotConfig | null,
  ): number {
    let score = BUILD_BASE_SCORE;

    // Reward building more segments
    const segmentCount = option.segments?.length ?? 0;
    score += segmentCount * SEGMENT_BONUS;

    // Penalize cost (lower cost = higher score)
    score -= (option.estimatedCost ?? 0);

    // Bonus for reaching a named city
    if (option.targetCity) {
      score += CITY_REACH_BONUS;
    }

    // Archetype-specific adjustments
    if (botConfig?.archetype === BotArchetype.BuilderFirst) {
      // BuilderFirst bots get extra value from building more track
      score += segmentCount * BUILDER_FIRST_SEGMENT_BONUS;
    }

    // Chain completability bonus — use chainScore (payment/distance) not raw payment.
    // This ensures short cheap chains (Antwerpen→London) beat expensive cross-map chains
    // (Fish Aberdeen→Krakow) even when the expensive chain has a higher raw payment.
    if (option.chainScore) {
      score += option.chainScore * CHAIN_SCORE_FACTOR;
    } else if (option.payment) {
      // Fallback for non-chain build options (e.g., all-targets combined)
      score += option.payment * 0.3;
    }

    // Demand proximity bonus: check if any segment endpoint is near a demand city
    score += Scorer.demandProximityBonus(option, snapshot);

    return score;
  }

  /**
   * Score a MoveTrain option based on distance to target, demand payoff, and track usage fees.
   * Closer destinations with higher payoffs and lower fees score higher.
   */
  private static calculateMoveScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): number {
    let score = MOVE_BASE_SCORE;

    const mileposts = option.mileposts ?? 0;
    const speed = 12; // max possible speed for normalization

    // Detect frontier move: movementPath doesn't reach targetPosition
    const pathEnd = option.movementPath?.[option.movementPath.length - 1];
    const isFrontier = pathEnd && option.targetPosition &&
      (pathEnd.row !== option.targetPosition.row || pathEnd.col !== option.targetPosition.col);

    // Distance bonus: only for reachable cities (shorter = better = arriving sooner).
    // Frontier options get NO distance bonus — their mileposts reflect truncated path
    // length, not true distance, so the bonus would be misleading.
    if (mileposts > 0 && !isFrontier) {
      score += MOVE_DISTANCE_MAX_BONUS * (1 - (mileposts - 1) / speed);
    }

    // Payoff bonus: prioritize cities where we can actually deliver
    if (option.targetCity) {
      const demandDeck = DemandDeckService.getInstance();
      let bestDeliverablePayoff = 0;  // bot HAS the matching load
      let bestGeneralPayoff = 0;       // demand exists but bot doesn't have load

      for (const cardId of snapshot.bot.demandCards) {
        const card = demandDeck.getCard(cardId);
        if (!card) continue;
        for (const demand of card.demands) {
          if (demand.city !== option.targetCity) continue;
          if (snapshot.bot.loads.includes(demand.resource)) {
            if (demand.payment > bestDeliverablePayoff) bestDeliverablePayoff = demand.payment;
          } else {
            if (demand.payment > bestGeneralPayoff) bestGeneralPayoff = demand.payment;
          }
        }
      }

      const trainType = snapshot.bot.trainType as TrainType;
      const rawSpeed = TRAIN_PROPERTIES[trainType]?.speed ?? 9;
      const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
      const hasCapacity = snapshot.bot.loads.length < capacity;

      if (bestDeliverablePayoff > 0) {
        // P2 fix: discount payoff by estimated turns to arrive (income-per-turn).
        // $30M delivery 2 turns away ($15M/turn) beats $50M delivery 40 turns away ($1.25M/turn).
        let turnsToArrive = 1;
        if (!isFrontier && mileposts > 0) {
          turnsToArrive = Math.max(1, Math.ceil(mileposts / rawSpeed));
        } else if (isFrontier && option.targetPosition && pathEnd) {
          const remainingDist = Math.sqrt(
            (pathEnd.row - option.targetPosition.row) ** 2 +
            (pathEnd.col - option.targetPosition.col) ** 2,
          );
          turnsToArrive = Math.max(1, Math.ceil((mileposts + remainingDist) / rawSpeed));
        }
        const incomePerTurn = bestDeliverablePayoff / turnsToArrive;
        score += incomePerTurn * PAYOFF_BONUS_FACTOR + 15;
      } else if (bestGeneralPayoff > 0 && hasCapacity) {
        // Demand exists but bot can't deliver — weak bonus only if bot has room
        // to pick up new loads. When full with non-matching loads, heading to a
        // demand city achieves nothing and causes oscillation.
        let turnsToArrive = 1;
        if (!isFrontier && mileposts > 0) {
          turnsToArrive = Math.max(1, Math.ceil(mileposts / rawSpeed));
        }
        score += (bestGeneralPayoff / turnsToArrive) * 0.1;
      }

      // Pickup opportunity bonus: target city has loads matching demand cards.
      // Rewards heading toward cities where the bot can pick up a useful load.
      // Reachability-aware: only give full bonus if the DELIVERY destination for
      // that load is also on the bot's track network. Otherwise the bot chases
      // high-value pickups it can never deliver (e.g., Labor→Cardiff when Cardiff
      // is unreachable).
      const availableLoads = snapshot.loadAvailability?.[option.targetCity] ?? [];
      if (availableLoads.length > 0) {
        const onNetwork = new Set<string>();
        for (const seg of snapshot.bot.existingSegments) {
          onNetwork.add(`${seg.from.row},${seg.from.col}`);
          onNetwork.add(`${seg.to.row},${seg.to.col}`);
        }
        const grid = loadGridPoints();

        let bestReachablePickupPayoff = 0;
        let bestAspirationPickupPayoff = 0;

        for (const rd of snapshot.bot.resolvedDemands) {
          for (const demand of rd.demands) {
            if (!availableLoads.includes(demand.loadType)) continue;
            if (snapshot.bot.loads.includes(demand.loadType)) continue;

            // Check if this demand's delivery city is on the network
            let deliveryReachable = false;
            for (const [key, point] of grid) {
              if (point.name === demand.city && onNetwork.has(key)) {
                deliveryReachable = true;
                break;
              }
            }

            if (deliveryReachable) {
              if (demand.payment > bestReachablePickupPayoff) bestReachablePickupPayoff = demand.payment;
            } else {
              if (demand.payment > bestAspirationPickupPayoff) bestAspirationPickupPayoff = demand.payment;
            }
          }
        }

        // Full bonus for reachable pickup→delivery chains
        if (bestReachablePickupPayoff > 0) {
          score += bestReachablePickupPayoff * PICKUP_OPPORTUNITY_FACTOR;
        } else if (bestAspirationPickupPayoff > 0) {
          // Reduced bonus for aspirational pickups (delivery destination not yet on network)
          score += bestAspirationPickupPayoff * PICKUP_OPPORTUNITY_FACTOR * 0.3;
        }
      }
    }

    // Penalty: track usage fees
    score -= (option.estimatedCost ?? 0);

    return score;
  }

  /**
   * Score a DeliverLoad option. Delivery is the highest-priority action since
   * it produces immediate income. Base 100 + payment * 2.
   */
  private static calculateDeliveryScore(option: FeasibleOption): number {
    const payment = option.payment ?? 0;
    return DELIVER_BASE_SCORE + payment * DELIVER_PAYMENT_FACTOR;
  }

  /**
   * Score a PickupLoad option. Base 50 + best matching demand payment * 0.5.
   * Pickups with reachable delivery destinations score much higher than
   * aspirational pickups (destination not yet on network).
   */
  private static calculatePickupScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): number {
    let score = PICKUP_BASE_SCORE;

    // If the option already has a payment (from demand matching in OptionGenerator),
    // use it directly.
    if (option.payment && option.payment > 0) {
      score += option.payment * PICKUP_PAYMENT_FACTOR;
    } else {
      // Speculative pickup — find the best matching demand for this load type
      let bestPayment = 0;
      if (option.loadType) {
        for (const rd of snapshot.bot.resolvedDemands) {
          for (const demand of rd.demands) {
            if (demand.loadType === option.loadType && demand.payment > bestPayment) {
              bestPayment = demand.payment;
            }
          }
        }
      }
      score += bestPayment * PICKUP_PAYMENT_FACTOR;
    }

    // Reachability check: penalize pickups where delivery destination is NOT on network.
    // Still allow them (DropLoad provides escape valve), but strongly prefer reachable ones.
    if (option.loadType && snapshot.bot.existingSegments.length > 0) {
      const grid = loadGridPoints();
      const onNetwork = new Set<string>();
      for (const seg of snapshot.bot.existingSegments) {
        onNetwork.add(`${seg.from.row},${seg.from.col}`);
        onNetwork.add(`${seg.to.row},${seg.to.col}`);
      }

      let hasReachableDestination = false;
      for (const rd of snapshot.bot.resolvedDemands) {
        for (const demand of rd.demands) {
          if (demand.loadType !== option.loadType) continue;
          for (const [key, point] of grid) {
            if (point.name === demand.city && onNetwork.has(key)) {
              hasReachableDestination = true;
              break;
            }
          }
          if (hasReachableDestination) break;
        }
        if (hasReachableDestination) break;
      }

      if (!hasReachableDestination) {
        // Heavily penalize aspirational pickups — barely above PassTurn.
        // The bot should not fill its train with loads it can't deliver.
        // A load for a reachable destination should strongly dominate.
        let reachabilityPenalty = 0.15;

        // Affordability check: estimate build cost to delivery city.
        // If unaffordable, apply even heavier penalty to prevent the bot
        // from picking up loads it can never deliver (e.g., Tourists→Oslo).
        if (option.loadType) {
          let minDeliveryCost = Infinity;
          for (const rd of snapshot.bot.resolvedDemands) {
            for (const demand of rd.demands) {
              if (demand.loadType !== option.loadType) continue;
              for (const [, point] of grid) {
                if (point.name !== demand.city) continue;
                for (const seg of snapshot.bot.existingSegments) {
                  const dr = point.row - seg.to.row;
                  const dc = point.col - seg.to.col;
                  const dist = Math.sqrt(dr * dr + dc * dc);
                  // Conservative flat estimate: 2.0M per segment
                  const cost = dist * 1.2 * 2.0;
                  if (cost < minDeliveryCost) minDeliveryCost = cost;
                }
              }
            }
          }
          if (minDeliveryCost > snapshot.bot.money) {
            reachabilityPenalty = 0.05; // near-zero: delivery is unaffordable
          }
        }

        score *= reachabilityPenalty;

        // Don't stack unreachable loads: if the bot already carries loads
        // for unreachable destinations, score this at 0
        if (snapshot.bot.loads.length > 0) {
          let hasExistingUnreachableLoad = false;
          for (const existingLoad of snapshot.bot.loads) {
            let existingLoadReachable = false;
            for (const rd of snapshot.bot.resolvedDemands) {
              for (const demand of rd.demands) {
                if (demand.loadType !== existingLoad) continue;
                for (const [key, point] of grid) {
                  if (point.name === demand.city && onNetwork.has(key)) {
                    existingLoadReachable = true;
                    break;
                  }
                }
                if (existingLoadReachable) break;
              }
              if (existingLoadReachable) break;
            }
            if (!existingLoadReachable) {
              hasExistingUnreachableLoad = true;
              break;
            }
          }
          if (hasExistingUnreachableLoad) {
            score = 0;
          }
        }
      }
    }

    return score;
  }

  /**
   * Score a DropLoad option. OptionGenerator now only generates drops for
   * truly orphaned loads (no demand card at all), so this scorer is simpler.
   * Base 10 — orphaned loads should be dropped to free capacity for useful pickups.
   * Bonus if train is full and a useful load is available at the current city.
   */
  private static calculateDropScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): number {
    // Orphaned load (no demand card) — should almost always drop
    let score = 10;

    // Bonus if train is full and a better load is available at this city
    if (option.loadType) {
      const trainType = snapshot.bot.trainType as TrainType;
      const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
      if (snapshot.bot.loads.length >= capacity && option.targetCity) {
        const availableLoads = snapshot.loadAvailability?.[option.targetCity] ?? [];
        const hasUsefulPickup = availableLoads.some(l =>
          snapshot.bot.resolvedDemands.some(rd =>
            rd.demands.some(d => d.loadType === l),
          ),
        );
        if (hasUsefulPickup) score += 5;
      }
    }

    return score;
  }

  private static calculatePassTurnScore(): number {
    return PASS_TURN_SCORE;
  }

  /**
   * Award bonus points if segments build toward cities that match demand cards.
   * P6 fix: only count cities relevant to current demands (destinations + source cities),
   * not any arbitrary named location.
   */
  private static demandProximityBonus(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
  ): number {
    if (!option.segments || option.segments.length === 0) return 0;
    if (snapshot.bot.demandCards.length === 0) return 0;

    const grid = loadGridPoints();

    // Build set of demand-relevant city names
    const relevantCities = new Set<string>();
    for (const rd of snapshot.bot.resolvedDemands) {
      for (const d of rd.demands) {
        relevantCities.add(d.city);
      }
    }
    for (const cityName of Object.keys(snapshot.loadAvailability)) {
      relevantCities.add(cityName);
    }

    let bonus = 0;
    for (const seg of option.segments) {
      const toPoint = grid.get(`${seg.to.row},${seg.to.col}`);
      if (toPoint?.name && relevantCities.has(toPoint.name)) {
        bonus += 5; // Strong signal for demand-relevant cities
      }
    }

    return bonus;
  }

  /**
   * P3: Score an UpgradeTrain option. Higher score when bot has enough
   * track built and would benefit from speed/capacity improvement.
   *
   * Game-phase-aware (BE-004): uses BotMemory data to discourage
   * premature upgrades and encourage overdue ones.
   */
  private static calculateUpgradeScore(
    option: FeasibleOption,
    snapshot: WorldSnapshot,
    botMemory?: BotMemoryState,
  ): number {
    const segmentCount = snapshot.bot.existingSegments.length;

    // Early game penalty: if few deliveries AND few segments, strongly discourage upgrades.
    // Prioritizes building track and making initial deliveries over spending 20M on a train.
    if (botMemory && botMemory.deliveryCount < 2 && segmentCount < 20) {
      return 2;
    }

    // Original segment threshold (no memory available — preserve legacy behavior)
    if (!botMemory && segmentCount < 10) return 2;

    let score = 8; // Slightly above PassTurn

    const currentType = snapshot.bot.trainType as TrainType;
    const targetType = option.targetTrainType;
    if (!targetType) return score;

    const currentProps = TRAIN_PROPERTIES[currentType];
    const targetProps = TRAIN_PROPERTIES[targetType];
    if (!currentProps || !targetProps) return score;

    // Speed improvement — reach destinations sooner
    if (targetProps.speed > currentProps.speed) {
      score += 10;
    }

    // Capacity improvement — carry more loads per trip
    if (targetProps.capacity > currentProps.capacity) {
      score += 8;
    }

    // More money = upgrade is affordable without sacrificing build budget
    if (snapshot.bot.money >= 50) score += 3;
    if (snapshot.bot.money >= 80) score += 3;

    // Overdue upgrade boost: if deep into the game and still on basic Freight,
    // strongly encourage upgrading — speed/capacity is critical for late-game income.
    if (botMemory && botMemory.turnNumber > 25 && currentType === TrainType.Freight) {
      score += 15;
    }

    // Financial readiness boost: when flush with cash and has active deliveries
    // to make, upgrading is a sound investment. The bot has enough money that
    // spending 20M on a train won't compromise track building.
    if (botMemory && snapshot.bot.money > 80 && botMemory.deliveryCount >= 2) {
      score += 10;
    }

    return score;
  }

  /**
   * P4: Score a DiscardHand option.
   *
   * Discarding is a DESPERATE last resort: the bot loses its entire turn
   * AND scraps all existing plans (demand cards that informed track building).
   * Score must stay below BuildTrack (~25+) and MoveTrain (~10+) in all but
   * the most hopeless situations. Only barely above PassTurn (0).
   *
   * Game-phase-aware (BE-005): analyzes how many demand card destinations
   * are reachable on the bot's current track network. If none are reachable
   * and the bot has made few deliveries, strongly encourages discarding.
   */
  private static calculateDiscardScore(
    snapshot: WorldSnapshot,
    botMemory?: BotMemoryState,
  ): number {
    // Without memory data or network, preserve legacy behavior
    if (!botMemory || snapshot.bot.existingSegments.length === 0) {
      return 1;
    }

    // B6: Prevent discard death spiral — max 2 consecutive discards.
    // Score -1 so PassTurn (0) wins the tiebreaker. Previously returned 0,
    // which tied with PassTurn and DiscardHand won by sort order.
    if (botMemory.consecutiveDiscards >= 2) {
      return -1;
    }

    // Build set of grid coords on the bot's track network
    const onNetwork = new Set<string>();
    for (const seg of snapshot.bot.existingSegments) {
      onNetwork.add(`${seg.from.row},${seg.from.col}`);
      onNetwork.add(`${seg.to.row},${seg.to.col}`);
    }

    const grid = loadGridPoints();

    // Count how many demand cards have at least one reachable delivery destination
    let reachableCount = 0;
    for (const rd of snapshot.bot.resolvedDemands) {
      let cardReachable = false;
      for (const demand of rd.demands) {
        for (const [key, point] of grid) {
          if (point.name === demand.city && onNetwork.has(key)) {
            cardReachable = true;
            break;
          }
        }
        if (cardReachable) break;
      }
      if (cardReachable) reachableCount++;
    }

    // 0/3 reachable AND few deliveries: desperate — new hand is critical
    if (reachableCount === 0 && botMemory.deliveryCount < 3) {
      return 20;
    }

    // 1/3 reachable: marginal hand — discarding might help
    if (reachableCount === 1) {
      return 5;
    }

    // 2-3/3 reachable: decent hand — keep it
    return 1;
  }
}
