// apps/web/src/engine/exportPolars.ts
// Synapse 工作流 → Python (Polars) 腳本匯出。
//
// 為什麼要有這個：SQL CTE 匯出只能在 DuckDB 裡跑。要真的把 pipeline 帶進
// 使用者的 Python 環境（notebook、排程、CI），需要一個可執行的 Python 腳本。
//
// 設計原則：
//   - 與 SQL 匯出共用同一套節點語意（config → 運算式），不是重新發明一套。
//     因此同一張畫布匯出的 SQL 與 Polars 會做同一件事。
//   - 誠實原則：Polars 沒有 SQL 的完整表達力，無法自動翻譯的部分**不假裝**。
//     會產生一個可執行但有標記的佔位，並把節點 id 收進 `needsReview`。
//     寧可留下明確的 TODO，也不要產生看起來能跑但算錯的腳本。
//   - 本檔案不可 import React component（verify.mjs 會在 Node 直接 import）。
import type { Edge, Node } from "@xyflow/react";
import { orderUpstreamSources, topologicalSort } from "./scheduler";
import { resolveSourceTables, falseBranchTable } from "./astCompiler";
import { safeOp, safeFunc, safeJoinType, safeExpr, safeUnionMode, safeSampleMode, safeImputeMethod, safeRankMethod, safeUnmatched, safeRegexMode, regexPattern, safeMultiFieldOutputMode, safeNewFieldSuffix, hasCurrentField, applyCurrentField, safeSplitMode, intLit } from "./sql";

// ---------------------------------------------------------------------------
// Python literal / identifier
// ---------------------------------------------------------------------------

/** Python 字串字面值（escape 反斜線與雙引號） */
export function pyStr(value: unknown): string {
	return `"${String(value ?? "")
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")}"`;
}

/** Python 數值 / 布林 / None 字面值；判斷規則與 sql.ts 的 lit() 保持一致 */
export function pyLiteral(value: unknown): string {
	const t = String(value ?? "").trim();
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return t;
	if (/^true$/i.test(t)) return "True";
	if (/^false$/i.test(t)) return "False";
	if (/^null$/i.test(t)) return "None";
	return pyStr(t);
}

// ---------------------------------------------------------------------------
// SQL 運算式 → Polars 運算式（保守翻譯）
// ---------------------------------------------------------------------------

type Token =
	| { kind: "num"; text: string }
	| { kind: "str"; text: string }
	| { kind: "ident"; text: string }
	| { kind: "op"; text: string }
	| { kind: "ws"; text: string };

/** SQL 函數 → Polars 方法鏈。不在表內的一律拒絕（不猜）。 */
const POLARS_FUNCS: Record<string, (args: string[]) => string> = {
	ABS: (a) => `(${a[0]}).abs()`,
	CEIL: (a) => `(${a[0]}).ceil()`,
	FLOOR: (a) => `(${a[0]}).floor()`,
	SQRT: (a) => `(${a[0]}).sqrt()`,
	ROUND: (a) => (a.length > 1 ? `(${a[0]}).round(${a[1]})` : `(${a[0]}).round()`),
	UPPER: (a) => `(${a[0]}).str.to_uppercase()`,
	LOWER: (a) => `(${a[0]}).str.to_lowercase()`,
	LENGTH: (a) => `(${a[0]}).str.len_chars()`,
	TRIM: (a) => `(${a[0]}).str.strip_chars()`,
	// COALESCE 是 n 元的；fill_null 串起來語意相同
	COALESCE: (a) => a.reduce((acc, cur) => `${acc}.fill_null(${cur})`),
	// 跨列函數：MULTI_ROW_FORMULA 的主力（會再被 .over(...) 包住）
	LAG: (a) => (a.length > 1 ? `(${a[0]}).shift(${a[1]})` : `(${a[0]}).shift(1)`),
	LEAD: (a) => (a.length > 1 ? `(${a[0]}).shift(-(${a[1]}))` : `(${a[0]}).shift(-1)`),
};

/**
 * SQL 關鍵字：出現就放棄翻譯。
 * 這些要靠運算子優先級 / 括號重建才正確（`a > 1 AND b < 2` 在 Polars 需要
 * `(a > 1) & (b < 2)`），用字串替換硬做一定會錯 → 交給人工。
 */
const REJECT_KEYWORDS = new Set([
	"AND", "OR", "NOT", "CASE", "WHEN", "THEN", "ELSE", "END",
	"CAST", "AS", "DISTINCT", "IN", "IS", "BETWEEN", "LIKE", "ILIKE",
	"EXISTS", "SELECT", "FROM", "OVER", "PARTITION", "BY", "TRY_CAST",
]);

function tokenizeExpr(src: string): Token[] | null {
	const toks: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			// 空白原樣保留 —— 產生的腳本要給人看，`a*b` 比 `a * b` 難讀
			let j = i;
			while (j < src.length && /\s/.test(src[j])) j++;
			toks.push({ kind: "ws", text: src.slice(i, j) });
			i = j;
			continue;
		}
		if (c === "'") {
			// SQL 字串：'' 代表一個單引號
			let j = i + 1;
			let out = "";
			let closed = false;
			while (j < src.length) {
				if (src[j] === "'") {
					if (src[j + 1] === "'") {
						out += "'";
						j += 2;
						continue;
					}
					closed = true;
					break;
				}
				out += src[j++];
			}
			if (!closed) return null;
			toks.push({ kind: "str", text: out });
			i = j + 1;
			continue;
		}
		if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
			const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
			if (!m) return null;
			toks.push({ kind: "num", text: m[0] });
			i += m[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_]\w*/.exec(src.slice(i));
			if (!m) return null;
			toks.push({ kind: "ident", text: m[0] });
			i += m[0].length;
			continue;
		}
		if ("+-*/%(),".includes(c)) {
			toks.push({ kind: "op", text: c });
			i++;
			continue;
		}
		return null; // 不認得的字元（`;`、`::`、`||`…）→ 放棄
	}
	return toks;
}

/**
 * 翻譯一個 scalar SQL 運算式成 Polars。
 * 回傳 null = 無法可靠翻譯（呼叫方要標記 needsReview）。
 */
export function translateExprToPolars(src: string): string | null {
	const toks = tokenizeExpr(src);
	if (!toks || toks.length === 0) return null;
	let i = 0;

	const parse = (): string | null => {
		let out = "";
		while (i < toks.length) {
			const t = toks[i];
			// `)` / `,` 不消耗，交回呼叫方決定（函數參數 / 括號群組的結尾）
			if (t.kind === "op" && (t.text === ")" || t.text === ",")) return out;

			if (t.kind === "ws") {
				out += t.text;
				i++;
				continue;
			}
			if (t.kind === "num") {
				out += t.text;
				i++;
				continue;
			}
			if (t.kind === "str") {
				out += pyStr(t.text);
				i++;
				continue;
			}

			// 括號群組：必須自己配對消耗，否則頂層的 `(a + b) / 2`
			// 會在第一個 `)` 就被當成結束 → 整個運算式被誤判成無法翻譯
			if (t.kind === "op" && t.text === "(") {
				i++; // 吃掉 (
				const inner = parse();
				if (inner === null) return null;
				if (!(toks[i]?.kind === "op" && toks[i].text === ")")) return null;
				i++; // 吃掉 )
				out += `(${inner})`;
				continue;
			}

			if (t.kind === "op") {
				out += t.text;
				i++;
				continue;
			}

			// ident
			const upper = t.text.toUpperCase();
			if (upper === "NULL") {
				out += "None";
				i++;
				continue;
			}
			if (upper === "TRUE") {
				out += "True";
				i++;
				continue;
			}
			if (upper === "FALSE") {
				out += "False";
				i++;
				continue;
			}

			// 函數呼叫：識別字後面（可含空白）緊接 `(`
			let k = i + 1;
			while (toks[k]?.kind === "ws") k++;
			const isCall = toks[k]?.kind === "op" && toks[k].text === "(";

			if (isCall) {
				const fn = POLARS_FUNCS[upper];
				if (!fn) return null;
				i = k + 1; // 跳到 ( 之後
				const args: string[] = [];
				while (true) {
					const arg = parse();
					if (arg === null) return null;
					args.push(arg);
					if (toks[i]?.kind === "op" && toks[i].text === ",") {
						i++;
						continue;
					}
					break;
				}
				if (!(toks[i]?.kind === "op" && toks[i].text === ")")) return null;
				i++; // 吃掉 )
				// 參數的空白不影響語意，trim 掉才不會產生 `( x )` 這種雜訊
				const clean = args.map((a) => a.trim()).filter((a) => a !== "");
				out += fn(clean);
				continue;
			}

			if (REJECT_KEYWORDS.has(upper)) return null;
			out += `pl.col(${pyStr(t.text)})`;
			i++;
		}
		return out;
	};

	const result = parse();
	if (result === null || i !== toks.length || result.trim() === "") return null;
	return result;
}

// ---------------------------------------------------------------------------
// 節點 → Polars 陳述式
// ---------------------------------------------------------------------------

interface EmitCtx {
	/** 這一步是否無法完整翻譯（會寫進 needsReview） */
	needsReview: boolean;
	/** 需要人工注意的說明，會以註解寫在腳本裡 */
	notes: string[];
}

/** 把 config 裡可能是 string / string[] / undefined 的欄位清單正規化成 string[] */
function nameList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((v) => String(v ?? "").trim()).filter(Boolean);
	}
	const s = String(value ?? "").trim();
	return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * Polars 的 `.over(...)` 子句。
 * partitionBy 為空時不產生 over（整個表就是一個分區），
 * 只有 order_by 時也要保留（累計 / 位移都需要明確順序）。
 */
function polarsOver(config: any, opts: { orderBy?: string } = {}): string {
	const parts = nameList(config?.partitionBy);
	const orderBy = String(opts.orderBy ?? config?.orderBy ?? "").trim();
	const args: string[] = [];
	if (parts.length > 0) args.push(`[${parts.map(pyStr).join(", ")}]`);
	if (orderBy) args.push(`order_by=${pyStr(orderBy)}`);
	return args.length > 0 ? `.over(${args.join(", ")})` : "";
}

/** CROSS_TAB 的聚合函數名 → Polars pivot 的 aggregate_function */
const PIVOT_AGG: Record<string, string> = {
	SUM: "sum",
	AVG: "mean",
	COUNT: "len",
	MIN: "min",
	MAX: "max",
	FIRST: "first",
};

/** RANK 的排名方式 → Polars rank 的 method */
const RANK_METHOD: Record<string, string> = {
	RANK: "min",
	DENSE_RANK: "dense",
	ROW_NUMBER: "ordinal",
};

/** 聚合函數 → Polars 表達式（作用在 pl.col(target) 上） */
function aggExprToPolars(func: string, target: string, alias: string): string | null {
	const col = `pl.col(${pyStr(target)})`;
	const aliasPart = `.alias(${pyStr(alias)})`;
	switch (safeFunc(func, "SUM")) {
		case "SUM":
			return `${col}.sum()${aliasPart}`;
		case "AVG":
			return `${col}.mean()${aliasPart}`;
		case "COUNT":
			return `${col}.count()${aliasPart}`;
		case "COUNT_DISTINCT":
			return `${col}.n_unique()${aliasPart}`;
		case "MIN":
			return `${col}.min()${aliasPart}`;
		case "MAX":
			return `${col}.max()${aliasPart}`;
		case "STDDEV":
			return `${col}.std()${aliasPart}`;
		case "MEDIAN":
			return `${col}.median()${aliasPart}`;
		case "ANY_VALUE":
			return `${col}.first()${aliasPart}`;
		default:
			return null;
	}
}

/** FILTER 條件 → Polars 布林表達式 */
function filterExprToPolars(
	config: { field?: string; op?: string; val?: string },
	ctx: EmitCtx,
): string {
	const field = config.field || "amount";
	const op = safeOp(config.op, ">");
	const val = config.val ?? "1000";
	const col = `pl.col(${pyStr(field)})`;

	switch (op) {
		case "=":
		case "==":
			return `${col} == ${pyLiteral(val)}`;
		case "!=":
		case "<>":
			return `${col} != ${pyLiteral(val)}`;
		case ">":
		case ">=":
		case "<":
		case "<=":
			return `${col} ${op} ${pyLiteral(val)}`;
		case "IS":
			return /^null$/i.test(val.trim()) ? `${col}.is_null()` : `${col} == ${pyLiteral(val)}`;
		case "IS NOT":
			return /^null$/i.test(val.trim()) ? `${col}.is_not_null()` : `${col} != ${pyLiteral(val)}`;
		case "LIKE":
		case "NOT LIKE": {
			// SQL 的 % → Polars 的 contains / starts_with / ends_with
			const pattern = String(val).trim();
			const negate = op === "NOT LIKE";
			let call: string;
			if (pattern.startsWith("%") && pattern.endsWith("%") && pattern.length > 2) {
				call = `${col}.str.contains(${pyStr(pattern.slice(1, -1))})`;
			} else if (pattern.endsWith("%") && pattern.length > 1) {
				call = `${col}.str.starts_with(${pyStr(pattern.slice(0, -1))})`;
			} else if (pattern.startsWith("%") && pattern.length > 1) {
				call = `${col}.str.ends_with(${pyStr(pattern.slice(1))})`;
			} else {
				ctx.notes.push(`LIKE 樣式 ${pyStr(pattern)} 沒有 % 萬用字元 → 已當成等值比較處理`);
				call = `${col} == ${pyStr(pattern)}`;
			}
			return negate ? `~(${call})` : call;
		}
		default:
			// ILIKE / NOT ILIKE：大小寫不敏感比對在 Polars 要明確轉小寫，
			// 這裡不猜，改成永遠不成立的條件並標記。
			ctx.needsReview = true;
			ctx.notes.push(`FILTER 運算子 ${op} 無法自動翻譯成 Polars → 條件暫以 False 佔位`);
			return "pl.lit(False)";
	}
}

/** 一個節點的 Polars 陳述式（不含結尾換行） */
function emitNode(
	id: string,
	type: string,
	config: any,
	upstream: string[],
	ctx: EmitCtx,
): string {
	const src = upstream[0] || "raw_data";

	switch (type) {
		case "INPUT_DUCKDB": {
			const fileName = String(config?.fileName || "");
			if (!fileName) {
				ctx.needsReview = true;
				ctx.notes.push(`節點 ${id} 尚未載入任何檔案 → 請自行指定資料來源`);
				return `# TODO: 這個 Input Data 節點尚未載入檔案，請改成實際的載入方式\n${id} = pl.DataFrame()`;
			}
			const reader = /\.parquet$/i.test(fileName) ? "read_parquet" : "read_csv";
			return `# ⚠ 請確認路徑正確（匯出時只知道原始檔名）\n${id} = pl.${reader}(${pyStr(fileName)})`;
		}

		case "FILTER": {
			const cond = filterExprToPolars(config || {}, ctx);
			const falseCond = filterExprToPolars(config || {}, ctx);
			return [
				`${id} = ${src}.filter(${cond})`,
				`# FILTER 的 false 分支（對應 SQL 的 ${falseBranchTable(id)}）`,
				`${falseBranchTable(id)} = ${src}.filter(~(${falseCond}))`,
			].join("\n");
		}

		case "FORMULA": {
			const outputCol = config?.outputColumn || "amount_taxed";
			const raw = safeExpr(config?.expression, "1");
			const translated = translateExprToPolars(raw);
			if (translated === null) {
				ctx.needsReview = true;
				ctx.notes.push(
					`節點 ${id} 的 FORMULA 運算式無法自動翻譯（${raw}）→ 已用 null 佔位，請手動改寫`,
				);
				return [
					`# TODO: 無法自動翻譯 SQL 運算式 → ${raw}`,
					`${id} = ${src}.with_columns(pl.lit(None).alias(${pyStr(outputCol)}))`,
				].join("\n");
			}
			return `${id} = ${src}.with_columns((${translated}).alias(${pyStr(outputCol)}))`;
		}

		case "SUMMARIZE": {
			// 分組鍵
			const g = config?.groupBy;
			let groups: string[];
			if (Array.isArray(g)) {
				groups = g.map((x: unknown) => String(x ?? "").trim()).filter(Boolean);
			} else {
				const s = String(g ?? "").trim();
				groups = s
					? s.split(",").map((x) => x.trim()).filter(Boolean)
					: ["year"];
			}

			// 聚合（新格式優先，空 → 舊格式單一組）
			const rawAggs = Array.isArray(config?.aggregations) ? config.aggregations : [];
			let aggs = rawAggs
				.map((a: any) => ({
					func: safeFunc(a?.func, "SUM"),
					target: String(a?.target ?? "").trim(),
				}))
				.filter((a: any) => a.target);
			if (aggs.length === 0) {
				aggs = [
					{
						func: safeFunc(config?.func, "SUM"),
						target: String(config?.target || "amount"),
					},
				];
			}

			const used = new Set<string>(groups);
			const unique = (base: string) => {
				let name = base;
				let n = 2;
				while (used.has(name)) name = `${base}_${n++}`;
				used.add(name);
				return name;
			};

			const aggParts: string[] = [];
			for (const a of aggs) {
				if (a.target === "*") {
					aggParts.push(`pl.len().alias(${pyStr(unique("count"))})`);
					continue;
				}
				const alias = unique(`${a.target}_${a.func.toLowerCase()}`);
				const expr = aggExprToPolars(a.func, a.target, alias);
				if (expr === null) {
					ctx.needsReview = true;
					ctx.notes.push(`節點 ${id} 的聚合函數 ${a.func} 無法翻譯 → 已略過`);
					continue;
				}
				aggParts.push(expr);
			}

			const groupPart =
				groups.length > 0
					? `.group_by([${groups.map((x) => pyStr(x)).join(", ")}])`
					: "";

			// 沒有分組鍵 → Polars 用 select 做整表聚合
			const head = groups.length > 0 ? `${src}${groupPart}.agg([` : `${src}.select([`;
			return [
				`${id} = (`,
				`    ${head}`,
				...aggParts.map((p) => `        ${p},`),
				`    ])`,
				`)`,
			].join("\n");
		}

		case "JOIN": {
			const left = upstream[0] || "raw_data";
			const right = upstream[1] || "raw_data";
			const how = safeJoinType(config?.joinType, "INNER").split(" ")[0].toLowerCase();
			const leftKey = config?.leftKey || "id";
			const rightKey = config?.rightKey || "id";
			ctx.notes.push(
				`節點 ${id}：Polars 的欄位衝突後綴已設成 "_1" 以對齊 DuckDB 的命名（Polars 預設是 "_right"）`,
			);
			return `${id} = ${left}.join(${right}, left_on=${pyStr(leftKey)}, right_on=${pyStr(rightKey)}, how=${pyStr(how)}, suffix="_1")`;
		}

		case "SORT": {
			const legacy = Array.isArray(config?.groupBy) ? config.groupBy[0] : config?.groupBy;
			const by = config?.field || legacy || "id";
			const desc = config?.descending ? "True" : "False";
			return `${id} = ${src}.sort(${pyStr(by)}, descending=${desc})`;
		}

		case "SELECT": {
			const cols = Array.isArray(config?.columns)
				? config.columns.map((c: unknown) => String(c ?? "").trim()).filter(Boolean)
				: [];
			if (cols.length === 0) return `${id} = ${src}  # 未選欄位 → 全選（passthrough）`;
			return `${id} = ${src}.select([${cols.map((c: string) => pyStr(c)).join(", ")}])`;
		}

		case "UNION": {
			const tables = upstream.length > 0 ? upstream : ["raw_data"];
			const byName = safeUnionMode(config?.unionMode, "BY_NAME") === "BY_NAME";
			// diagonal = 依欄位名對齊（缺欄補 null）；vertical = 依位置
			const how = byName ? "diagonal" : "vertical";
			return `${id} = pl.concat([${tables.join(", ")}], how=${pyStr(how)})`;
		}

		case "SAMPLE": {
			const n = intLit(config?.sampleSize, 100);
			if (safeSampleMode(config?.sampleMode, "FIRST") === "RANDOM") {
				return `${id} = ${src}.sample(${n}, seed=42)`;
			}
			return `${id} = ${src}.head(${n})`;
		}

		case "RENAME": {
			const raw = Array.isArray(config?.renames) ? config.renames : [];
			let pairs = raw
				.map((r: any) => ({
					from: String(r?.from ?? "").trim(),
					to: String(r?.to ?? "").trim(),
				}))
				.filter((r: any) => r.from && r.to && r.from !== r.to);
			if (pairs.length === 0) {
				const from = String(config?.field ?? "").trim();
				const to = String(config?.outputColumn ?? "").trim();
				pairs = from && to && from !== to ? [{ from, to }] : [];
			}
			if (pairs.length === 0) return `${id} = ${src}  # 未設定改名 → passthrough`;
			// SQL 端已改用 `* RENAME`，兩邊都會保留欄位原本位置，不再有差異
			const map = pairs
				.map((p: { from: string; to: string }) => `${pyStr(p.from)}: ${pyStr(p.to)}`)
				.join(", ");
			return `${id} = ${src}.rename({${map}})`;
		}

		// ---------------------------------------------------------------
		// 資料清理組
		// ---------------------------------------------------------------
		case "UNIQUE": {
			const keys = nameList(config?.columns);
			if (keys.length === 0) return `${id} = ${src}.unique()`;
			return `${id} = ${src}.unique(subset=[${keys.map(pyStr).join(", ")}], keep="first")`;
		}

		case "IMPUTE": {
			const cols = nameList(config?.columns);
			if (cols.length === 0) return `${id} = ${src}  # 未設定欄位 → passthrough`;
			const method = safeImputeMethod(config?.method, "CONSTANT");
			const parts = cols.map((c: string) =>
				method === "MEAN"
					? `pl.col(${pyStr(c)}).fill_null(pl.col(${pyStr(c)}).mean())`
					: `pl.col(${pyStr(c)}).fill_null(${pyLiteral(config?.fillValue ?? "0")})`,
			);
			return `${id} = ${src}.with_columns([${parts.join(", ")}])`;
		}

		case "DATA_CLEANSING": {
			const cols = nameList(config?.columns);
			if (cols.length === 0) return `${id} = ${src}  # 未設定欄位 → passthrough`;
			const collapse = config?.collapse === true;
			const trim = collapse || config?.trim !== false;
			const emptyToNull = config?.emptyToNull !== false;

			const parts = cols.map((c: string) => {
				let e = `pl.col(${pyStr(c)})`;
				if (collapse) e = `${e}.str.replace_all(r"\\s+", " ").str.strip_chars()`;
				else if (trim) e = `${e}.str.strip_chars()`;
				// replace("", None)：空字串轉空值（與 SQL 的 NULLIF(..., '') 一致）
				if (emptyToNull) e = `${e}.replace("", None)`;
				return e;
			});
			return `${id} = ${src}.with_columns([${parts.join(", ")}])`;
		}

		// ---------------------------------------------------------------
		// 樞紐 / 轉置組
		// ---------------------------------------------------------------
		case "CROSS_TAB": {
			const pivot = config?.pivotColumn || "category";
			const value = config?.valueColumn || "amount";
			const agg = PIVOT_AGG[safeFunc(config?.aggFunc, "SUM")] || "sum";
			const groups = nameList(config?.groupBy);
			// 實測差異（見 README 的 sharp edges）：展開欄為 NULL 時 DuckDB 直接
			// 丟掉那批列，Polars 會多出一個 "null" 欄；而缺組合 DuckDB 補 NULL、
			// Polars 的 sum 補 0。
			ctx.notes.push(
				`節點 ${id}：CROSS_TAB 在展開欄含 NULL 時，DuckDB 會丟掉那些列、` +
					`Polars 會多一個 "null" 欄；缺組合 DuckDB 補 NULL、Polars 補 0`,
			);
			const indexArg =
				groups.length > 0 ? `index=[${groups.map(pyStr).join(", ")}], ` : "";
			return `${id} = ${src}.pivot(on=${pyStr(pivot)}, ${indexArg}values=${pyStr(value)}, aggregate_function=${pyStr(agg)})`;
		}

		case "TRANSPOSE": {
			const cols = nameList(config?.columns);
			if (cols.length === 0) return `${id} = ${src}  # 未設定欄位 → passthrough`;
			const nameCol = config?.nameColumn || "metric";
			const valueCol = config?.valueColumn || "value";
			return `${id} = ${src}.unpivot(on=[${cols.map(pyStr).join(", ")}], variable_name=${pyStr(nameCol)}, value_name=${pyStr(valueCol)})`;
		}

		case "TEXT_TO_COLUMNS": {
			const field = config?.field || "name";
			const sep = String(config?.separator ?? ",");
			const names = nameList(config?.outputColumns);
			if (names.length === 0) return `${id} = ${src}  # 未設定輸出欄位 → passthrough`;
			// 實測：Polars 的 list.get 越界會直接拋 ComputeError，DuckDB 的
			// string_split(...)[n] 則是回 NULL。一定要帶 null_on_oob=True，
			// 否則欄位數不一致的資料會在 Polars 這邊炸掉而 SQL 那邊沒事。
			ctx.notes.push(
				`節點 ${id}：list.get 帶了 null_on_oob=True —— Polars 預設越界會拋錯，` +
					`DuckDB 的 string_split(...)[n] 則回 NULL`,
			);
			// 實測（Polars 1.44）：`str.split` 的 `by` 預設是**字面**比對，
			// 不是 regex。但這個預設值在 Polars 版本之間改過，所以兩種模式都把
			// literal 明寫出來 —— 依賴一個會變的預設值，等於把語意綁在版本上。
			const isRegex = safeSplitMode(config?.splitMode) === "REGEX";
			if (isRegex && !sep) return `${id} = ${src}  # 未設定樣式 → passthrough`;
			const splitExpr = isRegex
				? `pl.col(${pyStr(field)}).str.split(${pyStr(regexPattern(sep, config?.caseInsensitive))}, literal=False)`
				: `pl.col(${pyStr(field)}).str.split(${pyStr(sep)}, literal=True)`;
			const parts = names.map(
				(n: string, i: number) =>
					`${splitExpr}.list.get(${i}, null_on_oob=True).alias(${pyStr(n)})`,
			);
			return `${id} = ${src}.with_columns([${parts.join(", ")}])`;
		}

		case "REGEX": {
			const field = config?.field || "name";
			const rawPattern = String(config?.pattern ?? "");
			if (!rawPattern) return `${id} = ${src}  # 未設定樣式 → passthrough`;
			// 與 astCompiler 共用 regexPattern：忽略大小寫以 inline (?i) 表示，
			// 因為 Polars 的 str.extract / str.replace_all 根本沒有 case 參數。
			const pattern = pyStr(regexPattern(rawPattern, config?.caseInsensitive));
			const mode = safeRegexMode(config?.regexMode);

			if (mode === "PARSE") {
				const names = nameList(config?.outputColumns);
				if (names.length === 0) {
					return `${id} = ${src}  # 未設定擷取欄位 → passthrough`;
				}
				// 已實測的跨引擎差異：未命中時 DuckDB 的 regexp_extract 回**空字串**，
				// Polars 的 str.extract 回 null。SQL 那邊刻意不加 COALESCE ——
				// 「沒有命中」與「命中到空字串」本來就是不同的事，硬要統一會讓
				// SQL 那份也失去這個區分。這裡只記錄，不假裝兩邊一樣。
				ctx.notes.push(
					`節點 ${id}：未命中時 regexp_extract 回空字串、Polars 的 str.extract 回 null`,
				);
				const parts = names.map(
					(n: string, i: number) =>
						`pl.col(${pyStr(field)}).str.extract(${pattern}, group_index=${i + 1}).alias(${pyStr(n)})`,
				);
				return `${id} = ${src}.with_columns([${parts.join(", ")}])`;
			}

			if (mode === "REPLACE") {
				const out = config?.outputColumn || "regex_replaced";
				// replace_all 對應 SQL 的 regexp_replace(..., 'g')
				return (
					`${id} = ${src}.with_columns(` +
					`pl.col(${pyStr(field)}).str.replace_all(${pattern}, ` +
					`${pyStr(String(config?.replacement ?? ""))}).alias(${pyStr(out)}))`
				);
			}

			const out = config?.outputColumn || "regex_match";
			return (
				`${id} = ${src}.with_columns(` +
				`pl.col(${pyStr(field)}).str.contains(${pattern}).alias(${pyStr(out)}))`
			);
		}

		// ---------------------------------------------------------------
		// 視窗 / 序列組
		// ---------------------------------------------------------------
		case "MULTI_FIELD_FORMULA": {
			const cols = [...new Set(nameList(config?.columns))];
			if (cols.length === 0) return `${id} = ${src}  # 未選取欄位 → passthrough`;

			const raw = safeExpr(config?.expression, "1");
			if (!hasCurrentField(raw)) {
				// 與 SQL 端一致：沒有 _CurrentField_ 就 passthrough。
				// OVERWRITE 模式下把每一欄都寫成同一個常數是不可逆的資料破壞。
				ctx.notes.push(
					`節點 ${id}：運算式沒有用到 _CurrentField_ → 未改動任何欄位`,
				);
				return `${id} = ${src}  # 運算式缺少 _CurrentField_ → passthrough`;
			}

			// 先把運算式翻成 Polars，佔位符留成一個合法的識別字，翻完再把
			// `pl.col("__CURRENT_FIELD__")` 逐欄換掉。
			//
			// 為什麼不直接代入欄位名：欄位名可能含空白或標點（`my field`），
			// 那會讓 tokenizer 把它切成兩個識別字，產生語法正確但算錯的腳本。
			// 先翻再換，等於借用翻譯器自己的引號規則。
			const MARKER = `pl.col("__CURRENT_FIELD__")`;
			const template = translateExprToPolars(applyCurrentField(raw, "__CURRENT_FIELD__"));
			if (template === null || !template.includes(MARKER)) {
				ctx.needsReview = true;
				ctx.notes.push(
					`節點 ${id} 的 MULTI_FIELD_FORMULA 運算式無法自動翻譯（${raw}）→ 已用 null 佔位，請手動改寫`,
				);
				return [
					`# TODO: 無法自動翻譯 SQL 運算式 → ${raw}`,
					`${id} = ${src}.with_columns(pl.lit(None).alias(${pyStr(cols[0])}))`,
				].join("\n");
			}

			const mode = safeMultiFieldOutputMode(config?.outputMode);
			const suffix = safeNewFieldSuffix(config?.newFieldSuffix);
			const parts = cols.map((c) => {
				// 就地改寫時 alias 沿用原欄位名 —— Polars 的 with_columns
				// 同名即取代，且保留原本的位置，與 SQL 的 `SELECT * REPLACE` 一致。
				const out = mode === "NEW_FIELD" ? c + suffix : c;
				const expr = template.split(MARKER).join(`pl.col(${pyStr(c)})`);
				// 一定要加括號：`.alias` 的綁定優先於二元運算子，所以
				// `pl.col("x") * 1.1.alias("x")` 會變成 `float.alias` —— 執行時
				// 才炸，而字串比對看不出來。`(pl.col("x") * 1.1).alias("x")` 才對。
				return `(${expr}).alias(${pyStr(out)})`;
			});
			return `${id} = ${src}.with_columns([${parts.join(", ")}])`;
		}

		case "MULTI_ROW_FORMULA": {
			const out = config?.outputColumn || "prev_amount";
			const raw = safeExpr(config?.expression, "1");
			const translated = translateExprToPolars(raw);
			if (translated === null) {
				ctx.needsReview = true;
				ctx.notes.push(
					`節點 ${id} 的 MULTI_ROW_FORMULA 運算式無法自動翻譯（${raw}）→ 已用 null 佔位，請手動改寫`,
				);
				return [
					`# TODO: 無法自動翻譯 SQL 運算式 → ${raw}`,
					`${id} = ${src}.with_columns(pl.lit(None).alias(${pyStr(out)}))`,
				].join("\n");
			}
			const over = polarsOver(config, { orderBy: config?.orderBy || "id" });
			return `${id} = ${src}.with_columns((${translated})${over}.alias(${pyStr(out)}))`;
		}

		case "RUNNING_TOTAL": {
			const target = config?.target || "amount";
			const out = config?.outputColumn || `${target}_running`;
			// 實測：Polars 的 cum_sum 會把 NULL 往後傳（100, None, 400…），
			// 而 DuckDB 的 SUM(...) OVER (ROWS ...) 忽略 NULL（100, 100, 400…）。
			// SUM 忽略 NULL 等價於「NULL 當 0 再加」，所以 fill_null(0) 之後
			// 兩邊完全一致。唯一殘留差異：整個視窗框都是 NULL 時 DuckDB 回
			// NULL、這裡回 0。
			ctx.notes.push(
				`節點 ${id}：cum_sum 前先 fill_null(0)，以對齊 DuckDB 的 SUM(...) OVER (ROWS ...) ` +
					`（SUM 忽略 NULL）；若整段視窗框全為 NULL，DuckDB 回 NULL、這裡回 0`,
			);
			const over = polarsOver(config, { orderBy: config?.orderBy || "id" });
			return `${id} = ${src}.with_columns(pl.col(${pyStr(target)}).fill_null(0).cum_sum()${over}.alias(${pyStr(out)}))`;
		}

		case "RANK": {
			const target = config?.target || "amount";
			const out = config?.outputColumn || `${target}_rank`;
			const method =
				RANK_METHOD[safeRankMethod(config?.method, "RANK")] || "min";
			// 預設「大者在先」，與 SQL 端一致
			const desc =
				config?.descending === undefined ? true : Boolean(config.descending);
			const parts = nameList(config?.partitionBy);
			const over =
				parts.length > 0 ? `.over([${parts.map(pyStr).join(", ")}])` : "";
			// 實測差異：DuckDB 會給 NULL 列一個名次（排在最後），Polars 對 NULL 回 null
			ctx.notes.push(
				`節點 ${id}：DuckDB 會給 NULL 列一個名次，Polars 對 NULL 回 null`,
			);
			return `${id} = ${src}.with_columns(pl.col(${pyStr(target)}).rank(method=${pyStr(method)}, descending=${desc ? "True" : "False"})${over}.alias(${pyStr(out)}))`;
		}

		// ---------------------------------------------------------------
		// 進階連接組
		// ---------------------------------------------------------------
		case "APPEND_FIELDS": {
			const left = upstream[0] || "raw_data";
			const right = upstream[1] || "raw_data";
			return `${id} = ${left}.join(${right}, how="cross")`;
		}

		case "FIND_REPLACE": {
			const left = upstream[0] || "raw_data";
			const right = upstream[1] || "raw_data";
			const find = config?.findField || "id";
			const lookup = config?.lookupField || "id";
			const replace = config?.replaceField || "name";
			const out = String(config?.outputColumn ?? "").trim() || find;
			const keep = safeUnmatched(config?.unmatched, "KEEP") === "KEEP";
			const fallback = keep ? `pl.col(${pyStr(find)})` : "pl.lit(None)";
			// lookup === replace（查找表只有一欄）時不要重複 select
			const pickCols = lookup === replace ? [lookup] : [lookup, replace];

			ctx.notes.push(
				`節點 ${id}：若左表本身已有同名的 ${pyStr(replace)} 欄位，Polars 會加後綴、` +
					`取到的可能不是查找表那一欄 → 請先改名`,
			);

			const lines = [
				`${id} = ${left}.join(${right}.select([${pickCols.map(pyStr).join(", ")}]), left_on=${pyStr(find)}, right_on=${pyStr(lookup)}, how="left")`,
				`${id} = ${id}.with_columns(pl.coalesce([pl.col(${pyStr(replace)}), ${fallback}]).alias(${pyStr(out)}))`,
			];
			// 取回的值欄位用完就丟，除非它正是輸出欄位、或它就是來源鍵
			if (replace !== out && replace !== find) {
				lines.push(`${id} = ${id}.drop(${pyStr(replace)})`);
			}
			return lines.join("\n");
		}

		default:
			ctx.needsReview = true;
			ctx.notes.push(`節點 ${id} 的類型 ${type} 沒有 Polars 對應 → 已當成 passthrough`);
			return `${id} = ${src}  # 未支援的節點類型：${type}`;
	}
}

// ---------------------------------------------------------------------------
// 匯出
// ---------------------------------------------------------------------------

export interface PolarsExportResult {
	/** 可直接執行的 Python 腳本 */
	script: string;
	/** 不由工作流產生的來源表 */
	externalSources: string[];
	/** 被略過的節點 id（VIZ_CHART 不產生資料） */
	skipped: string[];
	/** 需要人工處理的節點 id（無法自動翻譯的部分） */
	needsReview: string[];
}

/**
 * 將整個 DAG 匯出成 Polars 腳本。
 * 回傳 null = 圖含循環依賴（無法線性化）。
 */
export function exportToPolars(
	nodes: Node[],
	edges: Edge[],
	opts: { sink?: string; title?: string } = {},
): PolarsExportResult | null {
	const order = topologicalSort(
		nodes.map((n) => n.id),
		edges,
	);
	if (!order) return null;

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const hasOutgoing = new Set(edges.map((e) => e.source));
	const externalSources = new Set<string>();
	const skipped: string[] = [];
	const needsReview: string[] = [];
	const notes: string[] = [];
	const blocks: { id: string; label: string; type: string; code: string }[] = [];

	for (const id of order) {
		const node = byId.get(id);
		if (!node) continue;
		const data: any = node.data || {};
		const type: string = data.type || "RAW_SQL";
		const label: string = data.label || id;

		// 檢視節點不產生資料
		if (type === "VIZ_CHART") {
			skipped.push(id);
			continue;
		}

		// UNION 要全部上游；其餘節點用 resolveSourceTables 的語意
		const upstream =
			type === "UNION"
				? resolveSourceTables(id, "UNION", edges)
				: orderUpstreamSources(id, edges);

		if (upstream.length === 0) {
			const src =
				type === "INPUT_DUCKDB" && data.config?.fileName
					? data.config.tableName || `src_${id}`
					: "raw_data";
			externalSources.add(src);
		}

		const ctx: EmitCtx = { needsReview: false, notes: [] };
		const code = emitNode(id, type, data.config || {}, upstream, ctx);
		if (ctx.needsReview) needsReview.push(id);
		for (const n of ctx.notes) notes.push(n);
		blocks.push({ id, label, type, code });
	}

	// ---- 終點 ----
	let sinkVar: string | null = null;
	if (opts.sink && byId.has(opts.sink)) {
		sinkVar = opts.sink;
	} else {
		const vizId = order.find((id) => (byId.get(id)?.data as any)?.type === "VIZ_CHART");
		if (vizId) {
			sinkVar = resolveSourceTables(vizId, "FILTER", edges)[0] || null;
		} else {
			const sinks = order.filter((id) => !hasOutgoing.has(id));
			sinkVar =
				sinks.length > 0
					? sinks[sinks.length - 1]
					: blocks.length > 0
						? blocks[blocks.length - 1].id
						: null;
		}
	}

	// ---- 組裝 ----
	const lines: string[] = [
		'"""',
		`Synapse Workflow → Polars${opts.title ? ` (${opts.title})` : ""}`,
		"",
		"節點順序 = 拓撲序（上游先於下游），與畫布實際執行次序一致。",
		"",
		"⚠ 這個腳本由 Synapse 自動產生。SQL 與 Polars 的表達力不完全相同，",
		"  標了 TODO 的地方需要人工確認（見檔尾的 needs-review 清單）。",
		'"""',
		"",
		"import polars as pl",
		"",
	];

	if (externalSources.size > 0) {
		lines.push("# ⚠ 以下來源不在工作流內，請先準備好對應的 DataFrame：");
		for (const s of [...externalSources].sort()) {
			lines.push(
				s === "raw_data"
					? `raw_data = pl.read_csv("raw_data.csv")  # TODO: 換成實際的資料載入方式`
					: `${s} = pl.DataFrame()  # TODO: 節點 ${s} 的來源資料`,
			);
		}
		lines.push("");
	}

	if (blocks.length === 0) {
		lines.push("# 這個工作流沒有任何會產生資料的節點。");
		return {
			script: lines.join("\n"),
			externalSources: [...externalSources].sort(),
			skipped,
			needsReview,
		};
	}

	for (const b of blocks) {
		lines.push(`# --- ${b.label} (${b.type}) ---`);
		lines.push(b.code);
		lines.push("");
	}

	lines.push("# --- 最終輸出 ---");
	lines.push(sinkVar ? `print(${sinkVar})` : "# 找不到終點節點");

	if (skipped.length > 0) {
		lines.push("");
		lines.push(`# 已略過 ${skipped.length} 個檢視節點（不產生資料）：${skipped.join(", ")}`);
	}
	if (notes.length > 0) {
		lines.push("");
		lines.push("# --- 翻譯備註 ---");
		for (const n of notes) lines.push(`#   - ${n}`);
	}
	if (needsReview.length > 0) {
		lines.push("");
		lines.push(`# ⚠ needs review（${needsReview.length}）：${needsReview.join(", ")}`);
	}

	return {
		script: lines.join("\n"),
		externalSources: [...externalSources].sort(),
		skipped,
		needsReview,
	};
}
