import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG = "biome.json";
const STRICT_CONFIG = ".biome-strict.json";
const BASELINE = "docs/biome-overrides-baseline.json";

function identity(entry) {
  return JSON.stringify([entry.file, entry.rule, entry.message]);
}

export function summarizeDiagnostics(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const rule = diagnostic.category;
    if (!rule?.startsWith("lint/")) continue;
    const file = diagnostic.location.path;
    const key = identity({ file, rule, message: diagnostic.message });
    const current = counts.get(key);
    if (current === undefined) {
      counts.set(key, { file, rule, message: diagnostic.message, count: 1 });
    } else {
      current.count += 1;
    }
  }
  return [...counts.values()].sort((left, right) => identity(left).localeCompare(identity(right)));
}

export function compareWithBaseline(actual, baseline) {
  const expected = new Map(baseline.map((entry) => [identity(entry), entry]));
  const observed = new Map(actual.map((entry) => [identity(entry), entry]));
  const added = [];
  const changed = [];
  const stale = [];
  for (const entry of actual) {
    const recorded = expected.get(identity(entry));
    if (recorded === undefined) added.push(entry);
    else if (recorded.count !== entry.count) changed.push({ entry, recorded: recorded.count });
  }
  for (const entry of baseline) {
    if (!observed.has(identity(entry))) stale.push(entry);
  }
  return { added, changed, stale };
}

function writeStrictConfig(root) {
  const config = JSON.parse(readFileSync(join(root, CONFIG), "utf8"));
  const strict = {
    ...config,
    files: { ...config.files, includes: [...config.files.includes, `!**/${STRICT_CONFIG}`] },
    overrides: [],
  };
  writeFileSync(join(root, STRICT_CONFIG), `${JSON.stringify(strict, null, 2)}\n`);
}

function runStrictCheck(root) {
  const binary = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "biome.cmd" : "biome",
  );
  const result = spawnSync(
    binary,
    ["check", "--config-path", STRICT_CONFIG, "--reporter=json", "--max-diagnostics=none", "."],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined) throw result.error;
  const output = result.stdout.trim();
  if (output === "") {
    process.stderr.write(result.stderr);
    throw new Error("Biome produced no JSON report");
  }
  return JSON.parse(output);
}

function describe(entry) {
  return `${entry.file} ${entry.rule} ${entry.message}`;
}

export function main(root = process.cwd()) {
  writeStrictConfig(root);
  let report;
  try {
    report = runStrictCheck(root);
  } finally {
    rmSync(join(root, STRICT_CONFIG), { force: true });
  }
  const actual = summarizeDiagnostics(report.diagnostics ?? []);
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
  const { added, changed, stale } = compareWithBaseline(actual, baseline);
  if (added.length === 0 && changed.length === 0 && stale.length === 0) {
    console.log("Lint overrides hide no unreviewed diagnostics.");
    return 0;
  }
  if (added.length > 0 || changed.length > 0) {
    console.error(`Lint overrides in ${CONFIG} hide diagnostics that ${BASELINE} does not record:`);
    for (const entry of added) console.error(`  ${describe(entry)}`);
    for (const { entry, recorded } of changed) {
      console.error(`  ${describe(entry)} (baseline ${recorded}, now ${entry.count})`);
    }
    console.error(`Record each reviewed diagnostic in ${BASELINE}, or fix the code it hides.`);
  }
  if (stale.length > 0) {
    console.error(`Lint overrides no longer hide diagnostics recorded in ${BASELINE}:`);
    for (const entry of stale) console.error(`  ${describe(entry)}`);
    console.error(
      `Remove those entries from ${BASELINE} and drop any override they made redundant.`,
    );
  }
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) process.exitCode = main();
