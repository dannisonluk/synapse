import React from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { Database, Play } from "lucide-react";
import { useTheme } from "../../../theme/ThemeContext";

export const SqlNode: React.FC<
	NodeProps<
		Node<{
			label?: string;
			sqlQuery?: string;
			executionState?: string;
			onExecute?: () => void;
		}>
	>
> = ({ data, selected }) => {
	// 主題由 context 提供語意布林，元件不再自己拿 mode 字串比較 ——
	// 模式名稱改了（claude-light → light）就只會壞在這一行，而那是很容易漏的。
	const { isLight, tokens } = useTheme();

	return (
		<div
			style={{
				backgroundColor: tokens.bgCard,
				borderColor: selected ? tokens.accent : tokens.border,
				boxShadow: selected
					? `0 0 0 2px ${tokens.accent}33`
					: "0 4px 12px rgba(0,0,0,0.05)",
			}}
			className="w-80 relative rounded-lg border p-3 text-xs font-sans transition-all"
		>
			<Handle
				type="target"
				position={Position.Left}
				style={{ backgroundColor: tokens.accent }}
				className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -left-1.5"
			/>

			<div className="flex items-center justify-between pb-2 border-b border-stone-200/50 dark:border-slate-800">
				<div className="flex items-center space-x-2">
					<Database className="w-4 h-4 text-cyan-500" />
					<span className="font-bold">
						{data.label || "SQL Query"}
					</span>
				</div>
				<button
					onClick={data.onExecute}
					className="p-1 hover:bg-stone-500/10 rounded text-cyan-500"
				>
					<Play className="w-3.5 h-3.5 fill-current" />
				</button>
			</div>

			<div
				className={`mt-2.5 p-2 rounded border font-mono text-[10px] ${isLight ? "bg-stone-100 border-stone-200 text-stone-800" : "bg-slate-950 border-slate-800 text-slate-300"}`}
			>
				<code>{data.sqlQuery}</code>
			</div>

			<div className="mt-2 flex justify-between text-[10px] opacity-60 font-mono">
				<span>Status:</span>
				<span className="font-bold text-emerald-500">
					{data.executionState || "IDLE"}
				</span>
			</div>

			<Handle
				type="source"
				position={Position.Right}
				style={{ backgroundColor: tokens.accent }}
				className="w-2.5 h-2.5 border-2 border-white dark:border-slate-900 -right-1.5"
			/>
		</div>
	);
};
