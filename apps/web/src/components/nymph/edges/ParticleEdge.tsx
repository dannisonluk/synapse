import React from "react";
import { BaseEdge, EdgeProps, getSmoothStepPath } from "@xyflow/react";
import { useTheme } from "../../../theme/ThemeContext";

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
	const { tokens } = useTheme();

	const [edgePath] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		borderRadius: 12,
	});

	return (
		<>
			<path
				d={edgePath}
				fill="none"
				stroke={tokens.edgeStroke}
				strokeWidth={5}
				strokeOpacity={0.15}
			/>
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					strokeWidth: 2,
					stroke: tokens.edgeStroke,
					...style,
				}}
			/>
			<circle
				r="3"
				fill={tokens.edgeStroke}
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
