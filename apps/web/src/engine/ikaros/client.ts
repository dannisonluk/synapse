import { parseArrowBuffer, arrowTableToJSON } from "@synapse/ikaros-arrow";

export class IkarosClient {
	private worker: Worker;
	private pendingRequests = new Map<
		string,
		{ resolve: Function; reject: Function }
	>();

	constructor() {
		this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});
		this.worker.onmessage = this.handleMessage.bind(this);
	}

	public async init(): Promise<void> {
		return this.sendRequest("INIT", {});
	}

	public async registerCSV(
		tableName: string,
		csvContent: string,
	): Promise<any> {
		return this.sendRequest("REGISTER_CSV", { tableName, csvContent });
	}

	public async query(sql: string): Promise<Record<string, any>[]> {
		const rawResult = await this.sendRequest("EXECUTE_SQL", { sql });
		const arrowTable = parseArrowBuffer(new Uint8Array(rawResult));
		return arrowTableToJSON(arrowTable);
	}

	private handleMessage(e: MessageEvent) {
		const { id, type, result, error } = e.data;

		// 處理異步 Promise 狀態
		if (this.pendingRequests.has(id)) {
			const { resolve, reject } = this.pendingRequests.get(id)!;
			if (error || type === "IKAROS_ERROR") {
				reject(new Error(error || "Ikaros execution error"));
			} else {
				if (type === "IKAROS_READY") {
					console.log(
						"⚡ [Ikaros Engine] DuckDB-WASM Initialized Successfully!",
					);
				}
				resolve(result);
			}
			this.pendingRequests.delete(id);
		}
	}

	private sendRequest(type: string, payload: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = Math.random().toString(36).substring(2, 9);
			this.pendingRequests.set(id, { resolve, reject });
			this.worker.postMessage({ id, type, payload });
		});
	}
}

export const ikaros = new IkarosClient();
