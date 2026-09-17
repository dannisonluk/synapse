import React from "react";
import { Sliders, Table as TableIcon, Database } from "lucide-react";

interface DataDrawerProps {
  isOpen: boolean;
  onToggle: () => void;
  selectedNode: {
    id: string;
    label: string;
    sqlQuery: string;
    data: any[];
  } | null;
}

export const DataDrawer: React.FC<DataDrawerProps> = ({ isOpen, onToggle, selectedNode }) => {
  const rows = selectedNode?.data || [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <footer className={`border-t border-slate-800 bg-slate-900 transition-all ${isOpen ? "h-56" : "h-8"}`}>
      {/* 標題欄 */}
      <div
        onClick={onToggle}
        className="h-8 bg-slate-950 px-4 flex items-center justify-between cursor-pointer border-b border-slate-800 hover:bg-slate-900 transition-colors"
      >
        <div className="flex items-center space-x-2 text-xs font-mono text-slate-400">
          <Sliders className="w-3.5 h-3.5 text-cyan-400" />
          <span>Ikaros Data Drawer & Inspection Logs</span>
          {selectedNode && (
            <span className="text-cyan-300 font-bold bg-cyan-950/60 border border-cyan-800 px-2 py-0.5 rounded text-[10px]">
              Node: {selectedNode.label} ({selectedNode.id})
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{isOpen ? "▼ Minimize" : "▲ Expand"}</span>
      </div>

      {/* 數據表格內容 */}
      {isOpen && (
        <div className="p-3 text-xs font-mono h-48 overflow-auto">
          {selectedNode && rows.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span className="flex items-center space-x-1 text-emerald-400">
                  <TableIcon className="w-3.5 h-3.5" />
                  <span>{rows.length} rows materialized</span>
                </span>
                <span className="text-slate-500">Query: {selectedNode.sqlQuery}</span>
              </div>

              <div className="overflow-x-auto rounded border border-slate-800 bg-slate-950">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/80 text-cyan-300">
                      {columns.map((col) => (
                        <th key={col} className="p-2 font-semibold text-[11px]">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rIdx) => (
                      <tr key={rIdx} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                        {columns.map((col) => (
                          <td key={col} className="p-2 text-slate-300 text-[11px]">
                            {typeof row[col] === "bigint" ? Number(row[col]) : String(row[col])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
              <Database className="w-6 h-6 text-slate-700" />
              <span>Click any node on the canvas to inspect real-time materialized Arrow data stream</span>
            </div>
          )}
        </div>
      )}
    </footer>
  );
};