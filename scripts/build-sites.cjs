const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = resolve(__dirname, "..");
const outputDirectory = join(projectRoot, "out");
const distDirectory = join(projectRoot, "dist");
const sourceWorker = join(projectRoot, "worker", "static-index.js");
const hostingConfig = join(projectRoot, ".openai", "hosting.json");

const nextCli = require.resolve("next/dist/bin/next");
const build = spawnSync(process.execPath, [nextCli, "build"], {
  cwd: projectRoot,
  env: { ...process.env, SITES_STATIC_EXPORT: "1" },
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
if (!existsSync(join(outputDirectory, "index.html"))) throw new Error("静态构建没有生成 out/index.html");
if (!existsSync(sourceWorker)) throw new Error("缺少静态 Worker 入口");
if (!existsSync(hostingConfig)) throw new Error("缺少 Sites 托管配置");

rmSync(distDirectory, { recursive: true, force: true });
mkdirSync(join(distDirectory, "server"), { recursive: true });
mkdirSync(join(distDirectory, ".openai"), { recursive: true });
cpSync(outputDirectory, join(distDirectory, "client"), { recursive: true });
writeFileSync(join(distDirectory, "server", "index.js"), readFileSync(sourceWorker));
writeFileSync(join(distDirectory, ".openai", "hosting.json"), readFileSync(hostingConfig));

console.log("Sites deployment bundle staged in dist/");
