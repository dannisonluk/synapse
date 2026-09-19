#!/usr/bin/env node
// scripts/verify.mjs
// Synapse 引擎回歸驗證。
//
// 這些測試守住的是「看起來沒問題、但實際會靜靜地壞」的 bug —— 全部是真實
// 修過的 regression，不是為了寫而寫：
//   1. Kahn 拓撲排序（下游先於上游執行 / cycle 偵測失效）
//   2. Hermes patch 邊線對照（Map key 型別不符 → 全部邊變懸空）
//   3. SQL 編譯器注入防護（值 / 運算子 / 函數 / JOIN 類型 / 表達式）
//
// 用法：node scripts/verify.mjs      （在 repo root 執行）
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDuckDbWasmChecks } from "./verify_duckdb_wasm.mjs";

const ROOT = resolve(process.cwd());
/** 由 scripts/gen_node_catalog.mjs 產生；後端 hermes.py 讀的就是這一份 */
const CATALOG_JSON = join(ROOT, "apps", "server", "node_catalog.json");
let failures = 0;
let checks = 0;

function check(name, actual, expected) {
	checks++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
	} else {
		failures++;
		console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
		console.log(`        got      ${a}`);
		console.log(`        expected ${e}`);
	}
}

function has(name, haystack, needle, want = true) {
	check(name, String(haystack).includes(needle), want);
}

function section(title) {
	console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ---------------------------------------------------------------------------
// esbuild discovery — esbuild 只存在於 .pnpm store 內（pnpm 不會 hoist 它）
// ---------------------------------------------------------------------------
let esbuild = null;
const pnpmDir = join(ROOT, "node_modules", ".pnpm");
if (existsSync(pnpmDir)) {
	const dir = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
	if (dir) {
		esbuild = await import(
			pathToFileURL(join(pnpmDir, dir, "node_modules", "esbuild", "lib", "main.js")).href
		);
	}
}
if (!esbuild) {
	console.error("找不到 esbuild（node_modules/.pnpm）。請先執行 pnpm install。");
	process.exit(2);
}

/** 將一個 TS entry bundle 成 ESM 再 import —— 測的是真代碼，不是複製品 */
async function loadTs(entry, opts = {}) {
	const out = await esbuild.build({
		entryPoints: [join(ROOT, entry)],
		bundle: true,
		format: "esm",
		// apache-arrow 會拉入 CJS 依賴 flatbuffers；platform "neutral" 解析不到
		// （main field 被忽略），所以需要它的模組要用 platform: "node"。
		platform: opts.platform || "neutral",
		write: false,
		external: opts.external || ["@xyflow/react"],
	});
	const dir = mkdtempSync(join(tmpdir(), "synapse-verify-"));
	const file = join(dir, "mod.mjs");
	writeFileSync(file, out.outputFiles[0].text);
	return import(pathToFileURL(file).href);
}

// ===========================================================================
// 1. Topological scheduler
// ===========================================================================
const sched = await loadTs("apps/web/src/engine/scheduler.ts");
section("1. scheduler.ts — Kahn's Algorithm");

check("chain ff->aa runs ff first (id order must not win)",
	sched.topologicalSort(["node_aa", "node_ff"], [{ source: "node_ff", target: "node_aa" }]),
	["node_ff", "node_aa"]);
check("diamond: A first, D last",
	sched.topologicalSort(["A", "B", "C", "D"], [
		{ source: "A", target: "B" }, { source: "A", target: "C" },
		{ source: "B", target: "D" }, { source: "C", target: "D" },
	]), ["A", "B", "C", "D"]);
check("2-cycle detected (not silently ordered)",
	sched.topologicalSort(["a", "b"], [{ source: "a", target: "b" }, { source: "b", target: "a" }]), null);
check("self-loop detected", sched.topologicalSort(["a"], [{ source: "a", target: "a" }]), null);
check("parallel edges (JOIN left+right from one source) counted once",
	sched.topologicalSort(["p", "j"], [
		{ source: "p", target: "j", targetHandle: "left" },
		{ source: "p", target: "j", targetHandle: "right" },
	]), ["p", "j"]);
check("dangling edge ignored", sched.topologicalSort(["a"], [{ source: "ghost", target: "a" }]), ["a"]);
check("4-node reverse-alphabetical chain",
	sched.topologicalSort(["d", "c", "b", "a"], [
		{ source: "d", target: "c" }, { source: "c", target: "b" }, { source: "b", target: "a" },
	]), ["d", "c", "b", "a"]);

{
	const nodes = ["in", "f", "s", "v", "other"].map((id) => ({ id }));
	const edges = [
		{ source: "in", target: "f" }, { source: "f", target: "s" }, { source: "s", target: "v" },
	];
	check("ancestor closure of v = whole chain",
		sched.getAncestorClosure("v", nodes, edges).map((n) => n.id).sort(), ["f", "in", "s", "v"]);
	check("ancestor closure of f excludes downstream",
		sched.getAncestorClosure("f", nodes, edges).map((n) => n.id).sort(), ["f", "in"]);
	check("failure at f blocks only s,v (not unrelated)",
		[...sched.findDescendants(["f"], nodes, edges)].sort(), ["s", "v"]);
	check("subgraph sorted upstream-first",
		sched.sortSubgraphTopologically([{ id: "node_zz" }, { id: "node_yy" }],
			[{ source: "node_zz", target: "node_yy" }]).map((n) => n.id),
		["node_zz", "node_yy"]);
}

// ===========================================================================
// 2. SQL compiler
// ===========================================================================
const sqlMod = await loadTs("apps/web/src/engine/astCompiler.ts");
section("2. astCompiler.ts / sql.ts — 編譯 + 注入防護");
const NODE = "node_ab12cd";
const E = (source, target, targetHandle) => ({ source, target, targetHandle });
const gen = (type, config, upstream = []) =>
	sqlMod.generateSqlFromConfig(NODE, type, config, upstream);
/** 只取 SELECT 本體（無 DDL 外殼）—— 注入防護測試的關注點在這裡 */
const body = (type, config, upstream = []) =>
	sqlMod.compileNodeSelect(NODE, type, config, upstream);

check("no upstream -> raw_data", sqlMod.resolveSourceTables(NODE, "FILTER", []), ["raw_data"]);
check("JOIN left handle first",
	sqlMod.resolveSourceTables(NODE, "JOIN", [E("node_r", NODE, "right"), E("node_l", NODE, "left")]),
	["node_l", "node_r"]);
check("JOIN with one input pads raw_data",
	sqlMod.resolveSourceTables(NODE, "JOIN", [E("node_l", NODE, "left")]), ["node_l", "raw_data"]);
check("normal node pages its own table", sqlMod.outputTableFor(NODE, "FILTER", []), NODE);
check("VIZ_CHART pages upstream table (creates none)",
	sqlMod.outputTableFor(NODE, "VIZ_CHART", [E("node_u", NODE)]), "node_u");

check("FILTER numeric literal stays bare", body("FILTER", { field: "amount", op: ">", val: "1000" }, ["node_u"]),
	'SELECT * FROM "node_u" WHERE "amount" > 1000');
check("FILTER value single-quote doubled", body("FILTER", { field: "name", op: "=", val: "O'Brien" }, ["node_u"]),
	'SELECT * FROM "node_u" WHERE "name" = \'O\'\'Brien\'');
check("FILTER injection stays inside one literal",
	body("FILTER", { field: "name", op: "=", val: "x'; DROP TABLE users; --" }, ["node_u"]),
	'SELECT * FROM "node_u" WHERE "name" = \'x\'\'; DROP TABLE users; --\'');
has("FILTER identifier quote doubled", body("FILTER", { field: 'evil"col', op: ">", val: "1" }, ["node_u"]), '"evil""col"');
check("FILTER bogus operator -> default", body("FILTER", { field: "amount", op: "> 1; DROP TABLE x", val: "1" }, ["node_u"]),
	'SELECT * FROM "node_u" WHERE "amount" > 1');

// --- FILTER true / false 雙輸出（修正「false 埠是假的」） ---
{
	const stmts = sqlMod.compileNodeStatements(NODE, "FILTER",
		{ field: "amount", op: ">", val: "1000" }, ["node_u"]);
	check("FILTER emits two statements (true + false)", stmts.length, 2);
	check("true branch is the node's own table", stmts[0],
		`CREATE OR REPLACE TEMP TABLE "${NODE}" AS SELECT * FROM "node_u" WHERE "amount" > 1000;`);
	check("false branch gets its own table", stmts[1],
		`CREATE OR REPLACE TEMP TABLE "${NODE}__false" AS SELECT * FROM "node_u" WHERE NOT COALESCE(("amount" > 1000), FALSE);`);
	check("false branch uses COALESCE, not a naive NOT",
		stmts[1].includes("NOT COALESCE("), true);
	check("falseBranch:false suppresses the second table",
		sqlMod.compileNodeStatements(NODE, "FILTER", {}, ["node_u"], { falseBranch: false }).length, 1);
	check("non-FILTER nodes emit a single statement",
		sqlMod.compileNodeStatements(NODE, "SORT", {}, ["node_u"]).length, 1);
	check("generateSqlFromConfig joins the statements",
		gen("FILTER", { field: "amount", op: ">", val: "1000" }, ["node_u"]), stmts.join("\n"));
	check("falseBranchTable naming", sqlMod.falseBranchTable("node_x"), "node_x__false");
}

check("branchTableName maps the false handle", sqlMod.branchTableName("n", "false"), "n__false");
check("branchTableName leaves other handles alone",
	[sqlMod.branchTableName("n", "true"), sqlMod.branchTableName("n", undefined), sqlMod.branchTableName("n", null)],
	["n", "n", "n"]);
check("downstream on the false port reads the __false table",
	sqlMod.resolveSourceTables("node_d", "SORT",
		[{ source: "node_f", target: "node_d", sourceHandle: "false", targetHandle: "left" }]),
	["node_f__false"]);
check("downstream on the true port reads the main table",
	sqlMod.resolveSourceTables("node_d", "SORT",
		[{ source: "node_f", target: "node_d", sourceHandle: "true", targetHandle: "left" }]),
	["node_f"]);
check("missing sourceHandle still reads the main table (back-compat)",
	sqlMod.resolveSourceTables("node_d", "SORT", [{ source: "node_f", target: "node_d" }]), ["node_f"]);
check("false port into a JOIN still orders left-first",
	sqlMod.resolveSourceTables("node_j", "JOIN", [
		{ source: "node_f", target: "node_j", sourceHandle: "false", targetHandle: "right" },
		{ source: "node_l", target: "node_j", targetHandle: "left" },
	]), ["node_l", "node_f__false"]);

has("SUMMARIZE valid func", gen("SUMMARIZE", { groupBy: "year", func: "SUM", target: "amount" }, ["node_u"]),
	'SUM("amount") AS "amount_sum"');
has("SUMMARIZE invalid func -> SUM", gen("SUMMARIZE", { groupBy: "y", func: "SUM(a); DROP TABLE t; --", target: "amount" }, ["node_u"]),
	'SUM("amount")');
has("SUMMARIZE func injection removed", gen("SUMMARIZE", { groupBy: "y", func: "SUM(a); DROP TABLE t; --", target: "amount" }, ["node_u"]),
	"DROP TABLE t", false);

check("JOIN keeps both tables' columns (was a.* only)",
	body("JOIN", { joinType: "LEFT", leftKey: "id", rightKey: "id" }, ["node_l", "node_r"]),
	'SELECT a.*, b.* FROM "node_l" a LEFT JOIN "node_r" b ON a."id" = b."id"');
has("JOIN bad type -> INNER", gen("JOIN", { joinType: "INNER JOIN x ON 1=1; DROP TABLE t; --", leftKey: "id", rightKey: "id" }, ["node_l", "node_r"]),
	"a INNER JOIN");

has("FORMULA legit expression kept", gen("FORMULA", { outputColumn: "v", expression: "amount * 1.1" }, ["node_u"]), "(amount * 1.1)");
has("FORMULA multi-statement rejected", gen("FORMULA", { outputColumn: "v", expression: "1; DROP TABLE u" }, ["node_u"]), "DROP TABLE u", false);
has("FORMULA comment rejected", gen("FORMULA", { outputColumn: "v", expression: "1 -- x" }, ["node_u"]), "--", false);
has("FORMULA DDL rejected", gen("FORMULA", { outputColumn: "v", expression: "DROP TABLE u" }, ["node_u"]), "DROP TABLE", false);

has("INPUT_DUCKDB no file -> raw_data", gen("INPUT_DUCKDB", {}), 'FROM "raw_data"');
has("INPUT_DUCKDB uploaded file -> src_ table", gen("INPUT_DUCKDB", { fileName: "s.csv", tableName: "src_x" }), 'FROM "src_x"');
check("VIZ_CHART bounded SELECT", gen("VIZ_CHART", {}, ["node_u"]), 'SELECT * FROM "node_u" LIMIT 2000;');
has("unknown type -> passthrough", gen("WAT", {}, ["node_u"]), 'SELECT * FROM "node_u"');

// --- compileNodeSelect：DDL 外殼與本體分離（exporter 靠這個做 CTE） ---
check("compileNodeSelect returns bare body",
	sqlMod.compileNodeSelect(NODE, "FILTER", { field: "amount", op: ">", val: "1000" }, ["node_u"]),
	'SELECT * FROM "node_u" WHERE "amount" > 1000');
has("compileNodeSelect carries no DDL", sqlMod.compileNodeSelect(NODE, "FILTER", {}, ["node_u"]), "CREATE", false);
has("compileNodeSelect has no trailing semicolon",
	sqlMod.compileNodeSelect(NODE, "FILTER", {}, ["node_u"]).endsWith(";"), false);
check("generateSqlFromConfig == wrapper around compileNodeSelect",
	gen("SORT", { field: "a" }, ["node_u"]),
	`CREATE OR REPLACE TEMP TABLE "${NODE}" AS ${sqlMod.compileNodeSelect(NODE, "SORT", { field: "a" }, ["node_u"])};`);
check("VIZ_CHART body is unwrapped too",
	sqlMod.compileNodeSelect(NODE, "VIZ_CHART", {}, ["node_u"]),
	'SELECT * FROM "node_u" LIMIT 2000');
check("producesOutputTable(VIZ_CHART) is false", sqlMod.producesOutputTable("VIZ_CHART"), false);
check("producesOutputTable(FILTER) is true", sqlMod.producesOutputTable("FILTER"), true);

// --- SORT / SELECT：編譯器一直支援，但之前面板沒有入口（新增回歸） ---
check("SORT binds to field",
	sqlMod.compileNodeSelect(NODE, "SORT", { field: "amount" }, ["node_u"]),
	'SELECT * FROM "node_u" ORDER BY "amount"');
check("SORT still accepts legacy groupBy (Hermes payload)",
	sqlMod.compileNodeSelect(NODE, "SORT", { groupBy: "year" }, ["node_u"]),
	'SELECT * FROM "node_u" ORDER BY "year"');
check("SORT defaults to id",
	sqlMod.compileNodeSelect(NODE, "SORT", {}, ["node_u"]),
	'SELECT * FROM "node_u" ORDER BY "id"');
check("SELECT projects the chosen columns",
	sqlMod.compileNodeSelect(NODE, "SELECT", { columns: ["id", "name"] }, ["node_u"]),
	'SELECT "id", "name" FROM "node_u"');
check("SELECT with no columns is a passthrough",
	sqlMod.compileNodeSelect(NODE, "SELECT", { columns: [] }, ["node_u"]),
	'SELECT * FROM "node_u"');
check("SELECT quotes a hostile column name",
	sqlMod.compileNodeSelect(NODE, "SELECT", { columns: ['a"b'] }, ["node_u"]),
	'SELECT "a""b" FROM "node_u"');
check("SELECT creates its own output table",
	sqlMod.generateSqlFromConfig(NODE, "SELECT", { columns: [] }, ["node_u"]),
	`CREATE OR REPLACE TEMP TABLE "${NODE}" AS SELECT * FROM "node_u";`);

// ===========================================================================
// 3. Hermes patch resolution
// ===========================================================================
const patchMod = await loadTs("apps/web/src/engine/patch.ts");
section("3. patch.ts — Hermes patch → 畫布邊線對照");

// 這個 fixture 是由真實後端 hermes._validate_ast_patch() 的輸出捕捉下來的。
const BACKEND_PATCH = {
	nodes: [
		{ id: "n0", sourceIndex: 0, type: "INPUT_DUCKDB", label: "Input Data", config: {} },
		{ id: "n1", sourceIndex: 1, type: "FILTER", label: "Filter", config: { field: "amount", op: ">", val: "1000" } },
		{ id: "n2", sourceIndex: 2, type: "SUMMARIZE", label: "By Country", config: { groupBy: "country", func: "SUM", target: "amount" } },
		{ id: "n3", sourceIndex: 3, type: "VIZ_CHART", label: "Bar Chart", config: { chartType: "BAR" } },
	],
	edges: [
		{ source: "n0", target: "n1", targetHandle: "left" },
		{ source: "n1", target: "n2", targetHandle: "left" },
		{ source: "n2", target: "n3", targetHandle: "left" },
		{ source: "n3", target: "node_existing_on_canvas", targetHandle: "left" },
	],
};
const EXISTING = ["node_existing_on_canvas", "node-init"];

let n = 0;
const makeId = () => `node_gen${String(++n).padStart(2, "0")}`;
const r = patchMod.resolveAstPatch(BACKEND_PATCH, EXISTING, makeId);
const ids = r.nodes.map((x) => x.newNodeId);
const realIds = new Set(ids);

check("all 4 edges kept", r.edges.length, 4);
check("no edge points at literal 'n0' (the old bug)",
	r.edges.some((e) => e.source === "n0" || e.target === "n0"), false);
check("every endpoint resolves to a real node",
	r.edges.every((e) =>
		(realIds.has(e.source) || EXISTING.includes(e.source)) &&
		(realIds.has(e.target) || EXISTING.includes(e.target))), true);
check("chain wired end to end",
	r.edges.map((e) => `${e.source}>${e.target}`),
	[`${ids[0]}>${ids[1]}`, `${ids[1]}>${ids[2]}`, `${ids[2]}>${ids[3]}`, `${ids[3]}>node_existing_on_canvas`]);
check("VIZ_CHART -> chart renderer", r.nodes[3].flowNodeType, "vizChartNode");
check("others -> alteryx renderer", r.nodes.slice(0, 3).map((x) => x.flowNodeType),
	["alteryxNode", "alteryxNode", "alteryxNode"]);

{
	let d = 0;
	const dirty = patchMod.resolveAstPatch(
		{ nodes: BACKEND_PATCH.nodes, edges: [...BACKEND_PATCH.edges, { source: "n0", target: "n99" }] },
		EXISTING, () => `node_dirty${++d}`);
	check("unresolvable edge dropped defensively", dirty.droppedEdges, 1);
}
{
	const collapsed = patchMod.resolveAstPatch(BACKEND_PATCH, EXISTING, () => "node_same");
	check("self-loop guard drops collapsed intra-patch edges", collapsed.droppedEdges, 3);
	check("self-loop guard keeps edge into distinct canvas node", collapsed.edges.length, 1);
}
check("toFlowEdges marks particleEdge + animated",
	(() => { const f = patchMod.toFlowEdges(r.edges, () => "e"); return [f.length, f[0].type, f[0].animated]; })(),
	[4, "particleEdge", true]);

// 舊版邏輯回歸證明：Map key 是 number 但查 string → 全部 miss
{
	const oldMap = new Map();
	r.nodes.forEach((x) => oldMap.set(x.sourceIndex, x.newNodeId));
	const oldResolve = (ref) => (typeof ref === "string" && ref.startsWith("n") && oldMap.has(ref.slice(1))
		? oldMap.get(ref.slice(1)) : String(ref));
	check("OLD resolver really produced dangling 'n0'", oldResolve("n0"), "n0");
	check("NEW resolver produces a real node id", r.edges[0].source.startsWith("node_gen"), true);
}

// --- 3b. 新增節點類型經 Hermes patch 進入畫布的路徑 ---------------------------
// 前面驗證了「編譯器懂新工具」，但 Hermes 的 patch 是另一條入口：
// 若 patch.ts 不認得新 type，節點會靜默變成 FILTER 或根本渲染不出來。
{
	const catalogMod = await loadTs("apps/web/src/engine/nodeCatalog.ts");
	const catalog = catalogMod.NODE_CATALOG;
	const catalogTypes = Object.keys(catalog).sort();

	// 3b-1. 每個 catalogue 條目的 nodeType 必須是畫布 nodeTypes registry 的 key。
	// 這個 union 是手寫的，不是從 registry 推導 —— 改錯名字 tsc 不會叫，
	// 只會讓節點在畫布上變成空白。
	const canvasSrc = readFileSync(join(ROOT, "apps", "web", "src", "components", "nymph", "NymphCanvas.tsx"), "utf8");
	const registryMatch = /const nodeTypes\s*=\s*\{([\s\S]*?)\n\};/.exec(canvasSrc);
	const registryKeys = registryMatch
		? [...registryMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1])
		: [];
	check("parsed the canvas nodeTypes registry", registryKeys.sort(), ["alteryxNode", "sqlNode", "vizChartNode"]);
	check("every catalogue nodeType is a real canvas renderer",
		[...new Set(Object.values(catalog).map((s) => s.nodeType))].filter((t) => !registryKeys.includes(t)),
		[]);

	// 3b-2. 一個含新工具 + 幻覺 config key 的 patch，走完 patch.ts 之後：
	// type 保留、nodeType 正確、config 被 normalizeConfig 收斂。
	// 欄位名刻意用 catalogue 的真實名稱 —— 打錯字會被 normalizeConfig 靜默丟掉，
	// 所以這幾條 assertion 同時守著「名字對」和「名字錯會被擋」。
	const NEW_PATCH = {
		nodes: [
			{ id: "n0", sourceIndex: 0, type: "INPUT_DUCKDB", label: "In", config: { tableName: "raw_data" } },
			{ id: "n1", sourceIndex: 1, type: "UNIQUE", label: "Dedupe",
			  config: { columns: ["id"], sortField: "hallucinated" } },
			{ id: "n2", sourceIndex: 2, type: "RUNNING_TOTAL", label: "Cumulative",
			  config: { target: "amount", partitionBy: ["country"], orderBy: "seq" } },
			{ id: "n3", sourceIndex: 3, type: "CROSS_TAB", label: "Pivot",
			  config: { pivotColumn: "category", valueColumn: "amount", aggFunc: "SUM", groupBy: ["country"] } },
		],
		edges: [
			{ source: "n0", target: "n1", targetHandle: "left" },
			{ source: "n1", target: "n2", targetHandle: "left" },
			{ source: "n2", target: "n3", targetHandle: "left" },
		],
	};
	let k = 0;
	const nr = patchMod.resolveAstPatch(NEW_PATCH, [], () => `node_new${++k}`);
	check("new node types survive the patch", nr.nodes.map((x) => x.nodeType),
		["INPUT_DUCKDB", "UNIQUE", "RUNNING_TOTAL", "CROSS_TAB"]);
	check("new node types route to the alteryx renderer",
		nr.nodes.map((x) => x.flowNodeType), ["alteryxNode", "alteryxNode", "alteryxNode", "alteryxNode"]);
	check("hallucinated config key is dropped on the way in",
		Object.keys(nr.nodes[1].config), ["columns"]);
	check("model-supplied values are kept",
		nr.nodes[1].config.columns, ["id"]);
	check("a default is back-filled when the model omits it (outputColumn)",
		nr.nodes[2].config.outputColumn, "amount_running");
	check("new types keep the model's own values",
		[nr.nodes[2].config.target, nr.nodes[2].config.orderBy, nr.nodes[3].config.aggFunc],
		["amount", "seq", "SUM"]);
	check("all new edges resolve", nr.edges.length, 3);

	// 3b-3. 未知 type 仍然降級成 FILTER 而不是消失（沿用舊行為，但要有測試守著）。
	const unknown = patchMod.resolveAstPatch(
		{ nodes: [{ id: "n0", sourceIndex: 0, type: "NOT_A_REAL_TOOL", label: "?", config: {} }], edges: [] },
		[], () => "node_unknown");
	check("unknown type falls back to FILTER rather than vanishing",
		[unknown.nodes.length, unknown.nodes[0].nodeType], [1, "FILTER"]);

	// 3b-4. catalogue 與編譯器的 type 清單必須一致（這裡是最便宜的一條守門）。
	check("catalogue covers all 22 types", catalogTypes.length, 22);
}

// ===========================================================================
// 4. Hermes backend (Python)
// ===========================================================================
section("4. apps/server/hermes.py — context + patch 驗證");
const py = [
	join(ROOT, "apps", "server", "venv", "Scripts", "python.exe"),
	join(ROOT, "apps", "server", "venv", "bin", "python"),
].find(existsSync);

if (!py) {
	console.log("  \x1b[33mSKIP\x1b[0m  找不到 apps/server/venv，略過 Python 測試");
} else {
	try {
		const out = execFileSync(py, ["scripts/verify_hermes.py"], {
			cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		});
		console.log(out.trimEnd().split("\n").map((l) => "  " + l).join("\n"));
		// 後端套件的斷言要一併計入總數 —— 先前只印不數，於是回報的
		// assertion 數低估了整個 Python suite（約 70 條）。
		const pyPass = (out.match(/^PASS /gm) ?? []).length;
		const pyFail = (out.match(/^FAIL /gm) ?? []).length;
		checks += pyPass + pyFail;
		failures += pyFail;
	} catch (err) {
		failures++;
		console.log("  \x1b[31mFAIL\x1b[0m  hermes 測試執行失敗");
		console.log(String(err.stdout || err.message).split("\n").map((l) => "        " + l).join("\n"));
	}
}

// ===========================================================================
// 5. Exporter — SQL CTE 匯出 / 工作流存檔
// ===========================================================================
const exporter = await loadTs("apps/web/src/engine/exporter.ts");
section("5. exporter.ts — SQL CTE 匯出 + 工作流存檔/讀檔");

const mk = (id, data, type = "alteryxNode") => ({
	id, type, position: { x: 0, y: 0 }, data,
});
const CHAIN_NODES = [
	mk("node_in", { label: "Input", type: "INPUT_DUCKDB", config: {} }),
	mk("node_f", { label: "Filter", type: "FILTER", config: { field: "amount", op: ">", val: "1000" } }),
	mk("node_s", { label: "Sum", type: "SUMMARIZE", config: { groupBy: "country", func: "SUM", target: "amount" } }),
	mk("node_v", { label: "Chart", type: "VIZ_CHART", config: { chartType: "BAR" } }, "vizChartNode"),
];
const CHAIN_EDGES = [
	{ id: "e1", source: "node_in", target: "node_f", targetHandle: "left" },
	{ id: "e2", source: "node_f", target: "node_s", targetHandle: "left" },
	{ id: "e3", source: "node_s", target: "node_v", targetHandle: "left" },
];

const cte = exporter.exportToSqlCte(CHAIN_NODES, CHAIN_EDGES);
check("chain compiles to a single query", typeof cte?.sql, "string");
has("CTE order is topological (in before f)",
	cte.sql.indexOf('"node_in" AS (') < cte.sql.indexOf('"node_f" AS ('), true);
has("CTE order is topological (f before s)",
	cte.sql.indexOf('"node_f" AS (') < cte.sql.indexOf('"node_s" AS ('), true);
has("node body inlined verbatim (no drift from compiler)",
	cte.sql, 'SELECT * FROM "node_in" WHERE "amount" > 1000');
check("CTE body == compileNodeSelect output (single source of truth)",
	cte.sql.includes(sqlMod.compileNodeSelect("node_s", "SUMMARIZE",
		{ groupBy: "country", func: "SUM", target: "amount" }, ["node_f"])), true);
check("VIZ_CHART skipped (creates no table)", cte.skipped, ["node_v"]);
has("final SELECT reads the viz source, not the viz", cte.sql, 'SELECT * FROM "node_s";');
check("raw_data flagged as an external source", cte.externalSources, ["raw_data"]);
check("no CREATE OR REPLACE TEMP TABLE survives into the CTE export",
	cte.sql.includes("CREATE OR REPLACE TEMP TABLE"), false);
has("sink override picks the requested node",
	exporter.exportToSqlCte(CHAIN_NODES, CHAIN_EDGES, { sink: "node_f" }).sql, 'SELECT * FROM "node_f";');
has("title is emitted as a comment",
	exporter.exportToSqlCte(CHAIN_NODES, CHAIN_EDGES, { title: "Sales Q3" }).sql, "-- Sales Q3");

check("cycle -> null (cannot be linearised into SQL)",
	exporter.exportToSqlCte(
		[mk("a", { label: "A", type: "FILTER", config: {} }), mk("b", { label: "B", type: "FILTER", config: {} })],
		[{ id: "e1", source: "a", target: "b" }, { id: "e2", source: "b", target: "a" }]),
	null);
check("empty graph still yields valid SQL",
	exporter.exportToSqlCte([], []).sql.endsWith("SELECT 1 AS empty_workflow;"), true);

// raw SQL 節點（使用者自己寫的，沒有 data.type）
{
	const raw = exporter.exportToSqlCte([mk("node-init", {
		label: "Raw",
		sqlQuery: 'CREATE OR REPLACE TEMP TABLE "node-init" AS SELECT \'Synapse Engine Active\' AS status, 2026 AS year;',
	}, "sqlNode")], []);
	has("raw SQL node: DDL wrapper stripped", raw.sql, "SELECT 'Synapse Engine Active' AS status, 2026 AS year");
	check("raw SQL node: no CREATE left behind", raw.sql.includes("CREATE"), false);
	check("self-contained raw node needs no external source", raw.externalSources, []);
	check("raw SQL body helper strips DDL + semicolon",
		exporter.rawSqlBody('CREATE TEMP TABLE "t" AS SELECT 1;'), "SELECT 1");
	check("raw SQL body helper passes a bare SELECT through",
		exporter.rawSqlBody("SELECT 42 AS x"), "SELECT 42 AS x");
	check("raw SQL body helper never returns empty",
		exporter.rawSqlBody("   "), "SELECT 1");
}

// JOIN：兩個上游都要入 CTE，且要按 left/right handle 排序
{
	const joinRes = exporter.exportToSqlCte([
		mk("L", { label: "L", type: "INPUT_DUCKDB", config: {} }),
		mk("R", { label: "R", type: "INPUT_DUCKDB", config: {} }),
		mk("J", { label: "J", type: "JOIN", config: { joinType: "LEFT", leftKey: "id", rightKey: "id" } }),
	], [
		{ id: "e1", source: "L", target: "J", targetHandle: "left" },
		{ id: "e2", source: "R", target: "J", targetHandle: "right" },
	]);
	has("JOIN CTE references both upstreams in handle order",
		joinRes.sql, 'SELECT a.*, b.* FROM "L" a LEFT JOIN "R" b ON a."id" = b."id"');
	check("shared external source deduped", joinRes.externalSources, ["raw_data"]);
	check("JOIN is the sink", joinRes.sql.trimEnd().endsWith('SELECT * FROM "J";'), true);
}

// --- 工作流存檔 / 讀檔 ---
const NOW = "2026-09-20T00:00:00.000Z";
const json = exporter.exportWorkflowJson(CHAIN_NODES, CHAIN_EDGES, { title: "Sales Q3", now: NOW });
const back = exporter.importWorkflowJson(json);

check("round-trip keeps node count", back.nodes.length, 4);
check("round-trip keeps edge count", back.edges.length, 3);
check("round-trip keeps title", back.title, "Sales Q3");
check("round-trip keeps exportedAt", back.exportedAt, NOW);
check("round-trip keeps node type", back.nodes[1].data.type, "FILTER");
check("round-trip keeps config", back.nodes[1].data.config, { field: "amount", op: ">", val: "1000" });
check("round-trip keeps flow renderer type", back.nodes[3].type, "vizChartNode");
check("round-trip keeps handle", back.edges[0].targetHandle, "left");
check("callbacks are not serialised", json.includes("onExecute"), false);
check("transient state is not serialised", json.includes("executionState"), false);
check("re-export of an imported file is byte-identical",
	exporter.exportWorkflowJson(back.nodes, back.edges, { title: "Sales Q3", now: NOW }), json);
check("round-tripped workflow still compiles to the same SQL",
	exporter.exportToSqlCte(back.nodes, back.edges).sql, cte.sql);

check("rejects malformed JSON", exporter.importWorkflowJson("{nope"), null);
check("rejects a foreign format", exporter.importWorkflowJson('{"format":"alteryx","nodes":[],"edges":[]}'), null);
check("rejects missing edges array", exporter.importWorkflowJson('{"format":"synapse-workflow","nodes":[]}'), null);
check("rejects a JSON array", exporter.importWorkflowJson("[1,2,3]"), null);

{
	const dirty = exporter.importWorkflowJson(JSON.stringify({
		format: "synapse-workflow", version: 1, title: "d", exportedAt: "",
		nodes: [mk("a", { label: "A" })],
		edges: [{ id: "e1", source: "a", target: "ghost" }, { id: "e2", source: "a", target: "a" }],
	}));
	check("dangling edge dropped on import", dirty.edges.length, 1);
	check("edge that does resolve is kept", dirty.edges[0].target, "a");
	check("missing position defaults to origin",
		exporter.importWorkflowJson(JSON.stringify({
			format: "synapse-workflow", nodes: [{ id: "a", data: { label: "A" } }], edges: [],
		})).nodes[0].position, { x: 0, y: 0 });
}
{
	const dup = exporter.importWorkflowJson(JSON.stringify({
		format: "synapse-workflow",
		nodes: [
			mk("a", { label: "first" }),
			mk("a", { label: "second" }),
		],
		edges: [],
	}));
	check("duplicate node id deduped", dup.nodes.length, 1);
	check("first definition wins", dup.nodes[0].data.label, "first");
}

// ===========================================================================
// 6. Exported SQL 真的跑得動嗎？（真 DuckDB，不只是字串比對）
// ===========================================================================
section("6. exporter SQL → 真實 DuckDB 執行");

/** 尋找一個裝了 duckdb 的 python；找不到就跳過（不應因為環境而紅燈） */
function findDuckdbPython() {
	const candidates = [
		process.env.SYNAPSE_DUCKDB_PYTHON,
		join(ROOT, "apps", "server", "venv", "Scripts", "python.exe"),
		join(ROOT, "apps", "server", "venv", "bin", "python"),
		"python",
		"python3",
	].filter(Boolean);

	for (const bin of candidates) {
		try {
			execFileSync(bin, ["-c", "import duckdb"], {
				encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			});
			return bin;
		} catch {
			// 下一個
		}
	}
	return null;
}

/** 任何一個能跑的 python（不需要任何額外套件） */
function findPython() {
	const candidates = [
		process.env.SYNAPSE_PYTHON,
		join(ROOT, "apps", "server", "venv", "Scripts", "python.exe"),
		join(ROOT, "apps", "server", "venv", "bin", "python"),
		"python",
		"python3",
	].filter(Boolean);

	for (const bin of candidates) {
		try {
			execFileSync(bin, ["-c", "import sys"], {
				encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			});
			return bin;
		} catch {
			// 下一個
		}
	}
	return null;
}

/**
 * 尋找一個裝了 polars 的 python；找不到就跳過（只驗語法，不驗算術結果）。
 *
 * POLARS_SKIP_CPU_CHECK=1 是必要的：polars-runtime 啟動時會檢查 CPU feature
 * flags，在某些 Windows/CPU 組合上會拋 `RuntimeError: unknown feature flag: 'sse3'`
 * 而完全無法 import。那是 polars 自己的偵測問題（不是我們的程式碼），
 * 而且只影響這個驗證工具，所以這裡直接繞過。
 */
function findPolarsPython() {
	const candidates = [
		process.env.SYNAPSE_POLARS_PYTHON,
		join(ROOT, "apps", "server", "venv", "Scripts", "python.exe"),
		join(ROOT, "apps", "server", "venv", "bin", "python"),
		"python",
		"python3",
	].filter(Boolean);

	for (const bin of candidates) {
		try {
			execFileSync(bin, ["-c", "import polars"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, POLARS_SKIP_CPU_CHECK: "1" },
			});
			return bin;
		} catch {
			// 下一個
		}
	}
	return null;
}

const duckPy = findDuckdbPython();

if (!duckPy) {
	console.log(
		"  \x1b[33mSKIP\x1b[0m  找不到裝了 duckdb 的 python（可設 SYNAPSE_DUCKDB_PYTHON 指定）",
	);
} else {
	// 真實工作流：raw_data → FILTER → FORMULA → SUMMARIZE → VIZ_CHART
	const RUNTIME_NODES = [
		mk("node_in", { label: "Input", type: "INPUT_DUCKDB", config: {} }),
		mk("node_f", { label: "Filter", type: "FILTER", config: { field: "amount", op: ">", val: "1000" } }),
		mk("node_x", { label: "Tax", type: "FORMULA", config: { outputColumn: "amount_taxed", expression: "amount * 1.1" } }),
		mk("node_s", { label: "By Country", type: "SUMMARIZE", config: { groupBy: "country", func: "SUM", target: "amount_taxed" } }),
		mk("node_v", { label: "Chart", type: "VIZ_CHART", config: { chartType: "BAR" } }, "vizChartNode"),
	];
	const RUNTIME_EDGES = [
		{ id: "e1", source: "node_in", target: "node_f", targetHandle: "left" },
		{ id: "e2", source: "node_f", target: "node_x", targetHandle: "left" },
		{ id: "e3", source: "node_x", target: "node_s", targetHandle: "left" },
		{ id: "e4", source: "node_s", target: "node_v", targetHandle: "left" },
	];

	const exported = exporter.exportToSqlCte(RUNTIME_NODES, RUNTIME_EDGES, { title: "Runtime check" });
	check("5-node workflow exports", typeof exported?.sql, "string");
	check("uploaded-file-free workflow needs only raw_data", exported.externalSources, ["raw_data"]);

	// 使用者執行匯出 SQL 之前，要自己提供 raw_data（檔頭註解有寫）
	const SETUP = `CREATE OR REPLACE TABLE raw_data AS SELECT * FROM (VALUES
	('US', 500), ('US', 1500), ('TW', 2000), ('TW', 200), ('JP', 3000)
) AS t(country, amount);\n`;

	let result = null;
	try {
		const out = execFileSync(duckPy, ["scripts/run_duckdb_sql.py"], {
			cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
			input: SETUP + exported.sql,
		});
		result = JSON.parse(out);
	} catch (err) {
		result = { ok: false, error: String(err.stdout || err.message) };
	}

	check("exported SQL executes in real DuckDB", result.ok, true);
	if (result.ok) {
		check("column names survive the CTE chain", result.columns, ["country", "amount_taxed_sum"]);
		// 沒有 ORDER BY，因此排序後再比對
		const rows = [...result.rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
		check("FILTER + FORMULA + SUMMARIZE produce correct numbers", rows,
			[["JP", 3300], ["TW", 2200], ["US", 1650]]);
	} else {
		console.log(`        ${result.error}`);
	}

	// 同一條 CTE 也應該可以直接餵入 CREATE TABLE（即是可以當一個 view 使用）
	let materialised = null;
	try {
		const out = execFileSync(duckPy, ["scripts/run_duckdb_sql.py"], {
			cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
			input: SETUP + `CREATE OR REPLACE TABLE out AS ${exported.sql.replace(/;\s*$/, "")};\nSELECT count(*) AS n FROM out;`,
		});
		materialised = JSON.parse(out);
	} catch (err) {
		materialised = { ok: false, error: String(err.stdout || err.message) };
	}
	check("exported SQL is composable (usable as a subquery)", materialised.ok, true);
	if (materialised.ok) {
		check("composed result has the expected row count", materialised.rows, [[3]]);
	} else {
		console.log(`        ${materialised.error}`);
	}

	// 循環圖一定要拒絕，不可產生跑不動的 SQL
	check("cyclic graph is refused before reaching DuckDB",
		exporter.exportToSqlCte(
			[mk("a", { label: "A", type: "FILTER", config: {} }), mk("b", { label: "B", type: "FILTER", config: {} })],
			[{ id: "e1", source: "a", target: "b" }, { id: "e2", source: "b", target: "a" }]),
		null);
}

// ===========================================================================
// 7. 真實 duckdb-wasm 引擎（專案自帶依賴，不需要外部環境）
// ===========================================================================
section("7. 真實 duckdb-wasm 引擎 — SQL 語意");
{
	// LLM 離線時的決定性 fallback patch，交給 wasm harness 端到端執行。
	// 需要 venv 的 python；沒有就跳過這一節（其餘 wasm 斷言照跑）。
	let fallbackPipelines = [];
	if (py) {
		try {
			const raw = execFileSync(py, [join(ROOT, "scripts", "fallback_pipelines.py")], {
				cwd: ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, POLARS_SKIP_CPU_CHECK: "1" },
				maxBuffer: 8 * 1024 * 1024,
			});
			fallbackPipelines = JSON.parse(raw).pipelines ?? [];
		} catch (err) {
			console.log(
				`  \x1b[33mSKIP\x1b[0m  fallback_pipelines.py 執行失敗：${String(err.message).slice(0, 120)}`,
			);
		}
	} else {
		console.log("  \x1b[33mSKIP\x1b[0m  沒有 python，跳過 fallback 端到端執行");
	}

	const wasmChecks = await runDuckDbWasmChecks(ROOT, loadTs, fallbackPipelines);
	if (!wasmChecks) {
		console.log(
			"  \x1b[33mSKIP\x1b[0m  找不到 duckdb-wasm 的 node build（node_modules/.pnpm）",
		);
	} else {
		for (const c of wasmChecks) check(c.name, c.actual, c.expected);
	}
}

// ===========================================================================
// 8. exportPolars.ts — Python / Polars 腳本匯出
// ===========================================================================
const polars = await loadTs("apps/web/src/engine/exportPolars.ts");
section("8. exportPolars.ts — Python / Polars 腳本匯出");
{
	// --- 運算式翻譯 ---
	const T = (src) => polars.translateExprToPolars(src);
	check("arithmetic expression is translated", T("amount * 1.1"), 'pl.col("amount") * 1.1');
	check("parenthesised expression is translated", T("(amount + tax) / 2"), '(pl.col("amount") + pl.col("tax")) / 2');
	check("string literal becomes a Python string", T("'x'"), '"x"');
	check("SQL NULL becomes None", T("NULL"), "None");
	check("booleans become Python booleans", [T("TRUE"), T("FALSE")], ["True", "False"]);
	check("whitelisted function maps to a Polars method", T("ABS(amount)"), '(pl.col("amount")).abs()');
	check("ROUND with two args keeps the precision", T("ROUND(amount, 2)"), '(pl.col("amount")).round(2)');
	check("nested functions nest", T("UPPER(TRIM(name))"),
		'((pl.col("name")).str.strip_chars()).str.to_uppercase()');
	check("whitespace in the source expression is preserved", T("a  +  b"),
		'pl.col("a")  +  pl.col("b")');
	check("COALESCE chains fill_null", T("COALESCE(a, b, c)"),
		'pl.col("a").fill_null(pl.col("b")).fill_null(pl.col("c"))');
	// 拒絕清單：這些硬翻一定錯（運算子優先級 / 沒有對應 API）
	check("AND is refused (Polars needs explicit parentheses)", T("a > 1 AND b < 2"), null);
	check("CASE is refused", T("CASE WHEN a > 1 THEN 1 ELSE 0 END"), null);
	check("CAST is refused", T("CAST(amount AS DOUBLE)"), null);
	check("unknown function is refused", T("SOME_UNKNOWN_FN(amount)"), null);
	check("unterminated string is refused", T("'abc"), null);
	check("unknown character is refused", T("amount || 'x'"), null);
	check("empty expression is refused", T(""), null);

	// --- 型別 / 字面值 ---
	check("pyStr escapes a double quote", polars.pyStr('a"b'), '"a\\"b"');
	check("pyStr escapes a backslash", polars.pyStr("a\\b"), '"a\\\\b"');
	check("pyLiteral keeps numbers bare", polars.pyLiteral("1000"), "1000");
	check("pyLiteral quotes a non-numeric string", polars.pyLiteral("HK"), '"HK"');
	check("pyLiteral maps null", polars.pyLiteral("null"), "None");

	// --- 整條鏈 ---
	const POL_NODES = [
		mk("node_in", { label: "Input", type: "INPUT_DUCKDB", config: { fileName: "sales.csv" } }),
		mk("node_f", { label: "Filter", type: "FILTER", config: { field: "amount", op: ">", val: "1000" } }),
		mk("node_s", { label: "Sum", type: "SUMMARIZE", config: { groupBy: "country", func: "SUM", target: "amount" } }),
		mk("node_v", { label: "Chart", type: "VIZ_CHART", config: { chartType: "BAR" } }, "vizChartNode"),
	];
	const chain = polars.exportToPolars(POL_NODES, CHAIN_EDGES);
	check("chain exports a script", typeof chain?.script, "string");
	has("script imports polars", chain.script, "import polars as pl");
	has("input node reads the file", chain.script, 'pl.read_csv("sales.csv")');
	has("filter becomes .filter()", chain.script, '.filter(pl.col("amount") > 1000)');
	has("summarize becomes group_by/agg", chain.script, '.group_by(["country"]).agg([');
	has("summarize aliases match the SQL export", chain.script, '.alias("amount_sum")');
	check("chart node is skipped", chain.skipped, ["node_v"]);
	check("the sink is the chart's source", chain.script.includes("print(node_s)"), true);
	check("nothing needs review on this chain", chain.needsReview, []);

	// --- 順序：與 SQL 匯出必須一致 ---
	has("node order is topological (in before f)",
		chain.script.indexOf("node_in = ") < chain.script.indexOf("node_f = "), true);
	has("node order is topological (f before s)",
		chain.script.indexOf("node_f = ") < chain.script.indexOf("node_s = "), true);

	// --- SUMMARIZE 多鍵 / 多聚合 ---
	const multi = polars.exportToPolars(
		[mk("node_s2", {
			label: "Sum2", type: "SUMMARIZE",
			config: { groupBy: ["year", "region"], aggregations: [
				{ func: "SUM", target: "amount" },
				{ func: "COUNT", target: "*" },
				{ func: "COUNT_DISTINCT", target: "region" },
			] },
		})],
		[],
	);
	has("multi-key group_by is emitted", multi.script, '.group_by(["year", "region"])');
	has("SUM maps to .sum()", multi.script, '.sum().alias("amount_sum")');
	has("COUNT(*) maps to pl.len()", multi.script, '.alias("count")');
	has("COUNT_DISTINCT maps to n_unique", multi.script, '.n_unique().alias("region_count_distinct")');
	has("multi aggregation uses pl.len()", multi.script, "pl.len()");

	// 沒有分組鍵 → 用 select 做整表聚合（Polars 沒有無 group 的 group_by）
	const noGroup = polars.exportToPolars(
		[mk("node_s3", { label: "All", type: "SUMMARIZE",
			config: { groupBy: [], aggregations: [{ func: "SUM", target: "amount" }] } })],
		[],
	);
	has("empty groupBy switches to select()", noGroup.script, ".select([");
	check("empty groupBy does not emit group_by", noGroup.script.includes("group_by"), false);

	// --- UNION / SAMPLE / RENAME ---
	const u = polars.exportToPolars(
		[mk("u_a", { label: "A", type: "FILTER", config: {} }),
		 mk("u_b", { label: "B", type: "FILTER", config: {} }),
		 mk("node_u", { label: "U", type: "UNION", config: { unionMode: "BY_NAME" } })],
		[{ id: "e1", source: "u_a", target: "node_u" }, { id: "e2", source: "u_b", target: "node_u" }],
	);
	has("UNION BY NAME uses diagonal concat", u.script, 'pl.concat([u_a, u_b], how="diagonal")');

	const uPos = polars.exportToPolars(
		[mk("u_a", { label: "A", type: "FILTER", config: {} }),
		 mk("u_b", { label: "B", type: "FILTER", config: {} }),
		 mk("node_u", { label: "U", type: "UNION", config: { unionMode: "POSITION" } })],
		[{ id: "e1", source: "u_a", target: "node_u" }, { id: "e2", source: "u_b", target: "node_u" }],
	);
	has("UNION POSITION uses vertical concat", uPos.script, 'how="vertical"');

	const sFirst = polars.exportToPolars(
		[mk("node_s", { label: "S", type: "SAMPLE", config: { sampleMode: "FIRST", sampleSize: 25 } })], []);
	has("SAMPLE FIRST maps to head()", sFirst.script, ".head(25)");
	const sRand = polars.exportToPolars(
		[mk("node_s", { label: "S", type: "SAMPLE", config: { sampleMode: "RANDOM", sampleSize: 25 } })], []);
	has("SAMPLE RANDOM maps to sample(seed=42) — same reproducibility as the SQL side",
		sRand.script, ".sample(25, seed=42)");

	const rn = polars.exportToPolars(
		[mk("node_r", { label: "R", type: "RENAME", config: { renames: [{ from: "amount", to: "revenue" }] } })], []);
	has("RENAME maps to rename()", rn.script, '.rename({"amount": "revenue"})');

	// --- JOIN 的欄位衝突後綴必須對齊 DuckDB ---
	const j = polars.exportToPolars(
		[mk("j_l", { label: "L", type: "FILTER", config: {} }),
		 mk("j_r", { label: "R", type: "FILTER", config: {} }),
		 mk("node_j", { label: "J", type: "JOIN", config: { joinType: "LEFT", leftKey: "id", rightKey: "uid" } })],
		[{ id: "e1", source: "j_l", target: "node_j", targetHandle: "left" },
		 { id: "e2", source: "j_r", target: "node_j", targetHandle: "right" }],
	);
	has("JOIN keeps the left/right key mapping",
		j.script, 'left_on="id", right_on="uid"');
	has("JOIN maps LEFT to how=left", j.script, 'how="left"');
	has("JOIN forces the DuckDB-compatible suffix",
		j.script, 'suffix="_1"');

	// --- 誠實原則：無法翻譯就要標記，不可以假裝成功 ---
	const badFormula = polars.exportToPolars(
		[mk("node_x", { label: "F", type: "FORMULA",
			config: { outputColumn: "flag", expression: "CASE WHEN amount > 1 THEN 1 ELSE 0 END" } })], []);
	check("untranslatable FORMULA is reported", badFormula.needsReview, ["node_x"]);
	has("untranslatable FORMULA leaves a TODO", badFormula.script, "# TODO:");
	has("untranslatable FORMULA is listed in the footer", badFormula.script, "needs review");

	// 沒有檔案的 INPUT_DUCKDB 也必須標記，不可產生空腳本
	const noFile = polars.exportToPolars(
		[mk("node_in", { label: "In", type: "INPUT_DUCKDB", config: {} })], []);
	check("INPUT_DUCKDB without a file is reported", noFile.needsReview, ["node_in"]);

	// 外部來源要有可執行的佔位，而不是直接 NameError
	const orphan = polars.exportToPolars(
		[mk("node_f", { label: "F", type: "FILTER", config: {} })], []);
	check("orphan node declares raw_data as external", orphan.externalSources, ["raw_data"]);
	has("external source gets a runnable placeholder", orphan.script, 'raw_data = pl.read_csv("raw_data.csv")');

	// --- 擴充節點（資料清理 / 樞紐 / 視窗 / 進階連接）---
	// 逐個節點產生一份最小腳本，斷言它真的用到對應的 Polars API。
	// 這裡守的是「SQL 有做、Polars 忘了做」這種單邊實作 ——
	// 那種 bug 在畫布上看不出來，只有匯出之後才會發現兩邊算的不一樣。
	const one = (type, config) => polars.exportToPolars(
		[mk("node_x", { label: type, type, config })], [],
	).script;
	const oneRes = (type, config) => polars.exportToPolars(
		[mk("node_x", { label: type, type, config })], [],
	);

	has("UNIQUE maps to .unique(subset=, keep='first')",
		one("UNIQUE", { columns: ["country"] }), '.unique(subset=["country"], keep="first")');
	has("UNIQUE without keys maps to plain .unique()",
		one("UNIQUE", { columns: [] }), ".unique()");
	has("IMPUTE constant maps to fill_null",
		one("IMPUTE", { columns: ["amount"], method: "CONSTANT", fillValue: "0" }),
		'pl.col("amount").fill_null(0)');
	has("IMPUTE mean maps to fill_null(mean())",
		one("IMPUTE", { columns: ["amount"], method: "MEAN" }),
		'pl.col("amount").fill_null(pl.col("amount").mean())');
	has("DATA_CLEANSING trims",
		one("DATA_CLEANSING", { columns: ["name"], trim: true, collapse: false }),
		'pl.col("name").str.strip_chars()');
	has("DATA_CLEANSING collapse squeezes inner whitespace",
		one("DATA_CLEANSING", { columns: ["name"], collapse: true }),
		'.str.replace_all(r"\\s+", " ").str.strip_chars()');
	has("DATA_CLEANSING turns the empty string into null",
		one("DATA_CLEANSING", { columns: ["name"], emptyToNull: true }),
		'.replace("", None)');
	has("CROSS_TAB maps to pivot with the right aggregate",
		one("CROSS_TAB", { pivotColumn: "category", valueColumn: "amount", aggFunc: "AVG", groupBy: ["country"] }),
		'.pivot(on="category", index=["country"], values="amount", aggregate_function="mean")');
	has("TRANSPOSE maps to unpivot",
		one("TRANSPOSE", { columns: ["amount"], nameColumn: "metric", valueColumn: "value" }),
		'.unpivot(on=["amount"], variable_name="metric", value_name="value")');
	// ⚠ 這條是實測踩出來的：Polars 的 list.get 越界會直接拋錯，
	//   DuckDB 的 string_split(...)[n] 則回 NULL。必須帶 null_on_oob=True。
	has("TEXT_TO_COLUMNS uses null_on_oob so it matches DuckDB",
		one("TEXT_TO_COLUMNS", { field: "raw", separator: ",", outputColumns: ["p1", "p2"] }),
		'pl.col("raw").str.split(",").list.get(0, null_on_oob=True).alias("p1")');
	has("MULTI_ROW_FORMULA maps LAG to shift",
		one("MULTI_ROW_FORMULA", { outputColumn: "prev", expression: "LAG(amount, 1)", orderBy: "seq" }),
		'pl.col("amount")).shift(1)).over(order_by="seq")');
	has("MULTI_ROW_FORMULA keeps a compound expression",
		one("MULTI_ROW_FORMULA", { outputColumn: "d", expression: "LAG(amount, 1) - amount", orderBy: "seq" }),
		'.shift(1) - pl.col("amount")');
	// ⚠ 另一條實測差異：cum_sum 會把 NULL 往後傳，DuckDB 的 SUM(...) OVER
	//   (ROWS ...) 忽略 NULL → 必須先 fill_null(0) 兩邊才一致。
	has("RUNNING_TOTAL fills nulls before cum_sum to match DuckDB",
		one("RUNNING_TOTAL", { target: "amount", outputColumn: "rt", orderBy: "seq" }),
		'pl.col("amount").fill_null(0).cum_sum().over(order_by="seq")');
	has("RANK maps RANK to method='min'",
		one("RANK", { target: "amount", outputColumn: "r", method: "RANK", descending: true }),
		'.rank(method="min", descending=True)');
	has("RANK maps DENSE_RANK to method='dense'",
		one("RANK", { target: "amount", outputColumn: "r", method: "DENSE_RANK" }),
		'.rank(method="dense"');
	has("RANK maps ROW_NUMBER to method='ordinal'",
		one("RANK", { target: "amount", outputColumn: "r", method: "ROW_NUMBER" }),
		'.rank(method="ordinal"');
	has("APPEND_FIELDS maps to a cross join",
		polars.exportToPolars(
			[mk("node_a", { label: "A", type: "FILTER", config: {} }),
			 mk("node_b", { label: "B", type: "FILTER", config: {} }),
			 mk("node_ap", { label: "Append", type: "APPEND_FIELDS", config: {} })],
			[{ id: "e1", source: "node_a", target: "node_ap", targetHandle: "left" },
			 { id: "e2", source: "node_b", target: "node_ap", targetHandle: "right" }],
		).script, 'how="cross"');
	has("FIND_REPLACE coalesces and drops the lookup column",
		polars.exportToPolars(
			[mk("node_a", { label: "A", type: "FILTER", config: {} }),
			 mk("node_b", { label: "B", type: "FILTER", config: {} }),
			 mk("node_fr", { label: "FR", type: "FIND_REPLACE", config: { findField: "code", lookupField: "code", replaceField: "label" } })],
			[{ id: "e1", source: "node_a", target: "node_fr", targetHandle: "left" },
			 { id: "e2", source: "node_b", target: "node_fr", targetHandle: "right" }],
		).script, '.drop("label")');
	has("SORT carries the descending flag",
		one("SORT", { field: "amount", descending: true }), 'sort("amount", descending=True)');

	// 無法翻譯的 MULTI_ROW_FORMULA 必須被標記，而不是產生看起來能跑的錯碼
	const badWindow = oneRes("MULTI_ROW_FORMULA", {
		outputColumn: "d", expression: "CASE WHEN amount > 1 THEN 1 ELSE 0 END",
	});
	check("an untranslatable MULTI_ROW_FORMULA is reported", badWindow.needsReview, ["node_x"]);
	has("an untranslatable MULTI_ROW_FORMULA leaves a TODO", badWindow.script, "# TODO:");

	// --- cycle 一定要拒絕 ---
	check("cyclic graph is refused",
		polars.exportToPolars(
			[mk("a", { label: "A", type: "FILTER", config: {} }), mk("b", { label: "B", type: "FILTER", config: {} })],
			[{ id: "e1", source: "a", target: "b" }, { id: "e2", source: "b", target: "a" }]),
		null);

	// --- 產生的腳本必須是合法的 Python（用 CPython 真的編譯一次）---
	// 字串比對只能證明「看起來像 Python」。這裡真的交給 CPython 檢查語法。
	// 找不到 python 就 SKIP，不應該因為環境而紅燈（與 section 6 的原則一致）。
	const pyBin = findPython();
	if (!pyBin) {
		console.log(
			"  \x1b[33mSKIP\x1b[0m  找不到 python（可設 SYNAPSE_PYTHON 指定）—— 無法檢查產生的腳本語法",
		);
	} else {
		let compileOk = null;
		try {
			const dir = mkdtempSync(join(tmpdir(), "synapse-polars-"));
			const file = join(dir, "workflow.py");
			writeFileSync(file, chain.script, "utf8");
			execFileSync(pyBin, ["-m", "py_compile", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			compileOk = true;
		} catch (err) {
			compileOk = String(err.stdout || err.message).slice(0, 200);
		}
		check("the generated chain script is valid Python syntax", compileOk, true);

		// 更強的一步：如果環境裡有 polars，就真的把腳本跑起來，
		// 並斷言算出來的數字與 DuckDB 那邊一致。
		const polarsPy = findPolarsPython();
		if (!polarsPy) {
			console.log(
				"  \x1b[33mSKIP\x1b[0m  找不到裝了 polars 的 python（可設 SYNAPSE_POLARS_PYTHON 指定）—— 只驗到語法，未驗算術結果",
			);
		} else {
			const dir = mkdtempSync(join(tmpdir(), "synapse-polars-run-"));
			// 一份小的 CSV：country + amount（與 section 6 的 raw_data 等價）
			//
			// ⚠ 這裡刻意用「空欄位」而不是字面量 NULL 來表示缺值。兩個引擎對
			//   字面量 NULL 的行為其實一致 —— 都當成字串 'NULL'（不是 null），
			//   於是 amount 整欄退化成 VARCHAR，`amount > 1000` 直接型別錯誤。
			//   換句話說這不是 Polars 與 DuckDB 的差異，是 fixture 寫錯了。
			//   空欄位在兩邊都是真正的 null，才是可以互相比較的基準。
			writeFileSync(
				join(dir, "sales.csv"),
				"country,amount\nHK,500\nHK,1500\nTW,2000\nTW,\nHK,2500\n",
				"utf8",
			);
			// 與 SQL 那條鏈完全相同的節點，只是把 Input 換成 CSV。
			// 注意：section 6 的 RUNTIME_EDGES 在該 block 內宣告，這裡看不到，
			// 所以這條鏈自己帶一份邊線（同樣是 in → f → x → s）。
			const polarsChain = polars.exportToPolars([
				mk("node_in", { label: "Input", type: "INPUT_DUCKDB", config: { fileName: "sales.csv" } }),
				mk("node_f", { label: "Filter", type: "FILTER", config: { field: "amount", op: ">", val: "1000" } }),
				mk("node_x", { label: "Tax", type: "FORMULA", config: { outputColumn: "amount_taxed", expression: "amount * 1.1" } }),
				mk("node_s", { label: "By Country", type: "SUMMARIZE", config: { groupBy: "country", func: "SUM", target: "amount_taxed" } }),
			], [
				{ id: "pe1", source: "node_in", target: "node_f", targetHandle: "left" },
				{ id: "pe2", source: "node_f", target: "node_x", targetHandle: "left" },
				{ id: "pe3", source: "node_x", target: "node_s", targetHandle: "left" },
			]);
			check("the runnable chain needs no manual review", polarsChain.needsReview, []);

			const scriptPath = join(dir, "workflow.py");
			// 把路徑改成相對檔名（腳本會以 cwd = dir 執行）
			writeFileSync(scriptPath, polarsChain.script, "utf8");
			let runOut = null;
			try {
				runOut = execFileSync(polarsPy, [scriptPath], {
					cwd: dir,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					// 與 findPolarsPython 的探測保持一致（見該函式註解）
					env: { ...process.env, POLARS_SKIP_CPU_CHECK: "1" },
				});
			} catch (err) {
				runOut = String(err.stdout || "") + String(err.stderr || err.message);
			}
			check("the generated Polars script actually runs", runOut.includes("country"), true);
			// DuckDB 的結果：HK = (1500 + 2500) * 1.1 = 4400，TW = 2000 * 1.1 = 2200
			check("Polars agrees with DuckDB on the HK total", runOut.includes("4400.0"), true);
			check("Polars agrees with DuckDB on the TW total", runOut.includes("2200.0"), true);
			// NULL amount 必須被 FILTER 排除，不可讓 TW 變成 null 或 2200 以外
			check("the NULL row is excluded by the filter, not counted as 0",
				runOut.includes("TW") && !runOut.includes("nan"), true);
		}
	}
}

// ===========================================================================
// 9. persistence.ts — 自動存檔
// ===========================================================================
const persist = await loadTs("apps/web/src/engine/persistence.ts");
section("9. persistence.ts — 自動存檔（可注入 storage，因此能在 Node 測）");
{
	/** 最小可用的 localStorage 替身 */
	const makeStorage = (opts = {}) => {
		const map = new Map();
		return {
			map,
			getItem: (k) => (map.has(k) ? map.get(k) : null),
			setItem: (k, v) => {
				if (opts.failOnWrite) throw new Error("QuotaExceededError");
				map.set(k, v);
			},
			removeItem: (k) => {
				if (opts.failOnRemove) throw new Error("nope");
				map.delete(k);
			},
		};
	};

	const s = makeStorage();
	check("a fresh storage has no autosave", persist.loadAutosave(s), null);
	check("save reports success", persist.saveAutosave('{"a":1}', s), { ok: true });
	check("the saved payload round-trips", persist.loadAutosave(s), '{"a":1}');
	check("the key is versioned", persist.AUTOSAVE_KEY, "synapse.workflow.autosave.v1");
	check("the key is what was actually written", s.map.has(persist.AUTOSAVE_KEY), true);

	persist.clearAutosave(s);
	check("clear removes the autosave", persist.loadAutosave(s), null);
	check("clear on an already-empty storage is safe", persist.clearAutosave(s), undefined);

	// 配額爆滿：必須回報失敗，而不是讓整個 app 拋錯
	const full = makeStorage({ failOnWrite: true });
	const res = persist.saveAutosave("x", full);
	check("a quota error is reported, not thrown", res.ok, false);
	check("the quota error carries a reason", typeof res.error, "string");

	// storage 被停用（無痕模式）：回傳 null / 回報失敗，不可拋錯
	const disabled = {
		getItem: () => { throw new Error("storage disabled"); },
		setItem: () => { throw new Error("storage disabled"); },
		removeItem: () => { throw new Error("storage disabled"); },
	};
	check("a disabled storage yields no autosave", persist.loadAutosave(disabled), null);
	check("a disabled storage reports a failed save", persist.saveAutosave("x", disabled).ok, false);
	check("a disabled storage does not throw on clear", persist.clearAutosave(disabled), undefined);

	// 沒有 storage（SSR / 舊瀏覽器）也不可拋錯
	check("no storage -> no autosave", persist.loadAutosave(null), null);
	check("no storage -> save fails cleanly", persist.saveAutosave("x", null), { ok: false, error: "storage 不可用" });

	// 與工作流 JSON 格式一致：存進去的東西必須能被 importWorkflowJson 讀回來
	const AUTO_NODES = [
		mk("node_a", { label: "A", type: "FILTER", config: { field: "amount", op: ">", val: "1" } }),
		mk("node_b", { label: "B", type: "SUMMARIZE", config: { groupBy: ["year"], aggregations: [{ func: "SUM", target: "amount" }] } }),
	];
	const AUTO_EDGES = [{ id: "e1", source: "node_a", target: "node_b", targetHandle: "left" }];
	const store = makeStorage();
	persist.saveAutosave(exporter.exportWorkflowJson(AUTO_NODES, AUTO_EDGES, { title: "Autosave" }), store);
	const restored = exporter.importWorkflowJson(persist.loadAutosave(store));
	check("the autosave is a valid workflow file", restored?.format, "synapse-workflow");
	check("the autosave keeps the title", restored?.title, "Autosave");
	check("the autosave keeps the node count", restored?.nodes.length, 2);
	// 關鍵：多聚合的 config 必須原樣回來（不是被壓成舊格式）
	check("the autosave preserves the multi-aggregate config",
		restored?.nodes[1].data.config, {
			groupBy: ["year"],
			aggregations: [{ func: "SUM", target: "amount" }],
		});

	// --- 「開新工作流」依賴的契約 ---
	// 空工作流仍然是一個**合法**的檔案（parse 會成功、nodes 為 0），
	// 所以畫布的還原邏輯必須靠「節點數 > 0」判斷，不能靠 parse 成功與否 ——
	// 否則清空後的存檔會在下一次載入時被當成有效內容還原。
	const emptyJson = exporter.exportWorkflowJson([], [], { title: "Empty" });
	check("an empty workflow is still a valid file", exporter.importWorkflowJson(emptyJson)?.format, "synapse-workflow");
	check("...and parses to zero nodes", exporter.importWorkflowJson(emptyJson)?.nodes.length, 0);

	// 清掉之後必須是「沒有東西可還原」，而不是「還原出一個空工作流」
	persist.saveAutosave(emptyJson, store);
	persist.clearAutosave(store);
	check("after clearing there is nothing to restore", persist.loadAutosave(store), null);
	check("a missing autosave imports as null, not as an empty workflow",
		exporter.importWorkflowJson(persist.loadAutosave(store)), null);
}

// ===========================================================================
// 10. 節點目錄 → 後端同步（drift guard）
// ===========================================================================
// hermes.py 的「我會哪些工具」以前是手寫在 Python 裡的，與 astCompiler 的
// switch 各寫一份，於是漂移掉了：少了 SELECT / UNION / SAMPLE / RENAME，
// SUMMARIZE 的描述還停在單一聚合的舊格式，SORT 的鍵名也寫錯。
// 結果是 AI 產生不出那些節點，而沒有任何測試會發現。
//
// 現在唯一真相來源是 apps/web/src/engine/nodeCatalog.ts，後端讀的是由它產生的
// node_catalog.json。這一節守住「產物與來源一致」與「後端真的讀到了」。
{
	const catalog = await loadTs("apps/web/src/engine/nodeCatalog.ts");
	const snapshot = catalog.catalogSnapshot();

	// 10a. 磁碟上的 JSON 必須與目錄重新產生一次的結果完全相同。
	// 比對前正規化 CRLF：Windows 上 core.autocrlf 會在 checkout 時改寫行尾，
	// 若直接比 bytes，一次 fresh clone 就會讓這條守門誤報。
	const generated = JSON.stringify(snapshot, null, 2) + "\n";
	const onDisk = existsSync(CATALOG_JSON)
		? readFileSync(CATALOG_JSON, "utf8").replace(/\r\n/g, "\n")
		: null;
	check("apps/server/node_catalog.json exists", onDisk !== null, true);
	check("node_catalog.json is byte-identical to a fresh generation of the catalogue",
		onDisk, generated);

	// 10b. 快照內容本身要合理（防止「產了一個空檔但兩邊都一樣」）
	check("the snapshot lists every catalogued node type",
		snapshot.types.length, catalog.NODE_TYPES.length);
	check("the snapshot carries a non-empty prompt section",
		snapshot.promptSection.length > 500, true);
	check("the snapshot carries canvas hint keys",
		snapshot.hintKeys.length > 0, true);

	// 10c. 後端真的讀到了 —— 直接 import hermes.py，問它「你會哪些工具」
	//      這是唯一能證明「agent 理解這些 tools」的斷言。
	const pyBin = findPython();
	if (!pyBin) {
		console.log(
			"  \x1b[33mSKIP\x1b[0m  找不到 python（可設 SYNAPSE_PYTHON 指定）—— 無法確認 hermes.py 讀到了目錄",
		);
	} else {
		const probe = [
			"import sys, json",
			`sys.path.insert(0, ${JSON.stringify(join(ROOT, "apps", "server"))})`,
			"import hermes",
			"print(json.dumps({",
			"    'types': sorted(hermes.VALID_NODE_TYPES),",
			"    'has_prompt': hermes.MUTATE_SYSTEM_PROMPT.count('- ') >= len(hermes.VALID_NODE_TYPES),",
			"    'hints': hermes._CANVAS_HINT_KEYS,",
			"}))",
		].join("\n");
		let hermesInfo = null;
		try {
			const out = execFileSync(pyBin, ["-c", probe], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			hermesInfo = JSON.parse(out.trim().split("\n").pop());
		} catch (err) {
			hermesInfo = { error: String(err.stderr || err.message).slice(0, 300) };
		}

		check("hermes.py imports without error", hermesInfo?.error, undefined);
		// 最關鍵的一條：後端認得的節點集合 == 目錄的節點集合
		check("hermes.py knows exactly the catalogued node types",
			hermesInfo?.types, [...snapshot.types].sort());
		check("the generated prompt describes every node type",
			hermesInfo?.has_prompt, true);
		check("hermes.py uses the catalogue's canvas hint keys",
			hermesInfo?.hints, snapshot.hintKeys);
	}

	// 10d. 後端的決定性 fallback 也要認得新工具（LLM 掛掉時的唯一退路）
	const hermesSrc = readFileSync(join(ROOT, "apps", "server", "hermes.py"), "utf8");
	const fallbackTypes = [...hermesSrc.matchAll(/"type":\s*"([A-Z_]+)"/g)].map((m) => m[1]);
	const unknownInFallback = fallbackTypes.filter((t) => !snapshot.types.includes(t));
	check("every node type in the keyword fallback exists in the catalogue",
		unknownInFallback, []);
	// fallback 至少要知道這幾個最常用的新工具，否則 AI 一掛就退回舊世界
	for (const t of ["UNIQUE", "DATA_CLEANSING", "RANK", "RUNNING_TOTAL", "CROSS_TAB", "TRANSPOSE"]) {
		check(`the keyword fallback understands ${t}`, fallbackTypes.includes(t), true);
	}
}

// ===========================================================================
console.log(
	`\n\x1b[1m${checks} 個 assertion，${failures === 0 ? "\x1b[32m全部通過\x1b[0m" : `\x1b[31m${failures} 個失敗\x1b[0m`}\x1b[0m`,
);
process.exit(failures === 0 ? 0 : 1);

