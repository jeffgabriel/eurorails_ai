# Compounds Skill Usage Log

Tracks when the compounds skill was used and what benefit it provided.

| Date | Task/Context | Benefit |
|------|-------------|---------|
| 2026-02-14 | Track usage fee bug — BFS picks shortest path through opponent track instead of own track | Identified all key files (trackUsageFees.ts, MovementExecutor.ts, UIManager.ts, PlayerStateService.ts) and the full data flow (computeTrackUsageForMove → bfsPath → confirmOpponentTrackFee popup) in a single query, enabling quick root cause identification |
| 2026-02-14 | Bot builds track randomly, never reaches demand cities | Compounds identified OptionGenerator, computeBuildSegments, identifyTargetCity, and determineStartPositions as the key components. Revealed that computeBuildSegments had no target parameter and generateBuildTrackOptions never passed demand info. Confirmed BuildTowardMajorCity action type existed but was never generated. |
| 2026-02-14 | Investigate server-side reversal enforcement | Compounds traced the full movement flow: moveTrainForUser → position update → movement_history. Found the client-side reversal logic (isReversalByDirectionFallback, isTerrainCityOrFerry) in TrainMovementManager.ts and confirmed no equivalent exists server-side. Also identified that movement_history already stores per-move segments server-side, providing the data needed for direction detection. |
