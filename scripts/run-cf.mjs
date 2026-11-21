import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Pass a cf command, such as build, dev, or deploy.");
}

const nodeOptions = [process.env.NODE_OPTIONS, "--import=tsx"].filter(Boolean).join(" ");
const child = spawn(process.platform === "win32" ? "cf.cmd" : "cf", args, {
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
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
