// apps/web/src/engine/shareLink.ts
//
// 可分享的工作流連結。
//
// 設計要點，依重要性排序：
//
// 1. **只分享工作流，不分享資料。** 資料進 URL 會爆，而且是隱私問題。
//    檔案來源的節點在對方那邊仍然是壞的（對方沒有那個檔案）—— 這件事要講清楚，
//    不能讓人以為點了連結就什麼都有。
//
// 2. **編碼前先剝掉衍生欄位。** `sqlQuery` 是由（type + config + 上游）推導出來的，
//    匯入端本來就會重編一次（hydrateWorkflow 會呼叫 compileNodeStatements）。
//    帶著它進 URL 只是把同樣的資訊存兩份，而它剛好是體積最大的欄位 ——
//    剝掉之後連結通常小一半以上。同理 `executionState` 是執行期狀態，
//    `upstreamTables` 是查出來的 schema，兩者都不該跟著跑。
//
// 3. **超過上限就明確失敗。** 產生一條被聊天軟體截斷的連結，比產生一條
//    「太長了，請改用 JSON 匯出」的訊息糟得多 —— 前者打開後是壞的，而且
//    沒有任何線索說明為什麼。
//
// 本檔案只用 TextEncoder / TextDecoder / btoa / atob（Node ≥16 與所有現代瀏覽器
// 都有），所以可以在 Node 裡直接測。

/** 分享連結的欄位名（放在 URL fragment，不會送到伺服器） */
export const SHARE_PARAM = "w";

/**
 * 連結長度上限。
 *
 * 8000 是保守值：舊瀏覽器與部分聊天軟體的換行/截斷門檻在 2000～8000 之間。
 * 寧可早一點告訴使用者「太長了」，也不要送出一條看起來正常、打開卻壞掉的連結。
 */
export const DEFAULT_SHARE_LIMIT = 8000;

/** 節點 data 裡「由 config 推導」或「執行期才有」的欄位，不進 URL */
const DERIVED_DATA_KEYS = [
	"sqlQuery",
	"executionState",
	"upstreamTables",
	// 回呼函式不是資料，序列化時本來就會消失；列出來是為了讓意圖明確
	"onExecute",
	"onChangeConfig",
];

/**
 * 把工作流轉成「可分享」的形狀：只留真正需要存下來的東西。
 *
 * 回傳的是新物件，不動輸入 —— 呼叫端可能還要用原本的那一份。
 */
export function toShareable(workflow: unknown): unknown {
	if (!workflow || typeof workflow !== "object") return workflow;
	const wf = workflow as Record<string, unknown>;
	const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];

	return {
		...wf,
		nodes: nodes.map((n) => {
			if (!n || typeof n !== "object") return n;
			const node = n as Record<string, unknown>;
			const data = (node.data ?? {}) as Record<string, unknown>;
			const slim: Record<string, unknown> = { ...data };
			for (const k of DERIVED_DATA_KEYS) delete slim[k];
			return { ...node, data: slim };
		}),
	};
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	// base64url：+ → -、/ → _、去掉 = 填充（fragment 裡不需要，而且會被轉義）
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
	// 還原標準 base64 的字母表與填充
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export interface ShareEncodeResult {
	ok: boolean;
	/** 成功時的 token（不含 `#w=` 前綴） */
	token?: string;
	/** token 的長度，方便 UI 顯示 */
	length?: number;
	error?: string;
}

/**
 * 把工作流編成一條連結用的 token。
 *
 * 失敗一律回 `{ok:false, error}`，不拋錯 —— 呼叫端要能把它顯示給使用者，
 * 而不是讓整個元件爆掉。
 */
export function encodeShareLink(
	workflow: unknown,
	limit: number = DEFAULT_SHARE_LIMIT,
): ShareEncodeResult {
	let json: string;
	try {
		json = JSON.stringify(toShareable(workflow));
	} catch (err: any) {
		return { ok: false, error: `工作流無法序列化：${err?.message || err}` };
	}
	if (!json || json === "null") {
		return { ok: false, error: "沒有可分享的內容" };
	}

	let token: string;
	try {
		token = bytesToBase64Url(new TextEncoder().encode(json));
	} catch (err: any) {
		return { ok: false, error: `編碼失敗：${err?.message || err}` };
	}

	if (token.length > limit) {
		return {
			ok: false,
			length: token.length,
			error: `連結長度 ${token.length} 字元，超過上限 ${limit} —— 請改用「匯出工作流 JSON」傳檔`,
		};
	}
	return { ok: true, token, length: token.length };
}

export interface ShareDecodeResult {
	ok: boolean;
	workflow?: unknown;
	error?: string;
}

/**
 * 解開一條 token。
 *
 * 這裡只做「是不是一個看起來像工作流的物件」的檢查 —— 真正的欄位驗證是
 * importWorkflowJson 的職責，不要在這裡抄第二份。
 */
export function decodeShareLink(token: unknown): ShareDecodeResult {
	const raw = String(token ?? "").trim();
	if (!raw) return { ok: false, error: "連結裡沒有工作流內容" };

	let json: string;
	try {
		json = new TextDecoder().decode(base64UrlToBytes(raw));
	} catch {
		// atob 對非 base64 字元會拋 —— 使用者手動改過連結就會走到這裡
		return { ok: false, error: "連結內容不是有效的編碼（可能被截斷或修改過）" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { ok: false, error: "連結內容不是有效的 JSON" };
	}

	if (!parsed || typeof parsed !== "object") {
		return { ok: false, error: "連結內容不是一個工作流" };
	}
	const wf = parsed as Record<string, unknown>;
	if (!Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
		return { ok: false, error: "連結內容缺少 nodes 或 edges" };
	}

	return { ok: true, workflow: parsed };
}

/**
 * 從一個 URL 取出分享 token。
 *
 * 只讀 fragment（`#` 之後）—— fragment 不會送到伺服器，所以工作流內容
 * 不會出現在任何 access log 裡。這也是刻意不用 query string 的原因。
 */
export function readShareToken(url: string): string | null {
	const s = String(url ?? "");
	const hashAt = s.indexOf("#");
	if (hashAt < 0) return null;
	const hash = s.slice(hashAt + 1);
	for (const part of hash.split("&")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq) === SHARE_PARAM) {
			const v = part.slice(eq + 1).trim();
			return v || null;
		}
	}
	return null;
}

/** 產生要貼給別人的完整連結 */
export function buildShareUrl(
	baseUrl: string,
	token: string,
): string {
	const base = String(baseUrl ?? "").split("#")[0];
	return `${base}#${SHARE_PARAM}=${token}`;
}
