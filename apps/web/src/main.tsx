import React from "react";
import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		{/* 最外層安全網：任何 render 例外都不會變成白畫面 */}
		<ErrorBoundary variant="app" label="Synapse Workbench">
			<App />
		</ErrorBoundary>
	</React.StrictMode>,
);
