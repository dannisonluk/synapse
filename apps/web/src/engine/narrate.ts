// apps/web/src/engine/narrate.ts
//
// 把一個節點說成一句人話 —— 用來產生管線說明。
//
// 為什麼要「確定性」而不是叫 LLM 寫：
// 讓模型自由描述一張圖，它會產生**看起來合理但不存在的步驟**。這正是本專案
// 一貫拒絕的模式（見 exportPolars 對無法翻譯的節點留 TODO 而非猜）。
// 所以骨架由編譯器這一側產生 —— 每個節點的 config 就是事實 —— 說明只是把它
// 轉成人話。零成本、零幻覺，而且可以逐條斷言。
//
// **關鍵約束：敘述必須走與編譯器同一套正規化函式**（safeOp / safeFunc /
// safeJoinType …）。自己另寫一套判斷的話，說明遲早會說出跟實際 SQL 不一樣的
// 事情 —— 而「說明與實際不符」比沒有說明更糟。
//
// 本檔案只 import sql.ts 的白名單，因此仍可在 Node 裡直接測。

import {
	safeOp,
	safeFunc,
	safeJoinType,
	safeFuzzyJoinType,
	safeMatchFunc,
	safeAssertCheck,
	safeOutputFormat,
	safeSpatialPredicate,
	safeSampleMode,
	safeUnionMode,
	safeRegexMode,
	safeSplitMode,
	safeImputeMethod,
	safeRankMethod,
	safeMultiFieldOutputMode,
	safeDistanceUnit,
	safeHttpUrl,
} from "./sql";

export interface NarrateInput {
	type: string;
	config: Record<string, unknown>;
	/** 上游節點的顯示名稱（依連線順序）。空陣列 = 來源節點 */
	upstreamLabels?: string[];
}

/** 把值轉成簡短的顯示字串；空值回「未設定」 */
function show(value: unknown, fallback = "未設定"): string {
	const s = String(value ?? "").trim();
	return s || fallback;
}

/** 欄位清單：陣列或逗號分隔字串都吃，回傳顯示用字串 */
function list(value: unknown, fallback = ""): string {
	const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
	const items = raw.map((v) => String(v ?? "").trim()).filter(Boolean);
	return items.length > 0 ? items.join("、") : fallback;
}

/** 上游描述：接在前面的「從 X 讀取」 */
function from(input: NarrateInput): string {
	const labels = (input.upstreamLabels ?? []).filter(Boolean);
	if (labels.length === 0) return "";
	if (labels.length === 1) return `從「${labels[0]}」讀取`;
	return `合併「${labels.join("」與「")}」`;
}

/**
 * 一個節點 → 一句說明。
 *
 * 回傳的字串**不含**節點名稱與編號前綴（呼叫端負責加），所以可以自由組合。
 */
export function narrateNode(input: NarrateInput): string {
	const c = input.config ?? {};
	const src = from(input);
	const lead = src ? `${src}，` : "";

	switch (input.type) {
		case "INPUT_DUCKDB": {
			// 遠端來源要講清楚它需要網路 —— 這句話會出現在匯出的腳本裡，
			// 而那是唯一讀得到它的地方。
			//
			// **必須走 safeHttpUrl，不能只看「有沒有填」**：不合法的 URL
			// （`file://…`）會被編譯器忽略並退回本機路徑，而說明若還說
			// 「從遠端讀取」，就變成在描述一件程式碼沒做的事 ——
			// 說明與實際不符，比沒有說明更糟。
			const url = safeHttpUrl(c.sourceUrl);
			if (url) {
				return `從遠端讀取 Parquet：${url}（需要網路與 httpfs 擴充；畫布上讀不到）`;
			}
			const file = show(c.fileName, "（未指定檔案）");
			const table = String(c.tableName ?? "").trim();
			return table
				? `載入檔案「${file}」，註冊成表「${table}」`
				: `載入檔案「${file}」`;
		}

		case "FILTER":
			return `${lead}只保留 ${show(c.field, "未指定欄位")} ${safeOp(c.op, ">")} ${show(c.val, "未指定值")} 的列`;

		case "FORMULA":
			return `${lead}新增欄位「${show(c.outputColumn, "未命名")}」，值為 ${show(c.expression, "未設定")}`;

		case "SUMMARIZE": {
			const groups = list(c.groupBy, "");
			const fn = safeFunc(c.func, "SUM");
			const target = show(c.target, "未指定欄位");
			return groups
				? `${lead}依「${groups}」分組，對「${target}」做 ${fn}`
				: `${lead}對「${target}」做 ${fn}（整表聚合成一列）`;
		}

		case "JOIN":
			return `${lead}以 ${show(c.leftKey, "未指定")} = ${show(c.rightKey, "未指定")} 做 ${safeJoinType(c.joinType, "INNER")} JOIN`;

		case "FUZZY_JOIN":
			return `${lead}以「${show(c.leftKey, "未指定")}」對「${show(c.rightKey, "未指定")}」做 ${safeMatchFunc(c.matchFunc, "JARO_WINKLER")} 模糊比對（門檻 ${show(c.threshold, "預設")}，${safeFuzzyJoinType(c.joinType, "INNER")}）`;

		case "SPATIAL_MATCH": {
			const geom = (wkt: unknown, lon: unknown, lat: unknown) =>
				String(wkt ?? "").trim()
					? `WKT 欄位「${String(wkt).trim()}」`
					: String(lon ?? "").trim() && String(lat ?? "").trim()
						? `經緯度「${String(lon).trim()}」/「${String(lat).trim()}」`
						: "未指定幾何";
			const pred = safeSpatialPredicate(c.spatialPredicate);
			const dist =
				pred === "DWITHIN"
					? `（距離 ${show(c.distance, "未設定")} ${safeDistanceUnit(c.distanceUnit)}）`
					: "";
			return `${lead}用 ${geom(c.leftGeometryField, c.leftLonField, c.leftLatField)} 對 ${geom(c.rightGeometryField, c.rightLonField, c.rightLatField)} 做 ${pred} 空間比對${dist}`;
		}

		case "OUTPUT":
			return `${lead}標記為輸出終點，可下載成 ${safeOutputFormat(c.outputFormat)}（檔名 ${show(c.fileName, "未設定")}）`;

		case "ASSERT": {
			const check = safeAssertCheck(c.assertCheck);
			const label = String(c.assertLabel ?? "").trim();
			// 有自訂名稱就寫「檢查「主鍵唯一」：…」；沒有的話要留一個空格給
			// 全大寫的檢查碼（「檢查 NOT_NULL：…」），否則中英會黏在一起。
			const name = label ? `「${label}」` : ` ${check}`;
			if (check === "NOT_NULL")
				return `${lead}檢查${name}：欄位「${show(c.assertColumn, "未指定")}」不得為 NULL，否則整個流程失敗`;
			if (check === "UNIQUE")
				return `${lead}檢查${name}：欄位「${list(c.assertColumn, "未指定")}」必須唯一，否則整個流程失敗`;
			if (check === "ROW_COUNT") {
				const lo = String(c.assertMin ?? "").trim();
				const hi = String(c.assertMax ?? "").trim();
				const range =
					lo && hi ? `${lo}～${hi}` : lo ? `至少 ${lo}` : hi ? `最多 ${hi}` : "未設限";
				return `${lead}檢查${name}：列數必須 ${range}，否則整個流程失敗`;
			}
			return `${lead}檢查${name}：述句「${show(c.assertPredicate, "未設定")}」不得有任何一列為假`;
		}

		case "SORT":
			return `${lead}依「${show(c.field, "未指定欄位")}」${c.descending ? "降冪" : "升冪"}排序`;

		case "SELECT": {
			const cols = list(c.columns, "");
			return cols ? `${lead}只保留欄位「${cols}」` : `${lead}全選（等同不變）`;
		}

		case "UNION":
			return `${lead}以 ${safeUnionMode(c.unionMode)} 方式合併（缺欄位補 NULL）`;

		case "SAMPLE":
			return `${lead}取 ${show(c.sampleSize, "未設定")} 列（${safeSampleMode(c.sampleMode) === "RANDOM" ? "隨機" : "取前幾列"}）`;

		case "RENAME": {
			const pairs = Array.isArray(c.renames) ? c.renames : [];
			const shown = pairs
				.map((p: any) => `${p?.from} → ${p?.to}`)
				.filter((s: string) => !s.includes("undefined"))
				.join("、");
			return `${lead}重新命名欄位：${shown || "未設定"}`;
		}

		case "UNIQUE":
			return `${lead}去除重複（依「${list(c.columns, "整列")}」判斷，保留第一筆）`;

		case "IMPUTE":
			return `${lead}補值：對「${list(c.columns, "未指定欄位")}」以 ${
				safeImputeMethod(c.method) === "MEAN"
					? "平均值"
					: `常數 ${show(c.fillValue, "未設定")}`
			} 填補 NULL`;

		case "DATA_CLEANSING": {
			const ops: string[] = [];
			if (c.trim) ops.push("去頭尾空白");
			if (c.collapse) ops.push("壓縮內部空白");
			return `${lead}清理「${list(c.columns, "未指定欄位")}」：${ops.join("、") || "未設定任何清理動作"}`;
		}

		case "CROSS_TAB":
			return `${lead}樞紐：以「${show(c.pivotField, "未指定")}」為欄、對「${show(c.valueField, "未指定")}」做 ${safeFunc(c.func, "SUM")}`;

		case "TRANSPOSE":
			return `${lead}轉置：把「${list(c.columns, "未指定欄位")}」由欄轉列`;

		case "TEXT_TO_COLUMNS": {
			const mode = safeSplitMode(c.splitMode);
			const sep = show(c.separator, "未設定");
			return `${lead}把「${show(c.field, "未指定欄位")}」依 ${mode === "REGEX" ? `正規表示式 /${sep}/` : `分隔符「${sep}」`} 拆成欄位「${list(c.outputColumns, "未命名")}」`;
		}

		case "REGEX": {
			const mode = safeRegexMode(c.mode);
			const verb =
				mode === "MATCH" ? "比對是否命中" : mode === "PARSE" ? "擷取捕獲組" : "取代命中處";
			return `${lead}對「${show(c.field, "未指定欄位")}」以 /${show(c.pattern, "未設定")}/ ${verb}`;
		}

		case "MULTI_FIELD_FORMULA":
			return `${lead}對「${list(c.columns, "未指定欄位")}」套用同一條運算式 ${show(c.expression, "未設定")}（${safeMultiFieldOutputMode(c.outputMode) === "NEW_FIELD" ? "另存新欄位" : "就地覆寫"}）`;

		case "MULTI_ROW_FORMULA":
			return `${lead}新增欄位「${show(c.outputColumn, "未命名")}」，值為跨列運算式 ${show(c.expression, "未設定")}`;

		case "RUNNING_TOTAL":
			return `${lead}對「${show(c.target, "未指定欄位")}」做累計（依「${show(c.orderBy, "未指定")}」排序）`;

		case "RANK":
			return `${lead}依「${show(c.orderBy, "未指定")}」做 ${safeRankMethod(c.method)} 排名`;

		case "APPEND_FIELDS":
			return `${lead}把兩張表逐列並排（交叉連接，不做鍵比對）`;

		case "FIND_REPLACE":
			return `${lead}以「${show(c.lookupField, "未指定")}」查表，把「${show(c.findField, "未指定")}」換成「${show(c.replaceField, "未指定")}」`;

		case "VIZ_CHART":
			return `${lead}畫 ${show(c.chartType, "未指定")} 圖（X 軸 ${show(c.xAxis, "未設定")}、Y 軸 ${show(c.yAxis, "未設定")}）`;

		default:
			// 未知型別**不可以**回空字串或「未知節點」就了事 —— 那會讓一個新增的
			// 節點類型在說明裡靜默消失。回一個明確標記，並由斷言守住。
			return `${lead}⚠ 尚未為節點類型「${input.type}」撰寫說明`;
	}
}

/** 這一句是不是「尚未撰寫」的佔位？呼叫端據此決定要不要標記為待補 */
export function isPlaceholderNarration(text: string): boolean {
	return text.includes("尚未為節點類型");
}
