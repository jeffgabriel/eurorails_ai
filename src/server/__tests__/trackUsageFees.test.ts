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

  it("treats ferry edges as public (ownerless) connections", () => {
    // Player has track to one side of the ferry, wants to move to the other side
    const allTracks: PlayerTrackState[] = [
      {
        playerId: "p1",
        gameId: "g1",
        segments: [
          {
            // Track from (0,0) to (0,1) - leading to ferry port at (0,1)
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

    // Ferry connects (0,1) to (0,5) - crossing water
    const ferryEdges = [
      {
        name: "TestFerry",
        pointA: { row: 0, col: 1 },
        pointB: { row: 0, col: 5 },
      },
    ];

    const result = computeTrackUsageForMove({
      allTracks,
      from: { row: 0, col: 0 },
      to: { row: 0, col: 5 },
      currentPlayerId: "p1",
      majorCityGroups: [],
      ferryEdges,
    });

    expect(result.isValid).toBe(true);
    expect(result.path.length).toBe(2); // (0,0)-(0,1) owned + (0,1)-(0,5) ferry

    // The ferry edge should be ownerless (public)
    const ferryEdge = result.path.find(
      (e) =>
        (e.from.row === 0 && e.from.col === 1 && e.to.row === 0 && e.to.col === 5) ||
        (e.from.row === 0 && e.from.col === 5 && e.to.row === 0 && e.to.col === 1)
    );
    expect(ferryEdge).toBeDefined();
    expect(ferryEdge?.ownerPlayerIds || []).toEqual([]);

    // No usage fees should be charged (player owns track to ferry, ferry is public)
    expect(result.ownersUsed.size).toBe(0);
  });

  it("prefers longer own-track path over shorter opponent-track path", () => {
    // Bug scenario: p1 has a long route (0,0)→(0,1)→(0,2)→(0,3)→(0,4)→(0,5)
    // p2 has a shortcut (0,0)→(0,5) via (0,0)→(1,0)→(0,5)
    // BFS would pick the 2-hop opponent path; Dijkstra should pick the 5-hop own path
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
          {
            from: { x: 0, y: 0, row: 0, col: 1, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 2, terrain: TerrainType.Clear },
            cost: 1,
          },
          {
            from: { x: 0, y: 0, row: 0, col: 2, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 3, terrain: TerrainType.Clear },
            cost: 1,
          },
          {
            from: { x: 0, y: 0, row: 0, col: 3, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 4, terrain: TerrainType.Clear },
            cost: 1,
          },
          {
            from: { x: 0, y: 0, row: 0, col: 4, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 5, terrain: TerrainType.Clear },
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
            from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 1, col: 0, terrain: TerrainType.Clear },
            cost: 1,
          },
          {
            from: { x: 0, y: 0, row: 1, col: 0, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 5, terrain: TerrainType.Clear },
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
      to: { row: 0, col: 5 },
      currentPlayerId: "p1",
      majorCityGroups: [],
    });

    expect(result.isValid).toBe(true);
    // Should use own 5-hop path, NOT the 2-hop opponent shortcut
    expect(result.path.length).toBe(5);
    expect(result.ownersUsed.size).toBe(0);
  });

  it("uses opponent track only when no own-track path exists", () => {
    // p1 has track (0,0)→(0,1) and (0,4)→(0,5)
    // p2 bridges the gap: (0,1)→(0,2)→(0,3)→(0,4)
    // p1 must use p2's track to get from (0,0) to (0,5)
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
          {
            from: { x: 0, y: 0, row: 0, col: 4, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 5, terrain: TerrainType.Clear },
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
          {
            from: { x: 0, y: 0, row: 0, col: 2, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 3, terrain: TerrainType.Clear },
            cost: 1,
          },
          {
            from: { x: 0, y: 0, row: 0, col: 3, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 4, terrain: TerrainType.Clear },
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
      to: { row: 0, col: 5 },
      currentPlayerId: "p1",
      majorCityGroups: [],
    });

    expect(result.isValid).toBe(true);
    expect(result.path.length).toBe(5);
    expect(result.ownersUsed.has("p2")).toBe(true);
    expect(result.ownersUsed.has("p1")).toBe(false);
  });

  it("finds valid path across ferry to connect disconnected networks", () => {
    // Two players with track on opposite sides of a ferry
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
            from: { x: 0, y: 0, row: 0, col: 5, terrain: TerrainType.Clear },
            to: { x: 0, y: 0, row: 0, col: 6, terrain: TerrainType.Clear },
            cost: 1,
          },
        ],
        totalCost: 0,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date(),
      } as any,
    ];

    // Ferry connects (0,1) to (0,5)
    const ferryEdges = [
      {
        name: "TestFerry",
        pointA: { row: 0, col: 1 },
        pointB: { row: 0, col: 5 },
      },
    ];

    // P1 wants to travel from their track through ferry to p2's track
    const result = computeTrackUsageForMove({
      allTracks,
      from: { row: 0, col: 0 },
      to: { row: 0, col: 6 },
      currentPlayerId: "p1",
      majorCityGroups: [],
      ferryEdges,
    });

    expect(result.isValid).toBe(true);
    // Path: (0,0)-(0,1) p1 owned, (0,1)-(0,5) ferry, (0,5)-(0,6) p2 owned
    expect(result.path.length).toBe(3);
    // P1 should owe p2 for using their track
    expect(result.ownersUsed.has("p2")).toBe(true);
    expect(result.ownersUsed.has("p1")).toBe(false);
  });
});

