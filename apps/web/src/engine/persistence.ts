// apps/web/src/engine/persistence.ts
// 畫布自動存檔（autosave）—— 目前唯一的持久化來源。
//
// 為什麼需要：整個畫布狀態只活在 React state 裡，一次重新載入
// （或一次未攔截的 render 例外）就全部消失。
//
// 設計取捨：
//   - 只存 exportWorkflowJson() 的輸出（已經是經過驗證的序列化格式），
//     不另外發明第二套格式 —— 這樣「手動存檔 / 手動讀檔 / 自動還原」永遠一致。
//   - key 帶版本：格式一旦不相容就換 key，寧可讓舊資料靜靜失效，
//     也不要在載入時丟出難以理解的錯誤。
//   - 所有操作都包 try/catch：storage 可能被停用（無痕模式）或配額爆滿，
//     持久化失敗不應該讓整個 app 壞掉。
//   - storage 可注入，所以這個模組可以在 Node 裡被單元測試（見 scripts/verify.mjs）。

/** 只用到這三個方法，因此不必依賴 DOM 的 Storage 型別 */
export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export const AUTOSAVE_KEY = "synapse.workflow.autosave.v1";

export interface SaveResult {
	ok: boolean;
	error?: string;
}

/** 瀏覽器預設 storage；不可用（SSR / 停用）時回傳 null */
export function defaultStorage(): StorageLike | null {
	try {
		return typeof window !== "undefined" && window.localStorage
			? window.localStorage
			: null;
	} catch {
		// 某些瀏覽器在停用 cookie 時，光是存取 localStorage 就會拋錯
		return null;
	}
}

/** 讀回自動存檔的原始 JSON 字串；沒有存檔、無法讀取 → null */
export function loadAutosave(storage = defaultStorage()): string | null {
	if (!storage) return null;
	try {
		return storage.getItem(AUTOSAVE_KEY);
	} catch {
		return null;
	}
}

export function saveAutosave(
	json: string,
	storage = defaultStorage(),
): SaveResult {
	if (!storage) return { ok: false, error: "storage 不可用" };
	try {
		storage.setItem(AUTOSAVE_KEY, json);
		return { ok: true };
	} catch (err: any) {
		// 配額爆滿（QuotaExceededError）是最常見的情況
		return { ok: false, error: err?.message || String(err) };
	}
}

export function clearAutosave(storage = defaultStorage()): void {
	if (!storage) return;
	try {
		storage.removeItem(AUTOSAVE_KEY);
	} catch {
		// 清不掉也不影響功能
	}
}
