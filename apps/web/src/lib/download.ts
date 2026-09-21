// apps/web/src/lib/download.ts
//
// 觸發瀏覽器下載（純前端，不需要後端）。
//
// 為什麼放在 lib/ 而不是 engine/：engine/ 底下的模組必須能在 Node 裡直接 import
// 做驗證（見 scripts/verify.mjs），所以不能碰 DOM。這個檔案的唯一職責就是碰 DOM。
//
// 為什麼不留在 NymphCanvas.tsx：OUTPUT 節點的下載鈕也要用它，而 NymphCanvas
// 反過來 import AlteryxNode —— 從那邊 import 會繞成循環依賴。

/** 觸發瀏覽器下載 */
export function downloadText(
	filename: string,
	text: string,
	mime = "text/plain",
): void {
	const blob = new Blob([text], { type: `${mime};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	// click() 是同步的，但瀏覽器讀取 blob 是非同步 → 延遲 revoke 最穩妥
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
