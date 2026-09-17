import React from "react";
import { BaseEdge, EdgeProps, getSmoothStepPath } from "@xyflow/react";

export const ParticleEdge: React.FC<EdgeProps> = ({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	style = {},
	markerEnd,
}) => {
	// 使用正交 90 度圓角折線算法（Alteryx 經典 Wire 模式）
	const [edgePath] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		borderRadius: 16, // 圓角弧度
	});

	return (
		<>
			{/* 底部螢光發光軌道 */}
			<path
				d={edgePath}
				fill="none"
				stroke="#06b6d4"
				strokeWidth={6}
				strokeOpacity={0.2}
				className="blur-[1px]"
			/>

			{/* 高對比螢光青色主線 */}
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					strokeWidth: 2.5,
					stroke: "#22d3ee",
					...style,
				}}
			/>

			{/* 線條動態粒子 */}
			<circle
				r="3.5"
				fill="#a5f3fc"
			>
				<animateMotion
					dur="3s"
					repeatCount="indefinite"
					path={edgePath}
				/>
			</circle>
		</>
	);
};
