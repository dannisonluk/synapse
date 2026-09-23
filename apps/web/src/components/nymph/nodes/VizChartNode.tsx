import React, { useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { PieChart, RefreshCw, BarChart3, LineChart, Gauge } from "lucide-react";
import { ikaros } from "../../../engine/ikaros/client";
import { useTheme } from "../../../theme/ThemeContext";
import type { NodeConfig } from "../../../types/nodeConfig";

/**
 * 圖表類型。
 *
 * 由 types/nodeConfig.ts 的形狀表推導，不再手抄一次這四個字串
 * （這裡以前是本專案第四份 config 宣告）。
 */
export type ChartType = NonNullable<NodeConfig["chartType"]>;

/** 圖表節點只用到 config 的這三個欄位；其餘欄位與它無關。 */
export type VizChartConfig = Pick<NodeConfig, "chartType" | "xAxis" | "yAxis">;

interface VizChartNodeData extends Record<string, unknown> {
	label?: string;
	sqlQuery?: string;
	config?: VizChartConfig;
	/** 由畫布注入：把設定寫回 data.config（存檔與 Hermes context 都靠它） */
	onChangeConfig?: (newConfig: VizChartConfig) => void;
}

const CHART_COLORS = [
	"#58A6FF",
	"#DA5B2A",
	"#3FB950",
	"#F0B429",
	"#BF4B8A",
	"#A371F7",
	"#39C5CF",
	"#F0883E",
];

/**
 * 動態 BI 視覺化節點：Bar / Line / Pie / KPI
 * - 執行上游資料表查詢（data.sqlQuery）
 * - X/Y 軸由使用者動態選擇（options 來自查詢結果欄位）
 * - 100% 訂閱 ThemeContext
 */
export const VizChartNode: React.FC<
	NodeProps<Node<VizChartNodeData>>
> = ({ id, data, selected }) => {
	// 語意布林由 context 提供，元件不再自己拿 mode 字串比較
	const { tokens } = useTheme();

	const [chartData, setChartData] = useState<any[]>([]);
	const [loading, setLoading] = useState(false);
	const [chartType, setChartType] = useState<ChartType>(
		data.config?.chartType || "BAR",
	);
	const [xAxis, setXAxis] = useState(data.config?.xAxis || "");
	const [yAxis, setYAxis] = useState(data.config?.yAxis || "");

	// 外部 config 變動 → 同步回本地（存檔還原、Hermes 改 config 都會走這裡）
	useEffect(() => {
		setChartType(data.config?.chartType || "BAR");
		setXAxis(data.config?.xAxis || "");
		setYAxis(data.config?.yAxis || "");
	}, [data.config]);

	/**
	 * 設定一律寫回 data.config。
	 * 舊版只存在 local state：存檔不保留、送給 Hermes 的 current_dag 永遠是
	 * palette 預設值、元件重新掛載即遺失。
	 */
	const updateConfig = (patch: Partial<VizChartConfig>) => {
		const next: VizChartConfig = { chartType, xAxis, yAxis, ...patch };
		setChartType(next.chartType || "BAR");
		setXAxis(next.xAxis || "");
		setYAxis(next.yAxis || "");
		data.onChangeConfig?.(next);
	};

	const renderChart = async () => {
		if (!data.sqlQuery) return;
		setLoading(true);
		try {
			const res = await ikaros.query(data.sqlQuery);
			setChartData(res);
			// 自動填充軸：無設定時用首兩欄（也要寫回 config，否則重整就沒了）
			if (res.length > 0) {
				const keys = Object.keys(res[0]);
				const nextX = xAxis || keys[0] || "";
				const nextY = yAxis || keys[1] || keys[0] || "";
				if (nextX !== xAxis || nextY !== yAxis) {
					updateConfig({ xAxis: nextX, yAxis: nextY });
				}
			}
		} catch (e) {
			console.error("Viz Chart Execution Error:", e);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		renderChart();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data.sqlQuery]);

	const rows = chartData.slice(0, 50);
	const labels = rows.map((r) => String(r[xAxis] ?? ""));
	const values = rows.map((r) => Number(r[yAxis]) || 0);
	const maxVal = Math.max(1, ...values);
	const total = values.reduce((a, b) => a + b, 0) || 1;

	/** SVG 圓餅切片 path（極座標扇形） */
	const piePath = (
		startAngle: number,
		endAngle: number,
		r: number,
	): string => {
		const cx = 100;
		const cy = 100;
		const x1 = cx + r * Math.cos(startAngle);
		const y1 = cy + r * Math.sin(startAngle);
		const x2 = cx + r * Math.cos(endAngle);
		const y2 = cy + r * Math.sin(endAngle);
		const large = endAngle - startAngle > Math.PI ? 1 : 0;
		return `M${cx} ${cy} L${x1.toFixed(2)} ${y1.toFixed(
			2,
		)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(
			2,
		)} Z`;
	};

	const inputBorder = "var(--syn-border-hover)";
	const inputBg = "var(--syn-bg-card)";

	return (
		<div
			style={{
				backgroundColor: "var(--syn-bg-panel)",
				borderColor: selected
					? tokens.accent
					: "var(--syn-border)",
				boxShadow: selected
					? `0 0 0 2px ${tokens.accent}33`
					: "0 4px 12px rgba(0,0,0,0.05)",
			}}
			className="w-80 relative rounded-lg border p-3 text-xs font-sans transition-all"
		>
			<Handle
				type="target"
				position={Position.Left}
				style={{
					top: "50%",
					backgroundColor: "#A371F7",
				}}
				className="w-2.5 h-2.5 border-2 border-[var(--syn-bg-card)] -left-1.5 -translate-y-1/2"
			/>

			{/* Header */}
			<div
				className={`flex items-center justify-between pb-2 border-b border-[var(--syn-border)]`}
			>
				<div className="flex items-center space-x-2">
					<div
						className={`p-1 rounded bg-[var(--syn-accent-soft)] text-[var(--syn-accent-soft-text)]`}
					>
						<PieChart className="w-3.5 h-3.5" />
					</div>
					<div>
						<div
							className={`font-semibold text-[var(--syn-text-primary)]`}
						>
							{data.label || "BI Chart"}
						</div>
						<div
							className={`text-[9px] font-mono text-[var(--syn-text-secondary)]`}
						>
							VIZ_CHART
						</div>
					</div>
				</div>
				<button
					onClick={renderChart}
					className={`p-1 rounded hover:bg-[var(--syn-bg-hover)] text-[var(--syn-text-secondary)]`}
				>
					<RefreshCw
						className={`w-3.5 h-3.5 ${
							loading ? "animate-spin" : ""
						}`}
					/>
				</button>
			</div>

			{/* 圖型 + 軸設定 */}
			<div className="py-2 space-y-2">
				<div className="flex space-x-1">
					{(["BAR", "LINE", "PIE", "KPI"] as ChartType[]).map(
						(t) => (
							<button
								key={t}
								onClick={() => updateConfig({ chartType: t })}
								title={t}
								className={`flex-1 flex items-center justify-center p-1 rounded border text-[9px] font-bold ${
									chartType === t
										? "bg-[var(--syn-accent-soft)] text-[var(--syn-accent-soft-text)] border-[var(--syn-accent)]"
										: "bg-[var(--syn-bg-input)] text-[var(--syn-text-muted)] border-[var(--syn-border)]"
								}`}
							>
								{t === "BAR" && (
									<BarChart3 className="w-3 h-3 mr-0.5" />
								)}
								{t === "LINE" && (
									<LineChart className="w-3 h-3 mr-0.5" />
								)}
								{t === "PIE" && (
									<PieChart className="w-3 h-3 mr-0.5" />
								)}
								{t === "KPI" && (
									<Gauge className="w-3 h-3 mr-0.5" />
								)}
								{t}
							</button>
						),
					)}
				</div>

				<div className="grid grid-cols-2 gap-1">
					<select
						value={xAxis}
						onChange={(e) =>
							updateConfig({ xAxis: e.target.value })
						}
						style={{
							backgroundColor: inputBg,
							borderColor: inputBorder,
							color: tokens.textPrimary,
						}}
						className="px-1 py-0.5 rounded border text-[10px] font-mono"
					>
						<option value="">X Axis…</option>
						{chartData[0] &&
							Object.keys(chartData[0]).map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
					</select>
					<select
						value={yAxis}
						onChange={(e) =>
							updateConfig({ yAxis: e.target.value })
						}
						style={{
							backgroundColor: inputBg,
							borderColor: inputBorder,
							color: tokens.textPrimary,
						}}
						className="px-1 py-0.5 rounded border text-[10px] font-mono"
					>
						<option value="">Y Axis…</option>
						{chartData[0] &&
							Object.keys(chartData[0]).map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
					</select>
				</div>

				{/* 圖表渲染區 */}
				<div
					style={{
						backgroundColor: "var(--syn-bg-canvas)",
						borderColor: tokens.border,
					}}
					className="rounded border p-2"
				>
					{chartData.length > 0 && xAxis && yAxis ? (
						chartType === "KPI" ? (
							<div className="text-center py-4">
								<div
									style={{ color: tokens.accent }}
									className="text-3xl font-bold font-mono"
								>
									{values[0]?.toLocaleString() || "0"}
								</div>
								<div
									className={`text-[10px] font-mono mt-1 text-[var(--syn-text-muted)]`}
								>
									{yAxis} (top row)
								</div>
							</div>
						) : chartType === "PIE" ? (
							<svg
								viewBox="0 0 200 110"
								className="w-full h-auto"
							>
								{labels.slice(0, 8).map((label, i) => {
									const start =
										values
											.slice(0, i)
											.reduce((a, b) => a + b, 0) /
										total;
									const end =
										values
											.slice(0, i + 1)
											.reduce((a, b) => a + b, 0) /
										total;
									return (
										<path
											key={i}
											d={piePath(
												start * Math.PI * 2,
												end * Math.PI * 2,
												60,
											)}
											fill={
												CHART_COLORS[
													i % CHART_COLORS.length
												]
											}
											stroke={
												"var(--syn-bg-card)"
											}
											strokeWidth="1"
										/>
									);
								})}
								<g
									fontSize="6"
									fill={"var(--syn-text-primary)"}
								>
									{labels.slice(0, 5).map((label, i) => (
										<text
											key={i}
											x={130}
											y={14 + i * 14}
										>
											<rect
												x={122}
												y={i * 14 + 4}
												width="6"
												height="6"
												fill={
													CHART_COLORS[
														i %
															CHART_COLORS
																.length
													]
												}
											/>
											{String(label).slice(0, 14)}
										</text>
									))}
								</g>
							</svg>
						) : (
							<svg
								viewBox="0 0 280 110"
								className="w-full h-auto"
							>
								{chartType === "BAR"
									? values.slice(0, 10).map((v, i) => {
											const h =
												(v / maxVal) * 80;
											return (
												<g key={i}>
													<rect
														x={i * 26 + 6}
														y={96 - h}
														width="18"
														height={h}
														fill={
															CHART_COLORS[
																i %
																	CHART_COLORS
																		.length
															]
														}
														rx="2"
													/>
													<text
														x={i * 26 + 15}
														y={106}
														fontSize="6"
														textAnchor="middle"
														fill={
															"var(--syn-text-secondary)"
														}
													>
														{String(
															labels[i] ?? "",
														).slice(0, 6)}
													</text>
												</g>
											);
										})
									: (() => {
											const pts = values
												.slice(0, 20)
												.map((v, i) => {
													const x = 4 + (i * 272) / 19;
													const y = 96 - (v / maxVal) * 80;
													return `${x},${y}`;
												})
												.join(" ");
											return (
												<g>
													<polyline
														points={pts}
														fill="none"
														stroke={tokens.accent}
														strokeWidth="2"
													/>
													{values
														.slice(0, 20)
														.map((v, i) => {
															const x =
																4 +
																(i * 272) / 19;
															const y =
																96 -
																(v / maxVal) * 80;
															return (
																<circle
																	key={i}
																	cx={x}
																	cy={y}
																	r="2"
																	fill={
																		CHART_COLORS[
																			i %
																				CHART_COLORS
																					.length
																		]
																	}
																/>
															);
														})}
												</g>
											);
										})()}
							</svg>
						)
					) : (
						<div
							className={`text-center py-4 text-[10px] text-[var(--syn-text-secondary)]`}
						>
							{loading
								? "Loading data..."
								: "Connect upstream node and run pipeline, then configure X/Y axis"}
						</div>
					)}
				</div>
			</div>
		</div>
	);
};