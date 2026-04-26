/**
 * ContextSerializer — Prompt serializers for the bot's LLM context.
 *
 * Owns the five prompt-serialization methods that were previously in ContextBuilder:
 *   - serializePrompt (main decision prompt)
 *   - serializeRoutePlanningPrompt (TripPlanner route selection prompt)
 *   - serializeSecondaryDeliveryPrompt (post-delivery opportunistic pickup prompt)
 *   - serializeCargoConflictPrompt (cargo conflict resolution prompt)
 *   - serializeUpgradeBeforeDropPrompt (upgrade vs drop evaluation prompt)
 *
 * JIRA-195: Extracted from ContextBuilder as part of Slice 1 decomposition.
 * Delegates to ContextBuilder for the actual implementation until BE-004
 * completes the code-motion (at which point the implementation moves here verbatim
 * and ContextBuilder re-exports via this module).
 *
 * **Call sites:** Update imports from `ContextBuilder.serialize*` to
 * `ContextSerializer.serialize*`. ContextBuilder re-exports these methods for
 * backward compatibility with test files that call via ContextBuilder.
 */

import {
  GameContext,
  WorldSnapshot,
  BotSkillLevel,
  GridPoint,
  TrackSegment,
  RouteStop,
  StrategicRoute,
  DemandContext,
  EnRoutePickup,
} from '../../../../shared/types/GameTypes';
import { ContextBuilder } from '../ContextBuilder';

export class ContextSerializer {
  /**
   * Render GameContext into structured text for the LLM user prompt.
   * Same signature and byte-output as ContextBuilder.serializePrompt.
   */
  static serializePrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
  ): string {
    return ContextBuilder.serializePrompt(context, skillLevel);
  }

  /**
   * Render the route-planning user prompt for TripPlanner.
   * Same signature and byte-output as ContextBuilder.serializeRoutePlanningPrompt.
   */
  static serializeRoutePlanningPrompt(
    context: GameContext,
    skillLevel: BotSkillLevel,
    gridPoints: GridPoint[],
    segments: TrackSegment[],
    lastAbandonedRouteKey?: string | null,
    previousRouteStops?: RouteStop[] | null,
  ): string {
    return ContextBuilder.serializeRoutePlanningPrompt(
      context, skillLevel, gridPoints, segments, lastAbandonedRouteKey, previousRouteStops,
    );
  }

  /**
   * JIRA-89: Render the secondary delivery evaluation prompt.
   * Same signature and byte-output as ContextBuilder.serializeSecondaryDeliveryPrompt.
   */
  static serializeSecondaryDeliveryPrompt(
    snapshot: WorldSnapshot,
    routeStops: RouteStop[],
    demands: DemandContext[],
    enRoutePickups: EnRoutePickup[],
  ): string {
    return ContextBuilder.serializeSecondaryDeliveryPrompt(snapshot, routeStops, demands, enRoutePickups);
  }

  /**
   * Render the cargo conflict resolution prompt.
   * Same signature and byte-output as ContextBuilder.serializeCargoConflictPrompt.
   */
  static serializeCargoConflictPrompt(
    snapshot: WorldSnapshot,
    plannedRoute: StrategicRoute,
    conflictingLoads: string[],
    demands: DemandContext[],
  ): string {
    return ContextBuilder.serializeCargoConflictPrompt(snapshot, plannedRoute, conflictingLoads, demands);
  }

  /**
   * JIRA-105b: Render the upgrade-before-drop evaluation prompt.
   * Same signature and byte-output as ContextBuilder.serializeUpgradeBeforeDropPrompt.
   */
  static serializeUpgradeBeforeDropPrompt(
    snapshot: WorldSnapshot,
    route: StrategicRoute,
    upgradeOptions: { targetTrain: string; cost: number }[],
    totalRoutePayout: number,
    demands: DemandContext[],
  ): string {
    return ContextBuilder.serializeUpgradeBeforeDropPrompt(
      snapshot, route, upgradeOptions, totalRoutePayout, demands,
    );
  }
}
