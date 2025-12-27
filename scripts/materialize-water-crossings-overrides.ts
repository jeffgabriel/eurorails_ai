import fs from "fs";
import path from "path";

type WaterCrossingsJson = {
  version: number;
  generatedAt?: string;
  source?: unknown;
  classification?: unknown;
  overrides?: {
    forceRiverEdges?: string[];
    forceNonRiverWaterEdges?: string[];
    excludeEdges?: string[];
  };
  riverEdges?: string[];
  nonRiverWaterEdges?: string[];
};

const WATER_CROSSINGS_JSON_PATH = path.resolve(
  __dirname,
  "..",
  "configuration",
  "waterCrossings.json"
);

function uniqSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function main(): void {
  const raw = fs.readFileSync(WATER_CROSSINGS_JSON_PATH, "utf-8");
  const json = JSON.parse(raw) as WaterCrossingsJson;

  const overrides = json.overrides || {};
  const forceRiver = new Set(overrides.forceRiverEdges || []);
  const forceNonRiver = new Set(overrides.forceNonRiverWaterEdges || []);
  const exclude = new Set(overrides.excludeEdges || []);

  const river = new Set(json.riverEdges || []);
  const nonRiver = new Set(json.nonRiverWaterEdges || []);

  // Apply forces (mutually exclusive, last writer wins doesn't matter because we enforce exclusivity).
  for (const k of forceRiver) {
    river.add(k);
    nonRiver.delete(k);
  }
  for (const k of forceNonRiver) {
    nonRiver.add(k);
    river.delete(k);
  }

  // Exclusions remove from both.
  for (const k of exclude) {
    river.delete(k);
    nonRiver.delete(k);
  }

  // Sanity: remove any residual overlaps.
  for (const k of river) {
    if (nonRiver.has(k)) nonRiver.delete(k);
  }

  const next: WaterCrossingsJson = {
    ...json,
    overrides: {
      forceRiverEdges: [],
      forceNonRiverWaterEdges: [],
      excludeEdges: [],
    },
    riverEdges: uniqSorted(river),
    nonRiverWaterEdges: uniqSorted(nonRiver),
  };

  fs.writeFileSync(WATER_CROSSINGS_JSON_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    `[materialize-water-crossings-overrides] wrote ${path.relative(
      process.cwd(),
      WATER_CROSSINGS_JSON_PATH
    )}: riverEdges=${next.riverEdges?.length ?? 0}, nonRiverWaterEdges=${
      next.nonRiverWaterEdges?.length ?? 0
    }`
  );
}

main();

