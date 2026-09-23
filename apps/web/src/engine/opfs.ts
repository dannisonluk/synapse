// apps/web/src/engine/opfs.ts
//
// 把上傳的檔案存進 OPFS（Origin Private File System）。
//
// 為什麼需要：目前重新載入頁面之後，引擎裡的表全部消失，而工作流還原了 ——
// 於是一張圖看起來好好的，執行起來每個 Input 節點都失敗。使用者唯一的補救是
// 把檔案重新上傳一次，而且**每次重新載入都要重做**。
//
// OPFS 是瀏覽器給每個 origin 的私有檔案系統：不會出現在使用者的檔案總管裡、
// 不經過網路、也有配額。它正好對應「這個網站自己留著的檔案」這個用途。
//
// 純邏輯（feature 偵測、鍵名、大小上限）與瀏覽器 API 分開放 ——
// 前者可以在 Node 裡斷言，後者不行。
//
// 本檔案只 import 型別，可以在 Node 裡直接測。

/** 只用到這幾個方法，所以測試可以注入假的 */
export interface OpfsLike {
	write(name: string, bytes: Uint8Array): Promise<void>;
	read(name: string): Promise<Uint8Array | null>;
	list(): Promise<string[]>;
	remove(name: string): Promise<void>;
}

/**
 * 單一檔案的大小上限。
 *
 * 64 MB 是刻意的保守值：OPFS 的配額是「origin 整體」的，而瀏覽器可以在
 * 任何時候清除它。把一個 2 GB 的 CSV 塞進去，結果是**整個 origin 的儲存被清掉**，
 * 連帶影響自動存檔。寧可一開始就不存大檔，也不要製造一個「有時候會全部不見」
 * 的狀態。
 */
export const MAX_PERSIST_BYTES = 64 * 1024 * 1024;

/** 這個檔案值不值得持久化？ */
export function shouldPersist(bytes: number): boolean {
	return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_PERSIST_BYTES;
}

/** OPFS 的檔名前綴。加前綴是為了不與未來的其他用途混在一起 */
export const FILE_PREFIX = "synapse-upload-";

/** 表名 + 原始檔名 → OPFS 檔名 */
function sanitiseTable(tableName: unknown): string {
	return String(tableName ?? "")
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.slice(0, 120);
}

/**
 * 表名 → OPFS 檔名，**帶上原來的副檔名**。
 *
 * 為什麼副檔名要留：還原時引擎要靠它決定用 CSV 還是 Parquet 讀取器
 * （見 core.ts 的 REGISTER_FILE）。把一個 Parquet 檔還原成 `.csv`，
 * 結果是解析失敗或更糟 —— 解析成功但內容是垃圾。
 */
export function opfsFileName(tableName: unknown, originalName: unknown): string {
	const table = sanitiseTable(tableName);
	if (!table) return "";
	const ext = /\.parquet$/i.test(String(originalName ?? "")) ? "parquet" : "csv";
	return `${FILE_PREFIX}${table}.${ext}`;
}

export interface PersistedFile {
	/** 引擎裡的表名 */
	table: string;
	/** 還原時要傳給引擎的檔名（決定讀取器） */
	fileName: string;
}

/**
 * OPFS 檔名 → 表名與還原用檔名；不是我們的檔就回 null。
 *
 * 兩個拒絕條件：
 *   1. 副檔名不在白名單內 —— 引擎只認得 CSV / Parquet
 *   2. **表名必須是 `sanitiseTable` 的固定點**（過一次不變）
 *
 * 第 2 點是對稱性：解析器只接受寫入器可能產生的名字。少了它，
 * `synapse-upload-..%2Fetc.csv` 會被解析成表名 `..%2Fetc` ——
 * 那樣的檔案不可能是 `opfsFileName` 寫出來的，所以它是別的東西留下的，
 * 或者被人手動改過。兩種情況都不該餵給引擎。
 */
export function parseOpfsFile(fileName: unknown): PersistedFile | null {
	const s = String(fileName ?? "");
	if (!s.startsWith(FILE_PREFIX)) return null;
	const rest = s.slice(FILE_PREFIX.length);
	const dot = rest.lastIndexOf(".");
	if (dot <= 0) return null;
	const table = rest.slice(0, dot);
	const ext = rest.slice(dot + 1).toLowerCase();
	if (ext !== "csv" && ext !== "parquet") return null;
	// 表名必須已經正規化過（寫入器會做的事，這裡要求它已經做過）
	if (!table || sanitiseTable(table) !== table) return null;
	return { table, fileName: `${table}.${ext}` };
}

/**
 * 這個環境有沒有 OPFS？
 *
 * 用 `navigator.storage.getDirectory` 的存在與否判斷，而不是看瀏覽器名稱 ——
 * 無痕模式、舊版 Safari、以及非瀏覽器環境都會缺這個方法。
 */
export function opfsSupported(nav?: unknown): boolean {
	const n = (nav ?? (globalThis as any).navigator) as any;
	try {
		return typeof n?.storage?.getDirectory === "function";
	} catch {
		// 某些瀏覽器在停用儲存時，光是存取 navigator.storage 就會拋
		return false;
	}
}

/**
 * 建立一個真的 OPFS 存取層。
 *
 * 所有方法都**不拋錯**：OPFS 失敗（配額、無痕模式、使用者清過）不該讓
 * 上傳流程跟著失敗 —— 檔案已經進引擎了，持久化只是加分。
 */
export async function createOpfs(): Promise<OpfsLike | null> {
	if (!opfsSupported()) return null;
	try {
		const root = await (navigator as any).storage.getDirectory();
		return {
			async write(name, bytes) {
				const handle = await root.getFileHandle(name, { create: true });
				const writable = await handle.createWritable();
				// 一定要 copy：直接把 Uint8Array 交給 writable 之後呼叫端仍可能改動它
				await writable.write(bytes.slice());
				await writable.close();
			},
			async read(name) {
				try {
					const handle = await root.getFileHandle(name);
					const file = await handle.getFile();
					return new Uint8Array(await file.arrayBuffer());
				} catch {
					return null;
				}
			},
			async list() {
				const out: string[] = [];
				for await (const [name] of root.entries()) out.push(name);
				return out;
			},
			async remove(name) {
				try {
					await root.removeEntry(name);
				} catch {
					// 不存在就當作成功
				}
			},
		};
	} catch {
		return null;
	}
}
