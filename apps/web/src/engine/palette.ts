// apps/web/src/engine/palette.ts
//
// 命令面板（⌘K）的搜尋與排序。
//
// 為什麼要有：28 種節點用拖的已經開始吃力，而且「執行 / 匯出 / 跳到某個節點」
// 目前只能靠滑鼠。
//
// 語料是現成的：nodeCatalog 的 `whenToUse` 本來就是寫給 LLM 看的自然語言描述
// （「使用者說『輸出 / 下載 / 匯出成檔案』時」），拿來做關鍵字搜尋剛好 ——
// 使用者打的字跟那句話本來就是同一種語言。
//
// 不引入模糊搜尋套件：28 個候選用「完全相符 > 前綴 > 子字串 > 說明命中」的
// 分層排序就夠，而且零依賴 = 可以在 Node 裡逐條斷言排序結果。
//
// 本檔案不 import 任何東西，可以在 Node 裡直接測。

/** 搜尋語料。刻意只要求這幾個欄位 —— 呼叫端可以傳 nodeCatalog 的條目進來 */
export interface PaletteCandidate {
	type: string;
	label: string;
	category: string;
	description?: string;
	whenToUse?: string;
}

/** 命中在哪個欄位。讓 UI 能解釋「為什麼這個結果會出現」 */
export type PaletteMatchField = "type" | "label" | "description" | "whenToUse";

export interface PaletteHit {
	type: string;
	label: string;
	category: string;
	score: number;
	matchedOn: PaletteMatchField;
}

/**
 * 單一詞彙對單一候選的評分。
 *
 * 分數刻意拉開層級，而不是用編輯距離：使用者打「join」時要看到 JOIN 排第一，
 * 而不是某個說明裡剛好提到 join 的節點。距離演算法會把這兩者混在一起。
 */
function scoreTerm(
	term: string,
	label: string,
	type: string,
	description: string,
	whenToUse: string,
): { score: number; field: PaletteMatchField } | null {
	if (label === term) return { score: 100, field: "label" };
	if (type === term) return { score: 95, field: "type" };
	if (label.startsWith(term)) return { score: 80, field: "label" };
	if (type.startsWith(term)) return { score: 70, field: "type" };
	if (label.includes(term)) return { score: 60, field: "label" };
	if (type.includes(term)) return { score: 50, field: "type" };
	if (description.includes(term)) return { score: 30, field: "description" };
	if (whenToUse.includes(term)) return { score: 20, field: "whenToUse" };
	return null;
}

/**
 * 排序候選節點。
 *
 * 多詞查詢採 **AND**（每個詞都要命中至少一個欄位）：打「fuzzy join」時，
 * 只有 FUZZY_JOIN 該出現，不該把 JOIN 也撈進來 —— 這跟 fallback 那條
 * 「更specific 者勝」的規則是同一個道理。
 *
 * @param limit 最多回幾個。0 或負數 = 不限。
 */
export function rankNodeTypes(
	query: string,
	candidates: readonly PaletteCandidate[],
	limit = 8,
): PaletteHit[] {
	const q = String(query ?? "").trim().toLowerCase();

	// 空查詢 = 列出全部（讓 UI 可以依分類分組顯示，而不是一片空白）
	if (!q) {
		const all = candidates.map((c) => ({
			type: c.type,
			label: c.label,
			category: c.category,
			score: 0,
			matchedOn: "label" as PaletteMatchField,
		}));
		return limit > 0 ? all.slice(0, limit) : all;
	}

	const terms = q.split(/\s+/).filter(Boolean);
	const hits: PaletteHit[] = [];

	for (const c of candidates) {
		const label = String(c.label ?? "").toLowerCase();
		const type = String(c.type ?? "").toLowerCase();
		const description = String(c.description ?? "").toLowerCase();
		const whenToUse = String(c.whenToUse ?? "").toLowerCase();

		let total = 0;
		let matchedOn: PaletteMatchField | null = null;
		let allTermsHit = true;

		for (const term of terms) {
			const s = scoreTerm(term, label, type, description, whenToUse);
			if (!s) {
				allTermsHit = false;
				break;
			}
			total += s.score;
			// 記錄**第一個**詞的命中欄位：它通常是使用者真正在打的那個詞
			if (matchedOn === null) matchedOn = s.field;
		}

		if (!allTermsHit) continue;
		hits.push({
			type: c.type,
			label: c.label,
			category: c.category,
			score: total,
			matchedOn: matchedOn ?? "label",
		});
	}

	// 分數高的在前；同分時標籤短的在前（更精確的命中）。
	// Array.sort 在 V8 是穩定的，所以完全同分時會保持目錄順序（= 分類順序）。
	hits.sort((a, b) => b.score - a.score || a.label.length - b.label.length);

	return limit > 0 ? hits.slice(0, limit) : hits;
}

/** 一個面板動作（不是節點，而是「執行 / 匯出 / 跳到某節點」之類） */
export interface PaletteAction {
	id: string;
	label: string;
	/** 顯示在右邊的提示，例如鍵盤快捷鍵或說明 */
	hint?: string;
	keywords?: string;
}

/** 依同樣的分層規則排序動作。動作數量少，所以不需要分組 */
export function rankActions(
	query: string,
	actions: readonly PaletteAction[],
	limit = 5,
): PaletteAction[] {
	const q = String(query ?? "").trim().toLowerCase();
	if (!q) return limit > 0 ? actions.slice(0, limit) : [...actions];

	const terms = q.split(/\s+/).filter(Boolean);
	const scored: { action: PaletteAction; score: number }[] = [];

	for (const a of actions) {
		const label = String(a.label ?? "").toLowerCase();
		const keywords = String(a.keywords ?? "").toLowerCase();
		let total = 0;
		let ok = true;
		for (const term of terms) {
			const s = scoreTerm(term, label, a.id.toLowerCase(), keywords, keywords);
			if (!s) {
				ok = false;
				break;
			}
			total += s.score;
		}
		if (ok) scored.push({ action: a, score: total });
	}

	scored.sort((a, b) => b.score - a.score || a.action.label.length - b.action.label.length);
	return (limit > 0 ? scored.slice(0, limit) : scored).map((s) => s.action);
}
