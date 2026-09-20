// packages/synapse-schema/src/zod.ts
// 子入口 `@synapse/schema/zod` —— 真正做 schema 驗證的地方。
//
// 為什麼獨立一個入口：zod 是執行期依賴，畫布前端只需要查表式的稽核
// （見 ./audit.ts，零依賴）。把 zod 放進主要入口會讓前端為了查表而把它
// 打包進 bundle，所以需要驗證的後端 / 驗證腳本才走這個子入口。
//
// 這裡**不該出現任何手寫的節點清單**：型別與欄位全部讀自 generated.ts，
// 由 nodeCatalog.ts 產生。以前手寫的那份（DATA_SOURCE / AGGREGATE /
// SQL_CUSTOM / CHART_BI / SNOWFLAKE / SANKEY）描述的是一個不存在的系統。
import { z } from "zod";
import { NODE_FIELDS, NODE_META, NODE_TYPES, type FieldSpec, type NodeType } from "./generated";

export * from "./generated";

/** 節點型別列舉（值域即目錄） */
export const NodeTypeEnum = z.enum(NODE_TYPES);

/**
 * 依欄位 kind 產生對應的 zod 型別。
 *
 * 策略是**寬鬆**：一律 optional + nullable。這個 schema 的用途是抓「結構錯誤」
 * ——未知型別、未知 config 鍵、非法 enum 值——而不是要求欄位必填。
 * 必填與否是目錄的語意（NODE_FIELDS[].required），而且 normalizeConfig 本來
 * 就會補上預設值；在這裡硬性要求只會讓 agent 的正常輸出被拒。
 */
function fieldSchema(f: FieldSpec): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	switch (f.kind) {
		case "number":
			base = z.coerce.number();
			break;
		case "boolean":
			base = z.boolean();
			break;
		case "enum":
			base = f.values && f.values.length ? z.enum([...f.values] as [string, ...string[]]) : z.string();
			break;
		// 舊 payload 是單一字串，新 payload 是陣列 —— 兩種都要接受
		case "fieldList":
		case "textList":
			base = z.union([z.string(), z.array(z.string())]);
			break;
		case "aggList":
			base = z.array(
				z.object({ func: z.string().optional(), target: z.string().optional() }).passthrough(),
			);
			break;
		case "pairList":
			base = z.array(z.object({ from: z.string().optional(), to: z.string().optional() }).passthrough());
			break;
		// text / field
		default:
			base = z.string();
			break;
	}
	return base.optional().nullable();
}

/**
 * 每個節點型別的 config schema。
 *
 * `.strict()` 是刻意的：LLM 很愛把 groupBy 寫成 groupby，寬鬆模式會靜默丟掉
 * 這個鍵，然後使用者在畫面上看到一個「沒有分組」的 SUMMARIZE 卻不知道為什麼。
 * strict 會把它變成 unrecognized_keys 錯誤，可以往上報。
 */
export const NODE_CONFIG_SCHEMAS = Object.fromEntries(
	NODE_TYPES.map((t) => [
		t,
		z
			.object(Object.fromEntries(NODE_FIELDS[t].map((f) => [f.name, fieldSchema(f)])))
			.strict(),
	]),
) as unknown as Record<NodeType, z.ZodTypeAny>;

/** 取某個節點型別的 config schema */
export function nodeConfigSchema(type: NodeType): z.ZodTypeAny {
	return NODE_CONFIG_SCHEMAS[type];
}

/** 目錄的描述（label / category / description / inputs） */
export const NodeMetaSchema = z.object({
	label: z.string(),
	category: z.string(),
	description: z.string(),
	inputs: z.number(),
});

/**
 * 後端 Hermes 回傳的單一節點。
 *
 * `type` 用 NodeTypeEnum —— 所以 `SQL_CUSTOM`（已刪除的 daedalus.py 曾經
 * 產生的型別）在這裡就會被擋下，而不是一路活到 patch.ts 才靜默退化成 FILTER。
 */
export const AstPatchNodeSchema = z.object({
	id: z.string().optional(),
	sourceIndex: z.union([z.number(), z.string()]).optional(),
	type: NodeTypeEnum,
	label: z.string().optional(),
	config: z.record(z.any()).optional(),
	position: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const AstPatchEdgeSchema = z.object({
	source: z.union([z.string(), z.number()]),
	target: z.union([z.string(), z.number()]),
	targetHandle: z.string().optional(),
});

/** Hermes 的 ast_patch：至少一個節點，邊可以沒有 */
export const AstPatchSchema = z.object({
	nodes: z.array(AstPatchNodeSchema).min(1),
	edges: z.array(AstPatchEdgeSchema).default([]),
	message: z.string().optional(),
});

/** Hermes /chat 的完整回應（SILENT 與 CANVAS_FOCUS 兩種模式共用） */
export const HermesResponseSchema = z.object({
	status: z.string(),
	action_type: z.enum(["INLINE_SQL", "MUTATE_AST", "MESSAGE"]),
	message: z.string(),
	sql_query: z.string().nullish(),
	ast_patch: AstPatchSchema.nullish(),
});

/** 落到 React Flow 之後的邊（對應 patch.ts 的 toFlowEdges） */
export const FlowEdgeSchema = z.object({
	id: z.string(),
	source: z.string(),
	target: z.string(),
	type: z.string().optional(),
	animated: z.boolean().optional(),
	targetHandle: z.string().nullish(),
});
