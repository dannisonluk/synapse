import { tableFromIPC, tableToIPC, Table, Field } from "apache-arrow";

/**
 * Ikaros Arrow Engine
 * 負責處理跨前後端 / Web Worker 之間的 Apache Arrow 零拷貝 (Zero-Copy) 二進位數據流
 */

// 1. 將二進位 IPC Stream Buffer 轉為 Arrow Table
export function parseArrowBuffer(buffer: Uint8Array): Table {
	return tableFromIPC(buffer);
}

// 2. 將 Arrow Table 序列化為 IPC Stream 二進位陣列
export function serializeArrowTable(table: Table): Uint8Array {
	return tableToIPC(table, "stream");
}

// 3. 提取 Arrow Table 前 N 筆資料供 Nymph 畫布與表格即時 Preview
export function arrowTableToJSON(table: any): Record<string, any>[] {
	const rows: Record<string, any>[] = [];
	const schema = table.schema;

	for (let i = 0; i < table.numRows; i++) {
		const row: Record<string, any> = {};
		for (let j = 0; j < schema.fields.length; j++) {
			const field = schema.fields[j];
			let val = table.getChildAt(j)?.get(i);

			// 🎯 將 BigInt 安全轉為 Number，防止 JSON.stringify 崩潰
			if (typeof val === "bigint") {
				val = Number(val);
			}
			row[field.name] = val;
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
