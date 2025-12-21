import { mapConfig } from "../../../client/config/mapConfig";
import { TerrainType, type GridPoint, WaterCrossingType } from "../../types/GameTypes";
import { getWaterCrossingExtraCost } from "../waterCrossings";
import crossings from "../../../../configuration/waterCrossings.json";

type WaterCrossingsJson = {
  riverEdges: string[];
  nonRiverWaterEdges: string[];
};

const json = crossings as unknown as WaterCrossingsJson;

const TERRAIN_COSTS: Record<TerrainType, number> = {
  [TerrainType.Clear]: 1,
  [TerrainType.Mountain]: 2,
  [TerrainType.Alpine]: 5,
  [TerrainType.SmallCity]: 3,
  [TerrainType.MediumCity]: 3,
  [TerrainType.MajorCity]: 5,
  [TerrainType.Water]: 0,
  [TerrainType.FerryPort]: 0,
};

function parseEdgeKey(key: string): { a: { row: number; col: number }; b: { row: number; col: number } } {
  const [a, b] = key.split("|");
  if (!a || !b) throw new Error(`Invalid edge key (missing '|'): ${key}`);
  const [ar, ac] = a.split(",").map((v) => Number(v.trim()));
  const [br, bc] = b.split(",").map((v) => Number(v.trim()));
  if (![ar, ac, br, bc].every(Number.isFinite)) throw new Error(`Invalid edge key: ${key}`);
  return { a: { row: ar, col: ac }, b: { row: br, col: bc } };
}

function buildPointLookup(): Map<string, GridPoint> {
  const m = new Map<string, GridPoint>();
  for (const p of mapConfig.points) {
    m.set(`${p.row},${p.col}`, p);
  }
  return m;
}

function findEdge(
  edgeKeys: string[],
  predicate: (p1: GridPoint, p2: GridPoint) => boolean
): { from: GridPoint; to: GridPoint; key: string } {
  const lookup = buildPointLookup();
  for (const key of edgeKeys) {
    const { a, b } = parseEdgeKey(key);
    const p1 = lookup.get(`${a.row},${a.col}`);
    const p2 = lookup.get(`${b.row},${b.col}`);
    if (!p1 || !p2) continue;

    // Try both orientations; tests treat "to" as the build destination.
    if (predicate(p1, p2)) return { from: p1, to: p2, key };
    if (predicate(p2, p1)) return { from: p2, to: p1, key };
  }
  throw new Error("No edge found matching predicate. The generated configuration may have changed.");
}

function segmentTotalCost(from: GridPoint, to: GridPoint): number {
  return TERRAIN_COSTS[to.terrain] + getWaterCrossingExtraCost(from, to);
}

describe("water crossing costs (from generated configuration)", () => {
  it("crossing a river adds +2 on clear terrain", () => {
    const edge = findEdge(json.riverEdges, (_from, to) => to.terrain === TerrainType.Clear);

    const extra = getWaterCrossingExtraCost(edge.from, edge.to);
    expect(extra).toBe(WaterCrossingType.River);

    expect(segmentTotalCost(edge.from, edge.to)).toBe(TERRAIN_COSTS[TerrainType.Clear] + 2);
  });

  it("crossing a river into a (small/medium) city adds +2 on top of city cost", () => {
    const edge = findEdge(
      json.riverEdges,
      (_from, to) => to.terrain === TerrainType.SmallCity || to.terrain === TerrainType.MediumCity
    );

    const extra = getWaterCrossingExtraCost(edge.from, edge.to);
    expect(extra).toBe(WaterCrossingType.River);

    expect(segmentTotalCost(edge.from, edge.to)).toBe(TERRAIN_COSTS[edge.to.terrain] + 2);
  });

  it("crossing a non-river body of water adds +3 on clear terrain", () => {
    const edge = findEdge(
      json.nonRiverWaterEdges,
      (_from, to) => to.terrain === TerrainType.Clear
    );

    const extra = getWaterCrossingExtraCost(edge.from, edge.to);
    expect(extra).toBe(WaterCrossingType.Lake);

    expect(segmentTotalCost(edge.from, edge.to)).toBe(TERRAIN_COSTS[TerrainType.Clear] + 3);
  });

  it("crossing a river to connect to a mountain adds +2 on top of mountain cost", () => {
    const edge = findEdge(json.riverEdges, (_from, to) => to.terrain === TerrainType.Mountain);

    const extra = getWaterCrossingExtraCost(edge.from, edge.to);
    expect(extra).toBe(WaterCrossingType.River);

    expect(segmentTotalCost(edge.from, edge.to)).toBe(TERRAIN_COSTS[TerrainType.Mountain] + 2);
  });
});

