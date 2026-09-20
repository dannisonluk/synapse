// packages/synapse-schema/src/index.ts
// @synapse/schema —— 節點目錄的「事實」與稽核工具。
//
// ⚠️ 這個檔案以前手寫了一份 NodeTypeEnum，內容是
//    DATA_SOURCE / TRANSFORM / AGGREGATE / SQL_CUSTOM / CHART_BI ——
//    那些節點早就不存在了（真正的清單在 apps/web/src/engine/nodeCatalog.ts）。
//    而且它在整個 git 歷史中**從未被任何檔案 import**：一個描述不存在的系統、
//    又沒有人用的套件。
//
// 現在：
//   - 事實（有哪些型別、每個型別吃什麼欄位）來自 src/generated.ts，
//     由 `node scripts/gen_node_catalog.mjs` 從 nodeCatalog.ts 產生。
//   - 本入口**零依賴**（不拉 zod），供畫布前端在套用 LLM payload 前做稽核。
//   - 需要真正的 schema 驗證時用子入口 `@synapse/schema/zod`。
export * from "./generated";
export * from "./audit";
