import React, { useEffect, useState, useCallback, useRef } from "react";
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
import { Wrench } from "lucide-react";
import { SqlNode } from "./nodes/SqlNode";
import { ParticleEdge } from "./edges/ParticleEdge";
import { AlteryxNode } from "./nodes/AlteryxNode";
import { VizChartNode } from "./nodes/VizChartNode";
import { ikaros } from "../../engine/ikaros/client";
import { generateSqlFromConfig } from "../../engine/astCompiler";

const nodeTypes = {
	sqlNode: SqlNode,
	alteryxNode: AlteryxNode,
	vizChartNode: VizChartNode,
};

const edgeTypes = { particleEdge: ParticleEdge };

interface NymphCanvasProps {
	onInspectNode?: (nodeInfo: {
		id: string;
		label: string;
		sqlQuery: string;
		data: any[];
	}) => void;
}

const CanvasInner: React.FC<NymphCanvasProps> = ({ onInspectNode }) => {
	const reactFlowWrapper = useRef<HTMLDivElement>(null);
	const { screenToFlowPosition } = useReactFlow();
	const [isEngineReady, setIsEngineReady] = useState(false);
	const [queryResult, setQueryResult] = useState<any[] | null>(null);
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
			setNodes((nds) =>
				nds.map((n) =>
					n.id === nodeId
						? { ...n, data: { ...n.data, executionState: "ERROR" } }
						: n,
				),
			);
			setChaosLog(`Chaos Agent repairing node [${nodeId}]...`);
			return false;
		}
	};

	// 卡片表單修改時，動態更新配置並重新編譯 SQL
	const handleNodeConfigChange = useCallback(
		(nodeId: string, newConfig: any) => {
			setNodes((nds) =>
				nds.map((n) => {
					if (n.id === nodeId) {
						const upstreamSources = edges
							.filter((e) => e.target === nodeId)
							.map((e) => e.source);

						const compiledSql = generateSqlFromConfig(
							nodeId,
							(n.data as any).type || "FILTER",
							newConfig,
							upstreamSources,
						);

						return {
							...n,
							data: {
								...n.data,
								config: newConfig,
								sqlQuery: compiledSql,
								onExecute: () =>
									executeNodeQuery(nodeId, compiledSql),
							},
						};
					}
					return n;
				}),
			);
		},
		[edges, setNodes],
	);

	// 當 Edge 變動時，重編譯下游節點 SQL
	const recompileDownstreamNodes = useCallback(
		(currentEdges: Edge[], targetNodes: Node[]) => {
			return targetNodes.map((node) => {
				const upstreamSources = currentEdges
					.filter((e) => e.target === node.id)
					.map((e) => e.source);

				if ((node.data as any).type) {
					const newSql = generateSqlFromConfig(
						node.id,
						(node.data as any).type,
						(node.data as any).config || {},
						upstreamSources,
					);

					return {
						...node,
						data: {
							...node.data,
							sqlQuery: newSql,
							onExecute: () => executeNodeQuery(node.id, newSql),
						},
					};
				}
				return node;
			});
		},
		[],
	);

	const onConnect = useCallback(
		(params: Connection) => {
			setEdges((eds) => {
				const newEdges = addEdge(
					{ ...params, type: "particleEdge" },
					eds,
				);
				setNodes((nds) => recompileDownstreamNodes(newEdges, nds));
				return newEdges;
			});
		},
		[setEdges, setNodes, recompileDownstreamNodes],
	);

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			const rawData = event.dataTransfer.getData("application/json");
			if (!rawData) return;

			try {
				const item = JSON.parse(rawData);
				const position = screenToFlowPosition({
					x: event.clientX,
					y: event.clientY,
				});

				const newNodeId = `node_${Date.now().toString().slice(-4)}`;
				const initialSql = generateSqlFromConfig(
					newNodeId,
					item.type,
					item.config || {},
					[],
				);

				const newNode: Node = {
					id: newNodeId,
					type: item.nodeType || "alteryxNode",
					position,
					data: {
						label: item.label,
						type: item.type,
						config: item.config,
						sqlQuery: initialSql,
						executionState: "IDLE",
						onExecute: () =>
							executeNodeQuery(newNodeId, initialSql),
						onChangeConfig: (newConfig: any) =>
							handleNodeConfigChange(newNodeId, newConfig),
					},
				};

				setNodes((nds) => [...nds, newNode]);
			} catch (err) {
				console.error("Drop Node Error:", err);
			}
		},
		[screenToFlowPosition, setNodes, handleNodeConfigChange],
	);

	const onNodeClick = useCallback(
		async (_: React.MouseEvent, node: Node) => {
			const sql = (node.data as any).sqlQuery;
			if (!sql) return;

			try {
				const result = await ikaros.query(sql);
				if (onInspectNode) {
					onInspectNode({
						id: node.id,
						label: (node.data as any).label || node.id,
						sqlQuery: sql,
						data: result,
					});
				}
			} catch (err) {
				console.warn(`Node ${node.id} inspection error:`, err);
			}
		},
		[onInspectNode],
	);

	return (
		<div
			ref={reactFlowWrapper}
			onDragOver={onDragOver}
			onDrop={onDrop}
			className="w-full h-full relative bg-slate-950"
		>
			{chaosLog && (
				<div className="absolute top-4 left-4 z-10 bg-amber-950/80 border border-amber-500/60 p-3 rounded-lg text-xs text-amber-200 max-w-lg shadow-2xl flex items-center space-x-2 backdrop-blur animate-fade-in">
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
				onNodeClick={onNodeClick}
				onDragOver={onDragOver}
				onDrop={onDrop}
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

			{queryResult && (
				<div className="absolute bottom-6 right-6 z-10 bg-slate-900 border border-cyan-500/40 p-4 rounded-lg max-w-md shadow-2xl backdrop-blur">
					<div className="text-xs font-bold text-cyan-400 mb-2">
						⚡ Ikaros Execution Result:
					</div>
					<pre className="text-[11px] font-mono bg-slate-950 p-2 rounded text-slate-200 overflow-x-auto max-h-48">
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

export const NymphCanvas: React.FC<NymphCanvasProps> = (props) => (
	<ReactFlowProvider>
		<CanvasInner {...props} />
	</ReactFlowProvider>
);
