import { AlteryxNodeConfig } from "../components/nymph/nodes/AlteryxNode";

export function generateSqlFromConfig(
	nodeId: string,
	nodeType: string,
	config: AlteryxNodeConfig,
	upstreamNodeIds: string[] = [],
): string {
	const sourceTable =
		upstreamNodeIds.length > 0 ? upstreamNodeIds[0] : "raw_data";

	switch (nodeType) {
		case "INPUT_DUCKDB": {
			const targetTable = config.tableName || "raw_data";
			return `CREATE TEMP TABLE ${nodeId} AS SELECT * FROM ${targetTable};`;
		}

		case "FILTER": {
			const field = config.field || "amount";
			const op = config.op || ">";
			const val = config.val || "1000";
			return `CREATE TEMP TABLE ${nodeId} AS SELECT * FROM ${sourceTable} WHERE ${field} ${op} ${val};`;
		}

		case "FORMULA": {
			const outputCol = config.outputColumn || "amount_taxed";
			const expr = config.expression || "amount * 1.1";
			return `CREATE TEMP TABLE ${nodeId} AS SELECT *, (${expr}) AS ${outputCol} FROM ${sourceTable};`;
		}

		case "SUMMARIZE": {
			const groupBy = config.groupBy || "year";
			const func = config.func || "SUM";
			const target = config.target || "amount";
			return `CREATE TEMP TABLE ${nodeId} AS SELECT ${groupBy}, ${func}(${target}) AS ${target}_${func.toLowerCase()} FROM ${sourceTable} GROUP BY ${groupBy};`;
		}

		case "JOIN": {
			const leftTable = upstreamNodeIds[0] || "raw_data";
			const rightTable = upstreamNodeIds[1] || sourceTable;
			const joinType = config.joinType || "INNER";
			const leftKey = config.leftKey || "user_id";
			const rightKey = config.rightKey || "user_id";

			return `CREATE TEMP TABLE ${nodeId} AS SELECT a.*, b.* RENAME (b.${rightKey} AS right_${rightKey}) FROM ${leftTable} a ${joinType} JOIN ${rightTable} b ON a.${leftKey} = b.${rightKey};`;
		}

		default:
			return `CREATE TEMP TABLE ${nodeId} AS SELECT * FROM ${sourceTable};`;
	}
}
