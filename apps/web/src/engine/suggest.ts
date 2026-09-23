// apps/web/src/engine/suggest.ts
//
// Join 鍵建議 —— 只用 schema，完全不碰資料。
//
// 為什麼要做：JOIN 鍵猜錯是最常見的錯誤之一，而且**錯了通常不會報錯**。
// 兩張表都有 cust_id / customer_id / CustID 的時候，選錯只是結果少幾列。
//
// 為什麼先做確定性的部分：名稱正規化、型別相容性這一段零成本、可測、
// 而且能解掉大部分情況。LLM 只該當平手時的裁判 —— 這跟 FUZZY_JOIN 那輪的
// 教訓相同：**確定性的部分才是可驗證的部分**。
//
// 隱私：輸入只有 `{name, type}`。這個模組在結構上就不可能讀到資料 ——
// 它連引擎的 import 都沒有。
//
// 本檔案不 import 任何東西，可以在 Node 裡直接測。

export interface SuggestColumn {
	name: string;
	type?: string;
}

export interface JoinKeySuggestion {
	left: string;
	right: string;
	score: number;
	/** 為什麼建議這一組（顯示給使用者看，不是給程式判斷） */
	reason: string;
}

/**
 * 常見的「這是一個鍵」詞尾。
 *
 * 剝掉之後 `customer_id`、`customerid`、`CustomerID` 才會正規化到同一個字串。
 * 不剝的話它們是三個不同的名字，而它們在實務上幾乎總是同一個東西。
 */
const KEY_TOKENS = [
	"id",
	"no",
	"num",
	"nbr",
	"code",
	"cd",
	"key",
	"pk",
	"fk",
	"ref",
	"uuid",
	"guid",
	"seq",
];

/** 型別名稱裡的數值特徵 */
const NUMERIC_HINTS = [
	"int",
	"decimal",
	"double",
	"float",
	"real",
	"numeric",
	"hugeint",
	"bigint",
	"smallint",
	"tinyint",
];

export function isNumericType(type: unknown): boolean {
	const t = String(type ?? "").toLowerCase();
	return NUMERIC_HINTS.some((h) => t.includes(h));
}

/**
 * 欄位名的正規化。
 *
 * 三步：小寫 → 剝掉「分隔符結尾的」噪音詞 → 剝掉「黏在字尾的」噪音詞 →
 * 移除所有非英數字（保留中文）。
 *
 * 黏字尾那一步有長度門檻（剩下的字元必須 > 詞長 + 3）。沒有的話 `valid` 會被
 * 剝成 `val`（它剛好以 `id` 結尾），於是 `valid` 與一個真的叫 `val` 的欄位會
 * 變成**完全相同**（100 分）—— 一個看起來很肯定的假陽性。有了門檻，它們只會
 * 落到「名稱相近」（55 分），而那個標籤是誠實的。
 */
export function normaliseColumnName(name: unknown): string {
	let s = String(name ?? "")
		.trim()
		.toLowerCase();
	if (!s) return "";

	// 以分隔符切開，尾端若是噪音詞就丟掉：customer_id → customer
	const tokens = s.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
	if (tokens.length > 1 && KEY_TOKENS.includes(tokens[tokens.length - 1])) {
		tokens.pop();
	}
	s = tokens.join("");

	// 再處理黏在一起的：customerid → customer
	for (const t of KEY_TOKENS) {
		if (s.length > t.length + 3 && s.endsWith(t)) {
			s = s.slice(0, -t.length);
			break;
		}
	}

	return s;
}

/**
 * 建議 join 鍵，分數高的在前。
 *
 * 只有兩種命中方式：正規化後**完全相同**（100 分），或**互相包含**（55 分，
 * 且兩邊都至少 3 個字元）。刻意不做編輯距離 —— 那會讓 `amount` 與 `account`
 * 這種無關的欄位拿到分數，而使用者只會看到一串看起來很專業的雜訊。
 * 拼字不同的情況本來就是 FUZZY_JOIN 的職責，不是這裡。
 */
export function suggestJoinKeys(
	left: readonly SuggestColumn[],
	right: readonly SuggestColumn[],
	limit = 3,
): JoinKeySuggestion[] {
	const out: JoinKeySuggestion[] = [];

	for (const l of left) {
		const ln = normaliseColumnName(l?.name);
		if (!ln) continue;

		for (const r of right) {
			const rn = normaliseColumnName(r?.name);
			if (!rn) continue;

			const same = ln === rn;
			let score = 0;
			if (same) {
				score = 100;
			} else {
				// 短字串的「包含」幾乎沒有資訊量（`a` 被任何字串包含）
				if (ln.length < 3 || rn.length < 3) continue;
				if (!ln.includes(rn) && !rn.includes(ln)) continue;
				score = 55;
			}

			const notes: string[] = [same ? "名稱相同" : "名稱相近"];

			// 拼寫完全相同比「正規化後相同」更可信：`amount` = `amount` 沒有
			// 任何推論成分，而 `customer_id` = `CustomerID` 已經用了剝後綴與
			// 大小寫折疊兩層推論。給一個小加成讓前者排前面。
			// 刻意不加進 notes —— 那是給人看的說明，不是分數的流水帳。
			if (String(l.name) === String(r.name)) score += 5;

			const lt = String(l.type ?? "").toLowerCase();
			const rt = String(r.type ?? "").toLowerCase();
			if (lt && rt) {
				if (lt === rt) {
					score += 20;
					notes.push("型別相同");
				} else if (isNumericType(lt) && isNumericType(rt)) {
					// 兩個都是數值但寫法不同（INTEGER vs BIGINT）→ 通常仍然可以接
					score += 10;
					notes.push("都是數值");
				} else if (isNumericType(lt) !== isNumericType(rt)) {
					// 這是最該被壓下去的情況：把文字接到數值，DuckDB 會嘗試轉型，
					// 轉不動的列直接消失 —— 又是「不報錯但算錯」。
					score -= 25;
					notes.push("型別不相容（數值 vs 文字）");
				} else {
					notes.push("型別不同");
				}
			}

			out.push({
				left: String(l.name),
				right: String(r.name),
				score,
				reason: notes.join("・"),
			});
		}
	}

	// 同分時保持掃描順序（Array.sort 在 V8 是穩定的），所以左表的欄位順序
	// 會決定優先序 —— 那正好符合「先看第一欄」的直覺。
	out.sort((a, b) => b.score - a.score);

	return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 這組建議夠不夠肯定？
 *
 * 用來決定 UI 要不要主動提示。分數 < 100 表示只是名稱相近，那時候自動填入
 * 是危險的（使用者可能就照著跑了），只該當提示。
 */
export function isConfidentSuggestion(s: JoinKeySuggestion): boolean {
	return s.score >= 100;
}
