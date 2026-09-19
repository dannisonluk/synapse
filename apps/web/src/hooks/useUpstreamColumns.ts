// apps/web/src/hooks/useUpstreamColumns.ts
// 讀取上游節點輸出表的欄位清單，讓 config 表單可以做成 dropdown。
//
// 為什麼放在 hooks/ 而不是 engine/：engine/ 底下的模組必須能在 Node 裡
// 直接 import 來做驗證（見 scripts/verify.mjs），所以不能依賴 React。
//
// 設計：查詢失敗（表還不存在、尚未執行）一律安靜地回傳空陣列 ——
// 表單會退回自由文字輸入，而不是讓整個節點爆掉。
import { useEffect, useState } from "react";
import { ikaros } from "../engine/ikaros/client";

export interface UpstreamColumn {
	name: string;
	type: string;
}

export interface UpstreamSchema {
	/** 各上游表自己的欄位（順序與傳入的 tables 一致），JOIN 需要分開看 */
	byTable: UpstreamColumn[][];
	/** 去重後的聯集，順序沿用上游表順序 */
	columns: UpstreamColumn[];
	loading: boolean;
}

/** 穩定的空陣列 sentinel —— 避免每次 render 都產生新陣列當 dependency */
const NO_TABLES: string[] = [];

export function useUpstreamColumns(
	tables: string[] | undefined,
	refreshKey?: unknown,
): UpstreamSchema {
	const [byTable, setByTable] = useState<UpstreamColumn[][]>([]);
	const [loading, setLoading] = useState(false);

	// tables 每次 render 都是新陣列 → 用字串當 dependency key
	const key = (tables || NO_TABLES).join("|");

	useEffect(() => {
		let cancelled = false;
		const list = (tables || NO_TABLES).filter(Boolean);

		if (list.length === 0) {
			setByTable([]);
			setLoading(false);
			return;
		}

		setLoading(true);
		(async () => {
			const perTable: UpstreamColumn[][] = [];
			try {
				for (const table of list) {
					try {
						const cols = await ikaros.describe(table);
						perTable.push(
							cols
								.filter((c) => Boolean(c.name))
								.map((c) => ({
									name: c.name,
									type: c.type || "UNKNOWN",
								})),
						);
					} catch {
						// 表還不存在（上游未執行）→ 這張表就是空的
						perTable.push([]);
					}
				}
				if (!cancelled) setByTable(perTable);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, refreshKey]);

	// 聯集（同名欄位只留第一個 —— JOIN 的右表衝突欄位會被 DuckDB 加 _1 後綴，
	// 這裡刻意不去猜後綴，讓使用者自己看 schema 決定）
	const columns: UpstreamColumn[] = [];
	const seen = new Set<string>();
	for (const list of byTable) {
		for (const col of list) {
			if (seen.has(col.name)) continue;
			seen.add(col.name);
			columns.push(col);
		}
	}

	return { byTable, columns, loading };
}
