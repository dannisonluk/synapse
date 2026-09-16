import React, { useEffect, useState, useCallback } from "react";
import {
	ReactFlow,
	Background,
	Controls,
	useNodesState,
	useEdgesState,
	addEdge,
	Connection,
	Edge,
	Node,
	ReactFlowProvider,
	useReactFlow,
} from "@xyflow/react";
import { Sparkles, Loader2, Play, PlaySquare, Wrench } from "lucide-react";
import { SqlNode } from "./nodes/SqlNode";
import { ParticleEdge } from "./edges/ParticleEdge";
import { ikaros } from "../../engine/ikaros/client";

const nodeTypes = { sqlNode: SqlNode };
const edgeTypes = { particleEdge: ParticleEdge };

function getTopologicalOrder(nodes: Node[], edges: Edge[]): Node[] {
	const inDegree: Record<string, number> = {};
	const adjList: Record<string, string[]> = {};

	nodes.forEach((n) => {
		inDegree[n.id] = 0;
		adjList[n.id] = [];
	});

	edges.forEach((e) => {
		if (adjList[e.source] && inDegree[e.target] !== undefined) {
			adjList[e.source].push(e.target);
			inDegree[e.target] = (inDegree[e.target] || 0) + 1;
		}
	});

	const queue: string[] = nodes
		.filter((n) => inDegree[n.id] === 0)
		.map((n) => n.id);
	const order: string[] = [];

	while (queue.length > 0) {
		const currId = queue.shift()!;
		order.push(currId);
		(adjList[currId] || []).forEach((neighbor) => {
			inDegree[neighbor]--;
			if (inDegree[neighbor] === 0) queue.push(neighbor);
		});
	}

	const orderedNodes = order
		.map((id) => nodes.find((n) => n.id === id)!)
		.filter(Boolean);
	const remaining = nodes.filter((n) => !order.includes(n.id));
	return [...orderedNodes, ...remaining];
}

const CanvasInner: React.FC = () => {
	const { fitView } = useReactFlow();
	const [isEngineReady, setIsEngineReady] = useState(false);
	const [queryResult, setQueryResult] = useState<any[] | null>(null);

	const [inputPrompt, setInputPrompt] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);
	const [isRunningPipeline, setIsRunningPipeline] = useState(false);
	const [chaosLog, setChaosLog] = useState<string | null>(null);

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([
		{
			id: "node-init",
			type: "sqlNode",
			position: { x: 250, y: 100 },
			data: {
				label: "Ikaros Test Query",
				sqlQuery:
					"SELECT 'Synapse Engine Active' AS status, 2026 AS year",
				executionState: "IDLE",
				onExecute: () =>
					executeNodeQuery(
						"node-init",
						"SELECT 'Synapse Engine Active' AS status, 2026 AS year",
					),
			},
		},
	]);

	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

	useEffect(() => {
		ikaros.init().then(() => setIsEngineReady(true));
	}, []);

	const executeNodeQuery = async (
		nodeId: string,
		sql: string,
	): Promise<boolean> => {
		try {
			setNodes((nds) =>
				nds.map((n) =>
					n.id === nodeId
						? {
								...n,
								data: { ...n.data, executionState: "RUNNING" },
							}
						: n,
				),
			);
			const res = await ikaros.query(sql);
			setQueryResult(res);
			setNodes((nds) =>
				nds.map((n) =>
					n.id === nodeId
						? {
								...n,
								data: { ...n.data, executionState: "SUCCESS" },
							}
						: n,
				),
			);
			return true;
		} catch (err: any) {
			const errorMsg = err?.message || String(err);
			setNodes((nds) =>
				nds.map((n) =>
					n.id === nodeId
						? { ...n, data: { ...n.data, executionState: "ERROR" } }
						: n,
				),
			);

			console.warn(`⚡ [Chaos Triggered] Fixing node ${nodeId}...`);
			setChaosLog(`Chaos Agent repairing node [${nodeId}]...`);
			await triggerChaosFix(nodeId, sql, errorMsg);
			return false;
		}
	};

	const triggerChaosFix = async (
		nodeId: string,
		failedSql: string,
		errorMsg: string,
	) => {
		try {
			const res = await fetch("http://localhost:8000/api/v1/chaos/fix", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					node_id: nodeId,
					failed_sql: failedSql,
					error_message: errorMsg,
					full_dag: { nodes, edges },
				}),
			});
			const data = await res.json();
			if (data.status === "SUCCESS" && data.fix?.fixedSqlQuery) {
				const fixedSql = data.fix.fixedSqlQuery;
				setChaosLog(`✅ [Chaos Fixed]: ${data.fix.explanation}`);

				setNodes((nds) =>
					nds.map((n) =>
						n.id === nodeId
							? {
									...n,
									data: {
										...n.data,
										sqlQuery: fixedSql,
										executionState: "IDLE",
										onExecute: () =>
											executeNodeQuery(nodeId, fixedSql),
									},
								}
							: n,
					),
				);

				// 重新執行修復後的節點，成功後自動繼續跑下游節點
				setTimeout(async () => {
					const success = await executeNodeQuery(nodeId, fixedSql);
					if (success) {
						runRemainingPipeline(nodeId);
					}
				}, 500);
			}
		} catch (cErr) {
			console.error("Chaos Repair Failed:", cErr);
		}
	};

	const runRemainingPipeline = async (fromNodeId: string) => {
		const orderedNodes = getTopologicalOrder(nodes, edges);
		const startIndex = orderedNodes.findIndex((n) => n.id === fromNodeId);
		if (startIndex !== -1 && startIndex < orderedNodes.length - 1) {
			const remainingNodes = orderedNodes.slice(startIndex + 1);
			for (const node of remainingNodes) {
				const currentSql = (node.data as any).sqlQuery;
				const success = await executeNodeQuery(node.id, currentSql);
				if (!success) break;
			}
		}
		setIsRunningPipeline(false);
	};

	const runFullPipeline = async () => {
		if (isRunningPipeline || nodes.length === 0) return;
		setIsRunningPipeline(true);
		setChaosLog(null);

		const orderedNodes = getTopologicalOrder(nodes, edges);
		for (const node of orderedNodes) {
			const currentSql = (node.data as any).sqlQuery;
			const success = await executeNodeQuery(node.id, currentSql);
			if (!success) {
				break;
			}
		}
		setIsRunningPipeline(false);
	};

	const handleAgentGenerate = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!inputPrompt.trim() || isGenerating) return;

		setIsGenerating(true);
		try {
			const response = await fetch(
				"http://localhost:8000/api/v1/daedalus/generate",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						prompt: inputPrompt,
						current_dag: { nodes, edges },
					}),
				},
			);

			const resData = await response.json();
			if (resData.status === "SUCCESS" && resData.dag?.nodes) {
				const currentMaxY =
					nodes.length > 0
						? Math.max(...nodes.map((n) => n.position.y))
						: 50;
				const baseOffsetY = currentMaxY + 200;

				const generatedNodes: Node[] = resData.dag.nodes.map(
					(n: any, index: number) => ({
						id: n.id,
						type: "sqlNode",
						position: {
							x: n.position?.x ?? 250,
							y: baseOffsetY + index * 180,
						},
						data: {
							label: n.label || "Daedalus Node",
							sqlQuery: n.data.sqlQuery || "SELECT 1",
							executionState: "IDLE",
							onExecute: () =>
								executeNodeQuery(n.id, n.data.sqlQuery),
						},
					}),
				);

				const generatedEdges: Edge[] = (resData.dag.edges || []).map(
					(e: any) => ({
						id: e.id,
						source: e.source,
						target: e.target,
						type: "particleEdge",
					}),
				);

				setNodes((prev) => [...prev, ...generatedNodes]);
				setEdges((prev) => [...prev, ...generatedEdges]);

				setTimeout(() => {
					fitView({ duration: 800, padding: 0.2 });
				}, 100);
			}
		} catch (err) {
			console.error("Daedalus Agent Connection Failed:", err);
		} finally {
			setIsGenerating(false);
			setInputPrompt("");
		}
	};

	const onConnect = useCallback(
		(params: Connection) =>
			setEdges((eds) =>
				addEdge({ ...params, type: "particleEdge" }, eds),
			),
		[setEdges],
	);

	return (
		<div
			style={{ width: "100vw", height: "100vh" }}
			className="relative bg-synapse-bg"
		>
			<div className="absolute top-4 left-4 z-10 flex items-center space-x-3">
				<div className="bg-synapse-card/80 backdrop-blur border border-synapse-border p-3 rounded-lg text-xs">
					<span className="font-bold text-synapse-accent">
						SYSTEM: SYNAPSE
					</span>{" "}
					| Nymph Engine Status:{" "}
					<span
						className={
							isEngineReady
								? "text-green-400 font-bold"
								: "text-amber-400"
						}
					>
						{isEngineReady
							? "Ikaros Ready (DuckDB-WASM Active)"
							: "Initializing..."}
					</span>
				</div>

				<button
					onClick={runFullPipeline}
					disabled={isRunningPipeline || !isEngineReady}
					className="flex items-center space-x-2 bg-green-500/20 hover:bg-green-500/40 border border-green-500/50 text-green-400 px-4 py-3 rounded-lg text-xs font-bold transition-all disabled:opacity-50 shadow-lg"
				>
					{isRunningPipeline ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
						<PlaySquare className="w-4 h-4" />
					)}
					<span>
						{isRunningPipeline
							? "Running Pipeline..."
							: "▶ Run Pipeline"}
					</span>
				</button>
			</div>

			<div className="absolute top-4 right-4 z-10 w-96">
				<form
					onSubmit={handleAgentGenerate}
					className="flex items-center space-x-2 bg-synapse-card/90 backdrop-blur border border-synapse-border focus-within:border-synapse-accent p-2 rounded-xl shadow-xl transition-all"
				>
					<Sparkles className="w-5 h-5 text-synapse-accent shrink-0 animate-pulse" />
					<input
						type="text"
						value={inputPrompt}
						onChange={(e) => setInputPrompt(e.target.value)}
						placeholder="Tell Daedalus to generate DAG..."
						className="w-full bg-transparent text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
					/>
					<button
						type="submit"
						disabled={isGenerating}
						className="bg-synapse-accent/20 hover:bg-synapse-accent/40 text-synapse-accent p-2 rounded-lg transition-colors disabled:opacity-50 shrink-0"
					>
						{isGenerating ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							<Play className="w-4 h-4" />
						)}
					</button>
				</form>
			</div>

			{chaosLog && (
				<div className="absolute top-20 left-4 z-10 bg-amber-950/80 border border-amber-500/60 p-3 rounded-lg text-xs text-amber-200 max-w-lg shadow-2xl flex items-center space-x-2 backdrop-blur animate-fade-in">
					<Wrench className="w-4 h-4 text-amber-400 shrink-0 animate-spin" />
					<span>{chaosLog}</span>
				</div>
			)}

			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				fitView
			>
				<Background
					color="#1f293d"
					gap={20}
				/>
				<Controls />
			</ReactFlow>

			{/* 🎯 BigInt 安全序列化防護 */}
			{queryResult && (
				<div className="absolute bottom-6 right-6 z-10 bg-synapse-card/90 border border-synapse-accent p-4 rounded-lg max-w-md shadow-2xl">
					<div className="text-xs font-bold text-synapse-accent mb-2">
						⚡ Ikaros Execution Result:
					</div>
					<pre className="text-[11px] font-mono bg-slate-900 p-2 rounded text-slate-200 overflow-x-auto max-h-48">
						{JSON.stringify(
							queryResult,
							(key, value) =>
								typeof value === "bigint"
									? Number(value)
									: value,
							2,
						)}
					</pre>
				</div>
			)}
		</div>
	);
};

export const NymphCanvas: React.FC = () => (
	<ReactFlowProvider>
		<CanvasInner />
	</ReactFlowProvider>
);
