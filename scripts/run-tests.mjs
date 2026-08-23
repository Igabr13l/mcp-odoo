import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDirectory = new URL("../dist/test/", import.meta.url);
const files = (await readdir(testDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => fileURLToPath(new URL(entry.name, testDirectory)))
  .sort();

if (files.length === 0) {
  throw new Error("No compiled tests found in dist/test");
}

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});

child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
