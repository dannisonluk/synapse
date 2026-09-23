// apps/web/src/engine/exportDbt.ts
//
// 把工作流匯出成一個 dbt 專案。
//
// 為什麼值得做：這個工具的價值之一是「畫完之後可以帶走」。目前能帶走的是
// 一段 SQL 或一個 Polars 腳本，兩者都是**單一檔案** —— 拿進團隊就得自己拆成
// 模型、自己補測試、自己接上游。而 dbt 剛好是這些團隊在用的東西。
//
// 與 ASSERT 的綜效是這個功能最大的理由：ASSERT 的四種檢查可以直接變成 dbt 的
// tests（兩種是內建 test，兩種是 singular test），於是在畫布上守的規則，
// 匯出之後**還在守**，而不是變成一條註解。
//
// 對應關係：
//   節點            → models/<name>.sql（`{{ ref() }}` 接上游）
//   INPUT_DUCKDB    → sources（外部檔案不是工作流產生的，不該假裝是 model）
//   ASSERT NOT_NULL → schema.yml 的 not_null test
//   ASSERT UNIQUE   → schema.yml 的 unique test（單欄）／singular test（組合鍵）
//   ASSERT PREDICATE/ROW_COUNT → tests/assert_*.sql（singular test）
//   VIZ_CHART       → 跳過（不是模型）
//
// 本檔案只 import engine 模組，可以在 Node 裡直接測。

import type { Edge, Node } from "@xyflow/react";
import { compileNodeSelect, assertPredicateNegation, assertRowCountBreach } from "./astCompiler";
import { orderUpstreamSources, topologicalSort } from "./scheduler";
import { safeAssertCheck, safeAssertLabel } from "./sql";
import { narrateNode } from "./narrate";

export interface DbtProject {
	/** 相對路徑 → 檔案內容。呼叫端負責打包成 zip 或逐檔下載 */
	files: Record<string, string>;
	/** 需要人工處理的地方（會寫進 README 與回傳值） */
	notes: string[];
	/** 無法自動轉換的節點 id */
	needsReview: string[];
}

/** dbt 的模型名稱必須是 `[A-Za-z_][A-Za-z0-9_]*` */
export function sanitiseModelName(label: unknown, fallback: string): string {
	const s = String(label ?? "")
		.trim()
		.toLowerCase()
		// 非 ASCII（含中文）一律換成底線 —— dbt 的模型名不接受它們
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		// 不可以數字開頭
		.replace(/^([0-9])/, "_$1");
	return s || fallback;
}

/**
 * 為每個節點決定模型名稱。
 *
 * 優先用人看得懂的名字（label），但**必須唯一**：兩個節點都叫「Filter」時，
 * 第二個退回用 id。這比「一律用 id」可讀，也比「一律用 label」安全 ——
 * 重名會讓 `{{ ref() }}` 指向錯的模型，而 dbt 不一定會報錯。
 */
export function assignModelNames(
	nodes: readonly Node[],
): { byId: Map<string, string>; taken: Set<string> } {
	const byId = new Map<string, string>();
	const taken = new Set<string>();

	for (const n of nodes) {
		const id = n.id;
		const label = (n.data as any)?.label;
		let name = sanitiseModelName(label, id);
		if (taken.has(name)) name = sanitiseModelName(`${label ?? ""}_${id}`, id);
		if (taken.has(name)) name = id;
		// 極端情況：連 id 都撞（不該發生）→ 加序號
		let k = 2;
		while (taken.has(name)) name = `${id}_${k++}`;
		taken.add(name);
		byId.set(id, name);
	}
	return { byId, taken };
}

/**
 * 把編譯出來的 SQL 裡的上游表名換成 `{{ ref('…') }}`。
 *
 * 只換 `FROM "x"` / `JOIN "x"` 這種位置，不做全域字串替換 —— 欄位名有可能
 * 剛好等於某個節點 id（尤其是匯入的舊存檔），全域替換會把它一起改掉。
 */
export function toRefs(
	body: string,
	upstreamIds: readonly string[],
	byId: Map<string, string>,
): string {
	let out = body;
	for (const up of upstreamIds) {
		const model = byId.get(up);
		if (!model) continue;
		const re = new RegExp(`\\b(FROM|JOIN)\\s+"${up.replace(/"/g, '""')}"`, "g");
		out = out.replace(re, (_m, kw: string) => `${kw} {{ ref('${model}') }}`);
	}
	return out;
}

/** 產生 dbt_project.yml。名稱與 profile 用佔位值，使用者一定要改。 */
function dbtProjectYml(projectName: string): string {
	return `# 由 Synapse 產生。\n# project name 與 profile 是佔位值 —— 接上你自己的 dbt 設定。\nname: '${projectName}'\nversion: '1.0.0'\nconfig-version: 2\n\nprofile: '${projectName}'\n\nmodel-paths: ["models"]\ntest-paths: ["tests"]\n\nmodels:\n  ${projectName}:\n    +materialized: view\n`;
}

/** YAML 的單引號字串：內部的單引號要加倍 */
function yamlStr(value: unknown): string {
	return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/** singular test 的檔名（不含路徑）：dbt 只要求檔名唯一 */
function testFileName(model: string, label: string, n: number): string {
	const safe = sanitiseModelName(label, "check");
	return `assert_${model}_${safe}${n > 1 ? `_${n}` : ""}`;
}

export interface DbtOptions {
	/** 專案名稱（dbt_project.yml 的 name） */
	projectName?: string;
	/** sources 的來源名稱 */
	sourceName?: string;
}

export function exportToDbt(
	nodes: readonly Node[],
	edges: readonly Edge[],
	opts: DbtOptions = {},
): DbtProject {
	const projectName = sanitiseModelName(opts.projectName, "synapse_workflow");
	const sourceName = sanitiseModelName(opts.sourceName, "raw");

	const byIdNode = new Map(nodes.map((n) => [n.id, n]));
	const { byId } = assignModelNames(nodes);
	// scheduler 的函式簽名要 mutable 陣列，而這裡的參數是 readonly
	const edgeList = [...edges];

	// 拓撲序：模型的檔名順序不影響 dbt，但測試檔的編號要穩定
	const order =
		topologicalSort(nodes.map((n) => n.id), edgeList) ?? nodes.map((n) => n.id);

	const files: Record<string, string> = {};
	const notes: string[] = [];
	const needsReview: string[] = [];
	// model → { column → tests[] }
	const schemaTests: Record<string, { name: string; tests: string[] }[]> = {};
	const externalSources = new Set<string>();

	for (const id of order) {
		const node = byIdNode.get(id);
		if (!node) continue;
		const data: any = node.data || {};
		const type: string = data.type || "RAW_SQL";
		const model = byId.get(id) || id;

		// 檢視節點不是模型
		if (type === "VIZ_CHART") continue;

		const upstreamIds = orderUpstreamSources(id, edgeList);

		// 需要 DuckDB 擴充的節點：dbt 模型裡沒有地方放 `LOAD spatial`，
		// 所以誠實地標記出來，而不是產生一個跑不動的模型。
		if (type === "SPATIAL_MATCH") {
			needsReview.push(id);
			notes.push(
				`節點「${data.label || id}」是 SPATIAL_MATCH —— dbt 模型裡沒有地方放 \`LOAD spatial\`。請改用支援 spatial 的 DuckDB profile 或在 model 前加 pre-hook。`,
			);
		}

		let body: string;
		if (data.type) {
			body = toRefs(
				compileNodeSelect(id, type, data.config || {}, upstreamIds),
				upstreamIds,
				byId,
			);
		} else {
			// 使用者自己寫的 raw SQL 節點：沿用原句，但把表名換成 ref
			body = toRefs(String(data.sqlQuery ?? "select 1 as x"), upstreamIds, byId);
		}

		// 沒有上游 → 讀外部表。dbt 裡那是 source，不是 model。
		if (upstreamIds.length === 0) {
			const src =
				type === "INPUT_DUCKDB" && data.config?.fileName
					? data.config.tableName || `src_${id}`
					: "raw_data";
			externalSources.add(src);
			body = body.replace(
				new RegExp(`\\bFROM\\s+"${src.replace(/"/g, '""')}"`, "g"),
				`FROM {{ source('${sourceName}', '${src}') }}`,
			);
		}

		// 模型檔頭：人話說明 + 節點資訊。拿到專案的人不必回頭開畫布。
		const narration = narrateNode({
			type,
			config: (data.config || {}) as Record<string, unknown>,
			upstreamLabels: upstreamIds.map(
				(uid) => (byIdNode.get(uid)?.data as any)?.label || uid,
			),
		});
		files[`models/${model}.sql`] = `-- ${data.label || id}（${type}）\n-- ${narration}\n\n${body}\n`;

		// --- ASSERT → dbt tests ---
		if (type === "ASSERT") {
			const cfg = data.config || {};
			const check = safeAssertCheck(cfg.assertCheck);
			const label = safeAssertLabel(cfg.assertLabel, check);
			const ref = `{{ ref('${model}') }}`;

			if (check === "NOT_NULL" || check === "UNIQUE") {
				const cols = String(cfg.assertColumn ?? "")
					.split(",")
					.map((c) => c.trim())
					.filter(Boolean);
				const list = cols.length > 0 ? cols : ["id"];

				// 單欄 → dbt 內建 test（一行搞定，而且 dbt 會自動平行化）
				if (list.length === 1) {
					const entry = schemaTests[model] ?? (schemaTests[model] = []);
					let col = entry.find((c) => c.name === list[0]);
					if (!col) {
						col = { name: list[0], tests: [] };
						entry.push(col);
					}
					col.tests.push(check === "NOT_NULL" ? "not_null" : "unique");
				} else {
					// 組合鍵：`unique` test 只吃單欄，而 dbt_utils 的
					// unique_combination_of_columns 需要額外套件。
					// 產生 singular test 就不必替使用者決定要裝什麼。
					const key = list.join(", ");
					const q = list.map((c) => `"${c}"`).join(", ");
					files[`tests/${testFileName(model, label, 1)}.sql`] =
						`-- ASSERT ${label}：組合鍵（${key}）必須唯一\n-- dbt 的 singular test 回傳 0 列才算通過。\nselect ${q}, count(*) as n\nfrom ${ref}\ngroup by ${q}\nhaving count(*) > 1\nlimit 100\n`;
				}
			} else if (check === "PREDICATE") {
				// 條件與 DuckDB 的守門共用同一份（見 assertPredicateNegation）
				files[`tests/${testFileName(model, label, 1)}.sql`] =
					`-- ASSERT ${label}：述句「${cfg.assertPredicate ?? ""}」不得有任何一列為假\n-- 條件與畫布上的守門共用同一份推導，兩邊不會不一致。\n-- dbt 的 singular test 回傳 0 列才算通過。\nselect *\nfrom ${ref}\nwhere ${assertPredicateNegation(cfg)}\nlimit 100\n`;
			} else if (check === "ROW_COUNT") {
				const breach = assertRowCountBreach(cfg);
				if (breach) {
					files[`tests/${testFileName(model, label, 1)}.sql`] =
						`-- ASSERT ${label}：列數必須落在設定範圍內\nselect count(*) as n\nfrom ${ref}\nhaving ${breach}\n`;
				} else {
					notes.push(
						`節點「${data.label || id}」的 ASSERT 列數上下限都沒填 → 沒有產生任何 test（畫布上也不會檢查）。`,
					);
				}
			}
		}
	}

	// --- schema.yml：sources + 欄位測試 ---
	const yml: string[] = [
		"# 由 Synapse 產生。",
		"# sources 指向工作流**外部**的表 —— 它們不是這個專案產生的。",
		"",
	];
	if (externalSources.size > 0) {
		yml.push("sources:");
		yml.push(`  - name: ${sourceName}`);
		yml.push("    tables:");
		for (const s of [...externalSources].sort()) {
			yml.push(`      - name: ${yamlStr(s)}`);
		}
		yml.push("");
	}
	if (Object.keys(schemaTests).length > 0) {
		yml.push("models:");
		for (const [model, cols] of Object.entries(schemaTests)) {
			yml.push(`  - name: ${yamlStr(model)}`);
			yml.push("    columns:");
			for (const col of cols) {
				yml.push(`      - name: ${yamlStr(col.name)}`);
				yml.push("        tests:");
				for (const t of col.tests) yml.push(`          - ${t}`);
			}
		}
	}
	files["models/schema.yml"] = `${yml.join("\n")}\n`;
	files["dbt_project.yml"] = dbtProjectYml(projectName);

	if (externalSources.size > 0) {
		notes.push(
			`sources 指向外部表：${[...externalSources].sort().join("、")} —— 執行前要先用 dbt seed 或你自己的方式讓它們存在。`,
		);
	}
	notes.push(
		"dbt_project.yml 的 project name 與 profile 是佔位值，接上你自己的 dbt 設定即可。",
	);

	return { files, notes, needsReview };
}

/** 把專案攤平成一個可下載的 tar-like 文字（給「複製全部」用） */
export function projectToText(project: DbtProject): string {
	const parts: string[] = [];
	for (const [path, content] of Object.entries(project.files)) {
		parts.push(`===== ${path} =====\n${content}`);
	}
	return parts.join("\n");
}
