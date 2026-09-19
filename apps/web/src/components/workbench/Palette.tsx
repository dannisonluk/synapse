import React from "react";
import {
	Database,
	Filter,
	Sigma,
	GitMerge,
	Calculator,
	PieChart,
	ArrowDownUp,
	Table,
	Combine,
	Rows3,
	CaseSensitive,
	CopyCheck,
	Droplets,
	Sparkles,
	Scissors,
	MoveVertical,
	TrendingUp,
	ListOrdered,
	TableProperties,
	FlipVertical2,
	Columns3,
	Replace,
	type LucideIcon,
} from "lucide-react";
import { useTheme } from "../../theme/ThemeContext";
import { catalogByCategory, defaultConfigFor, type NodeSpec } from "../../engine/nodeCatalog";
import type { AlteryxNodeType } from "../../types/workbench";

/**
 * 工具面板。
 *
 * 這裡**不再手寫節點清單** —— 舊版是一個手工維護的 items 陣列，與
 * astCompiler 的 switch 各寫一份，於是新增節點時很容易只改一邊
 * （hermes.py 就是這樣爛掉的）。現在面板完全由 engine/nodeCatalog.ts 生成，
 * 而 nodeCatalog 又有斷言強制與編譯器一致。
 *
 * 注意：這裡**不會**帶 SQL —— 拖放至畫布之後，節點 SQL 一律由
 * engine/astCompiler.generateSqlFromConfig() 依 `type` + `config` 生成。
 */

/** icon 名稱 → lucide 元件。名稱來自 nodeCatalog，缺漏會由斷言抓出來。 */
const ICONS: Record<string, LucideIcon> = {
	Database,
	Filter,
	Calculator,
	Table,
	ArrowDownUp,
	CaseSensitive,
	Rows3,
	CopyCheck,
	Droplets,
	Sparkles,
	Scissors,
	MoveVertical,
	TrendingUp,
	ListOrdered,
	Sigma,
	TableProperties,
	FlipVertical2,
	GitMerge,
	Combine,
	Columns3,
	Replace,
	PieChart,
};

/** 供驗證腳本斷言「目錄用到的 icon 名稱這裡都有」 */
export const PALETTE_ICON_NAMES = Object.keys(ICONS);

interface PaletteItem {
	type: AlteryxNodeType;
	nodeType: "alteryxNode" | "vizChartNode";
	label: string;
	category: string;
	config: Record<string, unknown>;
}

/** 目錄 → 可拖放的 payload（不含 React 元素，才能 JSON 序列化） */
function toItem(spec: NodeSpec): PaletteItem {
	return {
		type: spec.type,
		nodeType: spec.nodeType,
		label: spec.label,
		category: spec.category,
		config: defaultConfigFor(spec.type),
	};
}

export const Palette: React.FC = () => {
	const { tokens } = useTheme();

	const onDragStart = (event: React.DragEvent, item: PaletteItem) => {
		event.dataTransfer.setData("text/plain", JSON.stringify(item));
		event.dataTransfer.effectAllowed = "move";
	};

	return (
		<aside
			style={{
				backgroundColor: tokens.bgPanel,
				borderColor: tokens.border,
				color: tokens.textPrimary,
			}}
			className="w-56 border-r p-3 flex flex-col space-y-3 shrink-0 z-10 transition-colors duration-200 select-none overflow-y-auto"
		>
			<div className="text-[10px] font-mono font-bold uppercase tracking-wider opacity-60">
				Alteryx Tool Palette
			</div>

			{catalogByCategory().map((group) => (
				<div key={group.category} className="space-y-2">
					<div className="text-[9px] font-mono uppercase tracking-wider opacity-40 pt-1">
						{group.category}
					</div>
					{group.specs.map((spec) => {
						const item = toItem(spec);
						const Icon = ICONS[spec.icon] ?? Table;
						return (
							<div
								key={spec.type}
								draggable
								onDragStart={(e) => onDragStart(e, item)}
								title={`${spec.description}\n\n適用時機：${spec.whenToUse}`}
								style={{
									backgroundColor: tokens.bgCard,
									borderColor: tokens.border,
								}}
								className="p-2.5 rounded-lg border flex items-center space-x-2.5 cursor-grab hover:shadow-md transition-all active:cursor-grabbing"
							>
								<div className="p-1 rounded bg-stone-500/10 shrink-0">
									<Icon className={`w-4 h-4 ${spec.color}`} />
								</div>
								<div className="min-w-0">
									<div className="text-xs font-semibold truncate">
										{spec.label}
									</div>
									<div className="text-[9px] font-mono opacity-50 truncate">
										{spec.type}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			))}
		</aside>
	);
};
