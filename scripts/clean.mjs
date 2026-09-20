#!/usr/bin/env node
// scripts/clean.mjs
// 清掉「建置產物」—— 不動依賴，也不動原始碼。
//
// 為什麼不用 turbo：turbo 的 task 需要在每個 package 各寫一份 clean script，
// 而本專案只有 apps/web 真的產出建置物。開一個 task、加三個幾乎空的 script
// 只為了 rm 一個目錄並不划算。
//
// 為什麼要清 packages/*/dist：這兩個套件以前 build 是 `tsc`（emit 到 dist），
// 而 dist 在 .gitignore 裡。現在它們的 exports 指向 src，build 改成 `tsc --noEmit`，
// 所以 dist 只是舊版的殘留 —— 留著會讓「到底哪一份在生效」變得含糊。
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());

const TARGETS = [
	"apps/web/dist", // vite build 的產物
	".turbo", // turbo 的本地快取
	"packages/ikaros-arrow/dist", // 舊版 tsc emit 的殘留
	"packages/synapse-schema/dist",
	"packages/ikaros-arrow/dist.bak", // 舊版殘留的手動備份
	"packages/synapse-schema/dist.bak",
];

let removed = 0;
for (const rel of TARGETS) {
	const abs = join(ROOT, rel);
	if (!existsSync(abs)) continue;
	rmSync(abs, { recursive: true, force: true });
	console.log(`  已刪除 ${rel}`);
	removed += 1;
}

console.log(removed ? `✓ 清掉 ${removed} 個建置產物目錄` : "✓ 沒有建置產物需要清理");
