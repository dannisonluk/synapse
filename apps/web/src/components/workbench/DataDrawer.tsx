import React, { useEffect, useRef, useState } from "react";
import {
	Sliders,
	Table as TableIcon,
	Database,
	Search,
	Terminal,
	SkipForward,
	SkipBack,
} from "lucide-react";
import { useTheme } from "../../theme/ThemeContext";
import { ikaros, type ColumnInfo } from "../../engine/ikaros/client";
import {
	buildProfileQuery,
	parseProfileRow,
	nullRatio,
	type TableProfile,
} from "../../engine/profile";
import { ExecLogEntry } from "../../engine/scheduler";
import { InspectedNodePayload } from "../nymph/NymphCanvas";

const PAGE_SIZE = 100;

/** DuckDB 型態 → badge 色系 */
function typeBadgeClass(type: string, isLight: boolean): string {
	const t = type.toUpperCase();
	if (t.includes("INT") || t.includes("HUGEINT") || t.includes("UINT")) {
		return isLight ? "bg-blue-100 text-blue-700" : "bg-blue-950 text-blue-300";
	}
	if (t.includes("DOUBLE") || t.includes("FLOAT") || t.includes("DECIMAL")) {
		return isLight
			? "bg-emerald-100 text-emerald-700"
			: "bg-emerald-950 text-emerald-300";
	}
	if (t.includes("TIMESTAMP") || t.includes("DATE") || t.includes("TIME")) {
		return isLight
			? "bg-purple-100 text-purple-700"
			: "bg-purple-950 text-purple-300";
	}
	if (t.includes("BOOL")) {
		return isLight ? "bg-amber-100 text-amber-700" : "bg-amber-950 text-amber-300";
	}
	// VARCHAR / 其他
	return isLight ? "bg-stone-100 text-stone-700" : "bg-slate-800 text-slate-400";
}

const cellText = (v: any) =>
	typeof v === "bigint" ? Number(v).toString() : String(v);

interface DataDrawerProps {
	isOpen: boolean;
	onToggle: () => void;
	payload: InspectedNodePayload | null;
}

export const DataDrawer: React.FC<DataDrawerProps> = ({
	isOpen,
	onToggle,
	payload,
}) => {
	// 語意布林由 context 提供，元件不再自己拿 mode 字串比較
	const { isLight, tokens } = useTheme();

	const [tab, setTab] = useState<"data" | "logs">("data");
	const [searchInput, setSearchInput] = useState("");
	const [view, setView] = useState<{ page: number; search: string }>({
		page: 0,
		search: "",
	});
	const [columns, setColumns] = useState<ColumnInfo[]>([]);
	const [rows, setRows] = useState<Record<string, any>[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/**
	 * 剖面結果。
	 *
	 * **刻意放元件 state，不放節點 config**：config 是「驅動 SQL 的形狀」，
	 * 會被寫進 workflow 存檔、會進執行快取的鍵。剖面是衍生事實，寫進去會污染
	 * 存檔、讓快取永遠不命中，而且會隨檔案一起傳給別人。
	 */
	const [profile, setProfile] = useState<TableProfile | null>(null);
	const [profiling, setProfiling] = useState(false);
	const [profileError, setProfileError] = useState<string | null>(null);

	/** 每次檢視新節點 → 重設分頁 / 搜尋（render 期間同步，避免多跑一次 fetch） */
	const [seenPayload, setSeenPayload] = useState(payload);
	if (payload !== seenPayload) {
		setSeenPayload(payload);
		setView({ page: 0, search: "" });
		setSearchInput("");
	}

	const tableName = payload?.tableName || "";

	// 搜尋 debounce（300ms）→ 推入 view.search
	useEffect(() => {
		const timer = setTimeout(() => {
			setView((v) =>
				v.search === searchInput
					? v
					: { page: 0, search: searchInput },
			);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchInput]);

	/**
	 * 換一張表就把剖面清掉。
	 *
	 * 不清的話畫面會留著**上一張表**的數字，而下拉的標題已經是新表 ——
	 * 那比空白更糟：它看起來有資料，但資料是別人的。
	 */
	useEffect(() => {
		setProfile(null);
		setProfileError(null);
	}, [tableName]);

	/**
	 * 跑剖面。
	 *
	 * 必須由**使用者主動觸發**，不能自動跑：這是每欄一次全表掃描，
	 * COUNT(DISTINCT) 尤其貴。自動跑等於每次點節點都多付一次全掃描。
	 */
	const runProfile = async () => {
		if (!tableName || profiling) return;
		setProfiling(true);
		setProfileError(null);
		try {
			// 用引擎的 schema，不是畫面上的 columns —— 分頁查詢可能還沒回來，
			// 那時候 columns 是空的，剖面就會只算到 COUNT(*)。
			const cols = await ikaros.describe(tableName);
			const q = buildProfileQuery(tableName, cols);
			// maxRows = 1：這是單列聚合查詢，不必讓引擎準備更多
			const res = await ikaros.query(q.sql, 1);
			setProfile(parseProfileRow(res[0], q, cols));
		} catch (err: any) {
			setProfile(null);
			setProfileError(err?.message || String(err));
		} finally {
			setProfiling(false);
		}
	};

	/**
	 * SQL 側分頁查詢。
	 * 只有 PAGE_SIZE 行會跨過 worker 邊界 → 底層 100 萬行也不會 freeze UI。
	 * reqId 防止慢查詢覆蓋新結果（race）。
	 */
	const reqId = useRef(0);
	useEffect(() => {
		if (!tableName) {
			setColumns([]);
			setRows([]);
			setTotal(0);
			setError(null);
			setLoading(false);
			return;
		}

		const id = ++reqId.current;
		setLoading(true);
		ikaros
			.page(tableName, {
				offset: view.page * PAGE_SIZE,
				limit: PAGE_SIZE,
				search: view.search,
			})
			.then((res) => {
				if (reqId.current !== id) return;
				setColumns(res.columns);
				setRows(res.rows);
				setTotal(res.total);
				setError(null);
			})
			.catch((err: any) => {
				if (reqId.current !== id) return;
				setColumns([]);
				setRows([]);
				setTotal(0);
				setError(err?.message || String(err));
			})
			.finally(() => {
				if (reqId.current === id) setLoading(false);
			});
	}, [tableName, view, payload]);

	const columnNames = columns.map((c) => c.name);
	const typeByColumn: Record<string, string> = {};
	columns.forEach((c) => {
		typeByColumn[c.name] = c.type;
	});

	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const clampedPage = Math.min(view.page, pageCount - 1);

	const logs: ExecLogEntry[] = payload?.logs || [];
	const logColor = (level: ExecLogEntry["level"]) => {
		switch (level) {
			case "SUCCESS":
				return isLight ? "text-emerald-700" : "text-emerald-400";
			case "ERROR":
				return isLight ? "text-rose-700" : "text-rose-400";
			case "CHAOS":
				return isLight ? "text-amber-700" : "text-amber-400";
			case "SQL":
				return isLight ? "text-sky-700" : "text-sky-400";
			case "SKIP":
				// 快取命中的顏色刻意低調（紫），但要與 INFO 的灰明顯不同 ——
				// 「這個節點沒跑」是使用者必須一眼看到的資訊。
				return isLight ? "text-violet-700" : "text-violet-400";
			default:
				return isLight ? "text-stone-600" : "text-slate-400";
		}
	};

	const fmtTime = (ts: number) => {
		const d = new Date(ts);
		return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}:${String(
			d.getSeconds(),
		).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
	};

	const surfaceBg = isLight ? "#FDFBF7" : "#0D1117";
	const stickyBg = isLight ? "#FDFBF7" : "#161B22";

	return (
		<footer
			style={{
				backgroundColor: tokens.bgPanel,
				borderColor: tokens.border,
			}}
			className={`border-t transition-all ${isOpen ? "h-64" : "h-8"}`}
		>
			{/* 標題欄 */}
			<div
				onClick={onToggle}
				style={{
					backgroundColor: tokens.bgCanvas,
					borderColor: tokens.border,
					color: tokens.textPrimary,
				}}
				className="h-8 px-4 flex items-center justify-between cursor-pointer border-b transition-colors"
			>
				<div
					style={{ color: tokens.textSecondary }}
					className="flex items-center space-x-2 text-xs font-mono"
				>
					<Sliders
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>Ikaros Data Drawer & Execution Logs</span>
					{payload && (
						<span
							className="font-bold px-2 py-0.5 rounded text-[10px]"
							style={{
								backgroundColor: `${tokens.accent}15`,
								color: tokens.accent,
								borderColor: `${tokens.accent}30`,
							}}
						>
							{payload.nodeType} • {payload.label}
						</span>
					)}
					{payload && !payload.ok && (
						<span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-400">
							ERROR
						</span>
					)}
				</div>
				<span style={{ color: tokens.textSecondary }} className="text-xs">
					{isOpen ? "▼ Minimize" : "▲ Expand"}
				</span>
			</div>

			{isOpen && (
				<div
					style={{
						backgroundColor: tokens.bgCanvas,
						color: tokens.textSecondary,
						borderColor: tokens.border,
					}}
					className="p-2 text-xs font-mono overflow-auto h-56 flex flex-col"
				>
					{/* Tab 切換 + 搜尋 */}
					<div className="flex items-center space-x-3 shrink-0">
						<div className="flex rounded border overflow-hidden">
							<button
								onClick={() => setTab("data")}
								className={`px-2.5 py-1 text-[10px] font-bold ${
									tab === "data"
										? "bg-cyan-950/60 text-cyan-300"
										: "opacity-60"
								}`}
								style={{ color: tokens.textPrimary }}
							>
								<TableIcon className="w-3 h-3 inline mr-1" />
								Data
							</button>
							<button
								onClick={() => setTab("logs")}
								className={`px-2.5 py-1 text-[10px] font-bold ${
									tab === "logs"
										? "bg-cyan-950/60 text-cyan-300"
										: "opacity-60"
								}`}
								style={{ color: tokens.textPrimary }}
							>
								<Terminal className="w-3 h-3 inline mr-1" />
								Logs ({logs.length})
							</button>
						</div>

						{tab === "data" && tableName && (
							<div className="flex items-center flex-1 space-x-1.5">
								<Search
									className="w-3 h-3 opacity-50"
									style={{ color: tokens.textSecondary }}
								/>
								<input
									value={searchInput}
									onChange={(e) => setSearchInput(e.target.value)}
									placeholder="Search across all columns (SQL-side)..."
									style={{
										backgroundColor: tokens.bgCard,
										borderColor: tokens.border,
										color: tokens.textPrimary,
									}}
									className="flex-1 px-2 py-1 rounded border text-[10px] focus:outline-none"
								/>
								<button
									onClick={runProfile}
									disabled={profiling}
									title="對每個欄位算 NULL 數、唯一值數與值域。這是每欄一次全表掃描，所以刻意做成手動觸發。"
									style={{
										backgroundColor: tokens.bgCard,
										borderColor: tokens.border,
										color: tokens.textPrimary,
									}}
									className="shrink-0 px-2 py-1 rounded border text-[10px] hover:opacity-80 disabled:opacity-40"
								>
									{profiling ? "profiling…" : "Profile"}
								</button>
							</div>
						)}

						<span
							style={{ color: tokens.textSecondary }}
							className="shrink-0"
						>
							{loading
								? "querying…"
								: `${total.toLocaleString()} rows • ${columnNames.length} cols`}
							{!loading && view.search
								? ` • filtered by "${view.search}"`
								: ""}
						</span>
					</div>

					{/* 剖面結果。放在分頁列與資料區之間，不動下面那串三元式。 */}
					{tab === "data" && profileError && (
						<div className="mb-1 px-2 py-1 rounded border border-rose-500/40 text-[10px] text-rose-400 break-all">
							剖面失敗：{profileError}
						</div>
					)}
					{tab === "data" && profile && (
						<div
							className="mb-1 max-h-[150px] overflow-auto rounded border"
							style={{
								borderColor: tokens.border,
								backgroundColor: surfaceBg,
							}}
						>
							<table className="w-full text-left border-collapse text-[10px]">
								<thead>
									<tr
										className="border-b"
										style={{ borderColor: tokens.border }}
									>
										{["欄位", "型別", "NULL", "唯一值", "最小", "最大"].map((h) => (
											<th
												key={h}
												className="px-2 py-1 font-bold whitespace-nowrap"
												style={{ color: tokens.textSecondary }}
											>
												{h}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{profile.columns.map((c) => {
										const ratio = nullRatio(c, profile.rows);
										return (
											<tr
												key={c.name}
												className="border-b"
												style={{ borderColor: tokens.border }}
											>
												<td
													className="px-2 py-1 font-mono whitespace-nowrap"
													style={{ color: tokens.textPrimary }}
												>
													{c.name}
												</td>
												<td
													className="px-2 py-1 whitespace-nowrap opacity-70"
													style={{ color: tokens.textSecondary }}
												>
													{c.type}
												</td>
												<td
													className="px-2 py-1 whitespace-nowrap"
													style={{ color: tokens.textPrimary }}
												>
													{c.nulls ?? "—"}
													{/* 空表時 nullRatio 回 null → 不顯示比例。
													    顯示 0% 會把「空表」說成「沒有 NULL」。 */}
													{ratio !== null
														? ` (${(ratio * 100).toFixed(1)}%)`
														: ""}
												</td>
												<td
													className="px-2 py-1 whitespace-nowrap"
													style={{ color: tokens.textSecondary }}
												>
													{c.distinct ?? "—"}
												</td>
												<td
													className="px-2 py-1 font-mono max-w-[160px] truncate"
													style={{ color: tokens.textSecondary }}
													title={c.min ?? ""}
												>
													{c.min ?? "—"}
												</td>
												<td
													className="px-2 py-1 font-mono max-w-[160px] truncate"
													style={{ color: tokens.textSecondary }}
													title={c.max ?? ""}
												>
													{c.max ?? "—"}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
							<div
								className="px-2 py-1 text-[9px] opacity-60"
								style={{ color: tokens.textSecondary }}
							>
								{profile.rows.toLocaleString()} 列。「唯一值」走精確的
								COUNT(DISTINCT) —— 基數很高的欄位會慢，這正是它需要手動觸發的原因。
							</div>
						</div>
					)}

					{tab === "data" ? (
						error ? (
							<div className="flex-1 flex flex-col items-center justify-center space-y-1 text-rose-400">
								<span className="text-[11px] font-bold">
									查詢失敗
								</span>
								<span
									className="text-[10px] max-w-[80%] text-center break-all"
									style={{ color: tokens.textSecondary }}
								>
									{error}
								</span>
							</div>
						) : !tableName ? (
							<div className="flex-1 flex flex-col items-center justify-center text-slate-500 space-y-2">
								<Database className="w-6 h-6 opacity-40" />
								<span style={{ color: tokens.textSecondary }}>
									{payload
										? "此檢視沒有對應資料表 —— 請切換到 Logs 分頁查看執行記錄。"
										: "Click any node on the canvas to inspect its upstream pipeline output."}
								</span>
							</div>
						) : rows.length > 0 ? (
							<div
								className="flex-1 overflow-auto rounded border"
								style={{
									borderColor: tokens.border,
									backgroundColor: surfaceBg,
								}}
							>
								<table
									className="w-full text-left border-collapse"
									style={{ borderColor: tokens.border }}
								>
									<thead>
										<tr
											style={{ borderColor: tokens.border }}
											className="border-b"
										>
											{columnNames.map((col) => (
												<th
													key={col}
													className="p-1.5 font-semibold text-[10px] sticky top-0 z-10"
													style={{
														borderColor: tokens.border,
														color: tokens.accent,
														backgroundColor: stickyBg,
													}}
												>
													<div className="flex items-center space-x-1">
														<span className="truncate max-w-[140px]">
															{col}
														</span>
														{typeByColumn[col] && (
															<span
																className={`px-1 rounded text-[8px] font-bold shrink-0 ${typeBadgeClass(
																	typeByColumn[col],
																	isLight,
																)}`}
															>
																{typeByColumn[
																	col
																].toUpperCase()}
															</span>
														)}
													</div>
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{rows.map((row, rIdx) => (
											<tr
												key={
													clampedPage * PAGE_SIZE + rIdx
												}
												className="border-b"
												style={{
													borderColor: tokens.border,
												}}
											>
												{columnNames.map((col) => (
													<td
														key={col}
														className="p-1.5 text-[10px] truncate max-w-[220px]"
														title={cellText(row[col])}
														style={{
															color: tokens.textPrimary,
														}}
													>
														{cellText(row[col])}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>

								{/* 分頁 */}
								{pageCount > 1 && (
									<div
										className="flex items-center justify-end space-x-2 py-1.5 sticky bottom-0 px-2"
										style={{
											backgroundColor: stickyBg,
											color: tokens.textSecondary,
										}}
									>
										<button
											onClick={() =>
												setView((v) => ({
													...v,
													page: Math.max(
														0,
														clampedPage - 1,
													),
												}))
											}
											disabled={clampedPage === 0}
											className="p-1 rounded hover:opacity-70 disabled:opacity-30"
										>
											<SkipBack className="w-3.5 h-3.5" />
										</button>
										<span className="text-[10px]">
											Page {clampedPage + 1} / {pageCount}
										</span>
										<button
											onClick={() =>
												setView((v) => ({
													...v,
													page: Math.min(
														pageCount - 1,
														clampedPage + 1,
													),
												}))
											}
											disabled={
												clampedPage >= pageCount - 1
											}
											className="p-1 rounded hover:opacity-70 disabled:opacity-30"
										>
											<SkipForward className="w-3.5 h-3.5" />
										</button>
									</div>
								)}
							</div>
						) : (
							<div className="flex-1 flex flex-col items-center justify-center text-slate-500 space-y-2">
								<Database className="w-6 h-6 opacity-40" />
								<span style={{ color: tokens.textSecondary }}>
									{loading
										? "載入中…"
										: payload && !payload.ok
											? "Execution failed — check Logs tab for the error."
											: "0 rows returned for this query."}
								</span>
							</div>
						)
					) : (
						/* Logs tab */
						<div
							className="flex-1 overflow-auto rounded border p-2"
							style={{
								borderColor: tokens.border,
								backgroundColor: surfaceBg,
							}}
						>
							{logs.length === 0 ? (
								<div
									className="text-center text-slate-500 py-6"
									style={{ color: tokens.textSecondary }}
								>
									No execution logs yet — run a node to see DuckDB
									execution trace.
								</div>
							) : (
								logs.map((log, idx) => (
									<div
										key={idx}
										className="flex items-start space-x-2 py-1 border-b"
										style={{
											borderColor: `${tokens.border}66`,
										}}
									>
										<span
											className="text-[9px] w-16 shrink-0 opacity-60"
											style={{
												color: tokens.textSecondary,
											}}
										>
											{fmtTime(log.ts)}
										</span>
										<span
											className={`text-[10px] font-bold w-16 shrink-0 ${logColor(
												log.level,
											)}`}
										>
											{log.level}
										</span>
										<span
											className="flex-1 text-[10px] break-all"
											style={{ color: tokens.textPrimary }}
										>
											{log.message}
											{log.durationMs !== undefined && (
												<span className="opacity-60">
													{" "}
													({log.durationMs}ms
													{log.rows !== undefined
														? `, ${log.rows} rows`
														: ""}
													)
												</span>
											)}
										</span>
									</div>
								))
							)}
						</div>
					)}
				</div>
			)}
		</footer>
	);
};
