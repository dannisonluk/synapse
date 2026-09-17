import React, { useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { Filter, Database, Sigma, GitMerge, Code } from "lucide-react";

export interface AlteryxNodeConfig {
	field?: string;
	op?: string;
	val?: string;
	groupBy?: string;
	func?: string;
	target?: string;
	tableName?: string;
	joinType?: string;
	key?: string;
}

export interface AlteryxNodeData extends Record<string, unknown> {
	label?: string;
	type?: string;
	config?: AlteryxNodeConfig;
	sqlQuery?: string;
	executionState?: "IDLE" | "RUNNING" | "SUCCESS" | "ERROR";
	onExecute?: () => void;
	onChangeConfig?: (newConfig: AlteryxNodeConfig) => void;
}

export const AlteryxNode: React.FC<NodeProps<Node<AlteryxNodeData>>> = ({
	id,
	data,
	selected,
}) => {
	const nodeType = data.type || "FILTER";
	const [showSqlPreview, setShowSqlPreview] = useState(false);
	const [config, setConfig] = useState<AlteryxNodeConfig>(data.config || {});

	const updateConfig = (key: keyof AlteryxNodeConfig, value: string) => {
		const updated = { ...config, [key]: value };
		setConfig(updated);
		if (data.onChangeConfig) {
			data.onChangeConfig(updated);
		}
	};

	const getCategoryTheme = () => {
		switch (nodeType) {
			case "INPUT_DUCKDB":
				return {
					bg: "bg-emerald-950/80",
					border: "border-emerald-500",
					icon: <Database className="w-4 h-4 text-emerald-400" />,
					label: "Input Data",
					cat: "In/Out",
				};
			case "FILTER":
				return {
					bg: "bg-blue-950/80",
					border: "border-blue-500",
					icon: <Filter className="w-4 h-4 text-blue-400" />,
					label: "Filter",
					cat: "Preparation",
				};
			case "SUMMARIZE":
				return {
					bg: "bg-amber-950/80",
					border: "border-amber-500",
					icon: <Sigma className="w-4 h-4 text-amber-400" />,
					label: "Summarize",
					cat: "Transform",
				};
			case "JOIN":
				return {
					bg: "bg-purple-950/80",
					border: "border-purple-500",
					icon: <GitMerge className="w-4 h-4 text-purple-400" />,
					label: "Join",
					cat: "Join",
				};
			default:
				return {
					bg: "bg-slate-900",
					border: "border-slate-700",
					icon: <Filter className="w-4 h-4 text-slate-400" />,
					label: "Tool",
					cat: "Custom",
				};
		}
	};

	const theme = getCategoryTheme();

	return (
		<div
			className={`w-80 rounded-xl border ${selected ? "border-cyan-400 shadow-cyan-500/20 shadow-lg" : theme.border} ${theme.bg} backdrop-blur-md p-3 text-slate-100 shadow-xl transition-all`}
		>
			{/* 頂部 Header */}
			<div className="flex items-center justify-between pb-2 border-b border-slate-800">
				<div className="flex items-center space-x-2">
					<div className="p-1.5 rounded-lg bg-slate-900/80 border border-slate-700/50">
						{theme.icon}
					</div>
					<div>
						<div className="text-xs font-bold text-slate-100">
							{data.label || theme.label}
						</div>
						<div className="text-[10px] text-slate-400 font-mono">
							{theme.cat}
						</div>
					</div>
				</div>
				<button
					onClick={() => setShowSqlPreview(!showSqlPreview)}
					className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-400"
				>
					<Code className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* 動態表單 Controls */}
			<div className="py-2.5 space-y-2 text-xs">
				{nodeType === "FILTER" && (
					<div className="space-y-1.5 bg-slate-900/60 p-2 rounded-lg border border-slate-800">
						<span className="text-[10px] font-bold text-blue-400 uppercase">
							Filter Condition
						</span>
						<div className="flex items-center space-x-1">
							<input
								value={config.field || "amount"}
								onChange={(e) =>
									updateConfig("field", e.target.value)
								}
								className="w-20 bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200 text-[11px]"
							/>
							<select
								value={config.op || ">"}
								onChange={(e) =>
									updateConfig("op", e.target.value)
								}
								className="bg-slate-950 border border-slate-800 rounded px-1 py-1 text-cyan-400 text-[11px]"
							>
								<option value="=">=</option>
								<option value=">">&gt;</option>
								<option value="<">&lt;</option>
								<option value="!=">!=</option>
							</select>
							<input
								value={config.val || "1000"}
								onChange={(e) =>
									updateConfig("val", e.target.value)
								}
								className="flex-1 bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200 text-[11px]"
							/>
						</div>
					</div>
				)}

				{nodeType === "SUMMARIZE" && (
					<div className="space-y-1.5 bg-slate-900/60 p-2 rounded-lg border border-slate-800">
						<span className="text-[10px] font-bold text-amber-400 uppercase">
							Summarize Actions
						</span>
						<div className="flex items-center justify-between text-[11px]">
							<span className="text-slate-400">Group By:</span>
							<input
								value={config.groupBy || "year"}
								onChange={(e) =>
									updateConfig("groupBy", e.target.value)
								}
								className="w-28 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 text-slate-200"
							/>
						</div>
						<div className="flex items-center justify-between text-[11px]">
							<span className="text-slate-400">Action:</span>
							<div className="flex space-x-1">
								<select
									value={config.func || "SUM"}
									onChange={(e) =>
										updateConfig("func", e.target.value)
									}
									className="bg-slate-950 border border-slate-800 rounded px-1 text-amber-400"
								>
									<option value="SUM">SUM</option>
									<option value="COUNT">COUNT</option>
									<option value="AVG">AVG</option>
								</select>
								<input
									value={config.target || "amount"}
									onChange={(e) =>
										updateConfig("target", e.target.value)
									}
									className="w-16 bg-slate-950 border border-slate-800 rounded px-1.5 text-slate-200"
								/>
							</div>
						</div>
					</div>
				)}

				{/* 自動轉譯 SQL 預覽 */}
				{showSqlPreview && (
					<div className="p-2 bg-slate-950 rounded border border-slate-800 font-mono text-[10px] text-slate-400">
						<code>{data.sqlQuery || "SELECT * FROM table;"}</code>
					</div>
				)}
			</div>

			{/* 腳位 Handle */}
			<Handle
				type="target"
				position={Position.Top}
				className="w-2.5 h-2.5 bg-slate-400 border-2 border-slate-950"
			/>
			{nodeType === "FILTER" ? (
				<div className="flex justify-between px-4 pt-1 text-[9px] font-bold text-slate-500">
					<div className="relative">
						<span>T</span>
						<Handle
							type="source"
							id="true"
							position={Position.Bottom}
							className="w-2.5 h-2.5 bg-emerald-400 border-2 border-slate-950"
						/>
					</div>
					<div className="relative">
						<span>F</span>
						<Handle
							type="source"
							id="false"
							position={Position.Bottom}
							className="w-2.5 h-2.5 bg-rose-400 border-2 border-slate-950"
						/>
					</div>
				</div>
			) : (
				<Handle
					type="source"
					position={Position.Bottom}
					className="w-2.5 h-2.5 bg-cyan-400 border-2 border-slate-950"
				/>
			)}
		</div>
	);
};
