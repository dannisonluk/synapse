import React from "react";
import { Layers, Database, Filter, Sigma, GitMerge } from "lucide-react";

export const Palette: React.FC = () => {
	const onDragStart = (event: React.DragEvent, item: any) => {
		const payload = {
			nodeType: "alteryxNode", // 綁定視覺化 Alteryx 組件
			type: item.type,
			label: item.label,
			category: item.category,
			defaultSql: item.defaultSql,
			config: item.config,
		};

		event.dataTransfer.setData("application/json", JSON.stringify(payload));
		event.dataTransfer.effectAllowed = "move";
	};

	const items = [
		{
			type: "INPUT_DUCKDB",
			label: "Input Data",
			category: "In/Out",
			icon: <Database className="w-4 h-4 text-emerald-400" />,
			defaultSql:
				"CREATE TEMP TABLE raw_data AS SELECT 2026 AS year, 1500 AS amount, 1 AS user_id;",
			config: { tableName: "raw_data" },
		},
		{
			type: "FILTER",
			label: "Filter",
			category: "Preparation",
			icon: <Filter className="w-4 h-4 text-blue-400" />,
			defaultSql:
				"CREATE TEMP TABLE filtered_data AS SELECT * FROM raw_data WHERE amount > 1000;",
			config: { field: "amount", op: ">", val: "1000" },
		},
		{
			type: "SUMMARIZE",
			label: "Summarize",
			category: "Transform",
			icon: <Sigma className="w-4 h-4 text-amber-400" />,
			defaultSql:
				"SELECT year, SUM(amount) AS total_amount FROM filtered_data GROUP BY year;",
			config: { groupBy: "year", func: "SUM", target: "amount" },
		},
		{
			type: "JOIN",
			label: "Join",
			category: "Join",
			icon: <GitMerge className="w-4 h-4 text-purple-400" />,
			defaultSql:
				"SELECT a.*, b.* FROM table_a a JOIN table_b b ON a.id = b.id;",
			config: { joinType: "INNER", key: "id" },
		},
	];

	return (
		<aside className="w-60 border-r border-slate-800 bg-slate-900/60 backdrop-blur p-3 flex flex-col space-y-3 z-10 shrink-0 select-none">
			<div className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
				<Layers className="w-3.5 h-3.5 text-cyan-400" />
				<span>Alteryx Tool Palette</span>
			</div>
			<div className="space-y-2 text-xs">
				{items.map((item) => (
					<div
						key={item.type}
						draggable
						onDragStart={(e) => onDragStart(e, item)}
						className="p-2.5 bg-slate-800/60 hover:bg-slate-800 hover:border-cyan-500/50 border border-slate-700/60 rounded-lg cursor-grab active:cursor-grabbing flex items-center justify-between text-slate-200 transition-all shadow-sm"
					>
						<div className="flex items-center space-x-2">
							{item.icon}
							<span className="font-medium">{item.label}</span>
						</div>
						<span className="text-[10px] bg-slate-700/80 px-1.5 py-0.5 rounded text-slate-400">
							{item.category}
						</span>
					</div>
				))}
			</div>
		</aside>
	);
};
