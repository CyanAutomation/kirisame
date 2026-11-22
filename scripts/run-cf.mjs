import { execFileSync, spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Pass a cf command, such as build, dev, or deploy.");
}

const nodeOptions = [process.env.NODE_OPTIONS, "--import=tsx"].filter(Boolean).join(" ");
const environment = { ...process.env };
if (!environment.GITHUB_SHA) {
  try {
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!dirty.trim()) {
      environment.GITHUB_SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
  } catch {
    // Diagnostics use "unknown" when a local source revision cannot be established.
  }
}
environment.KIRISAME_BUILD_TIMESTAMP ??= new Date().toISOString();
const child = spawn(process.platform === "win32" ? "cf.cmd" : "cf", args, {
  env: { ...environment, NODE_OPTIONS: nodeOptions },
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
