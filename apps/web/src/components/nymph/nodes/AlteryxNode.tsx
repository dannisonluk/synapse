import React, { useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import {
	Filter,
	Database,
	Sigma,
	GitMerge,
	Code,
	Calculator,
} from "lucide-react";

export interface AlteryxNodeConfig {
	field?: string;
	op?: string;
	val?: string;
	groupBy?: string;
	func?: string;
	target?: string;
	tableName?: string;
	joinType?: string;
	leftKey?: string;
	rightKey?: string;
	outputColumn?: string;
	expression?: string;
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
			case "FORMULA":
				return {
					bg: "bg-teal-950/80",
					border: "border-teal-500",
					icon: <Calculator className="w-4 h-4 text-teal-400" />,
					label: "Formula",
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
			className={`w-80 relative rounded-xl border ${selected ? "border-cyan-400 shadow-cyan-500/30 shadow-xl" : theme.border} ${theme.bg} backdrop-blur-md p-3 text-slate-100 shadow-xl transition-all`}
		>
			{/* 👈 左側 Target 腳位（貼合左邊框） */}
			{nodeType === "JOIN" ? (
				<>
					<div className="absolute left-2 top-[30%] -translate-y-1/2 text-[9px] font-bold text-purple-300 pointer-events-none">
						L
					</div>
					<Handle
						type="target"
						id="left"
						position={Position.Left}
						style={{ top: "30%" }}
						className="w-3 h-3 bg-purple-400 border-2 border-slate-950 -left-1.5"
					/>

					<div className="absolute left-2 top-[70%] -translate-y-1/2 text-[9px] font-bold text-purple-300 pointer-events-none">
						R
					</div>
					<Handle
						type="target"
						id="right"
						position={Position.Left}
						style={{ top: "70%" }}
						className="w-3 h-3 bg-purple-400 border-2 border-slate-950 -left-1.5"
					/>
				</>
			) : (
				<Handle
					type="target"
					position={Position.Left}
					style={{ top: "50%" }}
					className="w-3 h-3 bg-slate-300 border-2 border-slate-950 -left-1.5 -translate-y-1/2"
				/>
			)}

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

				{nodeType === "FORMULA" && (
					<div className="space-y-1.5 bg-slate-900/60 p-2 rounded-lg border border-slate-800">
						<span className="text-[10px] font-bold text-teal-400 uppercase">
							New Column Formula
						</span>
						<div className="flex items-center justify-between text-[11px]">
							<span className="text-slate-400">Output Col:</span>
							<input
								value={config.outputColumn || "amount_taxed"}
								onChange={(e) =>
									updateConfig("outputColumn", e.target.value)
								}
								className="w-32 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 text-slate-200"
							/>
						</div>
						<div className="flex items-center justify-between text-[11px]">
							<span className="text-slate-400">Expression:</span>
							<input
								value={config.expression || "amount * 1.1"}
								onChange={(e) =>
									updateConfig("expression", e.target.value)
								}
								className="w-32 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 text-teal-300 font-mono"
							/>
						</div>
					</div>
				)}

				{nodeType === "JOIN" && (
					<div className="space-y-1.5 bg-slate-900/60 p-2 rounded-lg border border-slate-800">
						<span className="text-[10px] font-bold text-purple-400 uppercase">
							Join Match Keys
						</span>
						<div className="flex items-center justify-between text-[11px]">
							<span className="text-slate-400">Join Type:</span>
							<select
								value={config.joinType || "INNER"}
								onChange={(e) =>
									updateConfig("joinType", e.target.value)
								}
								className="bg-slate-950 border border-slate-800 rounded px-1 text-purple-300"
							>
								<option value="INNER">INNER JOIN</option>
								<option value="LEFT">LEFT JOIN</option>
								<option value="FULL">FULL JOIN</option>
							</select>
						</div>
						<div className="flex items-center space-x-1 text-[11px]">
							<input
								value={config.leftKey || "user_id"}
								onChange={(e) =>
									updateConfig("leftKey", e.target.value)
								}
								className="w-24 bg-slate-950 border border-slate-800 rounded px-1 py-0.5 text-slate-200"
							/>
							<span className="text-slate-500">=</span>
							<input
								value={config.rightKey || "user_id"}
								onChange={(e) =>
									updateConfig("rightKey", e.target.value)
								}
								className="w-24 bg-slate-950 border border-slate-800 rounded px-1 py-0.5 text-slate-200"
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

				{showSqlPreview && (
					<div className="p-2 bg-slate-950 rounded border border-slate-800 font-mono text-[10px] text-slate-400">
						<code>{data.sqlQuery || "SELECT * FROM table;"}</code>
					</div>
				)}
			</div>

			{/* 👉 右側 Source 腳位（貼合右邊框，標籤置於內部） */}
			{nodeType === "FILTER" ? (
				<>
					<div className="absolute right-2 top-[30%] -translate-y-1/2 text-[9px] font-bold text-emerald-400 pointer-events-none">
						T
					</div>
					<Handle
						type="source"
						id="true"
						position={Position.Right}
						style={{ top: "30%" }}
						className="w-3 h-3 bg-emerald-400 border-2 border-slate-950 -right-1.5"
					/>

					<div className="absolute right-2 top-[70%] -translate-y-1/2 text-[9px] font-bold text-rose-400 pointer-events-none">
						F
					</div>
					<Handle
						type="source"
						id="false"
						position={Position.Right}
						style={{ top: "70%" }}
						className="w-3 h-3 bg-rose-400 border-2 border-slate-950 -right-1.5"
					/>
				</>
			) : (
				<Handle
					type="source"
					position={Position.Right}
					style={{ top: "50%" }}
					className="w-3 h-3 bg-cyan-400 border-2 border-slate-950 -right-1.5 -translate-y-1/2"
				/>
			)}
		</div>
	);
};
