/**
 * DemandEngine — Internal demand scoring and computation engine.
 *
 * Contains the full demand context computation logic extracted from ContextBuilder
 * as part of JIRA-195 Slice 1 decomposition. This module is internal — it is
 * consumed by ContextBuilder's build() facade and by rebuildDemands/rebuildCanDeliver.
 *
 * Not exported from the public AI service boundary. All callers should use
 * ContextBuilder.rebuildDemands(), ContextBuilder.build(), or DemandContext.compute().
 */

import {
  WorldSnapshot,
  DemandContext,
  DeliveryOpportunity,
  PickupOpportunity,
  EnRoutePickup,
  RouteStop,
  TrainType,
  TRAIN_PROPERTIES,
  GridPoint,
  TerrainType,
  TrackSegment,
} from '../../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../../shared/services/TrackNetworkService';
import { getMajorCityGroups, getFerryEdges } from '../../../../shared/services/majorCityGroups';
import {
  hexDistance,
  estimateHopDistance,
  estimatePathCost,
  computeLandmass,
  computeFerryRouteInfo,
  makeKey,
  loadGridPoints,
} from '../MapTopology';

// ── Geographic region constants ─────────────────────────────────────────────

const BRITAIN_CITIES = new Set([
  'Aberdeen', 'Birmingham', 'Cardiff', 'Dover', 'Glasgow', 'Harwich',
  'Liverpool', 'London', 'Manchester', 'Newcastle', 'Plymouth',
  'Portsmouth', 'Southampton', 'Stranraer',
]);
const IRELAND_CITIES = new Set([
  'Belfast', 'Cork', 'Dublin',
]);
// Arhus is on the Jutland peninsula (land-connected to Germany), so it is treated as continent
// for ferry-region purposes — actual ferry need is detected by FerryPort milepost lookup.
const SCANDINAVIA_CITIES = new Set([
  'Oslo', 'Stockholm', 'Goteborg', 'Kobenhavn',
]);

function getCityRegion(cityName: string): 'britain' | 'ireland' | 'scandinavia' | 'continent' {
  if (BRITAIN_CITIES.has(cityName)) return 'britain';
  if (IRELAND_CITIES.has(cityName)) return 'ireland';
  if (SCANDINAVIA_CITIES.has(cityName)) return 'scandinavia';
  return 'continent';
}

// ── CORRIDOR_RADIUS constant ─────────────────────────────────────────────────
const CORRIDOR_RADIUS = 5;

// ── Ferry helpers ────────────────────────────────────────────────────────────

export function isFerryOnRoute(
  supplyCity: string | null,
  deliveryCity: string,
  gridPoints: GridPoint[],
): boolean {
  for (const gp of gridPoints) {
    if (gp.terrain === TerrainType.FerryPort || (gp as { isFerryCity?: boolean }).isFerryCity) {
      const cityName = gp.city?.name;
      if (cityName === supplyCity || cityName === deliveryCity) {
        return true;
      }
    }
  }
  if (!supplyCity) return false;
  return getCityRegion(supplyCity) !== getCityRegion(deliveryCity);
}

export function countFerryCrossings(
  supplyCity: string | null,
  deliveryCity: string,
  _gridPoints: GridPoint[],
): number {
  if (!supplyCity) return 0;
  const supplyRegion = getCityRegion(supplyCity);
  const deliveryRegion = getCityRegion(deliveryCity);
  if (supplyRegion === deliveryRegion) return 0;
  const regions = new Set([supplyRegion, deliveryRegion]);
  if (regions.has('continent') && regions.has('ireland')) return 2;
  return 1;
}

// ── Track cost estimation ────────────────────────────────────────────────────

function getDestinationCityCost(cityPoint: GridPoint): number {
  switch (cityPoint.terrain) {
    case TerrainType.MajorCity: return 5;
    case TerrainType.SmallCity:
    case TerrainType.MediumCity: return 3;
    default: return 0;
  }
}

function applyBudgetPenalty(cost: number): number {
  if (cost <= 20) return cost;
  const extraTurns = Math.ceil(cost / 20) - 1;
  return cost * (1 + 0.15 * extraTurns);
}

export function estimateTrackCost(
  cityName: string,
  segments: TrackSegment[],
  gridPoints: GridPoint[],
  fromCity?: string,
): number {
  const cityPoints = gridPoints.filter(gp => gp.city?.name === cityName);
  if (cityPoints.length === 0) return 0;
  const cityCost = getDestinationCityCost(cityPoints[0]);

  if (segments.length === 0) {
    if (fromCity) {
      const fromPoints = gridPoints.filter(gp => gp.city?.name === fromCity);
      if (fromPoints.length > 0) {
        let bestFrom = fromPoints[0];
        let bestTo = cityPoints[0];
        let minDist = Infinity;
        for (const cityPoint of cityPoints) {
          for (const fp of fromPoints) {
            const dist = hexDistance(cityPoint.row, cityPoint.col, fp.row, fp.col);
            if (dist < minDist) { minDist = dist; bestFrom = fp; bestTo = cityPoint; }
          }
        }
        if (minDist === Infinity || minDist <= 1) return 0;
        const pathCost = estimatePathCost(bestFrom.row, bestFrom.col, bestTo.row, bestTo.col);
        const rawCost = pathCost > 0 ? pathCost : Math.round(minDist * 4.0) + cityCost;
        return Math.round(applyBudgetPenalty(rawCost));
      }
    }
    const majorCityGroups = getMajorCityGroups();
    let bestMajor = { row: 0, col: 0 };
    let bestCity = cityPoints[0];
    let minDist = Infinity;
    for (const cityPoint of cityPoints) {
      for (const group of majorCityGroups) {
        const dist = hexDistance(cityPoint.row, cityPoint.col, group.center.row, group.center.col);
        if (dist < minDist) { minDist = dist; bestMajor = { row: group.center.row, col: group.center.col }; bestCity = cityPoint; }
      }
    }
    if (minDist === Infinity || minDist <= 1) return 0;
    const pathCost2 = estimatePathCost(bestMajor.row, bestMajor.col, bestCity.row, bestCity.col);
    const rawCost2 = pathCost2 > 0 ? pathCost2 : Math.round(minDist * 4.0) + cityCost;
    return Math.round(applyBudgetPenalty(rawCost2));
  }

  const endpointSet = new Set<string>();
  const trackEndpoints: Array<{ row: number; col: number }> = [];
  for (const seg of segments) {
    const fk = makeKey(seg.from.row, seg.from.col);
    if (!endpointSet.has(fk)) { endpointSet.add(fk); trackEndpoints.push({ row: seg.from.row, col: seg.from.col }); }
    const tk = makeKey(seg.to.row, seg.to.col);
    if (!endpointSet.has(tk)) { endpointSet.add(tk); trackEndpoints.push({ row: seg.to.row, col: seg.to.col }); }
  }

  const grid = loadGridPoints();
  const sourceLandmass = computeLandmass(trackEndpoints, grid);
  const targetOnSourceLandmass = cityPoints.some(cp => sourceLandmass.has(makeKey(cp.row, cp.col)));

  if (targetOnSourceLandmass) {
    const MAX_FRONTIER_SOURCES = 5;
    const candidates: Array<{ ep: { row: number; col: number }; cp: typeof cityPoints[0]; dist: number }> = [];
    for (const cityPoint of cityPoints) {
      for (const ep of trackEndpoints) {
        const dist = hexDistance(cityPoint.row, cityPoint.col, ep.row, ep.col);
        candidates.push({ ep, cp: cityPoint, dist });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const usedKeys = new Set<string>();
    const topSources: typeof candidates = [];
    for (const c of candidates) {
      const key = `${c.ep.row},${c.ep.col}`;
      if (!usedKeys.has(key)) { usedKeys.add(key); topSources.push(c); if (topSources.length >= MAX_FRONTIER_SOURCES) break; }
    }
    if (topSources.length === 0) return 0;
    let minCost = Infinity;
    let bestHexDist = topSources[0].dist;
    for (const src of topSources) {
      const cost = estimatePathCost(src.ep.row, src.ep.col, src.cp.row, src.cp.col);
      if (cost > 0 && cost < minCost) { minCost = cost; bestHexDist = src.dist; }
    }
    const rawCost = minCost < Infinity ? minCost : Math.round(bestHexDist * 4.0) + cityCost;
    return Math.round(applyBudgetPenalty(rawCost));
  }

  const ferryEdges = getFerryEdges();
  const ferryInfo = computeFerryRouteInfo(sourceLandmass, endpointSet, ferryEdges);
  if (ferryInfo.canCrossFerry) {
    let minFarDist = Infinity;
    let bestArrival = ferryInfo.arrivalPorts[0];
    let bestCity = cityPoints[0];
    for (const arrival of ferryInfo.arrivalPorts) {
      for (const cp of cityPoints) {
        const dist = hexDistance(arrival.row, arrival.col, cp.row, cp.col);
        if (dist < minFarDist) { minFarDist = dist; bestArrival = arrival; bestCity = cp; }
      }
    }
    if (minFarDist === Infinity) return 0;
    const ferryCrossCost = estimatePathCost(bestArrival.row, bestArrival.col, bestCity.row, bestCity.col);
    const rawFerryCost = ferryCrossCost > 0 ? ferryCrossCost : Math.round(minFarDist * 4.0) + cityCost;
    return Math.round(applyBudgetPenalty(rawFerryCost));
  }

  let bestTotal = Infinity;
  for (let i = 0; i < ferryInfo.departurePorts.length; i++) {
    const dep = ferryInfo.departurePorts[i];
    const arr = ferryInfo.arrivalPorts[i];
    let bestEp = trackEndpoints[0];
    let nearestTrackDist = Infinity;
    for (const ep of trackEndpoints) {
      const d = hexDistance(ep.row, ep.col, dep.row, dep.col);
      if (d < nearestTrackDist) { nearestTrackDist = d; bestEp = ep; }
    }
    const overlandToDep = estimatePathCost(bestEp.row, bestEp.col, dep.row, dep.col);
    const nearSideCost = overlandToDep > 0 ? overlandToDep : Math.round(nearestTrackDist * 4.0);
    let bestCp = cityPoints[0];
    let nearestTargetDist = Infinity;
    for (const cp of cityPoints) {
      const d = hexDistance(arr.row, arr.col, cp.row, cp.col);
      if (d < nearestTargetDist) { nearestTargetDist = d; bestCp = cp; }
    }
    const overlandFromArr = estimatePathCost(arr.row, arr.col, bestCp.row, bestCp.col);
    const farSideCost = overlandFromArr > 0 ? overlandFromArr : Math.round(nearestTargetDist * 4.0) + cityCost;
    let ferryCost = ferryInfo.cheapestFerryCost;
    for (const fe of ferryEdges) {
      const aKey = makeKey(fe.pointA.row, fe.pointA.col);
      const bKey = makeKey(fe.pointB.row, fe.pointB.col);
      if (aKey === makeKey(dep.row, dep.col) || bKey === makeKey(dep.row, dep.col)) { ferryCost = fe.cost; break; }
    }
    const total = nearSideCost + ferryCost + farSideCost;
    bestTotal = Math.min(bestTotal, total);
  }

  if (bestTotal === Infinity) {
    let minDist = Infinity;
    for (const cp of cityPoints) {
      for (const ep of trackEndpoints) {
        const d = hexDistance(ep.row, ep.col, cp.row, cp.col);
        minDist = Math.min(minDist, d);
      }
    }
    const rawFallback = Math.round(minDist * 4.0) + cityCost;
    return Math.round(applyBudgetPenalty(rawFallback));
  }
  return Math.round(applyBudgetPenalty(bestTotal));
}

// ── Demand scoring ───────────────────────────────────────────────────────────

function scoreDemand(
  payout: number,
  totalTrackCost: number,
  estimatedTurns: number,
  isAffordable: boolean = true,
  projectedFunds: number = Infinity,
): number {
  const COST_WEIGHT = 0.1;
  const incomeVelocity = payout / estimatedTurns;
  const costBurden = totalTrackCost * COST_WEIGHT;
  const rawScore = incomeVelocity - costBurden;
  const costPenaltyFactor = totalTrackCost > 50 ? Math.exp(-(totalTrackCost - 50) / 30) : 1;
  const penalizedScore = rawScore >= 0
    ? rawScore * costPenaltyFactor
    : rawScore / Math.max(costPenaltyFactor, 0.01);
  if (!isAffordable && totalTrackCost > 0) {
    const shortfall = totalTrackCost - Math.max(projectedFunds, 0);
    const shortfallRatio = Math.min(shortfall / totalTrackCost, 1);
    const affordPenalty = Math.max(0.05, 0.3 * (1 - shortfallRatio));
    return penalizedScore >= 0
      ? penalizedScore * affordPenalty
      : penalizedScore / Math.max(affordPenalty, 0.01);
  }
  return penalizedScore;
}

function isCityOnNetwork(
  cityName: string,
  network: ReturnType<typeof buildTrackNetwork> | null,
  gridPoints: GridPoint[],
): boolean {
  if (!network) return false;
  for (const gp of gridPoints) {
    if (gp.city?.name === cityName) {
      const key = `${gp.row},${gp.col}`;
      if (network.nodes.has(key)) return true;
    }
  }
  return false;
}

function computeCorridorValue(
  supplyCity: string | null,
  deliveryCity: string,
  segments: TrackSegment[],
  gridPoints: GridPoint[],
  connectedMajorCities: string[],
  startingCity?: string,
): { networkCities: number; victoryMajorCities: number } {
  if (!supplyCity) return { networkCities: 0, victoryMajorCities: 0 };
  const supplyCityPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
  const deliveryCityPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
  if (supplyCityPoints.length === 0) return { networkCities: 0, victoryMajorCities: 0 };
  const supplyPt = supplyCityPoints[0];
  let corridorStart: { row: number; col: number };
  if (segments.length > 0) {
    let bestDist = Infinity;
    corridorStart = { row: segments[0].to.row, col: segments[0].to.col };
    for (const seg of segments) {
      const dist = hexDistance(supplyPt.row, supplyPt.col, seg.to.row, seg.to.col);
      if (dist < bestDist) { bestDist = dist; corridorStart = { row: seg.to.row, col: seg.to.col }; }
    }
  } else {
    if (startingCity) {
      const startPoints = gridPoints.filter(gp => gp.city?.name === startingCity);
      corridorStart = startPoints.length > 0
        ? { row: startPoints[0].row, col: startPoints[0].col }
        : { row: supplyPt.row, col: supplyPt.col };
    } else {
      const majorCityGroups = getMajorCityGroups();
      let bestDist = Infinity;
      corridorStart = { row: supplyPt.row, col: supplyPt.col };
      for (const group of majorCityGroups) {
        const dist = hexDistance(supplyPt.row, supplyPt.col, group.center.row, group.center.col);
        if (dist < bestDist) { bestDist = dist; corridorStart = { row: group.center.row, col: group.center.col }; }
      }
    }
  }
  const waypoints: Array<{ row: number; col: number }> = [corridorStart, supplyPt];
  if (deliveryCityPoints.length > 0) waypoints.push(deliveryCityPoints[0]);
  const allCheckpoints: Array<{ row: number; col: number }> = [];
  for (let i = 0; i < waypoints.length; i++) {
    allCheckpoints.push(waypoints[i]);
    if (i < waypoints.length - 1) {
      allCheckpoints.push({
        row: Math.round((waypoints[i].row + waypoints[i + 1].row) / 2),
        col: Math.round((waypoints[i].col + waypoints[i + 1].col) / 2),
      });
    }
  }
  const networkCitySet = new Set<string>();
  if (segments.length > 0) {
    const network = buildTrackNetwork(segments);
    for (const gp of gridPoints) {
      if (gp.city?.name) {
        const key = `${gp.row},${gp.col}`;
        if (network.nodes.has(key)) networkCitySet.add(gp.city.name);
      }
    }
  }
  const connectedSet = new Set(connectedMajorCities);
  const seenCities = new Set<string>();
  let networkCities = 0;
  let victoryMajorCities = 0;
  for (const gp of gridPoints) {
    if (!gp.city?.name) continue;
    if (networkCitySet.has(gp.city.name)) continue;
    if (seenCities.has(gp.city.name)) continue;
    let nearCorridor = false;
    for (const cp of allCheckpoints) {
      if (hexDistance(gp.row, gp.col, cp.row, cp.col) <= CORRIDOR_RADIUS) { nearCorridor = true; break; }
    }
    if (!nearCorridor) continue;
    seenCities.add(gp.city.name);
    networkCities++;
    if (gp.terrain === TerrainType.MajorCity && !connectedSet.has(gp.city.name)) victoryMajorCities++;
  }
  return { networkCities, victoryMajorCities };
}

function estimateColdStartRouteCost(
  supplyCity: string,
  deliveryCity: string,
  gridPoints: GridPoint[],
): { supplyCost: number; deliveryCost: number; totalCost: number; startingCity: string; isHubModel: boolean } | null {
  const majorCityGroups = getMajorCityGroups();
  const supplyPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
  const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
  if (supplyPoints.length === 0 || deliveryPoints.length === 0) return null;

  const costBetween = (fromRow: number, fromCol: number, toRow: number, toCol: number): number => {
    if (fromRow === toRow && fromCol === toCol) return 0;
    const pathCost = estimatePathCost(fromRow, fromCol, toRow, toCol);
    if (pathCost > 0) return pathCost;
    const dist = hexDistance(fromRow, fromCol, toRow, toCol);
    return dist <= 1 ? 0 : Math.round(dist * 2.0);
  };

  let bestLinearDeliveryCost = Infinity;
  for (const sp of supplyPoints) {
    for (const dp of deliveryPoints) {
      const cost = costBetween(sp.row, sp.col, dp.row, dp.col);
      if (cost < bestLinearDeliveryCost) bestLinearDeliveryCost = cost;
    }
  }

  let bestTotalCost = Infinity;
  let bestSupplyCost = 0;
  let bestDeliveryCost = 0;
  let bestStartingCity = '';
  let bestIsHub = false;

  for (const group of majorCityGroups) {
    const startPoints = gridPoints.filter(gp => gp.city?.name === group.cityName);
    const S = startPoints.length > 0 ? { row: startPoints[0].row, col: startPoints[0].col } : group.center;
    let supplyCost = Infinity;
    if (group.cityName === supplyCity) {
      supplyCost = 0;
    } else {
      for (const sp of supplyPoints) {
        const cost = costBetween(S.row, S.col, sp.row, sp.col);
        if (cost < supplyCost) supplyCost = cost;
      }
    }
    if (supplyCost === Infinity) continue;
    let hubDeliveryCost = Infinity;
    if (group.cityName === deliveryCity) {
      hubDeliveryCost = 0;
    } else {
      for (const dp of deliveryPoints) {
        const cost = costBetween(S.row, S.col, dp.row, dp.col);
        if (cost < hubDeliveryCost) hubDeliveryCost = cost;
      }
    }
    const hubTotal = hubDeliveryCost < Infinity ? supplyCost + hubDeliveryCost : Infinity;
    const linearTotal = bestLinearDeliveryCost < Infinity ? supplyCost + bestLinearDeliveryCost : Infinity;
    const isHub = hubTotal <= linearTotal;
    const totalForCity = Math.min(hubTotal, linearTotal);
    const deliveryCostForCity = isHub
      ? (hubDeliveryCost < Infinity ? hubDeliveryCost : 0)
      : (bestLinearDeliveryCost < Infinity ? bestLinearDeliveryCost : 0);
    if (totalForCity < bestTotalCost || (totalForCity === bestTotalCost && supplyCost < bestSupplyCost)) {
      bestTotalCost = totalForCity;
      bestSupplyCost = supplyCost;
      bestDeliveryCost = deliveryCostForCity;
      bestStartingCity = group.cityName;
      bestIsHub = isHub;
    }
  }
  if (bestTotalCost === Infinity || !bestStartingCity) return null;
  return { supplyCost: bestSupplyCost, deliveryCost: bestDeliveryCost, totalCost: bestTotalCost, startingCity: bestStartingCity, isHubModel: bestIsHub };
}

// ── Load availability ────────────────────────────────────────────────────────

function getLoadTotalCopies(loadType: string): number {
  const fourCopyLoads = ['Beer', 'Cheese', 'Machinery', 'Oil', 'Wine'];
  return fourCopyLoads.includes(loadType) ? 4 : 3;
}

function countCarriedLoads(loadType: string, snapshot: WorldSnapshot): number {
  let carriedCount = 0;
  for (const load of snapshot.bot.loads) {
    if (load === loadType) carriedCount++;
  }
  if (snapshot.opponents) {
    for (const opp of snapshot.opponents) {
      for (const load of opp.loads) {
        if (load === loadType) carriedCount++;
      }
    }
  }
  return carriedCount;
}

export function isLoadRuntimeAvailable(loadType: string, snapshot: WorldSnapshot): boolean {
  const carriedCount = countCarriedLoads(loadType, snapshot);
  if (!snapshot.opponents) return carriedCount < 3;
  const totalCopies = getLoadTotalCopies(loadType);
  return carriedCount < totalCopies;
}

// ── Single supply demand context computation ─────────────────────────────────

function computeSingleSupplyDemandContext(
  cardIndex: number,
  demand: { city: string; loadType: string; payment: number },
  supplyCity: string | null,
  snapshot: WorldSnapshot,
  network: ReturnType<typeof buildTrackNetwork> | null,
  gridPoints: GridPoint[],
  reachableCities: string[],
  citiesOnNetwork: string[],
  connectedMajorCities: string[],
): DemandContext {
  const deliveryCity = demand.city;
  const loadType = demand.loadType;
  const isLoadOnTrain = snapshot.bot.loads.includes(loadType);
  const isSupplyReachable = supplyCity ? reachableCities.includes(supplyCity) : false;
  const isDeliveryReachable = reachableCities.includes(deliveryCity);
  const isSupplyOnNetwork = supplyCity ? isCityOnNetwork(supplyCity, network, gridPoints) : false;
  const isDeliveryOnNetwork = isCityOnNetwork(deliveryCity, network, gridPoints);

  let estimatedTrackCostToSupply = 0;
  let estimatedTrackCostToDelivery = 0;
  let optimalStartingCity: string | undefined;
  // JIRA-209: hold cold-start mode throughout initialBuild phase; also covers post-restart (mercy rule) when segments are wiped
  const isColdStart = snapshot.gameStatus === 'initialBuild' || snapshot.bot.existingSegments.length === 0;

  if (isColdStart && supplyCity && !isLoadOnTrain) {
    const coldStartResult = estimateColdStartRouteCost(supplyCity, deliveryCity, gridPoints);
    if (coldStartResult) {
      estimatedTrackCostToSupply = coldStartResult.supplyCost;
      estimatedTrackCostToDelivery = coldStartResult.deliveryCost;
      optimalStartingCity = coldStartResult.startingCity;
    } else {
      estimatedTrackCostToSupply = estimateTrackCost(supplyCity, snapshot.bot.existingSegments, gridPoints);
      estimatedTrackCostToDelivery = estimateTrackCost(deliveryCity, snapshot.bot.existingSegments, gridPoints, supplyCity);
    }
  } else {
    estimatedTrackCostToSupply = isSupplyOnNetwork || !supplyCity || isLoadOnTrain
      ? 0
      : estimateTrackCost(supplyCity, snapshot.bot.existingSegments, gridPoints);
    estimatedTrackCostToDelivery = isDeliveryOnNetwork
      ? 0
      : estimateTrackCost(deliveryCity, snapshot.bot.existingSegments, gridPoints);
  }

  const isLoadAvailable = isLoadRuntimeAvailable(loadType, snapshot);
  const ferryRequired = isFerryOnRoute(supplyCity, deliveryCity, gridPoints);
  const totalCopies = getLoadTotalCopies(loadType);
  const carriedCount = countCarriedLoads(loadType, snapshot);

  const totalTrackCost = estimatedTrackCostToSupply + estimatedTrackCostToDelivery;
  const speed = TRAIN_PROPERTIES[snapshot.bot.trainType as TrainType].speed;
  const buildTurns = totalTrackCost > 0 ? Math.ceil(totalTrackCost / 20) : 0;

  let travelTurns = 0;
  const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);

  if (supplyCity) {
    const supplyPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
    if (isColdStart && optimalStartingCity) {
      const startPoints = gridPoints.filter(gp => gp.city?.name === optimalStartingCity);
      if (startPoints.length > 0 && supplyPoints.length > 0 && deliveryPoints.length > 0) {
        let hopStartToSupply = Infinity;
        for (const stP of startPoints) {
          for (const sp of supplyPoints) {
            const d = estimateHopDistance(stP.row, stP.col, sp.row, sp.col);
            if (d >= 0 && d < hopStartToSupply) hopStartToSupply = d;
          }
        }
        let hopSupplyToDelivery = Infinity;
        for (const sp of supplyPoints) {
          for (const dp of deliveryPoints) {
            const d = estimateHopDistance(sp.row, sp.col, dp.row, dp.col);
            if (d >= 0 && d < hopSupplyToDelivery) hopSupplyToDelivery = d;
          }
        }
        if (hopStartToSupply === Infinity) {
          let minEuc = Infinity;
          for (const stP of startPoints) {
            for (const sp of supplyPoints) {
              const d = Math.sqrt((sp.row - stP.row) ** 2 + (sp.col - stP.col) ** 2);
              if (d < minEuc) minEuc = d;
            }
          }
          if (minEuc < Infinity) hopStartToSupply = minEuc;
        }
        if (hopSupplyToDelivery === Infinity) {
          let minEuc = Infinity;
          for (const sp of supplyPoints) {
            for (const dp of deliveryPoints) {
              const d = Math.sqrt((dp.row - sp.row) ** 2 + (dp.col - sp.col) ** 2);
              if (d < minEuc) minEuc = d;
            }
          }
          if (minEuc < Infinity) hopSupplyToDelivery = minEuc;
        }
        const totalHops = (hopStartToSupply < Infinity ? hopStartToSupply : 0)
          + (hopSupplyToDelivery < Infinity ? hopSupplyToDelivery : 0);
        if (totalHops > 0) travelTurns = Math.ceil(totalHops / speed);
      }
    } else if (supplyPoints.length > 0 && deliveryPoints.length > 0) {
      const botPos = snapshot.bot.position;
      let hopBotToSupply = 0;
      if (botPos) {
        hopBotToSupply = Infinity;
        for (const sp of supplyPoints) {
          const d = estimateHopDistance(botPos.row, botPos.col, sp.row, sp.col);
          if (d >= 0 && d < hopBotToSupply) hopBotToSupply = d;
        }
        if (hopBotToSupply === Infinity) {
          let minEuc = Infinity;
          for (const sp of supplyPoints) {
            const d = Math.sqrt((sp.row - botPos.row) ** 2 + (sp.col - botPos.col) ** 2);
            if (d < minEuc) minEuc = d;
          }
          if (minEuc < Infinity) hopBotToSupply = minEuc;
        }
        if (hopBotToSupply === Infinity) hopBotToSupply = 0;
      }
      let hopSupplyToDelivery = Infinity;
      for (const sp of supplyPoints) {
        for (const dp of deliveryPoints) {
          const d = estimateHopDistance(sp.row, sp.col, dp.row, dp.col);
          if (d >= 0 && d < hopSupplyToDelivery) hopSupplyToDelivery = d;
        }
      }
      if (hopSupplyToDelivery === Infinity) {
        let minEuc = Infinity;
        for (const sp of supplyPoints) {
          for (const dp of deliveryPoints) {
            const d = Math.sqrt((dp.row - sp.row) ** 2 + (dp.col - sp.col) ** 2);
            if (d < minEuc) minEuc = d;
          }
        }
        if (minEuc < Infinity) hopSupplyToDelivery = minEuc;
      }
      const totalHops = hopBotToSupply + (hopSupplyToDelivery < Infinity ? hopSupplyToDelivery : 0);
      if (totalHops > 0) travelTurns = Math.ceil(totalHops / speed);
    }
  } else if (isLoadOnTrain && snapshot.bot.position) {
    const botPos = snapshot.bot.position as { row: number; col: number };
    if (deliveryPoints.length > 0) {
      let minDist = Infinity;
      for (const dp of deliveryPoints) {
        const dist = estimateHopDistance(botPos.row, botPos.col, dp.row, dp.col);
        if (dist > 0) minDist = Math.min(minDist, dist);
      }
      if (minDist < Infinity) {
        travelTurns = Math.ceil(minDist / speed);
      } else {
        let minEuc = Infinity;
        for (const dp of deliveryPoints) {
          const eucDist = Math.sqrt((dp.row - botPos.row) ** 2 + (dp.col - botPos.col) ** 2);
          if (eucDist < minEuc) minEuc = eucDist;
        }
        if (minEuc < Infinity) travelTurns = Math.ceil(minEuc / speed);
      }
    }
  }

  const ferryCrossings = ferryRequired ? countFerryCrossings(supplyCity, deliveryCity, gridPoints) : 0;
  const estimatedTurns = buildTurns + travelTurns + (ferryCrossings * 2) + 1;

  // Build affordability
  let projectedIncome = 0;
  for (const loadType2 of snapshot.bot.loads) {
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const d of resolved.demands) {
        if (d.loadType === loadType2) { projectedIncome += d.payment; break; }
      }
    }
  }
  const projectedFunds = snapshot.bot.money + projectedIncome;
  const isAffordable = totalTrackCost <= projectedFunds;

  const corridorValue = computeCorridorValue(
    supplyCity, deliveryCity, snapshot.bot.existingSegments, gridPoints, connectedMajorCities, optimalStartingCity,
  );
  const demandScore = scoreDemand(demand.payment, totalTrackCost, estimatedTurns, isAffordable, projectedFunds);
  const efficiencyPerTurn = (demand.payment - totalTrackCost) / estimatedTurns;

  return {
    cardIndex,
    loadType,
    supplyCity: supplyCity ?? null,
    deliveryCity,
    payout: demand.payment,
    isSupplyReachable,
    isDeliveryReachable,
    isSupplyOnNetwork: supplyCity ? citiesOnNetwork.includes(supplyCity) : false,
    isDeliveryOnNetwork: citiesOnNetwork.includes(deliveryCity),
    estimatedTrackCostToSupply,
    estimatedTrackCostToDelivery,
    isLoadAvailable,
    isLoadOnTrain,
    ferryRequired,
    loadChipTotal: totalCopies,
    loadChipCarried: carriedCount,
    estimatedTurns,
    demandScore,
    efficiencyPerTurn,
    networkCitiesUnlocked: corridorValue.networkCities,
    victoryMajorCitiesEnRoute: corridorValue.victoryMajorCities,
    isAffordable,
    projectedFundsAfterDelivery: projectedFunds,
    optimalStartingCity,
  };
}

function computeBestDemandContext(
  cardIndex: number,
  demand: { city: string; loadType: string; payment: number },
  snapshot: WorldSnapshot,
  network: ReturnType<typeof buildTrackNetwork> | null,
  gridPoints: GridPoint[],
  reachableCities: string[],
  citiesOnNetwork: string[],
  connectedMajorCities: string[],
): DemandContext {
  const supplyCityNames = new Set<string>();
  for (const gp of gridPoints) {
    if (gp.city && gp.city.availableLoads.includes(demand.loadType)) {
      supplyCityNames.add(gp.city.name);
    }
  }
  if (snapshot.bot.loads.includes(demand.loadType)) {
    return computeSingleSupplyDemandContext(
      cardIndex, demand, null, snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );
  }
  if (supplyCityNames.size === 0) {
    const ctx = computeSingleSupplyDemandContext(
      cardIndex, demand, null, snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );
    ctx.supplyCity = 'NoSupply';
    ctx.estimatedTurns = 99;
    ctx.demandScore = -999;
    ctx.efficiencyPerTurn = -999;
    return ctx;
  }
  let bestContext: DemandContext | null = null;
  for (const supplyCity of supplyCityNames) {
    const ctx = computeSingleSupplyDemandContext(
      cardIndex, demand, supplyCity, snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );
    if (!bestContext || ctx.demandScore > bestContext.demandScore) bestContext = ctx;
  }
  return bestContext!;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function computeAllDemandContexts(
  snapshot: WorldSnapshot,
  network: ReturnType<typeof buildTrackNetwork> | null,
  gridPoints: GridPoint[],
  reachableCities: string[],
  citiesOnNetwork: string[],
  connectedMajorCities: string[],
): DemandContext[] {
  const contexts: DemandContext[] = [];
  for (const resolved of snapshot.bot.resolvedDemands) {
    for (const demand of resolved.demands) {
      contexts.push(
        computeBestDemandContext(resolved.cardId, demand, snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities),
      );
    }
  }
  return contexts;
}

export function computeCanDeliverFromSnapshot(
  snapshot: WorldSnapshot,
  gridPoints: GridPoint[],
): DeliveryOpportunity[] {
  if (!snapshot.bot.position) return [];
  const cityName = gridPoints.find(
    gp => gp.row === snapshot.bot.position!.row && gp.col === snapshot.bot.position!.col,
  )?.city?.name;
  if (!cityName) return [];
  const opportunities: DeliveryOpportunity[] = [];
  for (const resolved of snapshot.bot.resolvedDemands) {
    for (const demand of resolved.demands) {
      if (demand.city === cityName && snapshot.bot.loads.includes(demand.loadType)) {
        opportunities.push({
          loadType: demand.loadType,
          deliveryCity: demand.city,
          payout: demand.payment,
          cardIndex: resolved.cardId,
        });
      }
    }
  }
  return opportunities;
}

export function computeCanPickupFromSnapshot(
  snapshot: WorldSnapshot,
  gridPoints: GridPoint[],
): PickupOpportunity[] {
  if (!snapshot.bot.position) return [];
  if (snapshot.gameStatus === 'initialBuild') return [];
  const trainType = snapshot.bot.trainType as TrainType;
  const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
  if (snapshot.bot.loads.length >= capacity) return [];
  const cityName = gridPoints.find(
    gp => gp.row === snapshot.bot.position!.row && gp.col === snapshot.bot.position!.col,
  )?.city?.name;
  if (!cityName) return [];
  const availableLoads = snapshot.loadAvailability?.[cityName] ?? [];
  if (availableLoads.length === 0) return [];
  const opportunities: PickupOpportunity[] = [];
  for (const loadType of availableLoads) {
    if (snapshot.bot.loads.includes(loadType)) continue;
    let bestPayout = 0;
    let bestDeliveryCity = '';
    for (const resolved of snapshot.bot.resolvedDemands) {
      for (const demand of resolved.demands) {
        if (demand.loadType === loadType && demand.payment > bestPayout) {
          bestPayout = demand.payment;
          bestDeliveryCity = demand.city;
        }
      }
    }
    if (bestPayout > 0) {
      opportunities.push({ loadType, supplyCity: cityName, bestPayout, bestDeliveryCity });
    }
  }
  return opportunities;
}

export function computeEnRoutePickupsFromRoute(
  snapshot: WorldSnapshot,
  routeStops: RouteStop[],
  gridPoints: GridPoint[],
): EnRoutePickup[] {
  if (!routeStops || routeStops.length === 0) return [];
  if (snapshot.gameStatus === 'initialBuild') return [];

  const SCAN_RADIUS = 3;
  const MAX_RESULTS = 5;

  const cityCoords = new Map<string, { row: number; col: number }>();
  for (const gp of gridPoints) {
    if (gp.city?.name && !cityCoords.has(gp.city.name)) {
      cityCoords.set(gp.city.name, { row: gp.row, col: gp.col });
    }
  }

  const routeCoordsList: Array<{ row: number; col: number }> = [];
  const routeCityNames = new Set<string>();
  for (const stop of routeStops) {
    const coord = cityCoords.get(stop.city);
    if (coord) { routeCoordsList.push(coord); routeCityNames.add(stop.city); }
  }
  if (routeCoordsList.length === 0) return [];

  const demandMap = new Map<string, { demandCity: string; payoff: number }>();
  for (const resolved of snapshot.bot.resolvedDemands) {
    for (const demand of resolved.demands) {
      const existing = demandMap.get(demand.loadType);
      if (!existing || demand.payment > existing.payoff) {
        demandMap.set(demand.loadType, { demandCity: demand.city, payoff: demand.payment });
      }
    }
  }
  if (demandMap.size === 0) return [];

  const results: EnRoutePickup[] = [];
  const seenCityLoad = new Set<string>();

  for (const [cityName, coord] of cityCoords) {
    let minDist = Infinity;
    for (const routeCoord of routeCoordsList) {
      const dist = hexDistance(coord.row, coord.col, routeCoord.row, routeCoord.col);
      if (dist < minDist) minDist = dist;
    }
    if (minDist > SCAN_RADIUS) continue;
    const availableLoads = snapshot.loadAvailability?.[cityName] ?? [];
    for (const loadType of availableLoads) {
      const key = `${cityName}:${loadType}`;
      if (seenCityLoad.has(key)) continue;
      seenCityLoad.add(key);
      if (snapshot.bot.loads.includes(loadType)) continue;
      const demand = demandMap.get(loadType);
      if (!demand) continue;
      results.push({
        city: cityName,
        load: loadType,
        demandCity: demand.demandCity,
        payoff: demand.payoff,
        detourMileposts: minDist,
        onRoute: routeCityNames.has(cityName) || minDist === 0,
      });
    }
  }

  results.sort((a, b) => (b.payoff - b.detourMileposts) - (a.payoff - a.detourMileposts));
  return results.slice(0, MAX_RESULTS);
}
