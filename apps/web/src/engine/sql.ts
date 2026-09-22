// apps/web/src/engine/sql.ts
// SQL literal / identifier 安全層（zero dependencies —— main thread 與 Web Worker
// 都要使用，因此不可 import 任何 React component）。
//
// 設計原則：任何由 UI / LLM / 檔名流入 SQL 的值，都必須經本模組處理。
// 不存在「直接將字串 interpolation 進 SQL」的路徑。

/** 雙引號 identifier（escape 內含的雙引號） */
export function qi(identifier: string): string {
	return `"${String(identifier).replace(/"/g, '""')}"`;
}

/**
 * Value literal：純數字 / 布林保留原樣（方便 `WHERE amount > 1000`），
 * 其餘一律以 single quote 包裹並 escape。
 */
export function lit(value: unknown): string {
	const trimmed = String(value ?? "").trim();
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return trimmed;
	if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase();
	if (/^null$/i.test(trimmed)) return "NULL";
	return strLit(trimmed);
}

/** 強制為 string literal（例如 LIKE pattern 必須是 string，不可變成裸數字） */
export function strLit(value: unknown): string {
	return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

/** 非負整數（LIMIT / OFFSET 使用） */
export function intLit(value: unknown, fallback = 0): number {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * FILTER operator 白名單 —— 舊版直接將 config.op 插入 SQL。
 */
const ALLOWED_OPS = new Set([
	"=", "==", "!=", "<>", ">", ">=", "<", "<=",
	"LIKE", "NOT LIKE", "ILIKE", "NOT ILIKE", "IS", "IS NOT",
]);

export function safeOp(op: unknown, fallback = "="): string {
	const normalized = String(op ?? "").trim().toUpperCase().replace(/\s+/g, " ");
	return ALLOWED_OPS.has(normalized) ? normalized : fallback;
}

/**
 * Aggregate function 白名單。
 * COUNT_DISTINCT 是 UI 用的虛擬名稱 → 由 astCompiler 展開成 `COUNT(DISTINCT x)`
 * （DuckDB 沒有 count_distinct 這個函數名）。
 */
const ALLOWED_FUNCS = new Set([
	"SUM",
	"AVG",
	"COUNT",
	"COUNT_DISTINCT",
	"MIN",
	"MAX",
	"STDDEV",
	"MEDIAN",
	"ANY_VALUE",
	// CROSS_TAB（PIVOT ... USING FIRST(...)）需要 —— DuckDB 的 first() 聚合
	"FIRST",
]);

export function safeFunc(fn: unknown, fallback = "SUM"): string {
	const normalized = String(fn ?? "").trim().toUpperCase();
	return ALLOWED_FUNCS.has(normalized) ? normalized : fallback;
}

/** IMPUTE 補值方式白名單 */
const ALLOWED_IMPUTE_METHODS = new Set(["CONSTANT", "MEAN"]);

export function safeImputeMethod(m: unknown, fallback = "CONSTANT"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_IMPUTE_METHODS.has(normalized) ? normalized : fallback;
}

/** RANK 排名方式白名單（值同時是 DuckDB 的視窗函數名） */
const ALLOWED_RANK_METHODS = new Set(["RANK", "DENSE_RANK", "ROW_NUMBER"]);

export function safeRankMethod(m: unknown, fallback = "RANK"): string {
	const normalized = String(m ?? "").trim().toUpperCase().replace(/\s+/g, "_");
	return ALLOWED_RANK_METHODS.has(normalized) ? normalized : fallback;
}

/**
 * FIND_REPLACE 未命中時的處理。
 *   KEEP → 保留來源原值（LEFT JOIN + COALESCE）
 *   NULL → 設為空值
 */
const ALLOWED_UNMATCHED = new Set(["KEEP", "NULL"]);

export function safeUnmatched(m: unknown, fallback = "KEEP"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_UNMATCHED.has(normalized) ? normalized : fallback;
}

/** JOIN type 白名單 */
const ALLOWED_JOIN_TYPES = new Set(["INNER", "LEFT", "RIGHT", "FULL", "LEFT OUTER", "RIGHT OUTER", "FULL OUTER", "CROSS"]);

export function safeJoinType(t: unknown, fallback = "INNER"): string {
	const normalized = String(t ?? "").trim().toUpperCase().replace(/\s+/g, " ");
	return ALLOWED_JOIN_TYPES.has(normalized) ? normalized : fallback;
}

/**
 * FUZZY_JOIN 專用的 JOIN type 白名單。
 *
 * 為什麼要獨立一份：Polars 沒有字串相似度函數，模糊比對是用 cross join + 逐對算分
 * 表達的，只有 INNER / LEFT 有對應的實作（LEFT 靠 anti join 補回未命中的左表列）。
 * 若這裡沿用 safeJoinType，payload 寫 `FULL OUTER` 時 DuckDB 會真的做 FULL JOIN，
 * 而 Polars 只會給出 INNER 的結果 —— 兩個引擎無聲地不一致。
 *
 * 與 UI 表單一致（表單只提供 INNER / LEFT）。超出範圍一律退回 fallback，
 * 由呼叫端記錄一則 note，讓「被改寫過」這件事是可見的。
 */
const ALLOWED_FUZZY_JOIN_TYPES = new Set(["INNER", "LEFT"]);

export function safeFuzzyJoinType(t: unknown, fallback = "INNER"): string {
	const normalized = String(t ?? "").trim().toUpperCase().replace(/\s+/g, " ");
	return ALLOWED_FUZZY_JOIN_TYPES.has(normalized) ? normalized : fallback;
}

/**
 * SPATIAL_MATCH 的二元空間謂詞白名單 → DuckDB 函式名。
 *
 * 這裡**只有二元謂詞**。DWITHIN 不在這張表裡：它需要一個距離參數，而且距離的
 * 單位有兩種（度 / 公尺），編譯器是把它寫成 `<距離表達式> <= <門檻>` 而不是呼叫
 * ST_DWithin —— 這樣「篩選用的距離」與「輸出欄位的距離」保證是同一個表達式，
 * 不可能出現「門檻換了單位、輸出沒換」這種半套。詳見 astCompiler 的 SPATIAL_MATCH。
 */
const SPATIAL_PREDICATES: Record<string, string> = {
	INTERSECTS: "ST_Intersects",
	CONTAINS: "ST_Contains",
	WITHIN: "ST_Within",
	TOUCHES: "ST_Touches",
	OVERLAPS: "ST_Overlaps",
	CROSSES: "ST_Crosses",
	EQUALS: "ST_Equals",
};

/** DWITHIN 是唯一吃距離參數的謂詞，所以另外列舉。 */
export const SPATIAL_DWITHIN = "DWITHIN";

export function safeSpatialPredicate(p: unknown, fallback = "INTERSECTS"): string {
	const normalized = String(p ?? "").trim().toUpperCase().replace(/\s+/g, "");
	return normalized === SPATIAL_DWITHIN || normalized in SPATIAL_PREDICATES
		? normalized
		: fallback;
}

/** 二元謂詞 → DuckDB 函式名。呼叫前請先過 safeSpatialPredicate()。 */
export function duckdbSpatialFn(predicate: string): string {
	return SPATIAL_PREDICATES[predicate] ?? SPATIAL_PREDICATES.INTERSECTS;
}

/**
 * 距離單位白名單。
 *   DEGREES → ST_Distance / ST_DWithin 的平面度數
 *   METERS  → ST_Distance_Sphere
 *
 * ⚠ 這個 build 的 ST_Distance_Sphere 實測就是「平面度數 × 111194.92664455874」：
 *   同一段 1 度經差在赤道與 lat 60 量到完全一樣的值（比值 1.0），
 *   也就是**沒有**經度收斂修正。所以 METERS 在離開赤道後會高估東西向距離
 *   （lat 60 約高估一倍，香港 lat 22.3 約高估 8%）。
 *   要精確就選 DEGREES。這個數字不是推論，是 scripts/verify_duckdb_wasm.mjs 量到的。
 */
const ALLOWED_DISTANCE_UNITS = new Set(["DEGREES", "METERS"]);

export function safeDistanceUnit(u: unknown, fallback = "DEGREES"): string {
	const normalized = String(u ?? "").trim().toUpperCase();
	return ALLOWED_DISTANCE_UNITS.has(normalized) ? normalized : fallback;
}

/** 每度對應的公尺數（DuckDB ST_Distance_Sphere 在這個 build 用的常數） */
export const METERS_PER_DEGREE = 111194.92664455874;

/** SPATIAL_MATCH 的 JOIN type 白名單；與 UI 表單一致 */
const ALLOWED_SPATIAL_JOIN_TYPES = new Set(["INNER", "LEFT"]);

export function safeSpatialJoinType(t: unknown, fallback = "INNER"): string {
	const normalized = String(t ?? "").trim().toUpperCase().replace(/\s+/g, " ");
	return ALLOWED_SPATIAL_JOIN_TYPES.has(normalized) ? normalized : fallback;
}

/** 距離欄位名；空字串 = 不輸出 */
export function safeDistanceColumn(value: unknown, fallback = ""): string {
	const s = String(value ?? "").trim();
	return s || fallback;
}

/** OUTPUT 的格式白名單 */
const ALLOWED_OUTPUT_FORMATS = new Set(["CSV", "JSON"]);

export function safeOutputFormat(f: unknown, fallback = "CSV"): string {
	const normalized = String(f ?? "").trim().toUpperCase();
	return ALLOWED_OUTPUT_FORMATS.has(normalized) ? normalized : fallback;
}

/**
 * OUTPUT 的檔名。
 *
 * 兩個理由讓它必須被清乾淨，而不是直接拿使用者的輸入：
 *   1. 這個字串會被寫進匯出的 Python 腳本當字面值，也可能變成瀏覽器下載的檔名。
 *      路徑分隔符與 `..` 會讓 `write_csv("../../x.csv")` 寫到預期之外的位置。
 *   2. 副檔名必須跟著格式走。`output.csv` 裝 JSON 內容是那種「開得起來但讀不到」
 *      的錯，而且不會有任何錯誤訊息。
 */
export function safeOutputFileName(
	value: unknown,
	format: string = "CSV",
	fallback = "output",
): string {
	// 反斜線一律當分隔符（Windows 來的路徑），只取最後一段
	const base = String(value ?? "").trim().replace(/\\/g, "/").split("/").pop() ?? "";
	const stem =
		base
			// 去掉 .. 與前導點（`.hidden` / `..` 都不該變成檔名）
			.replace(/\.\./g, "")
			.replace(/^\.+/, "")
			// 去掉既有副檔名 —— 由 format 決定，不讓兩者不一致
			.replace(/\.(csv|json|tsv|txt)$/i, "")
			.trim() || fallback;
	const ext = safeOutputFormat(format) === "JSON" ? ".json" : ".csv";
	return `${stem}${ext}`;
}

/**
 * ASSERT 節點的檢查種類白名單。
 *
 *   NOT_NULL   → 指定欄位不得為 NULL
 *   UNIQUE     → 指定欄位的值必須唯一（含組合鍵）
 *   ROW_COUNT  → 總列數必須落在 [min, max] 之間
 *   PREDICATE  → 自訂述句，**不得**有任何一列讓它為假
 *
 * 刻意不做「資料型別」檢查：DuckDB 是強型別的，型別錯了在 binder 階段就會炸，
 * 輪不到 ASSERT 來守。
 */
export const ASSERT_CHECKS = [
	"NOT_NULL",
	"UNIQUE",
	"ROW_COUNT",
	"PREDICATE",
] as const;

const ALLOWED_ASSERT_CHECKS = new Set<string>(ASSERT_CHECKS);

export function safeAssertCheck(c: unknown, fallback = "NOT_NULL"): string {
	const normalized = String(c ?? "").trim().toUpperCase().replace(/\s+/g, "_");
	return ALLOWED_ASSERT_CHECKS.has(normalized) ? normalized : fallback;
}

/**
 * ASSERT 的數值邊界（ROW_COUNT 的 min / max）。
 *
 * 空字串與非數字一律視為「不設限」回 null —— 不是回 0。
 * 回 0 會讓「只填下限」變成「上限 0」，於是每一張表都違反，錯誤訊息還指向
 * 一個使用者從沒輸入過的數字。
 */
export function safeAssertBound(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const s = String(value).trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

/**
 * ASSERT 失敗訊息的前綴。
 *
 * 訊息會進到 error() 的參數，所以**必須**由這裡產生而不是讓使用者自由填寫 ——
 * 否則就多了一條字串注入路徑（`'` 可以逃逸出字面值）。使用者自訂的部分只留
 * 「檢查名稱」，而它只允許英數字與底線。
 */
export function safeAssertLabel(value: unknown, fallback = ""): string {
	return String(value ?? "")
		.trim()
		// 只留英數字、底線、連字號與空白，其餘一律拿掉
		.replace(/[^A-Za-z0-9_\- ]/g, "")
		.slice(0, 60)
		.trim() || fallback;
}

/**
 * UNION 的欄位對齊方式。
 *   BY_NAME  → `UNION ALL BY NAME`：按欄位名對齊，缺欄位補 NULL（Alteryx 的 Union 語意）
 *   POSITION → `UNION ALL`：按位置對齊
 */
const ALLOWED_UNION_MODES = new Set(["BY_NAME", "POSITION"]);

export function safeUnionMode(m: unknown, fallback = "BY_NAME"): string {
	const normalized = String(m ?? "").trim().toUpperCase().replace(/\s+/g, "_");
	return ALLOWED_UNION_MODES.has(normalized) ? normalized : fallback;
}

/** SAMPLE 取樣方式白名單 */
const ALLOWED_SAMPLE_MODES = new Set(["FIRST", "RANDOM"]);

export function safeSampleMode(m: unknown, fallback = "FIRST"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_SAMPLE_MODES.has(normalized) ? normalized : fallback;
}

/**
 * REGEX 模式白名單。
 *   MATCH   → 布林欄位（regexp_matches）
 *   PARSE   → 每個 capture group 一個欄位（regexp_extract）
 *   REPLACE → 取代所有命中（regexp_replace ... 'g'）
 */
const ALLOWED_REGEX_MODES = new Set(["MATCH", "PARSE", "REPLACE"]);

export function safeRegexMode(m: unknown, fallback = "MATCH"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_REGEX_MODES.has(normalized) ? normalized : fallback;
}

/**
 * 把「忽略大小寫」折進 pattern，而不是走各引擎各自的旗標參數。
 *
 * 為什麼：DuckDB 是 `regexp_replace(s, p, r, 'gi')`，Polars 是
 * `.str.contains(p)` —— Polars 的多數 str 方法根本沒有 case 參數。
 * 但兩邊的 regex 引擎（RE2 / Rust regex）都支援 inline flag `(?i)`，
 * 所以在 pattern 前面加 `(?i)` 是唯一能讓兩份輸出語意一致的做法。
 * 已實測：`regexp_matches('abc','(?i)B')` 與
 * `pl.col('s').str.contains('(?i)B')` 都回 True。
 */
export function regexPattern(value: unknown, caseInsensitive: unknown): string {
	const raw = String(value ?? "");
	if (!raw) return raw;
	// 已經自帶 inline flag 就不要重複加，避免 `(?i)(?i)x`
	if (/^\(\?[a-zA-Z]*i[a-zA-Z]*\)/.test(raw)) return raw;
	return caseInsensitive ? `(?i)${raw}` : raw;
}

/**
 * MULTI_FIELD_FORMULA 的「當前欄位」佔位符。
 *
 * 沿用 Alteryx 的 `_CurrentField_`：使用者（或 LLM）只寫一次運算式，
 * 節點把它套用到多個欄位上。比對刻意**不分大小寫** —— LLM 很常寫成
 * `_currentfield_`，而兩種寫法只可能指同一個東西。
 */
const CURRENT_FIELD_TEST = /_CurrentField_/i;

export function hasCurrentField(expr: unknown): boolean {
	return CURRENT_FIELD_TEST.test(String(expr ?? ""));
}

/**
 * 把 `_CurrentField_` 換成（已加引號的）欄位名；沒有佔位符就原樣回傳。
 *
 * 替換值用函式回傳而不是字串：字串替換會解讀 `$&` / `$1` / `$'`，
 * 而欄位名是使用者可控的字串 —— 一個叫 `a$&b` 的欄位會讓替換結果
 * 變成整段匹配。函式回傳不做任何解讀。
 */
export function applyCurrentField(expr: string, quotedField: string): string {
	return String(expr).replace(/_CurrentField_/gi, () => quotedField);
}

/**
 * MULTI_FIELD_FORMULA 的輸出模式白名單。
 *   OVERWRITE → 就地改寫選取的欄位（`SELECT * REPLACE (…)`，欄位順序不變）
 *   NEW_FIELD → 原欄位保留，每個選取欄位多一個新欄位
 */
const ALLOWED_MULTI_FIELD_OUTPUT_MODES = new Set(["OVERWRITE", "NEW_FIELD"]);

export function safeMultiFieldOutputMode(m: unknown, fallback = "OVERWRITE"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_MULTI_FIELD_OUTPUT_MODES.has(normalized) ? normalized : fallback;
}

/**
 * NEW_FIELD 模式的後綴。刻意不接受空字串。
 *
 * 實測（DuckDB 1.5.5 / Polars 1.44.2）：`SELECT *, UPPER("x") AS "x"` 會**安靜地**
 * 產生兩個叫 `x` 的欄位，而 Polars 的 `.with_columns(… .alias("x"))` 是安靜地
 * **就地取代**。空後綴等於讓兩個引擎在沒有任何警告的情況下做出不同的事，
 * 所以這裡退回預設值，而不是把選擇權交給使用者。
 */
export function safeNewFieldSuffix(value: unknown, fallback = "_new"): string {
	const raw = String(value ?? "").trim();
	return raw === "" ? fallback : raw;
}

/**
 * TEXT_TO_COLUMNS 的切分方式白名單。
 *   SEPARATOR → 字面分隔符（`string_split` / `.str.split(literal=True)`）
 *   REGEX     → 樣式切分（`regexp_split_to_array` / `.str.split(literal=False)`）
 */
const ALLOWED_SPLIT_MODES = new Set(["SEPARATOR", "REGEX"]);

export function safeSplitMode(m: unknown, fallback = "SEPARATOR"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_SPLIT_MODES.has(normalized) ? normalized : fallback;
}

/**
 * FUZZY_JOIN 的比對函數白名單。
 *
 * 「方向」是這裡最重要的一件事，也是這個工具最容易靜默出錯的地方：
 *   JARO_WINKLER         相似度 0..1，**越大越像** → 門檻是下限（>=）
 *   LEVENSHTEIN          編輯距離整數，**越小越像** → 門檻是上限（<=）
 *   DAMERAU_LEVENSHTEIN  同上，但允許相鄰字元互換
 *   EXACT                完全相等，門檻無意義
 *
 * 把方向收斂成 matchIsSimilarity() 一個判斷，是為了讓 SQL 編譯器、Polars 匯出
 * 與設定表單三處都問同一個來源。各自記一次的話，記錯方向不會報錯 ——
 * 只會讓「越像的配對越不被選中」，SQL 完全合法。
 *
 * 為什麼沒有 EDITDIST3：實測（DuckDB 1.5.5 / duckdb-wasm v1.4.3）它的預設成本
 * 等於 levenshtein（`editdist3('abc','abd')` = 1 = `levenshtein`），
 * 提供兩個名字指同一個東西只會讓 agent 選錯。需要自訂成本時再另開節點。
 */
const ALLOWED_MATCH_FUNCS = new Set([
	"JARO_WINKLER",
	"LEVENSHTEIN",
	"DAMERAU_LEVENSHTEIN",
	"EXACT",
]);

export function safeMatchFunc(m: unknown, fallback = "JARO_WINKLER"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_MATCH_FUNCS.has(normalized) ? normalized : fallback;
}

/** 這個函數是「相似度」（越大越像）還是「距離」（越小越像）？ */
export function matchIsSimilarity(fn: string): boolean {
	return fn === "JARO_WINKLER";
}

/**
 * 門檻的預設值。兩種方向的量綱完全不同（0.85 的相似度 vs 3 的編輯距離），
 * 所以不能共用一個數字 —— 共用會讓切換函數時門檻悄悄變成無意義的值。
 */
export function matchThresholdDefault(fn: string): number {
	if (fn === "JARO_WINKLER") return 0.85;
	if (fn === "EXACT") return 0;
	return 3;
}

/**
 * 門檻的數值。非數值輸入退回預設，而不是原樣塞進 SQL ——
 * 這裡刻意回 number 而不是字串，呼叫端直接內插，沒有引號可逃逸。
 */
export function matchThreshold(value: unknown, fn: string): number {
	if (fn === "EXACT") return 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : matchThresholdDefault(fn);
}

/**
 * 比對函數在 DuckDB 裡的名字。
 *
 * 這三個都是 DuckDB 內建（實測 duckdb-wasm v1.4.3 可用），不需要任何擴充：
 * `jaro_winkler_similarity('martha','marhta')` = 0.9611111111111111、
 * `levenshtein` / `damerau_levenshtein` 皆可用。
 * 注意 DuckDB 的 damerau 是**無限制版**（unrestricted），不是常見的 OSA 變體：
 * `damerau_levenshtein('ca','abc')` = 2，而 OSA 會給 3。
 */
export function duckdbMatchFn(fn: string): string {
	switch (fn) {
		case "LEVENSHTEIN":
			return "levenshtein";
		case "DAMERAU_LEVENSHTEIN":
			return "damerau_levenshtein";
		default:
			return "jaro_winkler_similarity";
	}
}

/**
 * 候選對縮減方式。
 *
 *   NONE       → 全部配對（O(n*m)）
 *   FIRST_CHAR → 只比首字元相同的配對
 *
 * FIRST_CHAR 是 OVERSAMPLE 那一類「先縮小候選集」的做法。它會改變結果
 * （首字元打錯的配對永遠不會命中），所以是**使用者明確選擇**，不是預設。
 */
const ALLOWED_PREFILTERS = new Set(["NONE", "FIRST_CHAR"]);

export function safePrefilter(m: unknown, fallback = "NONE"): string {
	const normalized = String(m ?? "").trim().toUpperCase();
	return ALLOWED_PREFILTERS.has(normalized) ? normalized : fallback;
}

/** 相似度分數的輸出欄位名；空字串 = 不輸出這個欄位 */
export function safeScoreColumn(value: unknown, fallback = ""): string {
	return String(value ?? "").trim() || fallback;
}

/**
 * FORMULA expression：本質上是自由 SQL 片段，無法完全參數化，
 * 因此做「結構性拒絕」—— 只擋多語句與註解，保留正常運算表達式。
 * （`;` 與 `--` / `/*` 在一個 scalar expression 內永遠不會合法）
 */
export function safeExpr(expr: unknown, fallback = "1"): string {
	const raw = String(expr ?? "").trim();
	if (!raw) return fallback;
	if (raw.length > 2000) return fallback;
	if (raw.includes(";") || raw.includes("--") || raw.includes("/*") || raw.includes("*/")) {
		return fallback;
	}
	// 只允許單層 expression：拒絕以 DDL / DML 關鍵字開頭
	if (/^\s*(drop|delete|insert|update|create|alter|attach|copy|pragma|install|load|export|import)\b/i.test(raw)) {
		return fallback;
	}
	return raw;
}

/** 產生「安全的虛擬檔名」：使用節點 id，而非使用者上傳的檔名 */
export function safeVirtualFileName(tableName: string, fileName: string): string {
	const ext = /\.parquet$/i.test(fileName) ? "parquet" : "csv";
	const safeBase = String(tableName).replace(/[^A-Za-z0-9_]/g, "_");
	return `${safeBase}.${ext}`;
}

/** 由檔名推斷 reader function */
export function readerFor(fileName: string): string {
	return /\.parquet$/i.test(fileName) ? "read_parquet" : "read_csv_auto";
}

/**
 * 大 CSV / Parquet 讀取參數。
 * sample_size = 100000：百萬行檔案需要足夠樣本推斷型別，
 * 避免預設 20480 抽樣不足而將數字欄位誤判成 VARCHAR。
 */
export const READER_OPTS: Record<string, string> = {
	csv: "sample_size = 100000, auto_detect = true, ignore_errors = true, null_padding = true",
	parquet: "",
};

/** 將欄位清單組成「跨欄位全文搜尋」的 SQL predicate（用於 Data Drawer 搜尋） */
export function buildSearchPredicate(columns: string[], needle: string): string {
	const q = needle.trim();
	if (!q || columns.length === 0) return "";
	const parts = columns.map((c) => `CAST(${qi(c)} AS VARCHAR)`);
	return `concat_ws(' ', ${parts.join(", ")}) ILIKE ${strLit(`%${q}%`)}`;
}
