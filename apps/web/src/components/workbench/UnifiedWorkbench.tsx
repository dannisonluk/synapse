import React, { useCallback, useState } from "react";
import {
	Sparkles,
	Sliders,
	Sun,
	Moon,
} from "lucide-react";
import { ExecutionViewMode } from "../../types/workbench";
import { NymphCanvas, InspectedNodePayload } from "../nymph/NymphCanvas";
import { Palette } from "./Palette";
import { DataDrawer } from "./DataDrawer";
import { ikaros } from "../../engine/ikaros/client";
import { ExecLogEntry } from "../../engine/scheduler";
import { useTheme, ThemeProvider } from "../../theme/ThemeContext";
import { Node, Edge } from "@xyflow/react";

/**
 * Hermes 請求逾時（毫秒）。
 * 舊版用裸 fetch 而且沒有 signal：後端連上但不回應時 isHermesBusy 永遠為 true，
 * 輸入框與送出按鈕永久停用，只能重新載入頁面。
 */
const HERMES_TIMEOUT_MS = 30_000;

const WorkbenchContent: React.FC = () => {
	/**
	 * Hermes 執行模式：
	 *   CANVAS_FOCUS → 生成多節點 pipeline 落畫布（MUTATE_AST）
	 *   SILENT       → 直接計算一條 SQL 並在 chat 回傳結果（INLINE_SQL）
	 * 舊版這個值是硬寫死 "CANVAS_FOCUS"，令後端 INLINE_SQL 路徑永遠走不到。
	 */
	const [viewMode, setViewMode] = useState<ExecutionViewMode>("CANVAS_FOCUS");
	const [isHermesOpen, setIsHermesOpen] = useState(true);
	const [isDrawerOpen, setIsDrawerOpen] = useState(true);
	const [inspectedPayload, setInspectedPayload] =
		useState<InspectedNodePayload | null>(null);
	const [canvasNodes, setCanvasNodes] = useState<Node[]>([]);
	const [canvasEdges, setCanvasEdges] = useState<Edge[]>([]);
	const [chatMessages, setChatMessages] = useState<
		Array<{ sender: "user" | "hermes"; text: string; dataPreview?: any }>
	>([
		{
			sender: "hermes",
			text: "Hello! I am Hermes. I can generate DAG flows or run inline calculations for you.\nExample: 「載入銷量數據，過濾 amount 大於 1000，再按 year 加總」",
		},
	]);
	const [inputPrompt, setInputPrompt] = useState("");
	const [isHermesBusy, setIsHermesBusy] = useState(false);

	const { mode, setMode, tokens } = useTheme();

	const handleCanvasStateChange = useCallback(
		(nodes: Node[], edges: Edge[]) => {
			setCanvasNodes(nodes);
			setCanvasEdges(edges);
		},
		[],
	);

	// Run Pipeline 全畫布執行 → 將執行 Log 顯示在 Drawer
	const handlePipelineLog = useCallback((logs: ExecLogEntry[]) => {
		setInspectedPayload({
			id: "pipeline",
			label: "Pipeline Run",
			nodeType: "PIPELINE",
			sqlQuery: "",
			// 全圖執行沒有單一輸出表 → Drawer 只顯示 Logs 分頁
			tableName: "",
			ok: logs.some((l) => l.level === "ERROR") ? false : true,
			logs,
		});
	}, []);

	const handleSendMessage = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!inputPrompt.trim() || isHermesBusy) return;

		const userText = inputPrompt;
		setInputPrompt("");
		setIsHermesBusy(true);
		setChatMessages((prev) => [
			...prev,
			{ sender: "user", text: userText },
		]);

		try {
			const response = await fetch(
				"http://localhost:8000/api/v1/hermes/chat",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					// 沒有這個 signal，後端 hang 住就會讓整個 chat 永久卡在 busy
					signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
					body: JSON.stringify({
						prompt: userText,
						execution_mode: viewMode,
						// 👉 真實畫布 DAG context（舊版永遠傳空陣列，AI 無從參考）
						current_dag: {
							nodes: canvasNodes.map((n) => ({
								id: n.id,
								label: (n.data as any).label,
								type: (n.data as any).type,
								config: (n.data as any).config,
							})),
							edges: canvasEdges.map((e) => ({
								source: e.source,
								target: e.target,
								targetHandle: e.targetHandle,
							})),
						},
					}),
				},
			);

			if (!response.ok) {
				throw new Error(`Hermes 回應 HTTP ${response.status}`);
			}
			const data = await response.json();

			if (data.action_type === "INLINE_SQL" && data.sql_query) {
				try {
					const queryResult = await ikaros.query(data.sql_query);
					setChatMessages((prev) => [
						...prev,
						{
							sender: "hermes",
							text: data.message,
							dataPreview: queryResult,
						},
					]);
				} catch (sqlErr) {
					setChatMessages((prev) => [
						...prev,
						{
							sender: "hermes",
							text: `${data.message}\n(SQL 執行失敗: ${String(
								(sqlErr as any)?.message || sqlErr,
							).slice(0, 300)})`,
						},
					]);
				}
			} else if (data.action_type === "MUTATE_AST" && data.ast_patch) {
				setChatMessages((prev) => [
					...prev,
					{ sender: "hermes", text: data.message },
				]);
				window.dispatchEvent(
					new CustomEvent("SYNAPSE_AST_PATCH", {
						detail: data.ast_patch,
					}),
				);
			} else {
				setChatMessages((prev) => [
					...prev,
					{ sender: "hermes", text: data.message || "Done." },
				]);
			}
		} catch (err: any) {
			// 逾時與 HTTP 錯誤要分開講，否則使用者只看到一句「連線失敗」而無從判斷
			const timedOut = err?.name === "TimeoutError";
			const text = timedOut
				? `Hermes 逾時：${HERMES_TIMEOUT_MS / 1000} 秒內沒有回應，已中止請求（可重試）。`
				: String(err?.message || "").startsWith("Hermes 回應 HTTP")
					? `${err.message} —— 請檢查後端日誌。`
					: "Hermes Agent Connection Failed — is the FastAPI backend running on :8000?";
			setChatMessages((prev) => [...prev, { sender: "hermes", text }]);
		} finally {
			setIsHermesBusy(false);
		}
	};

	return (
		<div
			style={{
				backgroundColor: tokens.bgCanvas,
				color: tokens.textPrimary,
			}}
			className="w-screen h-screen flex flex-col font-sans transition-colors duration-200"
		>
			{/* 頂部 Header */}
			<header
				style={{
					backgroundColor: tokens.bgPanel,
					borderColor: tokens.border,
				}}
				className="h-12 border-b px-4 flex items-center justify-between z-20 shrink-0"
			>
				<div className="flex items-center space-x-3">
					<span className="font-bold font-mono tracking-tight text-sm">
						SYNAPSE WORKBENCH
					</span>
					<span
						style={{
							backgroundColor: `${tokens.accent}15`,
							color: tokens.accent,
							borderColor: `${tokens.accent}30`,
						}}
						className="text-[10px] font-mono px-2 py-0.5 rounded border font-semibold"
					>
						{mode === "claude-light"
							? "Claude Light Theme"
							: "GitHub Dark Theme"}
					</span>
				</div>

				{/* 主題切換按鈕 */}
				<div className="flex items-center space-x-2">
					<button
						onClick={() =>
							setMode(
								mode === "claude-light"
									? "github-dark"
									: "claude-light",
							)
						}
						style={{
							backgroundColor: tokens.bgCard,
							borderColor: tokens.border,
							color: tokens.textPrimary,
						}}
						className="flex items-center space-x-2 px-3 py-1.5 text-xs rounded border shadow-sm hover:opacity-80 transition-all font-medium"
					>
						{mode === "claude-light" ? (
							<>
								<Moon className="w-3.5 h-3.5" />
								<span>GitHub Dark</span>
							</>
						) : (
							<>
								<Sun className="w-3.5 h-3.5 text-amber-500" />
								<span>Claude Light</span>
							</>
						)}
					</button>
				</div>
			</header>

			{/* 主工作空間 */}
			<div className="flex-1 flex relative overflow-hidden">
				<Palette />

				<main className="flex-1 relative">
					<NymphCanvas
						onInspectNode={setInspectedPayload}
						onPipelineLog={handlePipelineLog}
						onCanvasStateChange={handleCanvasStateChange}
					/>
				</main>

				{/* 右側 Hermes Chat */}
				<aside
					style={{
						backgroundColor: tokens.bgPanel,
						borderColor: tokens.border,
					}}
					className={`border-l flex flex-col transition-all duration-300 z-10 ${
						isHermesOpen ? "w-96" : "w-10"
					}`}
				>
					<div
						style={{ borderColor: tokens.border }}
						className="h-10 border-b px-3 flex items-center justify-between shrink-0"
					>
						{isHermesOpen && (
							<div
								style={{ color: tokens.accent }}
								className="flex items-center space-x-2 text-xs font-bold"
							>
								<Sparkles className="w-4 h-4 animate-pulse" />
								<span>Hermes AI Copilot</span>
							</div>
						)}
						{isHermesOpen && (
							<div
								className="flex rounded border overflow-hidden text-[9px] font-mono"
								style={{ borderColor: tokens.border }}
							>
								<button
									onClick={() => setViewMode("CANVAS_FOCUS")}
									title="生成多節點 pipeline 落畫布"
									style={{
										backgroundColor:
											viewMode === "CANVAS_FOCUS"
												? `${tokens.accent}22`
												: tokens.bgCard,
										color:
											viewMode === "CANVAS_FOCUS"
												? tokens.accent
												: tokens.textSecondary,
									}}
									className="px-2 py-1 font-bold"
								>
									PIPELINE
								</button>
								<button
									onClick={() => setViewMode("SILENT")}
									title="直接執行一條 SQL 並回傳結果"
									style={{
										backgroundColor:
											viewMode === "SILENT"
												? `${tokens.accent}22`
												: tokens.bgCard,
										color:
											viewMode === "SILENT"
												? tokens.accent
												: tokens.textSecondary,
										borderColor: tokens.border,
									}}
									className="px-2 py-1 font-bold border-l"
								>
									INLINE
								</button>
							</div>
						)}
						<button
							onClick={() => setIsHermesOpen(!isHermesOpen)}
							style={{ color: tokens.textSecondary }}
							className="p-1 rounded hover:opacity-80"
						>
							{isHermesOpen ? "➔" : "⬅"}
						</button>
					</div>

					{isHermesOpen && (
						<div className="flex-1 flex flex-col justify-between p-3 overflow-hidden">
							<div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs">
								{chatMessages.map((msg, idx) => (
									<div
										key={idx}
										style={{
											backgroundColor:
												msg.sender === "user"
													? `${tokens.accent}15`
													: tokens.bgCard,
											borderColor:
												msg.sender === "user"
													? `${tokens.accent}40`
													: tokens.border,
											color: tokens.textPrimary,
										}}
										className="p-3 rounded-lg border max-w-[90%]"
									>
										<p className="whitespace-pre-wrap">{msg.text}</p>
										{msg.dataPreview && (
											<div
												style={{
													backgroundColor:
														tokens.bgCanvas,
													borderColor: tokens.border,
												}}
												className="mt-2 p-2 rounded border overflow-auto max-h-48"
											>
												<div
													style={{
														color: tokens.accent,
													}}
													className="text-[10px] font-mono mb-1"
												>
													⚡ Query Output:{" "}
													{msg.dataPreview.length} rows
												</div>
												<table className="w-full text-left text-[10px] font-mono">
													<thead>
														<tr>
															{Object.keys(
																msg.dataPreview[0] ||
																	{},
															)
																.slice(0, 6)
																.map((col) => (
																	<th
																		key={col}
																		className="pb-1 pr-2"
																		style={{
																			color: tokens.accent,
																		}}
																	>
																		{col}
																	</th>
																))}
														</tr>
													</thead>
													<tbody>
														{msg.dataPreview
																													.slice(0, 20)
																													.map(
																														(
																															row: Record<
																																string,
																																any
																															>,
																															rIdx: number,
																														) => (
																	<tr
																		key={
																			rIdx
																		}
																	>
																		{Object.keys(
																			msg
																				.dataPreview[0] ||
																				{},
																		)
																			.slice(
																				0,
																				6,
																			)
																			.map(
																				(
																					col,
																				) => (
																					<td
																						key={
																							col
																						}
																						className="py-0.5 pr-2 truncate max-w-[80px]"
																					>
																						{String(
																							row[
																								col
																							],
																						)}
																					</td>
																				),
																			)}
																	</tr>
																),
															)}
													</tbody>
												</table>
											</div>
										)}
									</div>
								))}
								{isHermesBusy && (
									<div
										style={{
											backgroundColor: tokens.bgCard,
											borderColor: tokens.border,
											color: tokens.textSecondary,
										}}
										className="p-3 rounded-lg border text-[10px] font-mono"
									>
										🤖 Hermes is thinking...
									</div>
								)}
							</div>

							<form
								onSubmit={handleSendMessage}
								className="mt-3 flex items-center space-x-2 shrink-0"
							>
								<input
									type="text"
									value={inputPrompt}
									onChange={(e) =>
										setInputPrompt(e.target.value)
									}
									placeholder={
										viewMode === "CANVAS_FOCUS"
											? "Describe a pipeline to build on the canvas…"
											: "Ask for an inline calculation…"
									}
									style={{
										backgroundColor: tokens.bgCard,
										borderColor: tokens.border,
										color: tokens.textPrimary,
									}}
									className="flex-1 border rounded-lg p-2.5 text-xs focus:outline-none"
								/>
								<button
									type="submit"
									disabled={isHermesBusy}
									style={{
										backgroundColor: tokens.accent,
										color: "#FFFFFF",
									}}
									className="p-2.5 rounded-lg font-bold text-xs shrink-0 shadow disabled:opacity-50"
								>
									➔
								</button>
							</form>
						</div>
					)}
				</aside>
			</div>

			{/* 底部 Data Drawer（已真正接駁節點 Inspect / Pipeline Log） */}
			<DataDrawer
				isOpen={isDrawerOpen}
				onToggle={() => setIsDrawerOpen(!isDrawerOpen)}
				payload={inspectedPayload}
			/>
		</div>
	);
};

export const UnifiedWorkbench: React.FC = () => (
	<ThemeProvider>
		<WorkbenchContent />
	</ThemeProvider>
);