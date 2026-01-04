import "@jest/globals";
import { TerrainType } from "../../shared/types/GameTypes";
import { PlayerTrackState } from "../../shared/types/TrackTypes";
import { computeTrackUsageForMove } from "../../shared/services/trackUsageFees";

describe("trackUsageFees.computeTrackUsageForMove", () => {
  it("returns invalid when no path exists on union graph", () => {
    const allTracks: PlayerTrackState[] = [
      {
        playerId: "p1",
        gameId: "g1",
        segments: [
          {
            from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 1, terrain: TerrainType.Clear },
            cost: 1,
          },
        ],
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      } as any,
    ];

    const result = computeTrackUsageForMove({
      allTracks,
      from: { row: 0, col: 0 },
      to: { row: 9, col: 9 },
      currentPlayerId: "p1",
      majorCityGroups: [],
    });

    expect(result.isValid).toBe(false);
    expect(result.path).toHaveLength(0);
    expect(result.ownersUsed.size).toBe(0);
  });

  it("includes opponent owners and excludes current player on shared edges", () => {
    const allTracks: PlayerTrackState[] = [
      {
        playerId: "p1",
        gameId: "g1",
        segments: [
          {
            from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 1, terrain: TerrainType.Clear },
            cost: 1,
          },
        ],
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      } as any,
      {
        playerId: "p2",
        gameId: "g1",
        segments: [
          {
            from: { x: 0, y: 0, row: 0, col: 1, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 2, terrain: TerrainType.Clear },
            cost: 1,
          },
        ],
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      } as any,
    ];

    const asP1 = computeTrackUsageForMove({
      allTracks,
      from: { row: 0, col: 0 },
      to: { row: 0, col: 2 },
      currentPlayerId: "p1",
      majorCityGroups: [],
    });
    expect(asP1.isValid).toBe(true);
    expect(asP1.ownersUsed.has("p2")).toBe(true);
    expect(asP1.ownersUsed.has("p1")).toBe(false);

    const asP2 = computeTrackUsageForMove({
      allTracks,
      from: { row: 0, col: 0 },
      to: { row: 0, col: 2 },
      currentPlayerId: "p2",
      majorCityGroups: [],
    });
    expect(asP2.isValid).toBe(true);
    expect(asP2.ownersUsed.has("p1")).toBe(true);
    expect(asP2.ownersUsed.has("p2")).toBe(false);
  });

  it("treats major-city internal edges as public (ownerless)", () => {
    const allTracks: PlayerTrackState[] = [
      {
        playerId: "p1",
        gameId: "g1",
        segments: [
          {
            from: { x: 0, y: 0, row: 0, col: 1, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 2, terrain: TerrainType.Clear },
            cost: 1,
          },
        ],
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      } as any,
    ];

    const result = computeTrackUsageForMove({
      allTracks,
      from: { row: 0, col: 2 },
      to: { row: 0, col: 0 },
      currentPlayerId: "p2",
      majorCityGroups: [
        {
          cityName: "TestCity",
          center: { row: 0, col: 0 },
          outposts: [{ row: 0, col: 1 }],
        },
      ],
    });

    expect(result.isValid).toBe(true);
    // One owned edge (0,1)-(0,2) by p1, plus one public edge (0,0)-(0,1) ownerless.
    expect(result.path.length).toBe(2);
    expect(result.ownersUsed.has("p1")).toBe(true);
    const publicEdge = result.path.find(
      (e) =>
        (e.from.row === 0 && e.from.col === 0 && e.to.row === 0 && e.to.col === 1) ||
        (e.from.row === 0 && e.from.col === 1 && e.to.row === 0 && e.to.col === 0)
    );
    expect(publicEdge?.ownerPlayerIds || []).toEqual([]);
  });
});


