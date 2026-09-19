import { tableFromIPC, tableToIPC, Table, Field } from "apache-arrow";

/**
 * Ikaros Arrow Engine
 * 負責處理跨前後端 / Web Worker 之間的 Apache Arrow 資料流。
 *
 * 核心職責：把 Arrow Table 轉成「可以安全通過 structured clone」的純 JS 值。
 * 所有結果都要經 `postMessage` 從 worker 送回主線程，任何無法被 structured
 * clone 的值都會讓整個查詢失敗；任何 clone 後語意改變的值則會讓 UI 顯示錯誤數字。
 */

// 1. 將二進位 IPC Stream Buffer 轉為 Arrow Table
export function parseArrowBuffer(buffer: Uint8Array): Table {
	return tableFromIPC(buffer);
}

// 2. 將 Arrow Table 序列化為 IPC Stream 二進位陣列
export function serializeArrowTable(table: Table): Uint8Array {
	return tableToIPC(table, "stream");
}

/**
 * 把 Arrow 的 DECIMAL 值還原成 JS number。
 *
 * Arrow 以 `DecimalBigNum` 表示 DECIMAL：一個 little-endian 的 32-bit 字組陣列
 * （128-bit 精度），內容是**未縮放**的整數，且負數採二補數。
 * 例如 `1234.56::DECIMAL(10,2)` 的原始值是 `[123456, 0, 0, 0]`，scale = 2。
 *
 * 若不處理就往上傳：`DecimalBigNum` 會被 structured clone 拆成普通物件
 * `{0: 123456, 1: 0, 2: 0, 3: 0}`，於是 `1234.56` 在 UI 上顯示成 `123456`。
 *
 * 精度處理：先組成精確的十進位字串，再交給 `Number()` 做**一次**正確捨入，
 * 避免「BigInt → Number 再除」造成的二次捨入誤差。
 * （超出 Number.MAX_SAFE_INTEGER 的值仍會損失精度，與 bigint 的既有行為一致。）
 */
export function decimalToNumber(value: unknown, scale: number): number | null {
	if (value === null || value === undefined) return null;

	// 少數 arrow 版本直接回傳 bigint
	if (typeof value === "bigint") return scaleBigIntToNumber(value, scale);
	if (typeof value === "number") return value;

	// 逐字組重組 128-bit 未縮放值（little-endian）
	const words = value as ArrayLike<number>;
	const length = words?.length;
	if (typeof length !== "number" || length === 0) return Number(value);

	let unscaled = 0n;
	for (let i = length - 1; i >= 0; i--) {
		unscaled = (unscaled << 32n) | BigInt((words[i] as number) >>> 0);
	}

	// 二補數負數修正
	const bits = BigInt(length * 32);
	if (unscaled >= 1n << (bits - 1n)) unscaled -= 1n << bits;

	return scaleBigIntToNumber(unscaled, scale);
}

/** 把未縮放的整數依 scale 還原成 number（以精確字串中轉，只做一次捨入） */
function scaleBigIntToNumber(unscaled: bigint, scale: number): number {
	if (!Number.isFinite(scale) || scale <= 0) return Number(unscaled.toString());

	const negative = unscaled < 0n;
	const digits = (negative ? -unscaled : unscaled)
		.toString()
		.padStart(scale + 1, "0");
	const integerPart = digits.slice(0, -scale);
	const fractionPart = digits.slice(-scale);

	return Number(`${negative ? "-" : ""}${integerPart}.${fractionPart}`);
}

/**
 * 把單一 Arrow 值正規化成可安全跨 worker 傳遞的純 JS 值。
 *
 * 依序處理：
 *   - null / undefined 原樣保留
 *   - bigint（Int64 / Time64）→ number，否則 JSON.stringify 會直接拋錯
 *   - 其他 TypedArray（例如 Interval 的 Int32Array）→ 普通陣列
 *   - Uint8Array（BLOB）原樣保留，它本身可以被 structured clone
 *   - 巢狀型別（List → Vector、Struct → StructRow）→ 交給 Arrow 自己的 toJSON()，
 *     否則 structured clone 會因為物件帶有函式而拋錯
 */
export function normalizeArrowValue(value: unknown): unknown {
	if (value === null || value === undefined) return value;

	const type = typeof value;
	if (type === "bigint") return Number(value);
	if (type !== "object") return value;

	if (ArrayBuffer.isView(value)) {
		return value instanceof Uint8Array
			? value
			: Array.from(value as unknown as ArrayLike<number>);
	}

	const withToJSON = value as { toJSON?: () => unknown };
	if (typeof withToJSON.toJSON === "function") {
		try {
			return withToJSON.toJSON();
		} catch {
			// 個別型別的 toJSON 失敗時，寧可回傳原值也不要讓整個查詢掛掉
		}
	}

	return value;
}

/**
 * 為某一欄建立轉換器。
 *
 * 型別判斷刻意用 `String(field.type)` 而非 `instanceof`：本套件的 apache-arrow
 * 版本與 DuckDB-WASM 內嵌的 arrow 版本未必相同，跨版本的 instanceof 會失效。
 */
function makeValueConverter(field: Field | undefined): (value: unknown) => unknown {
	const typeName = String((field as { type?: unknown } | undefined)?.type ?? "");

	if (typeName.startsWith("Decimal")) {
		const scale = Number((field as { type?: { scale?: number } }).type?.scale) || 0;
		return (value) => decimalToNumber(value, scale);
	}

	return normalizeArrowValue;
}

// 3. 提取 Arrow Table 的資料供 Nymph 畫布與表格即時 Preview
export function arrowTableToJSON(table: any): Record<string, any>[] {
	const rows: Record<string, any>[] = [];
	const schema = table.schema;
	const fields: Field[] = schema.fields;

	// 每欄只判斷一次型別，不要每行重複檢查
	const converters = fields.map((field) => makeValueConverter(field));

	for (let i = 0; i < table.numRows; i++) {
		const row: Record<string, any> = {};
		for (let j = 0; j < fields.length; j++) {
			row[fields[j].name] = converters[j](table.getChildAt(j)?.get(i));
		}
		rows.push(row);
	}
	return rows;
}

// 4. 解析 Arrow Table 欄位型別與 Schema 結構
export interface ArrowColumnMetadata {
	name: string;
	type: string;
	nullable: boolean;
}

export function getArrowSchemaMetadata(table: Table): ArrowColumnMetadata[] {
	return table.schema.fields.map((field: Field) => ({
		name: field.name,
		type: field.type.toString(),
		nullable: field.nullable,
	}));
}
