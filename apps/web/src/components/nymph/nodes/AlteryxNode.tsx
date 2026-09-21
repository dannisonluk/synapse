import React, { useState, useEffect } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import {
	Filter,
	Database,
	Sigma,
	GitMerge,
	Code,
	Calculator,
	ArrowDownUp,
	Table,
	Combine,
	Rows3,
	CaseSensitive,
} from "lucide-react";
import { useTheme } from "../../../theme/ThemeContext";
import { ikaros } from "../../../engine/ikaros/client";
import {
	qi,
	hasCurrentField,
	safeMatchFunc,
	matchIsSimilarity,
	matchThresholdDefault,
} from "../../../engine/sql";
import {
	useUpstreamColumns,
	type UpstreamColumn,
} from "../../../hooks/useUpstreamColumns";
import type {
	NodeConfig,
	SummarizeAggregation,
	RenamePair,
} from "../../../types/nodeConfig";

// 節點 config 的形狀宣告在 types/nodeConfig.ts —— 那是唯一一份。
// 本檔以前手抄了一份 AlteryxNodeConfig（與 types/workbench.ts 的 ASTNodeConfig、
// engine/astCompiler.ts 的 NodeConfig 三份互不檢查），所以新增欄位要改三個地方。
//
// 以下三個是向後相容的別名 —— 這些名字過去都是從本檔 export 的，直接改名會動到呼叫端。
// 這一輪只做「去重複」，不動任何呼叫端。
export type AlteryxNodeConfig = NodeConfig;
export type SummarizeAgg = SummarizeAggregation;
export type RenamePairConfig = RenamePair;

/** SUMMARIZE 可選的聚合函數（值必須在 sql.ts safeFunc 白名單內） */
const AGG_FUNCS = [
	"SUM",
	"AVG",
	"COUNT",
	"COUNT_DISTINCT",
	"MIN",
	"MAX",
	"STDDEV",
	"MEDIAN",
	"ANY_VALUE",
];

export interface AlteryxNodeData extends Record<string, unknown> {
	label?: string;
	type?: string;
	config?: AlteryxNodeConfig;
	sqlQuery?: string;
	executionState?: "IDLE" | "RUNNING" | "SUCCESS" | "ERROR";
	/**
	 * 由畫布注入：這個節點實際會讀的上游表（順序 = JOIN 的 left / right）。
	 * 用來查上游 schema，做成 config 表單的欄位選單。
	 */
	upstreamTables?: string[];
	onExecute?: () => void;
	onChangeConfig?: (newConfig: AlteryxNodeConfig) => void;
}

/**
 * 帶 datalist 的欄位輸入。
 *
 * 選 datalist 而不是 select 是刻意的：上游表可能還沒執行（schema 未知），
 * 而且使用者有時候要打一個「即將產生」的欄位名（例如 FORMULA 剛新增的）。
 * datalist 同時提供下拉建議與自由輸入。
 */
const FieldInput: React.FC<{
	listId: string;
	options: UpstreamColumn[];
	value: string;
	onValueChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	style?: React.CSSProperties;
}> = ({
	listId,
	options,
	value,
	onValueChange,
	placeholder,
	className,
	style,
}) => (
	<>
		<input
			list={listId}
			value={value}
			onChange={(e) => onValueChange(e.target.value)}
			placeholder={placeholder}
			className={className}
			style={style}
		/>
		<datalist id={listId}>
			{options.map((c) => (
				<option key={c.name} value={c.name}>
					{c.type}
				</option>
			))}
		</datalist>
	</>
);

/**
 * 欄位不存在於上游 schema 的警告。
 *
 * 只有「schema 已知（options 非空）」時才判斷 —— 上游還沒執行時
 * 我們根本不知道有哪些欄位，這時候報錯只會是噪音。
 */
const MissingFieldWarning: React.FC<{
	field?: string | null;
	options: UpstreamColumn[];
}> = ({ field, options }) =>
	field && options.length > 0 && !options.some((c) => c.name === field) ? (
		<div className="text-[9px] font-mono text-rose-500">
			⚠ 上游沒有欄位「{field}」—— 直接執行會失敗
		</div>
	) : null;

/**
 * 欄位「清單」編輯器：自由輸入 + datalist + 可點的 schema chips。
 *
 * UNIQUE / IMPUTE / DATA_CLEANSING / TRANSPOSE / 視窗節點的分區鍵全部共用
 * 這個控件 —— 它們的差別只在標籤與提示文字，重寫五份只會讓樣式各自漂移。
 */
const FieldListEditor: React.FC<{
	listId: string;
	options: UpstreamColumn[];
	value: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
	hint?: string;
	inputClassName?: string;
	chipClassName: (active: boolean) => string;
}> = ({
	listId,
	options,
	value,
	onChange,
	placeholder,
	hint,
	inputClassName,
	chipClassName,
}) => (
	<div className="space-y-1">
		<input
			list={listId}
			value={value.join(", ")}
			onChange={(e) =>
				onChange(
					e.target.value
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				)
			}
			placeholder={placeholder}
			className={`w-full ${inputClassName || ""}`}
		/>
		<datalist id={listId}>
			{options.map((c) => (
				<option key={c.name} value={c.name}>
					{c.type}
				</option>
			))}
		</datalist>
		{hint && <div className="text-[9px] font-mono opacity-50">{hint}</div>}
		{options.length > 0 && (
			<div className="flex flex-wrap gap-1">
				{options.map((c) => (
					<button
						key={c.name}
						type="button"
						onClick={() =>
							onChange(
								value.includes(c.name)
									? value.filter((v) => v !== c.name)
									: [...value, c.name],
							)
						}
						className={chipClassName(value.includes(c.name))}
					>
						{c.name}
					</button>
				))}
			</div>
		)}
	</div>
);

export const AlteryxNode: React.FC<NodeProps<Node<AlteryxNodeData>>> = ({
	id,
	data,
	selected,
}) => {
	const { mode, tokens } = useTheme();
	const nodeType = data.type || "FILTER";
	const [showSqlPreview, setShowSqlPreview] = useState(false);
	const [config, setConfig] = useState<AlteryxNodeConfig>(data.config || {});
	const [previewRows, setPreviewRows] = useState<any[]>([]);

	/**
	 * 上游表的真實欄位。refreshKey 傳 sqlQuery：上游 SQL 一改（例如 FORMULA
	 * 新增欄位），schema 就會重查。
	 * 上游還沒執行時 describe() 會失敗，hook 安靜地回傳空陣列 →
	 * 表單退回自由輸入，不會讓節點爆掉。
	 */
	const upstream = useUpstreamColumns(data.upstreamTables, data.sqlQuery);

	// 同步外部傳入的 config 變更
	useEffect(() => {
		if (data.config) {
			setConfig(data.config);
		}
	}, [data.config]);

	// 自動為 INPUT_DUCKDB 載入數據預覽
	useEffect(() => {
		const tableToQuery =
			config.tableName || (config.fileName ? `src_${id}` : null);
		if (tableToQuery && nodeType === "INPUT_DUCKDB") {
			// 表名一律 quote（config.tableName 有可能由 Hermes 提供）
			ikaros
				.query(`SELECT * FROM ${qi(tableToQuery)} LIMIT 5;`)
				.then((rows) => setPreviewRows(rows))
				.catch(() => {});
		}
	}, [config.tableName, config.fileName, id, nodeType]);

	/**
	 * 任意 config patch。
	 * 陣列 / 數字欄位（aggregations、groupBy[]、renames、sampleSize）走這個，
	 * 因為 updateConfig 的 value 型別被限死在 string。
	 */
	const updateConfigValue = (patch: Partial<AlteryxNodeConfig>) => {
		const updated: AlteryxNodeConfig = { ...config, ...patch };
		setConfig(updated);
		if (data.onChangeConfig) data.onChangeConfig(updated);
	};

	/** 單一欄位更新（字串值） */
	const updateConfig = (key: keyof AlteryxNodeConfig, value: string) => {
		updateConfigValue({ [key]: value } as Partial<AlteryxNodeConfig>);
	};

	/**
	 * SUMMARIZE 的分組鍵清單（畫面用）。
	 * 舊格式的單一字串在這裡就正規化成陣列，編輯時一律寫回陣列格式。
	 */
	const summarizeGroups = ((): string[] => {
		const g = config.groupBy;
		if (Array.isArray(g)) return g;
		const s = String(g ?? "").trim();
		if (!s) return ["year"];
		return s
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean);
	})();

	/** SUMMARIZE 的聚合清單（畫面用）；空 → 由舊格式 func/target 補一組 */
	const summarizeAggs = ((): SummarizeAgg[] => {
		const raw = Array.isArray(config.aggregations)
			? config.aggregations
			: [];
		if (raw.length > 0) {
			return raw.map((a) => ({
				func: a.func || "SUM",
				target: a.target || "",
			}));
		}
		return [{ func: config.func || "SUM", target: config.target || "amount" }];
	})();

	/** RENAME 的改名清單（畫面用） */
	const renamePairs = Array.isArray(config.renames) ? config.renames : [];

	/** UNION 的實際輸入表（順序 = 連線進來的順序） */
	const unionInputs = data.upstreamTables || [];

	/**
	 * SORT 的排序欄位。
	 * groupBy 只是 Hermes 舊 payload 的 fallback，現在可能是陣列
	 * （SUMMARIZE 的多分組鍵）→ 取第一個就好。
	 */
	const sortField =
		config.field ||
		(Array.isArray(config.groupBy) ? config.groupBy[0] : config.groupBy) ||
		"id";

	/** SELECT 節點：逗號分隔字串 ↔ string[]（空 = 全選） */
	const updateColumns = (raw: string) => {
		const columns = raw
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean);
		const updated: AlteryxNodeConfig = { ...config, columns };
		setConfig(updated);
		if (data.onChangeConfig) data.onChangeConfig(updated);
	};

	/** SELECT 節點：點一下上游欄位 chip 就加入 / 移除選取（schema 驅動） */
	const toggleColumn = (name: string) => {
		const current = config.columns || [];
		const columns = current.includes(name)
			? current.filter((c) => c !== name)
			: [...current, name];
		const updated: AlteryxNodeConfig = { ...config, columns };
		setConfig(updated);
		if (data.onChangeConfig) data.onChangeConfig(updated);
	};

	const handleFileUpload = async (file: File) => {
		// 關鍵修復：使用 src_${id} 作為 DuckDB 檔案註冊表名，避免與計算臨時表 node_${id} 衝突
		const fileTable = `src_${id}`;
		try {
			const { rowCount, columns } = await ikaros.registerLocalFile(
				file,
				fileTable,
			);

			// 擷取前 5 筆真實數據進行預覽
			const sampleRows = await ikaros.query(
				`SELECT * FROM ${fileTable} LIMIT 5;`,
			);
			setPreviewRows(sampleRows);

			const updated: AlteryxNodeConfig = {
				...config,
				tableName: fileTable,
				fileName: file.name,
				rowCount,
				columnCount: columns.length,
			};
			setConfig(updated);
			if (data.onChangeConfig) data.onChangeConfig(updated);
		} catch (err: any) {
			console.error("Failed to load file into DuckDB-WASM:", err);
			alert(`檔案載入失敗: ${err?.message || "請檢查 CSV 格式"}`);
		}
	};

	const isLight = mode === "claude-light";

	// --- 擴充節點共用的樣式與小工具 -------------------------------------
	// 這幾個 class 在新增的 11 種節點裡重複出現，抽出來免得每塊各寫一份、
	// 改配色時漏掉其中幾塊。必須放在 isLight 之後 —— 它們在宣告時就要求值。

	/** 卡片式表單區塊的外框 */
	const boxCls = `p-2 rounded border space-y-1 ${
		isLight
			? "bg-stone-50/80 border-stone-200/60"
			: "bg-slate-900/60 border-slate-800"
	}`;

	/** 區塊標題 */
	const titleCls =
		"text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase";

	/** 說明文字 */
	const hintCls = "text-[9px] font-mono opacity-50";

	/** 一般文字輸入框 */
	const inputCls = `px-1.5 py-0.5 rounded border text-[11px] font-mono ${
		isLight
			? "bg-white border-stone-200 text-stone-800"
			: "bg-slate-950 border-slate-800 text-slate-200"
	}`;

	/** 下拉選單 */
	const selectCls = `px-1 py-0.5 rounded border text-[11px] font-mono ${
		isLight
			? "bg-white border-stone-200 text-stone-800"
			: "bg-slate-950 border-slate-800 text-slate-200"
	}`;

	/** schema chip（選取中 / 未選取） */
	const chipCls = (active: boolean) =>
		`px-1.5 py-0.5 rounded border text-[9px] font-mono transition-colors ${
			active
				? isLight
					? "bg-cyan-100 border-cyan-300 text-cyan-800"
					: "bg-cyan-900/40 border-cyan-700 text-cyan-300"
				: isLight
					? "bg-white border-stone-200 opacity-70 hover:opacity-100"
					: "bg-slate-950 border-slate-800 opacity-70 hover:opacity-100"
		}`;

	/** 通用：寫回某個 string[] 欄位（UNIQUE/IMPUTE/… 的 columns、partitionBy） */
	const setNameList = (
		key: "columns" | "partitionBy" | "outputColumns" | "groupBy",
		next: string[],
	) => updateConfigValue({ [key]: next } as Partial<AlteryxNodeConfig>);

	/** 從 config 讀出某個 string[] 欄位（可能是舊格式的單一字串） */
	const nameListOf = (key: "columns" | "partitionBy" | "outputColumns"): string[] => {
		const v = (config as Record<string, unknown>)[key];
		if (Array.isArray(v)) return v.map((x) => String(x ?? "")).filter(Boolean);
		const s = String(v ?? "").trim();
		return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
	};

	return (
		<div
			style={{
				backgroundColor: isLight ? "#FFFFFF" : "#161B22",
				borderColor: selected
					? tokens.accent
					: isLight
						? "#E7DFD5"
						: "#30363D",
				boxShadow: selected
					? `0 0 0 2px ${tokens.accent}33`
					: "0 4px 12px rgba(0,0,0,0.05)",
			}}
			className="w-80 relative rounded-lg border p-3 text-xs font-sans transition-all"
		>
			{/* 👈 左側 Target 埠 */}
			{nodeType === "JOIN" ? (
				<>
					<span className="absolute left-2 top-[30%] -translate-y-1/2 text-[9px] font-mono font-bold opacity-60">
						L
					</span>
					<Handle
						type="target"
						id="left"
						position={Position.Left}
						style={{ top: "30%", backgroundColor: tokens.accent }}
						className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -left-1.5"
					/>
					<span className="absolute left-2 top-[70%] -translate-y-1/2 text-[9px] font-mono font-bold opacity-60">
						R
					</span>
					<Handle
						type="target"
						id="right"
						position={Position.Left}
						style={{ top: "70%", backgroundColor: tokens.accent }}
						className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -left-1.5"
					/>
				</>
			) : (
				<Handle
					type="target"
					position={Position.Left}
					style={{
						top: "50%",
						backgroundColor: isLight ? "#78716C" : "#8B949E",
					}}
					className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -left-1.5 -translate-y-1/2"
				/>
			)}

			{/* 頂部 Header */}
			<div
				className={`flex items-center justify-between pb-2 border-b ${
					isLight ? "border-stone-100" : "border-gray-800"
				}`}
			>
				<div className="flex items-center space-x-2">
					<div
						className={`p-1 rounded ${
							isLight
								? "bg-stone-100 text-stone-700"
								: "bg-slate-800 text-slate-300"
						}`}
					>
						{nodeType === "INPUT_DUCKDB" && (
							<Database className="w-3.5 h-3.5" />
						)}
						{nodeType === "FILTER" && (
							<Filter className="w-3.5 h-3.5" />
						)}
						{nodeType === "FORMULA" && (
							<Calculator className="w-3.5 h-3.5" />
						)}
						{nodeType === "SUMMARIZE" && (
							<Sigma className="w-3.5 h-3.5" />
						)}
						{nodeType === "JOIN" && (
							<GitMerge className="w-3.5 h-3.5" />
						)}
						{nodeType === "SORT" && (
							<ArrowDownUp className="w-3.5 h-3.5" />
						)}
						{nodeType === "SELECT" && (
							<Table className="w-3.5 h-3.5" />
						)}
						{nodeType === "UNION" && (
							<Combine className="w-3.5 h-3.5" />
						)}
						{nodeType === "SAMPLE" && (
							<Rows3 className="w-3.5 h-3.5" />
						)}
						{nodeType === "RENAME" && (
							<CaseSensitive className="w-3.5 h-3.5" />
						)}
					</div>
					<div>
						<div
							className={`font-semibold ${
								isLight ? "text-stone-800" : "text-slate-100"
							}`}
						>
							{data.label || nodeType}
						</div>
						<div
							className={`text-[9px] font-mono ${
								isLight ? "text-stone-400" : "text-slate-500"
							}`}
						>
							{nodeType}
						</div>
					</div>
				</div>
				<button
					onClick={() => setShowSqlPreview(!showSqlPreview)}
					className={`p-1 rounded ${
						isLight
							? "hover:bg-stone-100 text-stone-400"
							: "hover:bg-slate-800 text-slate-500"
					}`}
				>
					<Code className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* 表單內容區 */}
			<div className="py-2 space-y-2">
				{/* 1. INPUT_DUCKDB 節點介面 */}
				{nodeType === "INPUT_DUCKDB" && (
					<div className="space-y-2">
						<div
							onDragOver={(e) => {
								e.preventDefault();
								e.stopPropagation();
							}}
							onDrop={(e) => {
								e.preventDefault();
								e.stopPropagation();
								const file = e.dataTransfer.files?.[0];
								if (file) handleFileUpload(file);
							}}
							className={`p-2.5 border-2 border-dashed rounded-lg text-center cursor-pointer transition-all ${
								isLight
									? "border-stone-300 hover:border-amber-500 bg-stone-50"
									: "border-slate-800 hover:border-cyan-500 bg-slate-950"
							}`}
						>
							<input
								type="file"
								accept=".csv,.parquet"
								id={`file-input-${id}`}
								className="hidden"
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (file) handleFileUpload(file);
								}}
							/>
							<label
								htmlFor={`file-input-${id}`}
								className="cursor-pointer block space-y-0.5"
							>
								<div className="text-[11px] font-semibold">
									{config.fileName
										? `📄 ${config.fileName}`
										: "Click or Drag CSV / Parquet"}
								</div>
								<div className="text-[9px] font-mono opacity-50">
									{config.fileName
										? `${config.rowCount || 0} rows • ${config.columnCount || 0} cols`
										: "Supports .csv, .parquet"}
								</div>
							</label>
						</div>

						{/* Alteryx 風格：Preview (Sample Data) 資料表格 */}
						{previewRows.length > 0 && (
							<div className="mt-2 space-y-1">
								<div className="text-[9px] font-mono font-bold uppercase opacity-60">
									Preview (Sample Data)
								</div>
								<div
									className="max-h-28 overflow-auto border rounded text-[9px] font-mono"
									style={{ borderColor: tokens.border }}
								>
									<table className="w-full border-collapse text-left">
										<thead>
											<tr
												className={
													isLight
														? "bg-stone-100 text-stone-700"
														: "bg-slate-900 text-slate-300"
												}
											>
												{Object.keys(previewRows[0])
													.slice(0, 5)
													.map((col) => (
														<th
															key={col}
															className="p-1 border-b border-r truncate max-w-[65px]"
														>
															{col}
														</th>
													))}
											</tr>
										</thead>
										<tbody>
											{previewRows.map((row, rIdx) => (
												<tr
													key={rIdx}
													className={
														rIdx % 2 === 0
															? "opacity-90"
															: "opacity-70"
													}
												>
													{Object.keys(previewRows[0])
														.slice(0, 5)
														.map((col) => (
															<td
																key={col}
																className="p-1 border-b border-r truncate max-w-[65px]"
															>
																{String(
																	row[col],
																)}
															</td>
														))}
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
						)}
					</div>
				)}

				{/* 2. FILTER 節點介面 */}
				{nodeType === "FILTER" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							Filter Condition
						</div>
						<div className="flex space-x-1">
							<FieldInput
								listId={`filter-field-${id}`}
								options={upstream.columns}
								value={config.field || "amount"}
								onValueChange={(v) => updateConfig("field", v)}
								placeholder="Field"
								className={`w-20 px-1.5 py-0.5 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-stone-800"
										: "bg-slate-950 border-slate-800 text-slate-200"
								}`}
							/>
							<select
								value={config.op || ">"}
								onChange={(e) =>
									updateConfig("op", e.target.value)
								}
								className={`px-1 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-amber-700"
										: "bg-slate-950 border-slate-800 text-cyan-400"
								}`}
							>
								<option value="=">=</option>
								<option value=">">&gt;</option>
								<option value="<">&lt;</option>
							</select>
							<input
								value={config.val || "1000"}
								onChange={(e) =>
									updateConfig("val", e.target.value)
								}
								placeholder="Value"
								className={`flex-1 px-1.5 py-0.5 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-stone-800"
										: "bg-slate-950 border-slate-800 text-slate-200"
								}`}
							/>
						</div>
						<MissingFieldWarning
							field={config.field || "amount"}
							options={upstream.columns}
						/>
					</div>
				)}

				{/* 3. FORMULA 節點介面 */}
				{nodeType === "FORMULA" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							New Column Formula
						</div>
						<div className="space-y-1">
							<input
								value={config.outputColumn || "amount_taxed"}
								onChange={(e) =>
									updateConfig("outputColumn", e.target.value)
								}
								placeholder="Output Column Name"
								className={`w-full px-1.5 py-0.5 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-stone-800"
										: "bg-slate-950 border-slate-800 text-slate-200"
								}`}
							/>
							<input
								value={config.expression || "amount * 1.1"}
								onChange={(e) =>
									updateConfig("expression", e.target.value)
								}
								placeholder="Expression (e.g. amount * 1.1)"
								className={`w-full px-1.5 py-0.5 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-amber-700"
										: "bg-slate-950 border-slate-800 text-cyan-400"
								}`}
							/>
						</div>
					</div>
				)}

				{/* 4. SUMMARIZE 節點介面（多分組鍵 + 多聚合） */}
				{nodeType === "SUMMARIZE" && (
					<div
						className={`p-2 rounded border space-y-2 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						{/* 分組鍵 */}
						<div className="space-y-1">
							<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
								Group By（分組鍵）
							</div>
							{summarizeGroups.map((g, i) => (
								<div key={i} className="flex items-center space-x-1">
									<FieldInput
										listId={`summarize-group-${id}-${i}`}
										options={upstream.columns}
										value={g}
										onValueChange={(v) => {
											const next = [...summarizeGroups];
											next[i] = v;
											updateConfigValue({ groupBy: next });
										}}
										placeholder="Group Key"
										className={`flex-1 px-1.5 py-0.5 rounded border text-[11px] font-mono ${
											isLight
												? "bg-white border-stone-200 text-stone-800"
												: "bg-slate-950 border-slate-800 text-slate-200"
										}`}
									/>
									<button
										type="button"
										title="移除這個分組鍵"
										onClick={() =>
											updateConfigValue({
												groupBy: summarizeGroups.filter(
													(_, j) => j !== i,
												),
											})
										}
										className="px-1 text-[11px] font-mono opacity-50 hover:opacity-100 hover:text-rose-500"
									>
										✕
									</button>
								</div>
							))}
							<button
								type="button"
								onClick={() =>
									updateConfigValue({
										groupBy: [...summarizeGroups, ""],
									})
								}
								className="text-[9px] font-mono opacity-60 hover:opacity-100"
							>
								＋ 新增分組鍵
							</button>
							{summarizeGroups.length === 0 && (
								<div className="text-[9px] font-mono opacity-50">
									沒有分組鍵 → 整表聚合成一列
								</div>
							)}
							{summarizeGroups.map((g, i) => (
								<MissingFieldWarning
									key={`w-${i}`}
									field={g}
									options={upstream.columns}
								/>
							))}
						</div>

						{/* 聚合 */}
						<div className="space-y-1">
							<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
								Aggregations（聚合）
							</div>
							{summarizeAggs.map((a, i) => (
								<div key={i} className="flex items-center space-x-1">
									<select
										value={a.func || "SUM"}
										onChange={(e) => {
											const next = [...summarizeAggs];
											next[i] = {
												...next[i],
												func: e.target.value,
											};
											updateConfigValue({
												aggregations: next,
											});
										}}
										className={`px-1 rounded border text-[11px] font-mono ${
											isLight
												? "bg-white border-stone-200 text-amber-700"
												: "bg-slate-950 border-slate-800 text-cyan-400"
										}`}
									>
										{AGG_FUNCS.map((f) => (
											<option key={f} value={f}>
												{f}
											</option>
										))}
									</select>
									<FieldInput
										listId={`summarize-agg-${id}-${i}`}
										options={upstream.columns}
										value={a.target || ""}
										onValueChange={(v) => {
											const next = [...summarizeAggs];
											next[i] = { ...next[i], target: v };
											updateConfigValue({
												aggregations: next,
											});
										}}
										placeholder="Target（* = COUNT(*)）"
										className={`flex-1 px-1.5 py-0.5 rounded border text-[11px] font-mono ${
											isLight
												? "bg-white border-stone-200 text-stone-800"
												: "bg-slate-950 border-slate-800 text-slate-200"
										}`}
									/>
									<button
										type="button"
										title="移除這組聚合"
										onClick={() =>
											updateConfigValue({
												aggregations:
													summarizeAggs.filter(
														(_, j) => j !== i,
													),
											})
										}
										className="px-1 text-[11px] font-mono opacity-50 hover:opacity-100 hover:text-rose-500"
									>
										✕
									</button>
								</div>
							))}
							<button
								type="button"
								onClick={() =>
									updateConfigValue({
										aggregations: [
											...summarizeAggs,
											{ func: "SUM", target: "" },
										],
									})
								}
								className="text-[9px] font-mono opacity-60 hover:opacity-100"
							>
								＋ 新增聚合
							</button>
							{summarizeAggs.length === 0 && (
								<div className="text-[9px] font-mono text-amber-600">
									⚠ 沒有任何聚合 → SQL 不合法，請至少加一組
								</div>
							)}
							{summarizeAggs
								.filter((a) => a.target && a.target !== "*")
								.map((a, i) => (
									<MissingFieldWarning
										key={`aw-${i}`}
										field={a.target}
										options={upstream.columns}
									/>
								))}
						</div>
					</div>
				)}

				{/* 5. JOIN 節點介面 */}
				{nodeType === "JOIN" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							Join Keys
						</div>
						<div className="flex space-x-1">
							<FieldInput
								listId={`join-left-${id}`}
								options={upstream.byTable[0] || []}
								value={config.leftKey || "id"}
								onValueChange={(v) => updateConfig("leftKey", v)}
								placeholder="Left Key"
								className={`w-full px-1.5 py-0.5 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-stone-800"
										: "bg-slate-950 border-slate-800 text-slate-200"
								}`}
							/>
							<select
								value={config.joinType || "INNER"}
								onChange={(e) =>
									updateConfig("joinType", e.target.value)
								}
								className={`px-1 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-amber-700"
										: "bg-slate-950 border-slate-800 text-cyan-400"
								}`}
							>
								<option value="INNER">INNER</option>
								<option value="LEFT">LEFT</option>
								<option value="RIGHT">RIGHT</option>
							</select>
							<FieldInput
								listId={`join-right-${id}`}
								options={upstream.byTable[1] || []}
								value={config.rightKey || "id"}
								onValueChange={(v) =>
									updateConfig("rightKey", v)
								}
								placeholder="Right Key"
								className={`w-full px-1.5 py-0.5 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-stone-800"
										: "bg-slate-950 border-slate-800 text-slate-200"
								}`}
							/>
						</div>
						<div className="flex justify-between gap-1">
							<MissingFieldWarning
								field={config.leftKey || "id"}
								options={upstream.byTable[0] || []}
							/>
							<MissingFieldWarning
								field={config.rightKey || "id"}
								options={upstream.byTable[1] || []}
							/>
						</div>
					</div>
				)}

				{/* 5b. FUZZY_JOIN 節點介面 */}
				{nodeType === "FUZZY_JOIN" && (() => {
					// 方向由 matchFunc 決定（相似度是下限、編輯距離是上限）。
					// 這裡刻意問 engine/sql.ts 的同一個函數，而不是在表單裡再記一次 ——
					// 記錯方向不會報錯，只會讓「越像的越不被選中」。
					const fn = safeMatchFunc(config.matchFunc);
					const isSim = matchIsSimilarity(fn);
					const dirLabel =
						fn === "EXACT"
							? "完全相等"
							: isSim
								? "相似度 ≥ 門檻"
								: "編輯距離 ≤ 門檻";
					return (
						<div
							className={`p-2 rounded border space-y-1 ${
								isLight
									? "bg-stone-50/80 border-stone-200/60"
									: "bg-slate-900/60 border-slate-800"
							}`}
						>
							<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
								Fuzzy Match Keys
							</div>
							<div className="flex space-x-1">
								<FieldInput
									listId={`fz-left-${id}`}
									options={upstream.byTable[0] || []}
									value={config.leftKey || ""}
									onValueChange={(v) =>
										updateConfig("leftKey", v)
									}
									placeholder="Left Key"
									className={`w-full ${inputCls}`}
								/>
								<FieldInput
									listId={`fz-right-${id}`}
									options={upstream.byTable[1] || []}
									value={config.rightKey || ""}
									onValueChange={(v) =>
										updateConfig("rightKey", v)
									}
									placeholder="Right Key"
									className={`w-full ${inputCls}`}
								/>
							</div>

							{/* 沒有鍵就無從比對 → 編譯器退回 passthrough。不講的話
							    使用者只會看到節點「什麼都沒做」。 */}
							{(!String(config.leftKey ?? "").trim() ||
								!String(config.rightKey ?? "").trim()) && (
								<div className="text-[9px] font-mono text-red-500 leading-tight">
									未設定左右鍵 → 這個節點會直接通過（passthrough），不做任何比對
								</div>
							)}

							<div className="flex space-x-1">
								<select
									value={fn}
									onChange={(e) =>
										updateConfigValue({
											matchFunc: e.target.value,
											// 切換函數時門檻的量綱也變了，一併換成該函數的預設值，
											// 否則 0.85 會被當成編輯距離（永遠不命中）。
											threshold: matchThresholdDefault(
												safeMatchFunc(e.target.value),
											),
										})
									}
									className={`flex-1 ${selectCls}`}
								>
									<option value="JARO_WINKLER">
										JARO_WINKLER
									</option>
									<option value="LEVENSHTEIN">
										LEVENSHTEIN
									</option>
									<option value="DAMERAU_LEVENSHTEIN">
										DAMERAU_LEVENSHTEIN
									</option>
									<option value="EXACT">EXACT</option>
								</select>
								<input
									type="number"
									step="0.01"
									value={
										config.threshold ??
										matchThresholdDefault(fn)
									}
									disabled={fn === "EXACT"}
									onChange={(e) =>
										updateConfigValue({
											threshold: Number(e.target.value),
										})
									}
									title="門檻"
									className={`w-20 ${inputCls} ${
										fn === "EXACT" ? "opacity-40" : ""
									}`}
								/>
								<select
									value={config.joinType || "INNER"}
									onChange={(e) =>
										updateConfig("joinType", e.target.value)
									}
									className={`w-20 ${selectCls}`}
								>
									<option value="INNER">INNER</option>
									<option value="LEFT">LEFT</option>
								</select>
							</div>

							<div className="text-[9px] font-mono opacity-60 leading-tight">
								{dirLabel}
								{fn !== "EXACT" &&
									`（${matchThresholdDefault(fn)} 是預設值）`}
							</div>

							<div className="flex space-x-1">
								<select
									value={config.prefilter || "NONE"}
									onChange={(e) =>
										updateConfig("prefilter", e.target.value)
									}
									title="候選縮減：先縮小要兩兩比較的配對數"
									className={`w-24 ${selectCls}`}
								>
									<option value="NONE">NONE</option>
									<option value="FIRST_CHAR">FIRST_CHAR</option>
								</select>
								<input
									value={config.scoreColumn ?? ""}
									onChange={(e) =>
										updateConfig(
											"scoreColumn",
											e.target.value,
										)
									}
									disabled={fn === "EXACT"}
									placeholder="分數欄位（留空則不輸出）"
									className={`flex-1 ${inputCls} ${
										fn === "EXACT" ? "opacity-40" : ""
									}`}
								/>
							</div>

							<label className="flex items-center space-x-1 text-[9px] font-mono opacity-70">
								<input
									type="checkbox"
									checked={config.caseInsensitive === true}
									onChange={(e) =>
										updateConfigValue({
											caseInsensitive: e.target.checked,
										})
									}
								/>
								<span>
									忽略大小寫（兩邊先 LOWER —— 相似度函數本身區分大小寫）
								</span>
							</label>

							<div className="text-[9px] font-mono opacity-50 leading-tight">
								FIRST_CHAR 只比首字元相同的配對，省掉大部分 O(n×m) 比較；首字元打錯的配對永遠不會命中。
							</div>
						</div>
					);
				})()}

				{/* 6. SORT 節點介面 */}
				{nodeType === "SORT" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							Sort Order
						</div>
						<FieldInput
							listId={`sort-field-${id}`}
							options={upstream.columns}
							value={sortField}
							onValueChange={(v) => updateConfig("field", v)}
							placeholder="Sort By (e.g. amount)"
							className={`w-full px-1.5 py-0.5 rounded border text-[11px] font-mono ${
								isLight
									? "bg-white border-stone-200 text-stone-800"
									: "bg-slate-950 border-slate-800 text-slate-200"
							}`}
						/>
						<MissingFieldWarning
							field={sortField}
							options={upstream.columns}
						/>
						<label className="flex items-center space-x-1 text-[9px] font-mono opacity-70">
							<input
								type="checkbox"
								checked={config.descending === true}
								onChange={(e) =>
									updateConfigValue({ descending: e.target.checked })
								}
							/>
							<span>遞減（由大到小）</span>
						</label>
						<div className="text-[9px] font-mono opacity-50">
							ORDER BY {sortField} {config.descending ? "DESC" : "ASC"}
						</div>
					</div>
				)}

				{/* 7. SELECT 節點介面 */}
				{nodeType === "SELECT" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							Column Selection
						</div>
						<input
							value={(config.columns || []).join(", ")}
							onChange={(e) => updateColumns(e.target.value)}
							placeholder="id, name, amount"
							className={`w-full px-1.5 py-0.5 rounded border text-[11px] font-mono ${
								isLight
									? "bg-white border-stone-200 text-stone-800"
									: "bg-slate-950 border-slate-800 text-slate-200"
							}`}
						/>
						{/* 上游 schema 已知時，點 chip 就能加入 / 移除（仍保留上面的自由輸入） */}
						{upstream.columns.length > 0 && (
							<div className="flex flex-wrap gap-1 pt-0.5">
								{upstream.columns.map((c) => {
									const picked = (
										config.columns || []
									).includes(c.name);
									return (
										<button
											key={c.name}
											type="button"
											title={c.type}
											onClick={() => toggleColumn(c.name)}
											className={`px-1.5 py-0.5 rounded border text-[9px] font-mono transition-colors ${
												picked
													? isLight
														? "bg-amber-100 border-amber-300 text-amber-800"
														: "bg-cyan-950 border-cyan-800 text-cyan-300"
													: isLight
														? "bg-white border-stone-200 text-stone-500 hover:border-stone-300"
														: "bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-700"
											}`}
										>
											{c.name}
										</button>
									);
								})}
							</div>
						)}
						<div className="text-[9px] font-mono opacity-50">
							{(config.columns || []).length > 0
								? `已選 ${(config.columns || []).length} 欄`
								: "留空 = SELECT *（全選）"}
						</div>
					</div>
				)}

				{/* 8. UNION 節點介面（N 路合併） */}
				{nodeType === "UNION" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							Union Mode
						</div>
						<select
							value={config.unionMode || "BY_NAME"}
							onChange={(e) =>
								updateConfig("unionMode", e.target.value)
							}
							className={`w-full px-1 py-0.5 rounded border text-[11px] font-mono ${
								isLight
									? "bg-white border-stone-200 text-fuchsia-700"
									: "bg-slate-950 border-slate-800 text-fuchsia-400"
							}`}
						>
							<option value="BY_NAME">
								BY NAME（按欄位名對齊，缺欄補 NULL）
							</option>
							<option value="POSITION">
								POSITION（按欄位位置對齊）
							</option>
						</select>
						<div className="text-[9px] font-mono opacity-50 leading-relaxed">
							合併順序（依連線先後）：
							{unionInputs.length > 0
								? unionInputs
										.map((t, i) => `${i + 1}. ${t}`)
										.join("  ")
								: "尚未接上任何上游"}
						</div>
						{unionInputs.length < 2 && (
							<div className="text-[9px] font-mono text-amber-600">
								⚠ Union 需要至少 2 條上游連線
							</div>
						)}
					</div>
				)}

				{/* 9. SAMPLE 節點介面 */}
				{nodeType === "SAMPLE" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							Sample
						</div>
						<div className="flex space-x-1">
							<select
								value={config.sampleMode || "FIRST"}
								onChange={(e) =>
									updateConfig("sampleMode", e.target.value)
								}
								className={`px-1 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-orange-700"
										: "bg-slate-950 border-slate-800 text-orange-400"
								}`}
							>
								<option value="FIRST">FIRST（前 N 列）</option>
								<option value="RANDOM">
									RANDOM（隨機抽樣）
								</option>
							</select>
							<input
								type="number"
								min={0}
								value={config.sampleSize ?? 100}
								onChange={(e) =>
									updateConfigValue({
										sampleSize: Math.max(
											0,
											Math.floor(
												Number(e.target.value) || 0,
											),
										),
									})
								}
								className={`w-20 px-1.5 py-0.5 rounded border text-[11px] font-mono ${
									isLight
										? "bg-white border-stone-200 text-stone-800"
										: "bg-slate-950 border-slate-800 text-slate-200"
								}`}
							/>
							<span className="self-center text-[9px] font-mono opacity-50">
								rows
							</span>
						</div>
						<div className="text-[9px] font-mono opacity-50">
							{(config.sampleMode || "FIRST") === "RANDOM"
								? "USING SAMPLE n ROWS (reservoir, 42) —— seed 固定，重跑結果一致"
								: "LIMIT n —— 依上游輸出順序取前 n 列"}
						</div>
					</div>
				)}

				{/* 10. RENAME 節點介面 */}
				{nodeType === "RENAME" && (
					<div
						className={`p-2 rounded border space-y-1 ${
							isLight
								? "bg-stone-50/80 border-stone-200/60"
								: "bg-slate-900/60 border-slate-800"
						}`}
					>
						<div className="text-[9px] font-bold font-mono tracking-wider opacity-60 uppercase">
							Rename Columns
						</div>
						{renamePairs.map((p, i) => (
							<div key={i} className="flex items-center space-x-1">
								<FieldInput
									listId={`rename-from-${id}-${i}`}
									options={upstream.columns}
									value={p.from || ""}
									onValueChange={(v) => {
										const next = [...renamePairs];
										next[i] = { ...next[i], from: v };
										updateConfigValue({ renames: next });
									}}
									placeholder="舊欄位名"
									className={`flex-1 px-1.5 py-0.5 rounded border text-[11px] font-mono ${
										isLight
											? "bg-white border-stone-200 text-stone-800"
											: "bg-slate-950 border-slate-800 text-slate-200"
									}`}
								/>
								<span className="text-[10px] font-mono opacity-50">
									→
								</span>
								<input
									value={p.to || ""}
									onChange={(e) => {
										const next = [...renamePairs];
										next[i] = {
											...next[i],
											to: e.target.value,
										};
										updateConfigValue({ renames: next });
									}}
									placeholder="新欄位名"
									className={`flex-1 px-1.5 py-0.5 rounded border text-[11px] font-mono ${
										isLight
											? "bg-white border-stone-200 text-lime-700"
											: "bg-slate-950 border-slate-800 text-lime-400"
									}`}
								/>
								<button
									type="button"
									title="移除這組改名"
									onClick={() =>
										updateConfigValue({
											renames: renamePairs.filter(
												(_, j) => j !== i,
											),
										})
									}
									className="px-1 text-[11px] font-mono opacity-50 hover:opacity-100 hover:text-rose-500"
								>
									✕
								</button>
							</div>
						))}
						<button
							type="button"
							onClick={() =>
								updateConfigValue({
									renames: [
										...renamePairs,
										{ from: "", to: "" },
									],
								})
							}
							className="text-[9px] font-mono opacity-60 hover:opacity-100"
						>
							＋ 新增改名
						</button>
						{renamePairs.length === 0 && (
							<div className="text-[9px] font-mono opacity-50">
								未設定 → 原樣輸出（passthrough）
							</div>
						)}
						{renamePairs.map((p, i) => (
							<MissingFieldWarning
								key={`rw-${i}`}
								field={p.from}
								options={upstream.columns}
							/>
						))}
					</div>
				)}

				{/* 11. UNIQUE 節點介面 */}
				{nodeType === "UNIQUE" && (
					<div className={boxCls}>
						<div className={titleCls}>Unique（去重）</div>
						<FieldListEditor
							listId={`unique-${id}`}
							options={upstream.columns}
							value={nameListOf("columns")}
							onChange={(next) => setNameList("columns", next)}
							placeholder="去重鍵（逗號分隔；留空 = 整列去重）"
							hint={
								nameListOf("columns").length === 0
									? "SELECT DISTINCT * —— 整列完全相同才算重複"
									: "DISTINCT ON (鍵) —— 每個鍵只保留第一列"
							}
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
					</div>
				)}

				{/* 12. IMPUTE 節點介面 */}
				{nodeType === "IMPUTE" && (
					<div className={boxCls}>
						<div className={titleCls}>Impute（補空值）</div>
						<FieldListEditor
							listId={`impute-${id}`}
							options={upstream.columns}
							value={nameListOf("columns")}
							onChange={(next) => setNameList("columns", next)}
							placeholder="要補的欄位（逗號分隔）"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
						<div className="flex items-center space-x-1">
							<select
								value={config.method || "CONSTANT"}
								onChange={(e) => updateConfig("method", e.target.value)}
								className={selectCls}
							>
								<option value="CONSTANT">CONSTANT（常數）</option>
								<option value="MEAN">MEAN（該欄平均）</option>
							</select>
							{(config.method || "CONSTANT") === "CONSTANT" && (
								<input
									value={config.fillValue ?? "0"}
									onChange={(e) =>
										updateConfig("fillValue", e.target.value)
									}
									placeholder="補值"
									className={`w-24 ${inputCls}`}
								/>
							)}
						</div>
						<div className={hintCls}>
							{(config.method || "CONSTANT") === "MEAN"
								? "COALESCE(欄位, AVG(欄位) OVER ()) —— 以整表平均填補"
								: "COALESCE(欄位, 常數)"}
						</div>
					</div>
				)}

				{/* 13. DATA_CLEANSING 節點介面 */}
				{nodeType === "DATA_CLEANSING" && (
					<div className={boxCls}>
						<div className={titleCls}>Data Cleansing（清理文字）</div>
						<FieldListEditor
							listId={`clean-${id}`}
							options={upstream.columns}
							value={nameListOf("columns")}
							onChange={(next) => setNameList("columns", next)}
							placeholder="要清理的欄位（逗號分隔）"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
						<div className="flex flex-wrap gap-2">
							{(
								[
									["trim", "去頭尾空白"],
									["collapse", "壓縮內部空白"],
									["emptyToNull", "空字串轉 NULL"],
								] as const
							).map(([key, label]) => (
								<label
									key={key}
									className="flex items-center space-x-1 text-[9px] font-mono opacity-70"
								>
									<input
										type="checkbox"
										checked={config[key] !== false}
										onChange={(e) =>
											updateConfigValue({
												[key]: e.target.checked,
											})
										}
									/>
									<span>{label}</span>
								</label>
							))}
						</div>
						<div className={hintCls}>
							壓縮內部空白會連帶去頭尾；空字串轉 NULL 等同
							NULLIF(..., '')
						</div>
					</div>
				)}

				{/* 14. CROSS_TAB 節點介面 */}
				{nodeType === "CROSS_TAB" && (
					<div className={boxCls}>
						<div className={titleCls}>Cross Tab（列轉欄）</div>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`pivot-${id}`}
								options={upstream.columns}
								value={config.pivotColumn || ""}
								onValueChange={(v) => updateConfig("pivotColumn", v)}
								placeholder="展開欄位"
								className={`flex-1 ${inputCls}`}
							/>
							<span className="text-[10px] font-mono opacity-50">→</span>
							<FieldInput
								listId={`pivotval-${id}`}
								options={upstream.columns}
								value={config.valueColumn || ""}
								onValueChange={(v) => updateConfig("valueColumn", v)}
								placeholder="取值欄位"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<div className="flex items-center space-x-1">
							<select
								value={config.aggFunc || "SUM"}
								onChange={(e) => updateConfig("aggFunc", e.target.value)}
								className={selectCls}
							>
								{["SUM", "AVG", "COUNT", "MIN", "MAX", "FIRST"].map(
									(f) => (
										<option key={f} value={f}>
											{f}
										</option>
									),
								)}
							</select>
							<span className={hintCls}>聚合函數</span>
						</div>
						<FieldListEditor
							listId={`pivotgroup-${id}`}
							options={upstream.columns}
							value={
								Array.isArray(config.groupBy)
									? config.groupBy
									: String(config.groupBy ?? "")
											.split(",")
											.map((s) => s.trim())
											.filter(Boolean)
							}
							onChange={(next) => setNameList("groupBy", next)}
							placeholder="保留為列的欄位（逗號分隔）"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
					</div>
				)}

				{/* 15. TRANSPOSE 節點介面 */}
				{nodeType === "TRANSPOSE" && (
					<div className={boxCls}>
						<div className={titleCls}>Transpose（欄轉列）</div>
						<FieldListEditor
							listId={`transpose-${id}`}
							options={upstream.columns}
							value={nameListOf("columns")}
							onChange={(next) => setNameList("columns", next)}
							placeholder="要轉的欄位（逗號分隔）"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
						<div className="flex items-center space-x-1">
							<input
								value={config.nameColumn ?? "metric"}
								onChange={(e) =>
									updateConfig("nameColumn", e.target.value)
								}
								placeholder="名稱欄位"
								className={`flex-1 ${inputCls}`}
							/>
							<input
								value={config.valueColumn ?? "value"}
								onChange={(e) =>
									updateConfig("valueColumn", e.target.value)
								}
								placeholder="值欄位"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<div className={hintCls}>
							未列在上面的欄位會自動保留，作為識別欄
						</div>
					</div>
				)}

				{/* 16. TEXT_TO_COLUMNS 節點介面 */}
				{nodeType === "TEXT_TO_COLUMNS" && (
					<div className={boxCls}>
						<div className={titleCls}>Text to Columns（拆欄）</div>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`t2c-${id}`}
								options={upstream.columns}
								value={config.field || ""}
								onValueChange={(v) => updateConfig("field", v)}
								placeholder="來源欄位"
								className={`flex-1 ${inputCls}`}
							/>
							<select
								value={config.splitMode || "SEPARATOR"}
								onChange={(e) =>
									updateConfig("splitMode", e.target.value)
								}
								className={`w-28 ${inputCls}`}
							>
								<option value="SEPARATOR">字面分隔符</option>
								<option value="REGEX">正規表示式</option>
							</select>
						</div>
						<div className="flex items-center space-x-1">
							<input
								value={config.separator ?? ","}
								onChange={(e) =>
									updateConfig("separator", e.target.value)
								}
								placeholder={
									(config.splitMode || "SEPARATOR") === "REGEX"
										? "樣式，例如 \\s+"
										: "分隔符，例如 ,"
								}
								className={`flex-1 ${inputCls}`}
							/>
							{(config.splitMode || "SEPARATOR") === "REGEX" && (
								<label className="flex items-center space-x-1 text-[9px] font-mono opacity-70">
									<input
										type="checkbox"
										checked={config.caseInsensitive === true}
										onChange={(e) =>
											updateConfigValue({
												caseInsensitive: e.target.checked,
											})
										}
									/>
									<span>忽略大小寫</span>
								</label>
							)}
						</div>
						<FieldListEditor
							listId={`t2cout-${id}`}
							options={[]}
							value={nameListOf("outputColumns")}
							onChange={(next) => setNameList("outputColumns", next)}
							placeholder="輸出欄位名（逗號分隔）"
							hint="依序對應第 1、2、3… 段；資料不足的段會是 NULL"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
						<div className={hintCls}>
							{(config.splitMode || "SEPARATOR") === "REGEX"
								? "樣式是 RE2 / Rust regex 語法；空樣式會跳過這個節點"
								: "字面比對，不需要跳脫特殊字元"}
						</div>
						<MissingFieldWarning
							field={config.field}
							options={upstream.columns}
						/>
					</div>
				)}

				{/* 17. REGEX 節點介面 */}
				{nodeType === "REGEX" && (
					<div className={boxCls}>
						<div className={titleCls}>RegEx（正規表示式）</div>
						<div className="flex items-center space-x-1">
							<select
								value={config.regexMode || "MATCH"}
								onChange={(e) =>
									updateConfig("regexMode", e.target.value)
								}
								className={`w-24 ${inputCls}`}
							>
								<option value="MATCH">MATCH</option>
								<option value="PARSE">PARSE</option>
								<option value="REPLACE">REPLACE</option>
							</select>
							<FieldInput
								listId={`regex-${id}`}
								options={upstream.columns}
								value={config.field || ""}
								onValueChange={(v) => updateConfig("field", v)}
								placeholder="來源欄位"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<input
							value={config.pattern ?? ""}
							onChange={(e) => updateConfig("pattern", e.target.value)}
							placeholder={"樣式，例如 ([A-Z]{2})-(\\d+)"}
							className={`w-full ${inputCls}`}
						/>
						<label className="flex items-center space-x-1 text-[9px] font-mono opacity-70">
							<input
								type="checkbox"
								checked={config.caseInsensitive === true}
								onChange={(e) =>
									updateConfigValue({
										caseInsensitive: e.target.checked,
									})
								}
							/>
							<span>忽略大小寫（摺進樣式的 (?i)）</span>
						</label>

						{(config.regexMode || "MATCH") === "PARSE" ? (
							<FieldListEditor
								listId={`regexout-${id}`}
								options={[]}
								value={nameListOf("outputColumns")}
								onChange={(next) =>
									setNameList("outputColumns", next)
								}
								placeholder="擷取欄位名（逗號分隔）"
								hint="依序對應第 1、2、3… 個 capture group；未命中時 DuckDB 回空字串、Polars 回 NULL"
								inputClassName={inputCls}
								chipClassName={chipCls}
							/>
						) : (
							<div className="flex items-center space-x-1">
								<input
									value={
										config.outputColumn ??
										((config.regexMode || "MATCH") ===
										"REPLACE"
											? "regex_replaced"
											: "regex_match")
									}
									onChange={(e) =>
										updateConfig(
											"outputColumn",
											e.target.value,
										)
									}
									placeholder="輸出欄位"
									className={`flex-1 ${inputCls}`}
								/>
								{(config.regexMode || "MATCH") ===
									"REPLACE" && (
									<input
										value={config.replacement ?? ""}
										onChange={(e) =>
											updateConfig(
												"replacement",
												e.target.value,
											)
										}
										placeholder={"取代字串（\\1 反向參照）"}
										className={`flex-1 ${inputCls}`}
									/>
								)}
							</div>
						)}
						<MissingFieldWarning
							field={config.field}
							options={upstream.columns}
						/>
					</div>
				)}

				{/* 18. MULTI_FIELD_FORMULA 節點介面 */}
				{nodeType === "MULTI_FIELD_FORMULA" && (
					<div className={boxCls}>
						<div className={titleCls}>Multi-Field Formula（一次改多欄）</div>
						<FieldListEditor
							listId={`mff-${id}`}
							options={upstream.columns}
							value={nameListOf("columns")}
							onChange={(next) => setNameList("columns", next)}
							placeholder="要套用的欄位（逗號分隔）"
							hint="運算式會逐一套用到這些欄位；重複的欄位會被忽略"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
						<input
							value={config.expression ?? ""}
							onChange={(e) =>
								updateConfig("expression", e.target.value)
							}
							placeholder="運算式，例如 TRIM(_CurrentField_)"
							className={`w-full ${inputCls}`}
						/>
						<div className="flex items-center space-x-1">
							<select
								value={config.outputMode || "OVERWRITE"}
								onChange={(e) =>
									updateConfig("outputMode", e.target.value)
								}
								className={`flex-1 ${inputCls}`}
							>
								<option value="OVERWRITE">就地改寫原欄位</option>
								<option value="NEW_FIELD">新增欄位（保留原欄位）</option>
							</select>
							{(config.outputMode || "OVERWRITE") ===
								"NEW_FIELD" && (
								<input
									value={config.newFieldSuffix ?? "_new"}
									onChange={(e) =>
										updateConfig(
											"newFieldSuffix",
											e.target.value,
										)
									}
									placeholder="_new"
									className={`w-24 ${inputCls}`}
								/>
							)}
						</div>
						{/* 少了 _CurrentField_ 時，SQL 與 Polars 都會退回 passthrough
						    （見 astCompiler / exportPolars 的說明）—— 在這裡說清楚，
						    否則使用者只會看到節點什麼都沒做。 */}
						{!hasCurrentField(config.expression) && (
							<div className="text-[9px] font-mono text-rose-500">
								⚠ 運算式沒有用到 _CurrentField_ —— 節點會直接跳過，不會改動任何欄位
							</div>
						)}
						<div className={hintCls}>
							用 _CurrentField_ 代表當前欄位，例如
							UPPER(_CurrentField_) 或 _CurrentField_ * 1.1
						</div>
					</div>
				)}

				{/* 19. MULTI_ROW_FORMULA 節點介面 */}
				{nodeType === "MULTI_ROW_FORMULA" && (
					<div className={boxCls}>
						<div className={titleCls}>Multi-Row Formula（跨列）</div>
						<input
							value={config.outputColumn ?? ""}
							onChange={(e) => updateConfig("outputColumn", e.target.value)}
							placeholder="新欄位名"
							className={`w-full ${inputCls}`}
						/>
						<input
							value={config.expression ?? ""}
							onChange={(e) => updateConfig("expression", e.target.value)}
							placeholder="例如 LAG(amount, 1) - amount"
							className={`w-full ${inputCls}`}
						/>
						<FieldListEditor
							listId={`mrfpart-${id}`}
							options={upstream.columns}
							value={nameListOf("partitionBy")}
							onChange={(next) => setNameList("partitionBy", next)}
							placeholder="分區鍵（逗號分隔；留空 = 整表一個分區）"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`mrforder-${id}`}
								options={upstream.columns}
								value={config.orderBy ?? ""}
								onValueChange={(v) => updateConfig("orderBy", v)}
								placeholder="排序鍵"
								className={`flex-1 ${inputCls}`}
							/>
							<label className="flex items-center space-x-1 text-[9px] font-mono opacity-70">
								<input
									type="checkbox"
									checked={config.descending === true}
									onChange={(e) =>
										updateConfigValue({
											descending: e.target.checked,
										})
									}
								/>
								<span>遞減</span>
							</label>
						</div>
						<div className={hintCls}>
							可用 LAG / LEAD；無法自動翻譯成 Polars 時匯出會標記
						</div>
					</div>
				)}

				{/* 20. RUNNING_TOTAL 節點介面 */}
				{nodeType === "RUNNING_TOTAL" && (
					<div className={boxCls}>
						<div className={titleCls}>Running Total（累計）</div>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`rt-${id}`}
								options={upstream.columns}
								value={config.target || ""}
								onValueChange={(v) => updateConfig("target", v)}
								placeholder="累計欄位"
								className={`flex-1 ${inputCls}`}
							/>
							<input
								value={config.outputColumn ?? ""}
								onChange={(e) =>
									updateConfig("outputColumn", e.target.value)
								}
								placeholder="輸出欄位名"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<FieldListEditor
							listId={`rtpart-${id}`}
							options={upstream.columns}
							value={nameListOf("partitionBy")}
							onChange={(next) => setNameList("partitionBy", next)}
							placeholder="分區鍵（逗號分隔）"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`rtorder-${id}`}
								options={upstream.columns}
								value={config.orderBy ?? ""}
								onValueChange={(v) => updateConfig("orderBy", v)}
								placeholder="排序鍵（決定累加順序）"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<div className={hintCls}>
							SUM(...) OVER (… ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT
							ROW)
						</div>
					</div>
				)}

				{/* 21. RANK 節點介面 */}
				{nodeType === "RANK" && (
					<div className={boxCls}>
						<div className={titleCls}>Rank（排名）</div>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`rank-${id}`}
								options={upstream.columns}
								value={config.target || ""}
								onValueChange={(v) => updateConfig("target", v)}
								placeholder="排名依據欄位"
								className={`flex-1 ${inputCls}`}
							/>
							<input
								value={config.outputColumn ?? ""}
								onChange={(e) =>
									updateConfig("outputColumn", e.target.value)
								}
								placeholder="輸出欄位名"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<div className="flex items-center space-x-1">
							<select
								value={config.method || "RANK"}
								onChange={(e) => updateConfig("method", e.target.value)}
								className={selectCls}
							>
								<option value="RANK">RANK（並列會跳號）</option>
								<option value="DENSE_RANK">DENSE_RANK（不跳號）</option>
								<option value="ROW_NUMBER">ROW_NUMBER（不並列）</option>
							</select>
							<label className="flex items-center space-x-1 text-[9px] font-mono opacity-70">
								<input
									type="checkbox"
									checked={config.descending !== false}
									onChange={(e) =>
										updateConfigValue({
											descending: e.target.checked,
										})
									}
								/>
								<span>大者在先</span>
							</label>
						</div>
						<FieldListEditor
							listId={`rankpart-${id}`}
							options={upstream.columns}
							value={nameListOf("partitionBy")}
							onChange={(next) => setNameList("partitionBy", next)}
							placeholder="分區鍵（逗號分隔）"
							inputClassName={inputCls}
							chipClassName={chipCls}
						/>
					</div>
				)}

				{/* 22. APPEND_FIELDS 節點介面 */}
				{nodeType === "APPEND_FIELDS" && (
					<div className={boxCls}>
						<div className={titleCls}>Append Fields（附加欄位）</div>
						<div className={hintCls}>
							不需鍵 —— 把右邊輸入的欄位接到左邊每一列後面
							（CROSS JOIN）。
						</div>
						<div className="text-[9px] font-mono text-amber-600">
							⚠ 列數 = 左 × 右。右邊若有 1 萬列，左邊每一列都會被複製 1 萬次。
						</div>
					</div>
				)}

				{/* 23. FIND_REPLACE 節點介面 */}
				{nodeType === "FIND_REPLACE" && (
					<div className={boxCls}>
						<div className={titleCls}>Find Replace（查找替換）</div>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`fr-find-${id}`}
								options={upstream.columns}
								value={config.findField || ""}
								onValueChange={(v) => updateConfig("findField", v)}
								placeholder="來源鍵"
								className={`flex-1 ${inputCls}`}
							/>
							<span className="text-[10px] font-mono opacity-50">=</span>
							<FieldInput
								listId={`fr-lookup-${id}`}
								options={[]}
								value={config.lookupField || ""}
								onValueChange={(v) => updateConfig("lookupField", v)}
								placeholder="查找表鍵"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<div className="flex items-center space-x-1">
							<FieldInput
								listId={`fr-replace-${id}`}
								options={[]}
								value={config.replaceField || ""}
								onValueChange={(v) => updateConfig("replaceField", v)}
								placeholder="取回的值欄位"
								className={`flex-1 ${inputCls}`}
							/>
							<input
								value={config.outputColumn ?? ""}
								onChange={(e) =>
									updateConfig("outputColumn", e.target.value)
								}
								placeholder="輸出欄位（留空 = 覆蓋來源鍵）"
								className={`flex-1 ${inputCls}`}
							/>
						</div>
						<div className="flex items-center space-x-1">
							<select
								value={config.unmatched || "KEEP"}
								onChange={(e) =>
									updateConfig("unmatched", e.target.value)
								}
								className={selectCls}
							>
								<option value="KEEP">未命中：保留原值</option>
								<option value="NULL">未命中：設為 NULL</option>
							</select>
						</div>
						<div className={hintCls}>
							只帶回一個值欄位（不像 Join 會帶回右表全部欄位）
						</div>
					</div>
				)}

				{/* SQL 預覽區塊 */}
				{showSqlPreview && (
					<div
						className={`p-2 rounded font-mono text-[10px] border ${
							isLight
								? "bg-stone-900 text-stone-200 border-stone-800"
								: "bg-slate-950 text-slate-400 border-slate-800"
						}`}
					>
						<code>{data.sqlQuery}</code>
					</div>
				)}
			</div>

			{/* 👉 右側 Source 埠 */}
			{nodeType === "FILTER" ? (
				<>
					<span className="absolute right-2 top-[30%] -translate-y-1/2 text-[9px] font-mono font-bold text-emerald-600 dark:text-emerald-400">
						T
					</span>
					<Handle
						type="source"
						id="true"
						position={Position.Right}
						style={{ top: "30%", backgroundColor: "#10B981" }}
						className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -right-1.5"
					/>
					<span className="absolute right-2 top-[70%] -translate-y-1/2 text-[9px] font-mono font-bold text-rose-600 dark:text-rose-400">
						F
					</span>
					<Handle
						type="source"
						id="false"
						position={Position.Right}
						style={{ top: "70%", backgroundColor: "#EF4444" }}
						className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -right-1.5"
					/>
				</>
			) : (
				<Handle
					type="source"
					position={Position.Right}
					style={{ top: "50%", backgroundColor: tokens.accent }}
					className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -right-1.5 -translate-y-1/2"
				/>
			)}
		</div>
	);
};
