// apps/web/src/engine/cache.ts
//
// 執行快取 —— 「這個節點能不能沿用上次的結果？」
//
// 為什麼要做：目前點一個節點會**重跑整個上游子圖**。調下游參數時，上游那些
// 昂貴的掃描與聚合全部重做一次，這是畫布上最大的時間浪費。
//
// 這裡刻意只放純邏輯（雜湊、鍵推導、要不要跳過的判斷），不放任何 DuckDB 呼叫。
// 快取是「靜默錯誤」的溫床 —— 一旦判斷錯了，使用者會看到舊資料而**毫無提示**。
// 所以決策必須是純函式，能被逐條斷言。
//
// 本檔案不 import 任何東西（與 sql.ts / csv.ts 一樣），可以在 Node 裡直接測。

/**
 * 快取鍵用的雜湊（FNV-1a 32-bit）。
 *
 * 為什麼不用密碼學雜湊：這只是「兩個字串一不一樣」的指紋，不需要抗碰撞攻擊。
 * 需要的是**穩定**（同樣輸入永遠同一個輸出）與**短**。
 * 不需要 async（SubtleCrypto 是 Promise）—— 快取判斷在執行路徑上，不該多一個 await。
 */
export function stableHash(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		// FNV prime 16777619，用移位與加法避免 32-bit 溢位時的精度問題
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * 快取鍵 = 執行語句的雜湊 + 資料版本。
 *
 * **為什麼可以用 SQL 當指紋，而不必另外雜湊 config**：
 * `generateSqlFromConfig()` 的輸出是由（節點類型 + 正規化後的 config + 上游節點 id）
 * 唯一決定的 —— 它本來就是那三者的指紋。config 改了但 SQL 沒改（例如 OUTPUT 的
 * fileName），表內容本來就一樣，跳過是正確的；config 改了且 SQL 也改了，鍵自然不同。
 * 少一層推導就少一層會漂移的邏輯。
 *
 * **資料版本是必要的，不是保險**：重新上傳一個同名同欄位的 CSV，SQL 完全不變，
 * 但資料變了。少了版本號就會命中快取而餵出**舊資料**，而且不會有任何錯誤訊息。
 * 這正是快取最危險的失敗形態。
 */
export function cacheKey(statementsSql: string, dataVersion: number): string {
	return `${stableHash(statementsSql)}:${dataVersion}`;
}

/** 一次「要不要沿用」的判斷結果 */
export interface ReuseDecision {
	/** 是否跳過執行 */
	skip: boolean;
	/** 這次執行後應該記下的鍵 */
	key: string;
	/** 為什麼（會寫進執行記錄 —— 使用者要看得見「這個節點沒跑」的原因） */
	reason: string;
}

/**
 * 判斷一個節點能不能沿用上次的結果。
 *
 * 三個必須重跑的理由，順序有意義（訊息要指向最根本的原因）：
 *   1. 從來沒跑過
 *   2. 鍵變了（設定、上游、或資料版本）
 *   3. 輸出表不見了（使用者清過引擎，或換了連線）
 *
 * 任何不確定的情況一律**重跑**。快取命中錯的代價遠大於多跑一次的代價。
 */
export function decideReuse(
	key: string,
	previousKey: string | undefined,
	outputTableExists: boolean,
): ReuseDecision {
	if (previousKey === undefined) {
		return { skip: false, key, reason: "首次執行" };
	}
	if (previousKey !== key) {
		return { skip: false, key, reason: "設定、上游或資料已變更" };
	}
	if (!outputTableExists) {
		return { skip: false, key, reason: "輸出表已不存在（需重建）" };
	}
	return { skip: true, key, reason: "沿用上次結果（未變更）" };
}

/**
 * 資料版本號。
 *
 * 每次有新資料進入引擎（上傳檔案、重新註冊）就 +1，讓所有下游的快取鍵一起失效。
 * 用類別而不是模組層級的裸變數，是為了讓測試能建立獨立實例 —— 模組層級的
 * 可變狀態會讓測試之間互相污染。
 */
export class DataVersion {
	private v = 0;

	/** 回傳新的版本號 */
	bump(): number {
		this.v += 1;
		return this.v;
	}

	get current(): number {
		return this.v;
	}
}

/**
 * 引擎全域的資料版本。
 *
 * 由 ikaros 的檔案註冊路徑 bump（見 ikaros/client.ts）。刻意做成單例：
 * 資料是引擎層級的，不是某個節點或某個元件的。
 */
export const dataVersion = new DataVersion();

/**
 * 節點快取簿。
 *
 * 只記「上次跑成功的鍵」，不記結果本身 —— 結果就在 DuckDB 的表裡。
 * 執行失敗的節點**不記鍵**，所以下次一定會重跑（失敗不該被快取）。
 */
export class NodeKeyBook {
	private keys = new Map<string, string>();

	/** 查上次成功執行時的鍵；沒跑過回 undefined */
	previous(nodeId: string): string | undefined {
		return this.keys.get(nodeId);
	}

	/** 記下這次成功的鍵 */
	record(nodeId: string, key: string): void {
		this.keys.set(nodeId, key);
	}

	/**
	 * 忘記一個節點的鍵。
	 * 節點被刪除、設定被清空、或執行失敗時呼叫 —— 讓它下次一定重跑。
	 */
	forget(nodeId: string): void {
		this.keys.delete(nodeId);
	}

	/** 只保留還存在的節點（刪節點時順手清掉，避免 Map 無限長大） */
	retain(nodeIds: readonly string[]): void {
		const alive = new Set(nodeIds);
		for (const id of this.keys.keys()) {
			if (!alive.has(id)) this.keys.delete(id);
		}
	}

	get size(): number {
		return this.keys.size;
	}
}
