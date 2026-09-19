#!/usr/bin/env node
// scripts/gen_node_catalog.mjs
// 把 apps/web/src/engine/nodeCatalog.ts 的節點能力目錄匯出成
// apps/server/node_catalog.json，供 hermes.py 在啟動時讀取。
//
// 為什麼要產生檔案而不是讓後端自己想辦法：
//   hermes.py 需要知道「有哪些節點、每個節點吃什麼 config」才能產生 pipeline。
//   以前那份清單是手寫在 hermes.py 裡的，與 astCompiler 的 switch 各寫一份，
//   於是漂移了 —— 它少了 SELECT / UNION / SAMPLE / RENAME，SUMMARIZE 的描述
//   還停在舊格式，SORT 的鍵名也寫錯。AI 因此根本產生不出這些節點。
//   現在後端只讀這份快照，唯一真相來源是 TS 目錄。
//
// 用法：
//   node scripts/gen_node_catalog.mjs           # 重新產生
//   node scripts/gen_node_catalog.mjs --check   # 只檢查是否為最新（CI / verify 用）
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, "apps", "server", "node_catalog.json");

// --- esbuild discovery（與 verify.mjs 同一套：esbuild 只存在於 .pnpm store）---
const pnpmDir = join(ROOT, "node_modules", ".pnpm");
if (!existsSync(pnpmDir)) {
	console.error("找不到 node_modules/.pnpm，請先執行 pnpm install。");
	process.exit(2);
}
const esbuildDir = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildDir) {
	console.error("找不到 esbuild，請先執行 pnpm install。");
	process.exit(2);
}
const esbuild = await import(
	pathToFileURL(join(pnpmDir, esbuildDir, "node_modules", "esbuild", "lib", "main.js")).href
);

const built = await esbuild.build({
	entryPoints: [join(ROOT, "apps/web/src/engine/nodeCatalog.ts")],
	bundle: true,
	format: "esm",
	platform: "neutral",
	write: false,
});
const dir = mkdtempSync(join(tmpdir(), "synapse-catalog-"));
const file = join(dir, "catalog.mjs");
writeFileSync(file, built.outputFiles[0].text);
const mod = await import(pathToFileURL(file).href);

const snapshot = mod.catalogSnapshot();
// 結尾一定要有換行，否則每次產生都會被 git 當成有變更
const json = JSON.stringify(snapshot, null, 2) + "\n";

if (process.argv.includes("--check")) {
	const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
	// 比對前先把 CRLF 正規化：Windows 上 core.autocrlf 會在 checkout 時把 LF
	// 換成 CRLF，若直接比 bytes，一次 fresh clone 就會讓這條守門誤報。
	// （.gitattributes 已把這個檔案釘成 LF，這裡是第二層保險 —— 不依賴 git 設定。）
	const normalize = (s) => s.replace(/\r\n/g, "\n");
	if (normalize(current) !== normalize(json)) {
		console.error(
			"✗ apps/server/node_catalog.json 與 nodeCatalog.ts 不同步。\n" +
				"  請執行：node scripts/gen_node_catalog.mjs",
		);
		process.exit(1);
	}
	console.log(`✓ node_catalog.json 是最新的（${snapshot.types.length} 種節點）`);
} else {
	writeFileSync(OUT, json, "utf8");
	console.log(
		`✓ 已寫入 ${OUT}\n  ${snapshot.types.length} 種節點、${snapshot.hintKeys.length} 個 canvas hint 鍵`,
	);
}
