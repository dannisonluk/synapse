// apps/web/src/components/ErrorBoundary.tsx
// 錯誤邊界（error boundary）—— 兩種顆粒度：
//   variant="app"  → 整個應用程式的安全網（不再整個白畫面）
//   variant="node" → 單一畫布節點，壞掉的節點退化成一張錯誤卡片
//
// 刻意不使用 ThemeContext：最外層的邊界有可能正是因為主題層出錯才被觸發，
// 所以 fallback 一律用自帶的 inline style，不依賴任何 app state。
import React from "react";

export interface ErrorBoundaryProps {
	children: React.ReactNode;
	variant?: "app" | "node";
	/** 顯示用的名稱（節點 label / 功能名），只用於訊息與 console log */
	label?: string;
	/**
	 * 這個值一旦改變就清除錯誤狀態。
	 * 用途：使用者改好節點設定後，壞掉的節點可以自動恢復，不必重新載入頁面。
	 */
	resetKey?: unknown;
}

interface ErrorBoundaryState {
	error: Error | null;
	resetKey: unknown;
}

function prefersDark(): boolean {
	try {
		return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
	} catch {
		return false;
	}
}

export class ErrorBoundary extends React.Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { error };
	}

	static getDerivedStateFromProps(
		props: ErrorBoundaryProps,
		state: ErrorBoundaryState,
	): Partial<ErrorBoundaryState> | null {
		// resetKey 變了 → 清掉錯誤，給它一次重生的機會
		if (state.resetKey !== props.resetKey) {
			return { error: null, resetKey: props.resetKey };
		}
		return null;
	}

	componentDidCatch(error: Error, info: React.ErrorInfo) {
		console.error(
			`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}]`,
			error,
			info.componentStack,
		);
	}

	private reset = () => this.setState({ error: null });

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return this.props.variant === "node"
			? this.renderNodeFallback(error)
			: this.renderAppFallback(error);
	}

	/**
	 * 節點級 fallback：一張小卡片。
	 * 顏色刻意用 `inherit` + 半透明紅，才能同時適配淺色與深色主題。
	 */
	private renderNodeFallback(error: Error) {
		return (
			<div
				style={{
					backgroundColor: "rgba(239, 68, 68, 0.10)",
					borderColor: "#EF4444",
					color: "inherit",
				}}
				className="w-80 rounded-lg border p-3 text-xs font-sans space-y-1"
			>
				<div className="font-semibold">
					節點渲染失敗（Node render error）
				</div>
				<div className="text-[10px] font-mono break-words opacity-80">
					{this.props.label ? `${this.props.label}: ` : ""}
					{error.message}
				</div>
				<button
					onClick={this.reset}
					style={{ borderColor: "#EF4444" }}
					className="mt-1 px-2 py-0.5 rounded border text-[10px] font-mono"
				>
					重試（Retry）
				</button>
			</div>
		);
	}

	/** 應用級 fallback：整頁的復原畫面。 */
	private renderAppFallback(error: Error) {
		const dark = prefersDark();
		const bg = dark ? "#0D1117" : "#FFFFFF";
		const fg = dark ? "#E6EDF3" : "#1C1917";
		const muted = dark ? "#8B949E" : "#78716C";
		const border = dark ? "#30363D" : "#E7DFD5";

		return (
			<div
				style={{ backgroundColor: bg, color: fg }}
				className="w-screen h-screen flex items-center justify-center p-8 font-sans"
			>
				<div
					style={{ borderColor: border }}
					className="max-w-xl w-full rounded-lg border p-6 space-y-3"
				>
					<div className="text-sm font-semibold">
						應用程式發生錯誤（Application error）
					</div>
					<p
						style={{ color: muted }}
						className="text-xs leading-relaxed"
					>
						畫面已被攔截，不會整個白畫面。若工作流已自動存檔，
						按「重試」或重新載入後會自動還原。
					</p>
					<pre
						style={{
							backgroundColor: dark ? "#161B22" : "#FAF7F2",
							borderColor: border,
							color: dark ? "#FF7B72" : "#B91C1C",
						}}
						className="p-3 rounded border text-[10px] font-mono overflow-auto max-h-40 whitespace-pre-wrap"
					>
						{error.stack || error.message}
					</pre>
					<div className="flex space-x-2">
						<button
							onClick={this.reset}
							style={{ backgroundColor: "#2563EB", color: "#FFFFFF" }}
							className="px-3 py-1.5 rounded text-xs font-medium"
						>
							重試（Retry）
						</button>
						<button
							onClick={() => window.location.reload()}
							style={{ borderColor: border, color: fg }}
							className="px-3 py-1.5 rounded border text-xs font-medium"
						>
							重新載入（Reload）
						</button>
					</div>
				</div>
			</div>
		);
	}
}

/**
 * 把畫布節點包進錯誤邊界。
 *
 * resetKey = 節點 id + 它的 SQL：使用者改動設定 → SQL 改變 → 自動清掉錯誤狀態重試，
 * 所以「改好設定就恢復」不需要重新載入頁面。
 */
export function withNodeBoundary<P extends { id?: string }>(
	Component: React.ComponentType<P>,
	label: string,
): React.ComponentType<P> {
	const Wrapped: React.FC<P> = (props) => {
		const data = (props as { data?: { sqlQuery?: string } }).data;
		return (
			<ErrorBoundary
				variant="node"
				label={label}
				resetKey={`${props.id ?? ""}:${data?.sqlQuery ?? ""}`}
			>
				<Component {...props} />
			</ErrorBoundary>
		);
	};
	Wrapped.displayName = `withNodeBoundary(${label})`;
	return Wrapped;
}
