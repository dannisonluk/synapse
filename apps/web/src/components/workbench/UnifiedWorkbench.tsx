import React, { useState } from "react";
import {
	Sparkles,
	Layers,
	Sliders,
	PlaySquare,
	Eye,
	MessageSquare,
	ChevronDown,
	ChevronUp,
} from "lucide-react";
import { ExecutionViewMode, SynapseASTGraph } from "../../types/workbench";
import { NymphCanvas } from "../nymph/NymphCanvas";
import { Palette } from "./Palette";
import { ikaros } from "../../engine/ikaros/client";

export const UnifiedWorkbench: React.FC = () => {
	const [viewMode, setViewMode] = useState<ExecutionViewMode>("CANVAS_FOCUS");
	const [isHermesOpen, setIsHermesOpen] = useState(true);
	const [isDrawerOpen, setIsDrawerOpen] = useState(true);
	const [chatMessages, setChatMessages] = useState<
		Array<{ sender: "user" | "hermes"; text: string; dataPreview?: any }>
	>([
		{
			sender: "hermes",
			text: "Hello! I am Hermes. I can generate DAG flows or run inline calculations for you.",
		},
	]);
	const [inputPrompt, setInputPrompt] = useState("");

	// 在 UnifiedWorkbench.tsx 中的 handleSendMessage 方法更新：
	const handleSendMessage = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!inputPrompt.trim()) return;

		const userText = inputPrompt;
		setInputPrompt("");
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
					body: JSON.stringify({
						prompt: userText,
						execution_mode: viewMode,
						current_dag: { nodes: [], edges: [] }, // 可帶入當前畫布節點
					}),
				},
			);

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
							text: `${data.message}\n(SQL: ${data.sql_query})`,
						},
					]);
				}
			} else if (data.action_type === "MUTATE_AST" && data.ast_patch) {
				setChatMessages((prev) => [
					...prev,
					{ sender: "hermes", text: data.message },
				]);
				// 觸發畫布新增節點通知
				window.dispatchEvent(
					new CustomEvent("SYNAPSE_AST_PATCH", {
						detail: data.ast_patch,
					}),
				);
			}
		} catch (err) {
			setChatMessages((prev) => [
				...prev,
				{ sender: "hermes", text: "Hermes Agent Connection Failed." },
			]);
		}
	};

	return (
		<div className="w-screen h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans">
			{/* 頂部 Header & 模式切換器 */}
			<header className="h-12 border-b border-slate-800 bg-slate-900/90 px-4 flex items-center justify-between z-20 shrink-0">
				<div className="flex items-center space-x-3">
					<div className="font-extrabold text-cyan-400 tracking-wider text-sm flex items-center space-x-1.5">
						<Sparkles className="w-4 h-4" />
						<span>SYNAPSE WORKBENCH</span>
					</div>
					<span className="text-slate-600">|</span>
					<span className="text-xs text-slate-400 font-mono">
						v1.0 (Agent + Alteryx + BI)
					</span>
				</div>

				{/* View Mode Toggle Switch */}
				<div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-1 space-x-1 text-xs">
					<button
						onClick={() => setViewMode("SILENT")}
						className={`flex items-center space-x-1.5 px-3 py-1 rounded-md transition-all ${
							viewMode === "SILENT"
								? "bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40"
								: "text-slate-400 hover:text-slate-200"
						}`}
					>
						<MessageSquare className="w-3.5 h-3.5" />
						<span>1) Silent Result Mode</span>
					</button>
					<button
						onClick={() => setViewMode("CANVAS_FOCUS")}
						className={`flex items-center space-x-1.5 px-3 py-1 rounded-md transition-all ${
							viewMode === "CANVAS_FOCUS"
								? "bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/40"
								: "text-slate-400 hover:text-slate-200"
						}`}
					>
						<Eye className="w-3.5 h-3.5" />
						<span>2) Canvas Focus Mode</span>
					</button>
				</div>

				<button className="flex items-center space-x-1 bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/40 text-xs px-3 py-1.5 rounded-lg transition-all font-bold">
					<PlaySquare className="w-4 h-4" />
					<span>Run Pipeline</span>
				</button>
			</header>

			{/* 主工作空間：左側 Palette + 中央 Canvas + 右側 Hermes Agent */}
			<div className="flex-1 flex relative overflow-hidden">
				{/* 左側 Alteryx Tool Palette */}
				<Palette />

				{/* 中央 Canvas 區域 */}
				<main className="flex-1 relative bg-slate-950">
					<NymphCanvas />
				</main>

				{/* 右側 Hermes Chat Side-Panel */}
				<aside
					className={`border-l border-slate-800 bg-slate-900/90 backdrop-blur flex flex-col transition-all duration-300 z-10 ${
						isHermesOpen ? "w-96" : "w-12"
					}`}
				>
					<div className="h-10 border-b border-slate-800 px-3 flex items-center justify-between bg-slate-900 shrink-0">
						{isHermesOpen && (
							<div className="flex items-center space-x-2 text-xs font-bold text-cyan-300">
								<Sparkles className="w-4 h-4 text-cyan-400 animate-pulse" />
								<span>Hermes AI Copilot</span>
							</div>
						)}
						<button
							onClick={() => setIsHermesOpen(!isHermesOpen)}
							className="text-slate-400 hover:text-slate-200 p-1 rounded"
						>
							{isHermesOpen ? "➔" : "⬅"}
						</button>
					</div>

					{isHermesOpen && (
						<div className="flex-1 flex flex-col justify-between p-3 overflow-hidden">
							{/* Message Stream */}
							<div className="flex-1 overflow-y-auto space-y-3 pr-1 text-xs">
								{chatMessages.map((msg, idx) => (
									<div
										key={idx}
										className={`p-3 rounded-lg max-w-[90%] ${
											msg.sender === "user"
												? "bg-cyan-600/20 border border-cyan-500/40 text-cyan-100 ml-auto"
												: "bg-slate-800/80 border border-slate-700/80 text-slate-200"
										}`}
									>
										<p>{msg.text}</p>
										{/* Silent Mode Inline Result Render */}
										{msg.dataPreview && (
											<div className="mt-2 bg-slate-950 p-2 rounded border border-slate-800 overflow-x-auto">
												<div className="text-[10px] text-cyan-400 font-mono mb-1">
													⚡ Query Output:
												</div>
												<pre className="text-[10px] text-slate-300">
													{JSON.stringify(
														msg.dataPreview,
														null,
														2,
													)}
												</pre>
											</div>
										)}
									</div>
								))}
							</div>

							{/* Chat Input */}
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
										viewMode === "SILENT"
											? "Ask Hermes to calculate silently..."
											: "Ask Hermes to modify canvas workflow..."
									}
									className="flex-1 bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg p-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none transition-colors"
								/>
								<button
									type="submit"
									className="bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-300 border border-cyan-500/50 p-2.5 rounded-lg transition-colors shrink-0"
								>
									➔
								</button>
							</form>
						</div>
					)}
				</aside>
			</div>

			{/* 底層 Ikaros Data Drawer (可收折數據抽屜) */}
			<footer
				className={`border-t border-slate-800 bg-slate-900 transition-all ${isDrawerOpen ? "h-40" : "h-8"}`}
			>
				<div
					onClick={() => setIsDrawerOpen(!isDrawerOpen)}
					className="h-8 bg-slate-950 px-4 flex items-center justify-between cursor-pointer border-b border-slate-800 hover:bg-slate-900 transition-colors"
				>
					<div className="flex items-center space-x-2 text-xs font-mono text-slate-400">
						<Sliders className="w-3.5 h-3.5 text-cyan-400" />
						<span>Ikaros Data Drawer & Execution Logs</span>
					</div>
					{isDrawerOpen ? (
						<ChevronDown className="w-4 h-4 text-slate-400" />
					) : (
						<ChevronUp className="w-4 h-4 text-slate-400" />
					)}
				</div>
				{isDrawerOpen && (
					<div className="p-3 text-xs font-mono text-slate-300 overflow-auto h-32">
						<div className="text-slate-500">
							// Select a node on canvas to inspect active Arrow
							Data Stream or DuckDB log...
						</div>
					</div>
				)}
			</footer>
		</div>
	);
};
