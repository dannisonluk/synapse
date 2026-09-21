// apps/web/src/engine/csv.ts
//
// 把查詢結果序列化成 CSV —— OUTPUT 節點的下載用。
//
// 為什麼獨立成一個沒有 React 依賴的模組：CSV 的轉義規則很容易寫錯，而寫錯的
// 症狀是「Excel 打開來欄位跑掉」，不會有任何錯誤訊息。獨立出來才能在 Node 裡
// 直接斷言（見 scripts/verify.mjs 的 toCsv 那幾條）。
//
// 這裡刻意不 import 任何東西 —— 與 sql.ts 一樣，可以被 worker 安全引用。

/** CSV 的欄位值轉義：含分隔符、引號、換行就整個包起來，內部的引號加倍 */
export function csvCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	const s = String(value);
	if (!/[",\r\n]/.test(s)) return s;
	return `"${s.replace(/"/g, '""')}"`;
}

/**
 * 序列化成 CSV 文字。
 *
 * @param rows   查詢結果（每個物件是一個列）
 * @param columns 欄位順序。省略時取第一列的鍵 —— 但明確給順序更安全，
 *                因為查詢結果的欄位順序才是使用者看到的順序。
 * @param delimiter 分隔符，預設逗號
 */
export function toCsv(
	rows: readonly Record<string, unknown>[],
	columns?: readonly string[],
	delimiter = ",",
): string {
	const cols =
		columns && columns.length > 0
			? [...columns]
			: rows.length > 0
				? Object.keys(rows[0])
				: [];
	// 零欄位 = 沒東西可寫。若照下面的邏輯走，表頭會是空字串，最後變成
	// 一個孤零零的換行 —— 下載下來是一個「有內容但沒有欄位」的檔案。
	if (cols.length === 0) return "";
	const lines: string[] = [];
	// 表頭也要轉義：欄位名可能含逗號（"last, first"）或引號
	lines.push(cols.map(csvCell).join(delimiter));
	for (const row of rows) {
		lines.push(cols.map((c) => csvCell(row[c])).join(delimiter));
	}
	// 結尾補一個換行：很多工具（含 Excel）對沒有結尾換行的最後一列處理不一致
	return `${lines.join("\r\n")}\r\n`;
}
