import React from "react";
import { Handle, Position } from "@xyflow/react";
import { Database, Play } from "lucide-react";

export interface SqlNodeData {
	label: string;
	sqlQuery: string;
	executionState?: "IDLE" | "RUNNING" | "SUCCESS" | "ERROR";
	onExecute?: () => void;
}

export const SqlNode: React.FC<{ data: SqlNodeData }> = ({ data }) => {
	return (
		<div className="bg-synapse-card border border-synapse-border hover:border-synapse-accent rounded-lg p-3 min-w-[220px] shadow-lg transition-all">
			<Handle
				type="target"
				position={Position.Top}
				className="!bg-synapse-accent !w-3 !h-3"
			/>

			<div className="flex items-center justify-between border-b border-synapse-border pb-2 mb-2">
				<div className="flex items-center space-x-2">
					<Database className="w-4 h-4 text-synapse-accent" />
					<span className="font-semibold text-sm text-slate-100">
						{data.label}
					</span>
				</div>
				<button
					onClick={data.onExecute}
					className="p-1 hover:bg-slate-700/50 rounded transition-colors text-synapse-accent"
				>
					<Play className="w-3.5 h-3.5" />
				</button>
			</div>

			<div className="bg-slate-900/80 p-2 rounded text-xs font-mono text-slate-300 max-h-20 overflow-y-auto">
				{data.sqlQuery || "-- Enter DuckDB SQL query"}
			</div>

			{data.executionState && (
				<div className="mt-2 text-[10px] flex items-center justify-between text-slate-400">
					<span>Status:</span>
					<span
						className={
							data.executionState === "SUCCESS"
								? "text-green-400 font-bold"
								: "text-amber-400"
						}
					>
						{data.executionState}
					</span>
				</div>
			)}

			<Handle
				type="source"
				position={Position.Bottom}
				className="!bg-synapse-accent !w-3 !h-3"
			/>
		</div>
	);
};
