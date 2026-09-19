// apps/web/src/engine/ikaros/client.ts
// Ikaros 前端入口 —— 對 UI 而言只是一組 async 方法，完全不知道 DuckDB 在哪一條 thread。
//
// 正常：所有工作在 Web Worker（worker.ts）—— main thread 零 WASM、零大結果集 materialization。
// 例外：瀏覽器不支援 nested worker（DuckDB 自身也要建立 worker）→ 自動 fallback
//       至 main thread，並記錄原因供 UI 顯示。此 fallback 保證功能不會因環境而完全喪失。
import { createCore, dispatch } from "./dispatch";
import { DEFAULT_MAX_ROWS, type IkarosCore } from "./core";

export type { ColumnInfo, PageResult, FileRegistration } from "./core";
export { DEFAULT_MAX_ROWS } from "./core";

import type { ColumnInfo, PageResult, FileRegistration } from "./core";

export type EngineMode = "worker" | "main-thread" | "unknown";

interface Pending {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

interface Transport {
	post(message: any, transfer?: Transferable[]): void;
	subscribe(handler: (message: any) => void): void;
	dispose(): void;
}

/** 致命錯誤 sentinel：transport 本身已失效，所有 in-flight request 都要立即失敗 */
const FATAL_ID = -1;

// ---------------------------------------------------------------------------
// Transport A：真 Web Worker
// ---------------------------------------------------------------------------
class WorkerTransport implements Transport {
	private worker: Worker;
	private handlers: Array<(message: any) => void> = [];

	constructor() {
		this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
			name: "ikaros-engine",
		});
		this.worker.onmessage = (ev: MessageEvent) => {
			this.emit(ev.data);
		};
		this.worker.onerror = (ev: ErrorEvent) => {
			this.emit({
				id: FATAL_ID,
				ok: false,
				error: ev?.message || "Ikaros worker 載入失敗",
			});
		};
		this.worker.onmessageerror = () => {
			this.emit({
				id: FATAL_ID,
				ok: false,
				error: "Ikaros worker 訊息無法反序列化",
			});
		};
	}

	private emit(message: any) {
		for (const handler of this.handlers) handler(message);
	}

	post(message: any, transfer?: Transferable[]) {
		this.worker.postMessage(message, transfer ?? []);
	}

	subscribe(handler: (message: any) => void) {
		this.handlers.push(handler);
	}

	dispose() {
		try {
			this.worker.terminate();
		} catch {
			/* already gone */
		}
	}
}

// ---------------------------------------------------------------------------
// Transport B：主線程 fallback（同 worker 用同一份 dispatch，行為一致）
// ---------------------------------------------------------------------------
class LocalTransport implements Transport {
	private handlers: Array<(message: any) => void> = [];
	private corePromise: Promise<IkarosCore> | null = null;

	private getCore(): Promise<IkarosCore> {
		if (!this.corePromise) this.corePromise = createCore();
		return this.corePromise;
	}

	post(message: any) {
		void (async () => {
			try {
				const core = await this.getCore();
				const result = await dispatch(core, String(message.op), message);
				this.emit({ id: message.id, ok: true, ...result });
			} catch (err: any) {
				this.emit({
					id: message.id,
					ok: false,
					error: err?.message || String(err),
				});
			}
		})();
	}

	private emit(message: any) {
		for (const handler of this.handlers) handler(message);
	}

	subscribe(handler: (message: any) => void) {
		this.handlers.push(handler);
	}

	dispose() {
		this.handlers = [];
	}
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
class IkarosEngine {
	private transport: Transport | null = null;
	private readyPromise: Promise<void> | null = null;
	private pending = new Map<number, Pending>();
	private seq = 0;

	private _mode: EngineMode = "unknown";
	private _error: string | null = null;
	private _workerError: string | null = null;

	/** 等初始化完成；失敗會 reject。 */
	get ready(): Promise<void> {
		if (!this.readyPromise) this.readyPromise = this.init();
		return this.readyPromise;
	}

	/** DuckDB 實際執行於何處："worker" 為正常、"main-thread" 為 fallback。 */
	get mode(): EngineMode {
		return this._mode;
	}

	get error(): string | null {
		return this._error;
	}

	/** Worker 路徑失敗的原因（若為 fallback 則有值）。 */
	get workerError(): string | null {
		return this._workerError;
	}

	private attach(transport: Transport) {
		this.transport = transport;
		transport.subscribe((message) => this.receive(message));
	}

	private receive(message: any) {
		if (!message || typeof message !== "object") return;

		// transport 本身已失效 → 不可等待 timeout，立即拒絕所有等待中的請求
		if (message.id === FATAL_ID) {
			const error = new Error(message.error || "Ikaros transport 失敗");
			const waiting = [...this.pending.values()];
			this.pending.clear();
			waiting.forEach((p) => p.reject(error));
			return;
		}

		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.ok === false) {
			pending.reject(new Error(message.error || "Ikaros 請求失敗"));
		} else {
			pending.resolve(message);
		}
	}

	private request(
		op: string,
		payload: Record<string, any> = {},
		transfer?: Transferable[],
		timeoutMs = 30_000,
	): Promise<any> {
		const transport = this.transport;
		if (!transport) {
			return Promise.reject(new Error("Ikaros transport 尚未建立"));
		}
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Ikaros ${op} 逾時（${timeoutMs}ms）`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				transport.post({ id, op, ...payload }, transfer);
			} catch (err: any) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private async init(): Promise<void> {
		// ---- 1) 首選：Web Worker -------------------------------------------
		try {
			const workerTransport = new WorkerTransport();
			this.attach(workerTransport);
			await this.request("INIT", {}, undefined, 60_000);
			this._mode = "worker";
			return;
		} catch (err: any) {
			this._workerError = err?.message || String(err);
			console.warn(
				`[Ikaros] Web Worker 路徑不可用，改用主線程 fallback：${this._workerError}`,
			);
			this.pending.clear();
			try {
				this.transport?.dispose();
			} catch {
				/* ignore */
			}
			this.transport = null;
		}

		// ---- 2) Fallback：主線程 --------------------------------------------
		try {
			const local = new LocalTransport();
			this.attach(local);
			await this.request("INIT", {}, undefined, 60_000);
			this._mode = "main-thread";
		} catch (err: any) {
			this._error = err?.message || String(err);
			throw err;
		}
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/** 執行 SQL 並回傳 JSON 行（最多 maxRows 行，預設 5000） */
	async query(sql: string, maxRows: number = DEFAULT_MAX_ROWS): Promise<any[]> {
		const res = await this.queryDetailed(sql, maxRows);
		return res.rows;
	}

	async queryDetailed(
		sql: string,
		maxRows: number = DEFAULT_MAX_ROWS,
	): Promise<{ rows: any[]; truncated: boolean; totalRows: number }> {
		await this.ready;
		const res = await this.request("EXEC", { sql, maxRows });
		return {
			rows: res.rows ?? [],
			truncated: Boolean(res.truncated),
			totalRows: Number(res.totalRows ?? 0),
		};
	}

	/** 執行 DDL/DML，只回傳受影響行數（不會搬運任何資料過來） */
	async exec(sql: string): Promise<number> {
		await this.ready;
		const res = await this.request("EXEC_DDL", { sql });
		return Number(res.rowCount ?? 0);
	}

	/** 讀取表的欄位型別 */
	async describe(tableName: string): Promise<ColumnInfo[]> {
		await this.ready;
		const res = await this.request("DESCRIBE", { table: tableName });
		return res.columns ?? [];
	}

	/**
	 * SQL 側分頁 + 搜尋。
	 * main thread 只會收到 limit 行 → 即使底層是 100 萬行也不會 freeze。
	 */
	async page(
		tableName: string,
		opts: { offset?: number; limit?: number; search?: string } = {},
	): Promise<PageResult> {
		await this.ready;
		const res = await this.request("PAGE", {
			table: tableName,
			offset: opts.offset ?? 0,
			limit: opts.limit ?? 100,
			search: opts.search ?? "",
		});
		return {
			columns: res.columns ?? [],
			rows: res.rows ?? [],
			total: Number(res.total ?? 0),
		};
	}

	/** 列出 DuckDB 內所有表 */
	async tables(): Promise<string[]> {
		await this.ready;
		const res = await this.request("TABLES", {});
		return res.tables ?? [];
	}

	/**
	 * 將本機檔案載入 DuckDB。
	 * ArrayBuffer 以 transferable 傳入 worker（零拷貝），
	 * CSV/Parquet 的解析工作全部在 worker thread 進行。
	 */
	async registerLocalFile(
		file: File,
		tableName: string,
	): Promise<FileRegistration> {
		await this.ready;
		const bytes = await file.arrayBuffer();
		const res = await this.request(
			"REGISTER_FILE",
			{ table: tableName, fileName: file.name, bytes },
			[bytes],
		);
		return {
			rowCount: Number(res.rowCount ?? 0),
			columns: res.columns ?? [],
		};
	}
}

export const ikaros = new IkarosEngine();
