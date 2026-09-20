#!/usr/bin/env node
// scripts/gen_node_catalog.mjs
// 把 apps/web/src/engine/nodeCatalog.ts 的節點能力目錄匯出成**兩份衍生檔案**：
//
//   1. apps/server/node_catalog.json          —— 供 hermes.py 啟動時讀取
//   2. packages/synapse-schema/src/generated.ts —— 供 @synapse/schema 建立 zod schema
//
// 為什麼要產生檔案而不是讓後端/套件自己想辦法：
//   以前「有哪些節點、每個節點吃什麼 config」被抄了好幾份：
//     - hermes.py 的 VALID_NODE_TYPES + MUTATE_SYSTEM_PROMPT（手寫）
//     - packages/synapse-schema 的 NodeTypeEnum（手寫）
//     - astCompiler.ts 的 switch（真正會動的那一份）
//   結果是前兩份靜靜地漂移：hermes.py 少了 SELECT / UNION / SAMPLE / RENAME，
//   synapse-schema 甚至還在描述 DATA_SOURCE / AGGREGATE / SQL_CUSTOM / CHART_BI
//   這些**已經不存在**的節點。AI 因此產生不出那些節點，而 schema 套件描述的
//   是一個不存在的系統。
//
//   現在唯一真相來源是 apps/web/src/engine/nodeCatalog.ts，其餘全部衍生。
//   忘記重新產生會讓 `--check`（CI / verify 用）直接紅燈，而不是靜默漂移。
//
// 用法：
//   node scripts/gen_node_catalog.mjs           # 重新產生兩份
//   node scripts/gen_node_catalog.mjs --check   # 只檢查是否為最新（CI / verify 用）
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.cwd());
const JSON_OUT = join(ROOT, "apps", "server", "node_catalog.json");
const TS_OUT = join(ROOT, "packages", "synapse-schema", "src", "generated.ts");

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

// ---------------------------------------------------------------------------
// 衍生檔 1：給 Python 後端的 JSON 快照
// ---------------------------------------------------------------------------
// 結尾一定要有換行，否則每次產生都會被 git 當成有變更
const json = JSON.stringify(snapshot, null, 2) + "\n";

// ---------------------------------------------------------------------------
// 衍生檔 2：給 @synapse/schema 的 TypeScript
// ---------------------------------------------------------------------------
// 這份檔案只放「目錄的事實」（有哪些型別、每個型別吃哪些欄位、欄位合法值），
// 不放任何驗證邏輯 —— zod schema 由 src/index.ts 從這些事實**程式化組出來**，
// 所以在這裡看不到第二份手寫的型別清單。
function renderSchemaModule(snap) {
	const q = (v) => JSON.stringify(v);

	// FieldKind 的聯集由資料本身推導，而不是在這裡再抄一次
	// nodeCatalog.ts 的 ConfigFieldKind —— 抄一份就又多一個漂移點。
	const kinds = [...new Set(snap.nodes.flatMap((n) => n.fields.map((f) => f.kind)))].sort();

	const lines = [];
	lines.push("// ⚠️ AUTO-GENERATED — DO NOT EDIT BY HAND.");
	lines.push("//");
	lines.push(`// 由 scripts/gen_node_catalog.mjs 從 ${snap.generatedFrom} 產生。`);
	lines.push("// 重新產生：node scripts/gen_node_catalog.mjs");
	lines.push("// 檢查是否最新：node scripts/gen_node_catalog.mjs --check");
	lines.push("//");
	lines.push("// 這個檔案以前是手寫的，內容是 DATA_SOURCE / TRANSFORM / AGGREGATE /");
	lines.push("// SQL_CUSTOM / CHART_BI —— 那些節點早就不存在了，而真正的清單在");
	lines.push("// engine/nodeCatalog.ts。兩份清單漂移之後，這個套件描述的是一個");
	lines.push("// 不存在的系統。現在它由目錄產生，不可能再漂移。");
	lines.push("");
	lines.push(`export const CATALOG_VERSION = ${q(snap.version)};`);
	lines.push(`export const GENERATED_FROM = ${q(snap.generatedFrom)};`);
	lines.push("");
	lines.push("/** 目錄裡的節點型別（單一真相來源：engine/nodeCatalog.ts） */");
	lines.push("export const NODE_TYPES = [");
	for (const t of snap.types) lines.push(`\t${q(t)},`);
	lines.push("] as const;");
	lines.push("");
	lines.push("export type NodeType = (typeof NODE_TYPES)[number];");
	lines.push("");
	lines.push("/** config 欄位的資料形狀（由目錄推導） */");
	lines.push(`export type FieldKind = ${kinds.map(q).join(" | ")};`);
	lines.push("");
	lines.push("export interface FieldSpec {");
	lines.push("\treadonly name: string;");
	lines.push("\treadonly kind: FieldKind;");
	lines.push("\treadonly label: string;");
	lines.push("\treadonly required: boolean;");
	lines.push("\t/** kind = \"enum\" 時的合法值 */");
	lines.push("\treadonly values?: readonly string[];");
	lines.push("}");
	lines.push("");
	lines.push("export interface NodeMeta {");
	lines.push("\treadonly label: string;");
	lines.push("\treadonly category: string;");
	lines.push("\treadonly description: string;");
	lines.push("\t/** 上游輸入埠數量：0 = 資料來源，1 = 單輸入，2 = 雙輸入，-1 = 不限 */");
	lines.push("\treadonly inputs: number;");
	lines.push("}");
	lines.push("");
	lines.push("/**");
	lines.push(" * 每個節點型別接受的 config 欄位。");
	lines.push(" *");
	lines.push(" * 型別是 mapped type `{ [K in NodeType]: ... }` —— 刻意的：任何一個型別");
	lines.push(" * 缺少欄位宣告都會讓 tsc 編譯失敗，所以「加了節點卻忘了欄位」不可能默默通過。");
	lines.push(" */");
	lines.push("export const NODE_FIELDS: { readonly [K in NodeType]: readonly FieldSpec[] } = {");
	for (const n of snap.nodes) {
		lines.push(`\t${n.type}: [`);
		for (const f of n.fields) {
			const parts = [
				`name: ${q(f.name)}`,
				`kind: ${q(f.kind)}`,
				`label: ${q(f.label)}`,
				`required: ${Boolean(f.required)}`,
			];
			if (Array.isArray(f.values)) parts.push(`values: [${f.values.map(q).join(", ")}]`);
			lines.push(`\t\t{ ${parts.join(", ")} },`);
		}
		lines.push("\t],");
	}
	lines.push("};");
	lines.push("");
	lines.push("/** 每個節點型別的顯示資訊（同樣由 mapped type 強制完整） */");
	lines.push("export const NODE_META: { readonly [K in NodeType]: NodeMeta } = {");
	for (const n of snap.nodes) {
		lines.push(
			`\t${n.type}: { label: ${q(n.label)}, category: ${q(n.category)}, ` +
				`description: ${q(n.description)}, inputs: ${n.inputs} },`,
		);
	}
	lines.push("};");
	lines.push("");
	return lines.join("\n");
}

const ts = renderSchemaModule(snapshot);

// ---------------------------------------------------------------------------
// 寫入 / 檢查
// ---------------------------------------------------------------------------
// 比對前先把 CRLF 正規化：Windows 上 core.autocrlf 會在 checkout 時把 LF
// 換成 CRLF，若直接比 bytes，一次 fresh clone 就會讓這條守門誤報。
// （.gitattributes 已把 JSON 釘成 LF，這裡是第二層保險 —— 不依賴 git 設定。）
const normalize = (s) => s.replace(/\r\n/g, "\n");
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

if (process.argv.includes("--check")) {
	const stale = [];
	for (const [out, expected] of [
		[JSON_OUT, json],
		[TS_OUT, ts],
	]) {
		const current = existsSync(out) ? readFileSync(out, "utf8") : "";
		if (normalize(current) !== normalize(expected)) stale.push(out);
	}
	if (stale.length) {
		console.error("✗ 以下衍生檔案與 nodeCatalog.ts 不同步：");
		for (const p of stale) console.error(`    ${rel(p)}`);
		console.error("  請執行：node scripts/gen_node_catalog.mjs");
		process.exit(1);
	}
	console.log(`✓ 衍生檔案都是最新的（${snapshot.types.length} 種節點）`);
} else {
	writeFileSync(JSON_OUT, json, "utf8");
	writeFileSync(TS_OUT, ts, "utf8");
	console.log(
		`✓ 已寫入 ${snapshot.types.length} 種節點、${snapshot.hintKeys.length} 個 canvas hint 鍵\n` +
			`  ${rel(JSON_OUT)}\n  ${rel(TS_OUT)}`,
	);
}
