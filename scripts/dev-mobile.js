const os = require("node:os");
const { spawn } = require("node:child_process");

const port = Number(process.env.PORT || 3000);

function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);

  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

const addresses = Object.values(os.networkInterfaces())
  .flatMap((entries) => entries || [])
  .filter(
    (entry) =>
      entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address),
  )
  .map((entry) => entry.address);

const uniqueAddresses = [...new Set(addresses)];
const commonHomeAddresses = uniqueAddresses.filter((address) =>
  address.startsWith("192.168."),
);
const displayedAddresses =
  commonHomeAddresses.length > 0 ? commonHomeAddresses : uniqueAddresses;

console.log("\n手机联调地址（手机和电脑需连接同一个 Wi-Fi）：");

if (displayedAddresses.length === 0) {
  console.log("  未找到局域网 IPv4 地址，请运行 ipconfig 后手动查看 WLAN 地址。");
} else {
  displayedAddresses.forEach((address) => {
    console.log(`  http://${address}:${port}`);
  });
}

console.log("\n保持此窗口运行；保存代码后，手机页面会自动更新。\n");

const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(
  process.execPath,
  [nextBin, "dev", "--hostname", "0.0.0.0", "--port", String(port)],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
