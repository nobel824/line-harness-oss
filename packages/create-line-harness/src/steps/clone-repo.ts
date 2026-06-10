import * as p from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import {
  isGeneratedInstalledWranglerToml,
  renderInstalledWranglerToml,
  resolveInstalledWranglerConfig,
  type SavedInstallConfig,
} from "../lib/installed-wrangler.js";
import { repoPnpm } from "../lib/pnpm.js";

const REPO_URL =
  process.env.LINE_HARNESS_REPO_URL ??
  "https://github.com/Shudesu/line-harness-oss.git";

/**
 * Make sure workspace dependencies are installed.
 *
 * The build step (`deployWorker`) relies on workspace binaries such as `tsc`
 * and `tsup`, which only exist once `pnpm install` has populated
 * `node_modules`. Resolving the repo from an existing checkout (`--repo-dir`,
 * cwd, or `~/.line-harness`) used to skip the install entirely, so a checkout
 * without `node_modules` would fail the build with "tsc: command not found".
 */
async function ensureDependencies(repoDir: string): Promise<void> {
  if (existsSync(join(repoDir, "node_modules"))) {
    return;
  }

  const s = p.spinner();
  s.start("依存関係インストール中...");
  try {
    await repoPnpm(repoDir, ["install", "--frozen-lockfile"], { cwd: repoDir });
  } catch {
    // Lockfile may be out of sync — fall back to a normal install.
    await repoPnpm(repoDir, ["install"], { cwd: repoDir });
  }
  s.stop("依存関係インストール完了");
}

/**
 * Clone the LINE Harness repo and install dependencies.
 * Returns the path to the cloned repo.
 */
export async function ensureRepo(repoDir: string | null): Promise<string> {
  // If --repo-dir was given and has the repo, use it
  if (repoDir && existsSync(join(repoDir, "pnpm-workspace.yaml"))) {
    await ensureDependencies(repoDir);
    return repoDir;
  }

  // Check if cwd is the repo
  if (existsSync(join(process.cwd(), "pnpm-workspace.yaml"))) {
    await ensureDependencies(process.cwd());
    return process.cwd();
  }

  // Check standard install location
  const homeDir = join(
    process.env.HOME || process.env.USERPROFILE || tmpdir(),
    ".line-harness",
  );
  if (existsSync(join(homeDir, "pnpm-workspace.yaml"))) {
    const wranglerTomlPath = join(homeDir, "apps/worker/wrangler.toml");
    const configPath = join(homeDir, ".line-harness-config.json");
    let installedToml: string | null = null;

    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(
          readFileSync(configPath, "utf-8"),
        ) as SavedInstallConfig;
        const resolved = resolveInstalledWranglerConfig(config);
        if (resolved) {
          installedToml = renderInstalledWranglerToml(resolved);
        }
      } catch {
        // Ignore unreadable config and continue with a normal pull.
      }
    }

    if (existsSync(wranglerTomlPath)) {
      try {
        const currentToml = readFileSync(wranglerTomlPath, "utf-8");
        if (isGeneratedInstalledWranglerToml(currentToml)) {
          await execa("git", ["checkout", "--", "apps/worker/wrangler.toml"], {
            cwd: homeDir,
          });
        }
      } catch {
        // Best effort — if the file stays dirty, the pull below may fail.
      }
    }

    // Pull latest
    const s = p.spinner();
    s.start("最新バージョンを取得中...");
    try {
      await execa("git", ["pull", "--ff-only"], { cwd: homeDir });
    } catch {
      // Non-critical, continue with existing
    }
    s.stop("リポジトリ更新完了");

    if (installedToml) {
      try {
        writeFileSync(wranglerTomlPath, installedToml);
      } catch {
        // Non-critical — the next setup run will regenerate it again.
      }
    }
    await ensureDependencies(homeDir);
    return homeDir;
  }

  // Clone fresh
  const s = p.spinner();
  s.start("LINE Harness をダウンロード中...");

  try {
    await execa("git", ["clone", "--depth", "1", REPO_URL, homeDir]);
  } catch (error: any) {
    s.stop("ダウンロード失敗");
    throw new Error(
      `git clone に失敗しました: ${error.message}\ngit がインストールされているか確認してください。`,
    );
  }
  s.stop("ダウンロード完了");

  // Install dependencies
  await ensureDependencies(homeDir);

  return homeDir;
}
