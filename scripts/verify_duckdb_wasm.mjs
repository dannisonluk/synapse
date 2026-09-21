// scripts/verify_duckdb_wasm.mjs
//
// 用 app 真正出貨的 duckdb-wasm 引擎（node build）驗證 SQL 語意。
//
// 為什麼要這樣做：字串比對只能證明「SQL 長得像對的」，不能證明它跑得動、
// 更不能證明它產生正確的資料。這個套件把 astCompiler 產生的**真實 SQL**
// 餵進**真實引擎**，然後斷言結果資料。
//
// 而且不需要任何外部依賴 —— duckdb-wasm 本來就是專案 dependency，
// 所以它不像 python duckdb 那套需要 SKIP。
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 在 .pnpm store 裡找出 duckdb-wasm（pnpm 不會 hoist 到 node_modules 根） */
function resolveDuckDbDist(root) {
	const pnpm = join(root, "node_modules", ".pnpm");
	if (!existsSync(pnpm)) return null;
	const dir = readdirSync(pnpm).find((d) => d.startsWith("@duckdb+duckdb-wasm@"));
	if (!dir) return null;
	const dist = join(pnpm, dir, "node_modules", "@duckdb", "duckdb-wasm", "dist");
	return existsSync(join(dist, "duckdb-node-blocking.cjs")) ? dist : null;
}

/**
 * 跑所有 duckdb-wasm 語意檢查。
 * @param loadTs 由 verify.mjs 傳入的 esbuild bundler（避免重複實作）
 * @returns {{ name: string, actual: any, expected: any }[]}
 */
export async function runDuckDbWasmChecks(root, loadTs, fallbackPipelines = []) {
	const results = [];
	const add = (name, actual, expected) => results.push({ name, actual, expected });

	const dist = resolveDuckDbDist(root);
	if (!dist) return null; // 呼叫方負責 SKIP

	const require = createRequire(import.meta.url);
	const duckdb = require(join(dist, "duckdb-node-blocking.cjs"));

	// createDuckDB 要的是**原始 bundles 物件**，不是 selectBundle() 的結果
	const BUNDLES = {
		mvp: {
			mainModule: join(dist, "duckdb-mvp.wasm"),
			mainWorker: join(dist, "duckdb-node-mvp.worker.cjs"),
		},
		eh: {
			mainModule: join(dist, "duckdb-eh.wasm"),
			mainWorker: join(dist, "duckdb-node-eh.worker.cjs"),
		},
	};
	const bindings = await duckdb.createDuckDB(
		BUNDLES,
		new duckdb.VoidLogger(),
		duckdb.NODE_RUNTIME,
	);
	await bindings.instantiate();
	const conn = bindings.connect();

	const q = (sql) => {
		const t = conn.query(sql);
		return t.toArray().map((r) => Object.values(r.toJSON()).map(String));
	};
	const schema = (table) =>
		conn.query(`DESCRIBE ${table};`).toArray().map((r) => String(r.toJSON().column_name));

	// --- 真實編譯器輸出的 SQL ---
	const compiler = await loadTs("apps/web/src/engine/astCompiler.ts");
	const NODE = "node_filter";

	add("engine reports a version", /^v\d+\./.test(q("SELECT version() AS v")[0][0]), true);

	// =====================================================================
	// 1. FILTER true / false 分支：完整且互斥
	// =====================================================================
	conn.query(
		`CREATE OR REPLACE TABLE raw_data AS SELECT * FROM (VALUES
			(1, 500), (2, 1500), (3, NULL), (4, 1000), (5, 2500)
		) AS t(id, amount);`,
	);

	const filterSql = compiler.generateSqlFromConfig(
		NODE,
		"FILTER",
		{ field: "amount", op: ">", val: "1000" },
		["raw_data"],
	);
	// 多語句：true 表 + false 表，一次 query() 送出去
	conn.query(filterSql);

	const trueRows = q(`SELECT id FROM "${NODE}" ORDER BY id;`).map((r) => r[0]);
	const falseRows = q(`SELECT id FROM "${NODE}__false" ORDER BY id;`).map((r) => r[0]);

	add("FILTER true branch", trueRows, ["2", "5"]);
	add("FILTER false branch", falseRows, ["1", "3", "4"]);
	add("branches are disjoint",
		trueRows.filter((x) => falseRows.includes(x)), []);
	add("branches are exhaustive (NULL row is not lost)",
		[...trueRows, ...falseRows].sort(), q("SELECT id FROM raw_data ORDER BY id;").map((r) => r[0]));
	add("the NULL row lands in the false branch", falseRows.includes("3"), true);

	// 對照組：舊版寫法 NOT (cond) 會把 NULL 那行弄丟
	const naive = q(
		`SELECT id FROM raw_data WHERE NOT (amount > 1000) ORDER BY id;`,
	).map((r) => r[0]);
	add("naive NOT (cond) really did lose the NULL row", naive, ["1", "4"]);

	// 邊界值：amount = 1000 不應通過 > 1000
	add("boundary value goes to false, not true", trueRows.includes("4"), false);

	// =====================================================================
	// 2. 下游接在 false 埠 → 真的讀到 false 分支
	// =====================================================================
	const EDGES = [
		{ source: NODE, target: "node_down", sourceHandle: "false", targetHandle: "left" },
	];
	const resolved = compiler.resolveSourceTables("node_down", "SORT", EDGES);
	add("false port resolves to the __false table", resolved, [`${NODE}__false`]);

	const downSql = compiler.generateSqlFromConfig("node_down", "SORT", { field: "id" }, resolved);
	conn.query(downSql);
	add("downstream wired to the false port sees the non-passing rows",
		q(`SELECT id FROM "node_down" ORDER BY id;`).map((r) => r[0]), ["1", "3", "4"]);

	// 對照：接在 true 埠
	const trueEdges = [
		{ source: NODE, target: "node_down2", sourceHandle: "true", targetHandle: "left" },
	];
	const resolvedTrue = compiler.resolveSourceTables("node_down2", "SORT", trueEdges);
	conn.query(compiler.generateSqlFromConfig("node_down2", "SORT", { field: "id" }, resolvedTrue));
	add("downstream wired to the true port sees the passing rows",
		q(`SELECT id FROM "node_down2" ORDER BY id;`).map((r) => r[0]), ["2", "5"]);

	// =====================================================================
	// 3. JOIN 保留左右兩表欄位
	// =====================================================================
	conn.query(
		"CREATE OR REPLACE TABLE L AS SELECT 1 AS id, 'US' AS country, 100 AS amount;",
	);
	// tax 用 DOUBLE：DECIMAL 有另一個已知的序列化問題（見 README 已知問題），
	// 這個斷言只想專注在 JOIN 的欄位保留語意。
	conn.query(
		"CREATE OR REPLACE TABLE R AS SELECT 1 AS id, 'US' AS country, CAST(0.07 AS DOUBLE) AS tax;",
	);
	const joinBody = compiler.compileNodeSelect(
		"node_join",
		"JOIN",
		{ joinType: "INNER", leftKey: "id", rightKey: "id" },
		["L", "R"],
	);
	conn.query(`CREATE OR REPLACE TABLE node_join AS ${joinBody};`);
	const joinCols = schema("node_join");
	add("JOIN keeps the right table's exclusive column", joinCols.includes("tax"), true);
	add("JOIN keeps the left table's exclusive column", joinCols.includes("amount"), true);
	add("colliding right column is suffixed, not dropped",
		joinCols.includes("country_1"), true);
	add("JOIN output column set", joinCols, ["id", "country", "amount", "id_1", "country_1", "tax"]);
	add("JOIN row is complete (both sides present)",
		q('SELECT id, country, amount, tax FROM node_join;'), [["1", "US", "100", "0.07"]]);

	// =====================================================================
	// 4. 多語句單次 query() —— FILTER 雙輸出所依賴的前提
	// =====================================================================
	conn.query("CREATE OR REPLACE TABLE ms1 AS SELECT 1 AS a; CREATE OR REPLACE TABLE ms2 AS SELECT 2 AS b;");
	add("multi-statement query() executes both statements",
		[Number(q("SELECT count(*) AS n FROM ms1;")[0][0]),
		 Number(q("SELECT count(*) AS n FROM ms2;")[0][0])], [1, 1]);

	// =====================================================================
	// 5. 值型別往返：arrowTableToJSON 產出的值必須能安全跨 worker
	// =====================================================================
	// apache-arrow 會拉入 CJS 依賴，必須用 platform: "node"
	const arrow = await loadTs("packages/ikaros-arrow/src/index.ts", {
		platform: "node",
		external: [],
	});

	const toJSON = (sql) => arrow.arrowTableToJSON(conn.query(sql));
	const first = (sql) => {
		const rows = toJSON(sql);
		return rows.length ? Object.values(rows[0])[0] : undefined;
	};

	// --- DECIMAL：本次修正的重點 ---
	add("DECIMAL literal round-trips exactly",
		first("SELECT 1234.56::DECIMAL(10,2) AS v;"), 1234.56);
	add("DECIMAL small value is not shown unscaled",
		first("SELECT 0.07::DECIMAL(10,2) AS v;"), 0.07);
	add("DECIMAL negative value (two's complement)",
		first("SELECT -9.99::DECIMAL(10,2) AS v;"), -9.99);
	add("DECIMAL with zero scale",
		first("SELECT 100::DECIMAL(10,0) AS v;"), 100);
	add("DECIMAL(5,1) — the shape of the seeded raw_data.amount",
		first("SELECT 1000.0 AS v;"), 1000);
	add("SUM over DECIMAL keeps its scale",
		first("SELECT SUM(amount) AS v FROM (VALUES (1000.0),(2000.0)) AS x(amount);"), 3000);
	add("SUM over DECIMAL with fractional part",
		first("SELECT SUM(amount) AS v FROM (VALUES (1.05),(2.10)) AS x(amount);"), 3.15);
	add("HUGEINT survives as an approximate number",
		Number.isFinite(first("SELECT 170141183460469231731687303715884105727::HUGEINT AS v;")), true);
	add("DECIMAL value is a number, not an object",
		typeof first("SELECT 1234.56::DECIMAL(10,2) AS v;"), "number");
	add("NULL DECIMAL stays null",
		first("SELECT NULL::DECIMAL(10,2) AS v;"), null);

	// 每一列都必須能被 structured clone（worker → 主線程的實際路徑）
	add("DECIMAL rows survive structuredClone",
		structuredClone(toJSON("SELECT 1234.56::DECIMAL(10,2) AS v;")), [{ v: 1234.56 }]);

	// 負對照組：舊版 arrowTableToJSON 只處理 bigint
	{
		const table = conn.query("SELECT 1234.56::DECIMAL(10,2) AS v;");
		const raw = table.getChildAt(0).get(0);
		const oldConvert = typeof raw === "bigint" ? Number(raw) : raw; // 舊版邏輯
		const cloned = structuredClone({ v: oldConvert });
		add("OLD converter really did produce a mangled object",
			cloned.v, { 0: 123456, 1: 0, 2: 0, 3: 0 });
	}

	// --- 其他型別：不可讓 structured clone 拋錯 ---
	add("INTEGER", first("SELECT 42 AS v;"), 42);
	add("DOUBLE", first("SELECT 3.14::DOUBLE AS v;"), 3.14);
	add("VARCHAR", first("SELECT 'hi' AS v;"), "hi");
	add("BOOLEAN", first("SELECT true AS v;"), true);
	add("NULL", first("SELECT NULL::INTEGER AS v;"), null);
	add("Int64 above MAX_SAFE_INTEGER becomes a number (documented precision loss)",
		typeof first("SELECT 9007199254740993::BIGINT AS v;"), "number");
	add("TIME (BigInt) becomes a number, not an unserializable BigInt",
		typeof first("SELECT TIME '03:14:15' AS v;"), "number");

	// LIST / STRUCT：舊版會讓 structuredClone 拋錯，整個查詢失敗
	for (const [label, sql] of [
		["LIST", "SELECT [1,2,3] AS v;"],
		["STRUCT", "SELECT {'a': 1} AS v;"],
		["INTERVAL", "SELECT INTERVAL 3 DAY AS v;"],
		["BLOB", "SELECT '\\x01\\x02'::BLOB AS v;"],
		["DATE", "SELECT DATE '2026-09-20' AS v;"],
		["TIMESTAMP", "SELECT TIMESTAMP '2026-09-20 03:14:15' AS v;"],
	]) {
		let cloneOk = true;
		let detail = "";
		try {
			structuredClone(toJSON(sql));
		} catch (e) {
			cloneOk = false;
			detail = String(e.message).slice(0, 60);
		}
		add(`${label} result survives structuredClone`, cloneOk ? true : detail, true);
	}

	// LIST / STRUCT 應該轉成普通 JS 值，而不是拋錯或留著 Arrow 物件
	add("LIST becomes a plain array",
		Array.isArray(first("SELECT [1,2,3] AS v;")), true);
	add("STRUCT becomes a plain object",
		(() => {
			const v = first("SELECT {'a': 1} AS v;");
			return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : v;
		})(), ["a"]);

	// --- schema metadata 不受影響 ---
	add("schema metadata still reports the Arrow type",
		arrow.getArrowSchemaMetadata(conn.query("SELECT 1.5::DECIMAL(10,2) AS v;"))[0].type,
		"Decimal[10e+2]");

	// =====================================================================
	// 6. SUMMARIZE：多分組鍵 + 多聚合
	// =====================================================================
	conn.query(
		`CREATE OR REPLACE TABLE sales AS SELECT * FROM (VALUES
			(2024, 'HK', 100, 2), (2024, 'HK', 300, 4),
			(2024, 'TW', 50,  1), (2025, 'HK', 1000, 10)
		) AS t(year, region, amount, qty);`,
	);

	// 6a. 新格式：兩個分組鍵 + 三組聚合（含 COUNT(*)）
	const multiBody = compiler.compileNodeSelect(
		"node_sum",
		"SUMMARIZE",
		{
			groupBy: ["year", "region"],
			aggregations: [
				{ func: "SUM", target: "amount" },
				{ func: "AVG", target: "qty" },
				{ func: "COUNT", target: "*" },
			],
		},
		["sales"],
	);
	conn.query(`CREATE OR REPLACE TABLE node_sum AS ${multiBody};`);
	add("SUMMARIZE multi-key groups by every key",
		q("SELECT year, region FROM node_sum ORDER BY year, region;"),
		[["2024", "HK"], ["2024", "TW"], ["2025", "HK"]]);
	add("SUMMARIZE multi-aggregate emits one column per aggregation",
		schema("node_sum"), ["year", "region", "amount_sum", "qty_avg", "count"]);
	add("SUMMARIZE aggregates are computed per group",
		q("SELECT year, region, amount_sum, qty_avg, count FROM node_sum ORDER BY year, region;"),
		[["2024", "HK", "400", "3", "2"], ["2024", "TW", "50", "1", "1"], ["2025", "HK", "1000", "10", "1"]]);

	// 6b. 舊格式（單一 groupBy 字串 + func/target）必須維持原行為
	const legacyBody = compiler.compileNodeSelect(
		"node_sum_legacy",
		"SUMMARIZE",
		{ groupBy: "year", func: "SUM", target: "amount" },
		["sales"],
	);
	add("SUMMARIZE legacy single-key SQL is unchanged",
		legacyBody,
		'SELECT "year", SUM("amount") AS "amount_sum" FROM "sales" GROUP BY "year"');
	conn.query(`CREATE OR REPLACE TABLE node_sum_legacy AS ${legacyBody};`);
	add("SUMMARIZE legacy grouping still produces the old result",
		q("SELECT year, amount_sum FROM node_sum_legacy ORDER BY year;"),
		[["2024", "450"], ["2025", "1000"]]);

	// 6c. 逗號分隔字串（Hermes 舊 payload）也當多鍵處理
	add("SUMMARIZE comma-separated groupBy is treated as multi-key",
		compiler.compileNodeSelect("x", "SUMMARIZE",
			{ groupBy: "year, region", aggregations: [{ func: "SUM", target: "amount" }] },
			["sales"]).includes('GROUP BY "year", "region"'), true);

	// 6d. 明確空陣列 → 不分组（整表聚合成一列）
	const noGroupBody = compiler.compileNodeSelect(
		"node_sum_all",
		"SUMMARIZE",
		{ groupBy: [], aggregations: [{ func: "SUM", target: "amount" }] },
		["sales"],
	);
	add("SUMMARIZE empty groupBy emits no GROUP BY clause",
		noGroupBody.includes("GROUP BY"), false);
	conn.query(`CREATE OR REPLACE TABLE node_sum_all AS ${noGroupBody};`);
	add("SUMMARIZE empty groupBy collapses the whole table to one row",
		q("SELECT amount_sum FROM node_sum_all;"), [["1450"]]);

	// 6e. COUNT_DISTINCT 展開成 COUNT(DISTINCT x)，不是不存在的函數名
	const cdBody = compiler.compileNodeSelect(
		"node_sum_cd",
		"SUMMARIZE",
		{ groupBy: ["year"], aggregations: [{ func: "COUNT_DISTINCT", target: "region" }] },
		["sales"],
	);
	add("SUMMARIZE COUNT_DISTINCT expands to COUNT(DISTINCT x)",
		cdBody.includes('COUNT(DISTINCT "region")'), true);
	conn.query(`CREATE OR REPLACE TABLE node_sum_cd AS ${cdBody};`);
	add("SUMMARIZE COUNT_DISTINCT counts distinct values",
		q("SELECT year, region_count_distinct FROM node_sum_cd ORDER BY year;"),
		[["2024", "2"], ["2025", "1"]]);

	// 6f. 同名別名去重：兩組相同聚合不可產生兩個同欄位名
	const dupBody = compiler.compileNodeSelect(
		"node_sum_dup",
		"SUMMARIZE",
		{ groupBy: ["year"], aggregations: [
			{ func: "SUM", target: "amount" },
			{ func: "SUM", target: "amount" },
		] },
		["sales"],
	);
	add("SUMMARIZE duplicate aggregations get a unique alias",
		dupBody.includes('AS "amount_sum"') && dupBody.includes('AS "amount_sum_2"'), true);
	conn.query(`CREATE OR REPLACE TABLE node_sum_dup AS ${dupBody};`);
	add("SUMMARIZE duplicate aggregation output has distinct column names",
		schema("node_sum_dup"), ["year", "amount_sum", "amount_sum_2"]);

	// 6g. 分組鍵與聚合別名撞名時也不可以出兩個同名欄位
	//     用一張真的有 amount_sum 欄位的表，才能真的製造碰撞
	conn.query("CREATE OR REPLACE TABLE clash_src AS SELECT 1 AS amount_sum, 5 AS amount;");
	const clashBody = compiler.compileNodeSelect(
		"node_sum_clash",
		"SUMMARIZE",
		{ groupBy: ["amount_sum"], aggregations: [{ func: "SUM", target: "amount" }] },
		["clash_src"],
	);
	conn.query(`CREATE OR REPLACE TABLE node_sum_clash AS ${clashBody};`);
	add("SUMMARIZE group key / aggregate alias collision is resolved",
		schema("node_sum_clash"), ["amount_sum", "amount_sum_2"]);
	add("SUMMARIZE colliding aggregate keeps the right value",
		q("SELECT amount_sum, amount_sum_2 FROM node_sum_clash;"), [["1", "5"]]);

	// 6h. 不合法的聚合函數必須被白名單擋掉（不可注入）
	add("SUMMARIZE rejects a function outside the whitelist",
		compiler.compileNodeSelect("x", "SUMMARIZE",
			{ groupBy: ["year"], aggregations: [{ func: "SUM(1); DROP TABLE sales; --", target: "amount" }] },
			["sales"]).includes("DROP"), false);

	// =====================================================================
	// 7. UNION：N 路合併
	// =====================================================================
	conn.query("CREATE OR REPLACE TABLE u_a AS SELECT 1 AS id, 'a' AS tag, 10 AS amount;");
	// 刻意換欄位順序、並少一個欄位 —— 按位置對齊會把資料接到錯的欄位
	conn.query("CREATE OR REPLACE TABLE u_b AS SELECT 'b' AS tag, 20 AS amount, 2 AS id;");

	// 7a. resolveSourceTables 必須回傳全部上游
	add("UNION resolves every upstream table",
		compiler.resolveSourceTables("node_u", "UNION", [
			{ source: "u_a", target: "node_u" },
			{ source: "u_b", target: "node_u" },
		]),
		["u_a", "u_b"]);
	add("UNION with no upstream falls back to raw_data",
		compiler.resolveSourceTables("node_u", "UNION", []), ["raw_data"]);

	// 7b. BY NAME（預設）：依欄位名對齊
	const unionByName = compiler.compileNodeSelect(
		"node_u",
		"UNION",
		{ unionMode: "BY_NAME" },
		["u_a", "u_b"],
	);
	conn.query(`CREATE OR REPLACE TABLE node_u AS ${unionByName};`);
	add("UNION BY NAME output columns follow the first branch",
		schema("node_u"), ["id", "tag", "amount"]);
	add("UNION BY NAME aligns by column name, not position",
		q("SELECT id, tag, amount FROM node_u ORDER BY id;"),
		[["1", "a", "10"], ["2", "b", "20"]]);

	// 7c. 缺欄位補 NULL
	conn.query("CREATE OR REPLACE TABLE u_c AS SELECT 3 AS id, 'c' AS tag;");
	const unionMissing = compiler.compileNodeSelect(
		"node_u2",
		"UNION",
		{ unionMode: "BY_NAME" },
		["u_a", "u_c"],
	);
	conn.query(`CREATE OR REPLACE TABLE node_u2 AS ${unionMissing};`);
	// 注意 q() 把所有值 map 成 String，所以 SQL NULL 在這裡是 "null"
	add("UNION BY NAME fills a missing column with NULL",
		q("SELECT id, tag, amount FROM node_u2 ORDER BY id;"),
		[["1", "a", "10"], ["3", "c", "null"]]);

	// 7d. POSITION：按位置對齊（刻意與 BY NAME 對照）
	const unionByPos = compiler.compileNodeSelect(
		"node_u3",
		"UNION",
		{ unionMode: "POSITION" },
		["u_a", "u_b"],
	);
	add("UNION POSITION does not use BY NAME",
		unionByPos.includes("BY NAME"), false);
	conn.query(`CREATE OR REPLACE TABLE node_u3 AS ${unionByPos};`);
	// 這正是 BY_NAME 要避開的陷阱：u_b 的欄位順序是 (tag, amount, id)，
	// 按位置對齊會把 'b' 接進 id、20 接進 tag。
	add("UNION POSITION really does align by position (the trap BY_NAME avoids)",
		q("SELECT id, tag FROM node_u3 ORDER BY 1;"),
		[["1", "a"], ["b", "20"]]);
	add("UNION POSITION output columns follow the first branch",
		schema("node_u3"), ["id", "tag", "amount"]);

	add("UNION rejects an unknown mode and falls back to BY_NAME",
		compiler.compileNodeSelect("x", "UNION", { unionMode: "'; DROP TABLE u_a; --" }, ["u_a", "u_b"])
			.includes("BY NAME"), true);

	// =====================================================================
	// 8. SAMPLE
	// =====================================================================
	conn.query(
		"CREATE OR REPLACE TABLE s_src AS SELECT range AS id FROM range(0, 100);",
	);
	const firstSql = compiler.compileNodeSelect("node_s1", "SAMPLE", { sampleMode: "FIRST", sampleSize: 5 }, ["s_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_s1 AS ${firstSql};`);
	add("SAMPLE FIRST takes the leading rows",
		q("SELECT id FROM node_s1 ORDER BY id;"),
		[["0"], ["1"], ["2"], ["3"], ["4"]]);

	const randSql = compiler.compileNodeSelect("node_s2", "SAMPLE", { sampleMode: "RANDOM", sampleSize: 7 }, ["s_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_s2 AS ${randSql};`);
	add("SAMPLE RANDOM returns exactly n rows",
		Number(q("SELECT count(*) AS n FROM node_s2;")[0][0]), 7);
	add("SAMPLE RANDOM rows all come from the source",
		q("SELECT count(*) AS n FROM node_s2 WHERE id NOT IN (SELECT id FROM s_src);")[0][0], "0");

	// 固定 seed 的意義：同一份資料重跑拿到同一批樣本
	conn.query(`CREATE OR REPLACE TABLE node_s2b AS ${randSql};`);
	add("SAMPLE RANDOM is reproducible (fixed seed)",
		q("SELECT id FROM node_s2 ORDER BY id;"), q("SELECT id FROM node_s2b ORDER BY id;"));

	add("SAMPLE size is clamped to a non-negative integer",
		compiler.compileNodeSelect("x", "SAMPLE", { sampleMode: "FIRST", sampleSize: -5 }, ["s_src"]).includes("LIMIT 100"), true);
	add("SAMPLE falls back to FIRST for an unknown mode",
		compiler.compileNodeSelect("x", "SAMPLE", { sampleMode: "SOMETHING ELSE" }, ["s_src"]).includes("LIMIT"), true);

	// =====================================================================
	// 9. RENAME
	// =====================================================================
	conn.query("CREATE OR REPLACE TABLE r_src AS SELECT 1 AS id, 100 AS amount, 'x' AS tag;");
	const renameSql = compiler.compileNodeSelect(
		"node_r",
		"RENAME",
		{ renames: [{ from: "amount", to: "revenue" }] },
		["r_src"],
	);
	conn.query(`CREATE OR REPLACE TABLE node_r AS ${renameSql};`);
	// 已改用 `* RENAME (舊名 AS 新名)`：欄位留在原本位置。
	// 舊版用 `* EXCLUDE (舊名), 舊名 AS 新名`，效果一樣但會把新欄位搬到最後 ——
	// 對下游「按位置」的步驟（例如 UNION POSITION）是靜默的災難。
	// 這條斷言守住的就是「換寫法之後順序真的沒變」。
	add("RENAME keeps the renamed column in its original position",
		schema("node_r"), ["id", "revenue", "tag"]);
	add("RENAME keeps the values under the new name",
		q("SELECT id, revenue, tag FROM node_r;"), [["1", "100", "x"]]);

	// 多組改名
	const renameMulti = compiler.compileNodeSelect(
		"node_r2",
		"RENAME",
		{ renames: [{ from: "amount", to: "revenue" }, { from: "tag", to: "label" }] },
		["r_src"],
	);
	conn.query(`CREATE OR REPLACE TABLE node_r2 AS ${renameMulti};`);
	add("RENAME handles several pairs at once", schema("node_r2"), ["id", "revenue", "label"]);
	// 未設定 → passthrough，不可產生語法不完整的 SQL
	const renameEmpty = compiler.compileNodeSelect("node_r3", "RENAME", { renames: [] }, ["r_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_r3 AS ${renameEmpty};`);
	add("RENAME with no pairs is a passthrough", schema("node_r3"), ["id", "amount", "tag"]);

	// from === to 的組必須被丟掉（否則 RENAME 一個不存在的改名沒有意義）
	add("RENAME drops no-op pairs",
		compiler.compileNodeSelect("x", "RENAME", { renames: [{ from: "amount", to: "amount" }] }, ["r_src"]),
		'SELECT * FROM "r_src"');

	// 舊 payload：field → outputColumn
	add("RENAME still understands the legacy field/outputColumn shape",
		compiler.compileNodeSelect("x", "RENAME", { field: "amount", outputColumn: "revenue" }, ["r_src"])
			.includes('"amount" AS "revenue"'), true);

	// =====================================================================
	// 10. 資料清理組：UNIQUE / IMPUTE / DATA_CLEANSING
	// =====================================================================
	// 一列只負責一件事，避免測試之間互相牽扯（前一版把「重複列」與「NULL note」
	// 混在同一組，結果兩條斷言都在測別的東西）。
	conn.query(
		`CREATE OR REPLACE TABLE c_src AS SELECT * FROM (VALUES
			('HK', 'a', 100, '  hello   world  '),
			('HK', 'b', 200, ''),
			('TW', 'a', 300, NULL),
			('JP', 'c', NULL, 'y')
		) AS t(country, category, amount, note);`,
	);

	// 10a. UNIQUE：有鍵 → 每個鍵只留第一列
	const uniqueKeyed = compiler.compileNodeSelect(
		"node_uniq", "UNIQUE", { columns: ["country"] }, ["c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_uniq AS ${uniqueKeyed};`);
	add("UNIQUE with keys emits DISTINCT ON", uniqueKeyed.includes("DISTINCT ON"), true);
	add("UNIQUE with keys keeps one row per key",
		q("SELECT country FROM node_uniq ORDER BY country;"), [["HK"], ["JP"], ["TW"]]);

	// 10b. UNIQUE：無鍵 → 整列去重。用一組真的有完全重複列的資料，
	//      否則這條斷言只證明「沒有重複時不會少列」，等於沒測到。
	conn.query(
		`CREATE OR REPLACE TABLE dup_src AS SELECT * FROM (VALUES
			(1, 'x'), (1, 'x'), (2, 'y')
		) AS t(id, tag);`,
	);
	const uniqueAll = compiler.compileNodeSelect("node_uniq2", "UNIQUE", {}, ["dup_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_uniq2 AS ${uniqueAll};`);
	add("UNIQUE without keys emits plain DISTINCT", uniqueAll.includes("SELECT DISTINCT *"), true);
	add("UNIQUE without keys collapses the fully-duplicated row",
		q("SELECT COUNT(*) FROM node_uniq2;"), [["2"]]);
	// 對照組：完全不重複時不可以少列
	conn.query(`CREATE OR REPLACE TABLE node_uniq3 AS ${compiler.compileNodeSelect("node_uniq3", "UNIQUE", {}, ["c_src"])};`);
	add("UNIQUE without keys does not drop distinct rows",
		q("SELECT COUNT(*) FROM node_uniq3;"), [["4"]]);
	// 有鍵時，「只差一個非鍵欄位」的列會被併掉（這才是 DISTINCT ON 的意義）
	add("UNIQUE with keys collapses rows that differ outside the key",
		q(`SELECT COUNT(*) FROM (${compiler.compileNodeSelect("x", "UNIQUE", { columns: ["id"] }, ["dup_src"])});`),
		[["2"]]);

	// 10c. IMPUTE 常數：只補指定的欄位
	const imputeConst = compiler.compileNodeSelect(
		"node_imp", "IMPUTE",
		{ columns: ["amount"], method: "CONSTANT", fillValue: "0" }, ["c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_imp AS ${imputeConst};`);
	add("IMPUTE constant fills the NULL",
		q("SELECT amount FROM node_imp WHERE country = 'JP';"), [["0"]]);
	add("IMPUTE constant leaves other rows alone",
		q("SELECT amount FROM node_imp WHERE country = 'HK' ORDER BY category;"), [["100"], ["200"]]);
	// * REPLACE 必須保留欄位順序（EXCLUDE + 同名 AS 會把欄位搬到最後）
	add("IMPUTE keeps the column in place", schema("node_imp"),
		["country", "category", "amount", "note"]);

	// 10d. IMPUTE 平均：(100+200+300)/3 = 200，NULL 不列入分母。
	//      CAST(... AS VARCHAR) 是刻意的：斷言工具會把值 String() 化，
	//      而 JS 的 String(200.0) 是 "200" —— 不加 cast 就看不出整數/浮點之別。
	const imputeMean = compiler.compileNodeSelect(
		"node_imp2", "IMPUTE",
		{ columns: ["amount"], method: "MEAN" }, ["c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_imp2 AS ${imputeMean};`);
	add("IMPUTE mean uses the column average, ignoring NULLs in the denominator",
		q("SELECT CAST(amount AS VARCHAR) FROM node_imp2 WHERE country = 'JP';"), [["200.0"]]);
	// REPLACE 會把欄位型別放寬（INTEGER → DOUBLE），不會把平均值截成整數
	add("IMPUTE mean widens the column type instead of truncating",
		q("SELECT DISTINCT typeof(amount) FROM node_imp2;"), [["DOUBLE"]]);

	// 10e. IMPUTE 未指定欄位 → passthrough（不可產生壞 SQL）
	add("IMPUTE with no columns is a passthrough",
		compiler.compileNodeSelect("x", "IMPUTE", { columns: [] }, ["c_src"]),
		'SELECT * FROM "c_src"');

	// 10f. DATA_CLEANSING：trim + 空字串轉 NULL
	const cleanse = compiler.compileNodeSelect(
		"node_clean", "DATA_CLEANSING",
		{ columns: ["note"], trim: true, collapse: false, emptyToNull: true }, ["c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_clean AS ${cleanse};`);
	add("DATA_CLEANSING trims surrounding whitespace",
		q("SELECT note FROM node_clean WHERE country = 'HK' AND category = 'a';"), [["hello   world"]]);
	add("DATA_CLEANSING turns the empty string into NULL",
		q("SELECT note FROM node_clean WHERE country = 'HK' AND category = 'b';"), [["null"]]);
	add("DATA_CLEANSING keeps the column in place", schema("node_clean"),
		["country", "category", "amount", "note"]);

	// 10g. collapse：把內部連續空白壓成一個（並且必然含 trim）
	const collapse = compiler.compileNodeSelect(
		"node_clean2", "DATA_CLEANSING",
		{ columns: ["note"], trim: false, collapse: true, emptyToNull: false }, ["c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_clean2 AS ${collapse};`);
	add("DATA_CLEANSING collapse squeezes inner whitespace",
		q("SELECT note FROM node_clean2 WHERE country = 'HK' AND category = 'a';"), [["hello world"]]);
	// collapse 時 trim 即使設 false 也必須生效（否則會留下頭尾空白）
	add("DATA_CLEANSING collapse implies trim",
		q("SELECT note FROM node_clean2 WHERE country = 'JP';"), [["y"]]);
	// emptyToNull=false 時空字串要留著
	add("DATA_CLEANSING can keep empty strings when asked",
		q("SELECT note FROM node_clean2 WHERE country = 'HK' AND category = 'b';"), [[""]]);

	// 10h. NULL 欄位不可以被 trim 弄成空字串（NULL 要維持 NULL）
	add("DATA_CLEANSING leaves NULL as NULL",
		q("SELECT note FROM node_clean WHERE country = 'TW' AND category = 'a';"), [["null"]]);

	// =====================================================================
	// 11. 樞紐 / 轉置組：CROSS_TAB / TRANSPOSE / TEXT_TO_COLUMNS
	// =====================================================================
	// 11a. CROSS_TAB：列轉欄
	const crossTab = compiler.compileNodeSelect(
		"node_ct", "CROSS_TAB",
		{ pivotColumn: "category", valueColumn: "amount", aggFunc: "SUM", groupBy: ["country"] },
		["c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_ct AS ${crossTab};`);
	const ctCols = schema("node_ct");
	add("CROSS_TAB pivots the category values into columns",
		ctCols.includes("a") && ctCols.includes("b") && ctCols.includes("c"), true);
	add("CROSS_TAB groups by the retained key",
		q("SELECT country, a FROM node_ct ORDER BY country;"), [["HK", "100"], ["JP", "null"], ["TW", "300"]]);
	// 缺組合必須是 NULL，不是 0（不然下游會把「沒有資料」當成「量為零」）
	add("CROSS_TAB leaves a missing combination as NULL",
		q("SELECT b FROM node_ct WHERE country = 'JP';"), [["null"]]);

	// 11a-2. 同一組 (country, category) 有多列時，聚合函數真的會生效
	conn.query(
		`CREATE OR REPLACE TABLE ct_src AS SELECT * FROM (VALUES
			('HK', 'a', 100), ('HK', 'a', 200), ('HK', 'b', 50)
		) AS t(country, category, amount);`,
	);
	const ctSum = compiler.compileNodeSelect(
		"node_ct2", "CROSS_TAB",
		{ pivotColumn: "category", valueColumn: "amount", aggFunc: "SUM", groupBy: ["country"] },
		["ct_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_ct2 AS ${ctSum};`);
	add("CROSS_TAB SUM adds up duplicate (group, pivot) pairs",
		q("SELECT a FROM node_ct2;"), [["300"]]);
	const ctFirst = compiler.compileNodeSelect(
		"node_ct3", "CROSS_TAB",
		{ pivotColumn: "category", valueColumn: "amount", aggFunc: "FIRST", groupBy: ["country"] },
		["ct_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_ct3 AS ${ctFirst};`);
	add("CROSS_TAB FIRST takes only the first duplicate",
		q("SELECT a FROM node_ct3;"), [["100"]]);

	// 11b. CROSS_TAB 的聚合函數走白名單
	add("CROSS_TAB rejects a function outside the whitelist",
		compiler.compileNodeSelect("x", "CROSS_TAB",
			{ pivotColumn: "category", valueColumn: "amount", aggFunc: "SUM(1); DROP TABLE c_src; --" },
			["c_src"]).includes("DROP"), false);
	// FIRST 必須被允許（它在 sql.ts 的白名單裡，是 PIVOT 的常用聚合）
	add("CROSS_TAB accepts FIRST",
		compiler.compileNodeSelect("x", "CROSS_TAB",
			{ pivotColumn: "category", valueColumn: "amount", aggFunc: "FIRST" },
			["c_src"]).includes('FIRST("amount")'), true);

	// 11c. TRANSPOSE：欄轉列
	const transpose = compiler.compileNodeSelect(
		"node_tp", "TRANSPOSE",
		{ columns: ["amount"], nameColumn: "metric", valueColumn: "value" }, ["c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_tp AS ${transpose};`);
	add("TRANSPOSE adds the name and value columns",
		schema("node_tp"), ["country", "category", "note", "metric", "value"]);
	add("TRANSPOSE emits one row per source column",
		q("SELECT DISTINCT metric FROM node_tp;"), [["amount"]]);
	add("TRANSPOSE carries the values across",
		q("SELECT value FROM node_tp WHERE country = 'HK' AND category = 'a';"), [["100"]]);
	// 未指定欄位 → passthrough
	add("TRANSPOSE with no columns is a passthrough",
		compiler.compileNodeSelect("x", "TRANSPOSE", { columns: [] }, ["c_src"]),
		'SELECT * FROM "c_src"');

	// 11d. TEXT_TO_COLUMNS：拆欄；資料不足的段必須是 NULL（不是空字串）
	conn.query("CREATE OR REPLACE TABLE t2c_src AS SELECT * FROM (VALUES (1, 'a,b,c'), (2, 'x'), (3, NULL)) AS t(id, raw);");
	const t2c = compiler.compileNodeSelect(
		"node_t2c", "TEXT_TO_COLUMNS",
		{ field: "raw", separator: ",", outputColumns: ["p1", "p2", "p3"] }, ["t2c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_t2c AS ${t2c};`);
	add("TEXT_TO_COLUMNS splits on the separator",
		q("SELECT p1, p2, p3 FROM node_t2c WHERE id = 1;"), [["a", "b", "c"]]);
	// 越界的段：DuckDB 的 string_split(...)[n] 回 NULL —— Polars 那邊要靠
	// list.get(..., null_on_oob=True) 才會一致（見 exportPolars 的註解）
	add("TEXT_TO_COLUMNS returns NULL for a missing segment, not an empty string",
		q("SELECT p2, p3 FROM node_t2c WHERE id = 2;"), [["null", "null"]]);
	add("TEXT_TO_COLUMNS passes NULL through",
		q("SELECT p1 FROM node_t2c WHERE id = 3;"), [["null"]]);
	add("TEXT_TO_COLUMNS keeps the source column", schema("node_t2c"), ["id", "raw", "p1", "p2", "p3"]);
	// 未指定輸出欄位 → passthrough
	add("TEXT_TO_COLUMNS with no output columns is a passthrough",
		compiler.compileNodeSelect("x", "TEXT_TO_COLUMNS", { field: "raw", outputColumns: [] }, ["t2c_src"]),
		'SELECT * FROM "t2c_src"');

	// --- 11d-2. TEXT_TO_COLUMNS 的正規表示式切分模式 ---
	// SEPARATOR 是**字面**比對（string_split 不做 regex），REGEX 才是樣式。
	// 這個區分本身就是重點：一個含 '.' 或 '|' 的分隔符在兩種模式下結果完全不同。
	const t2cRe = compiler.compileNodeSelect(
		"node_t2c_re", "TEXT_TO_COLUMNS",
		{ field: "raw", separator: "\\s*,\\s*", splitMode: "REGEX", outputColumns: ["q1", "q2"] },
		["t2c_src"]);
	add("TEXT_TO_COLUMNS REGEX mode emits regexp_split_to_array",
		t2cRe.includes("regexp_split_to_array("), true);
	add("TEXT_TO_COLUMNS SEPARATOR mode does not use a regex splitter",
		compiler.compileNodeSelect("x", "TEXT_TO_COLUMNS",
			{ field: "raw", separator: ",", outputColumns: ["a"] }, ["t2c_src"]).includes("regexp_split_to_array"),
		false);
	conn.query("CREATE OR REPLACE TABLE re_t2c_src AS SELECT * FROM (VALUES (1, 'a , b'), (2, 'a1b22c'), (3, NULL)) AS t(id, raw);");
	const t2cReRun = compiler.compileNodeSelect(
		"node_t2c_re_run", "TEXT_TO_COLUMNS",
		{ field: "raw", separator: "\\s*,\\s*", splitMode: "REGEX", outputColumns: ["q1", "q2"] },
		["re_t2c_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_t2c_re_run AS ${t2cReRun};`);
	// 可變長度的樣式：'a , b' 用 '\s*,\s*' 切成 a / b（單一分隔符做不到）
	add("TEXT_TO_COLUMNS REGEX splits on a variable-length pattern",
		q("SELECT q1, q2 FROM node_t2c_re_run WHERE id = 1;"), [["a", "b"]]);
	// 越界與 NULL 的行為必須與 SEPARATOR 模式一致
	add("TEXT_TO_COLUMNS REGEX returns NULL for a missing segment",
		q("SELECT q2 FROM node_t2c_re_run WHERE id = 2;"), [["null"]]);
	add("TEXT_TO_COLUMNS REGEX passes NULL through",
		q("SELECT q1 FROM node_t2c_re_run WHERE id = 3;"), [["null"]]);
	// 忽略大小寫折進 (?i)，與 REGEX 節點同一套規則
	add("TEXT_TO_COLUMNS REGEX folds case-insensitivity into (?i)",
		compiler.compileNodeSelect("x", "TEXT_TO_COLUMNS",
			{ field: "raw", separator: "x", splitMode: "REGEX", caseInsensitive: true, outputColumns: ["a"] },
			["t2c_src"]).includes("'(?i)x'"),
		true);
	// 空樣式會讓 regexp_split_to_array 逐字元切一刀，產生一堆無意義欄位 ——
	// 與 REGEX 節點一致，沒有樣式就 passthrough。
	add("TEXT_TO_COLUMNS REGEX with an empty pattern is a passthrough",
		compiler.compileNodeSelect("x", "TEXT_TO_COLUMNS",
			{ field: "raw", separator: "", splitMode: "REGEX", outputColumns: ["a"] }, ["t2c_src"]),
		'SELECT * FROM "t2c_src"');
	add("TEXT_TO_COLUMNS falls back to SEPARATOR for a mode outside the whitelist",
		compiler.compileNodeSelect("x", "TEXT_TO_COLUMNS",
			{ field: "raw", separator: ",", splitMode: "DROP TABLE", outputColumns: ["a"] }, ["t2c_src"])
			.includes("string_split("),
		true);

	// 11e. REGEX：MATCH / PARSE / REPLACE
	// 這一段刻意把「未命中」與「NULL 輸入」都測到：regexp_extract 未命中時回
	// **空字串**而不是 NULL，這是與 Polars str.extract 的已知差異（見 exportPolars），
	// 寫成 assertion 才不會被「順手改成 COALESCE」修掉。
	conn.query(
		`CREATE OR REPLACE TABLE re_src AS SELECT * FROM (VALUES
			('HK-1001', 1), ('TW-2002', 2), ('XX', 3), (NULL, 4)
		) AS t(code, id);`,
	);

	// --- MATCH → 布林欄位 ---
	const reMatch = compiler.compileNodeSelect(
		"node_re_match", "REGEX",
		{ field: "code", regexMode: "MATCH", pattern: "^[A-Z]{2}-\\d{4}$", outputColumn: "is_valid" },
		["re_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_re_match AS ${reMatch};`);
	add("REGEX MATCH produces a boolean column",
		q("SELECT is_valid FROM node_re_match WHERE id = 1;"), [["true"]]);
	add("REGEX MATCH is false (not NULL) for a non-matching row",
		q("SELECT is_valid FROM node_re_match WHERE id = 3;"), [["false"]]);
	add("REGEX MATCH passes NULL input through",
		q("SELECT is_valid FROM node_re_match WHERE id = 4;"), [["null"]]);
	add("REGEX MATCH keeps the source columns",
		schema("node_re_match"), ["code", "id", "is_valid"]);

	// --- PARSE → 每個 capture group 一欄 ---
	const reParse = compiler.compileNodeSelect(
		"node_re_parse", "REGEX",
		{ field: "code", regexMode: "PARSE", pattern: "([A-Z]{2})-(\\d{4})",
		  outputColumns: ["country", "number"] },
		["re_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_re_parse AS ${reParse};`);
	add("REGEX PARSE extracts each capture group",
		q("SELECT country, number FROM node_re_parse WHERE id = 1;"), [["HK", "1001"]]);
	// 已實測的跨引擎差異：DuckDB 回空字串、Polars 的 str.extract 回 null
	// （q() 會把每個值 String() 化，所以布林是 "false" / "true" 字串）
	add("REGEX PARSE yields an EMPTY STRING, not NULL, when nothing matches",
		q("SELECT country IS NULL AS is_null, country = '' AS is_empty FROM node_re_parse WHERE id = 3;"),
		[["false", "true"]]);
	add("REGEX PARSE passes NULL input through",
		q("SELECT country FROM node_re_parse WHERE id = 4;"), [["null"]]);

	// --- REPLACE → 全域取代（'g'），且支援反向參照 ---
	const reRepl = compiler.compileNodeSelect(
		"node_re_repl", "REGEX",
		{ field: "code", regexMode: "REPLACE", pattern: "\\d", replacement: "#",
		  outputColumn: "masked" },
		["re_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_re_repl AS ${reRepl};`);
	add("REGEX REPLACE replaces every hit, not just the first",
		q("SELECT masked FROM node_re_repl WHERE id = 1;"), [["HK-####"]]);
	const reSwap = compiler.compileNodeSelect(
		"node_re_swap", "REGEX",
		{ field: "code", regexMode: "REPLACE", pattern: "([A-Z]{2})-(\\d+)",
		  replacement: "\\2-\\1", outputColumn: "swapped" },
		["re_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_re_swap AS ${reSwap};`);
	add("REGEX REPLACE supports \\1 backreferences",
		q("SELECT swapped FROM node_re_swap WHERE id = 1;"), [["1001-HK"]]);

	// --- caseInsensitive 必須摺成 inline (?i)，因為 Polars 沒有 case 參數 ---
	const reCi = compiler.compileNodeSelect(
		"node_re_ci", "REGEX",
		{ field: "code", regexMode: "MATCH", pattern: "hk", caseInsensitive: true, outputColumn: "m" },
		["re_src"]);
	add("REGEX folds case-insensitivity into an inline (?i)",
		reCi.includes("'(?i)hk'"), true);
	conn.query(`CREATE OR REPLACE TABLE node_re_ci AS ${reCi};`);
	add("REGEX case-insensitive MATCH actually matches",
		q("SELECT m FROM node_re_ci WHERE id = 1;"), [["true"]]);

	// --- 邊界：空白樣式、非法模式、非字串欄位 ---
	add("REGEX with no pattern is a passthrough (not an always-false column)",
		compiler.compileNodeSelect("x", "REGEX", { field: "code", pattern: "" }, ["re_src"]),
		'SELECT * FROM "re_src"');
	add("REGEX falls back to MATCH for a mode outside the whitelist",
		compiler.compileNodeSelect("x", "REGEX",
			{ field: "code", regexMode: "DROP TABLE", pattern: "a" }, ["re_src"]).includes("regexp_matches"),
		true);
	add("REGEX PARSE with no capture-column names is a passthrough",
		compiler.compileNodeSelect("x", "REGEX",
			{ field: "code", regexMode: "PARSE", pattern: "a", outputColumns: [] }, ["re_src"]),
		'SELECT * FROM "re_src"');
	// 樣式裡的反斜線不可以被當成 escape —— DuckDB 的單引號字串不做 backslash escaping，
	// 所以 strLit 只 escape 單引號是正確的。這條 assertion 把那個假設釘住。
	add("REGEX escapes a quote in the pattern without touching backslashes",
		compiler.compileNodeSelect("x", "REGEX",
			{ field: "code", pattern: "it's \\d+" }, ["re_src"]).includes("'it''s \\d+'"),
		true);

	// 11f. MULTI_FIELD_FORMULA：一個運算式套用到多個欄位
	// 這裡刻意讓 name / code 兩欄的值不同 —— 這樣才能分辨「逐欄代入 _CurrentField_」
	// 與「只算一次然後複製到每一欄」（後者會讓兩欄拿到同一個值）。
	conn.query(
		`CREATE OR REPLACE TABLE mff_src AS SELECT * FROM (VALUES
			('  ab  ', 'x', 10), ('cd', 'y', 20), (NULL, NULL, 30)
		) AS t(name, code, amount);`,
	);

	// --- OVERWRITE：就地改寫 ---
	const mffOver = compiler.compileNodeSelect(
		"node_mff_over", "MULTI_FIELD_FORMULA",
		{ columns: ["name", "code"], expression: "TRIM(_CurrentField_)", outputMode: "OVERWRITE" },
		["mff_src"]);
	add("MULTI_FIELD_FORMULA OVERWRITE emits SELECT * REPLACE",
		mffOver.startsWith("SELECT * REPLACE ("), true);
	conn.query(`CREATE OR REPLACE TABLE node_mff_over AS ${mffOver};`);
	// 欄位順序必須不變 —— 這正是選用 REPLACE 而不是重建投影的原因
	add("MULTI_FIELD_FORMULA OVERWRITE preserves column order",
		schema("node_mff_over"), ["name", "code", "amount"]);
	add("MULTI_FIELD_FORMULA trims every selected field",
		q("SELECT name, code FROM node_mff_over WHERE amount = 10;"), [["ab", "x"]]);
	add("MULTI_FIELD_FORMULA passes NULL through",
		q("SELECT name FROM node_mff_over WHERE amount = 30;"), [["null"]]);

	// 逐欄代入的證明：同一個運算式 UPPER(_CurrentField_)，兩欄的結果必須不同。
	// 若實作只算一次再複製，這裡會拿到 ['X','X'] 而不是 ['AB','X']。
	const mffPerCol = compiler.compileNodeSelect(
		"node_mff_percol", "MULTI_FIELD_FORMULA",
		{ columns: ["name", "code"], expression: "UPPER(_CurrentField_)" }, ["mff_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_mff_percol AS ${mffPerCol};`);
	add("MULTI_FIELD_FORMULA substitutes _CurrentField_ per field, not once",
		q("SELECT name, code FROM node_mff_percol WHERE amount = 10;"), [["  AB  ", "X"]]);

	// --- NEW_FIELD：保留原欄位 ---
	const mffNew = compiler.compileNodeSelect(
		"node_mff_new", "MULTI_FIELD_FORMULA",
		{ columns: ["name"], expression: "UPPER(_CurrentField_)", outputMode: "NEW_FIELD" },
		["mff_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_mff_new AS ${mffNew};`);
	add("MULTI_FIELD_FORMULA NEW_FIELD keeps the original column",
		schema("node_mff_new"), ["name", "code", "amount", "name_new"]);
	add("MULTI_FIELD_FORMULA NEW_FIELD appends the transformed value",
		q("SELECT name, name_new FROM node_mff_new WHERE amount = 10;"), [["  ab  ", "  AB  "]]);
	const mffUp = compiler.compileNodeSelect(
		"node_mff_up", "MULTI_FIELD_FORMULA",
		{ columns: ["name"], expression: "UPPER(_CurrentField_)", outputMode: "NEW_FIELD", newFieldSuffix: "_up" },
		["mff_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_mff_up AS ${mffUp};`);
	add("MULTI_FIELD_FORMULA honours a custom suffix",
		schema("node_mff_up"), ["name", "code", "amount", "name_up"]);
	// 空後綴會讓新欄位與原欄位同名。實測：DuckDB 安靜地產生兩個同名的欄位，
	// 而 Polars 的同名 alias 是安靜地就地取代 —— 兩邊都不報錯卻做不同的事，
	// 所以空後綴一律退回 "_new"。
	add("MULTI_FIELD_FORMULA falls back to _new for an empty suffix",
		compiler.compileNodeSelect("x", "MULTI_FIELD_FORMULA",
			{ columns: ["name"], expression: "UPPER(_CurrentField_)", outputMode: "NEW_FIELD", newFieldSuffix: "" },
			["mff_src"]).includes('AS "name_new"'),
		true);

	// --- 防呆 ---
	// 重複的欄位：兩個引擎都會直接報錯（DuckDB: Duplicate entry in REPLACE list），
	// 所以編譯器先收掉。這條會同時證明它真的收掉了，而不是產生會炸的 SQL。
	add("MULTI_FIELD_FORMULA dedupes a repeated field",
		compiler.compileNodeSelect("x", "MULTI_FIELD_FORMULA",
			{ columns: ["name", "name"], expression: "TRIM(_CurrentField_)" }, ["mff_src"]),
		'SELECT * REPLACE ((TRIM("name")) AS "name") FROM "mff_src"');
	// 沒有 _CurrentField_ 就等於「把每一欄都寫成同一個常數」，在 OVERWRITE 模式
	// 是不可逆的資料破壞。所以退回 passthrough，而不是照做。
	add("MULTI_FIELD_FORMULA without _CurrentField_ is a passthrough",
		compiler.compileNodeSelect("x", "MULTI_FIELD_FORMULA",
			{ columns: ["name", "code"], expression: "1" }, ["mff_src"]),
		'SELECT * FROM "mff_src"');
	add("MULTI_FIELD_FORMULA with no columns is a passthrough",
		compiler.compileNodeSelect("x", "MULTI_FIELD_FORMULA",
			{ columns: [], expression: "TRIM(_CurrentField_)" }, ["mff_src"]),
		'SELECT * FROM "mff_src"');
	// LLM 很常寫成小寫的 _currentfield_；兩種寫法只可能指同一個東西。
	add("MULTI_FIELD_FORMULA accepts a lower-case _currentfield_",
		compiler.compileNodeSelect("x", "MULTI_FIELD_FORMULA",
			{ columns: ["name"], expression: "trim(_currentfield_)" }, ["mff_src"]),
		'SELECT * REPLACE ((trim("name")) AS "name") FROM "mff_src"');
	add("MULTI_FIELD_FORMULA falls back to OVERWRITE for a mode outside the whitelist",
		compiler.compileNodeSelect("x", "MULTI_FIELD_FORMULA",
			{ columns: ["name"], expression: "TRIM(_CurrentField_)", outputMode: "DROP TABLE" },
			["mff_src"]).startsWith("SELECT * REPLACE ("),
		true);
	// 數值欄位也可以就地改寫。刻意用 * 2 而不是 * 1.1：DECIMAL 在這個 harness 的
	// `q()` 裡是以未套用 scale 的原值回傳的（Arrow 的 DecimalBigNum），
	// 那是 harness 的限制，不該混進這條斷言裡。整數運算就沒有這個問題。
	const mffNum = compiler.compileNodeSelect(
		"node_mff_num", "MULTI_FIELD_FORMULA",
		{ columns: ["amount"], expression: "_CurrentField_ * 2" }, ["mff_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_mff_num AS ${mffNum};`);
	add("MULTI_FIELD_FORMULA rewrites a numeric column in place",
		q("SELECT amount FROM node_mff_num ORDER BY amount;"), [["20"], ["40"], ["60"]]);
	add("MULTI_FIELD_FORMULA leaves the untouched columns alone",
		schema("node_mff_num"), ["name", "code", "amount"]);

	// =====================================================================
	// 11g. FUZZY_JOIN：模糊比對
	// =====================================================================
	// Jaro-Winkler / Levenshtein / Damerau 都是 duckdb-wasm **內建**的，不需要
	// INSTALL / LOAD 任何 extension（在出貨的 wasm 上實測）。這點值得釘住，因為
	// 「要不要載 extension」正是瀏覽器裡最容易踩雷的地方 —— wasm 版沒有網路，
	// INSTALL 會變成 no-op，真正能用只因為它是靜態連結進去的。
	//
	// 這幾個常數在這裡釘一次，scripts/verify.mjs 的 FUZZY_JOIN 執行斷言再釘一次
	// 同一個分數：Polars 沒有對應函式，匯出時是內嵌一份純 Python 實作，
	// 兩邊各釘一次才擋得住「只改了一邊」。
	add("the shipped wasm has jaro_winkler_similarity built in",
		q("SELECT jaro_winkler_similarity('martha','marhta');"), [["0.9611111111111111"]]);
	add("the shipped wasm has levenshtein built in",
		q("SELECT levenshtein('kitten','sitting');"), [["3"]]);
	// DuckDB 的 damerau_levenshtein 是 **unrestricted** 版本，不是教科書的 OSA：
	// 'ca' vs 'abc' 它回 2，OSA 會回 3。內嵌的 Python 實作照這個（已照）。
	add("DuckDB's damerau_levenshtein is the unrestricted variant, not OSA",
		q("SELECT damerau_levenshtein('ca','abc');"), [["2"]]);
	// 空字串：DuckDB 回 0.0，不是直覺的 1.0。內嵌實作照這個（已照）。
	// 這裡的預期值是 "0" 而不是 "0.0"：harness 的 q() 把每個值丟給 String()，
	// 而 String(0) === "0"。這是 harness 的呈現方式，不是引擎的語意差異。
	add("jaro_winkler_similarity of two empty strings is 0.0, not 1.0",
		q("SELECT jaro_winkler_similarity('','');"), [["0"]]);
	// 三個函式都區分大小寫 → 「忽略大小寫」只能靠 LOWER()，不能指望函式本身。
	// 這正是 Polars 那邊 lower=True 與 SQL 那邊 lower() 的依據。
	add("the fuzzy functions are case-sensitive",
		q("SELECT jaro_winkler_similarity('hello','HELLO'), levenshtein('hello','HELLO');"),
		[["0", "5"]]);

	conn.query(`CREATE OR REPLACE TABLE fz_left AS SELECT * FROM (VALUES
		(1, 'martha'), (2, 'kitten'), (3, 'xyz'), (4, 'Smith')) AS t(id, name);`);
	conn.query(`CREATE OR REPLACE TABLE fz_right AS SELECT * FROM (VALUES
		(10, 'marhta'), (11, 'sitting'), (12, 'SMITH')) AS t(code, name);`);

	const fzCfg = (over = {}) => ({
		leftKey: "name", rightKey: "name", matchFunc: "JARO_WINKLER",
		threshold: 0.85, joinType: "INNER", scoreColumn: "score", ...over });
	const fzRun = (id, over) => conn.query(
		compiler.generateSqlFromConfig(id, "FUZZY_JOIN", fzCfg(over), ["fz_left", "fz_right"]));

	// 兩側鍵同名（name / name）是最常見、也最容易寫錯的情況：裸欄位名會讓 DuckDB
	// 報 "Ambiguous reference to column name"。所以這條「跑得動」本身就是對
	// a. / b. 表別名的斷言 —— 字串比對看不出這件事，只有真的執行才會炸。
	fzRun("fz_inner");
	add("FUZZY_JOIN INNER matches only the near pair",
		q("SELECT name, name_1 FROM fz_inner;"), [["martha", "marhta"]]);
	add("FUZZY_JOIN keeps both key columns, like JOIN does",
		schema("fz_inner"), ["id", "name", "code", "name_1", "score"]);
	add("FUZZY_JOIN exposes the Jaro-Winkler score",
		q("SELECT score FROM fz_inner;"), [["0.9611111111111111"]]);

	// 距離型指標的方向必須是 <=（越小越像）。寫成 >= 會讓「最不像的」全部命中，
	// 而且不會報任何錯 —— 這種 bug 只有看資料才發現得了。
	fzRun("fz_lev", { matchFunc: "LEVENSHTEIN", threshold: 2 });
	add("FUZZY_JOIN compares an edit distance with <=, not >=",
		q("SELECT name, name_1 FROM fz_lev;"), [["martha", "marhta"]]);

	// 忽略大小寫要靠 LOWER()：函式本身區分大小寫，Smith/SMITH 才會變成 1.0。
	fzRun("fz_ci", { caseInsensitive: true });
	add("FUZZY_JOIN case-insensitive also matches the differing-case pair",
		q("SELECT name, name_1 FROM fz_ci ORDER BY id;"),
		[["martha", "marhta"], ["Smith", "SMITH"]]);
	add("...and scores an exact case-folded match as 1",
		q("SELECT score FROM fz_ci WHERE id = 4;"), [["1"]]);

	// LEFT：未命中的左表列必須留著（右表欄位為 NULL）
	fzRun("fz_lj", { joinType: "LEFT" });
	add("FUZZY_JOIN LEFT keeps unmatched left rows",
		q("SELECT id, name_1 FROM fz_lj ORDER BY id;"),
		[["1", "marhta"], ["2", "null"], ["3", "null"], ["4", "null"]]);

	// EXACT 是退化情況：只比相等，而且不產生相似度分欄（與匯出器一致）
	fzRun("fz_exact", { matchFunc: "EXACT" });
	add("FUZZY_JOIN EXACT matches only equal strings",
		q("SELECT name FROM fz_exact;"), []);
	add("FUZZY_JOIN EXACT adds no score column even if one was requested",
		schema("fz_exact"), ["id", "name", "code", "name_1"]);

	// 沒設鍵 → passthrough，不猜鍵（猜錯會變成笛卡兒積）
	conn.query(compiler.generateSqlFromConfig("fz_nokeys", "FUZZY_JOIN",
		{ leftKey: "", rightKey: "" }, ["fz_left", "fz_right"]));
	add("FUZZY_JOIN with no keys is a passthrough, not a guessed join",
		q("SELECT id FROM fz_nokeys ORDER BY id;"), [["1"], ["2"], ["3"], ["4"]]);
	add("...and adds no right-hand columns",
		schema("fz_nokeys"), ["id", "name"]);

	// 表單只提供 INNER / LEFT。硬塞 FULL OUTER 必須退回 INNER，否則 DuckDB 做
	// FULL JOIN 而 Polars 只給 INNER —— 兩個引擎無聲地不一致。
	fzRun("fz_full", { joinType: "FULL OUTER" });
	add("an out-of-range FUZZY_JOIN joinType is coerced to INNER on the SQL side",
		q("SELECT name FROM fz_full;"), [["martha"]]);

	// =====================================================================
	// 11h. SPATIAL_MATCH：空間比對（需要 LOAD spatial）
	// =====================================================================
	// 三個實測事實決定了這個節點的形狀，每一條都在這裡釘住：
	//
	// 1. 出貨的 duckdb-wasm 把 spatial **靜態連結**進去，所以 LOAD spatial 會成功
	//    而 INSTALL spatial 是 no-op（installed 永遠 false —— wasm 沒有網路）。
	//    但**全新連線預設沒載入**，直接呼叫會得到
	//    "Catalog Error: ... not in the catalog, but it exists in the spatial
	//     extension"。所以編譯器一定要補 LOAD，這不是保險起見。
	// 2. 壞掉的 WKT 會讓 ST_GeomFromText **拋錯**，不是回 NULL → 一定要包 TRY()。
	// 3. ST_Distance_Sphere 在這個 build 就是「平面度數 × 111194.93」，沒有經度
	//    收斂修正（同一段 1 度經差在赤道與 lat 60 量到同一個值）。所以 METERS
	//    只是個換算，不是真的球面距離 —— 這點寫進目錄的欄位提示裡了。
	// 兩張 fixture 的 DDL 存起來：下面的乾淨實例也要用同一份（見 LOAD 對照組）。
	const SP_PTS_DDL = `CREATE OR REPLACE TABLE sp_pts AS SELECT * FROM (VALUES
		(1, 'HK', 114.17, 22.30),
		(2, 'SZ', 114.06, 22.54),
		(3, 'TK', 139.69, 35.69)) AS t(id, city, lon, lat);`;
	const SP_ZONES_DDL = `CREATE OR REPLACE TABLE sp_zones AS SELECT * FROM (VALUES
		(10, 'Kowloon', 'POLYGON((114.0 22.2, 114.0 22.4, 114.3 22.4, 114.3 22.2, 114.0 22.2))'),
		(11, 'Tokyo', 'POLYGON((139.6 35.6, 139.6 35.8, 139.8 35.8, 139.8 35.6, 139.6 35.6))'))
		AS t(zone_id, zone, wkt);`;
	conn.query(SP_PTS_DDL);
	conn.query(SP_ZONES_DDL);

	const spCfg = (over = {}) => ({
		leftLonField: "lon", leftLatField: "lat", rightGeometryField: "wkt",
		spatialPredicate: "INTERSECTS", joinType: "INNER", ...over });
	const spRun = (id, over) => conn.query(
		compiler.generateSqlFromConfig(id, "SPATIAL_MATCH", spCfg(over), ["sp_pts", "sp_zones"]));

	// LOAD 前綴：編譯出來的語句必須自己帶上，否則換一條連線就掛。
	add("SPATIAL_MATCH emits a LOAD spatial preamble",
		compiler.compileNodeStatements("sp_x", "SPATIAL_MATCH",
			spCfg(), ["sp_pts", "sp_zones"])[0], "LOAD spatial;");
	add("a non-spatial node emits no LOAD preamble",
		compiler.compileNodeStatements("f_x", "FILTER", {}, ["sp_pts"])[0].startsWith("LOAD"), false);

	// 經緯度兩欄 → ST_Point(經度, 緯度)。實測 ST_Point 的第一個參數是 X。
	add("SPATIAL_MATCH builds a point from lon/lat in the right order",
		compiler.compileNodeSelect("sp_x", "SPATIAL_MATCH", spCfg(), ["sp_pts", "sp_zones"])
			.includes('ST_Point(TRY_CAST(a."lon" AS DOUBLE), TRY_CAST(a."lat" AS DOUBLE))'),
		true);
	// WKT 一定要包 TRY()，否則一列壞 WKT 就讓整個 join 拋錯。
	add("SPATIAL_MATCH wraps WKT parsing in TRY",
		compiler.compileNodeSelect("sp_x", "SPATIAL_MATCH", spCfg(), ["sp_pts", "sp_zones"])
			.includes('TRY(ST_GeomFromText(b."wkt"))'),
		true);

	spRun("sp_in");
	add("SPATIAL_MATCH INTERSECTS matches the two points that fall inside a zone",
		q("SELECT city, zone FROM sp_in ORDER BY city;"), [["HK", "Kowloon"], ["TK", "Tokyo"]]);
	add("...and leaves out the one that does not",
		q("SELECT count(*) FROM sp_in;"), [["2"]]);

	// 方向：CONTAINS 是「左包含右」、WITHIN 是「左落在右之內」。
	// 左邊是點、右邊是多邊形，所以 WITHIN 命中、CONTAINS 不命中 ——
	// 兩個寫反了不會報錯，只會永遠回 0 列。
	spRun("sp_contains", { spatialPredicate: "CONTAINS" });
	add("SPATIAL_MATCH CONTAINS is left-contains-right (so point CONTAINS polygon is empty)",
		q("SELECT count(*) FROM sp_contains;"), [["0"]]);
	spRun("sp_within", { spatialPredicate: "WITHIN" });
	add("SPATIAL_MATCH WITHIN is left-inside-right (so the same data matches)",
		q("SELECT count(*) FROM sp_within;"), [["2"]]);

	// LEFT：未命中的左表列要留著
	spRun("sp_left", { joinType: "LEFT" });
	add("SPATIAL_MATCH LEFT keeps the unmatched left row with a null zone",
		q("SELECT city, zone FROM sp_left ORDER BY city;"),
		[["HK", "Kowloon"], ["SZ", "null"], ["TK", "Tokyo"]]);

	// 距離：先確認這個 build 的 ST_Distance 是平面度數（3-4-5 直角三角形 = 5）
	add("ST_Distance in this build is planar (3-4-5 triangle = 5)",
		q("SELECT ST_Distance(ST_Point(0,0), ST_Point(3,4));"), [["5"]]);
	// 0.005 度經差。DEGREES 門檻 0.01 命中、0.001 不命中。
	conn.query(`CREATE OR REPLACE TABLE sp_poi AS SELECT * FROM (VALUES
		(1, 114.1700, 22.3000), (2, 114.1750, 22.3000)) AS t(poi_id, lon, lat);`);
	const spRunPoi = (id, over) => conn.query(
		compiler.generateSqlFromConfig(id, "SPATIAL_MATCH",
			{ leftLonField: "lon", leftLatField: "lat", rightLonField: "lon", rightLatField: "lat",
			  spatialPredicate: "DWITHIN", joinType: "INNER", ...over }, ["sp_poi", "sp_poi"]));

	spRunPoi("sp_d01", { distance: 0.01, distanceUnit: "DEGREES" });
	add("SPATIAL_MATCH DWITHIN in DEGREES matches within the threshold",
		q("SELECT count(*) FROM sp_d01;"), [["4"]]);
	spRunPoi("sp_d001", { distance: 0.001, distanceUnit: "DEGREES" });
	add("SPATIAL_MATCH DWITHIN in DEGREES excludes beyond the threshold",
		q("SELECT count(*) FROM sp_d001;"), [["2"]]);
	// 同一組資料換成 METERS：0.005 度 ≈ 555.97 公尺
	spRunPoi("sp_m1000", { distance: 1000, distanceUnit: "METERS" });
	add("SPATIAL_MATCH DWITHIN in METERS matches within 1000 m",
		q("SELECT count(*) FROM sp_m1000;"), [["4"]]);
	spRunPoi("sp_m100", { distance: 100, distanceUnit: "METERS" });
	add("SPATIAL_MATCH DWITHIN in METERS excludes beyond 100 m",
		q("SELECT count(*) FROM sp_m100;"), [["2"]]);
	// 而且距離欄位的值必須跟著單位換 —— 只換門檻不換輸出是最容易漏的一半。
	// 門檻用 1000 公尺（0.005 度 ≈ 555.97 公尺，要放得進去）。
	spRunPoi("sp_dc", { distance: 1000, distanceUnit: "METERS", distanceColumn: "d" });
	add("SPATIAL_MATCH writes the distance in the chosen unit",
		q("SELECT round(d, 2) FROM sp_dc WHERE poi_id = 2 AND poi_id_1 = 1;"), [["555.97"]]);

	// 壞 WKT：不能讓整個查詢拋錯，那一列要變成 NULL（不命中）
	conn.query(`CREATE OR REPLACE TABLE sp_bad AS SELECT * FROM (VALUES
		(1, 'NOPE'), (2, 'POINT(114.17 22.30)')) AS t(id, wkt);`);
	conn.query(compiler.generateSqlFromConfig("sp_bad_out", "SPATIAL_MATCH",
		{ leftGeometryField: "wkt", rightGeometryField: "wkt", spatialPredicate: "INTERSECTS" },
		["sp_bad", "sp_bad"]));
	add("a malformed WKT row becomes NULL instead of aborting the join",
		q("SELECT count(*) FROM sp_bad_out;"), [["1"]]);
	// 對照：不包 TRY 的裸 ST_GeomFromText 會拋錯 —— 證明 TRY 不是裝飾。
	// （harness 的 q() 本身不吞錯，所以這裡自己接。）
	let bareWktThrew = false;
	try {
		conn.query("SELECT ST_GeomFromText('NOPE');");
	} catch {
		bareWktThrew = true;
	}
	add("without TRY a malformed WKT really does throw (so TRY is load-bearing)",
		bareWktThrew, true);

	// 幾何無從取得 → passthrough（與 FUZZY_JOIN 的「不猜鍵」同一條原則）
	conn.query(compiler.generateSqlFromConfig("sp_none", "SPATIAL_MATCH",
		{ leftLonField: "", leftLatField: "" }, ["sp_pts", "sp_zones"]));
	add("SPATIAL_MATCH with no geometry source is a passthrough",
		q("SELECT city FROM sp_none ORDER BY city;"), [["HK"], ["SZ"], ["TK"]]);
	add("SPATIAL_MATCH passthrough adds no right-hand columns",
		schema("sp_none"), ["id", "city", "lon", "lat"]);

	// DWITHIN 的門檻與輸出欄位必須是同一個表達式。這條是實測踩出來的：
	// 第一版把 distanceUnit 只用在輸出欄位，門檻卻原值丟給 ST_DWithin，
	// 於是「100 公尺」被當成「100 度」—— 不會報錯，只是全部命中。
	const dwDeg = compiler.compileNodeSelect("sp_x", "SPATIAL_MATCH",
		{ leftLonField: "lon", leftLatField: "lat", rightLonField: "lon", rightLatField: "lat",
		  spatialPredicate: "DWITHIN", distance: 0.01, distanceUnit: "DEGREES" }, ["a", "b"]);
	const dwM = compiler.compileNodeSelect("sp_x", "SPATIAL_MATCH",
		{ leftLonField: "lon", leftLatField: "lat", rightLonField: "lon", rightLatField: "lat",
		  spatialPredicate: "DWITHIN", distance: 100, distanceUnit: "METERS" }, ["a", "b"]);
	add("DWITHIN in DEGREES compares against ST_Distance",
		dwDeg.includes("ST_Distance(") && dwDeg.includes("<= 0.01"), true);
	add("DWITHIN in METERS compares against ST_Distance_Sphere (not ST_DWithin with raw metres)",
		dwM.includes("ST_Distance_Sphere(") && dwM.includes("<= 100"), true);
	add("...and never passes a raw metre value to ST_DWithin",
		dwM.includes("ST_DWithin("), false);

	// 匯出的 SQL 腳本要真的跑得動 —— 前面只證明它「長得像對的」。
	const exporter = await loadTs("apps/web/src/engine/exporter.ts");
	const spCte = exporter.exportToSqlCte(
		[
			{ id: "node_l", data: { label: "L", type: "INPUT_DUCKDB", config: { fileName: "sp_pts.csv", tableName: "sp_pts" } } },
			{ id: "node_r", data: { label: "R", type: "INPUT_DUCKDB", config: { fileName: "sp_zones.csv", tableName: "sp_zones" } } },
			{ id: "node_j", data: { label: "J", type: "SPATIAL_MATCH", config: {
				leftLonField: "lon", leftLatField: "lat", rightGeometryField: "wkt" } } },
		],
		[
			{ id: "e1", source: "node_l", target: "node_j" },
			{ id: "e2", source: "node_r", target: "node_j" },
		],
	);
	let cteErr = "ok";
	try {
		conn.query(spCte.sql);
	} catch (err) {
		cteErr = "ERR: " + String(err.message).split("\n")[0].slice(0, 90);
	}
	add("the exported spatial CTE script actually runs", cteErr, "ok");

	// 對照組必須用**另一個 duckdb 實例**：LOAD 是載入到「資料庫實例」層級的，
	// 同一實例的新連線會共享已載入的擴充。第一版就是只在 bindings 上開新連線，
	// 於是拿掉 LOAD 也照樣成功 —— 對照組假通過，等於沒測。
	const cleanBindings = await duckdb.createDuckDB(
		BUNDLES, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
	await cleanBindings.instantiate();
	// 乾淨實例也要有同樣的來源表，否則對照組會因為「表不存在」而失敗，
	// 那又變成另一種假通過（錯的原因、對的結論）。
	const cleanConn = cleanBindings.connect();
	cleanConn.query(SP_PTS_DDL);
	cleanConn.query(SP_ZONES_DDL);
	let noLoadFailed = false;
	try {
		cleanConn.query(spCte.sql.replace("LOAD spatial;", ""));
	} catch {
		noLoadFailed = true;
	}
	add("without the LOAD preamble the same script fails on a clean instance",
		noLoadFailed, true);
	// 而同一個乾淨實例、加上 LOAD 就成功 —— 兩條一起才證明那句是必要的。
	let cleanOk = "ok";
	try {
		cleanConn.query(spCte.sql);
	} catch (err) {
		cleanOk = "ERR: " + String(err.message).split("\n")[0].slice(0, 90);
	}
	add("the same script succeeds on that clean instance once the LOAD is present",
		cleanOk, "ok");

	// =====================================================================
	// 12. 視窗 / 序列組：MULTI_ROW_FORMULA / RUNNING_TOTAL / RANK
	// =====================================================================
	conn.query(
		`CREATE OR REPLACE TABLE w_src AS SELECT * FROM (VALUES
			('HK', 1, 100), ('HK', 2, 200), ('HK', 3, 50),
			('TW', 1, 300), ('TW', 2, 300)
		) AS t(country, seq, amount);`,
	);

	// 12a. MULTI_ROW_FORMULA：LAG 取上一列
	const mrf = compiler.compileNodeSelect(
		"node_mrf", "MULTI_ROW_FORMULA",
		{ outputColumn: "prev_amount", expression: "LAG(amount, 1)",
			partitionBy: ["country"], orderBy: "seq" },
		["w_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_mrf AS ${mrf};`);
	add("MULTI_ROW_FORMULA partitions and orders",
		mrf.includes('PARTITION BY "country"') && mrf.includes('ORDER BY "seq"'), true);
	// 分區的第一列沒有上一列 → NULL；第二列拿到分區內前一列的值
	add("MULTI_ROW_FORMULA LAG looks at the previous row within the partition",
		q("SELECT seq, prev_amount FROM node_mrf WHERE country = 'HK' ORDER BY seq;"),
		[["1", "null"], ["2", "100"], ["3", "200"]]);
	// 關鍵：分區邊界不可跨區取到別國的值
	add("MULTI_ROW_FORMULA does not leak across partitions",
		q("SELECT prev_amount FROM node_mrf WHERE country = 'TW' AND seq = 1;"), [["null"]]);

	// 12a-2. 複合運算式：OVER 只綁定緊接在前的函數呼叫，所以必須逐個呼叫點插入。
	//        舊版在外層包一個 OVER（`(LAG(x,1) - x) OVER (…)`）會直接語法錯誤。
	const mrfCompound = compiler.compileNodeSelect(
		"node_mrf2", "MULTI_ROW_FORMULA",
		{ outputColumn: "delta", expression: "LAG(amount, 1) - amount",
			partitionBy: ["country"], orderBy: "seq" },
		["w_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_mrf2 AS ${mrfCompound};`);
	add("MULTI_ROW_FORMULA puts OVER on the function call, not the whole expression",
		mrfCompound.includes('LAG(amount, 1) OVER (PARTITION BY "country" ORDER BY "seq")'), true);
	add("MULTI_ROW_FORMULA compound expression computes the difference",
		q("SELECT seq, delta FROM node_mrf2 WHERE country = 'HK' ORDER BY seq;"),
		[["1", "null"], ["2", "-100"], ["3", "150"]]);
	// 使用者自己寫了 OVER → 不可以再插一次
	add("MULTI_ROW_FORMULA does not double up an explicit OVER",
		(compiler.compileNodeSelect("x", "MULTI_ROW_FORMULA",
			{ outputColumn: "d", expression: "LAG(amount, 1) OVER ()", orderBy: "seq" },
			["w_src"]).match(/OVER/g) || []).length, 1);
	// 非視窗函數不可被插 OVER（ROUND 不是視窗函數）
	add("MULTI_ROW_FORMULA leaves scalar functions alone",
		compiler.compileNodeSelect("x", "MULTI_ROW_FORMULA",
			{ outputColumn: "r", expression: "ROUND(amount, 1)", orderBy: "seq" },
			["w_src"]).includes("ROUND(amount, 1) OVER"), false);

	// 12b. RUNNING_TOTAL：累計（含 NULL 也必須與 SQL 語意一致）
	const running = compiler.compileNodeSelect(
		"node_rt", "RUNNING_TOTAL",
		{ target: "amount", outputColumn: "amount_running", partitionBy: ["country"], orderBy: "seq" },
		["w_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_rt AS ${running};`);
	add("RUNNING_TOTAL emits an explicit ROWS frame",
		running.includes("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW"), true);
	add("RUNNING_TOTAL accumulates in order",
		q("SELECT seq, amount_running FROM node_rt WHERE country = 'HK' ORDER BY seq;"),
		[["1", "100"], ["2", "300"], ["3", "350"]]);
	// 分區必須各自從頭累加（TW 第一列是 300 而不是 450）
	add("RUNNING_TOTAL restarts per partition",
		q("SELECT seq, amount_running FROM node_rt WHERE country = 'TW' ORDER BY seq;"),
		[["1", "300"], ["2", "600"]]);

	// 12c. RANK：三種排名方式在並列時的行為不同
	const rank = compiler.compileNodeSelect(
		"node_rk", "RANK",
		{ target: "amount", outputColumn: "amount_rank", method: "RANK",
			partitionBy: [], descending: true },
		["w_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_rk AS ${rank};`);
	add("RANK default is descending", rank.includes("ORDER BY \"amount\" DESC"), true);
	// 300, 300 並列第 1，下一個是第 3（RANK 會跳號）
	add("RANK skips numbers after a tie",
		q("SELECT amount, amount_rank FROM node_rk ORDER BY amount DESC, seq LIMIT 3;"),
		[["300", "1"], ["300", "1"], ["200", "3"]]);

	const dense = compiler.compileNodeSelect(
		"node_rk2", "RANK",
		{ target: "amount", outputColumn: "r", method: "DENSE_RANK", descending: true },
		["w_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_rk2 AS ${dense};`);
	add("DENSE_RANK does not skip numbers after a tie",
		q("SELECT amount, r FROM node_rk2 ORDER BY amount DESC, seq LIMIT 3;"),
		[["300", "1"], ["300", "1"], ["200", "2"]]);

	const rownum = compiler.compileNodeSelect(
		"node_rk3", "RANK",
		{ target: "amount", outputColumn: "rn", method: "ROW_NUMBER", descending: true },
		["w_src"]);
	conn.query(`CREATE OR REPLACE TABLE node_rk3 AS ${rownum};`);
	add("ROW_NUMBER never ties",
		q("SELECT rn FROM node_rk3 ORDER BY rn;"), [["1"], ["2"], ["3"], ["4"], ["5"]]);

	// 不合法的排名方式 → 白名單擋掉，退回 RANK
	add("RANK rejects a method outside the whitelist",
		compiler.compileNodeSelect("x", "RANK",
			{ target: "amount", method: "RANK() OVER (); DROP TABLE w_src; --" }, ["w_src"])
			.includes("DROP"), false);

	// =====================================================================
	// 13. 進階連接組：APPEND_FIELDS / FIND_REPLACE
	// =====================================================================
	conn.query("CREATE OR REPLACE TABLE j_left AS SELECT * FROM (VALUES (1, 'HK', 10), (2, 'TW', 20)) AS t(id, country, amount);");
	conn.query("CREATE OR REPLACE TABLE j_right AS SELECT * FROM (VALUES ('HK', 'Hong Kong'), ('TW', 'Taiwan')) AS t(code, label);");
	conn.query("CREATE OR REPLACE TABLE j_small AS SELECT * FROM (VALUES (1, 'x'), (2, 'y'), (3, 'z')) AS t(k, tag);");

	// 13a. APPEND_FIELDS：笛卡爾積
	const append = compiler.compileNodeSelect("node_ap", "APPEND_FIELDS", {}, ["j_left", "j_small"]);
	conn.query(`CREATE OR REPLACE TABLE node_ap AS ${append};`);
	add("APPEND_FIELDS emits a CROSS JOIN", append.includes("CROSS JOIN"), true);
	add("APPEND_FIELDS multiplies the row count (left × right)",
		q("SELECT COUNT(*) FROM node_ap;"), [["6"]]);
	add("APPEND_FIELDS carries both sides' columns",
		schema("node_ap"), ["id", "country", "amount", "k", "tag"]);
	// 缺右邊輸入時要有 raw_data 補位，不可產生語法錯誤的 SQL
	add("APPEND_FIELDS falls back to raw_data when the right input is missing",
		compiler.compileNodeSelect("x", "APPEND_FIELDS", {}, ["j_left"]).includes('CROSS JOIN "raw_data"'), true);

	// 13b. FIND_REPLACE：只帶回一個值欄位
	const findReplace = compiler.compileNodeSelect(
		"node_fr", "FIND_REPLACE",
		{ findField: "country", lookupField: "code", replaceField: "label",
			outputColumn: "", unmatched: "KEEP" },
		["j_left", "j_right"]);
	conn.query(`CREATE OR REPLACE TABLE node_fr AS ${findReplace};`);
	// 關鍵：不像 JOIN 會把右表全部欄位帶進來，這裡只有左表欄位
	add("FIND_REPLACE does not drag in the whole lookup table",
		schema("node_fr"), ["id", "country", "amount"]);
	add("FIND_REPLACE replaces the value in place",
		q("SELECT country FROM node_fr ORDER BY id;"), [["Hong Kong"], ["Taiwan"]]);

	// 未命中：KEEP 保留原值
	conn.query("CREATE OR REPLACE TABLE j_left2 AS SELECT * FROM (VALUES (1, 'HK'), (2, 'XX')) AS t(id, country);");
	const frKeep = compiler.compileNodeSelect(
		"node_fr2", "FIND_REPLACE",
		{ findField: "country", lookupField: "code", replaceField: "label", unmatched: "KEEP" },
		["j_left2", "j_right"]);
	conn.query(`CREATE OR REPLACE TABLE node_fr2 AS ${frKeep};`);
	add("FIND_REPLACE KEEP falls back to the original value",
		q("SELECT country FROM node_fr2 ORDER BY id;"), [["Hong Kong"], ["XX"]]);

	// 未命中：NULL 設為空值
	const frNull = compiler.compileNodeSelect(
		"node_fr3", "FIND_REPLACE",
		{ findField: "country", lookupField: "code", replaceField: "label", unmatched: "NULL" },
		["j_left2", "j_right"]);
	conn.query(`CREATE OR REPLACE TABLE node_fr3 AS ${frNull};`);
	add("FIND_REPLACE NULL blanks the unmatched value",
		q("SELECT country FROM node_fr3 ORDER BY id;"), [["Hong Kong"], ["null"]]);

	// 指定新欄位名 → 附加在最後，原本的來源鍵保留
	const frNewCol = compiler.compileNodeSelect(
		"node_fr4", "FIND_REPLACE",
		{ findField: "country", lookupField: "code", replaceField: "label", outputColumn: "country_name" },
		["j_left", "j_right"]);
	conn.query(`CREATE OR REPLACE TABLE node_fr4 AS ${frNewCol};`);
	add("FIND_REPLACE with a new output column keeps the source key",
		schema("node_fr4"), ["id", "country", "amount", "country_name"]);

	// 13c. 型別限制：KEEP 讓取回值與來源鍵共用一個 COALESCE，兩欄型別必須相容。
	//      這裡**刻意斷言它會大聲失敗** —— 我們選擇不擅自 CAST（一律轉 VARCHAR
	//      會讓「數字查數字」的替換也變成文字，那是更難察覺的錯）。
	//      DuckDB 沒有 `CAST(x AS typeof(y))`，靜態也拿不到欄位型別，
	//      所以無法在不犧牲正確性的前提下自動處理。
	let typeMismatch = null;
	try {
		conn.query(
			compiler.generateSqlFromConfig("node_fr5", "FIND_REPLACE",
				{ findField: "id", lookupField: "code", replaceField: "label" },
				["j_left", "j_right"], { falseBranch: false }),
		);
	} catch (err) {
		typeMismatch = /COALESCE/.test(String(err.message));
	}
	add("FIND_REPLACE fails loudly (not silently) on incompatible key/value types",
		typeMismatch, true);
	// 但型別相容時必須正常運作（這才是它存在的意義：代碼 → 名稱）
	const frCompatible = compiler.compileNodeSelect(
		"node_fr6", "FIND_REPLACE",
		{ findField: "country", lookupField: "code", replaceField: "label" },
		["j_left", "j_right"]);
	conn.query(`CREATE OR REPLACE TABLE node_fr6 AS ${frCompatible};`);
	add("FIND_REPLACE works when the key and the value share a type",
		q("SELECT country FROM node_fr6 ORDER BY id;"), [["Hong Kong"], ["Taiwan"]]);

	// =====================================================================
	// 14. 節點目錄一致性（drift guard）
	// =====================================================================
	// 這一節存在的理由：hermes.py 的能力清單曾經是手寫的，與 astCompiler 的
	// switch 各寫一份，最後漂移 —— 少了 SELECT / UNION / SAMPLE / RENAME，
	// SUMMARIZE 的描述還停在舊格式。AI 因此產生不出那些節點，而且沒有任何
	// 測試會發現。以下斷言讓「新增節點卻忘了同步」變成紅燈。
	const catalog = await loadTs("apps/web/src/engine/nodeCatalog.ts");
	const catalogTypes = [...catalog.NODE_TYPES].sort();

	// 14a. 目錄的鍵集合 == 編譯器 switch 的 case 集合
	//
	// 注意：不能靠「呼叫 compileNodeSelect 看有沒有拋錯」來判斷 —— 那個 switch
	// 有 default 分支，任何未知型別都會回一句 passthrough SQL，看起來一切正常。
	// 這正是漂移最危險的形態。所以直接解析原始碼裡的 case 標籤。
	const casesIn = (relPath, scope) => {
		const src = readFileSync(join(root, relPath), "utf8");
		let region = src;
		if (scope) {
			// 只掃某個函式的內容。exportPolars 的 filterExprToPolars 也有
			// `case "IS":` 之類的運算子分支，全檔掃會把它們當成節點型別。
			const start = src.indexOf(scope);
			if (start < 0) return [];
			// 由起始括號開始做括號配對，抓出整個函式本體
			const open = src.indexOf("{", start);
			let depth = 0;
			let end = open;
			for (let i = open; i < src.length; i++) {
				if (src[i] === "{") depth++;
				else if (src[i] === "}") {
					depth--;
					if (depth === 0) {
						end = i;
						break;
					}
				}
			}
			region = src.slice(start, end + 1);
		}
		return [...region.matchAll(/case\s+"([A-Z_]+)":/g)].map((m) => m[1]).sort();
	};

	const compilerCases = casesIn("apps/web/src/engine/astCompiler.ts");
	add("the compiler switch covers exactly the catalogued types",
		compilerCases, catalogTypes);

	// 匯出器也必須涵蓋全部型別（漏掉的話匯出的 Polars 會靜默 passthrough）。
	// VIZ_CHART 例外：它是純檢視節點，不產生資料，在 exportToPolars 的開頭
	// 就被 skipped 掉了，所以不會出現在 emitNode 的 switch 裡。
	const polarsCases = casesIn("apps/web/src/engine/exportPolars.ts", "function emitNode(");
	const expectedPolarsCases = catalogTypes.filter((t) => compiler.producesOutputTable(t));
	add("the Polars exporter covers exactly the data-producing types",
		polarsCases, expectedPolarsCases);
	add("VIZ_CHART is the only type that produces no output table",
		catalogTypes.filter((t) => !compiler.producesOutputTable(t)), ["VIZ_CHART"]);

	// 14b. 每個型別都要能對「欄位齊全的表」產生可執行的 SQL。
	//
	// 這張 probe_src 刻意包含所有節點預設 config 會引用到的欄位名
	// （目錄裡的 defaults）。少了任何一個，節點就會在 binder 階段失敗 ——
	// 那其實是在抱怨「這張表沒有那個欄位」，不是編譯器有問題。
	conn.query(
		`CREATE OR REPLACE TABLE probe_src AS SELECT * FROM (VALUES
			(1, 2024, 'HK', 'a', 100, 1, 'name1', 'x,y', 'C1', 'Label One', 114.1, 22.3),
			(2, 2025, 'TW', 'b', 200, 2, 'name2', 'z', 'C2', 'Label Two', 121.5, 25.0)
		) AS t(id, year, country, category, amount, seq, name, raw, code, label, lon, lat);`,
	);
	const probeUpstream = ["probe_src", "probe_src"];

	const unsupported = [];
	for (const t of catalogTypes) {
		try {
			conn.query(
				compiler.generateSqlFromConfig("probe_node", t, {}, probeUpstream, { falseBranch: false }),
			);
		} catch (err) {
			unsupported.push(`${t}: ${String(err.message).slice(0, 80)}`);
		}
	}
	add("every catalogued node type produces SQL the real engine accepts", unsupported, []);

	// 14c. 目錄的輸入埠數與 resolveSourceTables 的行為一致
	//      （inputs >= 2 的節點必須拿得到兩個上游）
	const twoInput = catalogTypes.filter((t) => catalog.NODE_CATALOG[t].inputs === 2);
	add("catalog declares exactly the dual-input nodes", twoInput.sort(),
		["APPEND_FIELDS", "FIND_REPLACE", "FUZZY_JOIN", "JOIN", "SPATIAL_MATCH"]);
	for (const t of twoInput) {
		add(`${t} resolves two upstream tables`,
			compiler.resolveSourceTables("x", t, [
				{ source: "a", target: "x" },
				{ source: "b", target: "x" },
			]),
			["a", "b"]);
	}
	const manyInput = catalogTypes.filter((t) => catalog.NODE_CATALOG[t].inputs === -1);
	add("catalog declares exactly the unbounded-input nodes", manyInput.sort(), ["UNION"]);

	// 14d. 每個 config 欄位都必須真的被編譯器讀到
	//      （防「目錄寫了欄位、但編譯器根本沒用它」的半套實作）
	//
	// enum 要餵「合法的另一個值」，不能餵亂字串 —— 餵亂字串會被白名單擋掉、
	// 退回預設值，於是產出的 SQL 與預設相同，看起來像「沒讀 config」，
	// 其實是探針本身沒有真的改變輸入（UNION 就踩過這個坑）。
	const unusedFields = [];
	for (const t of catalogTypes) {
		const spec = catalog.NODE_CATALOG[t];
		if (spec.fields.length === 0) continue;
		// VIZ_CHART 是純檢視節點：它的 config 決定圖表怎麼畫，不影響 SQL。
		if (t === "VIZ_CHART") continue;

		const probeConfig = {};
		for (const f of spec.fields) {
			if (f.kind === "enum") {
				const values = f.values || [];
				// 取最後一個（與 default 不同的合法值）
				probeConfig[f.name] = values[values.length - 1] ?? "zz_probe";
				continue;
			}
			// text 欄位優先用目錄宣告的預設值，沒有的話才用合成值。
			//
			// 為什麼：有些 text 欄位是「模板」而不是普通字串。MULTI_FIELD_FORMULA
			// 的 expression 需要內含 `_CurrentField_`，餵 `zz_probe_col` 會讓它
			// 走「沒有佔位符 → passthrough」那條路，於是產出與空 config 相同，
			// 這條守門就誤判成「編譯器沒讀這個欄位」。用目錄自己的預設值當探針，
			// 等於讓每個節點用它自己認可的合法輸入被測試。
			if (f.kind === "text" && typeof f.default === "string" && f.default !== "") {
				probeConfig[f.name] = f.default;
				continue;
			}
			probeConfig[f.name] =
				f.kind === "fieldList" || f.kind === "textList"
					? ["zz_probe_col"]
					: f.kind === "number"
						? 4242
						: f.kind === "boolean"
							? true
							: f.kind === "aggList"
								? [{ func: "MAX", target: "zz_probe_col" }]
								: f.kind === "pairList"
									? [{ from: "zz_probe_col", to: "zz_renamed" }]
									: "zz_probe_col";
		}
		const withConfig = compiler.compileNodeSelect("probe_node", t, probeConfig, probeUpstream);
		const bare = compiler.compileNodeSelect("probe_node", t, {}, probeUpstream);
		if (withConfig === bare) unusedFields.push(t);
	}
	add("every node type actually reads at least one of its declared config fields",
		unusedFields, []);

	// 14e. Palette 用到的 icon 名稱都必須存在（否則面板會靜默 fallback 成 Table）
	//
	// 同樣用原始碼解析而不是 import Palette.tsx —— 它是 React 元件，
	// 在 Node 裡 bundle 它會把 react / lucide-react 一起拉進來，既慢又脆弱。
	const paletteSrc = readFileSync(
		join(root, "apps/web/src/components/workbench/Palette.tsx"),
		"utf8",
	);
	const iconsBlock = /const ICONS[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(paletteSrc);
	const iconNames = iconsBlock
		? [...iconsBlock[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*,?\s*$/gm)].map((m) => m[1])
		: [];
	add("the palette declares an icon map", iconNames.length > 0, true);

	const missingIcons = catalogTypes
		.map((t) => catalog.NODE_CATALOG[t].icon)
		.filter((name) => !iconNames.includes(name));
	add("every catalogued icon exists in the palette's icon map", missingIcons, []);

	// 14f. defaultConfigFor 必須產生「真的能跑」的初始 config
	//      （拖進畫布就能執行，而不是一放上去就報錯）
	const badDefaults = [];
	for (const t of catalogTypes) {
		const defaults = catalog.defaultConfigFor(t);
		try {
			conn.query(
				compiler.generateSqlFromConfig("probe_node", t, defaults, probeUpstream, { falseBranch: false }),
			);
		} catch (err) {
			badDefaults.push(`${t}: ${String(err.message).slice(0, 80)}`);
		}
	}
	add("every node's default config produces runnable SQL", badDefaults, []);

	// 14g. normalizeConfig 必須清掉幻覺欄位、補上預設值。
	//      預設有兩層（spec.defaults 與逐欄位 default），**兩層都要吃** ——
	//      只吃逐欄位那一層曾讓 FILTER 的 val 在 Hermes 路徑上消失，
	//      於是表單顯示空白、SQL 卻用 1000（見 nodeCatalog.ts 的註解）。
	add("normalizeConfig drops hallucinated keys",
		Object.keys(catalog.normalizeConfig("FILTER", { field: "x", groupby: "y", bogus: 1 })).sort(),
		["field", "op", "val"]);
	add("normalizeConfig keeps the values the model did supply",
		catalog.normalizeConfig("FILTER", { field: "x", op: "<" }),
		{ field: "x", op: "<", val: "1000" });
	add("normalizeConfig fills the declared defaults",
		catalog.normalizeConfig("SAMPLE", {}),
		{ sampleMode: "FIRST", sampleSize: 100 });
	// spec.defaults 的鍵必須都是已宣告的欄位，否則第 1 層會靜默漏掉它
	add("no catalogue node has an orphan default key", catalog.orphanDefaultKeys(), []);
	// 兩條 config 產生路徑必須完全一致：Palette 拖放走 defaultConfigFor()，
	// Hermes patch 走 normalizeConfig(type, {})。若兩者分歧，同一個節點
	// 「用拖的」與「用講的」會得到不同的起始 config —— 那正是先前
	// FILTER.val 在 Hermes 路徑上消失的原因。
	add("defaultConfigFor agrees with normalizeConfig for every type",
		catalog.NODE_TYPES.filter((t) =>
			JSON.stringify(catalog.defaultConfigFor(t)) !==
			JSON.stringify(catalog.normalizeConfig(t, {}))),
		[]);
	// 未知型別不可拋錯（舊存檔可能有已移除的型別）
	add("normalizeConfig tolerates an unknown type", catalog.normalizeConfig("NOPE", { a: 1 }), {});

	// =====================================================================
	// 15. 端到端：自然語言 → fallback patch → 畫布 → SQL → 真實引擎
	// =====================================================================
	// 前面各節證明「編譯器懂每一個工具」，第 10 節證明「hermes.py 知道有哪些工具」。
	// 這一節證明**使用者講一句話，東西真的跑得動**。
	//
	// LLM 離線時 hermes 會產生決定性 fallback patch，而那份 patch 的 config 是
	// 手寫的字串（欄位名、聚合函式、分隔符號）—— 從來沒有被任何引擎執行過。
	// 「節點類型對」與「SQL 跑得動」是兩件不同的事，這裡把整條路走完：
	//   prompt → _fallback_ast_patch → _validate_ast_patch
	//          → patch.ts resolveAstPatch → exporter.exportToSqlCte → duckdb-wasm
	if (fallbackPipelines.length) {
		const patchMod = await loadTs("apps/web/src/engine/patch.ts");
		const exporterMod = await loadTs("apps/web/src/engine/exporter.ts");

		// fallback 的 config 會引用這些欄位。INPUT_DUCKDB 沒有 fileName 時讀 raw_data。
		// 刻意放入重複列（UNIQUE 才有事可做）與 NULL（IMPUTE / TEXT_TO_COLUMNS 才不會空轉）。
		conn.query(
			`CREATE OR REPLACE TABLE raw_data AS SELECT * FROM (VALUES
				(1, 1200, 2024, 'a', 'x,1'),
				(1, 1200, 2024, 'a', 'x,1'),
				(2, NULL, 2024, 'b', 'y,2'),
				(3,  800, 2025, 'a', 'z,3'),
				(4, 2500, 2025, 'b', NULL)
			) AS t(id, amount, year, category, item);`,
		);

		let idSeq = 0;
		const failures = [];
		const zeroRows = [];
		let executed = 0;

		for (const pipe of fallbackPipelines) {
			const resolved = patchMod.resolveAstPatch(pipe, [], () => `node_fb${++idSeq}`);
			const cNodes = resolved.nodes.map((n) => ({
				id: n.newNodeId,
				type: n.flowNodeType,
				data: { type: n.nodeType, label: n.label, config: n.config },
			}));
			const cEdges = resolved.edges.map((e, i) => ({
				id: `efb${i}`,
				source: e.source,
				target: e.target,
				targetHandle: e.targetHandle,
			}));

			const cte = exporterMod.exportToSqlCte(cNodes, cEdges);
			if (!cte || !cte.sql) {
				failures.push(`${pipe.prompt}: exporter produced no SQL`);
				continue;
			}
			try {
				const rows = conn.query(cte.sql).toArray();
				executed += 1;
				if (rows.length === 0) zeroRows.push(pipe.prompt);
			} catch (err) {
				failures.push(`${pipe.prompt}: ${String(err?.message || err).slice(0, 150)}`);
			}
		}

		add(
			`every fallback pipeline executes on the real engine (${executed}/${fallbackPipelines.length})`,
			failures,
			[],
		);
		add("no fallback pipeline returns zero rows", zeroRows, []);

		// 抽查一個具體數字，確認不只是「有跑完」而是「算對」。
		// 'dedupe the rows' → UNIQUE(columns=[]) → SELECT DISTINCT * 收掉重複列，
		// 而 fixture 有 5 列、其中 2 列完全相同 → 應該剩 4 列。
		// 用 `CREATE TABLE AS <整條 CTE>` 取值：這同時也證明匯出結果可組合。
		{
			const pipe = fallbackPipelines.find((p) => p.prompt === "dedupe the rows");
			if (pipe) {
				// 每個節點都要拿到**不同**的 id，否則 CTE 名稱重複 → Parser Error
				let spotSeq = 0;
				const resolved = patchMod.resolveAstPatch(pipe, [], () => `node_spot${++spotSeq}`);
				const cNodes = resolved.nodes.map((n) => ({
					id: n.newNodeId,
					type: n.flowNodeType,
					data: { type: n.nodeType, label: n.label, config: n.config },
				}));
				const cte = exporterMod.exportToSqlCte(cNodes, []);
				let count = "ERROR";
				try {
					conn.query(`CREATE OR REPLACE TABLE t15 AS ${cte.sql}`);
					count = q("SELECT count(*) AS n FROM t15;")[0][0];
				} catch (err) {
					count = String(err?.message || err).slice(0, 120);
				}
				add("fallback UNIQUE really drops the duplicated row", count, "4");
			}
		}
	}

	return results;
}
