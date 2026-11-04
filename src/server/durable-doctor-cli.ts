import { resolve } from "node:path";
import { durableDoctor, formatDoctorReport } from "./durable-doctor.js";

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const equalsValue = (name: string) => {
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const positional = args.find(
  (arg) =>
    !arg.startsWith("--") &&
    arg !== optionValue(args, "--database") &&
    arg !== optionValue(args, "--db"),
);
const databasePath =
  optionValue(args, "--database") ??
  optionValue(args, "--db") ??
  equalsValue("--database") ??
  equalsValue("--db") ??
  positional;
const repair = args.includes("--repair");
const dryRun = !repair || args.includes("--dry-run");
const dataDir = process.env.DATA_DIR?.trim() || "data";

const report = await durableDoctor({
  databasePath: databasePath ?? resolve(process.cwd(), dataDir, "pi.sqlite3"),
  repair: repair && !dryRun,
});
process.stdout.write(`${formatDoctorReport(report)}\n`);
if (report.torn && !report.repaired) {
  process.stdout.write(
    "run with --repair to rewrite a clean base revision (a .bak copy is taken first)\n",
  );
}
