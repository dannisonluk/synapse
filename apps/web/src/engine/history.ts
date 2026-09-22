// apps/web/src/engine/history.ts
//
// Undo / Redo 命令堆疊。
//
// 為什麼要做：改壞一個節點目前的唯一回復手段是重新拖一個。這會直接抑制探索 ——
// 而探索正是這個工具存在的理由。
//
// 這裡刻意是純邏輯（不含 React、不含 React Flow），因為 undo 最難的部分不是
// 「存快照」，是**合併規則**：表單每打一個字都會觸發 onChangeConfig，如果每次都
// 落一筆，打十個字就有十步 undo，使用者按到手痠。合併規則寫錯不會有任何錯誤訊息，
// 只會讓人覺得「undo 壞了」—— 所以它必須能被逐條斷言。
//
// 本檔案不 import 任何東西，可以在 Node 裡直接測。

export interface HistoryEntry<T> {
	value: T;
	/**
	 * 合併識別：同一段連續編輯共用一個 key。
	 * undefined = 這一筆永不與前一筆合併。
	 */
	key?: string;
	/** 落筆時間（毫秒）；用來判斷是否還在同一個「輸入爆發」內 */
	at: number;
}

export interface HistoryOptions {
	/** 最多保留幾步（超過就從最舊的丟）。預設 50 */
	limit?: number;
	/** 同一 key 在這個毫秒數內的連續變更會合併成一步。預設 400 */
	coalesceMs?: number;
}

/**
 * 快照式的 undo / redo。
 *
 * 用整份快照而不是 diff：節點圖的規模是幾十個，快照的記憶體成本可以忽略，
 * 而 diff 的還原邏輯（尤其是邊與 config 的巢狀結構）是錯誤的來源。
 * 這是刻意的取捨 —— 換到的是「還原一定正確」。
 */
export class History<T> {
	private stack: HistoryEntry<T>[] = [];
	private index = -1;
	private readonly limit: number;
	private readonly coalesceMs: number;

	constructor(options: HistoryOptions = {}) {
		this.limit = Math.max(1, options.limit ?? 50);
		this.coalesceMs = Math.max(0, options.coalesceMs ?? 400);
	}

	/**
	 * 建立初始狀態。**不會**產生一步 undo —— 這是「開啟檔案」的語意，
	 * 不是一次編輯。使用者不該能 undo 到「檔案還沒開」。
	 */
	reset(value: T): void {
		this.stack = [{ value, at: 0 }];
		this.index = 0;
	}

	/**
	 * 落一筆新狀態。
	 *
	 * @param key 合併識別。連續的同一 key（且在 coalesceMs 內）會被合併成一步 ——
	 *   「在欄位裡打一串字」是一次編輯，不是十次。
	 */
	push(value: T, key?: string, now: number = Date.now()): void {
		// 先判斷能不能與「目前這一筆」合併。
		//
		// 條件包含 `this.index === this.stack.length - 1`：如果使用者先 undo 過
		// （指標不在最尾端），接著又編輯，那是**新的一步**，不能跟前一筆合併 ——
		// 否則 undo 點會被吃掉，使用者會覺得「undo 之後改東西就回不去了」。
		const atTip = this.index === this.stack.length - 1;
		const last = this.stack[this.index];
		if (
			atTip &&
			last &&
			key !== undefined &&
			key === last.key &&
			now - last.at < this.coalesceMs
		) {
			last.value = value;
			// 更新 at 而不是保留原本的：讓「暫停」成為切分點。
			// 若保留原本的 at，一段長時間的連續輸入會在 coalesceMs 後被硬切開，
			// 而使用者根本沒有停下來。
			last.at = now;
			return;
		}

		// 不在尾端 → 這筆編輯作廢了 redo 分支
		if (!atTip) {
			this.stack.length = this.index + 1;
		}

		this.stack.push({ value, key, at: now });

		// 超過上限就從最舊的丟，指標跟著往前移
		while (this.stack.length > this.limit) {
			this.stack.shift();
			this.index -= 1;
		}
		this.index = this.stack.length - 1;
	}

	/** 回傳上一個狀態；沒有就回 null */
	undo(): T | null {
		if (!this.canUndo) return null;
		this.index -= 1;
		return this.stack[this.index].value;
	}

	/** 回傳下一個狀態；沒有就回 null */
	redo(): T | null {
		if (!this.canRedo) return null;
		this.index += 1;
		return this.stack[this.index].value;
	}

	get canUndo(): boolean {
		return this.index > 0;
	}

	get canRedo(): boolean {
		return this.index >= 0 && this.index < this.stack.length - 1;
	}

	/** 目前所在的狀態 */
	current(): T | null {
		return this.stack[this.index]?.value ?? null;
	}

	/** 堆疊裡有幾筆（= 最多能 undo 幾步，因為第一筆是 reset） */
	get depth(): number {
		return this.stack.length;
	}

	/** 目前指標位置（0 = 最舊） */
	get position(): number {
		return this.index;
	}

	/**
	 * 丟掉所有合併識別。
	 *
	 * 用途：使用者切換到別的節點、或執行了某個動作之後，下一個編輯不該跟
	 * 上一個「輸入爆發」合併 —— 中間發生的事情讓它們不再是一段連續編輯。
	 */
	breakCoalescing(): void {
		const last = this.stack[this.index];
		if (last) last.key = undefined;
	}
}
