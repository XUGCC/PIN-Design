import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface WebAppManifest {
  id?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  icons?: Array<{ sizes?: string; purpose?: string }>;
}

describe("PWA manifest", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8"),
  ) as WebAppManifest;

  it("launches the home page in standalone mode", () => {
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.display).toBe("standalone");
  });

  it("provides installable regular and maskable icons", () => {
    expect(manifest.icons?.some((icon) => icon.sizes === "192x192" && icon.purpose?.includes("maskable"))).toBe(true);
    expect(manifest.icons?.some((icon) => icon.sizes === "512x512" && icon.purpose?.includes("maskable"))).toBe(true);
  });

  it("uses explicit GitHub Pages paths for stricter mobile browsers", () => {
    const githubManifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/manifest.github.webmanifest"), "utf8"),
    ) as WebAppManifest;
    expect(githubManifest.id).toBe("/PIN-Design/");
    expect(githubManifest.start_url).toBe("/PIN-Design/?source=pwa");
    expect(githubManifest.scope).toBe("/PIN-Design/");
    expect(githubManifest.display).toBe("standalone");
  });
});
