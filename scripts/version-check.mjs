import { readFile } from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function readUiVersion(source) {
  const match = source.match(/export const VERSION = "([^"]+)";/);
  if (!match) {
    throw new Error("VERSION tidak ditemukan di src/ui.ts");
  }
  return match[1];
}

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const uiSource = await readFile("src/ui.ts", "utf8");

const versions = {
  "package.json": packageJson.version,
  "package-lock.json": packageLock.version,
  "package-lock root": packageLock.packages?.[""]?.version,
  "src/ui.ts": readUiVersion(uiSource),
};

const expected = versions["package.json"];
const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);

if (mismatches.length > 0) {
  console.error("Versi Rakit tidak sinkron:");
  for (const [name, version] of Object.entries(versions)) {
    console.error(`- ${name}: ${version ?? "(missing)"}`);
  }
  process.exit(1);
}

console.log(`Versi Rakit sinkron: ${expected}`);
