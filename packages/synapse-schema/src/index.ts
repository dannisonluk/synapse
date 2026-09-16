import { z } from "zod";

// 1. 定義 Synapse 支持的數據節點類型
export const NodeTypeEnum = z.enum([
	"DATA_SOURCE", // 數據源 (CSV, Parquet, Connection)
	"FILTER", // 數據篩選
	"TRANSFORM", // 欄位轉換 / 清理
	"JOIN", // 多表關聯
	"AGGREGATE", // GroupBy / 聚合
	"SQL_CUSTOM", // 自由撰寫 DuckDB SQL
	"CHART_BI", // Astraea BI 圖表節點
]);

export type NodeType = z.infer<typeof NodeTypeEnum>;

// 2. 基礎 Node 元件與座標位置 (對接 React Flow 格式)
export const BaseNodeSchema = z.object({
	id: z.string().describe("節點唯一 ID，例如: node-1"),
	type: NodeTypeEnum,
	label: z.string().describe("畫布上顯示的名稱"),
	position: z.object({
		x: z.number(),
		y: z.number(),
	}),
	// 紀錄該節點在 Ikaros 運算後的即時狀態
	executionState: z
		.enum(["IDLE", "RUNNING", "SUCCESS", "ERROR"])
		.default("IDLE"),
	errorMessage: z.string().optional(),
});

// 3. 各類型節點的專屬配置 (Node Data Payload)
export const DataSourceConfigSchema = z.object({
	sourceType: z.enum(["FILE_CSV", "FILE_PARQUET", "SNOWFLAKE", "POSTGRES"]),
	filePathOrUrl: z.string().optional(),
	tableName: z.string().describe("在 Ikaros DuckDB 中的虛擬 Table 名稱"),
});

export const SqlNodeConfigSchema = z.object({
	sqlQuery: z.string().describe("DuckDB / Polars 執行的 SQL 查詢語句"),
});

export const ChartConfigSchema = z.object({
	chartType: z.enum(["BAR", "LINE", "SCATTER", "PIE", "SANKEY"]),
	xAxis: z.string(),
	yAxis: z.array(z.string()),
	title: z.string().optional(),
});

// 4. 畫布連線 Edge 規格 (含 Nymph 粒子動畫流速參數)
export const SynapseEdgeSchema = z.object({
	id: z.string(),
	source: z.string().describe("起點 Node ID"),
	target: z.string().describe("終點 Node ID"),
	sourceHandle: z.string().optional(),
	targetHandle: z.string().optional(),
	// Nymph 專屬粒子視覺參數
	animated: z.boolean().default(true),
	particleSpeed: z.number().default(1).describe("粒子流速 (1~10)"),
	particleColor: z.string().default("#00f0ff").describe("粒子發光顏色 HEX"),
});

// 5. 完整的 Synapse DAG 拓撲圖結構 (Daedalus 生成與儲存標的)
export const SynapseDAGSchema = z.object({
	version: z.string().default("1.0.0"),
	dagId: z.string(),
	nodes: z.array(
		BaseNodeSchema.extend({
			data: z.union([
				DataSourceConfigSchema,
				SqlNodeConfigSchema,
				ChartConfigSchema,
				z.record(z.any()),
			]),
		}),
	),
	edges: z.array(SynapseEdgeSchema),
});

export type SynapseDAG = z.infer<typeof SynapseDAGSchema>;
export type SynapseEdge = z.infer<typeof SynapseEdgeSchema>;
