import React, {
	useEffect,
	useState,
	useCallback,
	useMemo,
	useRef,
} from "react";
import {
	ReactFlow,
	Background,
	Controls,
	useNodesState,
	useEdgesState,
	addEdge,
	applyNodeChanges,
	applyEdgeChanges,
	Connection,
	Edge,
	EdgeChange,
	Node,
	NodeChange,
	ReactFlowProvider,
	useReactFlow,
} from "@xyflow/react";
import {
	Wrench,
	Wand2,
	Play,
	Download,
	Upload,
	FileCode,
	Loader2,
	FilePlus,
	Undo2,
	Redo2,
	Command,
	Share2,
} from "lucide-react";
import { SqlNode } from "./nodes/SqlNode";
import { ParticleEdge } from "./edges/ParticleEdge";
import { AlteryxNode } from "./nodes/AlteryxNode";
import { VizChartNode } from "./nodes/VizChartNode";
import { withNodeBoundary } from "../ErrorBoundary";
import { CommandPalette } from "../workbench/CommandPalette";
// 命令面板的候選直接來自目錄 —— 它本來就是「有哪些節點」的唯一真相。
import { NODE_CATALOG, defaultConfigFor } from "../../engine/nodeCatalog";
import { ikaros } from "../../engine/ikaros/client";
import {
	generateSqlFromConfig,
	resolveSourceTables,
	outputTableFor,
} from "../../engine/astCompiler";
import {
	exportToSqlCte,
	exportWorkflowJson,
	importWorkflowJson,
	type SerializedEdge,
	type SerializedNode,
} from "../../engine/exporter";
import { exportToPolars } from "../../engine/exportPolars";
import { exportToDbt, projectToText } from "../../engine/exportDbt";
import { downloadText } from "../../lib/download";
import {
	NodeKeyBook,
	cacheKey,
	decideReuse,
	dataVersion,
} from "../../engine/cache";
import { History } from "../../engine/history";
import { rankActions, rankNodeTypes } from "../../engine/palette";
import {
	encodeShareLink,
	decodeShareLink,
	readShareToken,
	buildShareUrl,
} from "../../engine/shareLink";
import { getLayoutedElements } from "../../engine/autoLayout";
import { resolveAstPatch, toFlowEdges } from "../../engine/patch";
import {
	getAncestorClosure,
	sortSubgraphTopologically,
	findDescendants,
	makeExecLog,
	ExecLogEntry,
} from "../../engine/scheduler";
import { useTheme } from "../../theme/ThemeContext";
import {
	loadAutosave,
	saveAutosave,
	clearAutosave,
} from "../../engine/persistence";

// ---------------------------------------------------------------------------
// 節流常數
// ---------------------------------------------------------------------------

/**
 * 畫布狀態回報父層的延遲。
 * 拖曳節點時 React Flow 每一格都更新 nodes → 若每次都回報，父層
 * （整個 workbench：Palette + Chat + Drawer）會跟著重繪，拖曳明顯卡頓。
 * 250ms 遠低於人的點擊反應時間，Hermes 拿到的 DAG 不會有感落後。
 */
const CANVAS_REPORT_DEBOUNCE_MS = 250;

/**
 * 自動存檔的延遲。比回報再長一些 —— localStorage 是同步 I/O，
 * 拖曳期間完全不需要寫入。
 */
const AUTOSAVE_DEBOUNCE_MS = 800;

// 每個節點都包一層錯誤邊界：單一節點 render 拋錯只會退化成一張錯誤卡片，
// 不會拖垮整張畫布（React Flow 的 nodeTypes 不會替節點內部攔截例外）。
const nodeTypes = {
	sqlNode: withNodeBoundary(SqlNode, "SQL"),
	alteryxNode: withNodeBoundary(AlteryxNode, "Transform"),
	vizChartNode: withNodeBoundary(VizChartNode, "Chart"),
};

const edgeTypes = { particleEdge: ParticleEdge };

export interface InspectedNodePayload {
	id: string;
	label: string;
	nodeType: string;
	sqlQuery: string;
	/**
	 * 節點輸出結果所在的 DuckDB 表名。
	 * Data Drawer 靠這個做 SQL 側分頁 —— 不會把整張表搬到 main thread。
	 * 空字串 = 沒有對應表（例如 Pipeline Log 檢視）。
	 */
	tableName: string;
	ok: boolean;
	logs: ExecLogEntry[];
}

interface NymphCanvasProps {
	onInspectNode?: (payload: InspectedNodePayload) => void;
	onPipelineLog?: (logs: ExecLogEntry[]) => void;
	/** 畫布狀態回報（Hermes chat 需要真實 DAG context） */
	onCanvasStateChange?: (nodes: Node[], edges: Edge[]) => void;
}

/** 產生無撞號風險的節點 id（舊版 Date.now().slice(-4) 每 10 秒輪迴！） */
export function generateNodeId(): string {
	const bytes = new Uint8Array(6);
	try {
		crypto.getRandomValues(bytes);
	} catch {
		return `node_${Date.now().toString(16)}${Math.floor(
			Math.random() * 0xffff,
		).toString(16)}`;
	}
	return `node_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	)}`;
}

/**
 * Chaos Agent 整合：錯誤發生時 call 後端修復 API（4 秒 timeout）。
 * 後端離線 → 回傳 null，由呼叫人以本地 fallback 處理。
 */
async function chaosRepair(
	nodeId: string,
	failedSql: string,
	errorMessage: string,
	ctx: { nodes: Node[]; edges: Edge[] },
): Promise<{ fixedSqlQuery: string; explanation: string } | null> {
	try {
		const res = await fetch("http://localhost:8000/api/v1/chaos/fix", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				node_id: nodeId,
				failed_sql: failedSql,
				error_message: errorMessage,
				full_dag: {
					nodes: ctx.nodes.map((n) => ({ id: n.id, data: n.data })),
					edges: ctx.edges.map((e) => ({
						source: e.source,
						target: e.target,
					})),
				},
			}),
			signal: AbortSignal.timeout(4000),
		});
		const data = await res.json();
		if (data?.status === "SUCCESS" && data.fix?.fixedSqlQuery) {
			return data.fix;
		}
	} catch {
		// 後端未啟動 → 靜默 fallback
	}
	return null;
}

/**
 * 這個節點的 false 輸出埠有沒有下游？
 * 沒有就不必建立 false 分支表（省一次全表寫入）。
 */
function hasFalseConsumer(nodeId: string, edges: Edge[]): boolean {
	return edges.some((e) => e.source === nodeId && e.sourceHandle === "false");
}

interface CanvasNotice {
	kind: "ok" | "error";
	text: string;
}

const CanvasInner: React.FC<NymphCanvasProps> = ({
	onInspectNode,
	onPipelineLog,
	onCanvasStateChange,
}) => {
	const reactFlowWrapper = useRef<HTMLDivElement>(null);
	const { screenToFlowPosition, fitView } = useReactFlow();
	const { isLight, tokens } = useTheme();
	// 少數真的需要反過來判斷的地方（畫布底色、粒子邊）用這個
	const isDark = !isLight;

	const [isEngineReady, setIsEngineReady] = useState(false);
	const [engineError, setEngineError] = useState<string | null>(null);
	const [engineMode, setEngineMode] = useState(ikaros.mode);
	const [engineWarning, setEngineWarning] = useState<string | null>(null);
	const [chaosLog, setChaosLog] = useState<string | null>(null);
	const [notice, setNotice] = useState<CanvasNotice | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// ---------------------------------------------------------------------
	// 執行快取與 Undo/Redo 的狀態
	// ---------------------------------------------------------------------
	// 兩者都放 ref 而不是 state：它們是「執行 / 編輯的歷史」，不是畫面的一部分。
	// 放 state 會讓每一次 undo 或每一次快取命中都觸發重繪，而畫面完全沒變。
	//
	// keyBook 只記「上次跑成功的鍵」—— 結果本身就在 DuckDB 的表裡，不必再存一份。
	const keyBookRef = useRef(new NodeKeyBook());
	// 50 步、400ms 合併窗。合併窗的意義：表單每打一個字都會觸發 onChangeConfig，
	// 不合併的話打十個字就有十步 undo。
	const historyRef = useRef(new History<{ nodes: Node[]; edges: Edge[] }>({
		limit: 50,
		coalesceMs: 400,
	}));
	// 套用 undo/redo 時要抑制「因為 nodes 變了而再落一筆歷史」的遞迴
	const applyingHistoryRef = useRef(false);
	const [histVersion, setHistVersion] = useState(0);

	// nodes / edges 的最新值。
	//
	// 為什麼需要：落一筆歷史必須知道「變更後」的完整圖，而 setState 的
	// functional updater 裡不能呼叫 setState（updater 必須是純函式）。
	// 用 ref 讀當前值，就能在外面先把新陣列算出來，再同時交給 setNodes 與歷史。
	const nodesRef = useRef<Node[]>([]);
	const edgesRef = useRef<Edge[]>([]);

	// ---------------------------------------------------------------------
	// 執行互斥鎖（execution mutex）
	// ---------------------------------------------------------------------
	// 連續點擊兩個節點原本會產生兩個並行的 runGraph，對同一批 DuckDB 臨時表
	// 交錯執行 DDL → 結果不可預測。這裡把每次執行串成一條 promise chain：
	// 後到的請求排隊等待，不會交錯。
	const execChainRef = useRef<Promise<unknown>>(Promise.resolve());
	const activeRunsRef = useRef(0);
	const [isExecuting, setIsExecuting] = useState(false);

	const enqueue = useCallback((task: () => Promise<any>): Promise<any> => {
		activeRunsRef.current += 1;
		setIsExecuting(true);

		const settle = () => {
			activeRunsRef.current -= 1;
			if (activeRunsRef.current === 0) setIsExecuting(false);
		};

		// then(task, task)：前一個任務失敗也要繼續跑下一個，
		// 否則一次錯誤會讓整條鏈永遠卡住。
		const run = execChainRef.current.then(task, task);
		const tracked = run.then(
			(value) => {
				settle();
				return value;
			},
			(error) => {
				settle();
				throw error;
			},
		);
		execChainRef.current = tracked.catch(() => undefined);
		return tracked;
	}, []);

	// 提示訊息自動消失（不需要使用者手動關閉）
	useEffect(() => {
		if (!notice) return;
		const t = setTimeout(() => setNotice(null), 5000);
		return () => clearTimeout(t);
	}, [notice]);

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([
		{
			id: "node-init",
			type: "sqlNode",
			position: { x: 250, y: 100 },
			data: {
				label: "Ikaros Test Query",
				// 建立真表而非只是 SELECT：這樣 Data Drawer 才有內容可以分頁檢視
				sqlQuery:
					'CREATE OR REPLACE TEMP TABLE "node-init" AS SELECT \'Synapse Engine Active\' AS status, 2026 AS year;',
				executionState: "IDLE",
				onExecute: () =>
					executeNodeQuery(
						"node-init",
						'CREATE OR REPLACE TEMP TABLE "node-init" AS SELECT \'Synapse Engine Active\' AS status, 2026 AS year;',
					),
			},
		},
	]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

	// nodesRef / edgesRef 是「最新值」的鏡子，給需要在 setState 之外讀圖的地方用
	// （落歷史、config 變更時重算上游）。沒有這個 effect，它們永遠是空的。
	useEffect(() => {
		nodesRef.current = nodes;
		edgesRef.current = edges;
	}, [nodes, edges]);

	// 首次掛載建立歷史的起點。用 reset 而不是 push：開啟一個工作流不是一次編輯，
	// 使用者不該能 undo 到「什麼都沒有的空白畫布」。
	const historySeededRef = useRef(false);
	useEffect(() => {
		if (historySeededRef.current) return;
		historySeededRef.current = true;
		historyRef.current.reset({ nodes, edges });
		setHistVersion((v) => v + 1);
		// 只在掛載時跑一次 —— 之後由明確的編輯動作落筆
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 畫布狀態變更 → 節流後回報父層（Hermes 需要真實 current_dag）
	useEffect(() => {
		if (!onCanvasStateChange) return;
		const t = setTimeout(
			() => onCanvasStateChange(nodes, edges),
			CANVAS_REPORT_DEBOUNCE_MS,
		);
		return () => clearTimeout(t);
	}, [nodes, edges, onCanvasStateChange]);

	useEffect(() => {
		ikaros.ready
			.then(() => {
				setIsEngineReady(true);
				setEngineMode(ikaros.mode);
				if (ikaros.mode === "main-thread" && ikaros.workerError) {
					setEngineWarning(ikaros.workerError);
				}
			})
			.catch((err: any) => {
				setEngineError(String(err?.message || err));
			});
	}, []);

	/**
	 * 執行單一節點 SQL，並同步節點狀態（RUNNING→SUCCESS/ERROR）。
	 *
	 * 這是「未加鎖」的底層 primitive：runGraphInner 在鎖內直接呼叫它；
	 * 所有外部入口一律走下面的 executeNodeQuery（已排隊）。
	 */
	const executeNodeQueryRaw = useCallback(
		async (
			nodeId: string,
			sql: string,
		): Promise<{ ok: boolean; rows: any[]; ms: number; error?: string }> => {
			const t0 = performance.now();
			setNodes((nds) =>
				nds.map((n) =>
					n.id === nodeId
						? {
								...n,
								data: {
									...n.data,
									executionState: "RUNNING",
								},
							}
						: n,
				),
			);
			try {
				const rows = await ikaros.query(sql);
				setNodes((nds) =>
					nds.map((n) =>
						n.id === nodeId
							? {
									...n,
									data: {
										...n.data,
										executionState: "SUCCESS",
									},
								}
							: n,
					),
				);
				return { ok: true, rows, ms: Math.round(performance.now() - t0) };
			} catch (err: any) {
				setNodes((nds) =>
					nds.map((n) =>
						n.id === nodeId
							? {
									...n,
									data: {
										...n.data,
										executionState: "ERROR",
									},
								}
							: n,
					),
				);
				return {
					ok: false,
					rows: [],
					ms: Math.round(performance.now() - t0),
					error: err?.message || String(err),
				};
			}
		},
		[setNodes],
	);

	/** 外部入口：與 runGraph 共用同一條互斥鏈，避免與 pipeline 執行交錯。 */
	const executeNodeQuery = useCallback(
		(nodeId: string, sql: string) =>
			enqueue(() => executeNodeQueryRaw(nodeId, sql)),
		[enqueue, executeNodeQueryRaw],
	);

	/**
	 * 拓撲執行器 —— Run Pipeline 同「click 節點」共用同一條路徑。
	 *
	 * scope 為 null = 圖含 cycle（拒絕執行）。
	 * 任何節點失敗 → 之後所有下游節點一律跳過（findDescendants），
	 * 不可繼續執行，否則下游會靜靜地讀到上一次執行的舊表 → 結果錯誤。
	 */
	const runGraph = useCallback(
		async (
			scope: Node[] | null,
			targetId: string | null,
			ns: Node[],
			es: Edge[],
		): Promise<{ ok: boolean; rows: any[]; logs: ExecLogEntry[] }> => {
			const ordered = scope ? sortSubgraphTopologically(scope, es) : null;
			if (!ordered) {
				const logs = [
					makeExecLog(
						"ERROR",
						"Pipeline 含循環依賴（cycle）—— 已中止拓撲執行。",
					),
				];
				if (onPipelineLog) onPipelineLog(logs);
				return { ok: false, rows: [], logs };
			}

			const logs: ExecLogEntry[] = [
				makeExecLog(
					"INFO",
					`${targetId ? "子圖" : "全圖"}執行：${ordered.length} 個節點（拓撲序）`,
				),
			];

			const failed = new Set<string>();
			let blocked: Set<string> | null = null;
			let rows: any[] = [];
			// 不使用單一 boolean flag：修復成功不應抹掉之前已經記錄的失敗。
			// ok 最後由「有沒有未修復的失敗」+「有沒有節點被跳過」一起決定。
			let skipped = 0;

			// 執行快取：先把現存的表撈一次，之後在記憶體裡判斷 ——
			// 每個節點各問一次引擎太貴，而這份清單在一次執行內不會變。
			// 撈不到就當作空的（全部重跑）：寧可慢，也不要錯。
			const existingTables = new Set<string>();
			try {
				for (const t of await ikaros.tables()) existingTables.add(t);
			} catch {
				/* 引擎還沒準備好 → 當作沒有表 */
			}
			// 版本號在一次執行內固定：中途有檔案被上傳的話，下一次執行自然會
			// 全部失效，不需要在迴圈裡重新讀（讀了反而讓同一次執行前後不一致）。
			const version = dataVersion.current;
			let reused = 0;

			for (const node of ordered) {
				const label = (node.data as any).label || node.id;

				if (blocked?.has(node.id)) {
					skipped += 1;
					logs.push(
						makeExecLog(
							"ERROR",
							`${label}：跳過執行（上游失敗，避免讀到過期資料）`,
							{ nodeId: node.id },
						),
					);
					continue;
				}

				const sql = (node.data as any).sqlQuery;
				if (!sql) continue;

				// 快取判斷。鍵 = 編譯出來的 SQL + 資料版本。
				// SQL 本身就是（節點類型 + config + 上游）的指紋，不必另外雜湊 config。
				const key = cacheKey(sql, version);
				const decision = decideReuse(
					key,
					keyBookRef.current.previous(node.id),
					existingTables.has(node.id),
				);
				if (decision.skip) {
					reused += 1;
					logs.push(
						makeExecLog("SKIP", `${label}：${decision.reason}`, {
							nodeId: node.id,
						}),
					);
					continue;
				}

				logs.push(makeExecLog("SQL", sql, { nodeId: node.id }));
				const res = await executeNodeQueryRaw(node.id, sql);

				if (res.ok) {
					keyBookRef.current.record(node.id, key);
					existingTables.add(node.id);
					logs.push(
						makeExecLog(
							"SUCCESS",
							`${label}: ${res.rows.length} row(s)`,
							{
								nodeId: node.id,
								durationMs: res.ms,
								rows: res.rows.length,
							},
						),
					);
				} else {
					// 失敗**不記鍵**：快取只快取成功。否則一次失敗會被永久沿用。
					keyBookRef.current.forget(node.id);
					logs.push(
						makeExecLog("ERROR", `${label}: ${res.error}`, {
							nodeId: node.id,
							durationMs: res.ms,
						}),
					);
					setChaosLog(`Chaos Agent 修復節點 [${node.id}] 中…`);

					// 真正連線 Chaos 修復 API（後端離線 → null → 保留原錯）
					const fix = await chaosRepair(
						node.id,
						sql,
						res.error || "",
						{ nodes: ns, edges: es },
					);

					if (fix) {
						setNodes((nds) =>
							nds.map((n) =>
								n.id === node.id
									? {
											...n,
											data: {
												...n.data,
												sqlQuery: fix.fixedSqlQuery,
												onExecute: () =>
													executeNodeQuery(
														node.id,
														fix.fixedSqlQuery,
													),
											},
										}
									: n,
							),
						);
						logs.push(
							makeExecLog(
								"CHAOS",
								`${label}: ${fix.explanation}`,
								{ nodeId: node.id },
							),
						);

						const retry = await executeNodeQueryRaw(
							node.id,
							fix.fixedSqlQuery,
						);
						if (retry.ok) {
							// 修復成功 → 這個節點不算失敗，下游可以繼續
							logs.push(
								makeExecLog(
									"SUCCESS",
									`${label}（修復後）: ${retry.rows.length} row(s)`,
									{
										nodeId: node.id,
										durationMs: retry.ms,
										rows: retry.rows.length,
									},
								),
							);
							if (node.id === targetId) rows = retry.rows;
						} else {
							failed.add(node.id);
							blocked = findDescendants(failed, ordered, es);
							logs.push(
								makeExecLog(
									"ERROR",
									`${label} 修復後仍然失敗：${retry.error}`,
									{ nodeId: node.id },
								),
							);
						}
					} else {
						failed.add(node.id);
						blocked = findDescendants(failed, ordered, es);
						logs.push(
							makeExecLog(
								"CHAOS",
								"Chaos Agent 離線（後端無回應）—— 未套用自動修復。",
								{ nodeId: node.id },
							),
						);
					}
				}

				if (node.id === targetId && res.ok) rows = res.rows;
			}

			setChaosLog(null);

			// 快取摘要：使用者要能一眼知道「這次有多少東西真的跑了」。
			// 沒有這一行，一個全部命中的執行看起來會像是什麼都沒發生。
			if (reused > 0) {
				logs.push(
					makeExecLog(
						"INFO",
						`執行快取：${reused} / ${ordered.length} 個節點沿用上次結果（設定與資料都未變更）`,
					),
				);
			}
			// 刪掉的節點不必再記鍵，否則 Map 會隨編輯歷史無限長大
			keyBookRef.current.retain(ns.map((n) => n.id));

			// 只有「全圖執行」需要推去 Pipeline Log 面板；
			// click 節點的 log 已經包含在回傳值中，由 onInspectNode 顯示。
			if (!targetId && onPipelineLog) onPipelineLog(logs);
			return { ok: failed.size === 0 && skipped === 0, rows, logs };
		},
		[executeNodeQueryRaw, onPipelineLog, setNodes],
	);

	/** 執行全 DAG（Run Pipeline） */
	const handleRunPipeline = useCallback(async () => {
		await runGraph(nodes, null, nodes, edges);
	}, [nodes, edges, runGraph]);

	const handleAutoLayout = useCallback(
		(direction: "LR" | "TB" = "LR") => {
			const { nodes: layoutedNodes, edges: layoutedEdges } =
				getLayoutedElements(nodes, edges, direction);
			setNodes(layoutedNodes);
			setEdges(layoutedEdges);

			setTimeout(() => {
				fitView({ duration: 600, padding: 0.2 });
			}, 50);
		},
		[nodes, edges, setNodes, setEdges, fitView],
	);

	/**
	 * 落一筆歷史。
	 *
	 * 刻意**不**用 useEffect 監看 nodes/edges 來記錄 —— 那會把執行時更新
	 * executionState、自動排版、套用 Hermes patch 這些程式性變更也記成
	 * 「使用者編輯」，於是 undo 會走過一堆使用者從沒做過的動作。
	 * 由發起變更的地方明確呼叫，才是「哪些動作可 undo」的唯一真相。
	 *
	 * 必須宣告在 handleNodeConfigChange **之前**：它的 useCallback 依賴
	 * 這個名字，而 deps 陣列在 render 期間就會求值 —— 宣告在後面的話會踩
	 * `const` 的 TDZ，直接 ReferenceError。
	 */
	const recordHistory = useCallback(
		(next: { nodes: Node[]; edges: Edge[] }, key?: string) => {
			if (applyingHistoryRef.current) return;
			historyRef.current.push(next, key);
			setHistVersion((v) => v + 1);
		},
		[],
	);

	/** 把一份快照套回畫布。undo / redo 共用 */
	const applySnapshot = useCallback(
		(snap: { nodes: Node[]; edges: Edge[] } | null) => {
			if (!snap) return;
			applyingHistoryRef.current = true;
			setNodes(snap.nodes);
			setEdges(snap.edges);
			setHistVersion((v) => v + 1);
			// 下一個 microtask 才解除：React Flow 會因為 nodes 換了而補送
			// dimension 之類的變更事件，那些不該被記成新的編輯。
			queueMicrotask(() => {
				applyingHistoryRef.current = false;
			});
		},
		[setNodes, setEdges],
	);

	const handleUndo = useCallback(() => {
		applySnapshot(historyRef.current.undo());
	}, [applySnapshot]);

	const handleRedo = useCallback(() => {
		applySnapshot(historyRef.current.redo());
	}, [applySnapshot]);

	// ---------------------------------------------------------------------
	// 結構性變更（拖曳 / 刪除）與全域鍵盤
	// ---------------------------------------------------------------------
	/**
	 * 包一層 React Flow 的 onNodesChange，只為「結構性」變更落歷史。
	 *
	 * 選取（select）與拖曳中的座標更新刻意**不**記 —— 點一下節點不該是一次
	 * undo，否則堆疊會被點擊塞滿，真正想回復的編輯反而被擠掉。
	 * 拖曳只在 `dragging === false`（放開滑鼠）時記一筆。
	 */
	const handleNodesChange = useCallback(
		(changes: NodeChange<Node>[]) => {
			onNodesChange(changes);
			if (applyingHistoryRef.current) return;

			const structural = changes.some(
				(c) =>
					c.type === "remove" ||
					(c.type === "position" && c.dragging === false),
			);
			if (!structural) return;

			recordHistory(
				{
					nodes: applyNodeChanges(changes, nodesRef.current),
					edges: edgesRef.current,
				},
				`nodes:${changes[0]?.type}`,
			);
		},
		[onNodesChange, recordHistory],
	);

	const handleEdgesChange = useCallback(
		(changes: EdgeChange<Edge>[]) => {
			onEdgesChange(changes);
			if (applyingHistoryRef.current) return;

			// 邊只有「刪除」值得記；選取同樣不記。
			if (!changes.some((c) => c.type === "remove")) return;

			recordHistory(
				{
					nodes: nodesRef.current,
					edges: applyEdgeChanges(changes, edgesRef.current),
				},
				"edges:remove",
			);
		},
		[onEdgesChange, recordHistory],
	);

	/** 命令面板開關 */
	const [paletteOpen, setPaletteOpen] = useState(false);

	/**
	 * 全域鍵盤：⌘K / Ctrl+K 開面板，⌘Z / ⇧⌘Z / ⌘Y 復原與重做。
	 *
	 * 綁在 window 而不是畫布容器上：焦點通常在節點表單的輸入框裡，
	 * 綁容器的話按鍵根本不會傳到畫布。
	 */
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod) return;
			const k = e.key.toLowerCase();

			if (k === "k") {
				e.preventDefault();
				setPaletteOpen((v) => !v);
				return;
			}

			// 在輸入框裡讓瀏覽器處理 undo —— 使用者期待的是「復原我剛打的字」，
			// 不是「復原整張圖」。
			const el = e.target as HTMLElement | null;
			const typing =
				!!el &&
				(el.tagName === "INPUT" ||
					el.tagName === "TEXTAREA" ||
					el.isContentEditable);
			if (typing) return;

			if (k === "z") {
				e.preventDefault();
				if (e.shiftKey) handleRedo();
				else handleUndo();
			} else if (k === "y") {
				e.preventDefault();
				handleRedo();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [handleUndo, handleRedo]);

	const handleNodeConfigChange = useCallback(
		(nodeId: string, newConfig: any) => {
			// 先在 updater 外面算出「變更後」的圖：落歷史需要完整快照，
			// 而 setState 的 updater 必須是純函式，不能在裡面呼叫 setState。
			const nextNodes = nodesRef.current.map((n) => {
				if (n.id !== nodeId) return n;

				const upstreamSources = resolveSourceTables(
					nodeId,
					(n.data as any).type || "FILTER",
					edgesRef.current,
				);

				const compiledSql = generateSqlFromConfig(
					nodeId,
					(n.data as any).type || "FILTER",
					newConfig,
					upstreamSources,
					{ falseBranch: hasFalseConsumer(nodeId, edgesRef.current) },
				);

				return {
					...n,
					data: {
						...n.data,
						config: newConfig,
						sqlQuery: compiledSql,
						// 一併寫回上游表清單：config 表單靠它查 schema
						// 做欄位選單（schema 驅動欄位選單）。
						upstreamTables: upstreamSources,
						onExecute: () => executeNodeQuery(nodeId, compiledSql),
					},
				};
			});

			setNodes(nextNodes);
			// 合併鍵綁節點：同一段連續輸入（在合併窗內）是一步 undo，
			// 換到別的節點編輯就是新的一步。
			recordHistory({ nodes: nextNodes, edges: edgesRef.current }, `config:${nodeId}`);
		},
		[setNodes, executeNodeQuery, recordHistory],
	);

	/**
	 * 重算所有節點的 SQL 與「上游表清單」。
	 *
	 * 兩個用途：
	 *   1. 邊線變動（連線 / 刪邊）後重編譯下游 —— 舊版刪邊不重編譯，
	 *      下游會一直讀著舊的上游表。
	 *   2. 把 upstreamTables 注入節點 data，讓 config 表單能查上游 schema
	 *      （schema 驅動欄位選單）。
	 *
	 * 沒有實際變化時回傳同一個 node 物件 —— 這是必要的：呼叫端是
	 * useEffect(edges)，每次都產生新物件會造成無謂的重繪。
	 */
	const recompileDownstreamNodes = useCallback(
		(currentEdges: Edge[], targetNodes: Node[]) => {
			return targetNodes.map((node) => {
				const nodeType = (node.data as any).type;
				if (!nodeType) return node;

				const upstreamTables = resolveSourceTables(
					node.id,
					nodeType,
					currentEdges,
				);

				const newSql = generateSqlFromConfig(
					node.id,
					nodeType,
					(node.data as any).config || {},
					upstreamTables,
					{ falseBranch: hasFalseConsumer(node.id, currentEdges) },
				);

				const prevSql = (node.data as any).sqlQuery;
				const prevTables = (node.data as any).upstreamTables as
					| string[]
					| undefined;
				const tablesUnchanged =
					Array.isArray(prevTables) &&
					prevTables.length === upstreamTables.length &&
					prevTables.every((t, i) => t === upstreamTables[i]);

				if (prevSql === newSql && tablesUnchanged) return node;

				return {
					...node,
					data: {
						...node.data,
						upstreamTables,
						sqlQuery: newSql,
						onExecute: () =>
							enqueue(() => executeNodeQuery(node.id, newSql)),
					},
				};
			});
		},
		[enqueue, executeNodeQuery],
	);

	/**
	 * 邊線變動 → 重算所有節點的上游表與 SQL。
	 *
	 * 這裡取代了舊版在 onConnect 內「setNodes inside setEdges updater」的寫法
	 * （那在 StrictMode 下會重複執行 updater），也補上了刪邊不重編譯的漏洞。
	 */
	useEffect(() => {
		setNodes((nds) => recompileDownstreamNodes(edges, nds));
	}, [edges, setNodes, recompileDownstreamNodes]);

	/**
	 * 將存檔的序列化節點還原成畫布節點（重新注入 callback）。
	 * 邊線要先算好，因為節點 SQL 需要靠 edges 解析上游表名。
	 */
	const hydrateWorkflow = useCallback(
		(
			serializedNodes: SerializedNode[],
			serializedEdges: SerializedEdge[],
		): { nodes: Node[]; edges: Edge[] } => {
			const flowEdges: Edge[] = serializedEdges.map((e) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				sourceHandle: e.sourceHandle ?? undefined,
				targetHandle: e.targetHandle ?? undefined,
				type: "particleEdge",
				animated: true,
			}));

			const flowNodes: Node[] = serializedNodes.map((sn) => {
				const nodeType = sn.data.type;
				// 有存檔 SQL 就沿用（保留 Chaos Agent 修復過的版本）；
				// 沒有才由 config 重新編譯。
				const sql =
					sn.data.sqlQuery ??
					generateSqlFromConfig(
						sn.id,
						nodeType || "FILTER",
						(sn.data.config || {}) as any,
						resolveSourceTables(
							sn.id,
							nodeType || "FILTER",
							flowEdges,
						),
					);

				return {
					id: sn.id,
					type: sn.type,
					position: sn.position,
					data: {
						label: sn.data.label,
						...(nodeType ? { type: nodeType } : {}),
						config: sn.data.config,
						sqlQuery: sql,
						executionState: "IDLE",
						onExecute: () => executeNodeQuery(sn.id, sql),
						onChangeConfig: (cfg: any) =>
							handleNodeConfigChange(sn.id, cfg),
					},
				};
			});

			return { nodes: flowNodes, edges: flowEdges };
		},
		[executeNodeQuery, handleNodeConfigChange],
	);

	/** 匯出成單一 DuckDB CTE 查詢 */
	const handleExportSql = useCallback(() => {
		const res = exportToSqlCte(nodes, edges);
		if (!res) {
			setNotice({
				kind: "error",
				text: "圖含循環依賴（cycle），無法線性化成 SQL —— 請先解除迴圈。",
			});
			return;
		}
		downloadText("synapse-workflow.sql", res.sql, "text/plain");
		const extra =
			res.externalSources.length > 0
				? `　需自備來源表：${res.externalSources.join("、")}`
				: "";
		setNotice({ kind: "ok", text: `已匯出 SQL（${res.sql.length} 字元）。${extra}` });
	}, [nodes, edges]);

	/**
	 * 匯出成可執行的 Python (Polars) 腳本。
	 *
	 * Polars 沒有 SQL 的完整表達力，無法自動翻譯的部分會留在腳本裡的
	 * TODO 並回報節點 id —— 這裡一定要把 needsReview 講出來，否則使用者
	 * 會以為匯出的腳本算出來的結果跟畫布一致。
	 */
	const handleExportPython = useCallback(() => {
		const res = exportToPolars(nodes, edges);
		if (!res) {
			setNotice({
				kind: "error",
				text: "圖含循環依賴（cycle），無法線性化成 Python —— 請先解除迴圈。",
			});
			return;
		}
		downloadText("synapse-workflow.py", res.script, "text/x-python");
		const parts = [`已匯出 Python / Polars（${res.script.length} 字元）。`];
		if (res.needsReview.length > 0) {
			parts.push(
				`⚠ ${res.needsReview.length} 個節點無法自動翻譯（${res.needsReview.join("、")}）—— 腳本內有 TODO，請手動確認。`,
			);
		}
		setNotice({
			kind: res.needsReview.length > 0 ? "error" : "ok",
			text: parts.join("　"),
		});
	}, [nodes, edges]);

	/**
	 * 匯出 dbt 專案。
	 *
	 * dbt 專案是**多個檔案**，而瀏覽器不能一次下載多個。這裡下載的是一份
	 * 合併文字檔，用 `===== 路徑 =====` 分隔 —— 使用者按那個分隔切開即可。
	 * 誠實地講清楚這件事，比假裝它是一個可以直接用的 zip 好。
	 */
	const handleExportDbt = useCallback(() => {
		const proj = exportToDbt(nodes, edges, { projectName: "synapse_workflow" });
		const paths = Object.keys(proj.files);
		if (paths.length === 0) {
			setNotice({ kind: "error", text: "畫布上沒有可匯出的節點。" });
			return;
		}

		downloadText("synapse-dbt-project.txt", projectToText(proj), "text/plain");
		const parts = [
			`已匯出 dbt 專案：${paths.length} 個檔案（合併成一份文字檔，用 \`===== 路徑 =====\` 分隔）。`,
		];
		if (proj.notes.length > 0) parts.push(proj.notes[0]);
		if (proj.needsReview.length > 0) {
			parts.push(`⚠ ${proj.needsReview.length} 個節點需要手動處理（見檔案內註解）。`);
		}
		setNotice({
			kind: proj.needsReview.length > 0 ? "error" : "ok",
			text: parts.join("　"),
		});
	}, [nodes, edges]);

	// ---------------------------------------------------------------------
	// 自動存檔（autosave）
	//
	// 畫布狀態只活在 React state 裡，一次重新載入就全部消失。
	// 這裡把 exportWorkflowJson() 的輸出寫進 localStorage —— 刻意不另外
	// 發明第二套格式，這樣「自動還原 / 手動存檔 / 手動讀檔」永遠一致。
	// ---------------------------------------------------------------------

	/** 還原完成前不可存檔，否則初始空畫布會先覆寫掉存檔 */
	const autosaveReadyRef = useRef(false);
	/** 一旦畫布有過內容，就允許存「空畫布」（＝使用者真的清空了） */
	const hadContentRef = useRef(false);
	/** 存檔失敗只提示一次，不隨每次變更洗版 */
	const autosaveErrorShownRef = useRef(false);

	/**
	 * 啟動時還原上一次的自動存檔。
	 * 只在掛載時執行一次；hydrateWorkflow 會保留原節點 id，所以可重複執行。
	 */
	useEffect(() => {
		const raw = loadAutosave();
		if (raw) {
			const parsed = importWorkflowJson(raw);
			if (parsed && parsed.nodes.length > 0) {
				const hydrated = hydrateWorkflow(parsed.nodes, parsed.edges);
				setEdges(hydrated.edges);
				setNodes(hydrated.nodes);
				setTimeout(() => fitView({ duration: 600, padding: 0.2 }), 50);
				setNotice({
					kind: "ok",
					text: `已還原上次的工作流：${parsed.nodes.length} 個節點、${parsed.edges.length} 條連線。`,
				});
			}
		}
		autosaveReadyRef.current = true;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/** 畫布變更 → 節流寫入自動存檔 */
	useEffect(() => {
		if (!autosaveReadyRef.current) return;
		if (nodes.length > 0) hadContentRef.current = true;
		if (!hadContentRef.current) return;

		const t = setTimeout(() => {
			const res = saveAutosave(
				exportWorkflowJson(nodes, edges, { title: "Synapse Workflow" }),
			);
			if (!res.ok && !autosaveErrorShownRef.current) {
				autosaveErrorShownRef.current = true;
				setNotice({
					kind: "error",
					text: `自動存檔失敗（${res.error}）—— 請手動 Save，畫布變更不會被自動保留。`,
				});
			}
		}, AUTOSAVE_DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [nodes, edges]);

	/**
	 * 開新工作流：清空畫布 + 清掉自動存檔。
	 *
	 * 為什麼一定要清存檔：只清畫布的話，autosave 會在下一個節流週期把
	 * 「空畫布」寫回去，看起來像成功了；但使用者重新載入時，若清空發生在
	 * 還原之前，舊工作流又會回來。兩個都清才是一致的。
	 *
	 * `hadContentRef` 要重設為 false —— 否則清空後的那次存檔會立刻把
	 * 空工作流寫進 storage，留下一筆沒有意義的存檔。
	 */
	const handleNewWorkflow = useCallback(() => {
		const hasContent = nodes.length > 0 || edges.length > 0;
		if (
			hasContent &&
			typeof window !== "undefined" &&
			!window.confirm(
				`確定要清空畫布嗎？目前有 ${nodes.length} 個節點、${edges.length} 條連線，清空後無法復原。`,
			)
		) {
			return;
		}
		clearAutosave();
		hadContentRef.current = false;
		autosaveErrorShownRef.current = false;
		setNodes([]);
		setEdges([]);
		setNotice({ kind: "ok", text: "已開新工作流，自動存檔已清除。" });
	}, [nodes.length, edges.length, setNodes, setEdges]);

	/** 儲存工作流（.json，可以再次讀入） */
	const handleSaveWorkflow = useCallback(() => {
		const text = exportWorkflowJson(nodes, edges, { title: "Synapse Workflow" });
		downloadText("synapse-workflow.json", text, "application/json");
		setNotice({
			kind: "ok",
			text: `已儲存工作流：${nodes.length} 個節點、${edges.length} 條連線。`,
		});
	}, [nodes, edges]);

	/** 讀取工作流檔案 */
	const handleLoadWorkflow = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			// 清空 value，否則載入同一個檔案不會再觸發 change
			event.target.value = "";
			if (!file) return;

			let text: string;
			try {
				text = await file.text();
			} catch (err: any) {
				setNotice({
					kind: "error",
					text: `讀取檔案失敗：${err?.message || err}`,
				});
				return;
			}

			const parsed = importWorkflowJson(text);
			if (!parsed) {
				setNotice({
					kind: "error",
					text: "檔案格式不正確 —— 需要 Synapse 工作流檔（.json / .synapse）。",
				});
				return;
			}
			if (parsed.nodes.length === 0) {
				setNotice({ kind: "error", text: "檔案裡面沒有任何節點。" });
				return;
			}

			const hydrated = hydrateWorkflow(parsed.nodes, parsed.edges);
			setEdges(hydrated.edges);
			setNodes(hydrated.nodes);
			setTimeout(() => fitView({ duration: 600, padding: 0.2 }), 50);
			setNotice({
				kind: "ok",
				text: `已載入「${parsed.title}」：${parsed.nodes.length} 個節點、${parsed.edges.length} 條連線。`,
			});
		},
		[hydrateWorkflow, setNodes, setEdges, fitView],
	);

	/**
	 * 產生可分享的連結並複製到剪貼簿。
	 *
	 * 只分享工作流，**不分享資料**。編碼前會剝掉 sqlQuery 這類衍生欄位
	 * （匯入端本來就會重編），連結因此小一半以上。
	 *
	 * 超過長度上限時**明確失敗**，不產生一條會被截斷的連結 ——
	 * 前者使用者知道要改用 JSON 匯出，後者打開後是壞的而且沒有線索。
	 */
	const handleShareLink = useCallback(async () => {
		const enc = encodeShareLink({
			version: 1,
			title: "Synapse workflow",
			nodes: nodesRef.current,
			edges: edgesRef.current,
		});
		if (!enc.ok || !enc.token) {
			setNotice({ kind: "error", text: enc.error || "無法產生分享連結。" });
			return;
		}

		const url = buildShareUrl(window.location.href, enc.token);
		try {
			await navigator.clipboard.writeText(url);
			setNotice({
				kind: "ok",
				text: `分享連結已複製（${enc.length} 字元）。只含工作流、不含資料 —— 對方需要自己準備來源檔。`,
			});
		} catch {
			// 剪貼簿 API 在非 HTTPS 或未授權時會失敗。那不是「功能壞了」，
			// 只是沒能自動複製 —— 把連結顯示出來讓使用者自己複製。
			setNotice({ kind: "ok", text: `請手動複製：${url}` });
		}
	}, []);

	/**
	 * 開頁時檢查 URL fragment 有沒有分享連結。
	 *
	 * 只讀 fragment（`#` 之後）：fragment 不會送到伺服器，所以工作流內容
	 * 不會出現在任何 access log 裡。
	 *
	 * 只跑一次，而且**不會**覆蓋已經有內容的畫布 —— 自動存檔還原的內容
	 * 是使用者自己的，不該被一條網址蓋掉。
	 */
	const shareCheckedRef = useRef(false);
	useEffect(() => {
		if (shareCheckedRef.current) return;
		shareCheckedRef.current = true;

		const token = readShareToken(window.location.href);
		if (!token) return;

		const dec = decodeShareLink(token);
		if (!dec.ok) {
			setNotice({ kind: "error", text: `分享連結無法讀取：${dec.error}` });
			return;
		}
		// 交給既有的匯入驗證路徑，不在這裡抄第二份欄位檢查
		const parsed = importWorkflowJson(JSON.stringify(dec.workflow));
		if (!parsed || parsed.nodes.length === 0) {
			setNotice({ kind: "error", text: "分享連結裡沒有可用的節點。" });
			return;
		}
		if (hadContentRef.current) {
			setNotice({
				kind: "error",
				text: "網址裡有分享連結，但畫布已經有內容 —— 沒有自動覆蓋。請先「New」清空再重新開啟連結。",
			});
			return;
		}

		const hydrated = hydrateWorkflow(parsed.nodes, parsed.edges);
		setEdges(hydrated.edges);
		setNodes(hydrated.nodes);
		setTimeout(() => fitView({ duration: 600, padding: 0.2 }), 50);
		setNotice({
			kind: "ok",
			text: `已從連結載入「${parsed.title}」：${parsed.nodes.length} 個節點。來源檔需要你自己準備。`,
		});
	}, [hydrateWorkflow, setNodes, setEdges, fitView]);

	// 連線後不必在這裡重編譯：edges 一變，上面的 useEffect 就會統一重算。
	// （也避免在 setEdges 的 updater 內再呼叫 setNodes —— StrictMode 會重複執行。）
	const onConnect = useCallback(		(params: Connection) => {
			setEdges((eds) => addEdge({ ...params, type: "particleEdge" }, eds));
		},
		[setEdges],
	);

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation(); // 阻止冒泡，防止重複生成節點

			const rawData =
				event.dataTransfer.getData("text/plain") ||
				event.dataTransfer.getData("application/json");

			if (!rawData) return;

			try {
				const item = JSON.parse(rawData);
				const position = screenToFlowPosition({
					x: event.clientX,
					y: event.clientY,
				});

				const newNodeId = generateNodeId();
				const nodeType = (item.type as string) || "FILTER";
				// 剛拖進來的新節點必定沒有下游 → 不用建 FILTER 的 false 表；
				// 之後一旦有連線，recompileDownstreamNodes 會重新編譯補上。
				const initialSql = generateSqlFromConfig(
					newNodeId,
					nodeType,
					item.config || {},
					[],
					{ falseBranch: false },
				);

				const newNode: Node = {
					id: newNodeId,
					type: item.nodeType || "alteryxNode",
					position,
					data: {
						label: item.label,
						type: nodeType,
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
		[
			screenToFlowPosition,
			setNodes,
			executeNodeQuery,
			handleNodeConfigChange,
		],
	);

	// ---------------------------------------------------------------------
	// 命令面板
	// ---------------------------------------------------------------------
	/** 候選節點直接由目錄投影 —— 新增節點後面板自動認識它，不必另外維護一份清單 */
	const paletteCandidates = useMemo(
		() =>
			Object.values(NODE_CATALOG).map((s) => ({
				type: s.type,
				label: s.label,
				category: s.category,
				description: s.description,
				whenToUse: s.whenToUse,
			})),
		[],
	);

	const paletteActions = useMemo(
		() => [
			{ id: "run", label: "執行全部", hint: "Run Pipeline", keywords: "run execute 執行 全部 跑" },
			{ id: "layout", label: "自動排版", hint: "Auto Layout", keywords: "layout auto 排版 排列 整理" },
			{ id: "undo", label: "復原", hint: "⌘Z", keywords: "undo 復原 退回" },
			{ id: "redo", label: "重做", hint: "⇧⌘Z", keywords: "redo 重做" },
			{ id: "export-sql", label: "匯出 SQL", hint: "CTE", keywords: "export sql 匯出 下載" },
			{ id: "export-python", label: "匯出 Python（Polars）", hint: ".py", keywords: "export python polars 匯出" },
			{ id: "export-dbt", label: "匯出 dbt 專案", hint: "models + tests", keywords: "export dbt models tests 匯出" },
			{ id: "save", label: "儲存工作流", hint: "JSON", keywords: "save 儲存 存檔" },
			{ id: "share", label: "複製分享連結", hint: "URL", keywords: "share link 分享 連結 網址" },
			{ id: "load", label: "載入工作流", hint: "JSON", keywords: "load import open 載入 開啟" },
			{ id: "new", label: "清空畫布", hint: "New", keywords: "new clear 清空 新增" },
		],
		[],
	);

	/**
	 * 面板選了一個節點類型 → 在視窗中央放一個新節點。
	 *
	 * 刻意與 onDrop 產生**同一個形狀**的節點：兩條建立路徑若長得不一樣，
	 * 遲早會有一邊漏掉某個欄位（例如 upstreamTables），而且只會在特定路徑下壞。
	 */
	const handlePickNodeType = useCallback(
		(nodeType: string) => {
			const spec = NODE_CATALOG[nodeType as keyof typeof NODE_CATALOG];
			if (!spec) return;

			const newNodeId = generateNodeId();
			const config = defaultConfigFor(spec.type);
			// 新節點必定沒有下游 → 不必建 FILTER 的 false 表（與 onDrop 同一個理由）
			const initialSql = generateSqlFromConfig(newNodeId, spec.type, config, [], {
				falseBranch: false,
			});

			// 從視窗中心往下錯開，連續加幾個不會完全疊在一起
			const centre = screenToFlowPosition({
				x: window.innerWidth / 2,
				y: window.innerHeight / 2,
			});
			const offset = (nodesRef.current.length % 5) * 28;

			const newNode: Node = {
				id: newNodeId,
				type: spec.nodeType,
				position: { x: centre.x + offset, y: centre.y + offset },
				data: {
					label: spec.label,
					type: spec.type,
					config,
					sqlQuery: initialSql,
					executionState: "IDLE",
					onExecute: () => executeNodeQuery(newNodeId, initialSql),
					onChangeConfig: (newConfig: any) =>
						handleNodeConfigChange(newNodeId, newConfig),
				},
			};

			const nextNodes = [...nodesRef.current, newNode];
			setNodes(nextNodes);
			recordHistory({ nodes: nextNodes, edges: edgesRef.current }, "palette:add");
		},
		[
			screenToFlowPosition,
			setNodes,
			executeNodeQuery,
			handleNodeConfigChange,
			recordHistory,
		],
	);

	/** 面板選了一個動作 → 分派到既有的處理函式（不重寫一份邏輯） */
	const handlePaletteAction = useCallback(
		(id: string) => {
			switch (id) {
				case "run":
					return void handleRunPipeline();
				case "layout":
					return handleAutoLayout();
				case "undo":
					return handleUndo();
				case "redo":
					return handleRedo();
				case "export-sql":
					return handleExportSql();
				case "export-python":
					return handleExportPython();
				case "export-dbt":
					return handleExportDbt();
				case "save":
					return handleSaveWorkflow();
				case "share":
					return void handleShareLink();
				case "load":
					// 載入是「開檔案選擇器」而不是「立刻讀一個檔案」——
					// 借用既有的隱藏 input，不要在面板裡重寫一份讀檔邏輯。
					fileInputRef.current?.click();
					return;
				case "new":
					return handleNewWorkflow();
				default:
					return;
			}
		},
		[
			handleRunPipeline,
			handleAutoLayout,
			handleUndo,
			handleRedo,
			handleExportSql,
			handleExportPython,
			handleSaveWorkflow,
			handleLoadWorkflow,
			handleNewWorkflow,
		],
	);

	/** 點擊節點 → 執行「該節點 + 其整個上游子圖」→ 回饋 Data Drawer */
	const onNodeClick = useCallback(
		async (_: React.MouseEvent, node: Node) => {
			const ns = nodes;
			const es = edges;
			const closure = getAncestorClosure(node.id, ns, es);
			const exec = await runGraph(closure, node.id, ns, es);

			const nodeType = (node.data as any).type || "UNKNOWN";
			if (onInspectNode) {
				onInspectNode({
					id: node.id,
					label: (node.data as any).label || node.id,
					nodeType,
					sqlQuery: (node.data as any).sqlQuery || "",
					tableName: outputTableFor(node.id, nodeType, es),
					ok: exec.ok,
					logs: exec.logs,
				});
			}
		},
		[nodes, edges, onInspectNode, runGraph],
	);

	// ---------------------------------------------------------------------
	// Hermes AST patch → 畫布節點
	// ---------------------------------------------------------------------
	useEffect(() => {
		const handleAstPatch = (e: any) => {
			const patch = e?.detail;
			if (!patch?.nodes?.length) return;

			// 映射邏輯抽去 engine/patch.ts（純函數，有獨立測試守住）
			const resolved = resolveAstPatch(
				patch,
				nodes.map((n) => n.id),
				generateNodeId,
			);

			const newNodes: Node[] = resolved.nodes.map((rn) => {
				const compiled = generateSqlFromConfig(
					rn.newNodeId,
					rn.nodeType,
					rn.config,
					[],
				);
				return {
					id: rn.newNodeId,
					type: rn.flowNodeType,
					position: rn.position,
					data: {
						label: rn.label,
						type: rn.nodeType,
						config: rn.config,
						sqlQuery: compiled,
						executionState: "IDLE",
						onExecute: () =>
							executeNodeQuery(rn.newNodeId, compiled),
						onChangeConfig: (newConfig: any) =>
							handleNodeConfigChange(rn.newNodeId, newConfig),
					},
				} as Node;
			});

			const newEdges = toFlowEdges(resolved.edges, () =>
				`edge_${generateNodeId().replace("node_", "")}`,
			);

			if (resolved.droppedEdges > 0) {
				console.warn(
					`[Hermes] ${resolved.droppedEdges} 條邊無法對照到節點，已丟棄（避免懸空連線）。`,
				);
			}

			// 後端給了目錄以外的東西（未知型別、幻覺 config 鍵、非法 enum 值…）。
			// resolveAstPatch 已經把它擋下來了，所以畫布不會壞；但這件事本身必須
			// 講出來 —— 靜默退化正是「看起來有動、其實做錯事」的來源。
			if (resolved.issues.length > 0) {
				const shown = resolved.issues.slice(0, 3).map((i) => i.detail).join("；");
				const rest =
					resolved.issues.length > 3 ? `（另有 ${resolved.issues.length - 3} 項）` : "";
				console.warn("[Hermes] payload 不符節點目錄：", resolved.issues);
				setNotice({
					kind: "error",
					text: `Hermes payload 有 ${resolved.issues.length} 處不符節點目錄：${shown}${rest}`,
				});
			}

			// 一次性更新：不可在 setNodes 的 updater 內再 call setEdges
			// （StrictMode 會重複執行 updater → 重複邊線）
			const mergedNodes = recompileDownstreamNodes(
				[...edges, ...newEdges],
				[...nodes, ...newNodes],
			);
			const mergedEdges = [...edges, ...newEdges];
			const { nodes: layouted } = getLayoutedElements(
				mergedNodes,
				mergedEdges,
				"LR",
			);

			setEdges(mergedEdges);
			setNodes(layouted);

			setTimeout(() => {
				fitView({ duration: 600, padding: 0.2 });
			}, 100);
		};

		window.addEventListener("SYNAPSE_AST_PATCH", handleAstPatch);
		return () =>
			window.removeEventListener("SYNAPSE_AST_PATCH", handleAstPatch);
	}, [
		nodes,
		edges,
		setNodes,
		setEdges,
		fitView,
		executeNodeQuery,
		handleNodeConfigChange,
		recompileDownstreamNodes,
	]);

	return (
		<div
			ref={reactFlowWrapper}
			style={{ backgroundColor: tokens.bgCanvas }}
			className="w-full h-full relative transition-colors duration-200"
		>
			{/* 頂部工具列 */}
			<div className="absolute top-4 left-4 z-10 flex items-center space-x-3">
				<button
					onClick={() => handleRunPipeline()}
					disabled={isExecuting}
					title={
						isExecuting
							? "執行中 —— 新的請求會排隊等待（避免對同一批臨時表交錯執行 DDL）"
							: "以拓撲序執行整個 DAG"
					}
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
						opacity: isExecuting ? 0.6 : 1,
						cursor: isExecuting ? "wait" : "pointer",
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					{isExecuting ? (
						<Loader2
							className="w-3.5 h-3.5 animate-spin"
							style={{ color: tokens.accent }}
						/>
					) : (
						<Play
							className="w-3.5 h-3.5"
							style={{ color: tokens.accent }}
						/>
					)}
					<span>{isExecuting ? "Running…" : "Run Pipeline"}</span>
				</button>

				<button
					onClick={() => handleAutoLayout("LR")}
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					<Wand2
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>Auto Layout (Left to Right)</span>
				</button>

				{/* 復原 / 重做 / 命令面板。
				    histVersion 出現在 key 裡是刻意的：canUndo / canRedo 是 ref 上的
				    值，React 不會因為它變了就重繪 —— 用它當 key 讓按鈕的 disabled
				    狀態跟上歷史的變化。 */}
				<div
					key={`hist-${histVersion}`}
					className="flex items-center space-x-1"
				>
					<button
						onClick={handleUndo}
						disabled={!historyRef.current.canUndo}
						title="復原（⌘Z）"
						style={{
							backgroundColor: tokens.bgCard,
							borderColor: tokens.border,
							color: tokens.textPrimary,
						}}
						className="flex items-center space-x-1.5 border text-xs px-2 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium disabled:opacity-35"
					>
						<Undo2 className="w-3.5 h-3.5" />
					</button>
					<button
						onClick={handleRedo}
						disabled={!historyRef.current.canRedo}
						title="重做（⇧⌘Z）"
						style={{
							backgroundColor: tokens.bgCard,
							borderColor: tokens.border,
							color: tokens.textPrimary,
						}}
						className="flex items-center space-x-1.5 border text-xs px-2 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium disabled:opacity-35"
					>
						<Redo2 className="w-3.5 h-3.5" />
					</button>
					<button
						onClick={() => setPaletteOpen(true)}
						title="命令面板（⌘K）—— 搜尋節點或動作"
						style={{
							backgroundColor: tokens.bgCard,
							borderColor: tokens.border,
							color: tokens.textPrimary,
						}}
						className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
					>
						<Command className="w-3.5 h-3.5" />
						<span>⌘K</span>
					</button>
					<button
						onClick={handleShareLink}
						title="複製分享連結（只含工作流，不含資料）"
						style={{
							backgroundColor: tokens.bgCard,
							borderColor: tokens.border,
							color: tokens.textPrimary,
						}}
						className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
					>
						<Share2 className="w-3.5 h-3.5" />
						<span>Share</span>
					</button>
				</div>

				{/* 匯出 / 存檔 / 讀檔 */}
				<button
					onClick={handleNewWorkflow}
					title="清空畫布並清除自動存檔（無法復原）"
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					<FilePlus
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>New</span>
				</button>

				<button
					onClick={handleExportSql}
					title="將整個 DAG 編譯成單一 DuckDB CTE 查詢並下載"
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					<FileCode
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>Export SQL</span>
				</button>

				<button
					onClick={handleExportPython}
					title="匯出可執行的 Python (Polars) 腳本；無法自動翻譯的節點會在腳本內留下 TODO"
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					<FileCode
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>Export Python</span>
				</button>

				<button
					onClick={handleExportDbt}
					title="匯出 dbt 專案：每個節點一個 model，ASSERT 變成 dbt 的 tests"
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					<FileCode
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>Export dbt</span>
				</button>

				<button
					onClick={handleSaveWorkflow}
					title="儲存工作流為 JSON（可再次讀入）"
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					<Download
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>Save</span>
				</button>

				<button
					onClick={() => fileInputRef.current?.click()}
					title="由 JSON 工作流檔還原畫布"
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						color: tokens.textPrimary,
					}}
					className="flex items-center space-x-1.5 border text-xs px-3 py-1.5 rounded-lg shadow-sm hover:opacity-80 transition-all font-medium"
				>
					<Upload
						className="w-3.5 h-3.5"
						style={{ color: tokens.accent }}
					/>
					<span>Load</span>
				</button>

				{/* 隱藏的檔案選擇器（由 Load 按鈕觸發） */}
				<input
					ref={fileInputRef}
					type="file"
					accept=".json,.synapse,application/json"
					onChange={handleLoadWorkflow}
					className="hidden"
				/>

				{isEngineReady && (
					<span
						title={
							engineMode === "worker"
								? "DuckDB-WASM 正在 Web Worker 執行（main thread 零阻塞）"
								: `DuckDB 退回主線程執行：${engineWarning ?? ""}`
						}
						className="text-[10px] font-mono px-2 py-0.5 rounded border"
						style={{
							backgroundColor: `${tokens.accent}15`,
							color: tokens.accent,
							borderColor: `${tokens.accent}30`,
						}}
					>
						⚡ Ikaros ·{" "}
						{engineMode === "worker" ? "Worker" : "Main Thread"}
					</span>
				)}
				{engineError && (
					<span
						className="text-[10px] font-mono px-2 py-0.5 rounded border text-rose-500"
						style={{
							backgroundColor: tokens.bgCard,
							borderColor: "#EF444480",
						}}
					>
						⚠ Ikaros Init Failed: {engineError}
					</span>
				)}

			</div>

			{/* 提示訊息列（同工具列分開，避免長訊息撐爆 flex row） */}
			{(chaosLog || notice) && (
				<div className="absolute top-16 left-4 z-10 flex flex-col space-y-2 max-w-md">
					{chaosLog && (
						<div
							className="p-2 px-3 rounded-lg text-xs shadow-lg flex items-center space-x-2 backdrop-blur border animate-fade-in"
							style={{
								backgroundColor: tokens.bgCard,
								borderColor: "#F59E0B80",
								color: isDark ? "#FCD34D" : "#92400E",
							}}
						>
							<Wrench
								className="w-3.5 h-3.5 shrink-0 animate-spin"
								style={{ color: "#F59E0B" }}
							/>
							<span>{chaosLog}</span>
						</div>
					)}

					{notice && (
						<div
							className="p-2 px-3 rounded-lg text-xs shadow-lg flex items-start space-x-2 backdrop-blur border animate-fade-in"
							style={{
								backgroundColor: tokens.bgCard,
								borderColor:
									notice.kind === "ok" ? "#10B98180" : "#EF444480",
								color:
									notice.kind === "ok"
										? isDark
											? "#6EE7B7"
											: "#065F46"
										: isDark
											? "#FCA5A5"
											: "#991B1B",
							}}
						>
							<span className="shrink-0">
								{notice.kind === "ok" ? "✓" : "⚠"}
							</span>
							<span>{notice.text}</span>
						</div>
					)}
				</div>
			)}

			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={handleNodesChange}
				onEdgesChange={handleEdgesChange}
				onConnect={onConnect}
				onNodeClick={onNodeClick}
				onDragOver={onDragOver}
				onDrop={onDrop}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				fitView
			>
				<Background color={tokens.gridColor} gap={20} />
				<Controls
					style={{
						backgroundColor: tokens.bgCard,
						borderColor: tokens.border,
						fill: tokens.textPrimary,
						color: tokens.textPrimary,
						borderRadius: "8px",
						boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
					}}
				/>
			</ReactFlow>

			{/* 命令面板。histVersion 只為了讓 canUndo / canRedo 的變化觸發重繪 */}
			<CommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
				candidates={paletteCandidates}
				actions={paletteActions}
				onPickNode={handlePickNodeType}
				onRunAction={handlePaletteAction}
			/>
		</div>
	);
};

/**
 * 畫布外層包裝。
 *
 * `React.memo` 是必要的，不是微優化：`onCanvasStateChange` 會讓父層
 * （整個 workbench：Palette + Hermes chat + Data Drawer）在畫布變更時重繪，
 * 父層一重繪就會連帶重繪整棵 React Flow 樹。三個 prop 都是穩定的
 * （`setState` 與 `useCallback([])`），所以 memo 能真的擋掉這條迴圈。
 * 主題切換不受影響 —— `CanvasInner` 自己是 `useTheme()` 的 consumer，
 * context 變更會直接穿透 memo 重繪。
 */
export const NymphCanvas: React.FC<NymphCanvasProps> = React.memo((props) => (
	<ReactFlowProvider>
		<CanvasInner {...props} />
	</ReactFlowProvider>
));
