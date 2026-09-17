import React, { useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { PieChart, RefreshCw } from "lucide-react";
import { ikaros } from "../../../engine/ikaros/client";

export const VizChartNode: React.FC<
	NodeProps<Node<{ label?: string; sqlQuery?: string }>>
> = ({ data, selected }) => {
	const [chartData, setChartData] = useState<any[]>([]);
	const [loading, setLoading] = useState(false);

	const renderChart = async () => {
		if (!data.sqlQuery) return;
		setLoading(true);
		try {
			const res = await ikaros.query(data.sqlQuery);
			setChartData(res);
		} catch (e) {
			console.error("Viz Chart Execution Error:", e);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		renderChart();
	}, [data.sqlQuery]);

	return (
		<div
			className={`w-80 rounded-xl border bg-slate-900/90 backdrop-blur-md p-3 text-slate-100 shadow-xl transition-all ${selected ? "border-purple-400 shadow-purple-500/20 shadow-lg" : "border-purple-500/50"}`}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="w-2.5 h-2.5 bg-purple-400 border-2 border-slate-950"
			/>

			<div className="flex items-center justify-between pb-2 border-b border-slate-800">
				<div className="flex items-center space-x-2">
					<div className="p-1.5 rounded-lg bg-purple-950/80 border border-purple-700/50">
						<PieChart className="w-4 h-4 text-purple-400" />
					</div>
					<div>
						<div className="text-xs font-bold text-slate-100">
							{data.label || "BI Chart Visualizer"}
						</div>
						<div className="text-[10px] text-purple-400 font-mono">
							BI Output
						</div>
					</div>
				</div>
				<button
					onClick={renderChart}
					className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-purple-400"
				>
					<RefreshCw
						className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
					/>
				</button>
			</div>

			{/* 簡易長條圖動態渲染 */}
			<div className="py-2 space-y-1.5">
				{chartData.length > 0 ? (
					<div className="space-y-1 bg-slate-950 p-2 rounded border border-slate-800">
						{chartData.slice(0, 4).map((row, idx) => {
							const keys = Object.keys(row);
							const label = row[keys[0]];
							const val = Number(row[keys[1]] || 0);
							return (
								<div
									key={idx}
									className="text-[10px]"
								>
									<div className="flex justify-between text-slate-400 mb-0.5">
										<span>{String(label)}</span>
										<span className="font-mono text-purple-300">
											{val}
										</span>
									</div>
									<div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
										<div
											className="bg-purple-500 h-full transition-all"
											style={{
												width: `${Math.min(100, val / 20)}%`,
											}}
										/>
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<div className="text-[10px] text-slate-500 text-center py-4">
						Connect upstream node to render BI chart
					</div>
				)}
			</div>
		</div>
	);
};
