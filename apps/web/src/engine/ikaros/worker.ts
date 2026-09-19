// apps/web/src/engine/ikaros/worker.ts
// Ikaros Web Worker —— DuckDB-WASM 真正的宿主。
//
// 這個檔案以前是死 code（client.ts 直接在 main thread 開啟 AsyncDuckDB，worker 從未被載入）。
// 現在：DuckDB 引擎、CSV 解析、結果集 materialization 全部在這條 thread 發生，
// main thread 只收「已經有界」的結果 → 百萬行 CSV 不會再 freeze UI。
//
// 協議（request/response by id）：
//   in : { id, op, ...payload }
//   out: { id, ok: true, ...payload } | { id, ok: false, error: string }
import { createCore, dispatch } from "./dispatch";
import type { IkarosCore } from "./core";

interface WorkerScope {
	onmessage: ((ev: MessageEvent) => void) | null;
	postMessage(message: any, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;

let corePromise: Promise<IkarosCore> | null = null;

function getCore(): Promise<IkarosCore> {
	if (!corePromise) {
		corePromise = createCore().catch((err) => {
			corePromise = null; // 容許下次重試（例如 wasm 網絡重試）
			throw err;
		});
	}
	return corePromise;
}

ctx.onmessage = async (ev: MessageEvent) => {
	const msg = ev.data;
	if (!msg || typeof msg !== "object") return;
	const { id, op, ...payload } = msg;

	try {
		const core = await getCore();
		const result = await dispatch(core, String(op), payload);
		ctx.postMessage({ id, ok: true, ...result });
	} catch (err: any) {
		ctx.postMessage({ id, ok: false, error: err?.message || String(err) });
	}
};
